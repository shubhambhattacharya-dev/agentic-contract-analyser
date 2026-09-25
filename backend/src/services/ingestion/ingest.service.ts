import { randomUUID } from "node:crypto";

import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import {
  AppError,
  HttpStatus,
} from "../../middleware/error-handler.js";
import { keys, store, TTL } from "../../lib/store.js";
import { startTrace } from "../../lib/observability.js";
import {
  type ExtractedDocument,
  type SupportedDocumentMimeType,
} from "../../types/document.types.js";
import { uploadDocument } from "../upload.service.js";
import {
  DocumentExtractionError,
  extractDocument,
} from "./extract.service.js";
import { structureDocument } from "./structure.service.js";
import {
  chunkDocument,
  DocumentChunkingError,
  type DocumentChunk,
} from "./chunk.service.js";
import {
  buildBM25Index,
} from "../retrieval/bm25.service.js";
import {
  saveBM25Index,
} from "../retrieval/bm25-store.service.js";
import {
  embedChunks,
} from "../retrieval/embedding.service.js";
import {
  saveEmbeddings,
} from "../retrieval/embedding-store.service.js";

export class ScannedDocumentError extends AppError {
  constructor() {
    super(
      "This document appears to be scanned (no selectable text). Please upload a text-based PDF or DOCX.",
      HttpStatus.UNPROCESSABLE_ENTITY,
      "SCANNED_DOCUMENT",
    );
  }
}

export class IngestionError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(
      message,
      HttpStatus.INTERNAL_SERVER_ERROR,
      "INGESTION_FAILED",
    );

    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export interface IngestInput {
  sessionId: string;
  buffer: Buffer;
  originalName: string;
  mimeType: SupportedDocumentMimeType;
  size: number;
}

export interface IngestedDocument {
  documentId: string;
  originalName: string;
  mimeType: SupportedDocumentMimeType;
  pageCount: number;
  charCount: number;
  wordCount: number;
  parentChunkCount: number;
  childChunkCount: number;
  status: string;
}

/**
 * Full ingestion pipeline — the seam that turns an uploaded binary into a
 * retrievable document:
 *
 *   upload → extract → structure → chunk → BM25 → embeddings → persist
 *
 * Failure contract: nothing is visible in the library unless every stage
 * succeeded. The raw binary may already be stored (harmless, TTL-free but
 * unreachable); the document record, indexes, and embeddings are written
 * last and only after all compute stages pass. A scanned or unreadable
 * document is rejected before any document record exists.
 */
export async function ingestDocument(
  input: IngestInput,
): Promise<IngestedDocument> {
  const documentId = randomUUID();
  const { sessionId } = input;

  const obsTrace = startTrace(
    "ingestion",
    {
      documentId,
      mimeType: input.mimeType,
      sizeBytes: input.size,
    },
    ["ingestion"],
  );

  // Tracked so a failure after the file was stored can clean it up —
  // a failed ingestion must not leave an unreachable blob behind.
  let storedFileUrl: string | null = null;

  try {
    // 1. Persist the raw binary through the storage abstraction.
    const storeSpan = obsTrace.span("store-file");

    const uploaded = await uploadDocument({
      buffer: input.buffer,
      originalname: input.originalName,
      mimetype: input.mimeType,
      size: input.size,
    });

    storedFileUrl = uploaded.url;

    storeSpan.end({ pathname: uploaded.pathname, sizeBytes: input.size });

    // 2-3. Extract + structure: one canonical text + page map.
    const extractSpan = obsTrace.span("extract");

    let extracted: ExtractedDocument;

    try {
      extracted = await extractDocument(
        input.buffer,
        input.mimeType,
      );
    } catch (error) {
      if (error instanceof DocumentExtractionError) {
        // Unreadable file: same contract as scanned — reject, keep the
        // library clean.
        throw new ScannedDocumentError();
      }

      throw error;
    }

    if (extracted.isScanned) {
      throw new ScannedDocumentError();
    }

    extractSpan.end({
      pageCount: extracted.pageCount,
      charCount: extracted.charCount,
    });

    const structured = structureDocument(extracted);

    // 4. Chunk (offset-true parents + children).
    const chunkSpan = obsTrace.span("chunk");

    let chunks: {
      parents: DocumentChunk[];
      children: DocumentChunk[];
      all: DocumentChunk[];
    };

    try {
      chunks = chunkDocument(structured);
    } catch (error) {
      if (error instanceof DocumentChunkingError) {
        throw new IngestionError(
          "Document could not be chunked.",
          error,
        );
      }

      throw error;
    }

    chunkSpan.end({
      parents: chunks.parents.length,
      children: chunks.children.length,
    });

    // 5. BM25 index over all chunks, persisted for retrieval.
    const bm25Span = obsTrace.span("bm25");

    const bm25Index = buildBM25Index(chunks.all);
    await saveBM25Index(sessionId, documentId, bm25Index, {
      ttlSeconds: TTL.DOCUMENT,
    });

    bm25Span.end({ documents: chunks.all.length });

    // 6. Embeddings for child chunks, persisted with model metadata.
    const embedSpan = obsTrace.span("embed");

    const embeddings = await embedChunks(chunks.all, {
      batchSize: env.EMBED_BATCH_SIZE,
    });

    embedSpan.end({
      vectors: embeddings.embeddings.length,
      model: embeddings.model,
    });

    await saveEmbeddings(sessionId, documentId, embeddings, {
      batchSize: env.EMBED_BATCH_SIZE,
      ttlSeconds: TTL.DOCUMENT,
    });

    // 7. Persist the document record — the library commit point.
    const meta = {
      documentId,
      originalName: input.originalName,
      mimeType: input.mimeType,
      pageCount: structured.pageCount,
      charCount: structured.charCount,
      wordCount: structured.wordCount,
      parentChunkCount: chunks.parents.length,
      childChunkCount: chunks.children.length,
      fileUrl: uploaded.url,
      filePathname: uploaded.pathname,
      sizeBytes: input.size,
      createdAt: new Date().toISOString(),
    };

    await store.set(
      keys.docMeta(sessionId, documentId),
      meta,
      TTL.DOCUMENT,
    );

    await store.set(
      keys.docText(sessionId, documentId),
      structured.text,
      TTL.DOCUMENT,
    );

    await store.set(
      keys.docPages(sessionId, documentId),
      structured.pages,
      TTL.DOCUMENT,
    );

    await store.set(
      keys.docChunks(sessionId, documentId),
      {
        parents: chunks.parents,
        children: chunks.children,
        all: chunks.all,
      },
      TTL.DOCUMENT,
    );

    await store.set(
      keys.docStatus(sessionId, documentId),
      {
        state: "ready",
        stage: "complete",
        updatedAt: new Date().toISOString(),
      },
      TTL.STATUS,
    );

    await store.set(
      keys.docFull(sessionId, documentId),
      uploaded,
      TTL.DOCUMENT,
    );

    await store.hset(
      keys.library(sessionId),
      documentId,
      meta,
      TTL.LIBRARY,
    );

    logger.info(
      {
        sessionId,
        documentId,
        originalName: input.originalName,
        pageCount: structured.pageCount,
        charCount: structured.charCount,
        parents: chunks.parents.length,
        children: chunks.children.length,
      },
      "Document ingested",
    );

    obsTrace.end({
      pageCount: structured.pageCount,
      parents: chunks.parents.length,
      children: chunks.children.length,
    });

    return {
      documentId,
      originalName: input.originalName,
      mimeType: input.mimeType,
      pageCount: structured.pageCount,
      charCount: structured.charCount,
      wordCount: structured.wordCount,
      parentChunkCount: chunks.parents.length,
      childChunkCount: chunks.children.length,
      status: "ready",
    };
  } catch (error) {
    obsTrace.end(
      { documentId },
      error instanceof Error ? error.message : "Ingestion failed",
    );

    // Ghost-file cleanup: the raw binary must not outlive a failed ingestion.
    if (storedFileUrl) {
      try {
        await store.deleteFile(storedFileUrl);
      } catch (cleanupError) {
        logger.warn(
          { cleanupError, documentId },
          "Failed to clean up stored file after ingestion failure.",
        );
      }
    }

    if (error instanceof AppError) {
      throw error;
    }

    throw new IngestionError(
      "Document ingestion failed.",
      error,
    );
  }
}



export interface DocumentStatusResponse {
  documentId: string;
  status: string;
  document: {
    originalName: string;
    mimeType: string;
    pageCount: number;
    charCount: number;
  };
}

/** Reads the processing status + summary for the library UI. */
export async function getDocumentStatus(
  sessionId: string,
  documentId: string,
): Promise<DocumentStatusResponse> {
  const meta = await store.get<{
    originalName: string;
    mimeType: string;
    pageCount: number;
    charCount: number;
  } | null>(keys.docMeta(sessionId, documentId));

  if (!meta) {
    throw new AppError(
      "Document not found.",
      HttpStatus.NOT_FOUND,
      "DOCUMENT_NOT_FOUND",
    );
  }

  return {
    documentId,
    status: "ready",
    document: {
      originalName: meta.originalName,
      mimeType: meta.mimeType,
      pageCount: meta.pageCount,
      charCount: meta.charCount,
    },
  };
}
