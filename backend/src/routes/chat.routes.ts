import { Router } from "express";

import {
  chatController,
  getConversationController,
  listConversationsController,
} from "../controllers/chat.controller.js";
import { requireSession } from "../middleware/session.middleware.js";

const router = Router();

// SSE chat stream: retrieval → gate → agent → generation → verification.
router.post("/", requireSession, chatController);

// Conversation history (reopen per-document / multi-document chats).
router.get(
  "/conversations",
  requireSession,
  listConversationsController,
);

router.get(
  "/conversations/:conversationId",
  requireSession,
  getConversationController,
);

export default router;
