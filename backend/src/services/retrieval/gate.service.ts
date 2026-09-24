import { logger } from "../../lib/logger.js";
import type { ScoredChunk } from "../../types/retrieval.types.js";


// ─────────────────────────────────────────────────────────────────────────────
// Calibrated gate constants
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Gate thresholds — PROVISIONAL, scale-corrected.
 *
 * Evidence scores are RRF-fused: each contributing ranked list adds
 * 1 / (RRF_K + rank), so a chunk ranked 1st by BOTH engines scores
 * 2/61 ≈ 0.0328 and a single-engine rank-1 scores 1/61 ≈ 0.0164.
 * The previous floors (0.35 / cosine-scale) were unreachable, which made
 * the "sufficient" branch dead and forced the agent loop on every question.
 *
 * Current values express, on the RRF scale:
 * - sufficient: top chunk is effectively rank-1 on both engines (>= 2/72)
 *   with >= 2 distinct parents and >= 25% query-term coverage.
 * - agentic: single-engine rank-1 evidence or >= 12.5% term coverage.
 *
 * TODO(gate-calibration): per Guidebook §13.3 these must be re-derived from
 * the golden-question set over real fixtures (answerable vs absent p5/p95).
 * Written 2026-09-24; re-run after any retrieval or embedding-model change.
 */

// 2/(60+12): effectively rank-1 on both engines at RRF_K = 60.
export const SCORE_FLOOR = 0.0278 as const;

export const MIN_PARENT_COVERAGE = 2 as const;

export const MIN_TERM_COVERAGE = 0.25 as const;

export const FINAL_CHILDREN = 15 as const;


// Weak-evidence band.
// Evidence below the sufficient threshold but above this band
// is worth investigating with the agent.
export const AGENTIC_SCORE_RATIO = 0.7 as const;

export const AGENTIC_TERM_COVERAGE_RATIO = 0.5 as const;


// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GateDecision =
  | {
      kind: "sufficient";
    }
  | {
      kind: "agentic";
    }
  | {
      kind: "abstain";
      reason: string;
    };

export interface GateMetrics {
  topScore: number;
  parentCoverage: number;
  termCoverage: number;
  evaluatedChunks: number;
}


// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function assessEvidence(
  query: string,
  chunks: ScoredChunk[],
): GateDecision {
  if (chunks.length === 0) {
    const decision: GateDecision = {
      kind: "abstain",
      reason: "No relevant evidence was retrieved.",
    };

    logger.debug(
      {
        decision: decision.kind,
        chunkCount: 0,
      },
      "Evidence gate evaluated.",
    );

    return decision;
  }

  const metrics = calculateMetrics(query, chunks);

  const decision = resolveDecision(metrics);

  logger.debug(
    {
      decision: decision.kind,
      metrics,
      thresholds: {
        scoreFloor: SCORE_FLOOR,
        minParentCoverage: MIN_PARENT_COVERAGE,
        minTermCoverage: MIN_TERM_COVERAGE,
        finalChildren: FINAL_CHILDREN,
      },
      chunkCount: chunks.length,
    },
    "Evidence gate evaluated.",
  );

  return decision;
}


// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

export function calculateMetrics(
  query: string,
  chunks: ScoredChunk[],
): GateMetrics {
  const rankedChunks = [...chunks]
    .filter((chunk) => Number.isFinite(chunk.score))
    .sort((a, b) => b.score - a.score);

  const window = rankedChunks.slice(0, FINAL_CHILDREN);

  const topScore = window[0]?.score ?? 0;

  const parentIds = new Set(
    window
      .map(getParentId)
      .filter((parentId): parentId is string => Boolean(parentId)),
  );

  const parentCoverage = parentIds.size;

  const queryTerms = tokenize(query);

  if (queryTerms.length === 0) {
    return {
      topScore,
      parentCoverage,
      termCoverage: 0,
      evaluatedChunks: window.length,
    };
  }

  const evidenceTokens = new Set(
    tokenize(
      window
        .map(getChunkText)
        .join(" "),
    ),
  );

  const matchedTerms = queryTerms.filter((term) =>
    evidenceTokens.has(term),
  );

  const termCoverage =
    matchedTerms.length / queryTerms.length;

  return {
    topScore,
    parentCoverage,
    termCoverage,
    evaluatedChunks: window.length,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// Decision logic
// ─────────────────────────────────────────────────────────────────────────────

function resolveDecision(
  metrics: GateMetrics,
): GateDecision {
  /*
   * Sufficient:
   *
   * 1. Strong enough top retrieval result.
   * 2. Evidence spans enough parent chunks.
   * 3. Query terms are represented in retrieved evidence.
   */
  if (
    metrics.topScore >= SCORE_FLOOR &&
    metrics.parentCoverage >= MIN_PARENT_COVERAGE &&
    metrics.termCoverage >= MIN_TERM_COVERAGE
  ) {
    return {
      kind: "sufficient",
    };
  }

  /*
   * Agentic:
   *
   * There is meaningful evidence, but it does not satisfy
   * the generation threshold.
   *
   * The agent gets a chance to search deeper.
   */
  const agenticScoreFloor =
    SCORE_FLOOR * AGENTIC_SCORE_RATIO;

  const agenticTermFloor =
    MIN_TERM_COVERAGE *
    AGENTIC_TERM_COVERAGE_RATIO;

  if (
    metrics.topScore >= agenticScoreFloor ||
    metrics.termCoverage >= agenticTermFloor
  ) {
    return {
      kind: "agentic",
    };
  }

  /*
   * Abstain:
   *
   * Evidence is too weak to justify another reasoning step.
   */
  return {
    kind: "abstain",
    reason:
      "Retrieved evidence is too weak to answer the question reliably.",
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// Chunk accessors
// ─────────────────────────────────────────────────────────────────────────────

function getParentId(chunk: ScoredChunk): string | null {
  return chunk.parentId ?? null;
}

function getChunkText(chunk: ScoredChunk): string {
  return chunk.text ?? "";
}


// ─────────────────────────────────────────────────────────────────────────────
// Tokenization
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set<string>([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "what",
  "when",
  "where",
  "which",
  "does",
  "have",
  "will",
  "about",
  "into",
  "there",
  "their",
  "they",
  "then",
  "than",
  "are",
  "was",
  "were",
  "been",
  "being",
  "can",
  "could",
  "would",
  "should",
]);

function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .toLocaleLowerCase()
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .map((term) => term.trim())
        .filter(
          (term) =>
            term.length >= 3 &&
            !STOP_WORDS.has(term),
        ),
    ),
  ];
}