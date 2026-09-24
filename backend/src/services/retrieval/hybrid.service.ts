import type { DocumentChunk } from "../ingestion/chunk.service.js";
import {
  BM25Index,
  type BM25SearchResult,
} from "./bm25.service.js";
import { logger } from "../../lib/logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TOP_K = 15 as const;
const DEFAULT_RRF_K = 60 as const;
const DEFAULT_MIN_SCORE = 0 as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VectorSearchResult {
  id: string;
  score: number;
}

export interface HybridSearchOptions {
  topK?: number;
  rrfK?: number;
  minBM25Score?: number;
  minVectorScore?: number;
}

export interface HybridSearchResult {
  id: string;
  score: number;
  bm25Rank: number | null;
  vectorRank: number | null;
  bm25Score: number | null;
  vectorScore: number | null;
}

export interface HydratedHybridResult
  extends HybridSearchResult {
  chunk: DocumentChunk;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class HybridSearchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HybridSearchError";
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateTopK(topK: number): void {
  if (!Number.isInteger(topK) || topK <= 0) {
    throw new HybridSearchError(
      "topK must be a positive integer.",
    );
  }
}

function validateRrfK(rrfK: number): void {
  if (!Number.isInteger(rrfK) || rrfK <= 0) {
    throw new HybridSearchError(
      "rrfK must be a positive integer.",
    );
  }
}

function validateMinScore(
  value: number,
  label: string,
): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new HybridSearchError(
      `${label} must be a non-negative finite number.`,
    );
  }
}

function validateSearchResult(
  result: BM25SearchResult | VectorSearchResult,
): void {
  if (!result.id || typeof result.id !== "string") {
    throw new HybridSearchError(
      "Search result must contain a valid ID.",
    );
  }

  if (!Number.isFinite(result.score)) {
    throw new HybridSearchError(
      `Search result "${result.id}" has an invalid score.`,
    );
  }
}

function resolveOptions(
  options: HybridSearchOptions,
): Required<HybridSearchOptions> {
  const topK =
    options.topK ?? DEFAULT_TOP_K;

  const rrfK =
    options.rrfK ?? DEFAULT_RRF_K;

  const minBM25Score =
    options.minBM25Score ?? DEFAULT_MIN_SCORE;

  const minVectorScore =
    options.minVectorScore ?? DEFAULT_MIN_SCORE;

  validateTopK(topK);
  validateRrfK(rrfK);
  validateMinScore(
    minBM25Score,
    "minBM25Score",
  );
  validateMinScore(
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

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function addBM25Results(
  candidates: Map<string, HybridSearchResult>,
  results: BM25SearchResult[],
  rrfK: number,
): void {
  const seen = new Set<string>();

  let rank = 0;

  for (const result of results) {
    validateSearchResult(result);

    if (seen.has(result.id)) {
      continue;
    }

    seen.add(result.id);
    rank += 1;

    const contribution =
      1 / (rrfK + rank);

    const existing =
      candidates.get(result.id);

    if (existing) {
      existing.score += contribution;
      existing.bm25Rank = rank;
      existing.bm25Score = result.score;
      continue;
    }

    candidates.set(result.id, {
      id: result.id,
      score: contribution,
      bm25Rank: rank,
      vectorRank: null,
      bm25Score: result.score,
      vectorScore: null,
    });
  }
}

function addVectorResults(
  candidates: Map<string, HybridSearchResult>,
  results: VectorSearchResult[],
  rrfK: number,
): void {
  const seen = new Set<string>();

  let rank = 0;

  for (const result of results) {
    validateSearchResult(result);

    if (seen.has(result.id)) {
      continue;
    }

    seen.add(result.id);
    rank += 1;

    const contribution =
      1 / (rrfK + rank);

    const existing =
      candidates.get(result.id);

    if (existing) {
      existing.score += contribution;
      existing.vectorRank = rank;
      existing.vectorScore = result.score;
      continue;
    }

    candidates.set(result.id, {
      id: result.id,
      score: contribution,
      bm25Rank: null,
      vectorRank: rank,
      bm25Score: null,
      vectorScore: result.score,
    });
  }
}

// ─── Reciprocal Rank Fusion ───────────────────────────────────────────────────

export function reciprocalRankFusion(
  bm25Results: BM25SearchResult[],
  vectorResults: VectorSearchResult[],
  options: Pick<
    HybridSearchOptions,
    "topK" | "rrfK"
  > = {},
): HybridSearchResult[] {
  const topK =
    options.topK ?? DEFAULT_TOP_K;

  const rrfK =
    options.rrfK ?? DEFAULT_RRF_K;

  validateTopK(topK);
  validateRrfK(rrfK);

  const candidates =
    new Map<string, HybridSearchResult>();

  addBM25Results(
    candidates,
    bm25Results,
    rrfK,
  );

  addVectorResults(
    candidates,
    vectorResults,
    rrfK,
  );

  return [...candidates.values()]
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return a.id.localeCompare(
        b.id,
        "en",
      );
    })
    .slice(0, topK);
}

// ─── Hybrid Search ────────────────────────────────────────────────────────────

export function hybridSearch(
  index: BM25Index,
  query: string,
  vectorResults: VectorSearchResult[],
  options: HybridSearchOptions = {},
): HybridSearchResult[] {
  if (!query.trim()) {
    return [];
  }

  const resolved =
    resolveOptions(options);

  const filteredVectorResults =
    vectorResults.filter((result) => {
      validateSearchResult(result);

      return (
        result.score >=
        resolved.minVectorScore
      );
    });

  const bm25Results = index.search(
    query,
    {
      topK: resolved.topK,
      minScore: resolved.minBM25Score,
    },
  );

  return reciprocalRankFusion(
    bm25Results,
    filteredVectorResults,
    {
      topK: resolved.topK,
      rrfK: resolved.rrfK,
    },
  );
}

// ─── Result Hydration ─────────────────────────────────────────────────────────

export function hydrateHybridResults(
  results: HybridSearchResult[],
  chunks: DocumentChunk[],
): HydratedHybridResult[] {
  const chunkMap = new Map(
    chunks.map((chunk) => [
      chunk.id,
      chunk,
    ]),
  );

  const hydrated: HydratedHybridResult[] =
    [];

  for (const result of results) {
    const chunk =
      chunkMap.get(result.id);

    if (!chunk) {
      logger.warn(
        {
          chunkId: result.id,
        },
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

// ─── Parent Context ───────────────────────────────────────────────────────────

export function extractParentIds(
  results: HydratedHybridResult[],
): string[] {
  return [
    ...new Set(
      results
        .map(
          (result) =>
            result.chunk.parentId,
        )
        .filter(
          (id): id is string =>
            id !== undefined,
        ),
    ),
  ];
}

// ─── Multi-Document Retrieval Orchestrator ────────────────────────────────────

import { store, keys } from "../../lib/store.js";
import { loadBM25Index } from "./bm25-store.service.js";
import { loadEmbeddings } from "./embedding-store.service.js";
import { embedQuery } from "./embedding.service.js";
import { searchVectors } from "./vector-search.service.js";
import type { ScoredChunk } from "../../types/retrieval.types.js";

export interface HybridRetrieveOptions {
  sessionId: string;
  documentIds: string[];
  query: string;
  topK?: number;
}

export interface HybridRetrieveResult {
  query: string;
  chunks: ScoredChunk[];
}

const MAX_RETRIEVE_DOCUMENTS = 5 as const;

/**
 * Retrieves evidence across one or more documents.
 *
 * The query is embedded exactly ONCE and shared across every document;
 * per document the persisted BM25 index and embedding batches are loaded
 * concurrently, fused with RRF, and hydrated from the stored child chunks.
 */
export async function hybridRetrieve(
  options: HybridRetrieveOptions,
): Promise<HybridRetrieveResult> {
  const {
    sessionId,
    documentIds,
    query,
  } = options;

  const topK = options.topK ?? DEFAULT_TOP_K;

  validateTopK(topK);

  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    return { query: normalizedQuery, chunks: [] };
  }

  if (
    documentIds.length === 0 ||
    documentIds.length > MAX_RETRIEVE_DOCUMENTS
  ) {
    throw new HybridSearchError(
      `Retrieval requires one to ${MAX_RETRIEVE_DOCUMENTS} documents.`,
    );
  }

  // One query embedding per request, shared by every document.
  const queryVector = await embedQuery(normalizedQuery);

  const perDocument = await Promise.all(
    documentIds.map(async (documentId) => {
      const [chunksRecord, bm25Index, embeddings] = await Promise.all([
        store.get<{
          parents: DocumentChunk[];
          children: DocumentChunk[];
          all: DocumentChunk[];
        }>(keys.docChunks(sessionId, documentId)),
        loadBM25Index(sessionId, documentId),
        loadEmbeddings(sessionId, documentId),
      ]);

      if (!chunksRecord) {
        throw new HybridSearchError(
          `Document "${documentId}" has no indexed chunks.`,
        );
      }

      if (!bm25Index) {
        throw new HybridSearchError(
          `Document "${documentId}" has no BM25 index.`,
        );
      }

      const children = Array.isArray(chunksRecord.children)
        ? chunksRecord.children
        : [];

      const vectorResults =
        embeddings && embeddings.embeddings.length > 0
          ? searchVectors(
              queryVector,
              embeddings.embeddings,
              { topK },
            )
          : [];

      const fused = hybridSearch(
        bm25Index,
        normalizedQuery,
        vectorResults,
        { topK },
      );

      const hydrated = hydrateHybridResults(fused, children);

      return hydrated.map(
        (result): ScoredChunk => ({
          id: result.chunk.id,
          score: result.score,
          text: result.chunk.text,
          ...(result.chunk.parentId !== undefined
            ? { parentId: result.chunk.parentId }
            : {}),
          documentId,
        }),
      );
    }),
  );

  return {
    query: normalizedQuery,
    chunks: perDocument.flat(),
  };
}