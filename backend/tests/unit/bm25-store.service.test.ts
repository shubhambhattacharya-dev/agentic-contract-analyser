import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { DocumentChunk } from "../../src/services/ingestion/chunk.service.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  exists: vi.fn(),
}));

vi.mock("../../src/lib/store.js", () => ({
  store: mocks,
}));

// Import after mock registration.
import {
  BM25Index,
  type BM25Document,
} from "../../src/services/retrieval/bm25.service.js";

import {
  BM25StoreError,
  deleteBM25Index,
  hasBM25Index,
  loadBM25Index,
  saveBM25Index,
  updateBM25Index,
} from "../../src/services/retrieval/bm25-store.service.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_ID = "session-test-123" as const;
const DOCUMENT_ID = "document-test-123" as const;

const META_KEY =
  `${SESSION_ID}:doc:${DOCUMENT_ID}:bm25:meta`;

const BATCH_KEY_PREFIX =
  `${SESSION_ID}:doc:${DOCUMENT_ID}:bm25:batch:`;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function createChild(
  id: string,
  text: string,
): DocumentChunk {
  return {
    id,
    kind: "child",
    parentId: "parent-1",
    text,
    startOffset: 0,
    endOffset: text.length,
    tokenEstimate: Math.ceil(
      text.length / 4,
    ),
  };
}

function createIndex(): BM25Index {
  const index = new BM25Index();

  index.addDocuments([
    createChild(
      "parent-1-child-1",
      "The tenant shall pay rent every month.",
    ),
    createChild(
      "parent-1-child-2",
      "The landlord may terminate the agreement.",
    ),
    createChild(
      "parent-1-child-3",
      "The tenant must maintain the property.",
    ),
  ]);

  return index;
}

function createLargeIndex(): BM25Index {
  const index = new BM25Index();

  const chunks: DocumentChunk[] = [];

  for (let i = 0; i < 501; i += 1) {
    chunks.push(
      createChild(
        `parent-1-child-${i + 1}`,
        `Contract clause ${i + 1} requires tenant notice and payment.`,
      ),
    );
  }

  index.addDocuments(chunks);

  return index;
}

function createMeta(
  generation = "generation-1",
  batchCount = 1,
) {
  return {
    version: 1 as const,
    generation,
    k1: 1.5,
    b: 0.75,
    documentCount: 3,
    averageDocumentLength: 7,
    batchCount,
    documentFrequency: {
      tenant: 2,
      landlord: 1,
      agreement: 1,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BM25 store service", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.set.mockResolvedValue(undefined);
    mocks.del.mockResolvedValue(undefined);
    mocks.exists.mockResolvedValue(false);
  });

  // ── Save ──────────────────────────────────────────────────────────────────

  describe("saveBM25Index", () => {
    it("saves BM25 metadata", async () => {
      const index = createIndex();

      await saveBM25Index(
        SESSION_ID,
        DOCUMENT_ID,
        index,
      );

      expect(mocks.set).toHaveBeenCalled();

      expect(mocks.set).toHaveBeenLastCalledWith(
        META_KEY,
        expect.objectContaining({
          version: 1,
          documentCount: 3,
          batchCount: 1,
        }),
        86_400,
      );
    });

    it("writes batches before metadata", async () => {
      const calls: string[] = [];

      mocks.set.mockImplementation(
        async (key: string) => {
          calls.push(key);
        },
      );

      await saveBM25Index(
        SESSION_ID,
        DOCUMENT_ID,
        createIndex(),
      );

      const metaIndex =
        calls.indexOf(META_KEY);

      const batchIndex =
        calls.findIndex((key) =>
          key.startsWith(
            BATCH_KEY_PREFIX,
          ),
        );

      expect(batchIndex).toBeGreaterThanOrEqual(
        0,
      );

      expect(metaIndex).toBeGreaterThan(
        batchIndex,
      );
    });

    it("uses the default 24 hour TTL", async () => {
      await saveBM25Index(
        SESSION_ID,
        DOCUMENT_ID,
        createIndex(),
      );

      expect(mocks.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        86_400,
      );
    });

    it("supports a custom TTL", async () => {
      await saveBM25Index(
        SESSION_ID,
        DOCUMENT_ID,
        createIndex(),
        { ttlSeconds: 3600 },
      );

      expect(mocks.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        3600,
      );
    });

    it("supports TTL disabled with zero", async () => {
      await saveBM25Index(
        SESSION_ID,
        DOCUMENT_ID,
        createIndex(),
        { ttlSeconds: 0 },
      );

      expect(mocks.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
      );
    });

    it("rejects invalid TTL", async () => {
      await expect(
        saveBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
          createIndex(),
          { ttlSeconds: -1 },
        ),
      ).rejects.toThrow(
        BM25StoreError,
      );

      expect(mocks.set).not.toHaveBeenCalled();
    });

    it("rejects non-integer TTL", async () => {
      await expect(
        saveBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
          createIndex(),
          { ttlSeconds: 1.5 },
        ),
      ).rejects.toThrow(
        "TTL must be a non-negative integer.",
      );
    });

    it("creates multiple batches for a large index", async () => {
      await saveBM25Index(
        SESSION_ID,
        DOCUMENT_ID,
        createLargeIndex(),
      );

      const batchCalls =
        mocks.set.mock.calls.filter(
          ([key]) =>
            typeof key === "string" &&
            key.startsWith(
              BATCH_KEY_PREFIX,
            ),
        );

      expect(batchCalls).toHaveLength(3);
    });

    it("uses the same generation for all batches", async () => {
      await saveBM25Index(
        SESSION_ID,
        DOCUMENT_ID,
        createLargeIndex(),
      );

      const batchKeys =
        mocks.set.mock.calls
          .map(([key]) => key)
          .filter(
            (key): key is string =>
              typeof key === "string" &&
              key.startsWith(
                BATCH_KEY_PREFIX,
              ),
          );

      const generations =
        batchKeys.map((key) => {
          const parts = key.split(":");

          return parts.at(-2);
        });

      expect(
        new Set(generations).size,
      ).toBe(1);
    });

    it("wraps unexpected storage errors", async () => {
      mocks.set.mockRejectedValueOnce(
        new Error("Redis unavailable"),
      );

      await expect(
        saveBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
          createIndex(),
        ),
      ).rejects.toThrow(
        "Failed to save BM25 index.",
      );
    });
  });

  // ── Load ──────────────────────────────────────────────────────────────────

  describe("loadBM25Index", () => {
    it("returns null when metadata does not exist", async () => {
      mocks.get.mockResolvedValueOnce(null);

      const result =
        await loadBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
        );

      expect(result).toBeNull();
    });

    it("loads a stored BM25 index", async () => {
      const original =
        createIndex();

      const data =
        original.toJSON();

      const generation =
        "generation-1";

      mocks.get.mockImplementation(
        async (key: string) => {
          if (key === META_KEY) {
            return {
              version: 1,
              generation,
              k1: data.k1,
              b: data.b,
              documentCount:
                data.documentCount,
              averageDocumentLength:
                data.averageDocumentLength,
              batchCount: 1,
              documentFrequency:
                data.documentFrequency,
            };
          }

          if (
            key ===
            `${BATCH_KEY_PREFIX}${generation}:0`
          ) {
            return data.documents;
          }

          return null;
        },
      );

      const restored =
        await loadBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
        );

      expect(restored).not.toBeNull();

      expect(
        restored?.documentCount,
      ).toBe(
        original.documentCount,
      );
    });

    it("restored index can search", async () => {
      const original =
        createIndex();

      const data =
        original.toJSON();

      const generation =
        "generation-search";

      mocks.get.mockImplementation(
        async (key: string) => {
          if (key === META_KEY) {
            return {
              version: 1,
              generation,
              k1: data.k1,
              b: data.b,
              documentCount:
                data.documentCount,
              averageDocumentLength:
                data.averageDocumentLength,
              batchCount: 1,
              documentFrequency:
                data.documentFrequency,
            };
          }

          return data.documents;
        },
      );

      const restored =
        await loadBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
        );

      expect(
        restored?.search("tenant"),
      ).toEqual(
        original.search("tenant"),
      );
    });

    it("loads multiple batches", async () => {
      const documents: BM25Document[] =
        Array.from(
          { length: 501 },
          (_, index) => ({
            id: `chunk-${index}`,
            length: 5,
            termFrequency: {
              tenant: 1,
            },
          }),
        );

      const generation =
        "generation-large";

      mocks.get.mockImplementation(
        async (key: string) => {
          if (key === META_KEY) {
            return {
              version: 1,
              generation,
              k1: 1.5,
              b: 0.75,
              documentCount: 501,
              averageDocumentLength: 5,
              batchCount: 3,
              documentFrequency: {
                tenant: 501,
              },
            };
          }

          const batchNumber =
            Number(
              key.split(":").at(-1),
            );

          return documents.slice(
            batchNumber * 250,
            (batchNumber + 1) * 250,
          );
        },
      );

      const result =
        await loadBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
        );

      expect(
        result?.documentCount,
      ).toBe(501);
    });

    it("throws when a batch is missing", async () => {
      mocks.get.mockImplementation(
        async (key: string) => {
          if (key === META_KEY) {
            return createMeta(
              "generation-missing",
              1,
            );
          }

          return null;
        },
      );

      await expect(
        loadBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
        ),
      ).rejects.toThrow(
        "BM25 batch 0 is missing.",
      );
    });

    it("rejects an unsupported version", async () => {
      mocks.get.mockResolvedValueOnce({
        ...createMeta(),
        version: 99,
      });

      await expect(
        loadBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
        ),
      ).rejects.toThrow(
        "Unsupported BM25 index version: 99",
      );
    });

    it("detects document count mismatch", async () => {
      mocks.get.mockImplementation(
        async (key: string) => {
          if (key === META_KEY) {
            return {
              ...createMeta(),
              documentCount: 100,
              batchCount: 1,
            };
          }

          return [
            {
              id: "chunk-1",
              length: 5,
              termFrequency: {
                tenant: 1,
              },
            },
          ];
        },
      );

      await expect(
        loadBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
        ),
      ).rejects.toThrow(
        "BM25 document count does not match stored metadata.",
      );
    });

    it("preserves BM25StoreError", async () => {
      mocks.get.mockRejectedValue(
        new BM25StoreError(
          "Storage failure",
        ),
      );

      await expect(
        loadBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
        ),
      ).rejects.toThrow(
        "Storage failure",
      );
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  describe("deleteBM25Index", () => {
    it("does nothing when metadata does not exist", async () => {
      mocks.get.mockResolvedValueOnce(null);

      await deleteBM25Index(
        SESSION_ID,
        DOCUMENT_ID,
      );

      expect(mocks.del).not.toHaveBeenCalled();
    });

    it("deletes batches before metadata", async () => {
      mocks.get.mockResolvedValueOnce(
        createMeta(
          "generation-delete",
          2,
        ),
      );

      const calls: string[] = [];

      mocks.del.mockImplementation(
        async (key: string) => {
          calls.push(key);
        },
      );

      await deleteBM25Index(
        SESSION_ID,
        DOCUMENT_ID,
      );

      expect(calls).toEqual([
        `${BATCH_KEY_PREFIX}generation-delete:0`,
        `${BATCH_KEY_PREFIX}generation-delete:1`,
        META_KEY,
      ]);
    });

    it("deletes all batches", async () => {
      mocks.get.mockResolvedValueOnce(
        createMeta(
          "generation-delete",
          3,
        ),
      );

      await deleteBM25Index(
        SESSION_ID,
        DOCUMENT_ID,
      );

      expect(mocks.del).toHaveBeenCalledTimes(
        4,
      );
    });

    it("wraps delete failures", async () => {
      mocks.get.mockResolvedValueOnce(
        createMeta(),
      );

      mocks.del.mockRejectedValueOnce(
        new Error("Redis unavailable"),
      );

      await expect(
        deleteBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
        ),
      ).rejects.toThrow(
        "Failed to delete BM25 index.",
      );
    });
  });

  // ── Update ────────────────────────────────────────────────────────────────

  describe("updateBM25Index", () => {
    it("creates a new generation", async () => {
      const oldGeneration =
        "old-generation";

      const oldMeta =
        createMeta(
          oldGeneration,
          1,
        );

      mocks.get.mockImplementation(
        async (key: string) => {
          if (key === META_KEY) {
            return oldMeta;
          }

          return null;
        },
      );

      const index =
        createIndex();

      await updateBM25Index(
        SESSION_ID,
        DOCUMENT_ID,
        index,
      );

      const metaWrites =
        mocks.set.mock.calls.filter(
          ([key]) =>
            key === META_KEY,
        );

      expect(metaWrites).toHaveLength(
        1,
      );

      const newMeta =
        metaWrites[0]?.[1] as {
          generation: string;
        };

      expect(
        newMeta.generation,
      ).not.toBe(oldGeneration);
    });
  });

  // ── Existence ─────────────────────────────────────────────────────────────

  describe("hasBM25Index", () => {
    it("returns true when metadata exists", async () => {
      mocks.exists.mockResolvedValueOnce(
        true,
      );

      await expect(
        hasBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
        ),
      ).resolves.toBe(true);
    });

    it("returns false when metadata does not exist", async () => {
      mocks.exists.mockResolvedValueOnce(
        false,
      );

      await expect(
        hasBM25Index(
          SESSION_ID,
          DOCUMENT_ID,
        ),
      ).resolves.toBe(false);
    });
  });

  // ── Identifier Validation ─────────────────────────────────────────────────

  describe("identifier validation", () => {
    it("rejects an empty session ID", async () => {
      await expect(
        saveBM25Index(
          "",
          DOCUMENT_ID,
          createIndex(),
        ),
      ).rejects.toThrow(
        "Invalid session ID.",
      );
    });

    it("rejects unsafe session IDs", async () => {
      await expect(
        saveBM25Index(
          "session:test",
          DOCUMENT_ID,
          createIndex(),
        ),
      ).rejects.toThrow(
        "Invalid session ID.",
      );
    });

    it("rejects unsafe document IDs", async () => {
      await expect(
        saveBM25Index(
          SESSION_ID,
          "document:test",
          createIndex(),
        ),
      ).rejects.toThrow(
        "Invalid document ID.",
      );
    });

    it("accepts hyphens and underscores", async () => {
      await expect(
        saveBM25Index(
          "session_123-test",
          "document_123-test",
          createIndex(),
        ),
      ).resolves.toBeUndefined();
    });
  });
});