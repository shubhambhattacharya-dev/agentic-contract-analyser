import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer, { type FileFilterCallback } from "multer";

import { env } from "../config/env.js";
import { uploadDocumentController } from "../controllers/upload.controller.js";
import { logger } from "../lib/logger.js";
import { HttpStatus } from "../middleware/error-handler.js";

const MAX_FILE_SIZE_BYTES = env.MAX_FILE_BYTES;
const MAX_FILE_SIZE_MB = Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024));

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

function fileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
): void {
  if (
    !ALLOWED_MIME_TYPES.includes(
      file.mimetype as (typeof ALLOWED_MIME_TYPES)[number],
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

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },

  fileFilter,
});

function handleMulterError(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!(err instanceof multer.MulterError)) {
    next(err);
    return;
  }

  logger.warn(
    {
      requestId: req.requestId,
      multerCode: err.code,
      field: err.field,
    },
    "Upload rejected by multer",
  );

  switch (err.code) {
    case "LIMIT_FILE_SIZE":
      res.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: "FILE_TOO_LARGE",
          message: `File size exceeds the ${MAX_FILE_SIZE_MB}MB limit.`,
        },
      });
      return;

    case "LIMIT_FILE_COUNT":
      res.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: "TOO_MANY_FILES",
          message: "Only one file can be uploaded at a time.",
        },
      });
      return;

    case "LIMIT_UNEXPECTED_FILE":
      res.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: "UNSUPPORTED_FILE_TYPE",
          message: "Only PDF and DOCX files are supported.",
        },
      });
      return;

    default:
      res.status(HttpStatus.BAD_REQUEST).json({
        error: {
          code: "UPLOAD_ERROR",
          message: "The file upload could not be processed.",
        },
      });
  }
}

const router = Router();

router.post(
  "/",
  upload.single("file"),
  handleMulterError,
  uploadDocumentController,
);

export default router;