import { describe, expect, it } from "vitest";

import {
  alignSections,
  classifyChange,
  extractSectionNumber,
  jaccardSimilarity,
  numericChange,
  type SectionInput,
} from "../../src/services/comparison/compare.service.js";

const section = (id: string, text: string): SectionInput => ({ id, text });

describe("extractSectionNumber", () => {
  it("extracts simple numbers", () => {
    expect(extractSectionNumber("8.2  Limitation of Liability ...")).toBe("8.2");
  });

  it("extracts nested numbers", () => {
    expect(extractSectionNumber("12.3 Termination for Insolvency")).toBe("12.3");
  });

  it("returns null when there is no leading number", () => {
    expect(extractSectionNumber("The parties agree as follows.")).toBeNull();
  });
});

describe("numericChange", () => {
  it("detects a changed liability cap", () => {
    const change = numericChange(
      "liability shall not exceed AED 100,000",
      "liability shall not exceed AED 1,000,000",
    );

    expect(change).toEqual({ from: "100,000", to: "1,000,000" });
  });

  it("returns null when numbers are identical", () => {
    expect(
      numericChange("cap of AED 100,000 applies", "cap of AED 100,000 applies"),
    ).toBeNull();
  });

  it("detects a removed number", () => {
    expect(numericChange("30 days notice", "notice")).toEqual({
      from: "30",
      to: "(missing)",
    });
  });
});

describe("classifyChange", () => {
  it("rates numeric changes as CRITICAL even when wording is identical", () => {
    expect(
      classifyChange(
        "The cap is AED 100,000 per claim.",
        "The cap is AED 1,000,000 per claim.",
      ),
    ).toBe("CRITICAL");
  });

  it("rates pure rewording as MODERATE", () => {
    expect(
      classifyChange(
        "Either party may terminate this agreement with thirty days written notice to the other party.",
        "Both parties may end this agreement by giving thirty days written notice to each other.",
      ),
    ).toBe("MODERATE");
  });

  it("rates formatting-only changes as MINOR", () => {
    expect(
      classifyChange(
        "The Vendor shall provide invoices monthly.",
        "The  Vendor   shall provide invoices monthly!",
      ),
    ).toBe("MINOR");
  });

  it("rates added or removed clauses as CRITICAL", () => {
    expect(classifyChange(null, "A brand new clause appears.")).toBe("CRITICAL");
    expect(classifyChange("An old clause disappears.", null)).toBe("CRITICAL");
  });
});

describe("alignSections", () => {
  it("aligns by section number across reordered documents", () => {
    const a = [
      section("p1", "1. Term. This agreement runs for 24 months."),
      section("p2", "2. Termination. Thirty days notice required."),
      section("p3", "3. Governing law. Dubai applies."),
    ];
    const b = [
      section("q1", "1. Term. This agreement runs for 24 months."),
      section("q2", "3. Governing law. Dubai applies."),
      section("q3", "2. Termination. Sixty days notice required."),
    ];

    const pairs = alignSections(a, b);

    expect(pairs).toHaveLength(3);
    expect(pairs.every((pair) => pair.textA && pair.textB)).toBe(true);
    const termination = pairs.find((pair) => pair.sectionNumber === "2");
    expect(termination?.textA).toContain("Thirty days");
    expect(termination?.textB).toContain("Sixty days");
  });

  it("reports removed sections", () => {
    const pairs = alignSections(
      [section("p1", "1. Term. 24 months."), section("p2", "9. Audit rights apply.")],
      [section("q1", "1. Term. 24 months.")],
    );

    const removed = pairs.find((pair) => pair.textB === null);
    expect(removed?.textA).toContain("Audit rights");
  });

  it("reports added sections", () => {
    const pairs = alignSections(
      [section("p1", "1. Term. 24 months.")],
      [section("q1", "1. Term. 24 months."), section("q2", "7. Insurance is mandatory.")],
    );

    const added = pairs.find((pair) => pair.textA === null);
    expect(added?.textB).toContain("Insurance");
  });

  it("pairs similar unnumbered sections by meaning", () => {
    const pairs = alignSections(
      [section("p1", "The vendor shall indemnify the client against third party claims.")],
      [section("q1", "The supplier shall indemnify the customer against third party claims.")],
    );

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.textA).toContain("vendor");
    expect(pairs[0]?.textB).toContain("supplier");
  });
});

describe("jaccardSimilarity", () => {
  it("is 1 for identical text and 0 for disjoint text", () => {
    expect(jaccardSimilarity("liability cap applies", "liability cap applies")).toBe(1);
    expect(jaccardSimilarity("liability cap applies", "governing law dubai")).toBe(0);
  });
});
