import { store } from "../../lib/store.js";
import type { EmbeddingVector } from "./embedding.service.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const VECTOR_STORE_VERSION = 1 as const;
const DEFAULT_BATCH_SIZE = 100 as const;
const DEFAULT_TTL_SECONDS = 86_400 as const;

const SAFE_ID_PATTERN = /^[\w-]{1,128}$/u;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredVectorMeta {
  version: 1;
  model: string;
  dimensions: number;
  embeddingCount: number;
  batchCount: number;
}

export interface StoredVectorResult {
  embeddings: EmbeddingVector[];
  model: string;
  dimensions: number;
}

export interface VectorStoreOptions {
  batchSize?: number;
  ttlSeconds?: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class VectorStoreError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VectorStoreError";
  }
}

// ─── Key Helpers ──────────────────────────────────────────────────────────────

function getMetaKey(sessionId: string, documentId: string): string {
  return `${sessionId}:doc:${documentId}:vector:meta`;
}

function getBatchKey(
  sessionId: string,
  documentId: string,
  batchNumber: number,
): string {
  return `${sessionId}:doc:${documentId}:vector:batch:${batchNumber}`;
}

function getAllBatchKeys(
  sessionId: string,
  documentId: string,
  batchCount: number,
): string[] {
  return Array.from(
    { length: batchCount },
    (_, index) => getBatchKey(sessionId, documentId, index),
  );
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateIdentifier(value: string, name: string): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new VectorStoreError(
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

function validateTTL(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0) {
    throw new VectorStoreError(
      "TTL must be a non-negative integer.",
    );
  }
}

function validateBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new VectorStoreError(
      "Batch size must be a positive integer.",
    );
  }
}

function validateDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new VectorStoreError(
      "Vector dimensions must be a positive integer.",
    );
  }
}

function validateModel(model: string): void {
  if (
    typeof model !== "string" ||
    model.trim().length === 0
  ) {
    throw new VectorStoreError(
      "Model name must be a non-empty string.",
    );
  }
}

// ─── Embedding Validation ─────────────────────────────────────────────────────

function validateEmbeddingsForWrite(
  embeddings: EmbeddingVector[],
  dimensions: number,
): void {
  if (!Array.isArray(embeddings)) {
    throw new VectorStoreError(
      "Embeddings must be an array.",
    );
  }

  for (const embedding of embeddings) {
    if (
      typeof embedding.chunkId !== "string" ||
      embedding.chunkId.trim().length === 0
    ) {
      throw new VectorStoreError(
        "Embedding is missing a valid chunk ID.",
      );
    }

    if (
      !Array.isArray(embedding.values) ||
      embedding.values.length === 0
    ) {
      throw new VectorStoreError(
        `Embedding ${embedding.chunkId} has no vector values.`,
      );
    }

    if (embedding.values.length !== dimensions) {
      throw new VectorStoreError(
        `Embedding ${embedding.chunkId} has dimension ${embedding.values.length}; expected ${dimensions}.`,
      );
    }

    for (const value of embedding.values) {
      if (!Number.isFinite(value)) {
        throw new VectorStoreError(
          `Embedding ${embedding.chunkId} contains a non-finite value.`,
        );
      }
    }
  }
}

function validateEmbeddingsForRead(
  embeddings: EmbeddingVector[],
  dimensions: number,
): void {
  for (const embedding of embeddings) {
    if (
      typeof embedding.chunkId !== "string" ||
      embedding.chunkId.trim().length === 0
    ) {
      throw new VectorStoreError(
        "Stored embedding is missing a valid chunk ID.",
      );
    }

    if (!Array.isArray(embedding.values)) {
      throw new VectorStoreError(
        `Stored embedding ${embedding.chunkId} has no values array.`,
      );
    }

    if (embedding.values.length !== dimensions) {
      throw new VectorStoreError(
        `Stored embedding ${embedding.chunkId} has dimension ${embedding.values.length}; expected ${dimensions}.`,
      );
    }
  }
}

// ─── Metadata Validation ──────────────────────────────────────────────────────

function validateMeta(meta: StoredVectorMeta): void {
  if (meta.version !== VECTOR_STORE_VERSION) {
    throw new VectorStoreError(
      `Unsupported vector store version: ${meta.version}.`,
    );
  }

  validateModel(meta.model);
  validateDimensions(meta.dimensions);

  if (
    !Number.isInteger(meta.embeddingCount) ||
    meta.embeddingCount < 0
  ) {
    throw new VectorStoreError(
      "Invalid embedding count in metadata.",
    );
  }

  if (
    !Number.isInteger(meta.batchCount) ||
    meta.batchCount < 0
  ) {
    throw new VectorStoreError(
      "Invalid batch count in metadata.",
    );
  }

  if (
    meta.embeddingCount > 0 &&
    meta.batchCount === 0
  ) {
    throw new VectorStoreError(
      "Metadata reports embeddings but zero batches.",
    );
  }

  if (
    meta.embeddingCount === 0 &&
    meta.batchCount !== 0
  ) {
    throw new VectorStoreError(
      "Metadata reports zero embeddings but contains batches.",
    );
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
      embeddings.slice(start, start + batchSize),
    );
  }

  return batches;
}

function storeSet<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  if (ttlSeconds > 0) {
    return store.set(key, value, ttlSeconds);
  }

  return store.set(key, value);
}

// ─── Save ─────────────────────────────────────────────────────────────────────

export async function saveVectorStore(
  sessionId: string,
  documentId: string,
  result: StoredVectorResult,
  options: VectorStoreOptions = {},
): Promise<void> {
  validateIdentifiers(sessionId, documentId);

  try {
    const batchSize =
      options.batchSize ?? DEFAULT_BATCH_SIZE;

    const ttlSeconds =
      options.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    validateBatchSize(batchSize);
    validateTTL(ttlSeconds);
    validateDimensions(result.dimensions);
    validateModel(result.model);

    validateEmbeddingsForWrite(
      result.embeddings,
      result.dimensions,
    );

    const batches = createBatches(
      result.embeddings,
      batchSize,
    );

    const meta: StoredVectorMeta = {
      version: VECTOR_STORE_VERSION,
      model: result.model,
      dimensions: result.dimensions,
      embeddingCount: result.embeddings.length,
      batchCount: batches.length,
    };

    // Write batches first.
    // Metadata is the commit marker.
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

    // Write metadata last.
    await storeSet(
      getMetaKey(sessionId, documentId),
      meta,
      ttlSeconds,
    );
  } catch (error) {
    if (error instanceof VectorStoreError) {
      throw error;
    }

    throw new VectorStoreError(
      "Failed to save vector embeddings.",
      error,
    );
  }
}

// ─── Load ─────────────────────────────────────────────────────────────────────

export async function loadVectorStore(
  sessionId: string,
  documentId: string,
): Promise<StoredVectorResult | null> {
  validateIdentifiers(sessionId, documentId);

  try {
    const meta = await store.get<StoredVectorMeta>(
      getMetaKey(sessionId, documentId),
    );

    if (!meta) {
      return null;
    }

    validateMeta(meta);

    const batchKeys = getAllBatchKeys(
      sessionId,
      documentId,
      meta.batchCount,
    );

    const batches = await Promise.all(
      batchKeys.map((key) =>
        store.get<EmbeddingVector[]>(key),
      ),
    );

    const embeddings: EmbeddingVector[] = [];

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];

      if (!batch) {
        throw new VectorStoreError(
          `Vector embedding batch ${index} is missing.`,
        );
      }

      embeddings.push(...batch);
    }

    if (
      embeddings.length !== meta.embeddingCount
    ) {
      throw new VectorStoreError(
        `Embedding count mismatch: expected ${meta.embeddingCount}, got ${embeddings.length}.`,
      );
    }

    validateEmbeddingsForRead(
      embeddings,
      meta.dimensions,
    );

    return {
      embeddings,
      model: meta.model,
      dimensions: meta.dimensions,
    };
  } catch (error) {
    if (error instanceof VectorStoreError) {
      throw error;
    }

    throw new VectorStoreError(
      "Failed to load vector embeddings.",
      error,
    );
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteVectorStore(
  sessionId: string,
  documentId: string,
): Promise<void> {
  validateIdentifiers(sessionId, documentId);

  try {
    const meta = await store.get<StoredVectorMeta>(
      getMetaKey(sessionId, documentId),
    );

    if (!meta) {
      return;
    }

    validateMeta(meta);

    const batchKeys = getAllBatchKeys(
      sessionId,
      documentId,
      meta.batchCount,
    );

    // Delete batches first.
    // Keep metadata until all batches are removed.
    await Promise.all(
      batchKeys.map((key) => store.del(key)),
    );

    // Metadata is deleted last.
    await store.del(
      getMetaKey(sessionId, documentId),
    );
  } catch (error) {
    if (error instanceof VectorStoreError) {
      throw error;
    }

    throw new VectorStoreError(
      "Failed to delete vector embeddings.",
      error,
    );
  }
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateVectorStore(
  sessionId: string,
  documentId: string,
  result: StoredVectorResult,
  options: VectorStoreOptions = {},
): Promise<void> {
  validateIdentifiers(sessionId, documentId);

  // Validate the new data before deleting the old index.
  // This prevents invalid input from destroying a valid existing index.
  try {
    const batchSize =
      options.batchSize ?? DEFAULT_BATCH_SIZE;

    const ttlSeconds =
      options.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    validateBatchSize(batchSize);
    validateTTL(ttlSeconds);
    validateDimensions(result.dimensions);
    validateModel(result.model);

    validateEmbeddingsForWrite(
      result.embeddings,
      result.dimensions,
    );
  } catch (error) {
    if (error instanceof VectorStoreError) {
      throw error;
    }

    throw new VectorStoreError(
      "Failed to validate vector update.",
      error,
    );
  }

  await deleteVectorStore(
    sessionId,
    documentId,
  );

  await saveVectorStore(
    sessionId,
    documentId,
    result,
    options,
  );
}

// ─── Existence ────────────────────────────────────────────────────────────────

export async function hasVectorStore(
  sessionId: string,
  documentId: string,
): Promise<boolean> {
  validateIdentifiers(sessionId, documentId);

  try {
    return await store.exists(
      getMetaKey(sessionId, documentId),
    );
  } catch (error) {
    if (error instanceof VectorStoreError) {
      throw error;
    }

    throw new VectorStoreError(
      "Failed to check vector store existence.",
      error,
    );
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export {
  VECTOR_STORE_VERSION,
  DEFAULT_BATCH_SIZE,
  DEFAULT_TTL_SECONDS,
};