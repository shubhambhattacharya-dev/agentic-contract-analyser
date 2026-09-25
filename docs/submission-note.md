# Elcara — Technical Note (submission)

## How quote verification works, and where it could fail

Every answer is generated under a strict contract: the model writes its answer
in plain text and must end with a JSON line listing candidate quotes. Those
candidates are **untrusted input**. The backend never reads page numbers or
offsets from the model — it locates each quote itself by normalizing the
canonical document text (NFC, smart quotes → ASCII, dashes, zero-width
removal, whitespace collapsing, lowercasing) while recording, for every
normalized character, the canonical offset it came from. A match in
normalized space maps back to exact canonical `(start, end)` offsets, and the
final safety check re-normalizes the sliced original text and demands it equal
the normalized quote — so a verified highlight can never land on the wrong
characters. Page numbers are derived by binary range lookup over the page map;
occurrences are counted directly. **Where it can fail:** quotes spanning a
chunk boundary are still found (verification runs on the whole document, not
per chunk), but heavy *paraphrasing* — a quote with even one word changed —
is rejected by design; very short quotes (< 3 normalized characters) are
rejected; and documents whose extraction scrambles word order (rare, broken
PDFs) would defeat any offset-based verifier.

## How I handled large documents

Documents become one canonical string plus a page map. Chunking produces
parent chunks (~1,800 tokens, for generation context) and child chunks
(≤200 tokens, for retrieval), both stored as exact offset spans of the
canonical text — children are sized by their real span so PDF-layout
whitespace can't overflow them, and pathological single tokens (base64 blobs,
long URLs) are split at character boundaries. Retrieval is hybrid: BM25 over
children plus dense embeddings, fused with Reciprocal Rank Fusion; a single
query embedding is shared across all selected documents. An evidence gate
decides sufficient / agentic / abstain, so weak evidence is escalated to the
tool-using agent instead of guessed at, and no-overlap questions abstain
without calling the model. Verified at 150-page scale: a question aimed at a
page-140 clause answers with the quote verified and page 140 attributed.
When the embedding provider is rate-limited, ingestion degrades to BM25-only
mode instead of failing the upload.

## Part C — Option 2 (agentic document research)

I chose Option 2 because it compounds with the grounding architecture: the
agent's tools (`search_document`, `get_section`, `list_clauses`) are executed
through a server-side executor that injects the session and document scope —
the model can widen neither — and every observation is wrapped as data, never
instructions. The loop runs a hard maximum of 4 rounds (`MAX_AGENT_ROUNDS`
is validated at boot); malformed JSON, unknown tools, and invalid arguments
are normalized into error observations instead of crashing the request.
Hardest part: making the tools genuinely useful under the round cap — tool
results are bounded (top-K evidence, section text limits) so four rounds
still fit the generation budget, and the final answer passes through the same
quote verifier as direct answers, so the agent cannot bypass grounding.

## What I would build next

1. Resumable background ingestion (client- or worker-driven batches with a
   status machine) so 150+ page uploads survive serverless timeouts.
2. Golden-set gate calibration wired into CI: answerable-vs-absent score
   distributions per fixture drive the gate thresholds.
3. Contract-aware section tree (clause hierarchy + defined-terms index)
   powering the sections tab and comparison alignment simultaneously.
