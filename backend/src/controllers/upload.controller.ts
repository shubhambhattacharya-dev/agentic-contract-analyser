import type {
  NextFunction,
  Request,
  Response,
} from "express";

import { logger } from "../lib/logger.js";
import { HttpStatus } from "../middleware/error-handler.js";
import { queueDocument } from "../services/ingestion/ingest.service.js";
import { ingestQueue } from "../services/ingestion/queue.service.js";
import type { SupportedDocumentMimeType } from "../types/document.types.js";

/**
 * POST /api/upload — accepts the file, stores it, creates the library entry,
 * and hands the heavy pipeline to the background queue.
 *
 * Returns 202 with the document record and status "queued"; the client polls
 * GET /api/documents/:docId/status until "ready" or "failed". Validation
 * rejections (missing file, wrong type, too large) still fail the request
 * synchronously with 400. Scan/readability failures are detected during
 * background processing and surface as status "failed" — the library is
 * cleaned up either way.
 */
export async function uploadDocumentController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.file) {
      logger.warn(
        { requestId: req.requestId },
        "Upload rejected: no file provided",
      );

      res.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: "FILE_REQUIRED",
          message: "Please upload a PDF or DOCX file.",
        },
      });
      return;
    }

    const queued = await queueDocument({
      sessionId: req.sessionId,
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      // The multer fileFilter already restricted uploads to supported types.
      mimeType: req.file.mimetype as SupportedDocumentMimeType,
      size: req.file.size,
    });

    ingestQueue.enqueue({
      sessionId: req.sessionId,
      documentId: queued.documentId,
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype as SupportedDocumentMimeType,
      size: req.file.size,
      fileUrl: queued.fileUrl,
      filePathname: queued.filePathname,
    });

    logger.info(
      {
        requestId: req.requestId,
        sessionId: req.sessionId,
        documentId: queued.documentId,
      },
      "Upload accepted — ingestion queued.",
    );

    res.status(HttpStatus.ACCEPTED).json({
      message: "Document accepted — processing continues in the background.",
      document: {
        documentId: queued.documentId,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
      status: "queued",
    });
  } catch (error) {
    next(error);
  }
}
