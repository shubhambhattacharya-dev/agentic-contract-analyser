import request from "supertest";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const {
  getTextMock,
  destroyMock,
  mammothExtractMock,
  embedChunksMock,
} = vi.hoisted(() => ({
  getTextMock: vi.fn(),
  destroyMock: vi.fn().mockResolvedValue(undefined),
  mammothExtractMock: vi.fn(),
  embedChunksMock: vi.fn(),
}));

// External I/O is mocked; everything else (store, fs, Redis, chunking,
// BM25, embeddings persistence) runs for real against the local Redis.
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

vi.mock("../../src/services/retrieval/embedding.service.js", () => ({
  embedChunks: embedChunksMock,
  embedText: vi.fn(),
  embedQuery: vi.fn(),
}));

import { app } from "../../src/app.js";
import { redis } from "../../src/lib/redis.js";

const PDF_FIXTURE = {
  buffer: Buffer.from("%PDF-1.7 fake pdf bytes"),
  filename: "contract.pdf",
  contentType: "application/pdf",
} as const;

describe("POST /api/upload (ingestion seam)", () => {
  beforeEach(() => {
    getTextMock.mockResolvedValue({
      pages: [
        { text: "The liability cap is 100,000." },
        { text: "Termination requires 30 days notice." },
      ],
    });
    mammothExtractMock.mockResolvedValue({
      value: "Contract body text",
      messages: [],
    });
    embedChunksMock.mockResolvedValue({
      embeddings: [
        { chunkId: "c0", values: [0.1, 0.2, 0.3, 0.4] },
        { chunkId: "c1", values: [0.2, 0.3, 0.4, 0.5] },
      ],
      model: "mock-embedding",
      dimensions: 4,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await redis.flushdb();
  });

  it("uploads a valid PDF through the full seam and returns the document record", async () => {
    const response = await request(app)
      .post("/api/upload")
      .attach("file", PDF_FIXTURE.buffer, {
        filename: PDF_FIXTURE.filename,
        contentType: PDF_FIXTURE.contentType,
      });

    expect(response.status).toBe(201);
    expect(response.body.message).toBe(
      "Document uploaded and processed successfully.",
    );
    expect(response.body.document.documentId).toBeDefined();
    expect(response.body.document.originalName).toBe("contract.pdf");
    expect(response.body.document.pageCount).toBe(2);
    expect(response.body.document.parentChunkCount).toBeGreaterThan(0);
    expect(response.body.document.childChunkCount).toBeGreaterThan(0);
    expect(response.body.status).toBe("ready");
  });

  it("rejects files without a file field", async () => {
    const response = await request(app).post("/api/upload");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("FILE_REQUIRED");
  });

  it("rejects unsupported file types with a clear message", async () => {
    const response = await request(app)
      .post("/api/upload")
      .attach("file", Buffer.from("plain text"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("rejects files larger than 25MB", async () => {
    const bigBuffer = Buffer.alloc(26 * 1024 * 1024);

    const response = await request(app)
      .post("/api/upload")
      .attach("file", bigBuffer, {
        filename: "big.pdf",
        contentType: "application/pdf",
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("DOCUMENT_TOO_LARGE");
  });

  it("rejects scanned PDFs with 422 and saves nothing", async () => {
    getTextMock.mockResolvedValue({ pages: [{ text: "" }] });

    const response = await request(app)
      .post("/api/upload")
      .attach("file", PDF_FIXTURE.buffer, {
        filename: "scanned.pdf",
        contentType: PDF_FIXTURE.contentType,
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("SCANNED_DOCUMENT");
  });

  it("rejects unreadable PDFs with 422", async () => {
    getTextMock.mockRejectedValue(new Error("bad pdf structure"));

    const response = await request(app)
      .post("/api/upload")
      .attach("file", PDF_FIXTURE.buffer, {
        filename: "broken.pdf",
        contentType: PDF_FIXTURE.contentType,
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("SCANNED_DOCUMENT");
  });
})
