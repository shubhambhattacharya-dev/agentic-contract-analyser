import request from "supertest";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const putMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    url: "https://blob.test/documents/test.pdf",
    pathname: "documents/test.pdf",
  }),
);

vi.mock("@vercel/blob", () => ({
  put: putMock,
}));

import { app } from "../../src/app.js";

const PDF_FIXTURE = {
  buffer: Buffer.from("%PDF-1.7\n1 0 obj\n"),
  filename: "contract.pdf",
  contentType: "application/pdf",
} as const;

const DOCX_FIXTURE = {
  buffer: Buffer.from("PK\x03\x04"),
  filename: "contract.docx",
  contentType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

const TXT_FIXTURE = {
  buffer: Buffer.from("plain text"),
  filename: "contract.txt",
  contentType: "text/plain",
} as const;

describe("POST /api/upload", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("success", () => {
    it("uploads a valid PDF and returns document metadata", async () => {
      const response = await request(app)
        .post("/api/upload")
        .attach("file", PDF_FIXTURE.buffer, {
          filename: PDF_FIXTURE.filename,
          contentType: PDF_FIXTURE.contentType,
        });

      expect(response.status).toBe(201);

      expect(response.body.message).toBe(
        "Document uploaded successfully.",
      );

      expect(response.body.document).toMatchObject({
        originalName: PDF_FIXTURE.filename,
        mimeType: PDF_FIXTURE.contentType,
        size: PDF_FIXTURE.buffer.byteLength,
        pathname: "documents/test.pdf",
      });

      expect(putMock).toHaveBeenCalledTimes(1);
    });

    it("uploads a valid DOCX and returns document metadata", async () => {
      putMock.mockResolvedValueOnce({
        url: "https://blob.test/documents/test.docx",
        pathname: "documents/test.docx",
      });

      const response = await request(app)
        .post("/api/upload")
        .attach("file", DOCX_FIXTURE.buffer, {
          filename: DOCX_FIXTURE.filename,
          contentType: DOCX_FIXTURE.contentType,
        });

      expect(response.status).toBe(201);

      expect(response.body.document).toMatchObject({
        originalName: DOCX_FIXTURE.filename,
        mimeType: DOCX_FIXTURE.contentType,
        pathname: "documents/test.docx",
      });

      expect(putMock).toHaveBeenCalledTimes(1);
    });

    it("returns an X-Request-ID response header", async () => {
      const response = await request(app)
        .post("/api/upload")
        .attach("file", PDF_FIXTURE.buffer, {
          filename: PDF_FIXTURE.filename,
          contentType: PDF_FIXTURE.contentType,
        });

      expect(response.headers["x-request-id"]).toBeDefined();
    });

    it("preserves a valid incoming X-Request-ID", async () => {
      const customId = "test-request-id-123";

      const response = await request(app)
        .post("/api/upload")
        .set("x-request-id", customId)
        .attach("file", PDF_FIXTURE.buffer, {
          filename: PDF_FIXTURE.filename,
          contentType: PDF_FIXTURE.contentType,
        });

      expect(response.headers["x-request-id"]).toBe(customId);
    });
  });

  describe("validation errors", () => {
    it("rejects a request with no file", async () => {
      const response = await request(app)
        .post("/api/upload");

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("FILE_REQUIRED");
      expect(putMock).not.toHaveBeenCalled();
    });

    it("rejects an unsupported file type", async () => {
      const response = await request(app)
        .post("/api/upload")
        .attach("file", TXT_FIXTURE.buffer, {
          filename: TXT_FIXTURE.filename,
          contentType: TXT_FIXTURE.contentType,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(
        "UNSUPPORTED_FILE_TYPE",
      );
      expect(putMock).not.toHaveBeenCalled();
    });

    it("rejects a file larger than 25MB", async () => {
      const largeFile = Buffer.alloc(
        25 * 1024 * 1024 + 1,
        0,
      );

      const response = await request(app)
        .post("/api/upload")
        .attach("file", largeFile, {
          filename: "large-contract.pdf",
          contentType: PDF_FIXTURE.contentType,
        });

      expect(response.status).toBe(400);

      expect([
        "FILE_TOO_LARGE",
        "DOCUMENT_TOO_LARGE",
      ]).toContain(response.body.error.code);

      expect(putMock).not.toHaveBeenCalled();
    });
  });

  describe("service errors", () => {
    it("returns 502 when Vercel Blob upload fails", async () => {
      putMock.mockRejectedValueOnce(
        new Error("Blob storage unavailable"),
      );

      const response = await request(app)
        .post("/api/upload")
        .attach("file", PDF_FIXTURE.buffer, {
          filename: PDF_FIXTURE.filename,
          contentType: PDF_FIXTURE.contentType,
        });

      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe(
        "UPLOAD_FAILED",
      );

      expect(putMock).toHaveBeenCalledTimes(1);
    });

    it("does not expose internal Blob error details", async () => {
      putMock.mockRejectedValueOnce(
        new Error("Internal secret error"),
      );

      const response = await request(app)
        .post("/api/upload")
        .attach("file", PDF_FIXTURE.buffer, {
          filename: PDF_FIXTURE.filename,
          contentType: PDF_FIXTURE.contentType,
        });

      expect(response.status).toBe(502);

      expect(response.body.error.message).not.toContain(
        "Internal secret error",
      );
    });
  });
});