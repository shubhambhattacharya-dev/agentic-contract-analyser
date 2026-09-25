# Elcara — Agentic Contract Analyser

Upload a legal contract (PDF or DOCX), ask questions about it in a chat, and get
answers backed by **verified quotes**: every quote is located in the canonical
document text by deterministic code before it is shown — invented or
paraphrased quotes are never presented as genuine. Clicking a citation opens
the document at the exact verified passage, highlighted.

![Chat with verified citations](frontend/public/screenshots/2-chat-verified-citation.png)

## Features (all implemented and tested)

- **PDF / DOCX upload** — clear rejection of other types; scanned (text-less)
  PDFs are refused with a 422 and nothing is saved
- **Document library** — list, open, delete (deletes indexes + chats too),
  per-session isolation, processing status
- **Grounded chat** — retrieval → evidence gate → (agent) → generation →
  verification, streamed over SSE token-by-token
- **Stop generation** — partial answer is kept and marked *stopped*
- **Verified quotes** — whitespace-tolerant matching, canonical offsets, page
  attribution, occurrence counts; rejected quotes emit a visible notice and
  are never shown as genuine
- **Citation highlighting** — click a citation → the viewer scrolls to and
  highlights the exact verified passage (page-correct, cross-page capable)
- **Multi-document questions** — select up to 5 documents; every quote is
  labelled and verified against its own document
- **Document comparison** — clause-level alignment (section-number + similarity
  fallback), numeric-aware severity (a cap moving 100,000 → 1,000,000 is
  CRITICAL even when wording is identical), grounded plain-language summaries,
  filter by change kind
- **Agentic research (Part C, Option 2)** — `search_document`, `get_section`,
  `list_clauses` through a trusted executor; hard 4-round cap; malformed or
  invented tool calls handled without crashing; live `agent_step` events
- **Conversation history** — per document-selection, reopenable, capped
- **Dark mode**, loading/empty/error states, responsive layout

## Architecture

```
frontend/  Next.js 14 (App Router) + Tailwind — Vercel
  src/lib/       typed API client, SSE parser, highlight math (pure, tested)
  src/hooks/     chat state machine (abort-safe), theme
  src/components/ sidebar, library, chat, viewer, sections, metadata, compare
backend/   Express 5 + TypeScript (strict) API server — Render
  services/
    ingestion/     extract (pdf-parse/mammoth) → structure → offset-true chunks
    retrieval/     BM25 + Gemini embeddings + RRF fusion + evidence gate
    ai/            provider abstraction (Groq/Gemini + fallback), agent loop,
                   tool registry, trusted tool executor
    verification/  whitespace-tolerant quote verifier (pure, deterministic)
    comparison/    clause alignment, severity classification, summaries
  lib/             Redis/Blob storage gateway (dev: ioredis + local FS,
                   prod: Upstash REST + Vercel Blob) + Langfuse tracing
```

**Design law: the LLM proposes; deterministic code disposes.** Model output is
untrusted end to end — quotes are verified against the canonical text,
offsets/pages are computed by the verifier (never read from the model), and
tool calls execute through a server-side executor that injects the session and
document scope.

## Running locally

```bash
# Redis (host port 6380 — see note in docker-compose.yml)
docker compose up -d redis

# Backend
cd backend
cp ../.env.example .env     # fill GROQ_API_KEY + GOOGLE_GENERATIVE_AI_API_KEY
npm ci && npm run dev       # http://localhost:8000

# Frontend (separate terminal)
cd frontend
npm ci && npm run dev       # http://localhost:3000 (proxies /api to :8000)

# Checks
cd backend  && npm run typecheck && npm test && npm run build
cd frontend && npm run typecheck && npm test && npm run build
```

All environment variables are validated at boot (Zod) — see `.env.example`.
Optional Langfuse LLM tracing: set `LANGFUSE_BASE_URL`/`PUBLIC_KEY`/`SECRET_KEY`
(cloud or `docker compose up -d langfuse`); disabled by default and
fail-safe, with `LANGFUSE_LOG_CONTENT=true` opted-in for raw prompts.

## Deployment

- **Backend → Render**: Blueprint from `render.yaml` (build `npm ci && npm run build`, start `node dist/index.js`, health `/health`). Env: `NODE_ENV=production`, Upstash Redis REST credentials, Vercel Blob token, provider keys, `ALLOWED_ORIGINS=https://<your-vercel-url>`.
- **Frontend → Vercel**: root directory `frontend`, env `NEXT_PUBLIC_API_URL=https://<render-app>.onrender.com`.
- Cookies are `SameSite=None; Secure` in production for the cross-origin flow; CORS is origin-restricted via `ALLOWED_ORIGINS`.

## Part C — Option 2: agentic document research

Weak retrieval evidence escalates to a ReAct-style research loop. The model
chooses one action per round from `search_document` / `get_section` /
`list_clauses`; every call is validated (name, arguments, trusted session and
document scope injected server-side) and streamed to the UI as an
`agent_step` event. The loop hard-stops at 4 rounds, and the final answer —
whether from direct retrieval or the agent — passes through the same quote
verifier, so the agent cannot bypass grounding.

## Testing

- Backend: **285 tests** (unit + integration) — chunker invariants and
  hardening (structured text, oversized tokens), BM25, stores, retrieval,
  verifier red-team cases, agent-loop safety, comparison, upload seam,
  library, deletion cleanup, session isolation, ghost-document protection.
- Frontend: **17 tests** — SSE parsing, highlight math, upload validation.
- CI: GitHub Actions — secret scan → backend (typecheck, tests, build against
  a live Redis) → frontend (typecheck, tests, build).
- Lint: not configured (not claimed).

## Known limitations

- Ingestion runs synchronously within the upload request; very large PDFs
  (>100 pages) can take a minute to process and there is no resumable queue.
- 150-page support is verified end-to-end with BM25-only retrieval (embeddings
  mocked) — the real-embedding run is gated on the free Gemini tier's daily
  quota; chunk/page/verify pipeline is identical either way.
- Gate thresholds are scale-corrected but not calibrated against a golden
  fixture set (procedure documented in the Build Guidebook §13.3).
- Quote verification is deliberately strict: heavily paraphrased "quotes" are
  rejected, so an answer may occasionally carry fewer citations than the model
  proposed — by design.
