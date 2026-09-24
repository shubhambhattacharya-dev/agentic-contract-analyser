// ─── Central typed API client ─────────────────────────────────────────────────
// The ONLY module that talks to the backend. Base URL from NEXT_PUBLIC_API_URL
// (empty = same origin, e.g. behind the dev proxy). Session lives in the
// backend-set cookie — never in localStorage.

const BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export interface DocumentMeta {
  documentId: string;
  originalName: string;
  mimeType: string;
  pageCount: number;
  charCount: number;
  wordCount: number;
  parentChunkCount: number;
  childChunkCount: number;
  sizeBytes: number;
  createdAt: string;
}

export interface DocumentPage {
  pageNumber: number;
  startOffset: number;
  endOffset: number;
}

export interface DocumentContent {
  documentId: string;
  originalName: string;
  pageCount: number;
  text: string;
  pages: DocumentPage[];
}

export interface CitedSource {
  chunkId: string;
  parentId: string | null;
  quote: string;
  verified: boolean;
  documentId: string;
  startOffset: number | null;
  endOffset: number | null;
  page: number | null;
  occurrences: number;
  matchedText?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  sources?: CitedSource[];
  status?: "complete" | "stopped";
}

export type ChatSseEvent =
  | { type: "agent_step"; round: number; tool: string; message: string }
  | { type: "token"; text: string }
  | { type: "quote_verified"; source: CitedSource }
  | { type: "quote_rejected"; quote: string; reason: string }
  | { type: "notice"; kind: string; text: string }
  | { type: "done"; message: ChatMessage; stopped: boolean }
  | { type: "error"; message: string }
  | { type: "unknown" };

export interface ConversationSummary {
  conversationId: string;
  documentIds: string[];
  messages: ChatMessage[];
  updatedAt: string;
}

export interface ComparisonChange {
  kind: "changed" | "added" | "removed";
  severity: "CRITICAL" | "MODERATE" | "MINOR";
  label: string;
  sectionNumber: string | null;
  textA: string | null;
  textB: string | null;
  summary: string;
}

export interface ComparisonResponse {
  documentA: { documentId: string; originalName: string };
  documentB: { documentId: string; originalName: string };
  changes: ComparisonChange[];
  counts: { critical: number; moderate: number; minor: number };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      credentials: "include",
      ...init,
    });
  } catch {
    throw new ApiError(
      "Cannot reach the Elcara backend. Is the server running?",
      0,
      "NETWORK_ERROR",
    );
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code: string | undefined;

    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // keep default message
    }

    throw new ApiError(message, response.status, code);
  }
  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export interface UploadResult {
  document: DocumentMeta;
}

/** Multipart upload with progress (XHR — fetch has no upload progress). */
export function uploadDocument(
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open("POST", `${BASE}/api/upload`);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status === 201) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new ApiError("Unexpected upload response", xhr.status));
        }
      } else {
        let message = `Upload failed (${xhr.status})`;
        let code: string | undefined;

        try {
          const body = JSON.parse(xhr.responseText) as {
            error?: { code?: string; message?: string };
          };
          if (body.error?.message) message = body.error.message;
          if (body.error?.code) code = body.error.code;
        } catch {
          // keep default
        }

        reject(new ApiError(message, xhr.status, code));
      }
    };

    xhr.onerror = () =>
      reject(new ApiError("Upload failed — network error", 0, "NETWORK_ERROR"));

    xhr.onabort = () =>
      reject(new ApiError("Upload cancelled", 0, "UPLOAD_ABORTED"));

    signal?.addEventListener("abort", () => xhr.abort());

    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export const api = {
  listDocuments: () =>
    request<{ documents: DocumentMeta[] }>("/api/documents"),

  deleteDocument: (docId: string) =>
    request<void>(`/api/documents/${docId}`, { method: "DELETE" }),

  getDocument: (docId: string) =>
    request<{ document: DocumentMeta }>(`/api/documents/${docId}`),

  getDocumentStatus: (docId: string) =>
    request<{ documentId: string; status: string }>(
      `/api/documents/${docId}/status`,
    ),

  getDocumentContent: (docId: string) =>
    request<DocumentContent>(`/api/documents/${docId}/content`),

  listConversations: () =>
    request<{ conversations: ConversationSummary[] }>(
      "/api/chat/conversations",
    ),

  getConversation: (conversationId: string) =>
    request<{ conversation: ConversationSummary }>(
      `/api/chat/conversations/${conversationId}`,
    ),

  compare: (documentIdA: string, documentIdB: string) =>
    request<ComparisonResponse>("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentIdA, documentIdB }),
    }),

  /**
   * Opens the chat SSE stream. `onEvent` receives parsed events; the returned
   * AbortController cancels the request — the backend persists the partial.
   */
  streamChat: (
    body: { documentIds: string[]; message: string; conversationId?: string },
    onEvent: (event: ChatSseEvent) => void,
  ): AbortController => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(`${BASE}/api/chat`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          let message = `Chat failed (${response.status})`;
          try {
            const errBody = (await response.json()) as {
              error?: { message?: string };
            };
            if (errBody.error?.message) message = errBody.error.message;
          } catch {
            // keep default
          }
          onEvent({ type: "error", message });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          let separator = buffer.indexOf("\n\n");

          while (separator !== -1) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);

            for (const event of parseSseFrame(frame)) {
              onEvent(event);
            }

            separator = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          onEvent({
            type: "error",
            message:
              (error as Error).message || "The chat stream failed unexpectedly.",
          });
        }
      }
    })();

    return controller;
  },
};

/** Parses one SSE frame ("data: {...}\n" lines) into typed chat events. */
export function parseSseFrame(frame: string): ChatSseEvent[] {
  const events: ChatSseEvent[] = [];

  for (const line of frame.split("\n")) {
    if (!line.startsWith("data: ")) {
      continue;
    }

    const payload = line.slice(6).trim();

    if (!payload) {
      continue;
    }

    try {
      const parsed = JSON.parse(payload) as { type?: string } & Record<
        string,
        unknown
      >;

      switch (parsed.type) {
        case "token":
          if (typeof parsed.text === "string") {
            events.push({ type: "token", text: parsed.text });
          }
          break;

        case "agent_step":
          if (
            typeof parsed.round === "number" &&
            typeof parsed.tool === "string" &&
            typeof parsed.message === "string"
          ) {
            events.push({
              type: "agent_step",
              round: parsed.round,
              tool: parsed.tool,
              message: parsed.message,
            });
          }
          break;

        case "quote_verified":
          events.push({
            type: "quote_verified",
            source: parsed.source as CitedSource,
          });
          break;

        case "quote_rejected":
          events.push({
            type: "quote_rejected",
            quote: String(parsed.quote ?? ""),
            reason: String(parsed.reason ?? "not_found"),
          });
          break;

        case "notice":
          events.push({
            type: "notice",
            kind: String(parsed.kind ?? ""),
            text: String(parsed.text ?? ""),
          });
          break;

        case "done":
          events.push({
            type: "done",
            message: parsed.message as ChatMessage,
            stopped: Boolean(parsed.stopped),
          });
          break;

        case "error":
          events.push({ type: "error", message: String(parsed.message ?? "") });
          break;

        default:
          events.push({ type: "unknown" });
      }
    } catch {
      // Malformed frame (e.g. comment/heartbeat) — ignore, never crash.
    }
  }

  return events;
}
