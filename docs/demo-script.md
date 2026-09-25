# Elcara — Demo Video Script (target ~4 minutes)

Demo documents (repo-adjacent, generated, no personal data):
- `demo-a-master-agreement.pdf` (Master Services Agreement)
- `demo-b-amendment.pdf` (Amendment No. 1)

Demo questions (exact wording):
1. "What is the termination notice period?"
2. "What is the maximum financial exposure?" (agent-triggering, semantic)
3. "What is the pet deposit policy for tenants?" (absent information)
4. "Summarize this document in detail, clause by clause." (then Stop)

## Shot list

| Time | Action | Talk track |
|------|--------|------------|
| 0:00–0:20 | Show landing / library | "This is Elcara, an agentic contract analysis app. Upload contracts, ask grounded questions, verify the supporting quotes, jump to the evidence, and compare documents." |
| 0:20–0:50 | Upload demo-a | "PDF or DOCX — text extraction, page mapping, chunking and indexing all happen before the document is marked ready." |
| 0:50–1:30 | Ask Q1 | "Answers stream in, and every claim is backed by a citation. Note the badge — that's not decoration." |
| 1:30–2:00 | Click the citation | "The viewer opens the exact passage. The model does not decide whether its quote is genuine — the backend independently verifies each quote against the canonical text and computes the page and offsets itself." |
| 2:00–2:40 | Ask Q2 (agent) | "I chose Part C Option 2 — agentic research. Weak evidence escalates to a tool loop: search_document, get_section, list_clauses — hard-capped at four rounds — and the final answer still passes quote verification." |
| 2:40–3:00 | Ask Q3 (absent) | "Ask for something that isn't there and the system refuses instead of inventing a contract fact." |
| 3:00–3:20 | Select Q-long, click Stop | "Stop generation keeps the partial answer and marks it stopped — the backend persists it." |
| 3:20–3:50 | Compare A + B | "Upload two versions and the comparison works at clause level: the payment fee moved, the liability cap moved ten-x, the Services clause was removed, Insurance was added — renumbering alone is not reported as a change." |
| 3:50–4:10 | Library + dark mode + close | "History per document selection, dark mode, and the whole pipeline — retrieval, gate, agent, verification — is observable via Langfuse traces." |

## Recording checklist
- [ ] Production URLs (Vercel frontend, Render backend), not localhost
- [ ] Clean browser profile, notifications off, no terminal
- [ ] Demo docs A/B pre-uploaded or upload on camera
- [ ] Full dry run once before recording
- [ ] No .env, no API keys, no personal documents on screen
