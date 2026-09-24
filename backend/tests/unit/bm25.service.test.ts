import {
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  BM25Index,
  buildBM25Index,
} from "../../src/services/retrieval/bm25.service.js";

import type { DocumentChunk } from "../../src/services/ingestion/chunk.service.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function createChild(
  id: string,
  text: string,
  parentId = "parent-1",
): DocumentChunk {
  return {
    id,
    kind: "child",
    parentId,
    text,
    startOffset: 0,
    endOffset: text.length,
    tokenEstimate: Math.ceil(text.length / 4),
  };
}

function createParent(
  id: string,
  text: string,
): DocumentChunk {
  return {
    id,
    kind: "parent",
    text,
    startOffset: 0,
    endOffset: text.length,
    tokenEstimate: Math.ceil(text.length / 4),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BM25Index", () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
  });

  // ── Basic Indexing ────────────────────────────────────────────────────────

  describe("indexing", () => {
    it("starts empty", () => {
      expect(index.documentCount).toBe(0);
      expect(index.averageDocumentLength).toBe(0);
    });

    it("indexes child chunks", () => {
      index.addDocument(
        createChild(
          "parent-1-child-1",
          "The tenant shall pay rent monthly.",
        ),
      );

      expect(index.documentCount).toBe(1);
      expect(index.has("parent-1-child-1")).toBe(true);
    });

    it("ignores parent chunks", () => {
      index.addDocument(
        createParent(
          "parent-1",
          "The tenant shall pay rent monthly.",
        ),
      );

      expect(index.documentCount).toBe(0);
      expect(index.has("parent-1")).toBe(false);
    });

    it("ignores empty child chunks", () => {
      index.addDocument(
        createChild("parent-1-child-1", ""),
      );

      expect(index.documentCount).toBe(0);
    });

    it("indexes multiple child chunks", () => {
      index.addDocuments([
        createChild(
          "parent-1-child-1",
          "The tenant shall pay rent.",
        ),
        createChild(
          "parent-1-child-2",
          "The landlord may terminate the agreement.",
        ),
      ]);

      expect(index.documentCount).toBe(2);
    });
  });

  // ── Search ────────────────────────────────────────────────────────────────

  describe("search", () => {
    beforeEach(() => {
      index.addDocuments([
        createChild(
          "parent-1-child-1",
          "The tenant shall pay rent every month.",
        ),
        createChild(
          "parent-1-child-2",
          "The landlord may terminate the lease.",
        ),
        createChild(
          "parent-1-child-3",
          "The tenant shall maintain the property.",
        ),
      ]);
    });

    it("returns relevant chunks for an exact term", () => {
      const results = index.search("tenant");

      expect(results.length).toBeGreaterThan(0);

      expect(
        results.map((result) => result.id),
      ).toContain("parent-1-child-1");
    });

    it("ranks matching documents above non-matching documents", () => {
      const results = index.search(
        "tenant rent",
      );

      expect(results.length).toBeGreaterThan(0);

      expect(results[0]?.id).toBe(
        "parent-1-child-1",
      );
    });

    it("returns scores greater than zero", () => {
      const results = index.search("tenant");

      expect(results.length).toBeGreaterThan(0);

      for (const result of results) {
        expect(result.score).toBeGreaterThan(0);
      }
    });

    it("returns results sorted by descending score", () => {
      const results = index.search(
        "tenant",
      );

      for (
        let i = 1;
        i < results.length;
        i += 1
      ) {
        const previous = results[i - 1];
        const current = results[i];

        if (previous && current) {
          expect(previous.score).toBeGreaterThanOrEqual(
            current.score,
          );
        }
      }
    });

    it("respects topK", () => {
      const results = index.search(
        "tenant",
        { topK: 1 },
      );

      expect(results).toHaveLength(1);
    });

    it("returns no results for an unknown term", () => {
      const results = index.search(
        "completelyunknownlegalterm",
      );

      expect(results).toEqual([]);
    });

    it("returns no results for an empty query", () => {
      expect(index.search("")).toEqual([]);
    });

    it("supports minimum score filtering", () => {
      const results = index.search(
        "tenant",
        { minScore: Number.MAX_SAFE_INTEGER },
      );

      expect(results).toEqual([]);
    });

    it("deduplicates repeated query terms", () => {
      const single = index.search(
        "tenant",
      );

      const repeated = index.search(
        "tenant tenant tenant",
      );

      expect(repeated).toEqual(single);
    });
  });

  // ── Document Management ──────────────────────────────────────────────────

  describe("document management", () => {
    it("has() returns true for an indexed document", () => {
      index.addDocument(
        createChild(
          "parent-1-child-1",
          "The tenant shall pay rent.",
        ),
      );

      expect(
        index.has("parent-1-child-1"),
      ).toBe(true);
    });

    it("has() returns false for an unknown document", () => {
      expect(
        index.has("does-not-exist"),
      ).toBe(false);
    });

    it("removes an indexed document", () => {
      index.addDocument(
        createChild(
          "parent-1-child-1",
          "The tenant shall pay rent.",
        ),
      );

      expect(
        index.removeDocument(
          "parent-1-child-1",
        ),
      ).toBe(true);

      expect(index.documentCount).toBe(0);
      expect(
        index.has("parent-1-child-1"),
      ).toBe(false);
    });

    it("returns false when removing an unknown document", () => {
      expect(
        index.removeDocument(
          "does-not-exist",
        ),
      ).toBe(false);
    });

    it("clears the entire index", () => {
      index.addDocuments([
        createChild(
          "parent-1-child-1",
          "The tenant shall pay rent.",
        ),
        createChild(
          "parent-1-child-2",
          "The landlord may terminate.",
        ),
      ]);

      index.clear();

      expect(index.documentCount).toBe(0);
      expect(index.averageDocumentLength).toBe(0);
      expect(
        index.search("tenant"),
      ).toEqual([]);
    });

    it("replaces an existing document when indexed again", () => {
      index.addDocument(
        createChild(
          "parent-1-child-1",
          "The tenant shall pay rent.",
        ),
      );

      index.addDocument(
        createChild(
          "parent-1-child-1",
          "The landlord may terminate.",
        ),
      );

      expect(index.documentCount).toBe(1);

      expect(
        index.search("landlord"),
      ).toHaveLength(1);

      expect(
        index.search("tenant"),
      ).toEqual([]);
    });
  });

  // ── Statistics ────────────────────────────────────────────────────────────

  describe("statistics", () => {
    it("calculates average document length", () => {
      const first = createChild(
        "parent-1-child-1",
        "one two three four",
      );

      const second = createChild(
        "parent-1-child-2",
        "one two",
      );

      index.addDocuments([
        first,
        second,
      ]);

      expect(
        index.averageDocumentLength,
      ).toBeGreaterThan(0);
    });
  });

  // ── Validation ───────────────────────────────────────────────────────────

  describe("validation", () => {
    it("rejects invalid k1", () => {
      expect(
        () =>
          new BM25Index({
            k1: 0,
          }),
      ).toThrow(
        "BM25 k1 must be greater than zero.",
      );
    });

    it("rejects negative b", () => {
      expect(
        () =>
          new BM25Index({
            b: -1,
          }),
      ).toThrow(
        "BM25 b must be between 0 and 1.",
      );
    });

    it("rejects b greater than one", () => {
      expect(
        () =>
          new BM25Index({
            b: 2,
          }),
      ).toThrow(
        "BM25 b must be between 0 and 1.",
      );
    });

    it("rejects invalid topK", () => {
      expect(() =>
        index.search("tenant", {
          topK: 0,
        }),
      ).toThrow(
        "BM25 topK must be a positive integer.",
      );
    });

    it("rejects non-integer topK", () => {
      expect(() =>
        index.search("tenant", {
          topK: 1.5,
        }),
      ).toThrow(
        "BM25 topK must be a positive integer.",
      );
    });

    it("rejects negative minimum score", () => {
      expect(() =>
        index.search("tenant", {
          minScore: -1,
        }),
      ).toThrow(
        "BM25 minScore must be a non-negative number.",
      );
    });
  });

  // ── Serialization ────────────────────────────────────────────────────────

  describe("serialization", () => {
    it("serializes the index", () => {
      index.addDocuments([
        createChild(
          "parent-1-child-1",
          "The tenant shall pay rent.",
        ),
        createChild(
          "parent-1-child-2",
          "The landlord may terminate.",
        ),
      ]);

      const serialized =
        index.serialize();

      expect(serialized).toEqual(
        expect.any(String),
      );

      expect(serialized.length).toBeGreaterThan(
        0,
      );
    });

    it("restores an index from serialized data", () => {
      index.addDocuments([
        createChild(
          "parent-1-child-1",
          "The tenant shall pay rent.",
        ),
        createChild(
          "parent-1-child-2",
          "The landlord may terminate.",
        ),
      ]);

      const restored =
        BM25Index.deserialize(
          index.serialize(),
        );

      expect(
        restored.documentCount,
      ).toBe(index.documentCount);

      expect(
        restored.averageDocumentLength,
      ).toBe(
        index.averageDocumentLength,
      );
    });

    it("preserves search results after serialization", () => {
      index.addDocuments([
        createChild(
          "parent-1-child-1",
          "The tenant shall pay rent.",
        ),
        createChild(
          "parent-1-child-2",
          "The landlord may terminate.",
        ),
      ]);

      const originalResults =
        index.search("tenant");

      const restored =
        BM25Index.deserialize(
          index.serialize(),
        );

      const restoredResults =
        restored.search("tenant");

      expect(restoredResults).toEqual(
        originalResults,
      );
    });

    it("rejects an unsupported index version", () => {
      expect(() =>
        BM25Index.fromJSON({
          version: 99 as 1,
          k1: 1.5,
          b: 0.75,
          documentCount: 0,
          averageDocumentLength: 0,
          documents: [],
          documentFrequency: {},
        }),
      ).toThrow(
        "Unsupported BM25 index version: 99",
      );
    });

    it("rejects invalid serialized JSON", () => {
      expect(() =>
        BM25Index.deserialize(
          "not-valid-json",
        ),
      ).toThrow(
        "Invalid serialized BM25 index.",
      );
    });
  });
});

// ─── Builder Tests ───────────────────────────────────────────────────────────

describe("buildBM25Index", () => {
  it("indexes only child chunks", () => {
    const chunks: DocumentChunk[] = [
      createParent(
        "parent-1",
        "The tenant shall pay rent.",
      ),
      createChild(
        "parent-1-child-1",
        "The tenant shall pay rent.",
      ),
      createChild(
        "parent-1-child-2",
        "The landlord may terminate.",
      ),
    ];

    const index =
      buildBM25Index(chunks);

    expect(index.documentCount).toBe(2);

    expect(
      index.has("parent-1"),
    ).toBe(false);

    expect(
      index.has("parent-1-child-1"),
    ).toBe(true);

    expect(
      index.has("parent-1-child-2"),
    ).toBe(true);
  });

  it("handles an empty chunk list", () => {
    const index =
      buildBM25Index([]);

    expect(index.documentCount).toBe(0);
    expect(
      index.search("tenant"),
    ).toEqual([]);
  });
});