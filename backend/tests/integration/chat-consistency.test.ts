import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pdf-parse", () => ({
  PDFParse: vi.fn().mockImplementation(function () {
    return {
      getText: async () => ({
        pages: [
          { text: "1. TERM. The agreement runs for 24 months." },
          { text: "2. LIABILITY. The cap is AED 100,000." },
        ],
      }),
      destroy: async () => undefined,
    };
  }),
}));

vi.mock("../../src/services/retrieval/embedding.service.js", () => ({
  embedChunks: vi.fn().mockResolvedValue({
    embeddings: [],
    model: "mock",
    dimensions: 768,
  }),
  embedQuery: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/services/ai/provider.service.js", () => ({
  providerService: {
    // The agent loop decides to FINISH immediately.
    generate: vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ thought: "evidence is enough", tool: "FINISH", args: {} }),
      ),
    // The final answer streams one token.
    stream: async function* () {
      yield "The cap is AED 100,000.";
    },
  },
  generate: vi.fn(),
}));

import { app } from "../../src/app.js";
import { redis } from "../../src/lib/redis.js";
import { keys, store } from "../../src/lib/store.js";

async function uploadDoc(cookie?: string) {
  const req = request(app)
    .post("/api/upload")
    .attach(
      "file",
      Buffer.from("%PDF-1.7 mock pdf for chat consistency"),
      { filename: "consistency.pdf", contentType: "application/pdf" },
    );

  if (cookie) req.set("Cookie", cookie);

  const res = await req;
  expect(res.status).toBe(201);

  const sessionCookie =
    cookie ?? res.headers["set-cookie"].map(String).join("; ").split(";")[0];

  return {
    docId: res.body.document.documentId as string,
    cookie: sessionCookie as string,
    sessionId: sessionCookie.replace("elcara_sid=", ""),
  };
}

describe("chat consistency (ghost document protection)", () => {
  beforeEach(async () => {
    await redis.flushdb();
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it("rejects chat when a selected document has no indexed chunks, with an actionable error", async () => {
    const { docId, cookie, sessionId } = await uploadDoc();

    // Simulate the ghost state: metadata survives, index is gone.
    const deleted = await store.del(keys.docChunks(sessionId, docId));
    expect(deleted).toBe(1);

    const res = await request(app)
      .post("/api/chat")
      .set("Cookie", cookie)
      .send({ documentIds: [docId], message: "What is the liability cap?" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    const body = res.text;
    expect(body).toContain('"type":"error"');
    expect(body).toContain("no longer indexed");
    expect(body).not.toContain('"type":"quote_verified"');
    expect(body).not.toContain('"type":"done"');
  });

  it("completes normally when every selected document is indexed", async () => {
    const { docId, cookie } = await uploadDoc();

    const res = await request(app)
      .post("/api/chat")
      .set("Cookie", cookie)
      .send({ documentIds: [docId], message: "What is the liability cap?" });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("no longer indexed");
    expect(res.text).toContain('"type":"done"');
  });

  it("rejects chat for a document owned by another session", async () => {
    const { docId } = await uploadDoc();

    const res = await request(app)
      .post("/api/chat")
      .set(
        "Cookie",
        "elcara_sid=99999999-9999-4999-8999-999999999999",
      )
      .send({ documentIds: [docId], message: "What is the liability cap?" });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"error"');
    expect(res.text).toContain("no longer indexed");
  });
});

describe("blank-answer guard", () => {
  beforeEach(async () => {
    await redis.flushdb();
  });

  it("never stores an empty assistant message — falls back to the honest refusal", async () => {
    // providerService.stream is mocked at module level; override it to yield
    // nothing (model returned an empty response for an off-topic question).
    const { providerService } = await import("../../src/services/ai/provider.service.js");
    const original = providerService.stream;
    (providerService as { stream: unknown }).stream = async function* () {
      yield "   ";
    };

    const upload = await request(app)
      .post("/api/upload")
      .attach("file", Buffer.from("%PDF-1.7 mock"), {
        filename: "blank.pdf",
        contentType: "application/pdf",
      });
    const cookie = upload.headers["set-cookie"].map(String).join("; ").split(";")[0];

    const res = await request(app)
      .post("/api/chat")
      .set("Cookie", cookie)
      .send({ documentIds: [upload.body.document.documentId], message: "who is sharukh khan ?" });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"done"');
    expect(res.text).toContain("could not find sufficient evidence");
    expect(res.text).not.toContain('"content":""');

    (providerService as { stream: unknown }).stream = original;
  });
});
