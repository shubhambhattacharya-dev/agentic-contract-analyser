import { put } from "@vercel/blob";

import { env } from "../config/env.js";
import {
  AppError,
  HttpStatus,
} from "../middleware/error-handler.js";

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

const MAX_FILE_SIZE_BYTES = env.MAX_FILE_BYTES;
const MAX_FILE_SIZE_MB = Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024));

type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export class UnsupportedFileTypeError extends AppError {
  constructor(mimeType: string) {
    super(
      `File type "${mimeType}" is not supported. Only PDF and DOCX are allowed.`,
      HttpStatus.BAD_REQUEST,
      "UNSUPPORTED_FILE_TYPE",
    );
  }
}

export class DocumentTooLargeError extends AppError {
  constructor() {
    super(
      `File exceeds the maximum allowed size of ${MAX_FILE_SIZE_MB}MB.`,
      HttpStatus.BAD_REQUEST,
      "DOCUMENT_TOO_LARGE",
    );
  }
}

export class UploadFailedError extends AppError {
  constructor() {
    super(
      "The document could not be uploaded. Please try again.",
      HttpStatus.BAD_GATEWAY,
      "UPLOAD_FAILED",
    );
  }
}

export interface UploadedDocument {
  url: string;
  pathname: string;
  contentType: AllowedMimeType;
  size: number;
}

function isAllowedMimeType(
  mimeType: string,
): mimeType is AllowedMimeType {
  return ALLOWED_MIME_TYPES.includes(
    mimeType as AllowedMimeType,
  );
}

function validateFile(
  file: Express.Multer.File,
): asserts file is Express.Multer.File & { mimetype: AllowedMimeType } {
  if (!isAllowedMimeType(file.mimetype)) {
    throw new UnsupportedFileTypeError(file.mimetype);
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new DocumentTooLargeError();
  }
}

export async function uploadDocument(
  file: Express.Multer.File,
): Promise<UploadedDocument> {
  validateFile(file);

  try {
    const blob = await put(
      `documents/${file.originalname}`,
      file.buffer,
      {
        access: "private",
        addRandomSuffix: true,
        contentType: file.mimetype,
      },
    );

    return {
      url: blob.url,
      pathname: blob.pathname,
      contentType: file.mimetype,
      size: file.size,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new UploadFailedError();
  }
}