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
import { ingestQueue } from "../../src/services/ingestion/queue.service.js";

const PDF_FIXTURE = {
  buffer: Buffer.from("%PDF-1.7 fake pdf bytes"),
  filename: "contract.pdf",
  contentType: "application/pdf",
} as const;

/** Uploads and waits for the background ingestion queue to settle. */
async function uploadAndProcess(overrides: {
  buffer?: Buffer;
  filename?: string;
  contentType?: string;
} = {}) {
  const response = await request(app)
    .post("/api/upload")
    .attach("file", overrides.buffer ?? PDF_FIXTURE.buffer, {
      filename: overrides.filename ?? PDF_FIXTURE.filename,
      contentType: overrides.contentType ?? PDF_FIXTURE.contentType,
    });

  await ingestQueue.idle();

  return response;
}

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

  it("accepts a valid PDF with 202, processes it in the queue, and reports ready", async () => {
    const response = await uploadAndProcess();

    expect(response.status).toBe(202);
    expect(response.body.message).toContain("background");
    expect(response.body.document.documentId).toBeDefined();
    expect(response.body.document.originalName).toBe("contract.pdf");
    expect(response.body.status).toBe("queued");

    const documentId = response.body.document.documentId as string;
    const cookie = response.headers["set-cookie"][0].split(";")[0];

    const status = await request(app)
      .get(`/api/documents/${documentId}/status`)
      .set("Cookie", cookie);

    expect(status.status).toBe(200);
    expect(status.body.status).toBe("ready");
    expect(status.body.document.pageCount).toBe(2);

    const library = await request(app)
      .get("/api/documents")
      .set("Cookie", cookie);

    expect(library.status).toBe(200);
    expect(library.body.documents).toHaveLength(1);
    expect(library.body.documents[0].pageCount).toBe(2);
    expect(library.body.documents[0].parentChunkCount).toBeGreaterThan(0);
    expect(library.body.documents[0].status).toBe("ready");
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

  it("fails scanned PDFs asynchronously and leaves the library clean", async () => {
    getTextMock.mockResolvedValue({ pages: [{ text: "" }] });

    const response = await uploadAndProcess({ filename: "scanned.pdf" });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("queued");

    const documentId = response.body.document.documentId as string;
    const cookie = response.headers["set-cookie"][0].split(";")[0];

    const status = await request(app)
      .get(`/api/documents/${documentId}/status`)
      .set("Cookie", cookie);

    expect(status.status).toBe(200);
    expect(status.body.status).toBe("failed");
    expect(status.body.error).toContain("scanned");

    const library = await request(app)
      .get("/api/documents")
      .set("Cookie", cookie);

    expect(library.status).toBe(200);
    expect(library.body.documents).toHaveLength(0);
  });

  it("fails unreadable PDFs asynchronously with the failed status", async () => {
    getTextMock.mockRejectedValue(new Error("bad pdf structure"));

    const response = await uploadAndProcess({ filename: "broken.pdf" });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("queued");

    const documentId = response.body.document.documentId as string;
    const cookie = response.headers["set-cookie"][0].split(";")[0];

    const status = await request(app)
      .get(`/api/documents/${documentId}/status`)
      .set("Cookie", cookie);

    expect(status.status).toBe(200);
    expect(status.body.status).toBe("failed");
  });

  it("answers chat with a still-processing notice while the document is in the queue", async () => {
    // Gate the pipeline at the embed stage so the queue is deterministically
    // mid-job (status "processing") when the chat request arrives.
    let releaseEmbeddings: (() => void) | undefined;
    embedChunksMock.mockImplementation(
      async () =>
        await new Promise<{ embeddings: unknown[]; model: string; dimensions: number }>(
          (resolve) => {
            releaseEmbeddings = () =>
              resolve({
                embeddings: [],
                model: "mock-embedding",
                dimensions: 4,
              });
          },
        ),
    );

    const response = await request(app)
      .post("/api/upload")
      .attach("file", PDF_FIXTURE.buffer, {
        filename: PDF_FIXTURE.filename,
        contentType: PDF_FIXTURE.contentType,
      });

    expect(response.status).toBe(202);

    const documentId = response.body.document.documentId as string;
    const cookie = response.headers["set-cookie"][0].split(";")[0];

    const chat = await request(app)
      .post("/api/chat")
      .set("Cookie", cookie)
      .send({ documentIds: [documentId], message: "What is the cap?" });

    expect(chat.status).toBe(200);
    expect(chat.headers["content-type"]).toContain("text/event-stream");
    expect(chat.text).toContain('"type":"error"');
    expect(chat.text).toContain("still processing");

    // Let the queue finish: the worker may still be in the BM25 stage, so
    // wait until the embed gate actually exists before releasing it.
    await new Promise<void>((done) => {
      const poll = setInterval(() => {
        if (releaseEmbeddings) {
          clearInterval(poll);
          releaseEmbeddings();
          done();
        }
      }, 5);
    });

    await ingestQueue.idle();

    const status = await request(app)
      .get(`/api/documents/${documentId}/status`)
      .set("Cookie", cookie);

    expect(status.body.status).toBe("ready");
  });
});
