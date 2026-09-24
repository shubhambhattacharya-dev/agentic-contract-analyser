// Constants
export const MAX_MESSAGES_PER_CONVERSATION = 50 as const;
export const MAX_MESSAGE_LENGTH = 4_000 as const;
export const MAX_DOCUMENT_IDS = 5 as const;

// Roles & Status
export type ChatRole = "user" | "assistant";

export type ConversationStatus =
  | "active"
  | "expired"
  | "error";

// Citations
export interface CitedSource {
  /** Child chunk ID where the quote was verified. */
  chunkId: string;

  /** Parent chunk ID used for broader context. */
  parentId: string | null;

  /** Exact quote extracted from the document. */
  quote: string;

  /** True only when the quote verifier confirms the quote exists. */
  verified: boolean;

  /** Document the quote was verified against (multi-document chats). */
  documentId: string;

  /** Canonical document start offset. */
  startOffset: number | null;

  /** Canonical document end offset. */
  endOffset: number | null;

  /** 1-based page derived from the page map (never model-supplied). */
  page: number | null;

  /** How many times the quote occurs in the document. */
  occurrences: number;
}

// ─── SSE events ──────────────────────────────────────────────────────────────

export type VerifiedSourceEvent = CitedSource & {
  /** Verbatim matched slice from the canonical document text. */
  matchedText: string;
};

export type ChatEvent =
  | { type: "agent_step"; round: number; tool: string; message: string }
  | { type: "token"; text: string }
  | { type: "quote_verified"; source: VerifiedSourceEvent }
  | { type: "quote_rejected"; quote: string; reason: string }
  | {
      type: "notice";
      kind: "unverified_removed" | "coverage" | "stopped";
      text: string;
    }
  | { type: "done"; message: ChatMessage; stopped: boolean }
  | { type: "error"; message: string };

// Messages
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;

  /** Sources attached to assistant messages. */
  sources?: CitedSource[];

  /** Present on assistant messages: completed normally vs user-stopped. */
  status?: "complete" | "stopped";
}

// Conversation
export interface ChatConversation {
  conversationId: string;
  documentIds: string[];
  messages: ChatMessage[];
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
}

// Request
export interface ChatRequestOptions {
  /** Number of chunks to retrieve. */
  topK?: number | undefined;

  /** Generation temperature. */
  temperature?: number | undefined;
}

export interface ChatRequest {
  documentIds: string[];
  conversationId?: string | undefined;
  message: string;
  options?: ChatRequestOptions | undefined;
}

// Response
export interface ChatResponse {
  conversationId: string;
  message: ChatMessage;
}

export interface ChatErrorResponse {
  error: {
    code: string;
    message: string;
    conversationId?: string;
  };
}