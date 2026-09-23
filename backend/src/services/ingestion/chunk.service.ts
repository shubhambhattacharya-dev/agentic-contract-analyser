import { logger } from "../../lib/logger.js";
import type { ExtractedDocument } from "../../types/document.types.js";

const PARENT_TARGET_TOKENS = 1_800 as const;
const CHILD_MAX_TOKENS = 200 as const;
const CHILD_OVERLAP_TOKENS = 20 as const;

// Approximate token count used only for chunk-size decisions.
// This is NOT an exact model tokenizer.
const CHARS_PER_TOKEN = 4 as const;

const PARAGRAPH_BOUNDARY = /\n{2,}/u;
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/u;
const WORD_BOUNDARY = /\s+/u;

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

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function splitWords(text: string): string[] {
  return text.split(WORD_BOUNDARY).filter(Boolean);
}

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitOversizedSentence(
  sentence: string,
): string[] {
  const estimatedTokens = estimateTokens(sentence);

  if (estimatedTokens <= PARENT_TARGET_TOKENS) {
    return [sentence];
  }

  logger.warn(
    {
      estimatedTokens,
      limit: PARENT_TARGET_TOKENS,
    },
    "Sentence exceeds parent token target; splitting at word boundaries",
  );

  const words = splitWords(sentence);
  const parts: string[] = [];

  let currentWords: string[] = [];

  for (const word of words) {
    const candidate =
      currentWords.length === 0
        ? word
        : `${currentWords.join(" ")} ${word}`;

    if (
      currentWords.length > 0 &&
      estimateTokens(candidate) > PARENT_TARGET_TOKENS
    ) {
      parts.push(currentWords.join(" "));
      currentWords = [word];
      continue;
    }

    currentWords.push(word);
  }

  if (currentWords.length > 0) {
    parts.push(currentWords.join(" "));
  }

  return parts;
}

interface TextSpan {
  text: string;
  startOffset: number;
  endOffset: number;
}

function findExactSpan(
  sourceText: string,
  text: string,
  searchFrom: number,
): TextSpan {
  if (text.length === 0) {
    throw new DocumentChunkingError(
      "Cannot create a chunk from empty text.",
    );
  }

  const startOffset = sourceText.indexOf(
    text,
    searchFrom,
  );

  if (startOffset === -1) {
    throw new DocumentChunkingError(
      "Chunk could not be mapped to canonical document text.",
    );
  }

  return {
    text,
    startOffset,
    endOffset: startOffset + text.length,
  };
}

function createParentTexts(
  documentText: string,
): string[] {
  const paragraphs = documentText
    .split(PARAGRAPH_BOUNDARY)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const parents: string[] = [];

  let currentParts: string[] = [];
  let currentTokens = 0;

  function flush(): void {
    if (currentParts.length === 0) {
      return;
    }

    parents.push(currentParts.join(" "));
    currentParts = [];
    currentTokens = 0;
  }

  for (const paragraph of paragraphs) {
    const sentences = splitSentences(paragraph);

    for (const sentence of sentences) {
      const parts = splitOversizedSentence(sentence);

      for (const part of parts) {
        const partTokens = estimateTokens(part);

        if (
          currentParts.length > 0 &&
          currentTokens + partTokens >
            PARENT_TARGET_TOKENS
        ) {
          flush();
        }

        currentParts.push(part);
        currentTokens += partTokens;
      }
    }

    // Preserve paragraph boundaries.
    flush();
  }

  return parents;
}

function buildParents(
  documentText: string,
): DocumentChunk[] {
  const parentTexts =
    createParentTexts(documentText);

  const parents: DocumentChunk[] = [];

  let searchFrom = 0;
  let parentNumber = 1;

  for (const parentText of parentTexts) {
    if (parentText.length === 0) {
      continue;
    }

    const span = findExactSpan(
      documentText,
      parentText,
      searchFrom,
    );

    parents.push({
      id: `parent-${parentNumber}`,
      kind: "parent",
      text: span.text,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
      tokenEstimate: estimateTokens(span.text),
    });

    parentNumber += 1;
    searchFrom = span.endOffset;
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
  const words = splitWords(parent.text);

  if (words.length === 0) {
    return [];
  }

  const wordOffsets = findWordStartOffsets(
    parent.text,
  );

  const children: DocumentChunk[] = [];

  let startWordIndex = 0;
  let childNumber = 1;

  while (startWordIndex < words.length) {
    const selectedWords: string[] = [];
    let endWordIndex = startWordIndex;

    while (endWordIndex < words.length) {
      const word = words[endWordIndex];

      if (!word) {
        break;
      }

      const candidate =
        selectedWords.length === 0
          ? word
          : `${selectedWords.join(" ")} ${word}`;

      if (
        selectedWords.length > 0 &&
        estimateTokens(candidate) >
          CHILD_MAX_TOKENS
      ) {
        break;
      }

      selectedWords.push(word);
      endWordIndex += 1;
    }

    if (selectedWords.length === 0) {
      throw new DocumentChunkingError(
        `Unable to create child chunk for ${parent.id}.`,
      );
    }

    const firstWordOffset =
      wordOffsets[startWordIndex];

    const lastWordIndex =
      endWordIndex - 1;

    const lastWord = words[lastWordIndex];

    const lastWordOffset =
      wordOffsets[lastWordIndex];

    if (
      firstWordOffset === undefined ||
      lastWord === undefined ||
      lastWordOffset === undefined
    ) {
      throw new DocumentChunkingError(
        `Unable to calculate offsets for ${parent.id}.`,
      );
    }

    const localStart = firstWordOffset;
    const localEnd =
      lastWordOffset + lastWord.length;

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

    const overlapWordCount =
      calculateOverlapWordCount(
        selectedWords,
        tokenEstimate,
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
        `Child ${child.id} exceeds ${CHILD_MAX_TOKENS} estimated tokens.`,
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