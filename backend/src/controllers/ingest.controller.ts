import type {
  NextFunction,
  Request,
  Response,
} from "express";

import { logger } from "../lib/logger.js";
import { HttpStatus } from "../middleware/error-handler.js";
import { getDocumentStatus } from "../services/ingestion/ingest.service.js";

/** GET /api/documents/:docId/status — processing status for the library UI. */
export async function getDocumentStatusController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { docId } = req.params as { docId: string };

    const result = await getDocumentStatus(
      req.sessionId,
      docId,
    );

    res.status(HttpStatus.OK).json(result);
  } catch (error) {
    next(error);
  }
}
