import { z } from "zod";

import { store, keys } from "../../lib/store.js";

import { embedQuery } from "../retrieval/embedding.service.js";

import { searchVectors } from "../retrieval/vector-search.service.js";

import { loadBM25Index as loadStoredBM25Index } from "../retrieval/bm25-store.service.js";

import { loadEmbeddings } from "../retrieval/embedding-store.service.js";

import type { BM25Index } from "../retrieval/bm25.service.js";

import type { EmbeddingVector } from "../retrieval/embedding.service.js";

import {
  hybridSearch,
  hydrateHybridResults,
  type HydratedHybridResult,
  type VectorSearchResult,
} from "../retrieval/hybrid.service.js";

import type { DocumentChunk } from "../ingestion/chunk.service.js";

import type { RegisteredTool } from "./execute-tool.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_QUERY_LENGTH = 2_000 as const;

const DEFAULT_SEARCH_LIMIT = 8 as const;

const MAX_SEARCH_LIMIT = 15 as const;

const MAX_SECTION_TEXT_LENGTH = 8_000 as const;

const MAX_CLAUSE_RESULTS = 20 as const;

const MAX_DOCUMENT_IDS = 5 as const;

const SAFE_ID_PATTERN = /^[\w-]{1,128}$/u;

// ─── Errors ───────────────────────────────────────────────────────────────────

export class AgentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolError";
  }
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const SearchDocumentInputSchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),

  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .default(DEFAULT_SEARCH_LIMIT),
});

const GetSectionInputSchema = z.object({
  sectionId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(
      SAFE_ID_PATTERN,
      "Invalid section ID format.",
    ),
});

const ListClausesInputSchema = z.object({
  query: z
    .string()
    .trim()
    .max(MAX_QUERY_LENGTH)
    .default(""),

  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_CLAUSE_RESULTS)
    .default(MAX_CLAUSE_RESULTS),
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolExecutionContext {
  sessionId: string;
  documentIds: string[];
}

interface StoredDocumentChunks {
  parents: DocumentChunk[];
  children: DocumentChunk[];
  all: DocumentChunk[];
}

interface ToolEvidence {
  documentId: string;
  chunkId: string;
  parentId: string | null;
  text: string;
  score: number;
  startOffset: number;
  endOffset: number;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateContext(
  context: ToolExecutionContext,
): void {
  if (
    !context.sessionId ||
    !SAFE_ID_PATTERN.test(context.sessionId)
  ) {
    throw new AgentToolError(
      "Invalid tool execution session.",
    );
  }

  if (
    context.documentIds.length === 0 ||
    context.documentIds.length > MAX_DOCUMENT_IDS
  ) {
    throw new AgentToolError(
      `Tool execution requires one to ${MAX_DOCUMENT_IDS} documents.`,
    );
  }

  for (const documentId of context.documentIds) {
    if (
      !documentId ||
      !SAFE_ID_PATTERN.test(documentId)
    ) {
      throw new AgentToolError(
        `Invalid document ID: ${documentId}`,
      );
    }
  }
}

// ─── Safe JSON Parsing ────────────────────────────────────────────────────────

function parseStoredJson<T>(
  value: unknown,
): T | null {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  if (typeof value !== "string") {
    return value as T;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

// ─── Document Loading ─────────────────────────────────────────────────────────

async function loadChunks(
  sessionId: string,
  documentId: string,
): Promise<StoredDocumentChunks> {
  const raw =
    await store.get<StoredDocumentChunks>(
      keys.docChunks(
        sessionId,
        documentId,
      ),
    );

  if (!raw) {
    throw new AgentToolError(
      `Chunks are not available for document "${documentId}".`,
    );
  }

  const parsed =
    parseStoredJson<StoredDocumentChunks>(
      raw,
    );

  if (!parsed) {
    throw new AgentToolError(
      `Stored chunks for document "${documentId}" are invalid.`,
    );
  }

  return {
    parents: Array.isArray(parsed.parents)
      ? parsed.parents
      : [],

    children: Array.isArray(parsed.children)
      ? parsed.children
      : [],

    all: Array.isArray(parsed.all)
      ? parsed.all
      : [],
  };
}

async function loadBM25Index(
  sessionId: string,
  documentId: string,
): Promise<BM25Index> {
  /*
   * Reads the index saved by ingestion via bm25-store.service
   * (key scheme `${sessionId}:doc:${documentId}:bm25:meta` + batches).
   */
  const index = await loadStoredBM25Index(
    sessionId,
    documentId,
  );

  if (!index) {
    throw new AgentToolError(
      `BM25 index is not available for document "${documentId}".`,
    );
  }

  return index;
}

async function loadEmbeddingMap(
  sessionId: string,
  documentId: string,
): Promise<EmbeddingVector[]> {
  /*
   * Reads the embeddings saved by ingestion via embedding-store.service
   * (key scheme `${sessionId}:doc:${documentId}:emb:meta` + batches).
   */
  const stored = await loadEmbeddings(
    sessionId,
    documentId,
  );

  return stored?.embeddings ?? [];
}

// ─── Dense Search ─────────────────────────────────────────────────────────────

async function searchDense(
  query: string,
  children: DocumentChunk[],
  embeddings: EmbeddingVector[],
): Promise<VectorSearchResult[]> {
  if (children.length === 0 || embeddings.length === 0) {
    return [];
  }

  const queryVector =
    await embedQuery(query);

  return searchVectors(
    queryVector,
    embeddings,
    { topK: MAX_SEARCH_LIMIT },
  );
}

// ─── Search One Document ──────────────────────────────────────────────────────

async function searchOneDocument(
  context: ToolExecutionContext,
  documentId: string,
  query: string,
  limit: number,
): Promise<ToolEvidence[]> {
  /*
   * These three reads are independent.
   * Load them concurrently.
   */
  const [
    chunks,
    bm25Index,
    embeddings,
  ] = await Promise.all([
    loadChunks(
      context.sessionId,
      documentId,
    ),

    loadBM25Index(
      context.sessionId,
      documentId,
    ),

    loadEmbeddingMap(
      context.sessionId,
      documentId,
    ),
  ]);

  /*
   * Dense retrieval performs the provider call.
   *
   * BM25 is synchronous and is executed internally
   * by hybridSearch().
   */
  const vectorResults =
    await searchDense(
      query,
      chunks.children,
      embeddings,
    );

  /*
   * hybridSearch performs:
   *
   * BM25 retrieval
   * +
   * dense retrieval
   * +
   * RRF fusion
   */
  const hybridResults =
    hybridSearch(
      bm25Index,
      query,
      vectorResults,
      {
        topK: limit,
      },
    );

  const hydrated =
    hydrateHybridResults(
      hybridResults,
      chunks.children,
    );

  return hydrated.map(
    (
      result: HydratedHybridResult,
    ): ToolEvidence => ({
      documentId,

      chunkId:
        result.chunk.id,

      parentId:
        result.chunk.parentId ??
        null,

      text:
        result.chunk.text,

      score:
        result.score,

      startOffset:
        result.chunk.startOffset,

      endOffset:
        result.chunk.endOffset,
    }),
  );
}

// ─── search_document ──────────────────────────────────────────────────────────

async function executeSearchDocument(
  args: z.infer<
    typeof SearchDocumentInputSchema
  > &
    ToolExecutionContext,
): Promise<{
  query: string;
  results: ToolEvidence[];
}> {
  const {
    sessionId,
    documentIds,
    query,
    limit,
  } = args;

  validateContext({
    sessionId,
    documentIds,
  });

  /*
   * Search all trusted documents concurrently.
   */
  const perDocumentResults =
    await Promise.all(
      documentIds.map(
        (documentId) =>
          searchOneDocument(
            {
              sessionId,
              documentIds,
            },
            documentId,
            query,
            limit,
          ),
      ),
    );

  /*
   * Merge document results, rank globally,
   * then enforce the final result limit.
   */
  const results =
    perDocumentResults
      .flat()
      .sort(
        (a, b) => b.score - a.score,
      )
      .slice(0, limit);

  return {
    query,
    results,
  };
}

// ─── get_section ──────────────────────────────────────────────────────────────

async function executeGetSection(
  args: z.infer<
    typeof GetSectionInputSchema
  > &
    ToolExecutionContext,
): Promise<{
  found: boolean;
  documentId?: string;
  section?: {
    id: string;
    text: string;
    startOffset: number;
    endOffset: number;
  };
  sectionId: string;
  message?: string;
}> {
  const {
    sessionId,
    documentIds,
    sectionId,
  } = args;

  validateContext({
    sessionId,
    documentIds,
  });

  /*
   * Load every document concurrently.
   */
  const documents =
    await Promise.all(
      documentIds.map(
        async (documentId) => ({
          documentId,

          chunks:
            await loadChunks(
              sessionId,
              documentId,
            ),
        }),
      ),
    );

  for (const {
    documentId,
    chunks,
  } of documents) {
    const parent =
      chunks.parents.find(
        (chunk) =>
          chunk.id === sectionId,
      );

    if (!parent) {
      continue;
    }

    return {
      found: true,

      documentId,

      sectionId,

      section: {
        id: parent.id,

        text: parent.text.slice(
          0,
          MAX_SECTION_TEXT_LENGTH,
        ),

        startOffset:
          parent.startOffset,

        endOffset:
          parent.endOffset,
      },
    };
  }

  return {
    found: false,

    sectionId,

    message:
      "The requested section was not found in the supplied documents.",
  };
}

// ─── list_clauses ─────────────────────────────────────────────────────────────

async function executeListClauses(
  args: z.infer<
    typeof ListClausesInputSchema
  > &
    ToolExecutionContext,
): Promise<{
  mode: "retrieval" | "structural";

  query: string;

  clauses: Array<{
    documentId: string;
    clauseId?: string;
    chunkId?: string;
    parentId?: string | null;
    text: string;
    startOffset: number;
    endOffset: number;
  }>;
}> {
  const {
    sessionId,
    documentIds,
    query,
    limit,
  } = args;

  validateContext({
    sessionId,
    documentIds,
  });

  /*
   * Query mode:
   *
   * Reuse the typed search pipeline instead of
   * duplicating retrieval logic.
   */
  if (query.trim().length > 0) {
    const {
      results,
    } =
      await executeSearchDocument({
        sessionId,
        documentIds,
        query,
        limit,
      });

    return {
      mode: "retrieval",

      query,

      clauses:
        results.map(
          (result) => ({
            documentId:
              result.documentId,

            chunkId:
              result.chunkId,

            parentId:
              result.parentId,

            text:
              result.text,

            startOffset:
              result.startOffset,

            endOffset:
              result.endOffset,
          }),
        ),
    };
  }

  /*
   * No query:
   *
   * Return the current structural units.
   *
   * The current chunk model has parent/child chunks,
   * not a dedicated Clause type.
   */
  const documents =
    await Promise.all(
      documentIds.map(
        async (documentId) => ({
          documentId,

          chunks:
            await loadChunks(
              sessionId,
              documentId,
            ),
        }),
      ),
    );

  const clauses: Array<{
    documentId: string;
    clauseId: string;
    text: string;
    startOffset: number;
    endOffset: number;
  }> = [];

  for (const {
    documentId,
    chunks,
  } of documents) {
    for (const parent of chunks.parents) {
      clauses.push({
        documentId,

        clauseId:
          parent.id,

        text:
          parent.text,

        startOffset:
          parent.startOffset,

        endOffset:
          parent.endOffset,
      });

      if (clauses.length >= limit) {
        break;
      }
    }

    if (clauses.length >= limit) {
      break;
    }
  }

  return {
    mode: "structural",

    query,

    clauses,
  };
}

// ─── Registered Tools ─────────────────────────────────────────────────────────

export const searchDocumentTool: RegisteredTool = {
  name: "search_document",

  description:
    "Search the supplied contract documents for relevant evidence using hybrid lexical and semantic retrieval.",

  inputSchema:
    SearchDocumentInputSchema,

  async execute(args) {
    // ToolExecutor merges the trusted ToolExecutionContext into args at runtime.
    return executeSearchDocument(
      args as unknown as z.infer<
        typeof SearchDocumentInputSchema
      > &
        ToolExecutionContext,
    );
  },
};

export const getSectionTool: RegisteredTool = {
  name: "get_section",

  description:
    "Retrieve the full text and canonical offsets of a specific parent section from the supplied documents.",

  inputSchema:
    GetSectionInputSchema,

  async execute(args) {
    // ToolExecutor merges the trusted ToolExecutionContext into args at runtime.
    return executeGetSection(
      args as unknown as z.infer<
        typeof GetSectionInputSchema
      > &
        ToolExecutionContext,
    );
  },
};

export const listClausesTool: RegisteredTool = {
  name: "list_clauses",

  description:
    "List structural contract sections or retrieve relevant structural sections matching a query.",

  inputSchema:
    ListClausesInputSchema,

  async execute(args) {
    // ToolExecutor merges the trusted ToolExecutionContext into args at runtime.
    return executeListClauses(
      args as unknown as z.infer<
        typeof ListClausesInputSchema
      > &
        ToolExecutionContext,
    );
  },
};

// ─── Agent Tools ──────────────────────────────────────────────────────────────

export const agentTools: readonly RegisteredTool[] = [
  searchDocumentTool,
  getSectionTool,
  listClausesTool,
];