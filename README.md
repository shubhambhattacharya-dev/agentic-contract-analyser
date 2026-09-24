# Elcara — Agentic Contract Analyser

Upload a legal contract (PDF or DOCX), ask questions about it in a chat, and get
answers backed by **verified quotes**: every quote is located in the canonical
document text by deterministic code before it is shown — invented or
paraphrased quotes are never presented as genuine.

## Architecture

```
backend/   Express 5 + TypeScript (strict) API server
  src/
    config/          Zod-validated environment (env.ts)
    routes/          upload, documents, chat (SSE), health
    controllers/     HTTP boundary — no business logic
    services/
      ingestion/     extract (pdf-parse/mammoth) → structure → offset-true chunks
      retrieval/     BM25 + Gemini embeddings + RRF fusion + evidence gate
      ai/            provider abstraction (Groq/Gemini + fallback), agent loop,
                     tool registry, trusted tool executor
      verification/  whitespace-tolerant quote verifier (pure, deterministic)
    lib/             Redis/Blob storage gateway (dev: ioredis + local FS,
                     prod: Upstash REST + Vercel Blob)
data/ public/ docs/ scripts/ fixtures/   (reserved; see "What is not finished")
```

Key design law: **the LLM proposes; deterministic code disposes.** Model output
is untrusted end to end — quotes are verified against the canonical text,
offsets/pages are computed by the verifier (never read from the model), and
tool calls execute through a server-side executor that injects the session and
document scope (the model can widen neither).

## Running locally

```bash
# 1. Redis (host port 6380 — see note in docker-compose.yml)
docker compose up -d redis langfuse   # redis required; langfuse optional

# 2. Backend
cd backend
cp ../.env.example .env      # fill GROQ_API_KEY + GOOGLE_GENERATIVE_AI_API_KEY
npm ci
npm run dev                  # http://localhost:8000

# Checks
npm run typecheck && npm test && npm run build
```

Environment variables are validated at boot (Zod): provider keys, models,
model routing (`GENERATION_PROVIDER`, `GENERATION_FALLBACK_CHAIN`), Redis,
Blob, and retrieval limits (`MAX_AGENT_ROUNDS` hard-capped at 4).

## LLM observability (Langfuse)

Every LLM surface is traced to a self-configurable Langfuse project (cloud or
the bundled local stack via `docker compose up -d langfuse` →
`http://localhost:3001`):

- `ingestion` trace — store-file / extract / chunk / bm25 / embed spans with
  counts and durations.
- `embedding` trace — one `embed-batch` generation per batch (batch API: up to
  100 inputs per provider call), plus total duration.
- `chat` trace — retrieval span (chunk count, gate decision), agent span when
  the gate escalates, and closing metadata: verified/rejected quote counts,
  gate decision, end-to-end duration.
- `agent-research` trace — one span per tool call (name, args, ok, latency),
  with trace-end reason (finished / hard-cap / malformed / aborted).
- `ai-generation` trace — every generation and stream: provider, model,
  first-token latency, stream size, fallback attempts, errors.

Configure in `backend/.env`: `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`. Tracing is fully optional and fail-safe — with keys
unset the app behaves identically and logs a single "tracing disabled" line.
By default **no contract text leaves the machine**: only sizes, latencies and
metadata are recorded. Set `LANGFUSE_LOG_CONTENT=true` to also record raw
prompts/completions.

## API

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/upload` | POST | multipart upload → extract → chunk → BM25 → embeddings → persist (422 on scanned/unreadable) |
| `/api/documents` | GET | library for the session cookie |
| `/api/documents/:docId` | GET / DELETE | open one document / delete it (cascades to indexes + chats) |
| `/api/documents/:docId/status` | GET | processing status |
| `/api/chat` | POST | SSE stream: retrieval → gate → (agent ≤ 4 rounds) → generation → quote verification → persistence |
| `/api/chat/conversations` | GET | list conversations |
| `/api/chat/conversations/:id` | GET | reopen one conversation |
| `/api/compare` | POST | clause-level comparison: section-number alignment, numeric-aware severity (CRITICAL/MODERATE/MINOR), grounded plain-language summaries |
| `/health` | GET | liveness + Redis latency |

SSE events: `token`, `agent_step`, `quote_verified`, `quote_rejected`,
`notice`, `done` (`stopped` flag), `error`.

## What is finished

- PDF/DOCX ingestion with offset-true parent/child chunks; per-page mapping;
  scanned-PDF rejection (nothing saved, clear 422 message).
- Session-scoped document library (list / open / delete with full cleanup,
  including chats) with cross-session isolation tests.
- Hybrid retrieval (BM25 + dense, RRF-fused) across multiple documents with a
  single query embedding per request.
- Evidence gate (sufficient / agentic / abstain) on RRF-scale floors.
- Part C Option 2 agentic loop: `search_document`, `get_section`,
  `list_clauses`; hard 4-round cap; malformed/unknown tool calls handled
  without crashing; every tool call streamed as an `agent_step` event.
- SSE chat with streaming tokens; stop mid-answer keeps the partial and marks
  it `stopped`; per-selection conversation history, capped at 50 messages.
- Whitespace-tolerant quote verification with canonical offset mapping, page
  derivation, and occurrence counts; rejected quotes emit `quote_rejected`
  and are never rendered as genuine. Verified live end-to-end: a page-140
  clause of a 150-page contract answers with the correct page attribution.
- Clause-level document comparison: alignment by section number with
  token-overlap fallback, numeric-change detection (a moved liability cap is
  CRITICAL even when wording is identical), severity filter/sort, grounded
  one-line summaries per change. One-change demo yields exactly one CRITICAL.
- 277 passing tests (unit + integration) covering the chunker invariants,
  BM25, stores, retrieval, the verifier (document-level red-team cases),
  the agent loop (hard cap, unknown tools, malformed calls, argument
  validation, abort), comparison alignment/classification, upload seam,
  library, deletion cleanup, and session isolation. CI runs secret scan →
  typecheck → tests → build.

## What is not finished

- **No frontend.** The `frontend/` directory is empty — there is no UI for
  upload, library, chat, or citation highlighting. All features above are
  API-only for now.
- **No citation highlighting (Part B #5) end-to-end.** The backend emits
  verified `startOffset`/`endOffset`/`page` per quote, but there is no viewer
  to scroll and highlight.
- **No deployment.** The app runs locally; there is no live URL yet.
- 150-page verification is partial: full ingestion with real embeddings is
  rate-limit-gated on the free Gemini tier; the page-140 test ran with
  BM25-only retrieval (embeddings mocked empty) through the real gate,
  agent, generation, and verifier.
- Gate thresholds are scale-corrected but not yet calibrated against the
  golden-question fixture set (Guidebook §13.3).
- No demo video, note, or screenshots yet.
