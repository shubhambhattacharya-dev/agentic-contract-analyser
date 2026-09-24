import { logger } from "../../lib/logger.js";
import type { DocumentChunk } from "../ingestion/chunk.service.js";

import { embedQuery } from "./embedding.service.js";
import { searchVectors } from "./vector-search.service.js";
import { reciprocalRankFusion } from "./hybrid.service.js";
import { loadBM25Index } from "./bm25-store.service.js";
import { loadVectorStore } from "./vector-store.service.js";

import type { HybridSearchResult } from "./hybrid.service.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TOP_K = 15 as const;
const DEFAULT_RRF_K = 60 as const;
const DEFAULT_MIN_BM25_SCORE = 0 as const;
const DEFAULT_MIN_VECTOR_SCORE = 0 as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RetrievalOptions {
  topK?: number;
  rrfK?: number;
  minBM25Score?: number;
  minVectorScore?: number;
}

export interface RetrievalResult extends HybridSearchResult {
  chunk: DocumentChunk;
}

export interface RetrievalResponse {
  query: string;
  results: RetrievalResult[];
  bm25Count: number;
  vectorCount: number;
  retrievedCount: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class RetrievalError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RetrievalError";
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateQuery(query: string): string {
  if (typeof query !== "string") {
    throw new RetrievalError(
      "Retrieval query must be a string.",
    );
  }

  const normalized = query.trim();

  if (!normalized) {
    throw new RetrievalError(
      "Retrieval query cannot be empty.",
    );
  }

  return normalized;
}

function validatePositiveInteger(
  value: number,
  name: string,
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RetrievalError(
      `${name} must be a positive integer.`,
    );
  }
}

function validateScore(
  value: number,
  name: string,
): void {
  if (!Number.isFinite(value)) {
    throw new RetrievalError(
      `${name} must be a finite number.`,
    );
  }
}

function resolveOptions(
  options: RetrievalOptions,
): Required<RetrievalOptions> {
  const topK =
    options.topK ?? DEFAULT_TOP_K;

  const rrfK =
    options.rrfK ?? DEFAULT_RRF_K;

  const minBM25Score =
    options.minBM25Score ??
    DEFAULT_MIN_BM25_SCORE;

  const minVectorScore =
    options.minVectorScore ??
    DEFAULT_MIN_VECTOR_SCORE;

  validatePositiveInteger(
    topK,
    "topK",
  );

  validatePositiveInteger(
    rrfK,
    "rrfK",
  );

  validateScore(
    minBM25Score,
    "minBM25Score",
  );

  validateScore(
    minVectorScore,
    "minVectorScore",
  );

  return {
    topK,
    rrfK,
    minBM25Score,
    minVectorScore,
  };
}

// ─── Chunk Hydration ──────────────────────────────────────────────────────────

function hydrateResults(
  results: HybridSearchResult[],
  chunks: DocumentChunk[],
): RetrievalResult[] {
  const chunkMap = new Map<string, DocumentChunk>();

  for (const chunk of chunks) {
    chunkMap.set(chunk.id, chunk);
  }

  const hydrated: RetrievalResult[] = [];

  for (const result of results) {
    const chunk = chunkMap.get(result.id);

    if (!chunk) {
      logger.warn(
        { chunkId: result.id },
        "Hybrid result could not be hydrated.",
      );

      continue;
    }

    hydrated.push({
      ...result,
      chunk,
    });
  }

  return hydrated;
}

// ─── Core Retrieval ───────────────────────────────────────────────────────────

export async function retrieve(
  sessionId: string,
  documentId: string,
  query: string,
  chunks: DocumentChunk[],
  options: RetrievalOptions = {},
): Promise<RetrievalResponse> {
  const normalizedQuery =
    validateQuery(query);

  const resolved =
    resolveOptions(options);

  if (chunks.length === 0) {
    logger.warn(
      {
        sessionId,
        documentId,
      },
      "Retrieval called with no document chunks.",
    );

    return {
      query: normalizedQuery,
      results: [],
      bm25Count: 0,
      vectorCount: 0,
      retrievedCount: 0,
    };
  }

  try {
    const [bm25Index, vectorStore] =
      await Promise.all([
        loadBM25Index(
          sessionId,
          documentId,
        ),
        loadVectorStore(
          sessionId,
          documentId,
        ),
      ]);

    if (!bm25Index) {
      throw new RetrievalError(
        "BM25 index is not available for this document.",
      );
    }

    if (!vectorStore) {
      throw new RetrievalError(
        "Vector store is not available for this document.",
      );
    }

    const queryVector =
      await embedQuery(
        normalizedQuery,
      );

    const bm25Results =
      bm25Index.search(
        normalizedQuery,
        {
          topK: resolved.topK,
          minScore:
            resolved.minBM25Score,
        },
      );

    const vectorResults =
      searchVectors(
        queryVector,
        vectorStore.embeddings,
        {
          topK: resolved.topK,
          minScore:
            resolved.minVectorScore,
        },
      );

    logger.debug(
      {
        sessionId,
        documentId,
        bm25Count: bm25Results.length,
        vectorCount: vectorResults.length,
        topK: resolved.topK,
        rrfK: resolved.rrfK,
      },
      "Retrieval candidates ready.",
    );

    const hybridResults =
      reciprocalRankFusion(
        bm25Results,
        vectorResults,
        {
          topK: resolved.topK,
          rrfK: resolved.rrfK,
        },
      );

    const results =
      hydrateResults(
        hybridResults,
        chunks,
      );

    logger.info(
      {
        sessionId,
        documentId,
        queryLength: normalizedQuery.length,
        bm25Count: bm25Results.length,
        vectorCount: vectorResults.length,
        hybridCount: hybridResults.length,
        retrievedCount: results.length,
      },
      "Retrieval complete.",
    );

    return {
      query: normalizedQuery,
      results,
      bm25Count: bm25Results.length,
      vectorCount: vectorResults.length,
      retrievedCount: results.length,
    };
  } catch (error) {
    if (error instanceof RetrievalError) {
      throw error;
    }

    throw new RetrievalError(
      "Failed to retrieve relevant document chunks.",
      error,
    );
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export {
  DEFAULT_TOP_K,
  DEFAULT_RRF_K,
  DEFAULT_MIN_BM25_SCORE,
  DEFAULT_MIN_VECTOR_SCORE,
};