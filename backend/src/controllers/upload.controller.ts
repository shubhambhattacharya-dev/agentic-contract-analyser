import type {
  NextFunction,
  Request,
  Response,
} from "express";

import { logger } from "../lib/logger.js";
import { HttpStatus } from "../middleware/error-handler.js";
import { ingestDocument } from "../services/ingestion/ingest.service.js";
import type { SupportedDocumentMimeType } from "../types/document.types.js";

/**
 * POST /api/upload - the full ingestion seam:
 * upload -> extract -> structure -> chunk -> BM25 -> embeddings -> persist.
 * Returns 201 with the document record, or 422 for scanned/unreadable files
 * (nothing is saved in that case - the library stays clean).
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

    const result = await ingestDocument({
      sessionId: req.sessionId,
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      // The multer fileFilter already restricted uploads to supported types.
      mimeType: req.file.mimetype as SupportedDocumentMimeType,
      size: req.file.size,
    });

    res.status(HttpStatus.CREATED).json({
      message: "Document uploaded and processed successfully.",
      document: {
        documentId: result.documentId,
        originalName: result.originalName,
        mimeType: result.mimeType,
        size: req.file.size,
        pageCount: result.pageCount,
        charCount: result.charCount,
        wordCount: result.wordCount,
        parentChunkCount: result.parentChunkCount,
        childChunkCount: result.childChunkCount,
      },
      status: result.status,
    });
  } catch (error) {
    next(error);
  }
}
