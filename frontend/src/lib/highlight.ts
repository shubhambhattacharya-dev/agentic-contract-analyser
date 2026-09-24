// ─── Citation → viewer highlight math (pure, testable) ───────────────────────
//
// The backend's canonical offsets are authoritative: this module NEVER does
// fuzzy matching — it slices the canonical text by verified offsets and maps
// them onto page windows from the backend page map.

import type { DocumentPage } from "./api";

export interface PageSegment {
  pageNumber: number;
  before: string;
  mark: string;
  after: string;
}

export interface HighlightPlan {
  page: number | null;
  segments: PageSegment[];
}

/**
 * Builds the per-page before/mark/after segments for a verified citation.
 * A quote spanning a page break produces one segment per touched page.
 */
export function buildHighlightPlan(
  text: string,
  pages: DocumentPage[],
  startOffset: number,
  endOffset: number,
): HighlightPlan {
  if (startOffset < 0 || endOffset <= startOffset || endOffset > text.length) {
    return { page: null, segments: [] };
  }

  const ordered = [...pages].sort((a, b) => a.startOffset - b.startOffset);

  const segments: PageSegment[] = [];
  let page: number | null = null;

  for (const candidate of ordered) {
    const overlapStart = Math.max(startOffset, candidate.startOffset);
    const overlapEnd = Math.min(endOffset, candidate.endOffset);

    if (overlapStart >= overlapEnd) {
      continue;
    }

    if (page === null) {
      page = candidate.pageNumber;
    }

    segments.push({
      pageNumber: candidate.pageNumber,
      before: text.slice(candidate.startOffset, overlapStart),
      mark: text.slice(overlapStart, overlapEnd),
      after: text.slice(overlapEnd, candidate.endOffset),
    });
  }

  // No page map: render the whole document as one segment.
  if (ordered.length === 0) {
    segments.push({
      pageNumber: 1,
      before: text.slice(0, startOffset),
      mark: text.slice(startOffset, endOffset),
      after: text.slice(endOffset),
    });
    page = 1;
  }

  return { page, segments };
}

/** Renders one page of the canonical text with an optional highlighted range. */
export function renderPage(
  text: string,
  page: DocumentPage,
  startOffset: number | null,
  endOffset: number | null,
): { before: string; mark: string; after: string } {
  const pageText = text.slice(page.startOffset, page.endOffset);

  if (
    startOffset === null ||
    endOffset === null ||
    endOffset <= startOffset ||
    endOffset <= page.startOffset ||
    startOffset >= page.endOffset
  ) {
    return { before: pageText, mark: "", after: "" };
  }

  const localStart = Math.max(startOffset - page.startOffset, 0);
  const localEnd = Math.min(endOffset - page.startOffset, page.endOffset - page.startOffset);

  return {
    before: pageText.slice(0, localStart),
    mark: pageText.slice(localStart, localEnd),
    after: pageText.slice(localEnd),
  };
}

const SECTION_NUMBER_PATTERN = /^\s*(\d+(?:\.\d+)*)[.)]?\s+/u;

export interface DerivedSection {
  number: string;
  title: string;
  startOffset: number;
}

/**
 * Derives section entries from the canonical text (offsets preserved).
 * Sections are numbered clauses only — never invented.
 */
export function deriveSections(text: string): DerivedSection[] {
  const sections: DerivedSection[] = [];
  let searchFrom = 0;

  for (;;) {
    const newline = text.indexOf("\n", searchFrom);

    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(searchFrom, lineEnd);
    const match = line.match(SECTION_NUMBER_PATTERN);

    if (match?.[1]) {
      const title = line
        .slice(match[0].length)
        .replace(/\s+/gu, " ")
        .trim()
        .split(" ")
        .slice(0, 8)
        .join(" ");

      sections.push({
        number: match[1],
        title,
        startOffset: searchFrom,
      });
    }

    if (newline === -1) {
      break;
    }

    searchFrom = newline + 1;
  }

  return sections;
}
