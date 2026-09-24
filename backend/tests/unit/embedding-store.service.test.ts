import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const storeMock = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  exists: vi.fn(),
}));

vi.mock("../../src/lib/store.js", () => ({
  store: storeMock,
}));

import {
  EmbeddingStoreError,
  deleteEmbeddings,
  hasEmbeddings,
  loadEmbeddings,
  saveEmbeddings,
  updateEmbeddings,
} from "../../src/services/retrieval/embedding-store.service.js";

import type { StoredEmbeddingResult } from "../../src/services/retrieval/embedding-store.service.js";

// ─── Test Data ────────────────────────────────────────────────────────────────

const SESSION_ID = "session-123";
const DOCUMENT_ID = "document-456";

const MODEL = "gemini-embedding-2";

const DIMENSIONS = 3;

const EMBEDDING_ONE = {
  chunkId: "parent-1-child-1",
  values: [0.1, 0.2, 0.3],
};

const EMBEDDING_TWO = {
  chunkId: "parent-1-child-2",
  values: [0.4, 0.5, 0.6],
};

const EMBEDDING_THREE = {
  chunkId: "parent-2-child-1",
  values: [0.7, 0.8, 0.9],
};

function createResult(
  embeddings = [
    EMBEDDING_ONE,
    EMBEDDING_TWO,
    EMBEDDING_THREE,
  ],
): StoredEmbeddingResult {
  return {
    embeddings,
    model: MODEL,
    dimensions: DIMENSIONS,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("embedding-store.service", () => {
  afterEach(() => {
    vi.clearAllMocks();

    storeMock.set.mockResolvedValue(undefined);
    storeMock.del.mockResolvedValue(undefined);
    storeMock.exists.mockResolvedValue(false);
  });

  // ─── Save ────────────────────────────────────────────────────────────────

  describe("saveEmbeddings", () => {
    it("saves metadata and embedding batches", async () => {
      await saveEmbeddings(
        SESSION_ID,
        DOCUMENT_ID,
        createResult(),
      );

      expect(storeMock.set).toHaveBeenCalled();

      const calls = storeMock.set.mock.calls;

      expect(calls).toHaveLength(2);

      expect(calls[0][0]).toBe(
        `${SESSION_ID}:doc:${DOCUMENT_ID}:emb:batch:0`,
      );

      expect(calls[0][1]).toHaveLength(3);

      expect(calls[1][0]).toBe(
        `${SESSION_ID}:doc:${DOCUMENT_ID}:emb:meta`,
      );
    });

    it("stores metadata after batches", async () => {
      const callOrder: string[] = [];

      storeMock.set.mockImplementation(
        async (key: string) => {
          callOrder.push(key);
        },
      );

      await saveEmbeddings(
        SESSION_ID,
        DOCUMENT_ID,
        createResult(),
      );

      expect(callOrder.at(-1)).toBe(
        `${SESSION_ID}:doc:${DOCUMENT_ID}:emb:meta`,
      );
    });

    it("uses the configured TTL", async () => {
      await saveEmbeddings(
        SESSION_ID,
        DOCUMENT_ID,
        createResult(),
        {
          ttlSeconds: 3600,
        },
      );

      for (const call of storeMock.set.mock.calls) {
        expect(call[2]).toBe(3600);
      }
    });

    it("allows TTL to be disabled with zero", async () => {
      await saveEmbeddings(
        SESSION_ID,
        DOCUMENT_ID,
        createResult(),
        {
          ttlSeconds: 0,
        },
      );

      for (const call of storeMock.set.mock.calls) {
        expect(call).toHaveLength(2);
      }
    });

    it("splits embeddings according to batchSize", async () => {
      const result = createResult();

      await saveEmbeddings(
        SESSION_ID,
        DOCUMENT_ID,
        result,
        {
          batchSize: 2,
        },
      );

      const batchCalls =
        storeMock.set.mock.calls.filter(
          ([key]) =>
            String(key).includes(":emb:batch:"),
        );

      expect(batchCalls).toHaveLength(2);

      expect(batchCalls[0][1]).toHaveLength(2);
      expect(batchCalls[1][1]).toHaveLength(1);
    });

    it("stores an empty embedding collection correctly", async () => {
      await saveEmbeddings(
        SESSION_ID,
        DOCUMENT_ID,
        createResult([]),
      );

      expect(storeMock.set).toHaveBeenCalledTimes(1);

      const [key, meta] =
        storeMock.set.mock.calls[0];

      expect(key).toBe(
        `${SESSION_ID}:doc:${DOCUMENT_ID}:emb:meta`,
      );

      expect(meta).toMatchObject({
        embeddingCount: 0,
        batchCount: 0,
      });
    });

    it("rejects an invalid batch size", async () => {
      await expect(
        saveEmbeddings(
          SESSION_ID,
          DOCUMENT_ID,
          createResult(),
          {
            batchSize: 0,
          },
        ),
      ).rejects.toThrow(
        "Batch size must be a positive integer.",
      );

      expect(
        storeMock.set,
      ).not.toHaveBeenCalled();
    });

    it("rejects invalid TTL", async () => {
      await expect(
        saveEmbeddings(
          SESSION_ID,
          DOCUMENT_ID,
          createResult(),
          {
            ttlSeconds: -1,
          },
        ),
      ).rejects.toThrow(
        "TTL must be a non-negative integer.",
      );

      expect(
        storeMock.set,
      ).not.toHaveBeenCalled();
    });

    it("rejects an invalid embedding dimension", async () => {
      const result = createResult([
        {
          ...EMBEDDING_ONE,
          values: [0.1, 0.2],
        },
        EMBEDDING_TWO,
        EMBEDDING_THREE,
      ]);

      await expect(
        saveEmbeddings(
          SESSION_ID,
          DOCUMENT_ID,
          result,
        ),
      ).rejects.toThrow(
        "Embedding dimensions mismatch",
      );
    });

    it("wraps storage failures", async () => {
      storeMock.set.mockRejectedValueOnce(
        new Error("Redis unavailable"),
      );

      await expect(
        saveEmbeddings(
          SESSION_ID,
          DOCUMENT_ID,
          createResult(),
        ),
      ).rejects.toThrow(
        "Failed to save embeddings.",
      );
    });
  });

  // ─── Load ─────────────────────────────────────────────────────────────────

  describe("loadEmbeddings", () => {
    it("returns null when metadata does not exist", async () => {
      storeMock.get.mockResolvedValueOnce(null);

      const result = await loadEmbeddings(
        SESSION_ID,
        DOCUMENT_ID,
      );

      expect(result).toBeNull();

      expect(
        storeMock.get,
      ).toHaveBeenCalledTimes(1);
    });

    it("loads metadata and all embedding batches", async () => {
      storeMock.get
        .mockResolvedValueOnce({
          version: 1,
          model: MODEL,
          dimensions: DIMENSIONS,
          embeddingCount: 3,
          batchCount: 2,
        })
        .mockResolvedValueOnce([
          EMBEDDING_ONE,
          EMBEDDING_TWO,
        ])
        .mockResolvedValueOnce([
          EMBEDDING_THREE,
        ]);

      const result =
        await loadEmbeddings(
          SESSION_ID,
          DOCUMENT_ID,
        );

      expect(result).toEqual({
        embeddings: [
          EMBEDDING_ONE,
          EMBEDDING_TWO,
          EMBEDDING_THREE,
        ],
        model: MODEL,
        dimensions: DIMENSIONS,
      });
    });

    it("loads batches in parallel", async () => {
      storeMock.get
        .mockResolvedValueOnce({
          version: 1,
          model: MODEL,
          dimensions: DIMENSIONS,
          embeddingCount: 2,
          batchCount: 2,
        })
        .mockResolvedValueOnce([
          EMBEDDING_ONE,
        ])
        .mockResolvedValueOnce([
          EMBEDDING_TWO,
        ]);

      await loadEmbeddings(
        SESSION_ID,
        DOCUMENT_ID,
      );

      expect(
        storeMock.get,
      ).toHaveBeenCalledTimes(3);
    });

    it("throws when an embedding batch is missing", async () => {
      storeMock.get
        .mockResolvedValueOnce({
          version: 1,
          model: MODEL,
          dimensions: DIMENSIONS,
          embeddingCount: 2,
          batchCount: 2,
        })
        .mockResolvedValueOnce([
          EMBEDDING_ONE,
        ])
        .mockResolvedValueOnce(null);

      await expect(
        loadEmbeddings(
          SESSION_ID,
          DOCUMENT_ID,
        ),
      ).rejects.toThrow(
        "Embedding batch 1 is missing.",
      );
    });

    it("detects an embedding count mismatch", async () => {
      storeMock.get
        .mockResolvedValueOnce({
          version: 1,
          model: MODEL,
          dimensions: DIMENSIONS,
          embeddingCount: 3,
          batchCount: 1,
        })
        .mockResolvedValueOnce([
          EMBEDDING_ONE,
          EMBEDDING_TWO,
        ]);

      await expect(
        loadEmbeddings(
          SESSION_ID,
          DOCUMENT_ID,
        ),
      ).rejects.toThrow(
        "Embedding count mismatch",
      );
    });

    it("rejects unsupported embedding versions", async () => {
      storeMock.get.mockResolvedValueOnce({
        version: 99,
        model: MODEL,
        dimensions: DIMENSIONS,
        embeddingCount: 0,
        batchCount: 0,
      });

      await expect(
        loadEmbeddings(
          SESSION_ID,
          DOCUMENT_ID,
        ),
      ).rejects.toThrow(
        "Unsupported embedding version: 99",
      );
    });
  });

  // ─── Delete ───────────────────────────────────────────────────────────────

  describe("deleteEmbeddings", () => {
    it("does nothing when metadata does not exist", async () => {
      storeMock.get.mockResolvedValueOnce(null);

      await deleteEmbeddings(
        SESSION_ID,
        DOCUMENT_ID,
      );

      expect(
        storeMock.del,
      ).not.toHaveBeenCalled();
    });

    it("deletes all batches and metadata", async () => {
      storeMock.get.mockResolvedValueOnce({
        version: 1,
        model: MODEL,
        dimensions: DIMENSIONS,
        embeddingCount: 3,
        batchCount: 2,
      });

      await deleteEmbeddings(
        SESSION_ID,
        DOCUMENT_ID,
      );

      expect(
        storeMock.del,
      ).toHaveBeenCalledTimes(3);

      expect(
        storeMock.del,
      ).toHaveBeenCalledWith(
        `${SESSION_ID}:doc:${DOCUMENT_ID}:emb:batch:0`,
      );

      expect(
        storeMock.del,
      ).toHaveBeenCalledWith(
        `${SESSION_ID}:doc:${DOCUMENT_ID}:emb:batch:1`,
      );

      expect(
        storeMock.del,
      ).toHaveBeenCalledWith(
        `${SESSION_ID}:doc:${DOCUMENT_ID}:emb:meta`,
      );
    });
  });

  // ─── Update ───────────────────────────────────────────────────────────────

  describe("updateEmbeddings", () => {
    it("replaces an existing embedding index", async () => {
      storeMock.get.mockResolvedValueOnce({
        version: 1,
        model: MODEL,
        dimensions: DIMENSIONS,
        embeddingCount: 3,
        batchCount: 1,
      });

      await updateEmbeddings(
        SESSION_ID,
        DOCUMENT_ID,
        createResult(),
      );

      expect(
        storeMock.del,
      ).toHaveBeenCalled();

      expect(
        storeMock.set,
      ).toHaveBeenCalled();
    });
  });

  // ─── Exists ───────────────────────────────────────────────────────────────

  describe("hasEmbeddings", () => {
    it("returns true when metadata exists", async () => {
      storeMock.exists.mockResolvedValueOnce(
        true,
      );

      const result =
        await hasEmbeddings(
          SESSION_ID,
          DOCUMENT_ID,
        );

      expect(result).toBe(true);
    });

    it("returns false when metadata does not exist", async () => {
      storeMock.exists.mockResolvedValueOnce(
        false,
      );

      const result =
        await hasEmbeddings(
          SESSION_ID,
          DOCUMENT_ID,
        );

      expect(result).toBe(false);
    });
  });

  // ─── Identifier Validation ───────────────────────────────────────────────

  describe("identifier validation", () => {
    it("rejects unsafe session IDs", async () => {
      await expect(
        hasEmbeddings(
          "session:injection",
          DOCUMENT_ID,
        ),
      ).rejects.toThrow(
        EmbeddingStoreError,
      );

      expect(
        storeMock.exists,
      ).not.toHaveBeenCalled();
    });

    it("rejects unsafe document IDs", async () => {
      await expect(
        hasEmbeddings(
          SESSION_ID,
          "document:injection",
        ),
      ).rejects.toThrow(
        EmbeddingStoreError,
      );

      expect(
        storeMock.exists,
      ).not.toHaveBeenCalled();
    });

    it("accepts normal UUID-like identifiers", async () => {
      storeMock.exists.mockResolvedValueOnce(
        true,
      );

      const result =
        await hasEmbeddings(
          "653d3627-88fa-432e-a90b-ac8bed245d95",
          "document_123",
        );

      expect(result).toBe(true);
    });
  });
});