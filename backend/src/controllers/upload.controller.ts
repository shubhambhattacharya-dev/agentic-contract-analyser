import type {
  NextFunction,
  Request,
  Response,
} from "express";

import { logger } from "../lib/logger.js";
import { HttpStatus } from "../middleware/error-handler.js";
import { uploadDocument } from "../services/upload.service.js";

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

    const uploaded = await uploadDocument(req.file);

    res.status(201).json({
      message: "Document uploaded successfully.",
      document: {
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        pathname: uploaded.pathname,
      },
    });
  } catch (error) {
    next(error);
  }
}