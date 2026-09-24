import { describe, expect, test } from "vitest";

import {
  isQuoteVerified,
  verifyQuote,
  verifyQuotes,
  QuoteVerificationError,
} from "../../src/services/verification/quote-verifier.service.js";

import type { DocumentChunk } from "../../src/services/ingestion/chunk.service.js";

// ─── Test Data ────────────────────────────────────────────────────────────────

function createChunk(
  overrides: Partial<DocumentChunk> = {},
): DocumentChunk {
  return {
    id: "parent-1-child-1",
    kind: "child",
    parentId: "parent-1",
    text:
      "The employer may terminate this agreement with thirty days written notice.",
    startOffset: 100,
    endOffset: 178,
    tokenEstimate: 14,
    ...overrides,
  };
}

const chunk = createChunk();

const chunks: DocumentChunk[] = [
  chunk,
  createChunk({
    id: "parent-1-child-2",
    text:
      "The employee must return all company property upon termination.",
    startOffset: 179,
    endOffset: 245,
    tokenEstimate: 12,
  }),
];

// ─── Single Quote Verification ───────────────────────────────────────────────

describe("verifyQuote", () => {
  test("verifies an exact quote", () => {
    const result = verifyQuote(
      {
        chunkId: chunk.id,
        quote: "The employer may terminate this agreement",
      },
      chunks,
    );

    expect(result.verified).toBe(true);
    expect(result.status).toBe("verified");
    expect(result.matchedText).toBe(
      "The employer may terminate this agreement",
    );
  });

  test("returns canonical document offsets", () => {
    const quote =
      "The employer may terminate this agreement";

    const result = verifyQuote(
      {
        chunkId: chunk.id,
        quote,
      },
      chunks,
    );

    expect(result.verified).toBe(true);
    expect(result.startOffset).toBe(100);
    expect(result.endOffset).toBe(100 + quote.length);
  });

  test("returns chunk-relative offsets", () => {
    const quote =
      "The employer may terminate this agreement";

    const result = verifyQuote(
      {
        chunkId: chunk.id,
        quote,
      },
      chunks,
    );

    expect(result.chunkStartOffset).toBe(0);
    expect(result.chunkEndOffset).toBe(quote.length);
  });

  test("matches without case sensitivity", () => {
    const result = verifyQuote(
      {
        chunkId: chunk.id,
        quote: "THE EMPLOYER MAY TERMINATE THIS AGREEMENT",
      },
      chunks,
    );

    expect(result.verified).toBe(true);
  });

  test("matches different whitespace", () => {
    const result = verifyQuote(
      {
        chunkId: chunk.id,
        quote:
          "The   employer   may   terminate\nthis agreement",
      },
      chunks,
    );

    expect(result.verified).toBe(true);
  });

  test("matches normalized smart quotes", () => {
    const quoteChunk = createChunk({
      id: "quote-child",
      text:
        'The employer’s "notice" must be written.',
      startOffset: 500,
      endOffset: 545,
    });

    const result = verifyQuote(
      {
        chunkId: quoteChunk.id,
        quote:
          'The employer\'s "notice" must be written.',
      },
      [quoteChunk],
    );

    expect(result.verified).toBe(true);
  });

  test("matches normalized dashes", () => {
    const dashChunk = createChunk({
      id: "dash-child",
      text:
        "This is a party–to–party agreement.",
      startOffset: 600,
      endOffset: 638,
    });

    const result = verifyQuote(
      {
        chunkId: dashChunk.id,
        quote:
          "This is a party-to-party agreement.",
      },
      [dashChunk],
    );

    expect(result.verified).toBe(true);
  });

  test("returns not_found when quote does not exist", () => {
    const result = verifyQuote(
      {
        chunkId: chunk.id,
        quote: "The agreement automatically renews.",
      },
      chunks,
    );

    expect(result.verified).toBe(false);
    expect(result.status).toBe("not_found");
    expect(result.startOffset).toBeNull();
    expect(result.endOffset).toBeNull();
    expect(result.matchedText).toBeNull();
  });

  test("returns source_not_found for unknown chunk", () => {
    const result = verifyQuote(
      {
        chunkId: "does-not-exist",
        quote: "The employer may terminate",
      },
      chunks,
    );

    expect(result.verified).toBe(false);
    expect(result.status).toBe(
      "source_not_found",
    );
  });
});

// ─── Invalid Input ────────────────────────────────────────────────────────────

describe("verifyQuote validation", () => {
  test("rejects empty quote", () => {
    expect(() =>
      verifyQuote(
        {
          chunkId: chunk.id,
          quote: "",
        },
        chunks,
      ),
    ).toThrow(QuoteVerificationError);
  });

  test("rejects extremely short quote", () => {
    expect(() =>
      verifyQuote(
        {
          chunkId: chunk.id,
          quote: "a",
        },
        chunks,
      ),
    ).toThrow(QuoteVerificationError);
  });

  test("rejects missing chunk ID", () => {
    expect(() =>
      verifyQuote(
        {
          chunkId: "",
          quote: "The employer",
        },
        chunks,
      ),
    ).toThrow(QuoteVerificationError);
  });

  test("rejects invalid chunk offsets", () => {
    const invalidChunk = createChunk({
      startOffset: 200,
      endOffset: 100,
    });

    expect(() =>
      verifyQuote(
        {
          chunkId: invalidChunk.id,
          quote: "The employer",
        },
        [invalidChunk],
      ),
    ).toThrow(QuoteVerificationError);
  });
});

// ─── Batch Verification ──────────────────────────────────────────────────────

describe("verifyQuotes", () => {
  test("verifies multiple quotes", () => {
    const results = verifyQuotes(
      [
        {
          chunkId: "parent-1-child-1",
          quote:
            "The employer may terminate this agreement",
        },
        {
          chunkId: "parent-1-child-2",
          quote:
            "The employee must return all company property",
        },
      ],
      chunks,
    );

    expect(results.results).toHaveLength(2);
    expect(results.verifiedCount).toBe(2);
    expect(results.failedCount).toBe(0);
    expect(results.allVerified).toBe(true);
  });

  test("handles mixed verified and unverified quotes", () => {
    const results = verifyQuotes(
      [
        {
          chunkId: "parent-1-child-1",
          quote:
            "The employer may terminate this agreement",
        },
        {
          chunkId: "parent-1-child-1",
          quote:
            "The contract automatically renews every year.",
        },
      ],
      chunks,
    );

    expect(results.verifiedCount).toBe(1);
    expect(results.failedCount).toBe(1);
    expect(results.allVerified).toBe(false);
  });

  test("handles missing source chunks", () => {
    const results = verifyQuotes(
      [
        {
          chunkId: "missing-chunk",
          quote: "Some legal text",
        },
      ],
      chunks,
    );

    expect(results.verifiedCount).toBe(0);
    expect(results.failedCount).toBe(1);
    expect(results.allVerified).toBe(false);
    expect(
      results.results[0]?.status,
    ).toBe("source_not_found");
  });

  test("empty input is not considered fully verified", () => {
    const results = verifyQuotes([], chunks);

    expect(results.results).toHaveLength(0);
    expect(results.verifiedCount).toBe(0);
    expect(results.failedCount).toBe(0);
    expect(results.allVerified).toBe(false);
  });

  test("uses the correct chunk when the same quote exists elsewhere", () => {
    const duplicateChunks = [
      createChunk({
        id: "duplicate-1",
        text:
          "The employer may terminate this agreement.",
        startOffset: 100,
        endOffset: 150,
      }),
      createChunk({
        id: "duplicate-2",
        text:
          "The employer may terminate this agreement.",
        startOffset: 1000,
        endOffset: 1050,
      }),
    ];

    const result = verifyQuote(
      {
        chunkId: "duplicate-2",
        quote:
          "The employer may terminate this agreement",
      },
      duplicateChunks,
    );

    expect(result.verified).toBe(true);
    expect(result.startOffset).toBe(1000);
  });
});

// ─── Convenience Helper ──────────────────────────────────────────────────────

describe("isQuoteVerified", () => {
  test("returns true for a verified quote", () => {
    expect(
      isQuoteVerified(
        "The employer may terminate this agreement",
        chunk.id,
        chunks,
      ),
    ).toBe(true);
  });

  test("returns false for an invalid quote", () => {
    expect(
      isQuoteVerified(
        "This text does not exist",
        chunk.id,
        chunks,
      ),
    ).toBe(false);
  });

  test("returns false when source chunk is missing", () => {
    expect(
      isQuoteVerified(
        "The employer may terminate this agreement",
        "missing",
        chunks,
      ),
    ).toBe(false);
  });
});