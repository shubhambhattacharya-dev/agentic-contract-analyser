import { describe, expect, it } from "vitest";

import type {
  ExtractedDocument,
  SupportedDocumentMimeType,
} from "../../src/types/document.types.js";

import {
  chunkDocument,
  DocumentChunkingError,
} from "../../src/services/ingestion/chunk.service.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const PDF_MIME =
  "application/pdf" as const satisfies SupportedDocumentMimeType;

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const satisfies SupportedDocumentMimeType;

const FIXED_TIMESTAMP =
  "2024-01-01T00:00:00.000Z" as const;

// ─── Test Helpers ────────────────────────────────────────────────────────────

function countWords(text: string): number {
  const trimmed = text.trim();

  return trimmed.length === 0
    ? 0
    : trimmed.split(/\s+/u).length;
}

function createDocument(
  text: string,
  overrides: Partial<ExtractedDocument> = {},
): ExtractedDocument {
  const words = countWords(text);

  return {
    text,
    pages: [
      {
        pageNumber: 1,
        text,
        startOffset: 0,
        endOffset: text.length,
        wordCount: words,
      },
    ],
    pageCount: 1,
    isScanned: false,
    mimeType: PDF_MIME,
    extension: "pdf",
    charCount: text.length,
    wordCount: words,
    extractedAt: FIXED_TIMESTAMP,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("chunkDocument", () => {
  // ── Input Handling ──────────────────────────────────────────────────────────

  describe("input handling", () => {
    it("throws DocumentChunkingError when document is missing", () => {
      expect(() =>
        chunkDocument(
          undefined as unknown as ExtractedDocument,
        ),
      ).toThrow(DocumentChunkingError);
    });

    it("throws DocumentChunkingError when document is null", () => {
      expect(() =>
        chunkDocument(
          null as unknown as ExtractedDocument,
        ),
      ).toThrow(DocumentChunkingError);
    });

    it("returns an empty result when document text is empty", () => {
      const result = chunkDocument(
        createDocument(""),
      );

      expect(result).toEqual({
        parents: [],
        children: [],
        all: [],
      });
    });

    it("returns an empty result when document text is whitespace only", () => {
      const result = chunkDocument(
        createDocument("   \n\n  "),
      );

      expect(result).toEqual({
        parents: [],
        children: [],
        all: [],
      });
    });
  });

  // ── Scanned Documents ───────────────────────────────────────────────────────

  describe("scanned documents", () => {
    it("returns no chunks for a scanned document", () => {
      const document = createDocument("", {
        isScanned: true,
        pages: [
          {
            pageNumber: 1,
            text: "",
            startOffset: 0,
            endOffset: 0,
            wordCount: 0,
          },
        ],
      });

      const result = chunkDocument(document);

      expect(result).toEqual({
        parents: [],
        children: [],
        all: [],
      });
    });
  });

  // ── Parent Chunks ───────────────────────────────────────────────────────────

  describe("parent chunks", () => {
    it("creates one parent for short text", () => {
      const text =
        "The tenant shall pay rent within thirty days. " +
        "The landlord may terminate the agreement.";

      const result = chunkDocument(
        createDocument(text),
      );

      expect(result.parents).toHaveLength(1);

      expect(result.parents[0]).toMatchObject({
        id: "parent-1",
        kind: "parent",
        text,
        startOffset: 0,
        endOffset: text.length,
      });
    });

    it("preserves exact canonical text offsets", () => {
      const text =
        "The tenant shall pay rent within thirty days. " +
        "The landlord may terminate the agreement.";

      const result = chunkDocument(
        createDocument(text),
      );

      for (const parent of result.parents) {
        expect(
          text.slice(
            parent.startOffset,
            parent.endOffset,
          ),
        ).toBe(parent.text);
      }
    });

    it("creates sequential parent IDs without gaps", () => {
      const text = [
        "First legal paragraph.",
        "Second legal paragraph.",
        "Third legal paragraph.",
      ].join("\n\n");

      const result = chunkDocument(
        createDocument(text),
      );

      expect(
        result.parents.map(
          (parent) => parent.id,
        ),
      ).toEqual([
        "parent-1",
        "parent-2",
        "parent-3",
      ]);
    });

    it("does not create empty parents", () => {
      const text =
        "First paragraph.\n\n\n\nSecond paragraph.";

      const result = chunkDocument(
        createDocument(text),
      );

      expect(
        result.parents.every(
          (parent) =>
            parent.text.trim().length > 0,
        ),
      ).toBe(true);
    });

    it("stores a positive token estimate on every parent", () => {
      const text =
        "The tenant shall pay rent within thirty days. " +
        "The landlord may terminate the agreement.";

      const result = chunkDocument(
        createDocument(text),
      );

      for (const parent of result.parents) {
        expect(
          parent.tokenEstimate,
        ).toBeGreaterThan(0);
      }
    });

    it("works correctly with PDF MIME type", () => {
      const text =
        "The tenant shall comply with all terms.";

      const result = chunkDocument(
        createDocument(text, {
          mimeType: PDF_MIME,
          extension: "pdf",
        }),
      );

      expect(result.parents.length).toBeGreaterThan(
        0,
      );
    });

    it("works correctly with DOCX MIME type", () => {
      const text =
        "The tenant shall comply with all terms.";

      const result = chunkDocument(
        createDocument(text, {
          mimeType: DOCX_MIME,
          extension: "docx",
        }),
      );

      expect(result.parents.length).toBeGreaterThan(
        0,
      );
    });
  });

  // ── Child Chunks ────────────────────────────────────────────────────────────

  describe("child chunks", () => {
    it("creates children for a parent", () => {
      const text =
        "The tenant shall pay rent within thirty days. " +
        "The landlord may terminate the agreement. " +
        "The tenant must maintain the property. " +
        "Written notice is required before termination.";

      const result = chunkDocument(
        createDocument(text),
      );

      expect(
        result.children.length,
      ).toBeGreaterThan(0);

      for (const child of result.children) {
        expect(child.kind).toBe("child");
        expect(child.parentId).toBeDefined();
      }
    });

    it("uses the correct child ID format", () => {
      const text =
        "The tenant shall pay rent within thirty days. " +
        "The landlord may terminate the agreement.";

      const result = chunkDocument(
        createDocument(text),
      );

      for (const child of result.children) {
        expect(child.id).toMatch(
          /^parent-\d+-child-\d+$/u,
        );
      }
    });

    it("assigns every child to an existing parent", () => {
      const text =
        "The tenant shall pay rent within thirty days. " +
        "The landlord may terminate the agreement.";

      const result = chunkDocument(
        createDocument(text),
      );

      const parentIds = new Set(
        result.parents.map(
          (parent) => parent.id,
        ),
      );

      for (const child of result.children) {
        expect(
          parentIds.has(child.parentId!),
        ).toBe(true);
      }
    });

    it("maps child text exactly to canonical document text", () => {
      const text =
        "The tenant shall pay rent within thirty days. " +
        "The landlord may terminate the agreement. " +
        "The tenant must maintain the property.";

      const result = chunkDocument(
        createDocument(text),
      );

      for (const child of result.children) {
        expect(
          text.slice(
            child.startOffset,
            child.endOffset,
          ),
        ).toBe(child.text);
      }
    });

    it("keeps child offsets inside their parent", () => {
      const text =
        "The tenant shall pay rent within thirty days. " +
        "The landlord may terminate the agreement.";

      const result = chunkDocument(
        createDocument(text),
      );

      for (const child of result.children) {
        const parent = result.parents.find(
          (item) =>
            item.id === child.parentId,
        );

        expect(parent).toBeDefined();

        expect(
          child.startOffset,
        ).toBeGreaterThanOrEqual(
          parent!.startOffset,
        );

        expect(
          child.endOffset,
        ).toBeLessThanOrEqual(
          parent!.endOffset,
        );
      }
    });

    it("does not create empty children", () => {
      const text =
        "The tenant shall pay rent within thirty days.";

      const result = chunkDocument(
        createDocument(text),
      );

      for (const child of result.children) {
        expect(child.text.trim()).not.toBe("");
        expect(
          child.endOffset,
        ).toBeGreaterThan(
          child.startOffset,
        );
      }
    });

    it("keeps every child within the 200-token estimate", () => {
      const text = Array.from(
        { length: 500 },
        (_, index) =>
          `contract-word-${index}`,
      ).join(" ");

      const result = chunkDocument(
        createDocument(text),
      );

      for (const child of result.children) {
        expect(
          child.tokenEstimate,
        ).toBeLessThanOrEqual(200);
      }
    });

    it("stores a positive token estimate on every child", () => {
      const text =
        "The tenant shall pay rent within thirty days.";

      const result = chunkDocument(
        createDocument(text),
      );

      for (const child of result.children) {
        expect(
          child.tokenEstimate,
        ).toBeGreaterThan(0);
      }
    });
  });

  // ── Child Overlap ───────────────────────────────────────────────────────────

  describe("child overlap", () => {
    it("allows overlap between children of the same parent", () => {
      const text = Array.from(
        { length: 1_000 },
        (_, index) =>
          `legalword${index}`,
      ).join(" ");

      const result = chunkDocument(
        createDocument(text),
      );

      for (const parent of result.parents) {
        const siblings =
          result.children.filter(
            (child) =>
              child.parentId === parent.id,
          );

        if (siblings.length < 2) {
          continue;
        }

        for (
          let index = 1;
          index < siblings.length;
          index += 1
        ) {
          const previous =
            siblings[index - 1]!;

          const current =
            siblings[index]!;

          expect(
            current.startOffset,
          ).toBeLessThan(
            previous.endOffset,
          );
        }
      }
    });

    it("does not overlap children from different parents", () => {
      const text = [
        "First paragraph with many legal words. ".repeat(
          20,
        ),
        "Second paragraph with many legal words. ".repeat(
          20,
        ),
        "Third paragraph with many legal words. ".repeat(
          20,
        ),
      ].join("\n\n");

      const result = chunkDocument(
        createDocument(text),
      );

      for (
        let i = 0;
        i < result.children.length;
        i += 1
      ) {
        for (
          let j = i + 1;
          j < result.children.length;
          j += 1
        ) {
          const first =
            result.children[i]!;

          const second =
            result.children[j]!;

          if (
            first.parentId ===
            second.parentId
          ) {
            continue;
          }

          const separated =
            first.endOffset <=
              second.startOffset ||
            second.endOffset <=
              first.startOffset;

          expect(separated).toBe(true);
        }
      }
    });

    it("does not overlap parents with each other", () => {
      const text = [
        "First paragraph with legal terms.",
        "Second paragraph with additional legal terms.",
        "Third paragraph with more legal terms.",
      ].join("\n\n");

      const result = chunkDocument(
        createDocument(text),
      );

      for (
        let index = 1;
        index < result.parents.length;
        index += 1
      ) {
        const previous =
          result.parents[index - 1]!;

        const current =
          result.parents[index]!;

        expect(
          current.startOffset,
        ).toBeGreaterThanOrEqual(
          previous.endOffset,
        );
      }
    });
  });

  // ── Long Documents ─────────────────────────────────────────────────────────

  describe("long documents", () => {
    it("splits large content into multiple parents", () => {
      const paragraphs = Array.from(
        { length: 20 },
        (_, index) =>
          `Paragraph ${index}. ` +
          "The tenant shall comply with all contractual obligations. ".repeat(
            20,
          ),
      );

      const text =
        paragraphs.join("\n\n");

      const result = chunkDocument(
        createDocument(text),
      );

      expect(
        result.parents.length,
      ).toBeGreaterThan(1);
    });

    it("keeps normal parents within the target", () => {
      const paragraphs = Array.from(
        { length: 10 },
        (_, index) =>
          `Paragraph ${index}. ` +
          "The tenant shall comply with the agreement. ".repeat(
            30,
          ),
      );

      const text =
        paragraphs.join("\n\n");

      const result = chunkDocument(
        createDocument(text),
      );

      for (const parent of result.parents) {
        expect(
          parent.tokenEstimate,
        ).toBeLessThanOrEqual(1_800);
      }
    });
  });

  // ── Oversized Sentences ─────────────────────────────────────────────────────

  describe("oversized sentences", () => {
    it("falls back to word boundaries", () => {
      const hugeSentence =
        "This is a contractual sentence containing many words. ".repeat(
          200,
        );

      const result = chunkDocument(
        createDocument(hugeSentence),
      );

      expect(
        result.parents.length,
      ).toBeGreaterThan(1);

      for (const parent of result.parents) {
        expect(
          parent.text.trim(),
        ).not.toBe("");
      }
    });

    it("still preserves canonical offsets", () => {
      const hugeSentence =
        "This is a contractual sentence containing many words. ".repeat(
          200,
        );

      const result = chunkDocument(
        createDocument(hugeSentence),
      );

      for (const parent of result.parents) {
        expect(
          hugeSentence.slice(
            parent.startOffset,
            parent.endOffset,
          ),
        ).toBe(parent.text);
      }
    });
  });

  // ── Duplicate Text ──────────────────────────────────────────────────────────

  describe("duplicate text", () => {
    it("maps duplicate paragraphs to distinct source ranges", () => {
      const repeated =
        "The tenant shall pay rent within thirty days.";

      const text =
        `${repeated}\n\n${repeated}`;

      const result = chunkDocument(
        createDocument(text),
      );

      expect(result.parents).toHaveLength(2);

      expect(
        result.parents[0]!.startOffset,
      ).toBe(0);

      expect(
        result.parents[1]!.startOffset,
      ).toBeGreaterThan(
        result.parents[0]!.endOffset,
      );

      expect(
        text.slice(
          result.parents[1]!.startOffset,
          result.parents[1]!.endOffset,
        ),
      ).toBe(repeated);
    });
  });

  // ── Determinism ─────────────────────────────────────────────────────────────

  describe("determinism", () => {
    it("produces identical chunks for the same document", () => {
      const text =
        "The tenant shall pay rent within thirty days. " +
        "The landlord may terminate the agreement.";

      const first = chunkDocument(
        createDocument(text),
      );

      const second = chunkDocument(
        createDocument(text),
      );

      expect(first).toEqual(second);
    });
  });

  // ── Result Structure ────────────────────────────────────────────────────────

  describe("result structure", () => {
    it("returns parents, children, and all", () => {
      const text =
        "The tenant shall pay rent within thirty days. " +
        "The landlord may terminate the agreement.";

      const result = chunkDocument(
        createDocument(text),
      );

      expect(result).toHaveProperty(
        "parents",
      );

      expect(result).toHaveProperty(
        "children",
      );

      expect(result).toHaveProperty(
        "all",
      );

      expect(result.all).toHaveLength(
        result.parents.length +
          result.children.length,
      );
    });

    it("places parents before children in all", () => {
      const text =
        "The tenant shall pay rent within thirty days. " +
        "The landlord may terminate the agreement.";

      const result = chunkDocument(
        createDocument(text),
      );

      const allParents =
        result.all.filter(
          (chunk) =>
            chunk.kind === "parent",
        );

      const allChildren =
        result.all.filter(
          (chunk) =>
            chunk.kind === "child",
        );

      expect(allParents).toEqual(
        result.parents,
      );

      expect(allChildren).toEqual(
        result.children,
      );
    });
  });
});