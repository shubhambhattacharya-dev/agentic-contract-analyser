import { describe, expect, it } from "vitest";

import {
  buildHighlightPlan,
  deriveSections,
  renderPage,
} from "../highlight";
import { validateUploadFile } from "../format";

const TEXT = "PAGE ONE TEXT.\n\nPAGE TWO TEXT WITH THE CLAUSE.";
const PAGES = [
  { pageNumber: 1, startOffset: 0, endOffset: 15 },
  { pageNumber: 2, startOffset: 16, endOffset: 46 },
];

describe("renderPage", () => {
  it("VIEW04: slices the exact verified range on the correct page", () => {
    const start = TEXT.indexOf("THE CLAUSE");
    const rendered = renderPage(TEXT, PAGES[1]!, start, start + 10);

    expect(rendered.mark).toBe("THE CLAUSE");
    expect(rendered.before.startsWith("PAGE TWO")).toBe(true);
  });

  it("renders the whole page unchanged without a citation", () => {
    const rendered = renderPage(TEXT, PAGES[0]!, null, null);

    expect(rendered).toEqual({
      before: "PAGE ONE TEXT.\n",
      mark: "",
      after: "",
    });
  });
});

describe("buildHighlightPlan", () => {
  it("produces one segment per touched page for cross-page quotes", () => {
    const plan = buildHighlightPlan(TEXT, PAGES, 10, 25);

    expect(plan.page).toBe(1);
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0]!.mark).toBe("EXT.\n");
    expect(plan.segments[1]!.mark).toBe("PAGE TWO ");
  });

  it("rejects impossible ranges instead of guessing", () => {
    expect(buildHighlightPlan(TEXT, PAGES, 500, 600).segments).toHaveLength(0);
    expect(buildHighlightPlan(TEXT, PAGES, 5, 5).segments).toHaveLength(0);
  });

  it("works without a page map (single segment)", () => {
    const plan = buildHighlightPlan("abcdef", [], 2, 4);

    expect(plan.page).toBe(1);
    expect(plan.segments[0]!.mark).toBe("cd");
  });
});

describe("deriveSections", () => {
  it("extracts numbered sections with preserved offsets", () => {
    const text = "Preamble.\n1. TERM. Short.\nNot a section.\n12.3 INSOLVENCY";
    const sections = deriveSections(text);

    expect(sections).toEqual([
      { number: "1", title: "TERM. Short.", startOffset: 10 },
      { number: "12.3", title: "INSOLVENCY", startOffset: 41 },
    ]);
  });

  it("never invents sections from unnumbered text", () => {
    expect(deriveSections("just some text\nwithout numbers")).toEqual([]);
  });
});

describe("validateUploadFile", () => {
  it("UP03: rejects unsupported extensions", () => {
    const file = { name: "virus.exe", size: 100 } as File;

    expect(validateUploadFile(file)).toContain("Only PDF and DOCX");
  });

  it("UP04: rejects oversized files", () => {
    const file = { name: "big.pdf", size: 30 * 1024 * 1024 } as File;

    expect(validateUploadFile(file)).toContain("25MB");
  });

  it("accepts a normal PDF", () => {
    const file = { name: "contract.pdf", size: 1024 } as File;

    expect(validateUploadFile(file)).toBeNull();
  });
});
