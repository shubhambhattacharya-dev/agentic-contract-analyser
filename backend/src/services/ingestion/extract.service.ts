import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

import { logger } from "../../lib/logger.js";
import {
  MIME_TO_EXTENSION,
  type DocumentPage,
  type ExtractedDocument,
  type SupportedDocumentMimeType,
} from "../../types/document.types.js";

const PAGE_SEPARATOR = "\n\n";

export class DocumentExtractionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function countWords(text: string): number {
  const normalized = text.trim();

  return normalized.length > 0
    ? normalized.split(/\s+/u).length
    : 0;
}

function buildPages(pageTexts: string[]): DocumentPage[] {
  let offset = 0;

  return pageTexts.map((rawText, index) => {
    const text = normalizeText(rawText);

    const page: DocumentPage = {
      pageNumber: index + 1,
      text,
      startOffset: offset,
      endOffset: offset + text.length,
    };

    offset += text.length + PAGE_SEPARATOR.length;

    return page;
  });
}

function buildDocument(
  pages: DocumentPage[],
  mimeType: SupportedDocumentMimeType,
): ExtractedDocument {
  const text = pages
    .map((page) => page.text)
    .join(PAGE_SEPARATOR)
    .trim();

  return {
    text,
    pages,
    pageCount: pages.length,
    isScanned: pages.length > 0 && text.length === 0,
    mimeType,
    extension: MIME_TO_EXTENSION[mimeType],
    charCount: text.length,
    wordCount: countWords(text),
    extractedAt: new Date().toISOString(),
  };
}

function wrapExtractionError(
  error: unknown,
  message: string,
): DocumentExtractionError {
  if (error instanceof DocumentExtractionError) {
    return error;
  }

  return new DocumentExtractionError(
    error instanceof Error
      ? `${message}: ${error.message}`
      : message,
    error,
  );
}

async function extractPdf(
  buffer: Buffer,
  mimeType: SupportedDocumentMimeType,
): Promise<ExtractedDocument> {
  const parser = new PDFParse({
    data: buffer,
  });

  try {
    const result = await parser.getText();

    const pageTexts = result.pages.map((page) => page.text);

    const pages = buildPages(pageTexts);

    const document = buildDocument(
      pages,
      mimeType,
    );

    logger.info(
      {
        mimeType,
        pageCount: document.pageCount,
        charCount: document.charCount,
        wordCount: document.wordCount,
        isScanned: document.isScanned,
      },
      "PDF extraction complete",
    );

    return document;
  } catch (error) {
    throw wrapExtractionError(
      error,
      "PDF extraction failed",
    );
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(
  buffer: Buffer,
  mimeType: SupportedDocumentMimeType,
): Promise<ExtractedDocument> {
  try {
    const result = await mammoth.extractRawText({
      buffer,
    });

    if (result.messages.length > 0) {
      logger.warn(
        {
          warningCount: result.messages.length,
        },
        "DOCX extraction produced warnings",
      );
    }

    const text = normalizeText(result.value);

    const pages = buildPages([text]);

    const document = buildDocument(
      pages,
      mimeType,
    );

    logger.info(
      {
        mimeType,
        pageCount: document.pageCount,
        charCount: document.charCount,
        wordCount: document.wordCount,
      },
      "DOCX extraction complete",
    );

    return document;
  } catch (error) {
    throw wrapExtractionError(
      error,
      "DOCX extraction failed",
    );
  }
}

export async function extractDocument(
  buffer: Buffer,
  mimeType: SupportedDocumentMimeType,
): Promise<ExtractedDocument> {
  if (buffer.length === 0) {
    throw new DocumentExtractionError(
      "Document is empty.",
    );
  }

  switch (mimeType) {
    case "application/pdf":
      return extractPdf(buffer, mimeType);

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractDocx(buffer, mimeType);

    default: {
      const unsupportedMimeType: never = mimeType;

      throw new DocumentExtractionError(
        `Unsupported document type: ${unsupportedMimeType}`,
      );
    }
  }
}