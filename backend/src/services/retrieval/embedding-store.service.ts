import { store } from "../../lib/store.js";
import type { EmbeddingVector } from "./embedding.service.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const EMBEDDING_VERSION = 1 as const;
const DEFAULT_BATCH_SIZE = 100 as const;
const DEFAULT_TTL_SECONDS = 86_400 as const;

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredEmbeddingMeta {
  version: typeof EMBEDDING_VERSION;
  model: string;
  dimensions: number;
  embeddingCount: number;
  batchCount: number;
}

export interface StoredEmbeddingResult {
  embeddings: EmbeddingVector[];
  model: string;
  dimensions: number;
}

export interface EmbeddingStoreOptions {
  ttlSeconds?: number;
  batchSize?: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class EmbeddingStoreError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbeddingStoreError";
  }
}

// ─── Key Helpers ──────────────────────────────────────────────────────────────

function getMetaKey(
  sessionId: string,
  documentId: string,
): string {
  return `${sessionId}:doc:${documentId}:emb:meta`;
}

function getBatchKey(
  sessionId: string,
  documentId: string,
  batchNumber: number,
): string {
  return `${sessionId}:doc:${documentId}:emb:batch:${batchNumber}`;
}

function getAllBatchKeys(
  sessionId: string,
  documentId: string,
  batchCount: number,
): string[] {
  return Array.from(
    { length: batchCount },
    (_, index) =>
      getBatchKey(
        sessionId,
        documentId,
        index,
      ),
  );
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateIdentifier(
  value: string,
  name: string,
): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new EmbeddingStoreError(
      `Invalid ${name}: must be 1-128 characters and contain only letters, digits, underscores, or dashes.`,
    );
  }
}

function validateIdentifiers(
  sessionId: string,
  documentId: string,
): void {
  validateIdentifier(sessionId, "session ID");
  validateIdentifier(documentId, "document ID");
}

function validateTTL(
  ttlSeconds: number,
): void {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 0
  ) {
    throw new EmbeddingStoreError(
      "TTL must be a non-negative integer.",
    );
  }
}

function validateBatchSize(
  batchSize: number,
): void {
  if (
    !Number.isInteger(batchSize) ||
    batchSize <= 0
  ) {
    throw new EmbeddingStoreError(
      "Batch size must be a positive integer.",
    );
  }
}

function validateResult(
  result: StoredEmbeddingResult,
): void {
  if (!result.model.trim()) {
    throw new EmbeddingStoreError(
      "Embedding model is required.",
    );
  }

  if (
    !Number.isInteger(result.dimensions) ||
    result.dimensions <= 0
  ) {
    throw new EmbeddingStoreError(
      "Embedding dimensions must be a positive integer.",
    );
  }

  for (const embedding of result.embeddings) {
    if (!embedding.chunkId.trim()) {
      throw new EmbeddingStoreError(
        "Embedding chunk ID cannot be empty.",
      );
    }

    if (
      embedding.values.length !==
      result.dimensions
    ) {
      throw new EmbeddingStoreError(
        `Embedding dimensions mismatch for chunk ${embedding.chunkId}.`,
      );
    }
  }
}

// ─── Batch Helpers ────────────────────────────────────────────────────────────

function createBatches(
  embeddings: EmbeddingVector[],
  batchSize: number,
): EmbeddingVector[][] {
  const batches: EmbeddingVector[][] = [];

  for (
    let start = 0;
    start < embeddings.length;
    start += batchSize
  ) {
    batches.push(
      embeddings.slice(
        start,
        start + batchSize,
      ),
    );
  }

  return batches;
}

function storeSet<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  if (ttlSeconds === 0) {
    return store.set(key, value);
  }

  return store.set(
    key,
    value,
    ttlSeconds,
  );
}

// ─── Save ─────────────────────────────────────────────────────────────────────

export async function saveEmbeddings(
  sessionId: string,
  documentId: string,
  result: StoredEmbeddingResult,
  options: EmbeddingStoreOptions = {},
): Promise<void> {
  validateIdentifiers(
    sessionId,
    documentId,
  );

  const ttlSeconds =
    options.ttlSeconds ??
    DEFAULT_TTL_SECONDS;

  const batchSize =
    options.batchSize ??
    DEFAULT_BATCH_SIZE;

  validateTTL(ttlSeconds);
  validateBatchSize(batchSize);
  validateResult(result);

  try {
    const batches = createBatches(
      result.embeddings,
      batchSize,
    );

    const meta: StoredEmbeddingMeta = {
      version: EMBEDDING_VERSION,
      model: result.model,
      dimensions: result.dimensions,
      embeddingCount:
        result.embeddings.length,
      batchCount: batches.length,
    };

    /*
     * Write batches first.
     * Metadata is written last and acts as the commit marker.
     */
    await Promise.all(
      batches.map((batch, index) =>
        storeSet(
          getBatchKey(
            sessionId,
            documentId,
            index,
          ),
          batch,
          ttlSeconds,
        ),
      ),
    );

    await storeSet(
      getMetaKey(
        sessionId,
        documentId,
      ),
      meta,
      ttlSeconds,
    );
  } catch (error) {
    if (
      error instanceof EmbeddingStoreError
    ) {
      throw error;
    }

    throw new EmbeddingStoreError(
      "Failed to save embeddings.",
      error,
    );
  }
}

// ─── Load ─────────────────────────────────────────────────────────────────────

export async function loadEmbeddings(
  sessionId: string,
  documentId: string,
): Promise<StoredEmbeddingResult | null> {
  validateIdentifiers(
    sessionId,
    documentId,
  );

  try {
    const meta =
      await store.get<StoredEmbeddingMeta>(
        getMetaKey(
          sessionId,
          documentId,
        ),
      );

    if (!meta) {
      return null;
    }

    if (
      meta.version !== EMBEDDING_VERSION
    ) {
      throw new EmbeddingStoreError(
        `Unsupported embedding version: ${meta.version}`,
      );
    }

    const keys =
      getAllBatchKeys(
        sessionId,
        documentId,
        meta.batchCount,
      );

    const batches =
      await Promise.all(
        keys.map((key) =>
          store.get<EmbeddingVector[]>(
            key,
          ),
        ),
      );

    const embeddings: EmbeddingVector[] =
      [];

    for (
      let index = 0;
      index < batches.length;
      index += 1
    ) {
      const batch = batches[index];

      if (!batch) {
        throw new EmbeddingStoreError(
          `Embedding batch ${index} is missing.`,
        );
      }

      embeddings.push(...batch);
    }

    if (
      embeddings.length !==
      meta.embeddingCount
    ) {
      throw new EmbeddingStoreError(
        `Embedding count mismatch: expected ${meta.embeddingCount}, got ${embeddings.length}.`,
      );
    }

    return {
      embeddings,
      model: meta.model,
      dimensions: meta.dimensions,
    };
  } catch (error) {
    if (
      error instanceof EmbeddingStoreError
    ) {
      throw error;
    }

    throw new EmbeddingStoreError(
      "Failed to load embeddings.",
      error,
    );
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteEmbeddings(
  sessionId: string,
  documentId: string,
): Promise<void> {
  validateIdentifiers(
    sessionId,
    documentId,
  );

  try {
    const meta =
      await store.get<StoredEmbeddingMeta>(
        getMetaKey(
          sessionId,
          documentId,
        ),
      );

    if (!meta) {
      return;
    }

    const batchKeys =
      getAllBatchKeys(
        sessionId,
        documentId,
        meta.batchCount,
      );

    /*
     * Delete batches first.
     * Keep metadata until all batches are removed.
     */
    await Promise.all(
      batchKeys.map((key) =>
        store.del(key),
      ),
    );

    await store.del(
      getMetaKey(
        sessionId,
        documentId,
      ),
    );
  } catch (error) {
    if (
      error instanceof EmbeddingStoreError
    ) {
      throw error;
    }

    throw new EmbeddingStoreError(
      "Failed to delete embeddings.",
      error,
    );
  }
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateEmbeddings(
  sessionId: string,
  documentId: string,
  result: StoredEmbeddingResult,
  options: EmbeddingStoreOptions = {},
): Promise<void> {
  validateIdentifiers(
    sessionId,
    documentId,
  );

  await deleteEmbeddings(
    sessionId,
    documentId,
  );

  await saveEmbeddings(
    sessionId,
    documentId,
    result,
    options,
  );
}

// ─── Existence ────────────────────────────────────────────────────────────────

export async function hasEmbeddings(
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
    throw new EmbeddingStoreError(
      "Failed to check embedding existence.",
      error,
    );
  }
}