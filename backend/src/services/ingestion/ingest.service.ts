import { randomUUID } from "node:crypto";

import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import {
  AppError,
  HttpStatus,
} from "../../middleware/error-handler.js";
import { keys, store, TTL, deleteIndexBatches } from "../../lib/store.js";
import { startTrace } from "../../lib/observability.js";
import { EmbeddingError } from "../retrieval/embedding.service.js";
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — request path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fast request-path half of ingestion: validate + store the binary, then
 * create the library entry, metadata, and a "queued" status record so the
 * document is visible and pollable before any heavy work starts.
 *
 * The heavy pipeline runs in the background queue (processIngestionJob).
 *
 * Failure contract (changed with async ingestion): the document IS visible
 * in the library while queued/processing. If the pipeline then fails, the
 * document is removed from the library and its indexes/files cleaned up —
 * only a "failed" status record survives (1-day TTL) so the polling client
 * can show what happened. The library still never keeps a broken document.
 */
export async function queueDocument(
  input: IngestInput,
): Promise<{
  documentId: string;
  status: "queued";
  fileUrl: string;
  filePathname: string;
}> {
  const documentId = randomUUID();

  const obsTrace = startTrace(
    "ingestion-queue",
    {
      documentId,
      mimeType: input.mimeType,
      sizeBytes: input.size,
    },
    ["ingestion"],
  );

  try {
    const storeSpan = obsTrace.span("store-file");

    const uploaded = await uploadDocument({
      buffer: input.buffer,
      originalname: input.originalName,
      mimetype: input.mimeType,
      size: input.size,
    });

    storeSpan.end({ pathname: uploaded.pathname, sizeBytes: input.size });

    const now = new Date().toISOString();

    // Provisional metadata: counts land when the pipeline commits.
    const meta = {
      documentId,
      originalName: input.originalName,
      mimeType: input.mimeType,
      pageCount: 0,
      charCount: 0,
      wordCount: 0,
      parentChunkCount: 0,
      childChunkCount: 0,
      fileUrl: uploaded.url,
      filePathname: uploaded.pathname,
      sizeBytes: input.size,
      createdAt: now,
      status: "processing",
    };

    await store.set(
      keys.docMeta(input.sessionId, documentId),
      meta,
      TTL.DOCUMENT,
    );

    await store.set(
      keys.docFull(input.sessionId, documentId),
      uploaded,
      TTL.DOCUMENT,
    );

    await store.set(
      keys.docStatus(input.sessionId, documentId),
      {
        state: "queued",
        stage: "queued",
        updatedAt: now,
      },
      TTL.STATUS,
    );

    await store.hset(
      keys.library(input.sessionId),
      documentId,
      meta,
      TTL.LIBRARY,
    );

    obsTrace.end({ documentId });

    return {
      documentId,
      status: "queued",
      fileUrl: uploaded.url,
      filePathname: uploaded.pathname,
    };
  } catch (error) {
    obsTrace.end(
      { documentId },
      error instanceof Error ? error.message : "Queueing failed",
    );

    if (error instanceof AppError) {
      throw error;
    }

    throw new IngestionError("Document could not be queued.", error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — worker path (queue executor)
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestJob {
  sessionId: string;
  documentId: string;
  buffer: Buffer;
  originalName: string;
  mimeType: SupportedDocumentMimeType;
  size: number;
  fileUrl: string;
  filePathname: string;
}

/**
 * Heavy ingestion pipeline, executed by the background queue:
 *
 *   extract → structure → chunk → BM25 → embeddings → commit
 *
 * On success the provisional metadata is replaced with real counts and the
 * status flips to "ready". On failure everything is cleaned up and only a
 * "failed" status record remains.
 */
export async function processIngestionJob(
  job: IngestJob,
): Promise<void> {
  const { sessionId, documentId } = job;

  const obsTrace = startTrace(
    "ingestion-worker",
    {
      documentId,
      mimeType: job.mimeType,
      sizeBytes: job.size,
    },
    ["ingestion"],
  );

  try {
    await store.set(
      keys.docStatus(sessionId, documentId),
      {
        state: "processing",
        stage: "extract",
        updatedAt: new Date().toISOString(),
      },
      TTL.STATUS,
    );

    // Extract + structure: one canonical text + page map.
    const extractSpan = obsTrace.span("extract");

    let extracted: ExtractedDocument;

    try {
      extracted = await extractDocument(
        job.buffer,
        job.mimeType,
      );
    } catch (error) {
      if (error instanceof DocumentExtractionError) {
        // Unreadable file: same contract as scanned — reject, clean up.
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

    // Chunk (offset-true parents + children).
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

    await store.set(
      keys.docStatus(sessionId, documentId),
      {
        state: "processing",
        stage: "index",
        updatedAt: new Date().toISOString(),
      },
      TTL.STATUS,
    );

    // BM25 index over all chunks, persisted for retrieval.
    const bm25Span = obsTrace.span("bm25");

    const bm25Index = buildBM25Index(chunks.all);
    await saveBM25Index(sessionId, documentId, bm25Index, {
      ttlSeconds: TTL.DOCUMENT,
    });

    bm25Span.end({ documents: chunks.all.length });

    // Embeddings for child chunks, persisted with model metadata.
    //
    // Resilience: if the embedding provider is rate-limited or down, the
    // document is still ingested in BM25-only mode (lexical retrieval fully
    // works; dense retrieval is disabled for this document) instead of
    // failing the upload. A document the user can search beats a 500.
    const embedSpan = obsTrace.span("embed");

    let embeddings: Awaited<ReturnType<typeof embedChunks>> | null = null;
    let embeddingsMode: "dense" | "bm25-only" = "dense";

    try {
      embeddings = await embedChunks(chunks.all, {
        batchSize: env.EMBED_BATCH_SIZE,
      });
    } catch (error) {
      if (error instanceof EmbeddingError) {
        embeddingsMode = "bm25-only";

        logger.warn(
          { documentId, error: error.message },
          "Embedding unavailable — ingesting in BM25-only mode.",
        );

        embeddings = {
          embeddings: [],
          model: "unavailable",
          dimensions: 0,
        };
      } else {
        throw error;
      }
    }

    embedSpan.end({
      vectors: embeddings.embeddings.length,
      model: embeddings.model,
      mode: embeddingsMode,
    });

    await saveEmbeddings(sessionId, documentId, embeddings, {
      batchSize: env.EMBED_BATCH_SIZE,
      ttlSeconds: TTL.DOCUMENT,
    });

    // Ghost-document guard before the commit point: the document may have
    // been deleted (or failed by the queue's timeout backstop) while this
    // job was running. The status record is the arbiter — if it no longer
    // says queued/processing, this job's work must not resurrect anything.
    const statusRecord = await store.getDocumentStatus(
      sessionId,
      documentId,
    );

    if (
      !statusRecord ||
      (statusRecord.state !== "queued" &&
        statusRecord.state !== "processing")
    ) {
      logger.warn(
        { sessionId, documentId, state: statusRecord?.state },
        "Ingestion job aborted before commit — document deleted or failed mid-processing.",
      );

      // The winner of the race (delete or failure path) already cleaned up
      // the document keys; only the batched index data written since then
      // can leak, and deleting it again is harmless.
      await deleteIndexBatches(sessionId, documentId);

      obsTrace.end({ documentId }, "Aborted before commit");
      return;
    }

    // Commit point: real counts + canonical text + indexes become visible.
    const meta = {
      documentId,
      originalName: job.originalName,
      mimeType: job.mimeType,
      pageCount: structured.pageCount,
      charCount: structured.charCount,
      wordCount: structured.wordCount,
      parentChunkCount: chunks.parents.length,
      childChunkCount: chunks.children.length,
      fileUrl: job.fileUrl,
      filePathname: job.filePathname,
      sizeBytes: job.size,
      createdAt: new Date().toISOString(),
      status: "ready",
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
        originalName: job.originalName,
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
  } catch (error) {
    obsTrace.end(
      { documentId },
      error instanceof Error ? error.message : "Ingestion failed",
    );

    await markIngestionFailed(
      sessionId,
      documentId,
      job.fileUrl,
      error instanceof Error
        ? error.message
        : "Processing failed unexpectedly.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure cleanup (worker + queue backstop + boot recovery)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fails an in-flight ingestion: removes the document from the library,
 * deletes metadata and indexes (including the raw binary — a failed
 * ingestion must not leave an unreachable blob behind), and writes a
 * "failed" status record so the polling client learns the reason.
 *
 * Best-effort by design: every step is individually guarded, because this
 * runs on paths (timeout backstop, boot recovery) where partial state is
 * exactly what we are cleaning up.
 */
export async function markIngestionFailed(
  sessionId: string,
  documentId: string,
  fileUrl: string | null,
  reason: string,
): Promise<void> {
  logger.warn(
    { sessionId, documentId, reason },
    "Marking ingestion failed.",
  );

  const meta = await store.getDocumentMeta(sessionId, documentId);

  const url = fileUrl ?? meta?.fileUrl ?? null;

  if (url) {
    try {
      await store.deleteFile(url);
    } catch (error) {
      logger.warn(
        { error, documentId },
        "Failed to delete stored file after ingestion failure.",
      );
    }
  }

  await store.del(...keys.allDocKeys(sessionId, documentId));

  // BM25 + embedding batches live under their own keys (not in allDocKeys).
  await deleteIndexBatches(sessionId, documentId);

  await store.hdel(keys.library(sessionId), documentId);

  await store.set(
    keys.docStatus(sessionId, documentId),
    {
      state: "failed",
      stage: "failed",
      error: reason,
      updatedAt: new Date().toISOString(),
    },
    TTL.STATUS,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot recovery
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_KEY_PATTERN = "elcara:sess:*:doc:*:status";
const STATUS_KEY_RE =
  /^elcara:sess:([^:]+):doc:([^:]+):status$/;

/**
 * Runs once at startup: the in-memory queue dies with the process, so any
 * document still "queued"/"processing" was interrupted by a restart. Its
 * job is gone — mark it failed and clean up, so the library never shows a
 * document that will never finish processing.
 *
 * Returns the number of interrupted ingestions recovered.
 */
export async function recoverInterruptedIngestions(): Promise<number> {
  let statusKeys: string[];

  try {
    statusKeys = await store.scanKeys(STATUS_KEY_PATTERN);
  } catch (error) {
    logger.error(
      { err: error },
      "Boot recovery could not scan for interrupted ingestions.",
    );

    return 0;
  }

  let recovered = 0;

  for (const key of statusKeys) {
    const match = STATUS_KEY_RE.exec(key);

    if (!match?.[1] || !match[2]) {
      continue;
    }

    const sessionId = match[1];
    const documentId = match[2];

    try {
      const record = await store.getDocumentStatus(
        sessionId,
        documentId,
      );

      if (
        !record ||
        (record.state !== "queued" &&
          record.state !== "processing")
      ) {
        continue;
      }

      await markIngestionFailed(
        sessionId,
        documentId,
        null,
        "Processing was interrupted by a server restart — please upload the document again.",
      );

      recovered += 1;
    } catch (error) {
      logger.warn(
        { err: error, sessionId, documentId },
        "Boot recovery failed for one document.",
      );
    }
  }

  if (recovered > 0) {
    logger.warn(
      { recovered },
      "Boot recovery marked interrupted ingestions as failed.",
    );
  }

  return recovered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status read model
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentStatusResponse {
  documentId: string;
  status: string;
  error?: string;
  document?: {
    originalName: string;
    mimeType: string;
    pageCount: number;
    charCount: number;
  };
}

/** Reads the real processing status for the library UI. */
export async function getDocumentStatus(
  sessionId: string,
  documentId: string,
): Promise<DocumentStatusResponse> {
  const [meta, statusRecord] = await Promise.all([
    store.getDocumentMeta(sessionId, documentId),
    store.getDocumentStatus(sessionId, documentId),
  ]);

  if (!meta && !statusRecord) {
    throw new AppError(
      "Document not found.",
      HttpStatus.NOT_FOUND,
      "DOCUMENT_NOT_FOUND",
    );
  }

  const state =
    statusRecord?.state ?? (meta ? "ready" : "failed");

  if (state === "failed") {
    return {
      documentId,
      status: "failed",
      error:
        (statusRecord as { error?: string } | null)?.error ??
        "Processing failed.",
      ...(meta
        ? {
            document: {
              originalName: meta.originalName,
              mimeType: meta.mimeType,
              pageCount: meta.pageCount,
              charCount: meta.charCount,
            },
          }
        : {}),
    };
  }

  if (!meta) {
    // A live state (queued/processing/ready) with no metadata means the
    // document record was lost — not answerable, treat as absent.
    throw new AppError(
      "Document not found.",
      HttpStatus.NOT_FOUND,
      "DOCUMENT_NOT_FOUND",
    );
  }

  return {
    documentId,
    status: state,
    document: {
      originalName: meta.originalName,
      mimeType: meta.mimeType,
      pageCount: meta.pageCount,
      charCount: meta.charCount,
    },
  };
}
