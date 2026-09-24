import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  hydrateHybridResults,
  hybridSearch,
  reciprocalRankFusion,
  extractParentIds,
  HybridSearchError,
} from "../../src/services/retrieval/hybrid.service.js";

import { BM25Index } from "../../src/services/retrieval/bm25.service.js";

import type { DocumentChunk } from "../../src/services/ingestion/chunk.service.js";

const makeChild = (
  id: string,
  text: string,
  parentId = "parent-1",
): DocumentChunk => ({
  id,
  kind: "child",
  text,
  startOffset: 0,
  endOffset: text.length,
  parentId,
  tokenEstimate: Math.ceil(text.length / 4),
});

describe("reciprocalRankFusion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns BM25-only results", () => {
    const results = reciprocalRankFusion(
      [
        { id: "chunk-1", score: 4 },
        { id: "chunk-2", score: 2 },
      ],
      [],
    );

    expect(results).toHaveLength(2);

    expect(results[0]).toMatchObject({
      id: "chunk-1",
      bm25Rank: 1,
      bm25Score: 4,
      vectorRank: null,
      vectorScore: null,
    });
  });

  it("returns vector-only results", () => {
    const results = reciprocalRankFusion(
      [],
      [
        { id: "chunk-1", score: 0.92 },
        { id: "chunk-2", score: 0.81 },
      ],
    );

    expect(results).toHaveLength(2);

    expect(results[0]).toMatchObject({
      id: "chunk-1",
      vectorRank: 1,
      vectorScore: 0.92,
      bm25Rank: null,
      bm25Score: null,
    });
  });

  it("combines results appearing in both lists", () => {
    const results = reciprocalRankFusion(
      [
        { id: "chunk-1", score: 5 },
      ],
      [
        { id: "chunk-1", score: 0.95 },
      ],
    );

    expect(results).toHaveLength(1);

    expect(results[0]).toMatchObject({
      id: "chunk-1",
      bm25Rank: 1,
      vectorRank: 1,
      bm25Score: 5,
      vectorScore: 0.95,
    });

    expect(results[0].score).toBeCloseTo(
      2 / 61,
    );
  });

  it("ranks documents using combined RRF score", () => {
    const results = reciprocalRankFusion(
      [
        { id: "bm25-only", score: 5 },
        { id: "shared", score: 3 },
      ],
      [
        { id: "shared", score: 0.9 },
        { id: "vector-only", score: 0.8 },
      ],
    );

    expect(results[0].id).toBe("shared");
  });

  it("respects topK", () => {
    const results = reciprocalRankFusion(
      [
        { id: "chunk-1", score: 5 },
        { id: "chunk-2", score: 4 },
        { id: "chunk-3", score: 3 },
      ],
      [],
      {
        topK: 2,
      },
    );

    expect(results).toHaveLength(2);
  });

  it("respects custom rrfK", () => {
    const results = reciprocalRankFusion(
      [
        { id: "chunk-1", score: 5 },
      ],
      [],
      {
        rrfK: 10,
      },
    );

    expect(results[0].score).toBeCloseTo(
      1 / 11,
    );
  });

  it("removes duplicate IDs from BM25 results", () => {
    const results = reciprocalRankFusion(
      [
        { id: "chunk-1", score: 5 },
        { id: "chunk-1", score: 4 },
      ],
      [],
    );

    expect(results).toHaveLength(1);
    expect(results[0].bm25Rank).toBe(1);
  });

  it("removes duplicate IDs from vector results", () => {
    const results = reciprocalRankFusion(
      [],
      [
        { id: "chunk-1", score: 0.9 },
        { id: "chunk-1", score: 0.8 },
      ],
    );

    expect(results).toHaveLength(1);
    expect(results[0].vectorRank).toBe(1);
  });

  it("uses deterministic ID ordering for equal scores", () => {
    const results = reciprocalRankFusion(
      [
        { id: "chunk-b", score: 1 },
      ],
      [
        { id: "chunk-a", score: 1 },
      ],
    );

    expect(results[0].id).toBe("chunk-a");
    expect(results[1].id).toBe("chunk-b");
  });

  it("rejects invalid topK", () => {
    expect(() =>
      reciprocalRankFusion(
        [],
        [],
        { topK: 0 },
      ),
    ).toThrow(HybridSearchError);
  });

  it("rejects invalid rrfK", () => {
    expect(() =>
      reciprocalRankFusion(
        [],
        [],
        { rrfK: 0 },
      ),
    ).toThrow(HybridSearchError);
  });

  it("rejects invalid search result score", () => {
    expect(() =>
      reciprocalRankFusion(
        [
          {
            id: "chunk-1",
            score: Number.NaN,
          },
        ],
        [],
      ),
    ).toThrow(HybridSearchError);
  });
});

describe("hybridSearch", () => {
  function createIndex(): BM25Index {
    const index = new BM25Index();

    index.addDocument(
      makeChild(
        "chunk-1",
        "termination payment obligation",
      ),
    );

    index.addDocument(
      makeChild(
        "chunk-2",
        "confidentiality obligation",
      ),
    );

    return index;
  }

  it("returns hybrid results from BM25 and vector search", () => {
    const index = createIndex();

    const results = hybridSearch(
      index,
      "termination obligation",
      [
        {
          id: "chunk-1",
          score: 0.95,
        },
        {
          id: "chunk-2",
          score: 0.75,
        },
      ],
    );

    expect(results.length).toBeGreaterThan(0);

    expect(
      results.some(
        (result) =>
          result.id === "chunk-1",
      ),
    ).toBe(true);
  });

  it("returns empty results for an empty query", () => {
    const index = createIndex();

    const results = hybridSearch(
      index,
      "   ",
      [],
    );

    expect(results).toEqual([]);
  });

  it("applies minVectorScore", () => {
    const index = createIndex();

    const results = hybridSearch(
      index,
      "obligation",
      [
        {
          id: "chunk-1",
          score: 0.9,
        },
        {
          id: "chunk-2",
          score: 0.2,
        },
      ],
      {
        minVectorScore: 0.5,
      },
    );

    const lowScoreResult =
      results.find(
        (result) =>
          result.id === "chunk-2",
      );

    expect(
      lowScoreResult?.vectorRank,
    ).toBeNull();
  });

  it("applies minBM25Score", () => {
    const index = createIndex();

    const results = hybridSearch(
      index,
      "termination",
      [],
      {
        minBM25Score: 1000,
      },
    );

    expect(results).toEqual([]);
  });

  it("respects topK", () => {
    const index = createIndex();

    const results = hybridSearch(
      index,
      "obligation",
      [
        {
          id: "chunk-1",
          score: 0.9,
        },
        {
          id: "chunk-2",
          score: 0.8,
        },
      ],
      {
        topK: 1,
      },
    );

    expect(results).toHaveLength(1);
  });

  it("rejects invalid minVectorScore", () => {
    const index = createIndex();

    expect(() =>
      hybridSearch(
        index,
        "obligation",
        [],
        {
          minVectorScore: -1,
        },
      ),
    ).toThrow(HybridSearchError);
  });
});

describe("hydrateHybridResults", () => {
  it("hydrates results with matching document chunks", () => {
    const chunks = [
      makeChild(
        "chunk-1",
        "termination clause",
      ),
    ];

    const results = hydrateHybridResults(
      [
        {
          id: "chunk-1",
          score: 0.5,
          bm25Rank: 1,
          vectorRank: 2,
          bm25Score: 3,
          vectorScore: 0.8,
        },
      ],
      chunks,
    );

    expect(results).toHaveLength(1);

    expect(results[0].chunk.id).toBe(
      "chunk-1",
    );

    expect(results[0].chunk.text).toBe(
      "termination clause",
    );
  });

  it("drops results when the chunk cannot be found", () => {
    const results = hydrateHybridResults(
      [
        {
          id: "missing",
          score: 0.5,
          bm25Rank: 1,
          vectorRank: null,
          bm25Score: 2,
          vectorScore: null,
        },
      ],
      [],
    );

    expect(results).toEqual([]);
  });

  it("preserves RRF metadata during hydration", () => {
    const chunks = [
      makeChild(
        "chunk-1",
        "payment obligation",
      ),
    ];

    const results = hydrateHybridResults(
      [
        {
          id: "chunk-1",
          score: 0.25,
          bm25Rank: 1,
          vectorRank: 3,
          bm25Score: 4,
          vectorScore: 0.9,
        },
      ],
      chunks,
    );

    expect(results[0]).toMatchObject({
      id: "chunk-1",
      score: 0.25,
      bm25Rank: 1,
      vectorRank: 3,
      bm25Score: 4,
      vectorScore: 0.9,
    });
  });
});

describe("extractParentIds", () => {
  it("returns unique parent IDs", () => {
    const chunks = [
      makeChild(
        "child-1",
        "first clause",
        "parent-1",
      ),
      makeChild(
        "child-2",
        "second clause",
        "parent-1",
      ),
      makeChild(
        "child-3",
        "third clause",
        "parent-2",
      ),
    ];

    const hydrated =
      hydrateHybridResults(
        [
          {
            id: "child-1",
            score: 0.5,
            bm25Rank: 1,
            vectorRank: 1,
            bm25Score: 3,
            vectorScore: 0.9,
          },
          {
            id: "child-2",
            score: 0.4,
            bm25Rank: 2,
            vectorRank: 2,
            bm25Score: 2,
            vectorScore: 0.8,
          },
          {
            id: "child-3",
            score: 0.3,
            bm25Rank: 3,
            vectorRank: 3,
            bm25Score: 1,
            vectorScore: 0.7,
          },
        ],
        chunks,
      );

    expect(
      extractParentIds(hydrated),
    ).toEqual([
      "parent-1",
      "parent-2",
    ]);
  });

  it("returns an empty array when no parent IDs exist", () => {
    const chunk: DocumentChunk = {
      ...makeChild(
        "child-1",
        "clause",
      ),
      parentId: undefined,
    };

    const hydrated =
      hydrateHybridResults(
        [
          {
            id: "child-1",
            score: 0.5,
            bm25Rank: 1,
            vectorRank: null,
            bm25Score: 2,
            vectorScore: null,
          },
        ],
        [chunk],
      );

    expect(
      extractParentIds(hydrated),
    ).toEqual([]);
  });
});