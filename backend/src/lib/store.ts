import { del, head } from "@vercel/blob";
import { Redis as UpstashRedis } from "@upstash/redis";

import { env } from "../config/env.js";
import { redis as localRedis } from "./redis.js";

const isProduction = env.NODE_ENV === "production";

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
): Promise<void> {
  if (keyList.length === 0) {
    return;
  }

  if (isProduction) {
    await getProductionRedis().del(...keyList);
    return;
  }

  await localRedis.del(...keyList);
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
  ): Promise<void> {
    await redisDelete(...keyList);
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
  ): Promise<void> {
    if (fields.length === 0) {
      return;
    }

    if (isProduction) {
      await getProductionRedis().hdel(
        key,
        ...fields,
      );
      return;
    }

    await localRedis.hdel(
      key,
      ...fields,
    );
  },

  async deleteFile(
    url: string,
  ): Promise<void> {
    if (!env.BLOB_READ_WRITE_TOKEN) {
      return;
    }

    try {
      await del(url);
    } catch {
      // Blob deletion is non-fatal.
    }
  },

  async fileExists(
    url: string,
  ): Promise<boolean> {
    try {
      requireBlobToken();

      await head(url);

      return true;
    } catch {
      return false;
    }
  },

  async deleteDocument(
    sid: string,
    did: string,
  ): Promise<void> {
    await store.del(
      ...keys.allDocKeys(sid, did),
    );

    await store.hdel(
      keys.library(sid),
      did,
    );
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