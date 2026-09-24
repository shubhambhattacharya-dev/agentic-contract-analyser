// backend/src/services/verification/quote-verifier.service.ts

import { logger } from "../../lib/logger.js";
import type { DocumentChunk } from "../ingestion/chunk.service.js";

import {
  normalizeText,
  replaceDashes,
  replaceSmartQuotes,
  stripZeroWidthCharacters,
} from "./normalize.service.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_QUOTE_LENGTH = 3 as const;
const MAX_QUOTE_LENGTH = 10_000 as const;
// ─── Types ────────────────────────────────────────────────────────────────────

export interface QuoteVerificationInput {
  quote: string;
  chunkId: string;
}

export type QuoteVerificationStatus =
  | "verified"
  | "not_found"
  | "source_not_found";

export interface QuoteVerificationResult {
  quote: string;
  chunkId: string;
  status: QuoteVerificationStatus;
  verified: boolean;

  startOffset: number | null;
  endOffset: number | null;

  chunkStartOffset: number | null;
  chunkEndOffset: number | null;

  matchedText: string | null;
}

export interface QuoteVerificationSummary {
  results: QuoteVerificationResult[];
  verifiedCount: number;
  failedCount: number;
  allVerified: boolean;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class QuoteVerificationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "QuoteVerificationError";
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateAndNormalizeQuote(quote: string): string {
  if (typeof quote !== "string") {
    throw new QuoteVerificationError(
      "Quote must be a string.",
    );
  }

  const normalized = normalizeText(quote);

  if (!normalized) {
    throw new QuoteVerificationError(
      "Quote cannot be empty after normalization.",
    );
  }

  if (normalized.length < MIN_QUOTE_LENGTH) {
    throw new QuoteVerificationError(
      `Quote must contain at least ${MIN_QUOTE_LENGTH} characters.`,
    );
  }

  if (normalized.length > MAX_QUOTE_LENGTH) {
    throw new QuoteVerificationError(
      `Quote cannot exceed ${MAX_QUOTE_LENGTH} characters.`,
    );
  }

  return normalized;
}

function validateChunk(chunk: DocumentChunk): void {
  if (!chunk.id) {
    throw new QuoteVerificationError(
      "Cannot verify a chunk without an ID.",
    );
  }

  if (typeof chunk.text !== "string" || !chunk.text.trim()) {
    throw new QuoteVerificationError(
      `Chunk ${chunk.id} contains invalid or empty text.`,
    );
  }

  if (
    !Number.isInteger(chunk.startOffset) ||
    !Number.isInteger(chunk.endOffset) ||
    chunk.startOffset < 0 ||
    chunk.endOffset < chunk.startOffset
  ) {
    throw new QuoteVerificationError(
      `Chunk ${chunk.id} contains invalid canonical offsets.`,
    );
  }
}

// ─── Result Helpers ───────────────────────────────────────────────────────────

function makeUnverifiedResult(
  input: QuoteVerificationInput,
  status: "not_found" | "source_not_found",
): QuoteVerificationResult {
  return {
    quote: input.quote,
    chunkId: input.chunkId,
    status,
    verified: false,
    startOffset: null,
    endOffset: null,
    chunkStartOffset: null,
    chunkEndOffset: null,
    matchedText: null,
  };
}

// ─── Normalized Offset Mapping ────────────────────────────────────────────────

interface NormalizedChunk {
  value: string;

  /**
   * normalizedOffsets[i] = original chunk offset
   * corresponding to normalized character i.
   */
  offsets: number[];
}

const WHITESPACE_ONLY_PATTERN = /^\s+$/u;

/*
 * Grapheme segmentation keeps offset mapping aligned with normalizeText():
 * combining marks, surrogate pairs, and CR/LF pairs are normalized as a
 * unit instead of being split into mismatched characters.
 */
let graphemeSegmenter: Intl.Segmenter | null | undefined;

function getGraphemeSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter !== undefined) {
    return graphemeSegmenter;
  }

  try {
    graphemeSegmenter = new Intl.Segmenter("en", {
      granularity: "grapheme",
    });
  } catch {
    graphemeSegmenter = null;
  }

  return graphemeSegmenter;
}

interface GraphemeSegment {
  index: number;
  segment: string;
}

function segmentGraphemes(
  text: string,
): GraphemeSegment[] {
  const segmenter = getGraphemeSegmenter();

  const segments: GraphemeSegment[] = [];

  if (segmenter) {
    for (const { index, segment } of segmenter.segment(text)) {
      segments.push({ index, segment });
    }

    return segments;
  }

  // Fallback: iterate code points with their UTF-16 offsets.
  let utf16Index = 0;

  for (const codePoint of text) {
    segments.push({ index: utf16Index, segment: codePoint });
    utf16Index += codePoint.length;
  }

  return segments;
}

/**
 * Builds the normalized chunk and an offset map in one pass.
 *
 * The normalization rules match normalizeText():
 * - NFC normalization
 * - zero-width removal
 * - smart quotes
 * - dash normalization
 * - whitespace collapsing
 * - trimming
 * - lowercase
 */
function buildNormalizedChunk(
  originalText: string,
): NormalizedChunk {
  const normalized = normalizeText(originalText);

  if (!normalized) {
    return {
      value: "",
      offsets: [],
    };
  }

  /*
   * The value produced by normalizeText() is authoritative, but its
   * offsets must be derived independently, character by character.
   *
   * The per-segment pipeline below mirrors normalizeText() step by step,
   * so the mapped slice always normalizes back to the matched quote.
   */
  const valueUnits: string[] = [];
  const offsets: number[] = [];

  // Starts true so leading whitespace is trimmed for free.
  let lastWasSpace = true;

  const emitUnit = (
    unit: string,
    sourceOffset: number,
  ): void => {
    if (unit === " ") {
      if (lastWasSpace) {
        return;
      }

      lastWasSpace = true;
    } else {
      lastWasSpace = false;
    }

    valueUnits.push(unit);
    offsets.push(sourceOffset);
  };

  const emitCodePoint = (
    codePoint: string,
    sourceOffset: number,
  ): void => {
    if (codePoint.length === 1) {
      emitUnit(codePoint, sourceOffset);
      return;
    }

    // Surrogate pairs occupy two UTF-16 units in the value string.
    for (const unit of codePoint.split("")) {
      emitUnit(unit, sourceOffset);
    }
  };

  for (const { index, segment } of segmentGraphemes(originalText)) {
    let normalizedSegment = segment.normalize("NFC");

    normalizedSegment =
      stripZeroWidthCharacters(normalizedSegment);

    if (!normalizedSegment) {
      continue;
    }

    normalizedSegment = replaceSmartQuotes(normalizedSegment);
    normalizedSegment = replaceDashes(normalizedSegment);

    if (WHITESPACE_ONLY_PATTERN.test(normalizedSegment)) {
      emitCodePoint(" ", index);
      continue;
    }

    const loweredSegment =
      normalizedSegment.toLocaleLowerCase("en");

    for (const codePoint of loweredSegment) {
      emitCodePoint(codePoint, index);
    }
  }

  // Trim trailing whitespace, mirroring normalizeText().
  while (
    valueUnits.length > 0 &&
    valueUnits[valueUnits.length - 1] === " "
  ) {
    valueUnits.pop();
    offsets.pop();
  }

  return {
    value: valueUnits.join(""),
    offsets,
  };
}

function mapNormalizedStart(
  normalizedChunk: NormalizedChunk,
  normalizedOffset: number,
  originalLength: number,
): number {
  if (normalizedOffset <= 0) {
    return 0;
  }

  if (normalizedOffset >= normalizedChunk.offsets.length) {
    return originalLength;
  }

  return normalizedChunk.offsets[normalizedOffset] ?? originalLength;
}

function mapNormalizedEnd(
  normalizedChunk: NormalizedChunk,
  normalizedEnd: number,
  originalLength: number,
): number {
  if (normalizedEnd <= 0) {
    return 0;
  }

  if (normalizedEnd >= normalizedChunk.offsets.length) {
    return originalLength;
  }

  /*
   * The next normalized unit's source offset is exactly where the
   * previous character ends — including multi-unit characters such
   * as surrogate pairs, which must never be sliced in half.
   */
  const nextCharacterOffset =
    normalizedChunk.offsets[normalizedEnd];

  if (nextCharacterOffset === undefined) {
    return originalLength;
  }

  return nextCharacterOffset;
}

// ─── Single Quote Verification ────────────────────────────────────────────────

export function verifyQuote(
  input: QuoteVerificationInput,
  chunks: DocumentChunk[],
): QuoteVerificationResult;

export function verifyQuote(
  input: QuoteVerificationInput,
  chunkMap: Map<string, DocumentChunk>,
): QuoteVerificationResult;

export function verifyQuote(
  input: QuoteVerificationInput,
  chunksOrMap: DocumentChunk[] | Map<string, DocumentChunk>,
): QuoteVerificationResult {
  if (
    input === null ||
    typeof input !== "object"
  ) {
    throw new QuoteVerificationError(
      "Quote verification input is required.",
    );
  }

  if (!input.chunkId) {
    throw new QuoteVerificationError(
      "Quote verification requires a chunk ID.",
    );
  }

  const normalizedQuote =
    validateAndNormalizeQuote(input.quote);

  const chunk =
    chunksOrMap instanceof Map
      ? chunksOrMap.get(input.chunkId)
      : chunksOrMap.find(
          (candidate) => candidate.id === input.chunkId,
        );

  if (!chunk) {
    logger.warn(
      { chunkId: input.chunkId },
      "Quote verification source chunk not found.",
    );

    return makeUnverifiedResult(
      input,
      "source_not_found",
    );
  }

  validateChunk(chunk);

  const normalizedChunk =
    buildNormalizedChunk(chunk.text);

  const normalizedStart =
    normalizedChunk.value.indexOf(
      normalizedQuote,
    );

  if (normalizedStart === -1) {
    logger.debug(
      {
        chunkId: chunk.id,
        quoteLength: normalizedQuote.length,
      },
      "Quote verification failed: quote not found.",
    );

    return makeUnverifiedResult(
      input,
      "not_found",
    );
  }

  const normalizedEnd =
    normalizedStart + normalizedQuote.length;

  const chunkStartOffset =
    mapNormalizedStart(
      normalizedChunk,
      normalizedStart,
      chunk.text.length,
    );

  const chunkEndOffset =
    mapNormalizedEnd(
      normalizedChunk,
      normalizedEnd,
      chunk.text.length,
    );

  const matchedText = chunk.text.slice(
    chunkStartOffset,
    chunkEndOffset,
  );

  /*
   * Final safety check.
   *
   * Never mark a quote as verified unless the exact
   * extracted source slice normalizes to the requested quote.
   */
  if (
    normalizeText(matchedText) !==
    normalizedQuote
  ) {
    logger.warn(
      {
        chunkId: chunk.id,
        chunkStartOffset,
        chunkEndOffset,
      },
      "Quote verification failed: mapped source slice does not match quote.",
    );

    return makeUnverifiedResult(
      input,
      "not_found",
    );
  }

  const canonicalStart =
    chunk.startOffset + chunkStartOffset;

  const canonicalEnd =
    chunk.startOffset + chunkEndOffset;

  logger.debug(
    {
      chunkId: chunk.id,
      canonicalStart,
      canonicalEnd,
    },
    "Quote verified.",
  );

  return {
    quote: input.quote,
    chunkId: chunk.id,
    status: "verified",
    verified: true,

    startOffset: canonicalStart,
    endOffset: canonicalEnd,

    chunkStartOffset,
    chunkEndOffset,

    matchedText,
  };
}

// ─── Batch Verification ───────────────────────────────────────────────────────

export function verifyQuotes(
  inputs: QuoteVerificationInput[],
  chunks: DocumentChunk[],
): QuoteVerificationSummary {
  if (!Array.isArray(inputs)) {
    throw new QuoteVerificationError(
      "Quote verification inputs must be an array.",
    );
  }

  if (!Array.isArray(chunks)) {
    throw new QuoteVerificationError(
      "Chunks must be an array.",
    );
  }

  /*
   * Build once.
   *
   * Without this:
   *
   * input 1 → chunks.find()
   * input 2 → chunks.find()
   * input 3 → chunks.find()
   *
   * With this:
   *
   * chunks → Map
   * every input → O(1) lookup
   */
  const chunkMap =
    new Map<string, DocumentChunk>();

  for (const chunk of chunks) {
    if (!chunkMap.has(chunk.id)) {
      chunkMap.set(chunk.id, chunk);
    }
  }

  const results: QuoteVerificationResult[] = [];

  for (const input of inputs) {
    results.push(
      verifyQuote(input, chunkMap),
    );
  }

  let verifiedCount = 0;

  for (const result of results) {
    if (result.verified) {
      verifiedCount += 1;
    }
  }

  const failedCount =
    results.length - verifiedCount;

  logger.info(
    {
      total: results.length,
      verifiedCount,
      failedCount,
    },
    "Quote verification batch complete.",
  );

  return {
    results,
    verifiedCount,
    failedCount,

    // Empty input intentionally returns false.
    allVerified:
      results.length > 0 &&
      verifiedCount === results.length,
  };
}

// ─── Convenience Helper ──────────────────────────────────────────────────────

export function isQuoteVerified(
  quote: string,
  chunkId: string,
  chunks: DocumentChunk[],
): boolean {
  return verifyQuote(
    {
      quote,
      chunkId,
    },
    chunks,
  ).verified;
}

// ─── Document-Level Verification ──────────────────────────────────────────────
//
// The runtime chat pipeline receives free-text quote candidates from the
// model with NO chunk ID and NO trusted position. This adapter searches the
// canonical document text itself — model-supplied pages/offsets would be
// ignored even if the model sent them.

export interface DocumentVerificationPayload {
  documentId: string;
  text: string;
  pages: { pageNumber: number; startOffset: number; endOffset: number }[];
  chunks: {
    id: string;
    kind?: string;
    text: string;
    startOffset: number;
    endOffset: number;
    parentId?: string;
  }[];
}

export interface DocumentQuoteResult {
  quote: string;
  documentId: string;
  verified: boolean;
  status: "verified" | "not_found";
  chunkId: string | null;
  parentId: string | null;
  startOffset: number | null;
  endOffset: number | null;
  page: number | null;
  occurrences: number;
  matchedText: string | null;
}

/**
 * Builds a per-document verifier. The document is normalized ONCE; every
 * candidate quote is then located in normalized space and mapped back to
 * canonical offsets. The matched slice is re-normalized as a final safety
 * check — identical to the chunk verifier's invariant.
 */
export function createDocumentVerifier(payload: DocumentVerificationPayload): {
  verify: (candidate: string) => DocumentQuoteResult;
} {
  const normalizedDocument = buildNormalizedChunk(payload.text);

  function locateAll(normalizedQuote: string): {
    first: number;
    count: number;
  } {
    let first = -1;
    let count = 0;
    let from = 0;

    while (from <= normalizedDocument.value.length) {
      const at = normalizedDocument.value.indexOf(normalizedQuote, from);

      if (at === -1) {
        break;
      }

      if (first === -1) {
        first = at;
      }

      count += 1;
      from = at + Math.max(normalizedQuote.length, 1);
    }

    return { first, count };
  }

  function pageForOffset(offset: number): number | null {
    for (const page of payload.pages) {
      if (offset >= page.startOffset && offset < page.endOffset) {
        return page.pageNumber;
      }
    }

    return payload.pages.length > 0 ? payload.pages.length : null;
  }

  function chunkForRange(
    start: number,
    end: number,
  ): { id: string; parentId?: string } | null {
    let parentMatch: { id: string; parentId?: string } | null = null;

    for (const chunk of payload.chunks) {
      if (chunk.startOffset <= start && end <= chunk.endOffset) {
        if (chunk.kind === "child") {
          return {
            id: chunk.id,
            ...(chunk.parentId !== undefined
              ? { parentId: chunk.parentId }
              : {}),
          };
        }

        parentMatch ??= {
          id: chunk.id,
          ...(chunk.parentId !== undefined
            ? { parentId: chunk.parentId }
            : {}),
        };
      }
    }

    return parentMatch;
  }

  function verify(candidate: string): DocumentQuoteResult {
    const notFound: DocumentQuoteResult = {
      quote: candidate,
      documentId: payload.documentId,
      verified: false,
      status: "not_found",
      chunkId: null,
      parentId: null,
      startOffset: null,
      endOffset: null,
      page: null,
      occurrences: 0,
      matchedText: null,
    };

    if (typeof candidate !== "string") {
      return notFound;
    }

    let normalizedQuote: string;

    try {
      normalizedQuote = validateAndNormalizeQuote(candidate);
    } catch {
      return notFound;
    }

    if (normalizedDocument.value.length === 0) {
      return notFound;
    }

    const { first, count } = locateAll(normalizedQuote);

    if (first === -1) {
      return notFound;
    }

    const startOffset = mapNormalizedStart(
      normalizedDocument,
      first,
      payload.text.length,
    );

    const endOffset = mapNormalizedEnd(
      normalizedDocument,
      first + normalizedQuote.length,
      payload.text.length,
    );

    const matchedText = payload.text.slice(startOffset, endOffset);

    // Final safety check: the canonical slice must normalize back to the quote.
    if (normalizeText(matchedText) !== normalizedQuote) {
      return notFound;
    }

    const sourceChunk = chunkForRange(startOffset, endOffset);

    return {
      quote: candidate,
      documentId: payload.documentId,
      verified: true,
      status: "verified",
      chunkId: sourceChunk?.id ?? null,
      parentId: sourceChunk?.parentId ?? null,
      startOffset,
      endOffset,
      page: pageForOffset(startOffset),
      occurrences: count,
      matchedText,
    };
  }

  return { verify };
}

// ─── Runtime Service Object ───────────────────────────────────────────────────

export const quoteVerifier = {
  verifyQuote,
  verifyQuotes,
  createDocumentVerifier,
} as const;