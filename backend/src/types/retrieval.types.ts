/**
 * A retrieved chunk with its fused relevance score.
 *
 * Consumed by the evidence gate (gate.service.ts) and the chat pipeline.
 * `score` is an RRF-fused score (1 / (rrfK + rank) per contributing list),
 * NOT a raw cosine or BM25 score.
 */
export interface ScoredChunk {
  id: string;

  /** Fused RRF score. */
  score: number;

  /** Chunk text (children carry their slice of the canonical text). */
  text?: string;

  /** Parent chunk ID for hydration/coverage, when the chunk is a child. */
  parentId?: string;

  /** Document this chunk belongs to (multi-document retrieval). */
  documentId?: string;
}
