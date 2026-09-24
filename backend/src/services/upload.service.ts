import { env } from "../config/env.js";
import {
  AppError,
  HttpStatus,
} from "../middleware/error-handler.js";
import {
  MIME_TO_EXTENSION,
  type SupportedDocumentMimeType,
} from "../types/document.types.js";
import { store, type StoredFile } from "../lib/store.js";

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

export interface UploadedDocument extends StoredFile {
  originalName: string;
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

/** The fields the uploader actually consumes - req.file satisfies this. */
export type UploadFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

function validateFile(
  file: UploadFile,
): asserts file is UploadFile & { mimetype: AllowedMimeType } {
  if (!isAllowedMimeType(file.mimetype)) {
    throw new UnsupportedFileTypeError(file.mimetype);
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new DocumentTooLargeError();
  }
}

function storageKeyFor(
  originalName: string,
  mimeType: AllowedMimeType,
): string {
  const extension = MIME_TO_EXTENSION[mimeType];
  // Client-supplied names are untrusted: keep the basename, drop anything
  // outside a safe charset, and let the storage layer add its own suffix.
  const safeBase =
    originalName
      .split(/[\/]/)
      .pop()
      ?.replace(/[^\w.\- ]+/g, "_")
      .slice(0, 120) || "document";

  return `documents/${safeBase}.${extension}`;
}

/**
 * Validates and persists the raw binary through the storage abstraction.
 * Document record creation and extraction happen in the ingestion service.
 */
export async function uploadDocument(
  file: UploadFile,
): Promise<UploadedDocument> {
  validateFile(file);

  try {
    const stored = await store.putFile(
      storageKeyFor(file.originalname, file.mimetype),
      file.buffer,
      file.mimetype,
    );

    return {
      ...stored,
      originalName: file.originalname,
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
