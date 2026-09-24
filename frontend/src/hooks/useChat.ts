"use client";

// ─── Chat streaming state machine ─────────────────────────────────────────────
// Phases advance ONLY when backend events justify them:
//   retrieving → (agent*) → generating → (verifying) → done | stopped | error

import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  type CitedSource,
  type ChatMessage,
  type ChatSseEvent,
} from "@/lib/api";

export type ChatPhase =
  | "idle"
  | "retrieving"
  | "agent"
  | "generating"
  | "done"
  | "stopped"
  | "error";

export interface AgentStep {
  round: number;
  tool: string;
  message: string;
}

export interface LiveAssistant {
  content: string;
  citations: CitedSource[];
  rejectedQuotes: string[];
  notices: { kind: string; text: string }[];
  agentSteps: AgentStep[];
  phase: ChatPhase;
}

const EMPTY_LIVE: LiveAssistant = {
  content: "",
  citations: [],
  rejectedQuotes: [],
  notices: [],
  agentSteps: [],
  phase: "retrieving",
};

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [live, setLive] = useState<LiveAssistant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const conversationRef = useRef<string | null>(null);
  const liveRef = useRef<LiveAssistant | null>(null);

  const stop = useCallback(() => {
    const current = liveRef.current;

    controllerRef.current?.abort();
    controllerRef.current = null;

    // The abort also kills the SSE connection, so the backend's done event
    // can never arrive — finalize the partial answer locally. The backend
    // persists the stopped turn independently.
    if (current) {
      setMessages((previous) => [
        ...previous,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: current.content,
          createdAt: new Date().toISOString(),
          sources: current.citations,
          status: "stopped",
        },
      ]);
      setLive(null);
    }
  }, []);

  const send = useCallback(
    (question: string, documentIds: string[], conversationId?: string) => {
      if (controllerRef.current) {
        return; // one request at a time
      }

      setError(null);
      setLive({ ...EMPTY_LIVE });

      const controller = new AbortController();
      controllerRef.current = controller;

      if (conversationId) {
        conversationRef.current = conversationId;
      }

      setMessages((previous) => [
        ...previous,
        {
          id: `user-${Date.now()}`,
          role: "user",
          content: question,
          createdAt: new Date().toISOString(),
        },
      ]);

      const apply = (event: ChatSseEvent) => {
        if (event.type === "done") {
          // Terminal events mutate sibling state OUTSIDE any updater —
          // React StrictMode double-invokes updaters, which would duplicate
          // the finalized message.
          setMessages((previous) => [
            ...previous,
            {
              ...event.message,
              status: event.stopped ? "stopped" : "complete",
            },
          ]);
          setLive(null);
          controllerRef.current = null;
          return;
        }

        if (event.type === "error") {
          setError(event.message);
          setLive((current) =>
            current ? { ...current, phase: "error" } : current,
          );
          controllerRef.current = null;
          return;
        }

        setLive((current) => {
          if (!current) {
            return current;
          }

          switch (event.type) {
            case "agent_step":
              return {
                ...current,
                phase: "agent",
                agentSteps: [
                  ...current.agentSteps,
                  {
                    round: event.round,
                    tool: event.tool,
                    message: event.message,
                  },
                ],
              };

            case "token":
              return {
                ...current,
                phase: "generating",
                content: current.content + event.text,
              };

            case "quote_verified":
              return {
                ...current,
                citations: [...current.citations, event.source],
              };

            case "quote_rejected":
              return {
                ...current,
                rejectedQuotes: [...current.rejectedQuotes, event.quote],
              };

            case "notice":
              return {
                ...current,
                notices: [
                  ...current.notices,
                  { kind: event.kind, text: event.text },
                ],
              };

            default:
              return current;
          }
        });
      };

      api.streamChat(
        {
          documentIds,
          message: question,
          ...(conversationRef.current
            ? { conversationId: conversationRef.current }
            : {}),
        },
        apply,
      );
    },
    [],
  );

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    conversationRef.current = null;
    setMessages([]);
    setLive(null);
    setError(null);
  }, []);

  const clearLive = useCallback(() => setLive(null), []);

  const busy =
    live !== null &&
    (live.phase === "retrieving" ||
      live.phase === "agent" ||
      live.phase === "generating");

  // Keep a ref in sync so stop() can read the latest partial content
  // without becoming a dependency of every streaming update.
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  return {
    messages,
    live,
    error,
    busy,
    conversationId: conversationRef.current,
    send,
    stop,
    reset,
    clearLive,
    setMessages,
  };
}
