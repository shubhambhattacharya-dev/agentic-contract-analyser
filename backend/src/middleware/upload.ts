import type { NextFunction, Request, Response } from "express";
import multer, { type FileFilterCallback } from "multer";

import { env } from "../config/env.js";
import { HttpStatus } from "./error-handler.js";
import { SUPPORTED_MIME_TYPES } from "../types/document.types.js";

const MAX_FILE_SIZE_BYTES = env.MAX_FILE_BYTES;
const MAX_FILE_SIZE_MB = Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024));

function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
): void {
  if (
    !SUPPORTED_MIME_TYPES.includes(
      file.mimetype as (typeof SUPPORTED_MIME_TYPES)[number],
    )
  ) {
    cb(
      new multer.MulterError(
        "LIMIT_UNEXPECTED_FILE",
        file.fieldname,
      ),
    );
    return;
  }

  cb(null, true);
}

/** Single shared multer instance: memory storage, one file, type + size limits. */
export const uploadSingle = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },

  fileFilter,
}).single("file");

/** Translates multer rejections into the API error contract. */
export function handleMulterError(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: "UNSUPPORTED_FILE_TYPE",
          message:
            "File type is not supported. Only PDF and DOCX are allowed.",
        },
      });
      return;
    }

    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: "DOCUMENT_TOO_LARGE",
          message: `File exceeds the maximum allowed size of ${MAX_FILE_SIZE_MB}MB.`,
        },
      });
      return;
    }
  }

  next(err);
}
