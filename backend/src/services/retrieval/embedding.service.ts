import { GoogleGenAI } from "@google/genai";

import { env, modelConfig } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { startTrace } from "../../lib/observability.js";
import type { DocumentChunk } from "../ingestion/chunk.service.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DIMENSIONS = 768 as const;
const DEFAULT_BATCH_SIZE = 50 as const;

const MAX_TEXT_LENGTH = 8_000 as const;

const BATCH_DELAY_MS = 200 as const;

const MAX_RETRIES = 3 as const;
const RETRY_DELAY_MS = 1_000 as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export type EmbeddingInputType =
  | "document"
  | "query";

export interface EmbeddingVector {
  chunkId: string;
  values: number[];
}

export interface EmbeddingOptions {
  batchSize?: number;
  dimensions?: number;
}

export interface EmbeddingResult {
  embeddings: EmbeddingVector[];
  model: string;
  dimensions: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

// ─── Gemini Client ────────────────────────────────────────────────────────────

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) {
    return client;
  }

  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new EmbeddingError(
      "Gemini API key is not configured.",
    );
  }

  client = new GoogleGenAI({
    apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
  });

  return client;
}

export function resetEmbeddingClient(): void {
  client = null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeText(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) {
    return text;
  }

  logger.warn(
    {
      originalLength: text.length,
      maxLength: MAX_TEXT_LENGTH,
    },
    "Embedding text exceeds limit; truncating input.",
  );

  return text.slice(0, MAX_TEXT_LENGTH);
}

// ─── Input Formatting ─────────────────────────────────────────────────────────
//
// Gemini Embedding 2 does not use RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY
// taskType parameters. Retrieval intent is expressed in the input text.

function formatDocumentInput(text: string): string {
  return `title: none | text: ${text}`;
}

function formatQueryInput(query: string): string {
  return `task: search result | query: ${query}`;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateBatchSize(batchSize: number): void {
  if (
    !Number.isInteger(batchSize) ||
    batchSize <= 0
  ) {
    throw new EmbeddingError(
      "Embedding batch size must be a positive integer.",
    );
  }
}

function validateDimensions(dimensions: number): void {
  if (
    !Number.isInteger(dimensions) ||
    dimensions < 128 ||
    dimensions > 3072
  ) {
    throw new EmbeddingError(
      "Embedding dimensions must be an integer between 128 and 3072.",
    );
  }
}

function validateChunk(chunk: DocumentChunk): void {
  if (!chunk.id) {
    throw new EmbeddingError(
      "Cannot embed a chunk without an ID.",
    );
  }

  if (!chunk.text || chunk.text.trim().length === 0) {
    throw new EmbeddingError(
      `Cannot embed empty chunk: ${chunk.id}`,
    );
  }
}

// ─── Model ────────────────────────────────────────────────────────────────────

function resolveModel(): string {
  return modelConfig.embedding().model;
}

// ─── Retry ────────────────────────────────────────────────────────────────────

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  const message = error.message.toLowerCase();

  return (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("temporarily unavailable") ||
    message.includes("503") ||
    message.includes("500")
  );
}

async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt += 1
  ) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error)) {
        throw error;
      }

      if (attempt === MAX_RETRIES) {
        break;
      }

      /*
       * Honor Retry-After when the provider sends one (429 responses);
       * otherwise back off exponentially — 1s, 2s, 4s — plus jitter.
       * Provider rate limits are not beatable by fast fixed retries.
       */
      const retryAfterMs = extractRetryAfterMs(error);

      const delay =
        retryAfterMs ??
        RETRY_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);

      logger.warn(
        {
          label,
          attempt,
          maxRetries: MAX_RETRIES,
          retryDelayMs: delay,
          retryAfterHonored: retryAfterMs !== null,
        },
        "Embedding request failed; retrying.",
      );

      await sleep(delay);
    }
  }

  if (lastError instanceof Error && lastError.message.includes("429")) {
    throw new EmbeddingError(
      "Embedding provider rate limit reached. Please retry in a minute.",
      lastError,
    );
  }

  throw new EmbeddingError(
    `Embedding request failed after ${MAX_RETRIES} attempts: ${label}`,
    lastError,
  );
}

/** Extracts Retry-After (seconds) from a provider error message, if present. */
function extractRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const match = error.message.match(/retry[- ]after\D{0,20}?(\d{1,4})/i);

  return match?.[1] ? Number(match[1]) * 1_000 : null;
}

// ─── Single Embedding ─────────────────────────────────────────────────────────

export async function embedText(
  text: string,
  options: EmbeddingOptions = {},
): Promise<number[]> {
  const normalized = normalizeText(text);

  if (!normalized) {
    throw new EmbeddingError(
      "Cannot create embedding for empty text.",
    );
  }

  const dimensions =
    options.dimensions ??
    DEFAULT_DIMENSIONS;

  validateDimensions(dimensions);

  const safeText =
    truncateText(normalized);

  const model = resolveModel();

  const input =
    formatDocumentInput(safeText);

  const response =
    await withRetry(
      "document embedding",
      async () => {
        const ai = getClient();

        return ai.models.embedContent({
          model,
          contents: input,
          config: {
            outputDimensionality:
              dimensions,
          },
        });
      },
    );

  const values =
    response.embeddings?.[0]?.values;

  if (!values || values.length === 0) {
    throw new EmbeddingError(
      "Gemini returned an empty embedding.",
    );
  }

  if (values.length !== dimensions) {
    throw new EmbeddingError(
      `Expected ${dimensions} embedding dimensions but received ${values.length}.`,
    );
  }

  return values;
}

// ─── Query Embedding ──────────────────────────────────────────────────────────

export async function embedQuery(
  query: string,
  options: Omit<
    EmbeddingOptions,
    "batchSize"
  > = {},
): Promise<number[]> {
  const normalized =
    normalizeText(query);

  if (!normalized) {
    throw new EmbeddingError(
      "Cannot create embedding for empty query.",
    );
  }

  const dimensions =
    options.dimensions ??
    DEFAULT_DIMENSIONS;

  validateDimensions(dimensions);

  const safeQuery =
    truncateText(normalized);

  const model = resolveModel();

  const input =
    formatQueryInput(safeQuery);

  const response =
    await withRetry(
      "query embedding",
      async () => {
        const ai = getClient();

        return ai.models.embedContent({
          model,
          contents: input,
          config: {
            outputDimensionality:
              dimensions,
          },
        });
      },
    );

  const values =
    response.embeddings?.[0]?.values;

  if (!values || values.length === 0) {
    throw new EmbeddingError(
      "Gemini returned an empty query embedding.",
    );
  }

  if (values.length !== dimensions) {
    throw new EmbeddingError(
      `Expected ${dimensions} embedding dimensions but received ${values.length}.`,
    );
  }

  return values;
}

// ─── Batch Embedding ──────────────────────────────────────────────────────────

/**
 * Embeds many texts in ONE provider call (up to ~100 inputs).
 * One request per chunk previously burned ~100× the quota and latency.
 */
async function embedTexts(
  texts: string[],
  dimensions: number,
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const model = resolveModel();

  const inputs = texts.map((text) =>
    formatDocumentInput(truncateText(normalizeText(text))),
  );

  const response = await withRetry(
    `document embedding batch (${inputs.length} inputs)`,
    async () => {
      const ai = getClient();

      return ai.models.embedContent({
        model,
        contents: inputs.map((text) => ({
          parts: [{ text }],
        })),
        config: {
          outputDimensionality: dimensions,
        },
      });
    },
  );

  const embeddings = response.embeddings ?? [];

  if (embeddings.length !== inputs.length) {
    throw new EmbeddingError(
      `Embedding batch returned ${embeddings.length} vectors for ${inputs.length} inputs.`,
    );
  }

  return embeddings.map((embedding, index) => {
    const values = embedding.values;

    if (!values || values.length === 0) {
      throw new EmbeddingError(
        `Gemini returned an empty embedding at batch position ${index}.`,
      );
    }

    if (values.length !== dimensions) {
      throw new EmbeddingError(
        `Expected ${dimensions} embedding dimensions but received ${values.length}.`,
      );
    }

    return values;
  });
}

export async function embedChunks(
  chunks: DocumentChunk[],
  options: EmbeddingOptions = {},
): Promise<EmbeddingResult> {
  const startedAt = Date.now();
  const obsTrace = startTrace(
    "embedding",
    { chunkCount: chunks.length },
    ["embedding"],
  );

  try {
    const batchSize =
      options.batchSize ??
      DEFAULT_BATCH_SIZE;

    validateBatchSize(batchSize);

    const dimensions =
      options.dimensions ??
      DEFAULT_DIMENSIONS;

    validateDimensions(dimensions);

    const model = resolveModel();

    // Parents are context containers.
    // Only child chunks become retrieval vectors.
    const children =
      chunks.filter(
        (chunk) => chunk.kind === "child",
      );

    if (children.length === 0) {
      return {
        embeddings: [],
        model,
        dimensions,
      };
    }

    const results: EmbeddingVector[] = [];
    let batchCount = 0;

    for (
      let start = 0;
      start < children.length;
      start += batchSize
    ) {
      const batch =
        children.slice(
          start,
          start + batchSize,
        );

      for (const chunk of batch) {
        validateChunk(chunk);
      }

      const batchStartedAt = Date.now();

      const values = await embedTexts(
        batch.map((chunk) => chunk.text),
        dimensions,
      );

      batchCount += 1;

      results.push(
        ...batch.map((chunk, index) => ({
          chunkId: chunk.id,
          values: values[index]!,
        })),
      );

      obsTrace.generation({
        name: "embed-batch",
        model,
        provider: "gemini",
        latencyMs: Date.now() - batchStartedAt,
        metadata: {
          inputs: batch.length,
          dimensions,
          batchIndex: batchCount - 1,
        },
      });

      logger.debug(
        {
          processed:
            start + batch.length,
          total: children.length,
          model,
          dimensions,
        },
        "Embedding batch complete.",
      );

      const hasMore =
        start + batch.length <
        children.length;

      if (hasMore) {
        await sleep(
          BATCH_DELAY_MS,
        );
      }
    }

    logger.info(
      {
        chunkCount: results.length,
        batchCount,
        model,
        dimensions,
        durationMs: Date.now() - startedAt,
      },
      "Document embeddings generated.",
    );

    obsTrace.end({
      chunkCount: results.length,
      batchCount,
      dimensions,
      durationMs: Date.now() - startedAt,
    });

    return {
      embeddings: results,
      model,
      dimensions,
    };
  } catch (error) {
    obsTrace.end(
      { chunkCount: chunks.length, durationMs: Date.now() - startedAt },
      error instanceof Error ? error.message : "Embedding failed",
    );

    throw error;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export {
  DEFAULT_DIMENSIONS,
  DEFAULT_BATCH_SIZE,
};