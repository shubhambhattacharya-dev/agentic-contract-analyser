import type { EmbeddingVector } from "./embedding.service.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TOP_K = 15 as const;
const DEFAULT_MIN_SCORE = 0 as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VectorSearchOptions {
  topK?: number;
  minScore?: number;
}

export interface VectorSearchResult {
  id: string;
  score: number;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class VectorSearchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VectorSearchError";
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateTopK(topK: number): void {
  if (!Number.isInteger(topK) || topK <= 0) {
    throw new VectorSearchError(
      "topK must be a positive integer.",
    );
  }
}

function validateMinScore(minScore: number): void {
  if (!Number.isFinite(minScore)) {
    throw new VectorSearchError(
      "minScore must be a finite number.",
    );
  }

  if (minScore < -1 || minScore > 1) {
    throw new VectorSearchError(
      "minScore must be between -1 and 1 for cosine similarity.",
    );
  }
}

function resolveOptions(
  options: VectorSearchOptions,
): Required<VectorSearchOptions> {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

  validateTopK(topK);
  validateMinScore(minScore);

  return {
    topK,
    minScore,
  };
}

// ─── Vector Validation ───────────────────────────────────────────────────────

function validateVector(
  vector: number[],
  label: string,
): void {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new VectorSearchError(
      `${label} must contain at least one value.`,
    );
  }

  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new VectorSearchError(
        `${label} contains a non-finite value.`,
      );
    }
  }
}

// ─── Vector Magnitude ────────────────────────────────────────────────────────

function calculateMagnitude(vector: number[]): number {
  let squaredMagnitude = 0;

  for (const value of vector) {
    squaredMagnitude += value * value;
  }

  return Math.sqrt(squaredMagnitude);
}

// ─── Raw Cosine Similarity ───────────────────────────────────────────────────

function cosineSimilarityRaw(
  a: number[],
  magnitudeA: number,
  b: number[],
  magnitudeB: number,
): number {
  let dotProduct = 0;

  for (let i = 0; i < a.length; i += 1) {
    const valueA = a[i];
    const valueB = b[i];

    if (valueA === undefined || valueB === undefined) {
      throw new VectorSearchError(
        "Vector contains an unexpected missing dimension.",
      );
    }

    dotProduct += valueA * valueB;
  }

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}

// ─── Public Cosine Similarity ────────────────────────────────────────────────

export function cosineSimilarity(
  a: number[],
  b: number[],
): number {
  validateVector(a, "First vector");
  validateVector(b, "Second vector");

  if (a.length !== b.length) {
    throw new VectorSearchError(
      `Vector dimension mismatch: ${a.length} !== ${b.length}.`,
    );
  }

  const magnitudeA = calculateMagnitude(a);
  const magnitudeB = calculateMagnitude(b);

  return cosineSimilarityRaw(
    a,
    magnitudeA,
    b,
    magnitudeB,
  );
}

// ─── Vector Search ───────────────────────────────────────────────────────────

export function searchVectors(
  queryVector: number[],
  embeddings: EmbeddingVector[],
  options: VectorSearchOptions = {},
): VectorSearchResult[] {
  validateVector(queryVector, "Query vector");

  const {
    topK,
    minScore,
  } = resolveOptions(options);

  if (embeddings.length === 0) {
    return [];
  }

  const queryMagnitude =
    calculateMagnitude(queryVector);

  if (queryMagnitude === 0) {
    throw new VectorSearchError(
      "Query vector has zero magnitude and cannot be searched.",
    );
  }

  const results: VectorSearchResult[] = [];

  for (const embedding of embeddings) {
    const values = embedding.values;

    validateVector(
      values,
      `Embedding ${embedding.chunkId}`,
    );

    if (values.length !== queryVector.length) {
      throw new VectorSearchError(
        `Dimension mismatch for chunk ${embedding.chunkId}: ` +
        `expected ${queryVector.length}, got ${values.length}.`,
      );
    }

    const embeddingMagnitude =
      calculateMagnitude(values);

    if (embeddingMagnitude === 0) {
      continue;
    }

    const score = cosineSimilarityRaw(
      queryVector,
      queryMagnitude,
      values,
      embeddingMagnitude,
    );

    if (score >= minScore) {
      results.push({
        id: embedding.chunkId,
        score,
      });
    }
  }

  return results
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return a.id.localeCompare(b.id, "en");
    })
    .slice(0, topK);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
  DEFAULT_TOP_K,
  DEFAULT_MIN_SCORE,
};