import { describe, expect, it } from "vitest";

import { chunkDocument } from "../../src/services/ingestion/chunk.service.js";
import type { ExtractedDocument } from "../../src/types/document.types.js";

function doc(text: string): ExtractedDocument {
  return {
    text,
    pages: [{ pageNumber: 1, startOffset: 0, endOffset: text.length }],
    pageCount: 1,
    isScanned: false,
    mimeType: "application/pdf",
    extension: "pdf",
    charCount: text.length,
    wordCount: 0,
    extractedAt: new Date().toISOString(),
  };
}

function assertInvariants(text: string, result: ReturnType<typeof chunkDocument>) {
  for (const chunk of result.all) {
    expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
    expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
    expect(chunk.endOffset).toBeLessThanOrEqual(text.length);
    expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
  }
  for (const child of result.children) {
    const parent = result.parents.find((p) => p.id === child.parentId);
    expect(parent).toBeDefined();
    expect(child.startOffset).toBeGreaterThanOrEqual(parent!.startOffset);
    expect(child.endOffset).toBeLessThanOrEqual(parent!.endOffset);
  }
}

describe("chunker hardening (real-world text)", () => {
  it("P0: survives an 8000-char single token (base64/URL blob) and keeps children within limits", () => {
    const blob = "a".repeat(8000);
    const text = `Header text here.\n\nDATA_FIELD ${blob} end of field.\n\nFooter.`;
    const result = chunkDocument(doc(text));

    expect(result.parents.length).toBeGreaterThan(0);
    for (const child of result.children) {
      expect(child.tokenEstimate).toBeLessThanOrEqual(200);
    }
    assertInvariants(text, result);
  });

  it("GOLDEN: resume-style text with email, phone, URL, ₹, %, bullets, no periods", () => {
    const text = [
      "SHUBHAM BHATTACHARYA",
      "AI ENGINEER — Vadodara, India · +91-9155252394 · shubhambhattacharya107@gmail.com",
      "github.com/shubhambhattacharya-dev · linkedin.com/in/shubham",
      "EXPERIENCE",
      "• Built an agentic contract analyser with verified quotes (2026)",
      "• Reduced retrieval latency by 40% using RRF fusion — 15% cost cut",
      "SKILLS",
      "Python TypeScript Redis BM25 embeddings ₹35,000/month 15% margin",
      "Section 12.1(a) — the non-breaching party may terminate on thirty (30) days notice.",
    ].join("\n");
    const result = chunkDocument(doc(text));
    expect(result.children.length).toBeGreaterThan(0);
    assertInvariants(text, result);
  });

  it("GOLDEN: legal punctuation, smart quotes, dashes, currency, percentages, quoted text", () => {
    const text =
      "4. LIMITATION OF LIABILITY. The aggregate liability shall not exceed AED 1,000,000 (15% of fees).\n\n" +
      "5. TERMINATION. \u201CEither party may terminate this Agreement\u201D on thirty (30) days\u2019 written notice — without prejudice to accrued rights; see §5.2 and https://example.com/terms?x=1&y=2.";
    const result = chunkDocument(doc(text));
    expect(result.children.length).toBeGreaterThan(0);
    assertInvariants(text, result);
  });

  it("GOLDEN: table-as-text and empty lines", () => {
    const text = "Item\tQty\tPrice\nWidget\t12\t₹1,500\n\n\nGadget\t3\tAED 99.50\n";
    const result = chunkDocument(doc(text));
    expect(result.children.length).toBeGreaterThan(0);
    assertInvariants(text, result);
  });

  it("GOLDEN: unicode and zero-width characters survive with valid offsets", () => {
    const text = "Café résumé — naïve ﬁle \u200Bhidden\u200B emoji 📄 end.";
    const result = chunkDocument(doc(text));
    assertInvariants(text, result);
  });
});
