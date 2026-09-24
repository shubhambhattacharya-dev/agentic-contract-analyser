import type { NextFunction, Request, Response } from "express";

import { logger } from "../lib/logger.js";
import { store } from "../lib/store.js";
import {
  AppError,
  HttpStatus,
} from "../middleware/error-handler.js";

function getSessionId(req: Request): string {
  const { sessionId } = req;

  if (!sessionId) {
    throw new AppError(
      "Session is required.",
      HttpStatus.UNAUTHORIZED,
      "SESSION_REQUIRED",
    );
  }

  return sessionId;
}

function getDocumentId(req: Request): string {
  const { docId } = req.params;

  if (typeof docId !== "string" || !docId) {
    throw new AppError(
      "Invalid document ID.",
      HttpStatus.UNPROCESSABLE_ENTITY,
      "INVALID_DOCUMENT_ID",
    );
  }

  return docId;
}

export async function listDocuments(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const sessionId = getSessionId(req);

    const documents = await store.listDocuments(sessionId);

    logger.debug(
      {
        sessionId,
        documentCount: documents.length,
        operation: "listDocuments",
      },
      "Documents listed",
    );

    res.status(HttpStatus.OK).json({
      documents,
    });
  } catch (error) {
    next(error);
  }
}

export async function getDocument(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const sessionId = getSessionId(req);
    const documentId = getDocumentId(req);

    const document = await store.getDocumentMeta(
      sessionId,
      documentId,
    );

    if (!document) {
      throw new AppError(
        "Document not found.",
        HttpStatus.NOT_FOUND,
        "DOCUMENT_NOT_FOUND",
      );
    }

    logger.debug(
      {
        sessionId,
        documentId,
        operation: "getDocument",
      },
      "Document retrieved",
    );

    res.status(HttpStatus.OK).json({
      document,
    });
  } catch (error) {
    next(error);
  }
}

/** GET /api/documents/:docId/content — canonical text + page map for the viewer. */
export async function getDocumentContent(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const sessionId = getSessionId(req);
    const documentId = getDocumentId(req);

    const [meta, text, pages] = await Promise.all([
      store.getDocumentMeta(sessionId, documentId),
      store.get<string>(`elcara:sess:${sessionId}:doc:${documentId}:text`),
      store.get<{ pageNumber: number; startOffset: number; endOffset: number }[]>(
        `elcara:sess:${sessionId}:doc:${documentId}:pages`,
      ),
    ]);

    if (!meta || !text) {
      throw new AppError(
        "Document not found.",
        HttpStatus.NOT_FOUND,
        "DOCUMENT_NOT_FOUND",
      );
    }

    res.status(HttpStatus.OK).json({
      documentId,
      originalName: meta.originalName,
      pageCount: meta.pageCount,
      text,
      pages: pages ?? [],
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteDocument(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const sessionId = getSessionId(req);
    const documentId = getDocumentId(req);

    const deleted = await store.deleteDocument(
      sessionId,
      documentId,
    );

    if (!deleted) {
      throw new AppError(
        "Document not found.",
        HttpStatus.NOT_FOUND,
        "DOCUMENT_NOT_FOUND",
      );
    }

    logger.info(
      {
        sessionId,
        documentId,
        operation: "deleteDocument",
        status: "deleted",
      },
      "Document deleted",
    );

    res.status(HttpStatus.NO_CONTENT).send();
  } catch (error) {
    next(error);
  }
}