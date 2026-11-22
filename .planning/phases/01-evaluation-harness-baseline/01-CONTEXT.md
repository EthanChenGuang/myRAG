# Phase 1: Evaluation Harness & Baseline - Context

**Gathered:** 2026-11-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver the measurement layer for the RAG upgrade, without changing retrieval or generation behavior:

- `rag-sidecar/` Python service skeleton (FastAPI, Pydantic v2 >=2.14.4, health/readiness, Dockerfile, shared-secret auth that fails closed).
- Pydantic as the single source of truth for structured contracts, with generated Zod schemas on the TypeScript side and a CI parity check.
- An authenticated internal endpoint `POST /api/internal/rag/run` that runs today's real retrieval code and returns a trace.
- A committed synthetic zh/en/it fixture corpus and fixture golden set, an eval runner with deterministic metrics (Recall@k, MRR, correct-refusal rate, false-refusal rate) per language and category, and a committed three-run baseline.
- Judge metrics (Faithfulness, Answer Relevance, Context Recall) via DeepEval and Ragas for the nightly tier, verified with a stubbed judge.
- A golden-set drafting tool that writes span-labelled items for a real workspace to a gitignored location with a frozen dev/test split.
- CI: PR smoke tier and nightly tier, schema parity, config-location check, characterization tests that lock today's behavior.

Out of this phase: any change to how retrieval or generation behaves (later phases), real-customer golden items in git, live-key runs (recorded as live verification).

</domain>

<decisions>
## Implementation Decisions

### Running today's retrieval with no live services
- The eval harness runs the repo's real retrieval code (`enhancedRetrieveChunks` and the chat route's post-retrieval filter: similarity > 0.65, document-name match, or image > 0.25) against PGlite (in-process Postgres with the pgvector extension) loaded with the repo's real SQL function definitions, behind a Supabase-compatible `rpc()` adapter — **Reversibility:** costly — new runtime dependency (`@electric-sql/pglite`) that every later phase's eval and conformance tests will build on; replacing it means re-plumbing all DB-backed tests
- The eval endpoint contract is `POST /api/internal/rag/run`, disabled when `NODE_ENV=production` unless `RAG_EVAL_ENDPOINT_ENABLED=true`, authenticated with an `x-rag-eval-secret` header compared in constant time against `RAG_EVAL_SECRET` (refuse all requests when unset) — **Reversibility:** one-way — URL and auth contract consumed by the Python runner, CI and later phases
- The smoke tier invokes the endpoint's exported route handler in-process (same auth and handler code path) from a `tsx` harness; the live tier calls the same endpoint over HTTP with `--base-url` — **Reversibility:** costly — CI wiring and harness depend on it

### Golden set contract
- `GoldenItem` (Pydantic v2): `id`, `question`, optional `conversation` history, `language` (`zh` | `en` | `it`), `category` (`multi_turn` | `compound` | `exact_term` | `table` | `scanned` | `no_answer` | `general`), `answerable`, `expected_answer`, `gold_evidence` as a list of spans (`document`, `section`, `quote`), `review_status` (`draft` | `approved` | `rejected`), `provenance` (`synthetic_fixture` | `claude_draft` | `ragas_generated` | `human`), `split` (`dev` | `test`). Never chunk IDs — **Reversibility:** costly — persisted golden files and the user's review work depend on the schema
- Real-workspace golden items are written to a gitignored path (`eval/golden/private/`) and never committed (AGENTS.md rule 7); only the synthetic fixture golden set is committed — **Reversibility:** one-way — committing customer-derived data cannot be undone

### Contracts and tooling dependencies
- Pydantic v2 models in the sidecar are the single source of truth; their JSON Schema is exported and converted to Zod (zod 3, `zod/v3` import style) with `json-schema-to-zod`; generated files are committed and CI fails when regeneration produces a diff — **Reversibility:** costly — every later contract follows this pipeline
- New dev/tool dependencies: Vitest (TypeScript tests), `@electric-sql/pglite`, `json-schema-to-zod`, `tsx`; Python: FastAPI, uvicorn, pydantic>=2.14.4, httpx, pytest; eval package adds deepeval and ragas in a separate `pyproject.toml` so they never enter the production sidecar image; Python environments are managed with `uv` and a committed `uv.lock` — **Reversibility:** costly — new dependencies across CI and developer setup

### Decided autonomously
- [Fixture run] Q: "How are embeddings produced without live keys?" → Selected: "A deterministic local fixture embedder (hashed character n-grams to 1536 dims, L2-normalized), used only when the eval run explicitly selects it" — internal provider behind an explicit switch
- [Fixture run] Q: "How do TS and Python exchange results?" → Selected: "The TS harness writes JSONL traces (Pydantic-defined, Zod-validated); the Python runner scores them and writes a report JSON plus a Markdown summary" — internal file format
- [Baseline] Q: "How is the noise band defined?" → Selected: "Per metric: baseline mean minus max(3 x spread across the three runs, 0.02 absolute floor); a run below that fails" — a single config value
- [Baseline] Q: "Where does the baseline live?" → Selected: "eval/baselines/fixture-baseline.json, committed, with a config hash per run" — one file
- [Baseline] Q: "How is the failing-PR demo shown?" → Selected: "A test runs the gate against a deliberately degraded config (for example max results 1) and asserts that it fails" — test code only
- [Golden set] Q: "When does a retrieved chunk match gold evidence?" → Selected: "Same document and the chunk contains the normalized quote (whitespace, case, punctuation and width normalized; substring match, which works for Chinese without tokenization)" — metric code only
- [Golden set] Q: "How is the dev/test split frozen?" → Selected: "Hash of item id decides a 70/30 split, recorded in a split manifest; existing items never move" — recomputable
- [Golden set] Q: "Which judge model?" → Selected: "A pinned non-Claude judge through OpenRouter at temperature 0; config refuses a judge from the same model family as the generator; DeepEval and Ragas telemetry are disabled by env" — config value
- [CI] Q: "Which CI provider and layout?" → Selected: "GitHub Actions: a PR smoke workflow (deterministic metrics on the fixture corpus, schema parity, config check, type-check of new code, characterization tests, sidecar tests) and a nightly workflow (judge metrics, skipped with a notice when no judge key is configured); Node 22, Python 3.12" — workflow files
- [Config] Q: "How is config drift checked?" → Selected: "A manifest of RAG env vars plus a check-config script over scripts/init-env.js, src/lib/env.ts, scripts/config-server.js and scripts/config-ui/index.html, and .env.local when it exists" — script and JSON

### Claude's Discretion
- Exact fixture corpus content and size (synthetic, covering zh/en/it and every category, including tables, scanned-style text and no-answer questions).
- Report layout and wording for the eval Markdown summary.
- How the characterization tests isolate the 4,500-line chat route (module mocks for Supabase, the AI SDK, Exa).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/enhanced-rag-retrieval.ts` — `enhancedRetrieveChunks(query, options)`; calls `supabase.rpc('match_documents_by_workspace' | 'match_document_chunks')` via the module-level client from `./supabase`, and `getQueryEmbedding` from `./document-processor`.
- `src/app/api/chat/route.ts` (~L2083-2330) — today's post-retrieval filter and context assembly (similarity > 0.65, name match, image > 0.25), strict-mode block at ~L2572 (`buildNoKnowledgeBaseResponse`), `createEnhancedRAGPrompt` at ~L2699.
- `src/lib/api-middleware.ts` — `withValidation` / `validateRequest` Zod helpers; `zod/v3` import style.
- `supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql` — the SQL functions PGlite must load.
- `scripts/rag/` — existing diagnostics; `package.json` script `test-rag` points at a missing `scripts/test-rag-system.js`.

### Established Patterns
- kebab-case modules, `@/` alias, Zod validation with structured 400 errors, bracketed log prefixes, no new `any`.
- Env values read through `src/lib/env.ts`; new vars mirrored in `scripts/init-env.js`, `scripts/config-server.js`, Config UI.
- Sibling services (`voice-agent/`, `baileys-whatsapp/`) each have their own Dockerfile and package manifest.

### Integration Points
- New route `src/app/api/internal/rag/run/route.ts` next to existing internal routes (`src/app/api/internal/voice-rag/route.ts`).
- `package.json` scripts (`test-rag`, new `test`, eval scripts), new `.github/workflows/`.
- New top-level `rag-sidecar/` and `eval/` directories.

</code_context>

<specifics>
## Specific Ideas

- The user wants Claude to draft the real golden set and the user to review it; drafting must cover Chinese, English and Italian.
- Pydantic is the user's chosen standard output format for every structured output.
- Targets are set only after the baseline exists; this phase records the baseline, it does not set improvement targets.
- No live vendor keys or live Supabase project are available in this environment; every success criterion must be checkable with fixtures, and live runs are recorded as live verification steps.

</specifics>

<deferred>
## Deferred Ideas

- Running the real-knowledge-base baseline and calibrating thresholds (needs a workspace and keys; live verification).
- Production sampling into the eval pipeline (v2, OPS-01).

</deferred>
