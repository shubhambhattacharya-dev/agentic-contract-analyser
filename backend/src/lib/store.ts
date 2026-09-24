import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { del, head, put } from "@vercel/blob";
import { Redis as UpstashRedis } from "@upstash/redis";

import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { redis as localRedis } from "./redis.js";
import { MAX_MESSAGES_PER_CONVERSATION } from "../types/chat.types.js";

const isProduction = env.NODE_ENV === "production";

// ─── File storage (dev: local filesystem, prod: Vercel Blob) ─────────────────

const DEV_BLOB_ROOT = path.resolve(".blob-store");
const DEV_BLOB_URL_PREFIX = "local://";

/** Strips traversal and unsafe characters from every path segment. */
function sanitizePathname(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => segment.replace(/[^\w.\- ]+/g, "_"))
    .filter((segment) => segment.length > 0 && segment !== "..")
    .join("/");
}

function devBlobPath(pathname: string): string {
  return path.join(DEV_BLOB_ROOT, sanitizePathname(pathname));
}

export interface StoredFile {
  url: string;
  pathname: string;
}

import type {
  DocumentMeta,
  DocumentStatusRecord,
} from "../types/document.types.js";
import type {
  ChatConversation,
  ChatMessage,
} from "../types/chat.types.js";

export type {
  DocumentMeta,
  DocumentStatusRecord,
};



const upstashRedis =
  isProduction &&
  env.UPSTASH_REDIS_REST_URL &&
  env.UPSTASH_REDIS_REST_TOKEN
    ? new UpstashRedis({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

export const TTL = {
  DOCUMENT: 60 * 60 * 24 * 7,
  STATUS: 60 * 60 * 24,
  CHAT: 60 * 60 * 24 * 7,
  QUERY_CACHE: 60 * 60,
  LIBRARY: 60 * 60 * 24 * 7,
} as const;

export type TtlKey = keyof typeof TTL;

const NS = "elcara";

export const keys = {
  docMeta: (sid: string, did: string) =>
    `${NS}:sess:${sid}:doc:${did}:meta`,

  docText: (sid: string, did: string) =>
    `${NS}:sess:${sid}:doc:${did}:text`,

  docFull: (sid: string, did: string) =>
    `${NS}:sess:${sid}:doc:${did}:doc`,

  docPages: (sid: string, did: string) =>
    `${NS}:sess:${sid}:doc:${did}:pages`,

  docChunks: (sid: string, did: string) =>
    `${NS}:sess:${sid}:doc:${did}:chunks`,

  docStatus: (sid: string, did: string) =>
    `${NS}:sess:${sid}:doc:${did}:status`,

  docBm25: (sid: string, did: string) =>
    `${NS}:sess:${sid}:doc:${did}:bm25`,

  docNormIdx: (sid: string, did: string) =>
    `${NS}:sess:${sid}:doc:${did}:normidx`,

  docEmbMap: (sid: string, did: string) =>
    `${NS}:sess:${sid}:doc:${did}:embmap`,

  library: (sid: string) =>
    `${NS}:sess:${sid}:lib`,

  chat: (sid: string, convKey: string) =>
    `${NS}:sess:${sid}:chat:${convKey}`,

  /** Hash of all conversations for a session: conversationId -> ChatConversation. */
  chatIndex: (sid: string) =>
    `${NS}:sess:${sid}:chats`,

  chatConvKey: (docIds: string[]) =>
    [...docIds].sort().join("+"),

  queryEmb: (hash: string) =>
    `${NS}:qcache:${hash}`,

  allDocKeys: (
    sid: string,
    did: string,
  ): string[] => [
    keys.docMeta(sid, did),
    keys.docText(sid, did),
    keys.docFull(sid, did),
    keys.docPages(sid, did),
    keys.docChunks(sid, did),
    keys.docStatus(sid, did),
    keys.docBm25(sid, did),
    keys.docNormIdx(sid, did),
    keys.docEmbMap(sid, did),
  ],
} as const;

function getProductionRedis(): UpstashRedis {
  if (!upstashRedis) {
    throw new Error(
      "Upstash Redis is not configured for production.",
    );
  }

  return upstashRedis;
}

function requireBlobToken(): void {
  if (!env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not configured.",
    );
  }
}

function safeParse<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  }

  return raw as T;
}

async function redisSet(
  key: string,
  value: string,
  ttlSec?: number,
): Promise<void> {
  if (isProduction) {
    const client = getProductionRedis();

    if (ttlSec) {
      await client.set(key, value, {
        ex: ttlSec,
      });
    } else {
      await client.set(key, value);
    }

    return;
  }

  if (ttlSec) {
    await localRedis.set(
      key,
      value,
      "EX",
      ttlSec,
    );
  } else {
    await localRedis.set(key, value);
  }
}

async function redisGet(
  key: string,
): Promise<unknown> {
  if (isProduction) {
    return getProductionRedis().get(key);
  }

  return localRedis.get(key);
}

async function redisDelete(
  ...keyList: string[]
): Promise<number> {
  if (keyList.length === 0) {
    return 0;
  }

  if (isProduction) {
    return getProductionRedis().del(...keyList);
  }

  return localRedis.del(...keyList);
}

async function redisExists(
  key: string,
): Promise<boolean> {
  if (isProduction) {
    return (await getProductionRedis().exists(key)) === 1;
  }

  return (await localRedis.exists(key)) === 1;
}

async function redisExpire(
  key: string,
  ttlSec: number,
): Promise<void> {
  if (isProduction) {
    await getProductionRedis().expire(
      key,
      ttlSec,
    );
    return;
  }

  await localRedis.expire(key, ttlSec);
}

export const store = {
  /**
   * Persists a document binary through the storage abstraction.
   * Production: Vercel Blob (private access). Development/test: local
   * filesystem under .blob-store/ (gitignored), addressed via local:// URLs.
   */
  async putFile(
    pathname: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<StoredFile> {
    const safePath = sanitizePathname(pathname);

    if (isProduction) {
      requireBlobToken();

      const blob = await put(safePath, buffer, {
        access: "private",
        addRandomSuffix: true,
        contentType,
      });

      return { url: blob.url, pathname: blob.pathname };
    }

    const absolutePath = devBlobPath(safePath);

    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, buffer);

    logger.debug(
      { pathname: safePath, bytes: buffer.length },
      "File stored locally",
    );

    return { url: `${DEV_BLOB_URL_PREFIX}${safePath}`, pathname: safePath };
  },

  async set<T>(
    key: string,
    value: T,
    ttlSec?: number,
  ): Promise<void> {
    await redisSet(
      key,
      JSON.stringify(value),
      ttlSec,
    );
  },

  async get<T>(
    key: string,
  ): Promise<T | null> {
    return safeParse<T>(
      await redisGet(key),
    );
  },

  async del(
    ...keyList: string[]
  ): Promise<number> {
    return redisDelete(...keyList);
  },

  async exists(
    key: string,
  ): Promise<boolean> {
    return redisExists(key);
  },

  async expire(
    key: string,
    ttlSec: number,
  ): Promise<void> {
    await redisExpire(key, ttlSec);
  },

  async hset<T>(
    key: string,
    field: string,
    value: T,
    ttlSec?: number,
  ): Promise<void> {
    const serialized = JSON.stringify(value);

    if (isProduction) {
      const client = getProductionRedis();

      await client.hset(key, {
        [field]: serialized,
      });

      if (ttlSec) {
        await client.expire(key, ttlSec);
      }

      return;
    }

    await localRedis.hset(
      key,
      field,
      serialized,
    );

    if (ttlSec) {
      await localRedis.expire(
        key,
        ttlSec,
      );
    }
  },

  async hget<T>(
    key: string,
    field: string,
  ): Promise<T | null> {
    const raw = isProduction
      ? await getProductionRedis().hget(
          key,
          field,
        )
      : await localRedis.hget(
          key,
          field,
        );

    return safeParse<T>(raw);
  },

  async hgetall<T>(
    key: string,
  ): Promise<Record<string, T> | null> {
    const raw = isProduction
      ? await getProductionRedis().hgetall(
          key,
        )
      : await localRedis.hgetall(key);

    if (
      !raw ||
      Object.keys(raw).length === 0
    ) {
      return null;
    }

    return Object.fromEntries(
      Object.entries(raw).map(
        ([field, value]) => [
          field,
          safeParse<T>(value),
        ],
      ),
    ) as Record<string, T>;
  },

  async hdel(
    key: string,
    ...fields: string[]
  ): Promise<number> {
    if (fields.length === 0) {
      return 0;
    }

    if (isProduction) {
      return getProductionRedis().hdel(
        key,
        ...fields,
      );
    }

    return localRedis.hdel(
      key,
      ...fields,
    );
  },

  async deleteFile(
    url: string,
  ): Promise<void> {
    try {
      if (isProduction) {
        await del(url);
        return;
      }

      if (!url.startsWith(DEV_BLOB_URL_PREFIX)) {
        return;
      }

      await rm(devBlobPath(url.slice(DEV_BLOB_URL_PREFIX.length)), {
        force: true,
      });
    } catch {
      // File deletion is non-fatal.
    }
  },

  async fileExists(
    url: string,
  ): Promise<boolean> {
    try {
      if (isProduction) {
        requireBlobToken();

        await head(url);

        return true;
      }

      if (!url.startsWith(DEV_BLOB_URL_PREFIX)) {
        return false;
      }

      await access(devBlobPath(url.slice(DEV_BLOB_URL_PREFIX.length)));

      return true;
    } catch {
      return false;
    }
  },

  /** All document metas in a session's library, newest first. */
  async listDocuments(
    sid: string,
  ): Promise<DocumentMeta[]> {
    const library = await store.hgetall<DocumentMeta>(
      keys.library(sid),
    );

    if (!library) {
      return [];
    }

    return Object.values(library).sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  },

  /** Document metadata for one document, or null if absent. */
  async getDocumentMeta(
    sid: string,
    did: string,
  ): Promise<DocumentMeta | null> {
    const meta = await store.get<DocumentMeta>(
      keys.docMeta(sid, did),
    );

    if (meta) {
      return meta;
    }

    return store.hget<DocumentMeta>(
      keys.library(sid),
      did,
    );
  },

  /** Stored processing status for one document, or null if absent. */
  async getDocumentStatus(
    sid: string,
    did: string,
  ): Promise<DocumentStatusRecord | null> {
    return store.get<DocumentStatusRecord>(
      keys.docStatus(sid, did),
    );
  },

  /**
   * Deletes a document and all related artifacts, indexes, embeddings,
   * and storage keys for a session.
   *
   * Returns true if the document was found and deleted, false if it did not exist.
   */
  async deleteDocument(
    sid: string,
    did: string,
  ): Promise<boolean> {
    // 1. Fetch metadata first to get file URL before keys are removed
    const meta = await store.getDocumentMeta(sid, did);

    // 2. Remove atomically from library hash and docMeta
    const removedFromLib = await store.hdel(
      keys.library(sid),
      did,
    );

    const removedMeta = await store.del(
      keys.docMeta(sid, did),
    );

    if (removedFromLib === 0 && removedMeta === 0 && !meta) {
      return false;
    }

    // 3. Remove all remaining standard document keys
    const remainingKeys = keys.allDocKeys(sid, did).filter(
      (k) => k !== keys.docMeta(sid, did),
    );
    await store.del(...remainingKeys);

    // 4. Remove BM25 data (meta + batches)
    try {
      const bm25MetaKey = `${sid}:doc:${did}:bm25:meta`;
      const bm25Meta = await store.get<{
        generation: string;
        batchCount: number;
      }>(bm25MetaKey);

      if (bm25Meta) {
        const batchKeys = Array.from(
          { length: bm25Meta.batchCount },
          (_, index) =>
            `${sid}:doc:${did}:bm25:batch:${bm25Meta.generation}:${index}`,
        );
        if (batchKeys.length > 0) {
          await store.del(...batchKeys);
        }
        await store.del(bm25MetaKey);
      }
    } catch (err) {
      logger.warn(
        { err, sid, did },
        "Failed to clean up BM25 index on document delete",
      );
    }

    // 5. Remove embedding data (meta + batches)
    try {
      const embMetaKey = `${sid}:doc:${did}:emb:meta`;
      const embMeta = await store.get<{
        batchCount: number;
      }>(embMetaKey);

      if (embMeta) {
        const batchKeys = Array.from(
          { length: embMeta.batchCount },
          (_, index) =>
            `${sid}:doc:${did}:emb:batch:${index}`,
        );
        if (batchKeys.length > 0) {
          await store.del(...batchKeys);
        }
        await store.del(embMetaKey);
      }
    } catch (err) {
      logger.warn(
        { err, sid, did },
        "Failed to clean up embeddings on document delete",
      );
    }

    // 6. Remove conversations that reference this document.
    try {
      await store.deleteChatsForDocument(sid, did);
    } catch (err) {
      logger.warn(
        { err, sid, did },
        "Failed to clean up chats on document delete",
      );
    }

    // 7. Remove associated stored file if present
    const fileUrl = meta?.fileUrl;
    if (fileUrl) {
      await store.deleteFile(fileUrl);
    }

    return true;
  },

  /** Canonical text + page map + chunks for quote verification, or null. */
  async getDocumentForVerification(
    sid: string,
    did: string,
  ): Promise<{
    text: string;
    pages: { pageNumber: number; startOffset: number; endOffset: number }[];
    chunks: { id: string; kind?: string; text: string; startOffset: number; endOffset: number; parentId?: string }[];
  } | null> {
    const [text, pages, chunksRecord] = await Promise.all([
      store.get<string>(keys.docText(sid, did)),
      store.get<{ pageNumber: number; startOffset: number; endOffset: number }[]>(
        keys.docPages(sid, did),
      ),
      store.get<
        | { parents: { id: string; kind?: string; text: string; startOffset: number; endOffset: number; parentId?: string }[]; children: { id: string; kind?: string; text: string; startOffset: number; endOffset: number; parentId?: string }[]; all: { id: string; kind?: string; text: string; startOffset: number; endOffset: number; parentId?: string }[] }
        | { id: string; kind?: string; text: string; startOffset: number; endOffset: number; parentId?: string }[]
      >(keys.docChunks(sid, did)),
    ]);

    if (!text || !chunksRecord) {
      return null;
    }

    const chunks = Array.isArray(chunksRecord)
      ? chunksRecord
      : Array.isArray(chunksRecord.all)
        ? chunksRecord.all
        : [];

    return {
      text,
      pages: pages ?? [],
      chunks,
    };
  },

  /** One conversation by ID, or null. */
  async getChatConversation(
    sid: string,
    conversationId: string,
  ): Promise<ChatConversation | null> {
    return store.hget<ChatConversation>(
      keys.chatIndex(sid),
      conversationId,
    );
  },

  /** All conversations of the session (unsorted). */
  async listChatConversations(
    sid: string,
  ): Promise<ChatConversation[]> {
    const all = await store.hgetall<ChatConversation>(
      keys.chatIndex(sid),
    );

    return all ? Object.values(all) : [];
  },

  /**
   * Appends one message to a conversation, creating it on first write.
   * History is capped at MAX_MESSAGES_PER_CONVERSATION (oldest dropped).
   */
  async appendChatMessage(
    sid: string,
    conversationId: string,
    message: ChatMessage,
    documentIds: string[] = [],
  ): Promise<void> {
    const indexKey = keys.chatIndex(sid);

    const existing =
      await store.hget<ChatConversation>(indexKey, conversationId);

    const now = new Date().toISOString();

    const conversation: ChatConversation = existing ?? {
      conversationId,
      documentIds,
      messages: [],
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    conversation.messages.push(message);

    if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      conversation.messages = conversation.messages.slice(
        -MAX_MESSAGES_PER_CONVERSATION,
      );
    }

    conversation.updatedAt = now;

    await store.hset(indexKey, conversationId, conversation, TTL.CHAT);
  },

  /** Deletes every conversation of the session that includes the document. */
  async deleteChatsForDocument(
    sid: string,
    did: string,
  ): Promise<void> {
    const indexKey = keys.chatIndex(sid);

    const all = await store.hgetall<ChatConversation>(indexKey);

    if (!all) {
      return;
    }

    const doomed = Object.entries(all)
      .filter(([, conversation]) =>
        conversation.documentIds?.includes(did),
      )
      .map(([conversationId]) => conversationId);

    if (doomed.length > 0) {
      await store.hdel(indexKey, ...doomed);
    }
  },

  async ping(): Promise<boolean> {
    try {
      const result = isProduction
        ? await getProductionRedis().ping()
        : await localRedis.ping();

      return result === "PONG";
    } catch {
      return false;
    }
  },

  async health(): Promise<{
    redis: boolean;
    latencyMs: number;
    blob: boolean;
  }> {
    const start = Date.now();

    const redisOk =
      await store.ping();

    return {
      redis: redisOk,
      latencyMs: Date.now() - start,
      blob: Boolean(
        env.BLOB_READ_WRITE_TOKEN,
      ),
    };
  },
};