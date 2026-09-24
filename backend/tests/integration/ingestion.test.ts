import request from "supertest";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { getTextMock, destroyMock, mammothExtractMock, embedChunksMock } =
  vi.hoisted(() => ({
    getTextMock: vi.fn(),
    destroyMock: vi.fn().mockResolvedValue(undefined),
    mammothExtractMock: vi.fn(),
    embedChunksMock: vi.fn(),
  }));

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
import {
  hasEmbeddings,
  loadEmbeddings,
} from "../../src/services/retrieval/embedding-store.service.js";

const PDF_FIXTURE = {
  buffer: Buffer.from("%PDF-1.7 fake pdf bytes"),
  filename: "merger-agreement.pdf",
  contentType: "application/pdf",
} as const;

async function uploadFixture(): Promise<string> {
  const response = await request(app)
    .post("/api/upload")
    .attach("file", PDF_FIXTURE.buffer, {
      filename: PDF_FIXTURE.filename,
      contentType: PDF_FIXTURE.contentType,
    });

  expect(response.status).toBe(201);

  return response.body.document.documentId as string;
}

describe("ingestion seam (upload -> extract -> chunk -> BM25 -> embed -> persist)", () => {
  beforeEach(() => {
    getTextMock.mockResolvedValue({
      pages: [
        { text: "Section 8.2 Liability is capped at 100,000 per claim." },
        { text: "Section 12 Termination requires sixty days written notice." },
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

  it("persists a retrievable document end to end", async () => {
    const uploadResponse = await request(app)
      .post("/api/upload")
      .attach("file", PDF_FIXTURE.buffer, {
        filename: PDF_FIXTURE.filename,
        contentType: PDF_FIXTURE.contentType,
      });

    expect(uploadResponse.status).toBe(201);

    const documentId = uploadResponse.body.document.documentId as string;

    // The server issued a session cookie; reuse it for follow-up calls.
    const setCookie = uploadResponse.headers["set-cookie"]?.[0] ?? "";
    const sessionCookie = setCookie.split(";")[0];
    const sid = sessionCookie.split("=")[1];

    const status = await request(app)
      .get(`/api/documents/${documentId}/status`)
      .set("Cookie", sessionCookie);

    expect(status.status).toBe(200);
    expect(status.body.status).toBe("ready");
    expect(status.body.document.originalName).toBe("merger-agreement.pdf");
    expect(status.body.document.pageCount).toBe(2);

    // Embeddings really persisted for THIS session (store round-trip).
    expect(await hasEmbeddings(sid, documentId)).toBe(true);
    const loaded = await loadEmbeddings(sid, documentId);
    expect(loaded.embeddings.length).toBeGreaterThan(0);

    // Session-scoped: a different session id cannot see the document.
    const wrongSession = await request(app)
      .get(`/api/documents/${documentId}/status`)
      .set("Cookie", "elcara_sid=0f0e0d0c-1111-4222-8333-444455556666");

    expect(wrongSession.status).toBe(404);
  });

  it("returns 404 for an unknown document id", async () => {
    const response = await request(app).get(
      "/api/documents/0f0e0d0c-1111-4222-8333-444455556666/status",
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("rejects malformed document ids", async () => {
    const response = await request(app).get("/api/documents/not-a-uuid/status");

    expect(response.status).toBe(422);
  });
})
