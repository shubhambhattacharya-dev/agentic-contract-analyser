import { logger } from "../../lib/logger.js";
import type {
  DocumentPage,
  ExtractedDocument,
} from "../../types/document.types.js";

const PAGE_SEPARATOR = "\n\n";

export class DocumentStructureError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DocumentStructureError";
  }
}

function countWords(text: string): number {
  const value = text.trim();

  return value.length === 0
    ? 0
    : value.split(/\s+/u).length;
}

function validatePage(page: DocumentPage): void {
  if (
    !Number.isInteger(page.pageNumber) ||
    page.pageNumber < 1
  ) {
    throw new DocumentStructureError(
      `Invalid page number: ${page.pageNumber}`,
    );
  }

  if (typeof page.text !== "string") {
    throw new DocumentStructureError(
      `Invalid text for page ${page.pageNumber}.`,
    );
  }

  if (
    !Number.isInteger(page.startOffset) ||
    !Number.isInteger(page.endOffset)
  ) {
    throw new DocumentStructureError(
      `Invalid offsets for page ${page.pageNumber}.`,
    );
  }

  if (page.startOffset < 0) {
    throw new DocumentStructureError(
      `Invalid start offset for page ${page.pageNumber}.`,
    );
  }

  if (page.endOffset < page.startOffset) {
    throw new DocumentStructureError(
      `Invalid offset range for page ${page.pageNumber}.`,
    );
  }
}

function validateDocument(
  document: ExtractedDocument,
): void {
  if (!document) {
    throw new DocumentStructureError(
      "Extracted document is required.",
    );
  }

  if (!Array.isArray(document.pages)) {
    throw new DocumentStructureError(
      "Document pages must be an array.",
    );
  }

  if (document.pages.length === 0) {
    throw new DocumentStructureError(
      "Document contains no pages.",
    );
  }
}

function buildCanonicalPages(
  pages: DocumentPage[],
): DocumentPage[] {
  let offset = 0;

  return pages.map((page, index) => {
    validatePage(page);

    const text = page.text;

    const canonicalPage: DocumentPage = {
      pageNumber: index + 1,
      text,
      startOffset: offset,
      endOffset: offset + text.length,
    };

    offset += text.length + PAGE_SEPARATOR.length;

    return canonicalPage;
  });
}

function buildCanonicalText(
  pages: DocumentPage[],
): string {
  return pages
    .map((page) => page.text)
    .join(PAGE_SEPARATOR);
}

function validateOffsets(
  canonicalText: string,
  pages: DocumentPage[],
): void {
  for (const page of pages) {
    const pageText = canonicalText.slice(
      page.startOffset,
      page.endOffset,
    );

    if (pageText !== page.text) {
      throw new DocumentStructureError(
        `Page ${page.pageNumber} offsets do not match canonical text.`,
      );
    }
  }
}

function buildStructuredDocument(
  document: ExtractedDocument,
  pages: DocumentPage[],
  text: string,
): ExtractedDocument {
  const isScanned =
    pages.length > 0 &&
    text.trim().length === 0;

  return {
    ...document,
    text,
    pages,
    pageCount: pages.length,
    charCount: text.length,
    wordCount: countWords(text),
    isScanned,
  };
}

export function structureDocument(
  document: ExtractedDocument,
): ExtractedDocument {
  try {
    validateDocument(document);

    const pages = buildCanonicalPages(
      document.pages,
    );

    const text = buildCanonicalText(pages);

    validateOffsets(text, pages);

    const structuredDocument =
      buildStructuredDocument(
        document,
        pages,
        text,
      );

    if (structuredDocument.isScanned) {
      logger.warn(
        {
          mimeType: structuredDocument.mimeType,
          pageCount: structuredDocument.pageCount,
        },
        "Document appears to be scanned with no selectable text.",
      );
    }

    logger.debug(
      {
        mimeType: structuredDocument.mimeType,
        pageCount: structuredDocument.pageCount,
        charCount: structuredDocument.charCount,
        wordCount: structuredDocument.wordCount,
        isScanned: structuredDocument.isScanned,
      },
      "Document structure built",
    );

    return structuredDocument;
  } catch (error) {
    if (error instanceof DocumentStructureError) {
      throw error;
    }

    throw new DocumentStructureError(
      "Failed to build document structure.",
      error,
    );
  }
}