import {
  describe,
  expect,
  it,
} from "vitest";

import {
  cosineSimilarity,
  searchVectors,
  VectorSearchError,
} from "../../src/services/retrieval/vector-search.service.js";

import type { EmbeddingVector } from "../../src/services/retrieval/embedding.service.js";

describe("vector-search.service", () => {
  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      const score = cosineSimilarity(
        [1, 2, 3],
        [1, 2, 3],
      );

      expect(score).toBeCloseTo(1, 10);
    });

    it("returns 0 for orthogonal vectors", () => {
      const score = cosineSimilarity(
        [1, 0],
        [0, 1],
      );

      expect(score).toBeCloseTo(0, 10);
    });

    it("returns -1 for opposite vectors", () => {
      const score = cosineSimilarity(
        [1, 0],
        [-1, 0],
      );

      expect(score).toBeCloseTo(-1, 10);
    });

    it("is independent of vector magnitude", () => {
      const score = cosineSimilarity(
        [1, 2],
        [10, 20],
      );

      expect(score).toBeCloseTo(1, 10);
    });

    it("throws for different dimensions", () => {
      expect(() =>
        cosineSimilarity(
          [1, 2],
          [1, 2, 3],
        ),
      ).toThrow(VectorSearchError);
    });

    it("throws for an empty vector", () => {
      expect(() =>
        cosineSimilarity([], []),
      ).toThrow(VectorSearchError);
    });

    it("throws for non-finite vector values", () => {
      expect(() =>
        cosineSimilarity(
          [1, Number.NaN],
          [1, 2],
        ),
      ).toThrow(VectorSearchError);
    });

    it("returns zero for zero-magnitude vectors", () => {
      const score = cosineSimilarity(
        [0, 0],
        [1, 2],
      );

      expect(score).toBe(0);
    });
  });

  describe("searchVectors", () => {
    const embeddings: EmbeddingVector[] = [
      {
        chunkId: "chunk-1",
        values: [1, 0, 0],
      },
      {
        chunkId: "chunk-2",
        values: [0, 1, 0],
      },
      {
        chunkId: "chunk-3",
        values: [1, 1, 0],
      },
      {
        chunkId: "chunk-4",
        values: [-1, 0, 0],
      },
    ];

    it("returns an empty array when there are no embeddings", () => {
      const results = searchVectors(
        [1, 0, 0],
        [],
      );

      expect(results).toEqual([]);
    });

    it("ranks the most similar vector first", () => {
      const results = searchVectors(
        [1, 0, 0],
        embeddings,
      );

      expect(results[0]).toMatchObject({
        id: "chunk-1",
        score: expect.closeTo(1, 10),
      });
    });

    it("returns results in descending score order", () => {
      const results = searchVectors(
        [1, 0, 0],
        embeddings,
      );

      for (let i = 1; i < results.length; i += 1) {
        expect(results[i - 1]!.score)
          .toBeGreaterThanOrEqual(results[i]!.score);
      }
    });

    it("respects topK", () => {
      const results = searchVectors(
        [1, 0, 0],
        embeddings,
        {
          topK: 2,
        },
      );

      expect(results).toHaveLength(2);
    });

    it("respects minScore", () => {
      const results = searchVectors(
        [1, 0, 0],
        embeddings,
        {
          minScore: 0.9,
        },
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("chunk-1");
    });

    it("uses deterministic ID ordering for equal scores", () => {
      const equalEmbeddings: EmbeddingVector[] = [
        {
          chunkId: "chunk-b",
          values: [1, 0],
        },
        {
          chunkId: "chunk-a",
          values: [1, 0],
        },
      ];

      const results = searchVectors(
        [1, 0],
        equalEmbeddings,
      );

      expect(results.map((result) => result.id))
        .toEqual([
          "chunk-a",
          "chunk-b",
        ]);
    });

    it("throws when query vector is empty", () => {
      expect(() =>
        searchVectors(
          [],
          embeddings,
        ),
      ).toThrow(VectorSearchError);
    });

    it("throws when query vector has zero magnitude", () => {
      expect(() =>
        searchVectors(
          [0, 0, 0],
          embeddings,
        ),
      ).toThrow(VectorSearchError);
    });

    it("throws when an embedding has the wrong dimension", () => {
      const invalidEmbeddings: EmbeddingVector[] = [
        {
          chunkId: "bad-chunk",
          values: [1, 2],
        },
      ];

      expect(() =>
        searchVectors(
          [1, 0, 0],
          invalidEmbeddings,
        ),
      ).toThrow(
        "Dimension mismatch for chunk bad-chunk",
      );
    });

    it("skips zero-magnitude stored embeddings", () => {
      const zeroEmbedding: EmbeddingVector[] = [
        {
          chunkId: "zero",
          values: [0, 0, 0],
        },
        {
          chunkId: "valid",
          values: [1, 0, 0],
        },
      ];

      const results = searchVectors(
        [1, 0, 0],
        zeroEmbedding,
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("valid");
    });

    it("throws for an invalid topK", () => {
      expect(() =>
        searchVectors(
          [1, 0, 0],
          embeddings,
          { topK: 0 },
        ),
      ).toThrow(VectorSearchError);
    });

    it("throws for an invalid minScore", () => {
      expect(() =>
        searchVectors(
          [1, 0, 0],
          embeddings,
          { minScore: 2 },
        ),
      ).toThrow(VectorSearchError);
    });
  });
});