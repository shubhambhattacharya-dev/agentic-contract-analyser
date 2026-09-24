import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { DocumentChunk } from "../../src/services/ingestion/chunk.service.js";
import type { BM25Index } from "../../src/services/retrieval/bm25.service.js";
import type { StoredVectorResult } from "../../src/services/retrieval/vector-store.service.js";

const mocks = vi.hoisted(() => ({
  embedQuery: vi.fn(),
  searchVectors: vi.fn(),
  reciprocalRankFusion: vi.fn(),
  loadBM25Index: vi.fn(),
  loadVectorStore: vi.fn(),
}));

vi.mock(
  "../../src/services/retrieval/embedding.service.js",
  () => ({
    embedQuery: mocks.embedQuery,
  }),
);

vi.mock(
  "../../src/services/retrieval/vector-search.service.js",
  () => ({
    searchVectors: mocks.searchVectors,
  }),
);

vi.mock(
  "../../src/services/retrieval/hybrid.service.js",
  () => ({
    reciprocalRankFusion:
      mocks.reciprocalRankFusion,
  }),
);

vi.mock(
  "../../src/services/retrieval/bm25-store.service.js",
  () => ({
    loadBM25Index:
      mocks.loadBM25Index,
  }),
);

vi.mock(
  "../../src/services/retrieval/vector-store.service.js",
  () => ({
    loadVectorStore:
      mocks.loadVectorStore,
  }),
);

vi.mock(
  "../../src/lib/logger.js",
  () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }),
);

import {
  retrieve,
  RetrievalError,
} from "../../src/services/retrieval/retrieval.service.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function createChunk(
  id: string,
  text: string,
  parentId?: string,
): DocumentChunk {
  return {
    id,
    kind: "child",
    text,
    startOffset: 0,
    endOffset: text.length,
    parentId,
    tokenEstimate: Math.ceil(text.length / 4),
  };
}

function createBM25Index(): Pick<
  BM25Index,
  "search"
> {
  return {
    search: vi.fn().mockReturnValue([]),
  };
}

function createVectorStore(): StoredVectorResult {
  return {
    embeddings: [
      {
        chunkId: "parent-1-child-1",
        values: [0.1, 0.2, 0.3],
      },
      {
        chunkId: "parent-1-child-2",
        values: [0.2, 0.3, 0.4],
      },
    ],
    model: "gemini-embedding-2",
    dimensions: 3,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("retrieval.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.embedQuery.mockResolvedValue([
      0.1,
      0.2,
      0.3,
    ]);

    mocks.loadBM25Index.mockResolvedValue(
      createBM25Index(),
    );

    mocks.loadVectorStore.mockResolvedValue(
      createVectorStore(),
    );

    mocks.searchVectors.mockReturnValue([
      {
        id: "parent-1-child-1",
        score: 0.91,
      },
    ]);

    mocks.reciprocalRankFusion.mockReturnValue([
      {
        id: "parent-1-child-1",
        score: 0.032,
        bm25Rank: 1,
        vectorRank: 1,
        bm25Score: 4.5,
        vectorScore: 0.91,
      },
    ]);
  });

  // ── Basic retrieval ───────────────────────────────────────────────────────

  it("retrieves relevant chunks", async () => {
    const chunks = [
      createChunk(
        "parent-1-child-1",
        "The tenant shall pay rent monthly.",
        "parent-1",
      ),
    ];

    const bm25Index =
      await mocks.loadBM25Index.mock.results;

    const result = await retrieve(
      "session-1",
      "document-1",
      "What are the rent payment terms?",
      chunks,
    );

    expect(result.query).toBe(
      "What are the rent payment terms?",
    );

    expect(result.results).toHaveLength(1);

    expect(
      result.results[0]?.chunk.id,
    ).toBe(
      "parent-1-child-1",
    );

    expect(result.bm25Count).toBe(0);
    expect(result.vectorCount).toBe(1);
    expect(result.retrievedCount).toBe(1);

    expect(
      mocks.embedQuery,
    ).toHaveBeenCalledWith(
      "What are the rent payment terms?",
    );

    expect(bm25Index).toBeDefined();
  });

  // ── Query validation ──────────────────────────────────────────────────────

  it("rejects an empty query", async () => {
    await expect(
      retrieve(
        "session-1",
        "document-1",
        "   ",
        [],
      ),
    ).rejects.toThrow(
      "Retrieval query cannot be empty.",
    );

    expect(
      mocks.loadBM25Index,
    ).not.toHaveBeenCalled();

    expect(
      mocks.loadVectorStore,
    ).not.toHaveBeenCalled();
  });

  it("rejects a non-string query", async () => {
    await expect(
      retrieve(
        "session-1",
        "document-1",
        null as unknown as string,
        [],
      ),
    ).rejects.toThrow(
      "Retrieval query must be a string.",
    );
  });

  // ── Empty chunks ───────────────────────────────────────────────────────────

  it("returns an empty response when there are no chunks", async () => {
    const result = await retrieve(
      "session-1",
      "document-1",
      "find payment terms",
      [],
    );

    expect(result.results).toEqual([]);
    expect(result.bm25Count).toBe(0);
    expect(result.vectorCount).toBe(0);
    expect(result.retrievedCount).toBe(0);

    expect(
      mocks.loadBM25Index,
    ).not.toHaveBeenCalled();

    expect(
      mocks.loadVectorStore,
    ).not.toHaveBeenCalled();

    expect(
      mocks.embedQuery,
    ).not.toHaveBeenCalled();
  });

  // ── BM25 ──────────────────────────────────────────────────────────────────

  it("passes retrieval options to BM25 search", async () => {
    const bm25Index =
      createBM25Index();

    const searchMock =
      bm25Index.search as ReturnType<
        typeof vi.fn
      >;

    searchMock.mockReturnValue([
      {
        id: "parent-1-child-1",
        score: 5.2,
      },
    ]);

    mocks.loadBM25Index.mockResolvedValue(
      bm25Index,
    );

    mocks.reciprocalRankFusion.mockReturnValue(
      [],
    );

    const chunks = [
      createChunk(
        "parent-1-child-1",
        "Payment must be made within ten days.",
      ),
    ];

    await retrieve(
      "session-1",
      "document-1",
      "payment deadline",
      chunks,
      {
        topK: 10,
        rrfK: 50,
        minBM25Score: 1.5,
        minVectorScore: 0.4,
      },
    );

    expect(searchMock).toHaveBeenCalledWith(
      "payment deadline",
      {
        topK: 10,
        minScore: 1.5,
      },
    );
  });

  // ── Embedding ─────────────────────────────────────────────────────────────

  it("creates a query embedding before vector search", async () => {
    const chunks = [
      createChunk(
        "parent-1-child-1",
        "The agreement expires on December 31.",
      ),
    ];

    await retrieve(
      "session-1",
      "document-1",
      "When does the agreement expire?",
      chunks,
    );

    expect(
      mocks.embedQuery,
    ).toHaveBeenCalledTimes(1);

    expect(
      mocks.searchVectors,
    ).toHaveBeenCalledWith(
      [0.1, 0.2, 0.3],
      expect.any(Array),
      expect.objectContaining({
        topK: 15,
        minScore: 0,
      }),
    );
  });

  // ── Vector filtering options ──────────────────────────────────────────────

  it("passes vector score threshold to vector search", async () => {
    const chunks = [
      createChunk(
        "parent-1-child-1",
        "Confidentiality obligations survive termination.",
      ),
    ];

    await retrieve(
      "session-1",
      "document-1",
      "confidentiality after termination",
      chunks,
      {
        minVectorScore: 0.75,
      },
    );

    expect(
      mocks.searchVectors,
    ).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      {
        topK: 15,
        minScore: 0.75,
      },
    );
  });

  // ── RRF ───────────────────────────────────────────────────────────────────

  it("combines BM25 and vector results with RRF", async () => {
    const chunks = [
      createChunk(
        "parent-1-child-1",
        "The customer shall pay the invoice.",
      ),
    ];

    const bm25Results = [
      {
        id: "parent-1-child-1",
        score: 5,
      },
    ];

    const vectorResults = [
      {
        id: "parent-1-child-1",
        score: 0.92,
      },
    ];

    const fusedResults = [
      {
        id: "parent-1-child-1",
        score: 0.032,
        bm25Rank: 1,
        vectorRank: 1,
        bm25Score: 5,
        vectorScore: 0.92,
      },
    ];

    const bm25Index =
      createBM25Index();

    (
      bm25Index.search as ReturnType<
        typeof vi.fn
      >
    ).mockReturnValue(
      bm25Results,
    );

    mocks.loadBM25Index.mockResolvedValue(
      bm25Index,
    );

    mocks.searchVectors.mockReturnValue(
      vectorResults,
    );

    mocks.reciprocalRankFusion.mockReturnValue(
      fusedResults,
    );

    const result = await retrieve(
      "session-1",
      "document-1",
      "invoice payment",
      chunks,
    );

    expect(
      mocks.reciprocalRankFusion,
    ).toHaveBeenCalledWith(
      bm25Results,
      vectorResults,
      {
        topK: 15,
        rrfK: 60,
      },
    );

    expect(result.results).toHaveLength(1);
  });

  // ── Hydration ──────────────────────────────────────────────────────────────

  it("hydrates fused results with their document chunks", async () => {
    const chunks = [
      createChunk(
        "parent-1-child-1",
        "The notice period is thirty days.",
        "parent-1",
      ),
    ];

    mocks.reciprocalRankFusion.mockReturnValue([
      {
        id: "parent-1-child-1",
        score: 0.03,
        bm25Rank: 1,
        vectorRank: 1,
        bm25Score: 3,
        vectorScore: 0.9,
      },
    ]);

    const result = await retrieve(
      "session-1",
      "document-1",
      "notice period",
      chunks,
    );

    expect(
      result.results[0]?.chunk.text,
    ).toBe(
      "The notice period is thirty days.",
    );

    expect(
      result.results[0]?.chunk.parentId,
    ).toBe("parent-1");
  });

  // ── Missing chunk ─────────────────────────────────────────────────────────

  it("drops a fused result when its chunk cannot be hydrated", async () => {
    const chunks = [
      createChunk(
        "different-child",
        "Different text.",
      ),
    ];

    mocks.reciprocalRankFusion.mockReturnValue([
      {
        id: "missing-child",
        score: 0.03,
        bm25Rank: 1,
        vectorRank: 1,
        bm25Score: 2,
        vectorScore: 0.8,
      },
    ]);

    const result = await retrieve(
      "session-1",
      "document-1",
      "missing clause",
      chunks,
    );

    expect(result.results).toEqual([]);
    expect(result.retrievedCount).toBe(0);
  });

  // ── Missing BM25 index ────────────────────────────────────────────────────

  it("throws when the BM25 index is missing", async () => {
    mocks.loadBM25Index.mockResolvedValue(
      null,
    );

    await expect(
      retrieve(
        "session-1",
        "document-1",
        "payment terms",
        [
          createChunk(
            "child-1",
            "Payment terms.",
          ),
        ],
      ),
    ).rejects.toThrow(
      "BM25 index is not available for this document.",
    );

    expect(
      mocks.embedQuery,
    ).not.toHaveBeenCalled();
  });

  // ── Missing vector store ──────────────────────────────────────────────────

  it("throws when the vector store is missing", async () => {
    mocks.loadVectorStore.mockResolvedValue(
      null,
    );

    await expect(
      retrieve(
        "session-1",
        "document-1",
        "payment terms",
        [
          createChunk(
            "child-1",
            "Payment terms.",
          ),
        ],
      ),
    ).rejects.toThrow(
      "Vector store is not available for this document.",
    );

    expect(
      mocks.embedQuery,
    ).not.toHaveBeenCalled();
  });

  // ── Invalid options ───────────────────────────────────────────────────────

  it("rejects invalid topK", async () => {
    await expect(
      retrieve(
        "session-1",
        "document-1",
        "payment",
        [
          createChunk(
            "child-1",
            "Payment terms.",
          ),
        ],
        {
          topK: 0,
        },
      ),
    ).rejects.toThrow(
      "topK must be a positive integer.",
    );
  });

  it("rejects invalid rrfK", async () => {
    await expect(
      retrieve(
        "session-1",
        "document-1",
        "payment",
        [
          createChunk(
            "child-1",
            "Payment terms.",
          ),
        ],
        {
          rrfK: -1,
        },
      ),
    ).rejects.toThrow(
      "rrfK must be a positive integer.",
    );
  });

  it("rejects non-finite BM25 score threshold", async () => {
    await expect(
      retrieve(
        "session-1",
        "document-1",
        "payment",
        [
          createChunk(
            "child-1",
            "Payment terms.",
          ),
        ],
        {
          minBM25Score: Number.NaN,
        },
      ),
    ).rejects.toThrow(
      "minBM25Score must be a finite number.",
    );
  });

  it("rejects non-finite vector score threshold", async () => {
    await expect(
      retrieve(
        "session-1",
        "document-1",
        "payment",
        [
          createChunk(
            "child-1",
            "Payment terms.",
          ),
        ],
        {
          minVectorScore: Number.POSITIVE_INFINITY,
        },
      ),
    ).rejects.toThrow(
      "minVectorScore must be a finite number.",
    );
  });

  // ── Error wrapping ────────────────────────────────────────────────────────

  it("wraps unexpected dependency errors", async () => {
    mocks.loadBM25Index.mockRejectedValue(
      new Error("Redis connection failed"),
    );

    await expect(
      retrieve(
        "session-1",
        "document-1",
        "payment",
        [
          createChunk(
            "child-1",
            "Payment terms.",
          ),
        ],
      ),
    ).rejects.toBeInstanceOf(
      RetrievalError,
    );

    await expect(
      retrieve(
        "session-1",
        "document-1",
        "payment",
        [
          createChunk(
            "child-1",
            "Payment terms.",
          ),
        ],
      ),
    ).rejects.toThrow(
      "Failed to retrieve relevant document chunks.",
    );
  });

  it("preserves RetrievalError without wrapping it", async () => {
    mocks.loadBM25Index.mockRejectedValue(
      new RetrievalError(
        "BM25 unavailable",
      ),
    );

    try {
      await retrieve(
        "session-1",
        "document-1",
        "payment",
        [
          createChunk(
            "child-1",
            "Payment terms.",
          ),
        ],
      );

      throw new Error(
        "Expected retrieve() to throw.",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(
        RetrievalError,
      );

      expect(
        (error as RetrievalError).message,
      ).toBe(
        "BM25 unavailable",
      );
    }
  });
});