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
import { keys, store } from "../../src/lib/store.js";

const PDF_FIXTURE = {
  buffer: Buffer.from("%PDF-1.7 mock pdf content for document library"),
  filename: "contract-agreement.pdf",
  contentType: "application/pdf",
} as const;

async function uploadDoc(sessionCookie?: string, filename = PDF_FIXTURE.filename) {
  const req = request(app)
    .post("/api/upload")
    .attach("file", PDF_FIXTURE.buffer, {
      filename,
      contentType: PDF_FIXTURE.contentType,
    });

  if (sessionCookie) {
    req.set("Cookie", sessionCookie);
  }

  const res = await req;
  expect(res.status).toBe(201);

  const cookie =
    sessionCookie ??
    (res.headers["set-cookie"]?.[0]?.split(";")[0] as string);
  const sid = cookie.split("=")[1] as string;
  const docId = res.body.document.documentId as string;

  return { docId, cookie, sid, body: res.body };
}

describe("Document Library Integration Tests", () => {
  beforeEach(() => {
    getTextMock.mockResolvedValue({
      pages: [
        { text: "Page 1: Terms and conditions agreement." },
        { text: "Page 2: Signatures and obligations." },
      ],
    });
    mammothExtractMock.mockResolvedValue({
      value: "Extracted contract text",
      messages: [],
    });
    embedChunksMock.mockResolvedValue({
      embeddings: [
        { chunkId: "c0", values: [0.1, 0.2, 0.3, 0.4] },
        { chunkId: "c1", values: [0.5, 0.6, 0.7, 0.8] },
      ],
      model: "mock-embedding",
      dimensions: 4,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await redis.flushdb();
  });

  // 1. list documents
  it("1. lists documents for the current session sorted newest first", async () => {
    const { cookie } = await uploadDoc(undefined, "first-doc.pdf");
    await uploadDoc(cookie, "second-doc.pdf");

    const response = await request(app)
      .get("/api/documents")
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("documents");
    expect(response.body.documents).toHaveLength(2);
    expect(response.body.documents[0].originalName).toBe("second-doc.pdf");
    expect(response.body.documents[1].originalName).toBe("first-doc.pdf");
  });

  // 2. empty library
  it("2. returns an empty array when library has no documents", async () => {
    const emptySessionCookie =
      "elcara_sid=00000000-0000-4000-8000-000000000001";

    const response = await request(app)
      .get("/api/documents")
      .set("Cookie", emptySessionCookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ documents: [] });
  });

  // 3. get existing document
  it("3. gets an existing document by docId", async () => {
    const { docId, cookie } = await uploadDoc();

    const response = await request(app)
      .get(`/api/documents/${docId}`)
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("document");
    expect(response.body.document.documentId).toBe(docId);
    expect(response.body.document.originalName).toBe(PDF_FIXTURE.filename);
    expect(response.body.document.pageCount).toBe(2);
  });

  // 4. get unknown document -> 404
  it("4. returns 404 DOCUMENT_NOT_FOUND when getting an unknown document", async () => {
    const sessionCookie =
      "elcara_sid=00000000-0000-4000-8000-000000000002";

    const response = await request(app)
      .get("/api/documents/ffffffff-ffff-4fff-8fff-ffffffffffff")
      .set("Cookie", sessionCookie);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("DOCUMENT_NOT_FOUND");
  });

  // 5. invalid document ID -> 422
  it("5. returns 422 VALIDATION_ERROR for malformed docId on GET", async () => {
    const sessionCookie =
      "elcara_sid=00000000-0000-4000-8000-000000000003";

    const response = await request(app)
      .get("/api/documents/not-a-valid-uuid")
      .set("Cookie", sessionCookie);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  // 6. missing session -> 401
  it("6. auto-provisions a session on first contact (200 + Set-Cookie)", async () => {
    // A brand-new browser session has no cookie yet. The global session
    // middleware assigns one and issues Set-Cookie; the request must succeed
    // against the fresh (empty) session instead of being rejected. This is
    // the assignment's "no login" contract: sessions are anonymous and
    // created on first use — never shared across browsers.
    const listRes = await request(app).get("/api/documents");
    expect(listRes.status).toBe(200);
    expect(listRes.body.documents).toEqual([]);
    expect(listRes.headers["set-cookie"]).toBeDefined();

    const getRes = await request(app).get(
      "/api/documents/ffffffff-ffff-4fff-8fff-ffffffffffff",
    );
    expect(getRes.status).toBe(404);
    expect(getRes.body.error.code).toBe("DOCUMENT_NOT_FOUND");

    const delRes = await request(app).delete(
      "/api/documents/ffffffff-ffff-4fff-8fff-ffffffffffff",
    );
    expect(delRes.status).toBe(404);
    expect(delRes.body.error.code).toBe("DOCUMENT_NOT_FOUND");
  });

  // 7. status endpoint
  it("7. returns document processing status via GET /api/documents/:docId/status", async () => {
    const { docId, cookie } = await uploadDoc();

    const response = await request(app)
      .get(`/api/documents/${docId}/status`)
      .set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ready");
    expect(response.body.document.originalName).toBe(PDF_FIXTURE.filename);
  });

  // 8. delete existing document -> 204
  it("8. deletes an existing document and returns 204 No Content", async () => {
    const { docId, cookie } = await uploadDoc();

    const deleteRes = await request(app)
      .delete(`/api/documents/${docId}`)
      .set("Cookie", cookie);

    expect(deleteRes.status).toBe(204);
    expect(deleteRes.body).toEqual({});
  });

  // 9. delete unknown document -> 404
  it("9. returns 404 DOCUMENT_NOT_FOUND when deleting an unknown document", async () => {
    const sessionCookie =
      "elcara_sid=00000000-0000-4000-8000-000000000004";

    const response = await request(app)
      .delete("/api/documents/ffffffff-ffff-4fff-8fff-ffffffffffff")
      .set("Cookie", sessionCookie);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("DOCUMENT_NOT_FOUND");
  });

  // 10. delete invalid ID -> 422
  it("10. returns 422 VALIDATION_ERROR when deleting with malformed docId", async () => {
    const sessionCookie =
      "elcara_sid=00000000-0000-4000-8000-000000000005";

    const response = await request(app)
      .delete("/api/documents/not-a-valid-uuid")
      .set("Cookie", sessionCookie);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  // 11. cross-session GET isolation
  it("11. ensures Session B cannot access Session A's document via GET", async () => {
    const { docId, cookie: cookieA } = await uploadDoc();
    const cookieB = "elcara_sid=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    // Session B tries to list documents -> empty
    const listResB = await request(app)
      .get("/api/documents")
      .set("Cookie", cookieB);
    expect(listResB.status).toBe(200);
    expect(listResB.body.documents).toHaveLength(0);

    // Session B tries to get document A -> 404
    const getResB = await request(app)
      .get(`/api/documents/${docId}`)
      .set("Cookie", cookieB);
    expect(getResB.status).toBe(404);
    expect(getResB.body.error.code).toBe("DOCUMENT_NOT_FOUND");

    // Session B tries to get document A status -> 404
    const statusResB = await request(app)
      .get(`/api/documents/${docId}/status`)
      .set("Cookie", cookieB);
    expect(statusResB.status).toBe(404);

    // Session A can still access its document
    const getResA = await request(app)
      .get(`/api/documents/${docId}`)
      .set("Cookie", cookieA);
    expect(getResA.status).toBe(200);
    expect(getResA.body.document.documentId).toBe(docId);
  });

  // 12. cross-session DELETE isolation
  it("12. ensures Session B cannot delete Session A's document", async () => {
    const { docId, cookie: cookieA } = await uploadDoc();
    const cookieB = "elcara_sid=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    // Session B attempts to delete document A -> 404
    const delResB = await request(app)
      .delete(`/api/documents/${docId}`)
      .set("Cookie", cookieB);
    expect(delResB.status).toBe(404);
    expect(delResB.body.error.code).toBe("DOCUMENT_NOT_FOUND");

    // Session A still has document A
    const getResA = await request(app)
      .get(`/api/documents/${docId}`)
      .set("Cookie", cookieA);
    expect(getResA.status).toBe(200);
    expect(getResA.body.document.documentId).toBe(docId);
  });

  // 13. document disappears from library after delete
  it("13. removes document from library list after deletion", async () => {
    const { docId, cookie } = await uploadDoc();

    const deleteRes = await request(app)
      .delete(`/api/documents/${docId}`)
      .set("Cookie", cookie);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app)
      .get("/api/documents")
      .set("Cookie", cookie);
    expect(listRes.status).toBe(200);
    expect(listRes.body.documents).toHaveLength(0);
  });

  // 14. document metadata removed
  it("14. removes document metadata from store after deletion", async () => {
    const { docId, cookie, sid } = await uploadDoc();

    expect(await store.getDocumentMeta(sid, docId)).not.toBeNull();

    await request(app)
      .delete(`/api/documents/${docId}`)
      .set("Cookie", cookie);

    expect(await store.getDocumentMeta(sid, docId)).toBeNull();
  });

  // 15. document status removed
  it("15. removes document status from store after deletion", async () => {
    const { docId, cookie, sid } = await uploadDoc();

    expect(await store.getDocumentStatus(sid, docId)).not.toBeNull();

    await request(app)
      .delete(`/api/documents/${docId}`)
      .set("Cookie", cookie);

    expect(await store.getDocumentStatus(sid, docId)).toBeNull();
  });

  // 16. document file removed
  it("16. removes associated stored file after deletion", async () => {
    const { docId, cookie, sid } = await uploadDoc();

    const meta = await store.getDocumentMeta(sid, docId);
    expect(meta).not.toBeNull();
    const fileUrl = meta!.fileUrl;

    expect(await store.fileExists(fileUrl)).toBe(true);

    await request(app)
      .delete(`/api/documents/${docId}`)
      .set("Cookie", cookie);

    expect(await store.fileExists(fileUrl)).toBe(false);
  });

  // 17. document storage keys removed
  it("17. removes all document storage keys (BM25, embeddings, pages, text, chunks) on delete", async () => {
    const { docId, cookie, sid } = await uploadDoc();

    // Verify keys exist before delete
    expect(await store.exists(keys.docMeta(sid, docId))).toBe(true);
    expect(await store.exists(keys.docText(sid, docId))).toBe(true);
    expect(await store.exists(keys.docFull(sid, docId))).toBe(true);
    expect(await store.exists(keys.docPages(sid, docId))).toBe(true);
    expect(await store.exists(keys.docChunks(sid, docId))).toBe(true);
    expect(await store.exists(keys.docStatus(sid, docId))).toBe(true);
    expect(await store.exists(`${sid}:doc:${docId}:bm25:meta`)).toBe(true);
    expect(await store.exists(`${sid}:doc:${docId}:emb:meta`)).toBe(true);

    await request(app)
      .delete(`/api/documents/${docId}`)
      .set("Cookie", cookie);

    // Verify all keys are removed after delete
    expect(await store.exists(keys.docMeta(sid, docId))).toBe(false);
    expect(await store.exists(keys.docText(sid, docId))).toBe(false);
    expect(await store.exists(keys.docFull(sid, docId))).toBe(false);
    expect(await store.exists(keys.docPages(sid, docId))).toBe(false);
    expect(await store.exists(keys.docChunks(sid, docId))).toBe(false);
    expect(await store.exists(keys.docStatus(sid, docId))).toBe(false);
    expect(await store.exists(`${sid}:doc:${docId}:bm25:meta`)).toBe(false);
    expect(await store.exists(`${sid}:doc:${docId}:emb:meta`)).toBe(false);
  });

  // 18. Redis/local development behavior
  it("18. behaves consistently in local development with filesystem storage and Redis", async () => {
    const { docId, cookie, sid } = await uploadDoc();

    const meta = await store.getDocumentMeta(sid, docId);
    expect(meta).not.toBeNull();
    expect(meta!.fileUrl).toMatch(/^local:\/\//);

    // File exists locally
    expect(await store.fileExists(meta!.fileUrl)).toBe(true);

    // Metas are stored in session library hash
    const libMeta = await store.hget(keys.library(sid), docId);
    expect(libMeta).not.toBeNull();
  });

  // 19. unexpected store failure -> clean 500
  it("19. returns a clean 500 without leaking credentials or internals on unexpected store failure", async () => {
    const sessionCookie =
      "elcara_sid=00000000-0000-4000-8000-000000000006";

    const storeSpy = vi
      .spyOn(store, "listDocuments")
      .mockRejectedValueOnce(new Error("FATAL: Redis connection failed"));

    const response = await request(app)
      .get("/api/documents")
      .set("Cookie", sessionCookie);

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(response.body.error.message).toBe("An unexpected error occurred.");
    expect(response.body.error.requestId).toBeDefined();
    // Ensure raw error message / stack is not leaked
    expect(JSON.stringify(response.body)).not.toContain("FATAL: Redis connection failed");


    storeSpy.mockRestore();
  });
});
