import type { DocumentChunk } from "../ingestion/chunk.service.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_K1 = 1.5 as const;
const DEFAULT_B = 0.75 as const;
const DEFAULT_TOP_K = 15 as const;
const DEFAULT_MIN_SCORE = 0 as const;

const TOKEN_PATTERN =
  /[a-z0-9]+(?:['-][a-z0-9]+)*/giu;

const LEGAL_STOP_WORDS = new Set<string>([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
]);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BM25Document {
  id: string;
  length: number;
  termFrequency: Record<string, number>;
}

export interface BM25IndexData {
  version: 1;
  k1: number;
  b: number;
  documentCount: number;
  averageDocumentLength: number;
  documents: BM25Document[];
  documentFrequency: Record<string, number>;
}

export interface BM25SearchResult {
  id: string;
  score: number;
}

export interface BM25Options {
  k1?: number;
  b?: number;
}

export interface BM25SearchOptions {
  topK?: number;
  minScore?: number;
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  const matches = text.toLocaleLowerCase("en").match(
    TOKEN_PATTERN,
  );

  if (!matches) {
    return [];
  }

  return matches.filter(
    (token) => !LEGAL_STOP_WORDS.has(token),
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTermFrequency(
  tokens: string[],
): Record<string, number> {
  const frequencies: Record<string, number> = {};

  for (const token of tokens) {
    frequencies[token] =
      (frequencies[token] ?? 0) + 1;
  }

  return frequencies;
}

function calculateIDF(
  documentCount: number,
  documentFrequency: number,
): number {
  return Math.log(
    1 +
      (documentCount - documentFrequency + 0.5) /
        (documentFrequency + 0.5),
  );
}

function validateSearchOptions(
  options: BM25SearchOptions,
): void {
  if (
    options.topK !== undefined &&
    (!Number.isInteger(options.topK) ||
      options.topK <= 0)
  ) {
    throw new Error(
      "BM25 topK must be a positive integer.",
    );
  }

  if (
    options.minScore !== undefined &&
    (!Number.isFinite(options.minScore) ||
      options.minScore < 0)
  ) {
    throw new Error(
      "BM25 minScore must be a non-negative number.",
    );
  }
}

// ─── BM25 Index ──────────────────────────────────────────────────────────────

export class BM25Index {
  private readonly k1: number;
  private readonly b: number;

  private readonly documents = new Map<
    string,
    BM25Document
  >();

  private readonly documentFrequency = new Map<
    string,
    number
  >();

  private totalDocumentLength = 0;

  constructor(options: BM25Options = {}) {
    this.k1 = options.k1 ?? DEFAULT_K1;
    this.b = options.b ?? DEFAULT_B;

    if (
      !Number.isFinite(this.k1) ||
      this.k1 <= 0
    ) {
      throw new Error(
        "BM25 k1 must be greater than zero.",
      );
    }

    if (
      !Number.isFinite(this.b) ||
      this.b < 0 ||
      this.b > 1
    ) {
      throw new Error(
        "BM25 b must be between 0 and 1.",
      );
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  get documentCount(): number {
    return this.documents.size;
  }

  get averageDocumentLength(): number {
    if (this.documents.size === 0) {
      return 0;
    }

    return (
      this.totalDocumentLength /
      this.documents.size
    );
  }

  has(documentId: string): boolean {
    return this.documents.has(documentId);
  }

  // ── Add Documents ──────────────────────────────────────────────────────────

  addDocument(chunk: DocumentChunk): void {
    if (chunk.kind !== "child") {
      return;
    }

    const tokens = tokenize(chunk.text);

    if (tokens.length === 0) {
      return;
    }

    if (this.documents.has(chunk.id)) {
      this.removeDocument(chunk.id);
    }

    const termFrequency =
      buildTermFrequency(tokens);

    const document: BM25Document = {
      id: chunk.id,
      length: tokens.length,
      termFrequency,
    };

    this.documents.set(
      chunk.id,
      document,
    );

    this.totalDocumentLength +=
      document.length;

    for (const term of Object.keys(
      termFrequency,
    )) {
      this.documentFrequency.set(
        term,
        (this.documentFrequency.get(term) ?? 0) +
          1,
      );
    }
  }

  addDocuments(
    chunks: DocumentChunk[],
  ): void {
    for (const chunk of chunks) {
      this.addDocument(chunk);
    }
  }

  // ── Remove Documents ──────────────────────────────────────────────────────

  removeDocument(
    documentId: string,
  ): boolean {
    const document =
      this.documents.get(documentId);

    if (!document) {
      return false;
    }

    for (const term of Object.keys(
      document.termFrequency,
    )) {
      const current =
        this.documentFrequency.get(term) ?? 0;

      if (current <= 1) {
        this.documentFrequency.delete(term);
      } else {
        this.documentFrequency.set(
          term,
          current - 1,
        );
      }
    }

    this.totalDocumentLength -=
      document.length;

    this.documents.delete(documentId);

    return true;
  }

  // ── Clear ──────────────────────────────────────────────────────────────────

  clear(): void {
    this.documents.clear();
    this.documentFrequency.clear();
    this.totalDocumentLength = 0;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  search(
    query: string,
    options: BM25SearchOptions = {},
  ): BM25SearchResult[] {
    validateSearchOptions(options);

    if (this.documents.size === 0) {
      return [];
    }

    const queryTerms = tokenize(query);

    if (queryTerms.length === 0) {
      return [];
    }

    const topK =
      options.topK ?? DEFAULT_TOP_K;

    const minScore =
      options.minScore ?? DEFAULT_MIN_SCORE;

    const uniqueTerms = [
      ...new Set(queryTerms),
    ];

    const results: BM25SearchResult[] = [];

    for (const document of this.documents.values()) {
      const score = this.scoreDocument(
        document,
        uniqueTerms,
      );

      if (score > minScore) {
        results.push({
          id: document.id,
          score,
        });
      }
    }

    results.sort(
      (a, b) => b.score - a.score,
    );

    return results.slice(0, topK);
  }

  // ── Scoring ────────────────────────────────────────────────────────────────

  private scoreDocument(
    document: BM25Document,
    queryTerms: string[],
  ): number {
    const documentCount =
      this.documents.size;

    const averageLength =
      this.averageDocumentLength || 1;

    const lengthNormalization =
      1 -
      this.b +
      this.b *
        (document.length /
          averageLength);

    let score = 0;

    for (const term of queryTerms) {
      const termFrequency =
        document.termFrequency[term] ?? 0;

      if (termFrequency === 0) {
        continue;
      }

      const documentFrequency =
        this.documentFrequency.get(term) ?? 0;

      if (documentFrequency === 0) {
        continue;
      }

      const idf = calculateIDF(
        documentCount,
        documentFrequency,
      );

      const numerator =
        termFrequency *
        (this.k1 + 1);

      const denominator =
        termFrequency +
        this.k1 *
          lengthNormalization;

      score +=
        idf *
        (numerator / denominator);
    }

    return score;
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  toJSON(): BM25IndexData {
    return {
      version: 1,
      k1: this.k1,
      b: this.b,
      documentCount:
        this.documents.size,
      averageDocumentLength:
        this.averageDocumentLength,
      documents: [
        ...this.documents.values(),
      ],
      documentFrequency:
        Object.fromEntries(
          this.documentFrequency,
        ),
    };
  }

  static fromJSON(
    data: BM25IndexData,
  ): BM25Index {
    if (data.version !== 1) {
      throw new Error(
        `Unsupported BM25 index version: ${data.version}`,
      );
    }

    if (
      !Number.isFinite(data.k1) ||
      data.k1 <= 0
    ) {
      throw new Error(
        "Invalid BM25 k1 value.",
      );
    }

    if (
      !Number.isFinite(data.b) ||
      data.b < 0 ||
      data.b > 1
    ) {
      throw new Error(
        "Invalid BM25 b value.",
      );
    }

    const index = new BM25Index({
      k1: data.k1,
      b: data.b,
    });

    for (const document of data.documents) {
      if (
        !document.id ||
        !Number.isInteger(document.length) ||
        document.length <= 0
      ) {
        throw new Error(
          "Invalid BM25 document data.",
        );
      }

      index.restoreDocument(document);
    }

    return index;
  }

  private restoreDocument(
    document: BM25Document,
  ): void {
    if (this.documents.has(document.id)) {
      throw new Error(
        `Duplicate BM25 document ID: ${document.id}`,
      );
    }

    this.documents.set(
      document.id,
      document,
    );

    this.totalDocumentLength +=
      document.length;

    for (const term of Object.keys(
      document.termFrequency,
    )) {
      const frequency =
        this.documentFrequency.get(term) ?? 0;

      this.documentFrequency.set(
        term,
        frequency + 1,
      );
    }
  }

  serialize(): string {
    return JSON.stringify(
      this.toJSON(),
    );
  }

  static deserialize(
    value: string,
  ): BM25Index {
    let data: unknown;

    try {
      data = JSON.parse(value);
    } catch {
      throw new Error(
        "Invalid serialized BM25 index.",
      );
    }

    return BM25Index.fromJSON(
      data as BM25IndexData,
    );
  }
}

// ─── Service Functions ────────────────────────────────────────────────────────

export function buildBM25Index(
  chunks: DocumentChunk[],
): BM25Index {
  const index = new BM25Index();

  index.addDocuments(chunks);

  return index;
}

export function searchBM25(
  index: BM25Index,
  query: string,
  options: BM25SearchOptions = {},
): BM25SearchResult[] {
  return index.search(
    query,
    options,
  );
}