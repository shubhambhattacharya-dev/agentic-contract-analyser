import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { MIME_TO_EXTENSION } from "../../src/types/document.types.js";

const {
  FIRST_PAGE,
  SECOND_PAGE,
  getTextMock,
  destroyMock,
  mammothExtractMock,
} = vi.hoisted(() => {
  const firstPage = "First page content";
  const secondPage = "Second page content";

  return {
    FIRST_PAGE: firstPage,
    SECOND_PAGE: secondPage,

    getTextMock: vi.fn(),

    destroyMock: vi.fn().mockResolvedValue(undefined),

    mammothExtractMock: vi.fn(),
  };
});

vi.mock("pdf-parse", () => ({
  PDFParse: class MockPDFParse {
    static isNodeJS = true;
    static setWorker = vi.fn();

    getText = getTextMock;
    destroy = destroyMock;
  },
}));

vi.mock("mammoth", () => ({
  default: {
    extractRawText: mammothExtractMock,
  },
}));

import {
  DocumentExtractionError,
  extractDocument,
} from "../../src/services/ingestion/extract.service.js";

const PAGE_SEPARATOR = "\n\n";

const PDF_MIME = "application/pdf";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function resetMocks(): void {
  getTextMock.mockResolvedValue({
    pages: [
      { text: FIRST_PAGE },
      { text: SECOND_PAGE },
    ],
  });

  destroyMock.mockResolvedValue(undefined);

  mammothExtractMock.mockResolvedValue({
    value: "Contract body text",
    messages: [],
  });
}

describe("extractDocument", () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetMocks();
  });

  describe("input validation", () => {
    it("throws for an empty buffer", async () => {
      await expect(
        extractDocument(Buffer.alloc(0), PDF_MIME),
      ).rejects.toThrow(DocumentExtractionError);
    });

    it("reports the empty buffer", async () => {
      await expect(
        extractDocument(Buffer.alloc(0), PDF_MIME),
      ).rejects.toThrow("Document is empty.");
    });

    it("throws for an unsupported MIME type", async () => {
      await expect(
        extractDocument(
          Buffer.from("data"),
          "text/plain" as never,
        ),
      ).rejects.toThrow(DocumentExtractionError);
    });

    it("includes the unsupported MIME type in the error", async () => {
      await expect(
        extractDocument(
          Buffer.from("data"),
          "text/plain" as never,
        ),
      ).rejects.toThrow(
        "Unsupported document type: text/plain",
      );
    });
  });

  describe("PDF extraction", () => {
    it("extracts text from multiple pages", async () => {
      const document = await extractDocument(
        Buffer.from("%PDF-1.4"),
        PDF_MIME,
      );

      expect(document.text).toBe(
        `${FIRST_PAGE}${PAGE_SEPARATOR}${SECOND_PAGE}`,
      );

      expect(document.pageCount).toBe(2);
      expect(document.pages).toHaveLength(2);
    });

    it("assigns page numbers and offsets", async () => {
      const document = await extractDocument(
        Buffer.from("%PDF-1.4"),
        PDF_MIME,
      );

      expect(document.pages[0]).toMatchObject({
        pageNumber: 1,
        text: FIRST_PAGE,
        startOffset: 0,
        endOffset: FIRST_PAGE.length,
      });

      expect(document.pages[1]).toMatchObject({
        pageNumber: 2,
        text: SECOND_PAGE,
        startOffset:
          FIRST_PAGE.length + PAGE_SEPARATOR.length,
        endOffset:
          FIRST_PAGE.length +
          PAGE_SEPARATOR.length +
          SECOND_PAGE.length,
      });
    });

    it("populates PDF metadata", async () => {
      const document = await extractDocument(
        Buffer.from("%PDF-1.4"),
        PDF_MIME,
      );

      expect(document.mimeType).toBe(PDF_MIME);

      expect(document.extension).toBe(
        MIME_TO_EXTENSION[PDF_MIME],
      );

      expect(document.isScanned).toBe(false);

      expect(document.charCount).toBe(
        document.text.length,
      );

      expect(document.wordCount).toBe(6);

      expect(document.extractedAt).toEqual(
        expect.any(String),
      );
    });

    it("destroys the PDF parser after extraction", async () => {
      await extractDocument(
        Buffer.from("%PDF-1.4"),
        PDF_MIME,
      );

      expect(destroyMock).toHaveBeenCalledTimes(1);
    });

    it("destroys the PDF parser when extraction fails", async () => {
      getTextMock.mockRejectedValueOnce(
        new Error("Corrupt PDF structure"),
      );

      await expect(
        extractDocument(
          Buffer.from("%PDF-1.4"),
          PDF_MIME,
        ),
      ).rejects.toThrow(
        "PDF extraction failed: Corrupt PDF structure",
      );

      expect(destroyMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("DOCX extraction", () => {
    it("extracts raw text", async () => {
      const document = await extractDocument(
        Buffer.from("PK"),
        DOCX_MIME,
      );

      expect(document.text).toBe(
        "Contract body text",
      );

      expect(document.pageCount).toBe(1);
      expect(document.pages).toHaveLength(1);
    });

    it("assigns page number and offsets", async () => {
      const document = await extractDocument(
        Buffer.from("PK"),
        DOCX_MIME,
      );

      const text = "Contract body text";

      expect(document.pages[0]).toMatchObject({
        pageNumber: 1,
        text,
        startOffset: 0,
        endOffset: text.length,
      });
    });

    it("populates DOCX metadata", async () => {
      const document = await extractDocument(
        Buffer.from("PK"),
        DOCX_MIME,
      );

      expect(document.mimeType).toBe(DOCX_MIME);

      expect(document.extension).toBe(
        MIME_TO_EXTENSION[DOCX_MIME],
      );

      expect(document.isScanned).toBe(false);

      expect(document.wordCount).toBe(3);

      expect(document.extractedAt).toEqual(
        expect.any(String),
      );
    });

    it("wraps DOCX extraction failures", async () => {
      mammothExtractMock.mockRejectedValueOnce(
        new Error("Corrupt DOCX structure"),
      );

      await expect(
        extractDocument(
          Buffer.from("PK"),
          DOCX_MIME,
        ),
      ).rejects.toThrow(
        "DOCX extraction failed: Corrupt DOCX structure",
      );
    });
  });

  describe("scanned PDF detection", () => {
    it("marks a PDF as scanned when no text is extracted", async () => {
      getTextMock.mockResolvedValueOnce({
        pages: [{ text: "" }],
      });

      const document = await extractDocument(
        Buffer.from("%PDF-1.4"),
        PDF_MIME,
      );

      expect(document.isScanned).toBe(true);
      expect(document.text).toBe("");
      expect(document.wordCount).toBe(0);
    });
  });
});