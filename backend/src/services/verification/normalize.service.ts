

const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\uFEFF]/gu;

const WHITESPACE_PATTERN = /\s+/gu;

const SMART_QUOTE_PATTERN =
  /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F]/gu;

const DASH_PATTERN =
  /[\u2010\u2011\u2012\u2013\u2014\u2212]/gu;

// ─── Replacement Maps ───────────────────────────────────────────────────────

const SMART_QUOTES: Readonly<Record<string, string>> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": "'",
  "\u201B": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u201F": '"',
};

const DASHES: Readonly<Record<string, string>> = {
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
};

// ─── Errors ──────────────────────────────────────────────────────────────────

export class NormalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizeError";
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NormalizedTextOptions {
  caseSensitive?: boolean;
  normalizeQuotes?: boolean;
  normalizeDashes?: boolean;
}

export interface NormalizedText {
  value: string;
  originalLength: number;
  normalizedLength: number;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

export function replaceSmartQuotes(text: string): string {
  return text.replace(
    SMART_QUOTE_PATTERN,
    (character) => SMART_QUOTES[character] ?? character,
  );
}

export function replaceDashes(text: string): string {
  return text.replace(
    DASH_PATTERN,
    (character) => DASHES[character] ?? character,
  );
}

/**
 * Removes zero-width characters.
 *
 * Exported so offset-mapping code can mirror normalizeText()
 * character-by-character without duplicating the rule set.
 */
export function stripZeroWidthCharacters(text: string): string {
  return text.replace(ZERO_WIDTH_PATTERN, "");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function normalizeText(
  text: string,
  options: NormalizedTextOptions = {},
): string {
  if (typeof text !== "string") {
    throw new NormalizeError(
      "normalizeText: input must be a string.",
    );
  }

  const {
    caseSensitive = false,
    normalizeQuotes = true,
    normalizeDashes = true,
  } = options;

  let normalized = text.normalize("NFC");

  normalized = stripZeroWidthCharacters(normalized);

  if (normalizeQuotes) {
    normalized = replaceSmartQuotes(normalized);
  }

  if (normalizeDashes) {
    normalized = replaceDashes(normalized);
  }

  normalized = normalized
    .replace(WHITESPACE_PATTERN, " ")
    .trim();

  if (!caseSensitive) {
    normalized = normalized.toLocaleLowerCase("en");
  }

  return normalized;
}

// ─── Metadata ────────────────────────────────────────────────────────────────

export function normalizeWithMetadata(
  text: string,
  options: NormalizedTextOptions = {},
): NormalizedText {
  if (typeof text !== "string") {
    throw new NormalizeError(
      "normalizeWithMetadata: input must be a string.",
    );
  }

  const value = normalizeText(text, options);

  return {
    value,
    originalLength: text.length,
    normalizedLength: value.length,
  };
}

// ─── Equality ─────────────────────────────────────────────────────────────────

export function normalizedTextEquals(
  first: string,
  second: string,
  options: NormalizedTextOptions = {},
): boolean {
  if (typeof first !== "string") {
    throw new NormalizeError(
      "normalizedTextEquals: first input must be a string.",
    );
  }

  if (typeof second !== "string") {
    throw new NormalizeError(
      "normalizedTextEquals: second input must be a string.",
    );
  }

  return (
    normalizeText(first, options) ===
    normalizeText(second, options)
  );
}

// ─── Normalized Search ────────────────────────────────────────────────────────

/**
 * Finds a quote inside normalized document text.
 *
 * IMPORTANT:
 * The returned offset belongs to the normalized string.
 * It is NOT a canonical document offset.
 *
 * Quote verification must map the match back to the
 * original canonical document before displaying highlights.
 *
 * Returns:
 * - normalized offset when found
 * - -1 when the normalized quote is empty or not found
 */
export function findNormalizedOffset(
  documentText: string,
  quote: string,
  options: NormalizedTextOptions = {},
): number {
  if (typeof documentText !== "string") {
    throw new NormalizeError(
      "findNormalizedOffset: documentText must be a string.",
    );
  }

  if (typeof quote !== "string") {
    throw new NormalizeError(
      "findNormalizedOffset: quote must be a string.",
    );
  }

  const normalizedDocument = normalizeText(
    documentText,
    options,
  );

  const normalizedQuote = normalizeText(
    quote,
    options,
  );

  if (!normalizedQuote) {
    return -1;
  }

  return normalizedDocument.indexOf(normalizedQuote);
}