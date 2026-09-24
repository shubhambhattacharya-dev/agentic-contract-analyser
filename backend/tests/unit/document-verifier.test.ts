import { describe, expect, it } from "vitest";

import { createDocumentVerifier } from "../../src/services/verification/quote-verifier.service.js";

/*
 * Document-level verifier tests: the runtime path where free-text model
 * quotes are checked against a whole document. Model-supplied pages and
 * offsets are structurally absent from the API — the verifier derives them.
 */

const TEXT = [
  "MASTER SERVICES AGREEMENT",
  "1. TERM. This Agreement begins on 1 January 2026 and continues for 24 months.",
  "2. TERMINATION. Either party may terminate with thirty (30) days written notice.",
].join("\n\n");

const PAGES = [
  { pageNumber: 1, startOffset: 0, endOffset: 26 },
  { pageNumber: 2, startOffset: 28, endOffset: 117 },
  { pageNumber: 3, startOffset: 119, endOffset: 200 },
];

const CHUNKS = [
  { id: "p1", kind: "parent", text: TEXT.slice(0, 26), startOffset: 0, endOffset: 26 },
  { id: "p1-c1", kind: "child", text: TEXT.slice(0, 26), startOffset: 0, endOffset: 26, parentId: "p1" },
  {
    id: "p2-c1",
    kind: "child",
    text: "1. TERM. This Agreement begins on 1 January 2026 and continues for 24 months.",
    startOffset: 28,
    endOffset: 117,
    parentId: "p2",
  },
  {
    id: "p3-c1",
    kind: "child",
    text: "2. TERMINATION. Either party may terminate with thirty (30) days written notice.",
    startOffset: 119,
    endOffset: 200,
    parentId: "p3",
  },
];

function makeVerifier(text = TEXT) {
  return createDocumentVerifier({
    documentId: "doc-1",
    text,
    pages: PAGES,
    chunks: CHUNKS,
  });
}

describe("document-level quote verifier", () => {
  it("V01: verifies a correct quote with canonical offsets, page, chunk, occurrences", () => {
    const result = makeVerifier().verify(
      "This Agreement begins on 1 January 2026 and continues for 24 months.",
    );

    expect(result.verified).toBe(true);
    expect(result.status).toBe("verified");
    expect(result.documentId).toBe("doc-1");
    expect(result.chunkId).toBe("p2-c1");
    expect(result.parentId).toBe("p2");
    expect(TEXT.slice(result.startOffset!, result.endOffset!)).toBe(
      "This Agreement begins on 1 January 2026 and continues for 24 months.",
    );
    expect(result.page).toBe(2);
    expect(result.occurrences).toBe(1);
  });

  it("V02/V08: rejects an invented quote", () => {
    const result = makeVerifier().verify(
      "The Vendor shall pay a penalty of one million dollars per breach.",
    );

    expect(result.verified).toBe(false);
    expect(result.status).toBe("not_found");
    expect(result.startOffset).toBeNull();
  });

  it("V02b: rejects a one-word-changed quote", () => {
    const result = makeVerifier().verify(
      "This Agreement begins on 1 January 2027 and continues for 24 months.",
    );

    expect(result.verified).toBe(false);
  });

  it("V03/V14: verifies across whitespace differences and maps to canonical offsets", () => {
    const result = makeVerifier().verify(
      "This Agreement begins on 1 January 2026\nand continues   for 24 months.",
    );

    expect(result.verified).toBe(true);
    expect(TEXT.slice(result.startOffset!, result.endOffset!)).toBe(
      "This Agreement begins on 1 January 2026 and continues for 24 months.",
    );
  });

  it("V04/V05/V06/V07: smart quotes, dashes, zero-width chars and case are normalized", () => {
    const text = 'The Vendor\u2019s \u201Ccap\u201D of AED 100\u2013000 \u200Bapplies to claims.';
    const verifier = createDocumentVerifier({
      documentId: "doc-1",
      text,
      pages: [{ pageNumber: 1, startOffset: 0, endOffset: text.length }],
      chunks: [{ id: "c1", kind: "child", text, startOffset: 0, endOffset: text.length }],
    });

    const result = verifier.verify("the vendor's \"cap\" of AED 100-000 applies to claims.");

    expect(result.verified).toBe(true);
  });

  it("V09: a quote from another document is NOT verified against this document", () => {
    const result = makeVerifier().verify(
      "The supplier shall maintain insurance coverage of two million dirhams.",
    );

    expect(result.verified).toBe(false);
  });

  it("V13: counts multiple occurrences and offsets point at the first", () => {
    const result = makeVerifier().verify("thirty (30) days");

    expect(result.verified).toBe(true);
    expect(result.occurrences).toBe(1);

    const text = "Pay 100 on signing. Pay 100 on delivery. Pay 100 at the end.";
    const verifier = createDocumentVerifier({
      documentId: "doc-1",
      text,
      pages: [{ pageNumber: 1, startOffset: 0, endOffset: text.length }],
      chunks: [{ id: "c1", kind: "child", text, startOffset: 0, endOffset: text.length }],
    });

    const multi = verifier.verify("Pay 100");

    expect(multi.verified).toBe(true);
    expect(multi.occurrences).toBe(3);
    expect(text.slice(multi.startOffset!, multi.endOffset!)).toBe("Pay 100");
    expect(multi.startOffset).toBe(0);
  });

  it("V11/V12: the API accepts no page or offset from the model — page is always derived", () => {
    const result = makeVerifier().verify("thirty (30) days written notice");

    expect(result.verified).toBe(true);
    expect(result.page).toBe(3);
    expect(typeof result.startOffset).toBe("number");
    expect(typeof result.endOffset).toBe("number");
  });

  it("V15: empty or too-short candidates are rejected, never thrown", () => {
    expect(makeVerifier().verify("").verified).toBe(false);
    expect(makeVerifier().verify("ab").verified).toBe(false);
  });

  it("V17: rejects against an empty document", () => {
    const verifier = createDocumentVerifier({
      documentId: "doc-1",
      text: "   ",
      pages: [],
      chunks: [],
    });

    expect(verifier.verify("anything at all").verified).toBe(false);
  });
});
