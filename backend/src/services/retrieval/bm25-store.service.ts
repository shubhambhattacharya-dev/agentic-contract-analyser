import { randomUUID } from "node:crypto";

import { store } from "../../lib/store.js";
import {
  BM25Index,
  type BM25Document,
  type BM25IndexData,
} from "./bm25.service.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const BM25_VERSION = 1 as const;

const BATCH_SIZE = 250 as const;

const DEFAULT_TTL_SECONDS = 86_400 as const;

const BM25_META_SUFFIX = "bm25:meta" as const;
const BM25_BATCH_SUFFIX = "bm25:batch" as const;

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

// ─── Types ────────────────────────────────────────────────────────────────────

interface BM25Meta {
  version: 1;
  generation: string;
  k1: number;
  b: number;
  documentCount: number;
  averageDocumentLength: number;
  batchCount: number;
  documentFrequency: Record<string, number>;
}

export interface BM25StoreOptions {
  /**
   * TTL in seconds.
   *
   * Default: 24 hours.
   * Pass 0 to disable expiration.
   */
  ttlSeconds?: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class BM25StoreError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BM25StoreError";
  }
}

// ─── Key Helpers ──────────────────────────────────────────────────────────────

function getMetaKey(
  sessionId: string,
  documentId: string,
): string {
  return `${sessionId}:doc:${documentId}:${BM25_META_SUFFIX}`;
}

function getBatchKey(
  sessionId: string,
  documentId: string,
  generation: string,
  batchNumber: number,
): string {
  return (
    `${sessionId}:doc:${documentId}:` +
    `${BM25_BATCH_SUFFIX}:${generation}:${batchNumber}`
  );
}

function getBatchKeys(
  sessionId: string,
  documentId: string,
  generation: string,
  batchCount: number,
): string[] {
  return Array.from(
    { length: batchCount },
    (_, index) =>
      getBatchKey(
        sessionId,
        documentId,
        generation,
        index,
      ),
  );
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateIdentifiers(
  sessionId: string,
  documentId: string,
): void {
  if (!SAFE_ID_PATTERN.test(sessionId)) {
    throw new BM25StoreError(
      "Invalid session ID.",
    );
  }

  if (!SAFE_ID_PATTERN.test(documentId)) {
    throw new BM25StoreError(
      "Invalid document ID.",
    );
  }
}

function validateTTL(ttlSeconds: number): void {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 0
  ) {
    throw new BM25StoreError(
      "TTL must be a non-negative integer.",
    );
  }
}

// ─── Batching ─────────────────────────────────────────────────────────────────

function batchDocuments(
  documents: BM25Document[],
): BM25Document[][] {
  const batches: BM25Document[][] = [];

  for (
    let start = 0;
    start < documents.length;
    start += BATCH_SIZE
  ) {
    batches.push(
      documents.slice(
        start,
        start + BATCH_SIZE,
      ),
    );
  }

  return batches;
}

// ─── Redis Helpers ────────────────────────────────────────────────────────────

async function setWithTTL<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  if (ttlSeconds === 0) {
    await store.set(key, value);
    return;
  }

  await store.set(
    key,
    value,
    ttlSeconds,
  );
}

async function deleteKeys(
  keys: string[],
): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  await Promise.all(
    keys.map((key) => store.del(key)),
  );
}

// ─── Save ─────────────────────────────────────────────────────────────────────

export async function saveBM25Index(
  sessionId: string,
  documentId: string,
  index: BM25Index,
  options: BM25StoreOptions = {},
): Promise<void> {
  validateIdentifiers(
    sessionId,
    documentId,
  );

  const ttl =
    options.ttlSeconds ??
    DEFAULT_TTL_SECONDS;

  validateTTL(ttl);

  try {
    const data = index.toJSON();

    const batches = batchDocuments(
      data.documents,
    );

    const generation = randomUUID();

    const meta: BM25Meta = {
      version: BM25_VERSION,
      generation,
      k1: data.k1,
      b: data.b,
      documentCount:
        data.documentCount,
      averageDocumentLength:
        data.averageDocumentLength,
      batchCount: batches.length,
      documentFrequency:
        data.documentFrequency,
    };

    const batchWrites = batches.map(
      (batch, indexNumber) =>
        setWithTTL(
          getBatchKey(
            sessionId,
            documentId,
            generation,
            indexNumber,
          ),
          batch,
          ttl,
        ),
    );

    /*
     * Write all batches first.
     *
     * The metadata is intentionally written last.
     * Metadata acts as the commit marker.
     */
    await Promise.all(batchWrites);

    await setWithTTL(
      getMetaKey(
        sessionId,
        documentId,
      ),
      meta,
      ttl,
    );
  } catch (error) {
    if (error instanceof BM25StoreError) {
      throw error;
    }

    throw new BM25StoreError(
      "Failed to save BM25 index.",
      error,
    );
  }
}

// ─── Load ─────────────────────────────────────────────────────────────────────

export async function loadBM25Index(
  sessionId: string,
  documentId: string,
): Promise<BM25Index | null> {
  validateIdentifiers(
    sessionId,
    documentId,
  );

  try {
    const meta =
      await store.get<BM25Meta>(
        getMetaKey(
          sessionId,
          documentId,
        ),
      );

    if (!meta) {
      return null;
    }

    if (meta.version !== BM25_VERSION) {
      throw new BM25StoreError(
        `Unsupported BM25 index version: ${meta.version}`,
      );
    }

    if (!meta.generation) {
      throw new BM25StoreError(
        "BM25 index generation is missing.",
      );
    }

    const batchKeys = getBatchKeys(
      sessionId,
      documentId,
      meta.generation,
      meta.batchCount,
    );

    /*
     * Read all batches concurrently.
     */
    const batches = await Promise.all(
      batchKeys.map((key) =>
        store.get<BM25Document[]>(key),
      ),
    );

    const documents: BM25Document[] = [];

    for (
      let indexNumber = 0;
      indexNumber < batches.length;
      indexNumber += 1
    ) {
      const batch =
        batches[indexNumber];

      if (!batch) {
        throw new BM25StoreError(
          `BM25 batch ${indexNumber} is missing.`,
        );
      }

      documents.push(...batch);
    }

    if (
      documents.length !==
      meta.documentCount
    ) {
      throw new BM25StoreError(
        "BM25 document count does not match stored metadata.",
      );
    }

    const data: BM25IndexData = {
      version: BM25_VERSION,
      k1: meta.k1,
      b: meta.b,
      documentCount:
        meta.documentCount,
      averageDocumentLength:
        meta.averageDocumentLength,
      documents,
      documentFrequency:
        meta.documentFrequency,
    };

    return BM25Index.fromJSON(data);
  } catch (error) {
    if (error instanceof BM25StoreError) {
      throw error;
    }

    throw new BM25StoreError(
      "Failed to load BM25 index.",
      error,
    );
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteBM25Index(
  sessionId: string,
  documentId: string,
): Promise<void> {
  validateIdentifiers(
    sessionId,
    documentId,
  );

  try {
    const meta =
      await store.get<BM25Meta>(
        getMetaKey(
          sessionId,
          documentId,
        ),
      );

    if (!meta) {
      return;
    }

    const batchKeys = getBatchKeys(
      sessionId,
      documentId,
      meta.generation,
      meta.batchCount,
    );

    /*
     * Delete batches first.
     *
     * Metadata remains until all batches are deleted.
     * If deletion fails, the metadata remains available
     * so the operation can be retried.
     */
    await deleteKeys(batchKeys);

    await store.del(
      getMetaKey(
        sessionId,
        documentId,
      ),
    );
  } catch (error) {
    if (error instanceof BM25StoreError) {
      throw error;
    }

    throw new BM25StoreError(
      "Failed to delete BM25 index.",
      error,
    );
  }
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateBM25Index(
  sessionId: string,
  documentId: string,
  index: BM25Index,
  options: BM25StoreOptions = {},
): Promise<void> {
  validateIdentifiers(
    sessionId,
    documentId,
  );

  const ttl =
    options.ttlSeconds ??
    DEFAULT_TTL_SECONDS;

  validateTTL(ttl);

  try {
    /*
     * Read the current generation before
     * writing the replacement.
     */
    const previousMeta =
      await store.get<BM25Meta>(
        getMetaKey(
          sessionId,
          documentId,
        ),
      );

    /*
     * Save creates a completely new generation.
     * The old generation remains available
     * until the new metadata is committed.
     */
    await saveBM25Index(
      sessionId,
      documentId,
      index,
      { ttlSeconds: ttl },
    );

    /*
     * Read the new committed generation.
     */
    const newMeta =
      await store.get<BM25Meta>(
        getMetaKey(
          sessionId,
          documentId,
        ),
      );

    if (!newMeta) {
      throw new BM25StoreError(
        "BM25 index update was not committed.",
      );
    }

    /*
     * Delete only the old generation.
     */
    if (
      previousMeta &&
      previousMeta.generation !==
        newMeta.generation
    ) {
      const oldBatchKeys =
        getBatchKeys(
          sessionId,
          documentId,
          previousMeta.generation,
          previousMeta.batchCount,
        );

      await deleteKeys(oldBatchKeys);
    }
  } catch (error) {
    if (error instanceof BM25StoreError) {
      throw error;
    }

    throw new BM25StoreError(
      "Failed to update BM25 index.",
      error,
    );
  }
}

// ─── Existence ────────────────────────────────────────────────────────────────

export async function hasBM25Index(
  sessionId: string,
  documentId: string,
): Promise<boolean> {
  validateIdentifiers(
    sessionId,
    documentId,
  );

  try {
    return await store.exists(
      getMetaKey(
        sessionId,
        documentId,
      ),
    );
  } catch (error) {
    throw new BM25StoreError(
      "Failed to check BM25 index existence.",
      error,
    );
  }
}