import type { Request, Response } from "express";
import { z } from "zod";

import { logger } from "../lib/logger.js";
import { store } from "../lib/store.js";
import { chatService } from "../services/chat.service.js";
import type { ChatEvent } from "../types/chat.types.js";
import {
  MAX_DOCUMENT_IDS,
  MAX_MESSAGE_LENGTH,
} from "../types/chat.types.js";

export const ChatRequestSchema = z.object({
  documentIds: z
    .array(z.string().uuid())
    .min(1)
    .max(MAX_DOCUMENT_IDS),

  conversationId: z.string().uuid().optional(),

  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),

  options: z
    .object({
      topK: z.number().int().min(1).max(50).optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .optional(),
});

function writeEvent(
  res: Response,
  event: ChatEvent,
): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * POST /api/chat — SSE stream of the full question pipeline:
 * retrieval → gate → (agent) → generation → quote verification → persistence.
 */
export async function chatController(
  req: Request,
  res: Response,
): Promise<void> {
  const sessionId = req.sessionId;

  if (!sessionId) {
    res.status(401).json({
      error: {
        code: "SESSION_REQUIRED",
        message: "Session is required.",
      },
    });
    return;
  }

  const parsed = ChatRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid chat request.",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }

  // SSE headers before anything else.
  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.flushHeaders?.();

  // Client disconnect (Stop button) aborts the whole pipeline.
  //
  // NOTE: on modern Node, req 'close' fires as soon as the request BODY is
  // fully consumed — not on disconnect. The response 'close' event is the
  // reliable disconnect signal for an SSE stream.
  const abort = new AbortController();

  res.on("close", () => {
    if (!res.writableEnded) {
      abort.abort();
    }
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": ping\n\n");
    }
  }, 15_000);

  try {
    for await (const event of chatService(
      sessionId,
      parsed.data,
      abort.signal,
    )) {
      if (res.writableEnded) {
        break;
      }

      writeEvent(res, event);
    }
  } catch (error) {
    logger.error(
      { sessionId, error },
      "Chat SSE stream failed.",
    );

    if (!res.writableEnded) {
      writeEvent(res, {
        type: "error",
        message: "Unable to complete the chat request.",
      });
    }
  } finally {
    clearInterval(heartbeat);

    if (!res.writableEnded) {
      res.end();
    }
  }
}

/** GET /api/chat/conversations — list the session's conversations. */
export async function listConversationsController(
  req: Request,
  res: Response,
): Promise<void> {
  const sessionId = req.sessionId;

  if (!sessionId) {
    res.status(401).json({
      error: {
        code: "SESSION_REQUIRED",
        message: "Session is required.",
      },
    });
    return;
  }

  const conversations =
    (await store.listChatConversations(sessionId)).sort(
      (a, b) =>
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );

  res.status(200).json({ conversations });
}

/** GET /api/chat/conversations/:conversationId — reopen one conversation. */
export async function getConversationController(
  req: Request,
  res: Response,
): Promise<void> {
  const sessionId = req.sessionId;

  if (!sessionId) {
    res.status(401).json({
      error: {
        code: "SESSION_REQUIRED",
        message: "Session is required.",
      },
    });
    return;
  }

  const rawConversationId = req.params.conversationId;

  const conversationId = Array.isArray(rawConversationId)
    ? rawConversationId[0]
    : rawConversationId;

  if (!conversationId) {
    res.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Conversation ID is required.",
      },
    });
    return;
  }

  const conversation = await store.getChatConversation(
    sessionId,
    conversationId,
  );

  if (!conversation) {
    res.status(404).json({
      error: {
        code: "CONVERSATION_NOT_FOUND",
        message: "Conversation not found.",
      },
    });
    return;
  }

  res.status(200).json({ conversation });
}
