import { logger } from "../../lib/logger.js";
import type { ExtractedDocument } from "../../types/document.types.js";

const PARENT_TARGET_TOKENS = 1_800 as const;
const CHILD_MAX_TOKENS = 200 as const;
const CHILD_OVERLAP_TOKENS = 20 as const;

// Approximate token count used only for chunk-size decisions.
// This is NOT an exact model tokenizer.
const CHARS_PER_TOKEN = 4 as const;

const PARAGRAPH_BOUNDARY_GLOBAL = /\n{2,}/gu;
const SENTENCE_BOUNDARY_GLOBAL = /(?<=[.!?])\s+/gu;

export type ChunkKind = "parent" | "child";

export interface DocumentChunk {
  id: string;
  kind: ChunkKind;
  text: string;
  startOffset: number;
  endOffset: number;
  parentId?: string;
  tokenEstimate: number;
}

export interface ChunkingResult {
  parents: DocumentChunk[];
  children: DocumentChunk[];
  all: DocumentChunk[];
}

export class DocumentChunkingError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DocumentChunkingError";
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function splitWords(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

interface TextSpan {
  text: string;
  startOffset: number;
  endOffset: number;
}

interface OffsetSpan {
  start: number;
  end: number;
}

/** Shrinks [start, end) past surrounding whitespace; returns null when empty. */
function trimSpan(
  source: string,
  start: number,
  end: number,
): OffsetSpan | null {
  let s = start;
  let e = end;

  while (s < e && /\s/u.test(source[s] ?? "")) {
    s += 1;
  }

  while (e > s && /\s/u.test(source[e - 1] ?? "")) {
    e -= 1;
  }

  return e > s ? { start: s, end: e } : null;
}

/** Splits [start, end) on a boundary regex, yielding trimmed absolute spans. */
function splitIntoSpans(
  source: string,
  start: number,
  end: number,
  boundary: RegExp,
): OffsetSpan[] {
  const spans: OffsetSpan[] = [];

  const slice = source.slice(start, end);

  let pieceStart = 0;

  const pushTrimmed = (pieceEnd: number): void => {
    const trimmed = trimSpan(slice, pieceStart, pieceEnd);

    if (trimmed) {
      spans.push({
        start: start + trimmed.start,
        end: start + trimmed.end,
      });
    }
  };

  for (const match of slice.matchAll(boundary)) {
    const separatorStart = match.index ?? 0;

    pushTrimmed(separatorStart);

    pieceStart = separatorStart + (match[0] ?? "").length;
  }

  pushTrimmed(slice.length);

  return spans;
}

/** Word-start offsets within [start, end), absolute in the source text. */
function wordStartsIn(source: string, start: number, end: number): number[] {
  const offsets: number[] = [];

  let index = start;

  while (index < end) {
    while (index < end && /\s/u.test(source[index] ?? "")) {
      index += 1;
    }

    if (index >= end) {
      break;
    }

    offsets.push(index);

    while (index < end && !/\s/u.test(source[index] ?? "")) {
      index += 1;
    }
  }

  return offsets;
}

/**
 * Splits an oversized sentence span at word boundaries. Parts are canonical
 * slices — whitespace is preserved exactly, never re-joined.
 */
function splitOversizedSpan(
  source: string,
  span: OffsetSpan,
): OffsetSpan[] {
  const words = wordStartsIn(source, span.start, span.end);

  if (words.length === 0) {
    return [span];
  }

  // End offset of each word (first whitespace at/after its start).
  const wordEnds = words.map((wordStart) => {
    let wordEnd = wordStart;

    while (wordEnd < span.end && !/\s/u.test(source[wordEnd] ?? "")) {
      wordEnd += 1;
    }

    return wordEnd;
  });

  const parts: OffsetSpan[] = [];

  let partStartIndex = 0;

  for (let index = 1; index < words.length; index += 1) {
    const partStart = wordAt(partStartIndex, words);
    const nextWordEnd = wordEnds[index] ?? span.end;

    if (
      estimateTokens(source.slice(partStart, nextWordEnd)) >
      PARENT_TARGET_TOKENS
    ) {
      const previousEnd = wordEnds[index - 1] ?? span.end;

      parts.push({ start: partStart, end: previousEnd });

      partStartIndex = index;
    }
  }

  const finalStart = partStartIndex < words.length
    ? wordAt(partStartIndex, words)
    : span.start;

  parts.push({ start: finalStart, end: span.end });

  return parts;
}

function wordAt(
  index: number,
  words: number[],
): number {
  const value = words[index];

  if (value === undefined) {
    throw new DocumentChunkingError(
      "Unable to split oversized sentence span.",
    );
  }

  return value;
}

interface SentenceSpan {
  start: number;
  end: number;
  tokens: number;
}

/** Paragraph and sentence spans for the whole document, offsets absolute. */
function createParentSpans(
  documentText: string,
): SentenceSpan[] {
  const parents: SentenceSpan[] = [];

  let currentParts: OffsetSpan[] = [];
  let currentTokens = 0;

  function flush(): void {
    if (currentParts.length === 0) {
      return;
    }

    const first = currentParts[0];
    const last = currentParts[currentParts.length - 1];

    if (first && last) {
      parents.push({
        start: first.start,
        end: last.end,
        tokens: currentTokens,
      });
    }

    currentParts = [];
    currentTokens = 0;
  }

  const paragraphs = splitIntoSpans(
    documentText,
    0,
    documentText.length,
    PARAGRAPH_BOUNDARY_GLOBAL,
  );

  for (const paragraph of paragraphs) {
    let sentenceSpans = splitIntoSpans(
      documentText,
      paragraph.start,
      paragraph.end,
      SENTENCE_BOUNDARY_GLOBAL,
    );

    // Oversized sentences are split at word boundaries into canonical slices.
    sentenceSpans = sentenceSpans.flatMap((span) =>
      estimateTokens(documentText.slice(span.start, span.end)) >
        PARENT_TARGET_TOKENS
        ? splitOversizedSpan(documentText, span)
        : [span],
    );

    for (const span of sentenceSpans) {
      const partTokens = estimateTokens(
        documentText.slice(span.start, span.end),
      );

      if (
        currentParts.length > 0 &&
        currentTokens + partTokens > PARENT_TARGET_TOKENS
      ) {
        flush();
      }

      currentParts.push(span);
      currentTokens += partTokens;
    }

    // Preserve paragraph boundaries.
    flush();
  }

  return parents;
}

function buildParents(
  documentText: string,
): DocumentChunk[] {
  const parentSpans = createParentSpans(documentText);

  const parents: DocumentChunk[] = [];

  let parentNumber = 1;

  for (const span of parentSpans) {
    const text = documentText.slice(span.start, span.end);

    if (text.length === 0) {
      continue;
    }

    parents.push({
      id: `parent-${parentNumber}`,
      kind: "parent",
      text,
      startOffset: span.start,
      endOffset: span.end,
      tokenEstimate: estimateTokens(text),
    });

    parentNumber += 1;
  }

  return parents;
}

function findWordStartOffsets(
  text: string,
): number[] {
  const offsets: number[] = [];

  let index = 0;

  while (index < text.length) {
    while (
      index < text.length &&
      /\s/u.test(text[index] ?? "")
    ) {
      index += 1;
    }

    if (index >= text.length) {
      break;
    }

    offsets.push(index);

    while (
      index < text.length &&
      !/\s/u.test(text[index] ?? "")
    ) {
      index += 1;
    }
  }

  return offsets;
}

function calculateOverlapWordCount(
  selectedWords: string[],
  tokenEstimate: number,
): number {
  if (selectedWords.length === 0) {
    return 0;
  }

  const averageTokensPerWord =
    tokenEstimate / selectedWords.length;

  return Math.max(
    1,
    Math.ceil(
      CHILD_OVERLAP_TOKENS /
        Math.max(averageTokensPerWord, 1),
    ),
  );
}

function buildChildChunks(
  parent: DocumentChunk,
): DocumentChunk[] {
  const rawWords = splitWords(parent.text);

  if (rawWords.length === 0) {
    return [];
  }

  const rawOffsets = findWordStartOffsets(
    parent.text,
  );

  /*
   * A single "word" longer than CHILD_MAX_TOKENS (base64 blobs, URLs without
   * separators, corrupted glyphs) would otherwise become an oversized child
   * and fail validation. Split such tokens at character boundaries — the
   * slices remain exact substrings, so canonical offsets stay true.
   */
  const maxWordChars =
    CHILD_MAX_TOKENS * CHARS_PER_TOKEN;

  const words: string[] = [];
  const wordOffsets: number[] = [];

  for (let index = 0; index < rawWords.length; index += 1) {
    const word = rawWords[index]!;
    const wordStart = rawOffsets[index]!;

    if (word.length <= maxWordChars) {
      words.push(word);
      wordOffsets.push(wordStart);
      continue;
    }

    for (let slice = 0; slice < word.length; slice += maxWordChars) {
      words.push(word.slice(slice, slice + maxWordChars));
      wordOffsets.push(wordStart + slice);
    }
  }

  /*
   * End offset of each word.
   *
   * Sizing MUST use the actual span (start of the first word → end of the
   * last word), because the slice keeps the ORIGINAL whitespace — newlines
   * and column-layout space runs can make the real text far longer than the
   * words joined with single spaces. Estimating from joined words was the
   * bug that produced oversized children on real PDFs.
   *
   * Sub-words (from the oversized-token split above) are exact slices with
   * no internal whitespace, so end = start + length is exact for all of them.
   */
  const wordEnds = words.map(
    (word, index) => (wordOffsets[index] ?? 0) + word.length,
  );

  const children: DocumentChunk[] = [];

  let startWordIndex = 0;
  let childNumber = 1;

  while (startWordIndex < words.length) {
    let endWordIndex = startWordIndex;
    let selectedCount = 0;

    while (endWordIndex < words.length) {
      const spanStart = wordOffsets[startWordIndex];
      const spanEnd = wordEnds[endWordIndex];

      if (spanStart === undefined || spanEnd === undefined) {
        break;
      }

      const spanEstimate = estimateTokens(
        parent.text.slice(spanStart, spanEnd),
      );

      if (
        selectedCount > 0 &&
        spanEstimate > CHILD_MAX_TOKENS
      ) {
        break;
      }

      selectedCount += 1;
      endWordIndex += 1;
    }

    if (selectedCount === 0) {
      throw new DocumentChunkingError(
        `Unable to create child chunk for ${parent.id}.`,
      );
    }

    const firstWordOffset =
      wordOffsets[startWordIndex];

    const lastWordIndex =
      endWordIndex - 1;

    const lastWordEnd =
      wordEnds[lastWordIndex];

    if (
      firstWordOffset === undefined ||
      lastWordEnd === undefined
    ) {
      throw new DocumentChunkingError(
        `Unable to calculate offsets for ${parent.id}.`,
      );
    }

    const localStart = firstWordOffset;
    const localEnd = lastWordEnd;

    const childText = parent.text.slice(
      localStart,
      localEnd,
    );

    const tokenEstimate =
      estimateTokens(childText);

    children.push({
      id: `${parent.id}-child-${childNumber}`,
      kind: "child",
      text: childText,
      startOffset:
        parent.startOffset + localStart,
      endOffset:
        parent.startOffset + localEnd,
      parentId: parent.id,
      tokenEstimate,
    });

    childNumber += 1;

    if (endWordIndex >= words.length) {
      break;
    }

    const overlapWordCount = Math.max(
      1,
      Math.ceil(
        CHILD_OVERLAP_TOKENS /
          Math.max(tokenEstimate / selectedCount, 1),
      ),
    );

    startWordIndex = Math.max(
      startWordIndex + 1,
      endWordIndex - overlapWordCount,
    );
  }

  return children;
}

function buildChildren(
  parents: DocumentChunk[],
): DocumentChunk[] {
  return parents.flatMap((parent) =>
    buildChildChunks(parent),
  );
}

function validateChunkOffsets(
  documentText: string,
  chunks: DocumentChunk[],
): void {
  for (const chunk of chunks) {
    if (
      chunk.startOffset < 0 ||
      chunk.endOffset > documentText.length
    ) {
      throw new DocumentChunkingError(
        `Invalid offsets for chunk ${chunk.id}.`,
      );
    }

    if (
      chunk.endOffset <= chunk.startOffset
    ) {
      throw new DocumentChunkingError(
        `Invalid offset range for chunk ${chunk.id}.`,
      );
    }

    const sourceText = documentText.slice(
      chunk.startOffset,
      chunk.endOffset,
    );

    if (sourceText !== chunk.text) {
      throw new DocumentChunkingError(
        `Chunk ${chunk.id} does not exactly match canonical document text.`,
      );
    }
  }
}

function validateChunkRelationships(
  parents: DocumentChunk[],
  children: DocumentChunk[],
): void {
  const parentIds = new Set(
    parents.map((parent) => parent.id),
  );

  for (const child of children) {
    if (!child.parentId) {
      throw new DocumentChunkingError(
        `Child ${child.id} is missing parentId.`,
      );
    }

    if (!parentIds.has(child.parentId)) {
      throw new DocumentChunkingError(
        `Child ${child.id} references missing parent ${child.parentId}.`,
      );
    }

    if (
      child.tokenEstimate >
      CHILD_MAX_TOKENS
    ) {
      throw new DocumentChunkingError(
        `Child ${child.id} exceeds ${CHILD_MAX_TOKENS} estimated tokens (got ${child.tokenEstimate}, text length ${child.text.length}).`,
      );
    }
  }
}

function validateParents(
  parents: DocumentChunk[],
): void {
  for (const parent of parents) {
    const words = splitWords(parent.text);

    if (words.length === 0) {
      throw new DocumentChunkingError(
        `Parent ${parent.id} contains no words.`,
      );
    }

    const largestWordTokens = Math.max(
      ...words.map(estimateTokens),
    );

    if (
      parent.tokenEstimate >
        PARENT_TARGET_TOKENS &&
      largestWordTokens <=
        PARENT_TARGET_TOKENS
    ) {
      throw new DocumentChunkingError(
        `Parent ${parent.id} unexpectedly exceeds the target.`,
      );
    }
  }
}

function validateChunks(
  documentText: string,
  parents: DocumentChunk[],
  children: DocumentChunk[],
): void {
  const all = [...parents, ...children];

  validateChunkOffsets(
    documentText,
    all,
  );

  validateChunkRelationships(
    parents,
    children,
  );

  validateParents(parents);
}

export function chunkDocument(
  document: ExtractedDocument,
): ChunkingResult {
  if (!document) {
    throw new DocumentChunkingError(
      "Extracted document is required.",
    );
  }

  if (
    document.isScanned ||
    document.text.trim().length === 0
  ) {
    logger.warn(
      {
        mimeType: document.mimeType,
        pageCount: document.pageCount,
      },
      "Skipping chunking: document contains no selectable text.",
    );

    return {
      parents: [],
      children: [],
      all: [],
    };
  }

  try {
    const parents = buildParents(
      document.text,
    );

    const children = buildChildren(
      parents,
    );

    validateChunks(
      document.text,
      parents,
      children,
    );

    const all = [
      ...parents,
      ...children,
    ];

    logger.info(
      {
        mimeType: document.mimeType,
        parentCount: parents.length,
        childCount: children.length,
      },
      "Document chunking complete",
    );

    return {
      parents,
      children,
      all,
    };
  } catch (error) {
    if (
      error instanceof DocumentChunkingError
    ) {
      throw error;
    }

    throw new DocumentChunkingError(
      "Document chunking failed.",
      error,
    );
  }
}