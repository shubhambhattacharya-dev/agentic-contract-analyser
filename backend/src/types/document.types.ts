export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export type SupportedDocumentMimeType =
  (typeof SUPPORTED_MIME_TYPES)[number];

export const SUPPORTED_EXTENSIONS = [
  "pdf",
  "docx",
] as const;

export type SupportedDocumentExtension =
  (typeof SUPPORTED_EXTENSIONS)[number];

export const MIME_TO_EXTENSION: Record<
  SupportedDocumentMimeType,
  SupportedDocumentExtension
> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
};

export interface DocumentPage {
  pageNumber: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface ExtractedDocument {
  text: string;
  pages: DocumentPage[];
  pageCount: number;
  isScanned: boolean;
  mimeType: SupportedDocumentMimeType;
  extension: SupportedDocumentExtension;
  charCount: number;
  wordCount: number;
  extractedAt: string;
}

export type ExtractionResult =
  | {
      success: true;
      document: ExtractedDocument;
    }
  | {
      success: false;
      error: string;
    };

export function isSupportedMimeType(
  mimeType: string,
): mimeType is SupportedDocumentMimeType {
  return SUPPORTED_MIME_TYPES.includes(
    mimeType as SupportedDocumentMimeType,
  );
}

export function isSupportedExtension(
  extension: string,
): extension is SupportedDocumentExtension {
  return SUPPORTED_EXTENSIONS.includes(
    extension as SupportedDocumentExtension,
  );
}