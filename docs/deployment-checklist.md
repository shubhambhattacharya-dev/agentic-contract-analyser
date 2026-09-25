# Elcara — Deployment Checklist

## Backend → Render

| Item | Status | Evidence / Action |
|------|--------|-------------------|
| Backend build (`npm ci && npm run build`) | PASS | CI job green; local build ✓ |
| Start command (`node dist/index.js`) | PASS | runs locally from dist |
| PORT handling | PASS | `env.PORT` (Render injects `PORT`) — Zod coerces |
| HOST | PASS | defaults `0.0.0.0` |
| Health endpoint | PASS | `GET /health` (used as Render health check) |
| Redis (Upstash REST) | ACTION | create Upstash DB → set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` |
| Storage (Vercel Blob) | ACTION | create Blob store → set `BLOB_READ_WRITE_TOKEN` |
| AI providers | ACTION | set `GROQ_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` |
| CORS | PASS | set `ALLOWED_ORIGINS=https://<vercel-url>` (env-driven) |
| Cookies | PASS | production sets `SameSite=None; Secure` (cross-origin Vercel→Render) |
| Trust proxy | PASS | `app.set("trust proxy", 1)` |
| SSE | PASS | streaming verified cross-origin via Next dev proxy; Render supports streaming responses |
| Env validation | PASS | boot fails fast with clear messages if a var is missing |

**Render setup:** New + → Blueprint → select repo (uses `render.yaml`), or Web Service with root dir `backend`, build `npm ci && npm run build`, start `node dist/index.js`. Add the env vars above (NODE_ENV=production).

## Frontend → Vercel

| Item | Status | Evidence / Action |
|------|--------|-------------------|
| Production build | PASS | `npm run build` green (typecheck + tests included in CI) |
| Tests | PASS | 17/17 (SSE parser, highlight math, upload validation) |
| API URL | ACTION | set `NEXT_PUBLIC_API_URL=https://<render-backend>.onrender.com` |
| Secrets | PASS | only `NEXT_PUBLIC_*` is public; all provider keys live on Render |

**Vercel setup:** Import repo → root directory `frontend` → framework auto-detects Next.js → add `NEXT_PUBLIC_API_URL` → Deploy.

## Post-deploy verification (run against the live URLs)

1. `GET https://<render>/health` → `{"status":"ok"}`
2. Open the Vercel URL → upload a contract → ready
3. Ask a grounded question → streaming + verified citation
4. Click citation → highlight
5. Ask an absent question → honest refusal
6. Select 2 documents → compare
7. Reload → conversation persists
