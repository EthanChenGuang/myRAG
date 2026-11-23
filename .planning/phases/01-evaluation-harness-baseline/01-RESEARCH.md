# Phase 1: Evaluation Harness & Baseline - Research

**Researched:** 2026-11-23
**Domain:** RAG evaluation harness (TS retrieval in-process + Python scoring), Pydantic-to-Zod contracts, PGlite-backed fixture retrieval, characterization tests, GitHub Actions gating
**Confidence:** MEDIUM-HIGH (all load-bearing mechanics were spiked end to end in this session; vendor/CI facts that could not be reached are tagged `[ASSUMED]`)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Running today's retrieval with no live services**
- The eval harness runs the repo's real retrieval code (`enhancedRetrieveChunks` and the chat route's post-retrieval filter: similarity > 0.65, document-name match, or image > 0.25) against PGlite (in-process Postgres with the pgvector extension) loaded with the repo's real SQL function definitions, behind a Supabase-compatible `rpc()` adapter — **Reversibility:** costly — new runtime dependency (`@electric-sql/pglite`) that every later phase's eval and conformance tests will build on; replacing it means re-plumbing all DB-backed tests
- The eval endpoint contract is `POST /api/internal/rag/run`, disabled when `NODE_ENV=production` unless `RAG_EVAL_ENDPOINT_ENABLED=true`, authenticated with an `x-rag-eval-secret` header compared in constant time against `RAG_EVAL_SECRET` (refuse all requests when unset) — **Reversibility:** one-way — URL and auth contract consumed by the Python runner, CI and later phases
- The smoke tier invokes the endpoint's exported route handler in-process (same auth and handler code path) from a `tsx` harness; the live tier calls the same endpoint over HTTP with `--base-url` — **Reversibility:** costly — CI wiring and harness depend on it

**Golden set contract**
- `GoldenItem` (Pydantic v2): `id`, `question`, optional `conversation` history, `language` (`zh` | `en` | `it`), `category` (`multi_turn` | `compound` | `exact_term` | `table` | `scanned` | `no_answer` | `general`), `answerable`, `expected_answer`, `gold_evidence` as a list of spans (`document`, `section`, `quote`), `review_status` (`draft` | `approved` | `rejected`), `provenance` (`synthetic_fixture` | `claude_draft` | `ragas_generated` | `human`), `split` (`dev` | `test`). Never chunk IDs — **Reversibility:** costly — persisted golden files and the user's review work depend on the schema
- Real-workspace golden items are written to a gitignored path (`eval/golden/private/`) and never committed (AGENTS.md rule 7); only the synthetic fixture golden set is committed — **Reversibility:** one-way — committing customer-derived data cannot be undone

**Contracts and tooling dependencies**
- Pydantic v2 models in the sidecar are the single source of truth; their JSON Schema is exported and converted to Zod (zod 3, `zod/v3` import style) with `json-schema-to-zod`; generated files are committed and CI fails when regeneration produces a diff — **Reversibility:** costly — every later contract follows this pipeline
- New dev/tool dependencies: Vitest (TypeScript tests), `@electric-sql/pglite`, `json-schema-to-zod`, `tsx`; Python: FastAPI, uvicorn, pydantic>=2.14.4, httpx, pytest; eval package adds deepeval and ragas in a separate `pyproject.toml` so they never enter the production sidecar image; Python environments are managed with `uv` and a committed `uv.lock` — **Reversibility:** costly — new dependencies across CI and developer setup

**Decided autonomously**
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

### Deferred Ideas (OUT OF SCOPE)
- Running the real-knowledge-base baseline and calibrating thresholds (needs a workspace and keys; live verification).
- Production sampling into the eval pipeline (v2, OPS-01).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| EVAL-01 | `rag-sidecar/` FastAPI service, Python 3.12, `pydantic>=2.14.4`, health/readiness, Dockerfile, constant-time shared-secret auth failing closed | Sidecar section; uv Dockerfile pattern; `hmac.compare_digest`; fastapi 0.165.0 needs Python >=3.11 |
| EVAL-02 | Pydantic is the single source; Zod generated; CI fails on stale Zod | Pydantic-to-Zod pipeline (raw `json-schema-to-zod` output is wrong on Pydantic schemas; preprocess step spiked and verified) |
| EVAL-03 | Span-based gold evidence, language, category, review status, never chunk IDs | `GoldenItem` model + span matcher definition |
| EVAL-04 | Committed trilingual fixture corpus and golden set | Fixture corpus design (embedder behaviour measured in spike) |
| EVAL-05 | Drafting tool, private gitignored output, frozen split | Drafting tool design; split manifest; quote-verification step |
| EVAL-06 | Authenticated internal endpoint returning a trace | Endpoint contract, trace shape, in-process invocation verified (`NextRequest` under `tsx`) |
| EVAL-07 | Recall@k, MRR, correct-/false-refusal without a judge | Metric definitions; refusal derivation from route code |
| EVAL-08 | Faithfulness / Answer Relevance / Context Recall via DeepEval + Ragas, pinned judge, telemetry off, per language/category | Stub-judge spike (zero outbound connections observed); telemetry variable names verified in source |
| EVAL-09 | Three-run baseline with config hash, mean, spread | Baseline procedure; determinism implication (spread is 0) |
| EVAL-10 | PR smoke + nightly CI; PR fails beyond noise band | Workflow layout; gate script; negative-control job |
| EVAL-11 | `npm run test-rag` runs smoke tier | Missing-script finding |
| EVAL-12 | Characterization tests for strict refusal, webSearch+strict, source_images, `{{context}}` | Three Vitest tests spiked against the real route; one tsx-run unit test for `{{context}}` |
| EVAL-13 | Config manifest + `check-config` in CI | Drift matrix measured on today's tree (only 15 of 51 vars are in all four tracked files) |
</phase_requirements>

## Summary

Every mechanism this phase depends on was exercised in a scratch copy of the repo (`npm ci`, then spikes). The headline results: (1) the repo's **entire** `supabase/single-tenant-setup.sql` and `multi-tenant-setup.sql` load unmodified into PGlite 0.5.17 + `@electric-sql/pglite-pgvector` 0.0.18 in about 1.5 s each once a small shim (3 roles, an `auth` schema with `users`/`uid()`/`role()`/`jwt()`, a `storage` schema with `buckets`/`objects`) exists, including the `hnsw (m=64, ef_construction=200)` index; (2) the **unmodified** `enhancedRetrieveChunks` runs end to end against PGlite with **zero production code changes** by pointing two environment variables at an in-process fake edge (`NEXT_PUBLIC_SUPABASE_URL` at a tiny PostgREST-compatible HTTP shim backed by PGlite, `OPENAI_BASE_URL` at a fake `/v1/embeddings`); (3) the real 4,500-line chat route can be driven from Vitest with module mocks for the strict-refusal, webSearch+strict and `source_images` behaviours.

Several findings change the plan versus CONTEXT's assumptions and the planner must account for them: the chat route applies **two** post-retrieval filters, not one, and the first one has a CJK defect that makes it pass everything for Chinese queries; today's strict refusal fires only when the first filter leaves the context empty; only 15 of 51 RAG-related env vars are present in all four tracked config files, so `check-config` needs a grandfathered-gaps ratchet or it fails on day one; raw `json-schema-to-zod` output silently turns every `$ref` into `z.any()` and emits Zod-4-only types for discriminated unions; with a deterministic embedder the "three runs" have zero spread so the 0.02 floor is the entire noise band; and vitest 5 breaks under the repo's `legacy-peer-deps` unless `vite@^7` is declared explicitly.

**Primary recommendation:** Build the harness on the "edge fakes" seam (PGlite + fake PostgREST + fake OpenAI embeddings, no production edits), replicate the route's two filters in a pure module guarded by a source-sentinel test, generate Zod from Pydantic through a deref-and-normalize step, and ratchet config drift with an explicit grandfather list.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Eval endpoint `POST /api/internal/rag/run` (auth, trace) | API / Backend (Next route handler) | — | Must run the real TS retrieval; Python only scores |
| Retrieval against fixture corpus | Database / Storage (PGlite with repo SQL) | API / Backend | Real SQL functions are the system under test |
| Fixture embeddings | API / Backend (fake edge in harness process) | — | Replaces OpenAI over `OPENAI_BASE_URL`, test-only |
| Deterministic metrics, baseline compare, gate | Python eval package | CI | Scoring is not a production concern; keep it out of the sidecar image |
| Judge metrics (DeepEval/Ragas) | Python eval package (nightly) | — | Heavy deps (langchain family, grpc, posthog) must not enter the sidecar image |
| Pydantic contracts | Python sidecar package | Generated Zod in `src/` | Single source of truth, TS side generated |
| Sidecar auth, health, readiness | Python sidecar (FastAPI) | Container platform probes | Fails closed; probes need an unauthenticated path |
| Config drift check | Node script (`scripts/`) | CI | Parses JS/TS/HTML text files; no runtime dependency |
| Golden drafting | Python eval package | Supabase read (live) | Private output, gitignored |
| Characterization tests | Vitest (Node) | — | Mocks Supabase, AI SDK, Exa around the real route |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@electric-sql/pglite` | 0.5.17 (published 2026-11-19) | In-process Postgres for fixture retrieval | Locked by CONTEXT; spiked end to end |
| `@electric-sql/pglite-pgvector` | 0.0.18 | pgvector for PGlite | In this PGlite line the vector extension is a **separate package** and its peer dependency is the exact pin `"@electric-sql/pglite": "0.5.17"` — pin both exactly, update together |
| `json-schema-to-zod` | 2.8.1 (2026-04-01) | JSON Schema to Zod source | Locked by CONTEXT; needs the preprocess below |
| `tsx` | 4.23.15 | Run TS harness with `@/` alias | Resolves `tsconfig` `paths`; verified importing `@/lib/enhanced-rag-retrieval` in ~330 ms |
| `vitest` | 5.1.1 (2026-11-18) | TS tests incl. route characterization | Requires Node `^22.12 \|\| ^24 \|\| >=26` and `vite ^6.4 \|\| ^7 \|\| ^8` |
| `vite` | 7.3.8 (explicit devDependency) | Vitest peer | Without it, `llamaindex` pulls a nested `vitest@2.1.9` and hoists `vite@5.4.21`, and vitest 5 dies with `ERR_PACKAGE_PATH_NOT_EXPORTED ./module-runner` (reproduced, then fixed by adding `vite@7.3.8`) |
| `fastapi` | 0.165.0 (requires Python >=3.11) | Sidecar | Locked by CONTEXT |
| `uvicorn` | 0.54.0 | ASGI server | Locked by CONTEXT |
| `httpx` | 0.28.1 | Sidecar test client / eval HTTP | Locked by CONTEXT |
| `pytest` | 9.2.0 | Python tests | Locked by CONTEXT |
| `pydantic` | >=2.14.4 (2.14.4 current, also installed system-wide) | Contracts | Locked by CONTEXT |

### Supporting (eval package only, separate `pyproject.toml`)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `deepeval` | 4.3.4 (requires Python >=3.10,<4) | Faithfulness / Answer Relevancy / Contextual Recall | Nightly tier and stub-judge tests |
| `ragas` | 0.4.4 | Second judge implementation, testset generation | Nightly tier; `ragas.testset.TestsetGenerator` for EVAL-05 (live only) |
| `anthropic` | 2.12.0 | Claude drafting of golden items | Drafting tool (not the judge) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Edge fakes (env-pointed fake PostgREST + OpenAI) | A small additive DI seam in `enhanced-rag-retrieval.ts` (`setRetrievalDependencies`) | In-process and simpler to read, but edits production code and is thrown away when Phase 2 re-homes retrieval. Fall back to it only if the fake PostgREST proves too costly |
| `vi.mock('./supabase')` | — | Not usable from a `tsx` harness (no module mocking); fine inside Vitest only |
| `vitest@3.x` | Works on Node 20 | Would avoid the Node >=22 requirement; not verified. CI is Node 22 and PIPE-10 moves the repo there, so use 5.1.1 |

**Installation:**
```bash
npm i -D --save-exact @electric-sql/pglite@0.5.17 @electric-sql/pglite-pgvector@0.0.18
npm i -D json-schema-to-zod@2.8.1 tsx@4.23.15 vitest@5.1.1 vite@7.3.8
# rag-sidecar/
uv init --package && uv add "fastapi==0.165.0" "uvicorn==0.54.0" "httpx==0.28.1" "pydantic>=2.14.4" && uv add --dev "pytest==9.2.0"
# eval/
uv add "deepeval==4.3.4" "ragas==0.4.4" "anthropic==2.12.0" "pydantic>=2.14.4" && uv add --dev "pytest==9.2.0"
```

**Version verification:** All versions above were read from the npm and PyPI registries this session (`npm view`, PyPI JSON API); the npm set was installed in a scratch copy with `npm ci --ignore-scripts` plus the devDependencies, and the Python set was installed into a uv venv on Python 3.12.

## Package Legitimacy Audit

Ran `gsd-tools query package-legitimacy check`. Every `SUS` below is caused only by `too-new` (a release in the last few weeks) and/or `unknown-downloads` (PyPI exposes no download counts to the checker); none carries a postinstall script, deprecation, or missing-repo signal except `deepeval` (`no-repository` metadata on PyPI). These are all high-profile, long-established projects, so the planner should satisfy the protocol with **one** `checkpoint:human-verify` task covering the whole dependency list rather than one per package.

| Package | Registry | Age / latest | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|--------------|-----------|-------------|---------|-------------|
| `@electric-sql/pglite` | npm | 0.5.17, 2026-11-19 | 44.2M/wk | github.com/electric-sql/pglite | SUS (too-new) | Flagged, single human-verify checkpoint |
| `@electric-sql/pglite-pgvector` | npm | 0.0.18, 2026-11-19 | 2.2M/wk | github.com/electric-sql/pglite | SUS (too-new) | Flagged; same maintainers as pglite |
| `json-schema-to-zod` | npm | 2.8.1, 2026-04-01 | 4.7M/wk | github.com/StefanTerdell/json-schema-to-zod | OK | Approved |
| `tsx` | npm | 4.23.15, 2026-09-20 | 146M/wk | — | OK | Approved |
| `vitest` | npm | 5.1.1, 2026-11-18 | 195M/wk | github.com/vitest-dev/vitest | SUS (too-new) | Flagged |
| `vite` | npm | 7.3.8, 2026-11-11 | 289M/wk | — | SUS (too-new) | Flagged |
| `fastapi` | PyPI | 0.165.0, 2026-11-18 | n/a | github.com/fastapi/fastapi | SUS (too-new, unknown-downloads) | Flagged |
| `uvicorn` / `httpx` / `pytest` | PyPI | 2026-09 / 2024-12 / 2026-10 | n/a | github.com/Kludex/uvicorn, encode/httpx, pytest-dev/pytest | SUS (unknown-downloads) | Flagged |
| `pydantic` | PyPI | 2.14.4, 2026-11-19 | n/a | — | SUS (too-new, unknown-downloads) | Flagged (user-mandated version floor) |
| `deepeval` | PyPI | 4.3.4, 2026-11-11 | n/a | none in metadata | SUS (too-new, unknown-downloads, no-repository) | Flagged |
| `ragas` | PyPI | 0.4.4, 2026-11-14 | n/a | — | SUS (too-new, unknown-downloads) | Flagged |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** all rows marked SUS above; planner inserts one `checkpoint:human-verify` before the first install task.

## Architecture Patterns

### System Architecture Diagram

```
                       PR smoke (no keys, no network)
 eval/fixtures/corpus ──► harness (tsx, repo root cwd) ──────────────────────────────┐
 eval/fixtures/golden.jsonl        │                                                  │
                                   ▼                                                  │
        ┌──────────────── one Node process ─────────────────────────┐                │
        │ PGlite + pgvector ◄── repo supabase/*.sql (+ auth shim)    │                │
        │      ▲                                                     │                │
        │ fake PostgREST (127.0.0.1:port) ◄─ NEXT_PUBLIC_SUPABASE_URL│                │
        │ fake /v1/embeddings (hashed n-gram) ◄─ OPENAI_BASE_URL     │                │
        │      ▲                                                     │                │
        │ real enhancedRetrieveChunks (supabase-js + OpenAI SDK)     │                │
        │      ▲                                                     │                │
        │ route handler POST (src/app/api/internal/rag/run/route.ts) │                │
        │   auth(x-rag-eval-secret) → retrieve → legacy post-filter  │                │
        │   → context → refusal decision → RagTrace                  │                │
        └───────────────▲────────────────────────────────────────────┘                │
        NextRequest per golden item (in-process)                                      │
                                   │ JSONL traces (Zod-validated on write)            │
                                   ▼                                                  │
        eval/out/<run>/traces.jsonl ──► python -m rag_eval (Pydantic-validated)       │
              metrics (Recall@k, MRR, refusal) per language × category                │
              report.json + report.md ──► gate vs eval/baselines/fixture-baseline.json ──► exit 0/1
 Live tier: same runner, `--base-url https://…` instead of in-process harness
 Nightly:   traces ──► judge (DeepEval + Ragas, pinned non-Claude judge, telemetry off)
```

### Recommended Project Structure

```
rag-sidecar/
├── pyproject.toml  uv.lock  .python-version(3.12)  Dockerfile  .dockerignore
├── src/rag_sidecar/{main.py,auth.py,settings.py,contracts/*.py,export_schemas.py}
├── schemas/*.schema.json            # generated, committed, sorted keys
└── tests/                           # pytest: auth matrix, health/ready, schema export
eval/
├── pyproject.toml  uv.lock          # path-depends on ../rag-sidecar for contracts
├── src/rag_eval/{metrics.py,matching.py,runner.py,gate.py,report.py,split.py,judge/,draft/}
├── fixtures/{corpus/{zh,en,it}/*.md, golden.jsonl}
├── baselines/fixture-baseline.json
├── config/{rag-eval-env.json,noise.json,judge.json}
├── harness/{run-smoke.mts,pglite-supabase.mts,fake-edge.mts,fixture-embedder.mts}
├── golden/private/                  # gitignored; add to .gitignore
└── tests/                           # pytest
src/lib/rag-eval/{contracts.generated.ts,legacy-post-filter.ts,trace.ts,auth.ts}
src/app/api/internal/rag/run/route.ts
tests/{setup-env.ts,chat-strict.test.ts,chat-websearch.test.ts,chat-source-images.test.ts,eval-route.test.ts,...}
scripts/check-config.mjs   scripts/rag/env-manifest.json   scripts/gen-zod.mjs
vitest.config.ts  tsconfig.eval.json
.github/workflows/{pr-smoke.yml,nightly.yml}
```

Use `.mts` for harness entry points: the root `package.json` has no `"type": "module"`, so a `.ts` file runs as CJS under `tsx` and top-level `await` fails with `Top-level await is currently not supported with the "cjs" output format` (reproduced). Alternatively wrap in `async function main()`.

### Pattern 1: PGlite loaded with the repo's real SQL

**What:** Create the shim, then `db.exec()` the whole repo SQL file. Both files load as-is. One PGlite instance per deployment mode (the two files define a different `match_document_chunks`).
**Verified shim (all six pieces are required; each removal failed in the spike):**
```ts
// Source: spike, repo supabase/single-tenant-setup.sql and multi-tenant-setup.sql loaded OK (~1.5 s each)
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';   // setup SQL does CREATE EXTENSION pg_trgm

const db = new PGlite({ extensions: { vector, pg_trgm } });
await db.exec(`
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text, name text, owner uuid);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`);
await db.exec(fs.readFileSync('supabase/single-tenant-setup.sql', 'utf8'));   // real functions, real HNSW index
```
Read the SQL from the repo at harness start (never copy it), so a change to the SQL functions changes the eval. The resulting index is `USING hnsw (embedding vector_cosine_ops) WITH (m='64', ef_construction='200')` (observed via `pg_indexes`). The multi-tenant file also loaded; its `match_documents_by_workspace` was **loaded but not yet called** (needs rows in `auth.users`, `documents.user_id`).
Calling a function the way PostgREST does: named arguments, vector as text: `SELECT * FROM match_document_chunks(query_embedding => $1, similarity_threshold => $2, match_count => $3)` with `$1 = '[0.1,...]'` worked.

### Pattern 2: Edge fakes as the injection seam (recommended, no production edits)

**What:** The unmodified code reaches Supabase through `supabase-js` (`NEXT_PUBLIC_SUPABASE_URL`) and embeddings through the OpenAI SDK (`OPENAI_BASE_URL`). Start one `http` server on `127.0.0.1:0` in the harness process, then set the env vars, then dynamically import the route. Verified output: `RESULT strategy= Semantic Only n= 1 / 0.413 ... http calls ["POST /v1/embeddings","POST /rest/v1/rpc/match_document_chunks"]`.
**Rules learned the hard way:**
- Set `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (placeholders) **before** importing anything from `@/lib`: `src/lib/env.ts` builds a frozen snapshot at import and **throws** when `OPENAI_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY` is empty outside production.
- The OpenAI SDK (4.104.0) requests `"encoding_format":"base64"`. A fake that returns a float array makes the SDK produce a vector of 384 numbers and PGlite fails with `different vector dimensions 1536 and 384`. Return `Buffer.from(new Float32Array(vec).buffer).toString('base64')` when `encoding_format === 'base64'`.
- Fake PostgREST needs only: `POST /rest/v1/rpc/<fn>` (JSON body to named args, arrays to `'[..]'`), and `GET /rest/v1/<table>?select=&<col>=eq.<v>` honouring `Accept: application/vnd.pgrst.object+json` for `.single()` (406 with `PGRST116` when not exactly one row). Whitelist table and column identifiers; return a loud 404/400 for any unsupported operator so a future change in retrieval code fails visibly.
- Bind to `127.0.0.1` only. PGlite is single-connection, so serialize requests.
- `src/lib/supabase/client.ts` returns `{}` when URL or anon key is empty, so the placeholders must be non-empty.
**Why not DI:** `tsx` has no module mocking, `supabase` in `src/lib/supabase.ts` is a Proxy over a private singleton, and this seam survives Phase 2 as long as legacy retrieval still uses supabase-js and the OpenAI SDK. If the planner prefers an in-process adapter, the fallback is three edit points in `enhanced-rag-retrieval.ts` (two `supabase.rpc` calls, one `getQueryEmbedding` call) behind a module-level `setRetrievalDependencies()`.

### Pattern 3: Eval route handler, replicating the chat route's post-retrieval logic

The route code is not a function; it is inline in `POST`. Facts read from `src/app/api/chat/route.ts` this session:

- Query text is the **last user message only** (`queryText = contextUserMessage.content` / text part); history is not used for retrieval.
- Retrieval call (L2117-2125): `maxResults: parseInt(env.RAG_FINAL_RESULT_COUNT || '25')` with `enableTemporalBoost: true`, `enableFinancialBoost: true`, `requireTemporalMatch: false`, `fallbackToLowerThreshold: true`. `RAG_FINAL_RESULT_COUNT` is **absent from `src/lib/env.ts`**, so `env.RAG_FINAL_RESULT_COUNT` is always `undefined` and the route always uses 25 whatever the Config UI says. Mirror it by reading the same `env` import.
- **Filter 1** (L2170-2172, L2221), decides which chunks become context and `usedDocuments`:
  ```ts
  const queryTerms = normalize(queryText).split(/\s+/)
    .filter(term => term.length > 3)
    .map(term => term.replace(/[^a-z0-9]/g, ''));
  ...
  if (chunk.similarity > 0.65 || isRelevantByName || (hasImage && chunk.similarity > 0.25)) {
  ```
  where `isRelevantByName = queryTerms.some(term => docName.includes(term) || (docMetadata.content && docMetadata.content.toLowerCase().includes(term)))`. **Defect measured:** for the query `年度订阅可以在多少天内退款？`, `queryTerms` is `[""]` and `"handbook.md".includes("")` is `true`, so **every retrieved chunk passes Filter 1 for Chinese queries**; Latin terms are matched against the whole document content, so en/it also pass whenever any query word of 4+ chars occurs anywhere in the document; Italian accents are stripped (`perché` becomes `perch`). The documented "similarity > 0.65" is therefore rarely the deciding condition.
- **Context is built from Filter 1 survivors** (`relevantChunks = similarChunks.filter(chunk => usedDocuments.some(doc => doc.id === chunk.document_id))`, L2250), grouped per document, image documents (by extension) skipped for the LLM context, a `=== RELEVANT INFORMATION FROM DOCUMENTS ===` wrapper added.
- **Filter 2** (L2512-2540) trims `usedDocuments` only (not `context`): keep when `doc.explicitly_referenced`, or `doc.similarity && (doc.similarity >= 0.6 || (doc.image_url && doc.similarity > 0.25))`, or `term.length > 3 && docName.includes(term)`. Note `0.6`, not `0.65`.
- **Refusal** (L2572-2577) — quote:
  ```ts
  const shouldBlockNoContextResponse =
    !effectiveDisableRAG && ragMode === 'strict' && !webSearchEnabled &&
    usedDocuments.length === 0 && context.trim().toLowerCase().startsWith('no relevant context found');
  ```
  `context` becomes `'No relevant context found.'` only when it is empty after retrieval (L2456), so **refusal happens iff nothing survived Filter 1** (Filter 2 can empty `usedDocuments` without refusing). The refusal text starts `# Information Not Available` (L605).
- The route also looks up `documents` (`id, filename, created_at, content, metadata`) and `document_chunks.metadata` per chunk with `.single()`.

**Recommendation:** put the replica in `src/lib/rag-eval/legacy-post-filter.ts` as pure functions (inputs: chunks, doc rows, query, flags; outputs: kept chunks, usedDocuments, context, refused), leave `route.ts` untouched in Phase 1, and add a **sentinel test** that reads `route.ts` and asserts the literal source fragments (`chunk.similarity > 0.65`, `doc.similarity >= 0.6`, `hasImage && chunk.similarity > 0.25`, the `queryTerms` expression, the `shouldBlockNoContextResponse` expression) still exist. Phase 2 extracts the real function and deletes the replica. The planner should confirm "replicate" over "extract now" (Open Question 2).

Trace the route returns (Pydantic is the source; field names are a recommendation): `schema_version`, `query`, `query_context{isTemporalQuery,isFinancialQuery,requiredPrecision,suggestedThreshold,searchStrategy}`, `retrieval_strategy`, `candidates[{chunk_id,document_id,document_name,content,similarity,final_score,match_reason}]`, `filtered[{...,kept_by: 'similarity'|'name'|'image'}]`, `used_documents`, `context`, `refused`, `refusal_reason`, `answer` (`null` in smoke), `citations` (`[]`), `stage_latency_ms`, `effective_config{rag_env, embedder, deployment_mode, endpoint_version}`, `config_hash`. Request: `query`, optional `conversation` (kept for later phases, ignored today), `rag_mode`, `web_search` (false), `options{max_results?, organization_id?, user_id?}`, `include_answer` (false).

**Auth:** hash both sides with SHA-256 then `crypto.timingSafeEqual` (it throws on unequal lengths); 404 when `NODE_ENV==='production'` and `RAG_EVAL_ENDPOINT_ENABLED!=='true'`; refuse (503) when `RAG_EVAL_SECRET` is unset. The existing internal routes use `apiKey !== env.MYRAG_INTERNAL_API_KEY` (non-constant-time) — do not copy. Read vars through `env` (AGENTS convention) and in tests set `process.env` then `vi.resetModules()` before importing, because `env` is a snapshot.

In-process invocation verified: `new NextRequest('http://localhost/api/internal/rag/run',{method:'POST',headers:{...},body})` works under `tsx` and Vitest; call the exported `POST(req)` and `await res.json()`.

### Pattern 4: Pydantic to Zod that actually works

Raw conversion of `Model.model_json_schema()` is **wrong** (verified on a schema with `$defs`, a `Literal` enum, an optional list and a discriminated union):
1. `$ref` is not resolved: `"items": z.array(z.any())`, `"payload": z.any().superRefine(...)` — types silently vanish.
2. `oneOf` (Pydantic's output for discriminated unions, with `discriminator`) generates code using `z.core.$ZodIssue`, a Zod 4 type that does not exist in the app's zod 3.25.76.
3. Output starts with `import { z } from "zod"` (the repo convention is `zod/v3`).

Working pipeline (verified: generated file ran under `tsx` and passed `tsc --strict`; valid and invalid payloads parsed as expected):
```js
// scripts/gen-zod.mjs (core), input: rag-sidecar/schemas/<Model>.schema.json exported with sorted keys
const defs = root.$defs ?? {};
function inline(node, stack = []) {
  if (Array.isArray(node)) return node.map(n => inline(n, stack));
  if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') {
      const name = node.$ref.replace('#/$defs/', '');
      if (stack.includes(name)) throw new Error('cyclic $ref ' + name);   // forbid recursive models
      return inline(defs[name], [...stack, name]);
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) if (k !== '$defs') out[k] = inline(v, stack);
    if (out.oneOf && out.discriminator) { out.anyOf = out.oneOf; delete out.oneOf; delete out.discriminator; }
    return out;
  }
  return node;
}
let code = jsonSchemaToZod(inline(root), { name, module: 'esm', type: true });  // `type:true` requires name + module:'esm'
code = code.replace('from "zod"', 'from "zod/v3"');
```
Add a header comment `// GENERATED by scripts/gen-zod.mjs from rag-sidecar/schemas — do not edit`. Practical rules: use `ConfigDict(extra='forbid')` on request models (emits `additionalProperties:false`); export with `mode='serialization'` for models the TS side **parses** (Python output: defaulted fields are then `required`) and `mode='validation'` for models the TS side **sends**; forbid recursive models; fields with defaults become `.default(...)`. Parity CI step: run `uv run --project rag-sidecar python -m rag_sidecar.export_schemas`, then `node scripts/gen-zod.mjs`, then `git diff --exit-code -- rag-sidecar/schemas src/lib/rag-eval/contracts.generated.ts`. Add a TS test that parses a Python-produced fixture JSONL line with the generated schema (round-trip proof).

### Pattern 5: Characterization tests (Vitest against the real route)

Spiked and **passing** (3 tests) against the real `src/app/api/chat/route.ts` with these mocks: `ai` (partial: real `createUIMessageStream`/`createUIMessageStreamResponse`, mocked `streamText`), `@/lib/enhanced-rag-retrieval`, `@/lib/document-processor`, `@/lib/supabase` (chainable `from().select().eq().single()` fake and `getSupabaseAdmin`), `@/lib/supabase/server` (`createClient` returning `auth.getUser`), `@openrouter/ai-sdk-provider` (`createOpenRouter`), `exa-js` (class with `searchAndContents`), `@/lib/thinking-rag-enhancer` (see pitfall 5). `tests/setup-env.ts` sets placeholders; `OPENROUTER_API_KEY` must match the route's own regex (it rejected shorter placeholders with "The OpenRouter API key format is invalid"): use `sk-or-` followed by 32 letters.

What to assert for each behavior (all observed passing):
- **Strict "information not available":** POST with `ragMode:'strict'`, `webSearch:false`, retrieval mock returns `chunks: []` → response body contains `Information Not Available`, and `streamText` was **not** called.
- **webSearch + strict uses Exa:** same strict mode with `settings.webSearch:true`, `EXA_API_KEY` set, retrieval empty → no refusal; `streamText` called once; `Object.keys(params.tools)` contains `webSearch`; `params.tools.webSearch.execute({query})` calls the Exa mock with `('latest news', { livecrawl: 'always', numResults: 3 })` and returns `[{title,url,content,publishedDate}]` with `content` truncated to 1000 characters (route: `content: result.text?.slice(0, 1000)`); no `:online` suffix logic (comment at L1869: "Removed legacy :online suffix logic").
- **`source_images` streams:** retrieval mock returns a chunk with `metadata.image_url` and `similarity: 0.3` (passes the image `> 0.25` branch) → response SSE body contains `source_images` and the URL, and `body.indexOf('source_images') < body.indexOf('"delta":"ok"')` (route writes `type: 'source_images' as any, source_images: precomputedSourceImages` before `writer.merge(result.toUIMessageStream(...))`).
- **`source_images` persist:** capture `params.onStepFinish` from the `streamText` mock call and invoke it with `{text:'',toolCalls:[],toolResults:[]}`; the array receives `{type:'source_images', source_images:[{name,size:0,type:'image/jpeg',url}]}` (plus a `query_documents` result with `images` and a `metadata` part). Add a pure round-trip test on `src/types/chat.ts` (`toDBMessages` -> `fromDBMessages` keeps a `{type:'source_images', source_images:[...]}` content part unchanged; `toDBMessages` copies `content` as-is).
- **`{{context}}` substitution:** unit test of `createEnhancedRAGPrompt(base, 'CTX-BLOCK', 'strict')` (output contains `CTX-BLOCK` and no `{{context}}`), plus `SystemPromptManager.ensureContextPlaceholder` / `injectContext` (pure). **Must run under `tsx`, not Vitest** (pitfall 5): verified `TSX_OK true false`.

### Pattern 6: Judge tier with stubbed judge (verified offline)

With `DEEPEVAL_TELEMETRY_OPT_OUT=1`, `RAGAS_DO_NOT_TRACK=true`, a `socket.connect` spy, and stub judges, **no outbound connection attempts occurred** while computing all six metrics.
- DeepEval 4.3.4: subclass `DeepEvalBaseLLM` implementing `load_model`, `get_model_name`, `generate(prompt, schema=None)`, `a_generate`. When `schema` is given, return an instance of it. `FaithfulnessMetric`, `AnswerRelevancyMetric`, `ContextualRecallMetric` all scored 1.0 with a stub. Build the stub generically by filling any Pydantic model from `model_fields` (Literal -> first value, `str` -> `"stub"`, verdict-like fields -> `"yes"`): a hand-written per-schema stub broke on `ContextualRecallVerdict.reason` (required).
- Ragas 0.4.4 modern API: `from ragas.metrics.collections import Faithfulness, AnswerRelevancy, ContextRecall`; they take an `InstructorBaseRagasLLM` (abstract `generate(prompt, response_model)` / `agenerate`, returning a Pydantic instance — which fits the Pydantic-everywhere rule) and, for `AnswerRelevancy`, a `BaseRagasEmbedding` (`embed_text`/`aembed_text`). Metric calls: `await metric.ascore(user_input=..., response=..., retrieved_contexts=[...], reference=...)` -> `.value`. Importing the old names from `ragas.metrics` emits a deprecation ("will be removed in v1.0").
- Telemetry names **verified in the wheels' source**: DeepEval `DEEPEVAL_TELEMETRY_OPT_OUT` (truthy tokens `1,true,t,yes,y,on`; legacy `DEEPEVAL_TELEMETRY_ENABLED` also honoured, any OFF signal wins; also set `DEEPEVAL_HOME` to a temp dir and `DEEPEVAL_UPDATE_WARNING_OPT_IN=0`; never set `CONFIDENT_API_KEY`); Ragas `RAGAS_DO_NOT_TRACK` must equal `true` case-insensitively (`os.environ.get(...).lower() == "true"`; `1` does not work).
- The eval runner must set these in-process **before importing** `deepeval`/`ragas` and also in the workflow `env:`; add a pytest asserting the two variables are set when the judge module is imported.
- Judge config (`eval/config/judge.json`): pinned id (e.g. an `openai/...` OpenRouter id from the model list already in `src/lib/env.ts`), `temperature: 0`, `family = id.split('/')[0]`; refuse to run if `family` equals the generator's family (default generator in `env.ts` is `anthropic/claude-sonnet-4.5`). DeepEval ships an `openrouter_model.py` and Ragas `llm_factory(model, provider='openai', client=AsyncOpenAI(base_url='https://openrouter.ai/api/v1', ...))` accepts a pre-built client `[ASSUMED]` that OpenRouter's OpenAI-compatible endpoint works with instructor JSON mode.
- Ragas language adaptation (`PromptMixin.adapt_prompts(language, llm)` with `save_prompts`/`load_prompts`) exists on the **legacy** metric classes; a grep of the `collections` package found `adapt` only in the `factual_correctness` util `[ASSUMED: absence not proven]`. Plan: run metrics with English prompts over zh/it content, hand-check 20 judged items per language at the first live run, and record it as live verification.

### Pattern 7: check-config with a grandfather ratchet

Measured on today's tree (51 names matching `RAG_*`, `LLAMACLOUD_*`, `OPENAI_EMBEDDING_MODEL`, found in `process.env.X` in `src/` or in any of the four files): only **15** are in all four of `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, `scripts/config-ui/index.html`. Examples: `RAG_SYSTEM_PROMPT` is in `env.ts` and code only; `RAG_DOCUMENT_COMPLETENESS_THRESHOLD` and `RAG_ENABLE_MULTI_PASS` are read in code but appear in none of the four; `RAG_FINAL_RESULT_COUNT` is in init/server but not `env.ts` (hence the always-25 behaviour above); `RAG_ENABLE_HYBRID_SEARCH` is not in `config-server.js`. A naive "all five locations" check fails on commit one.

Design:
- `scripts/rag/env-manifest.json`: `{ vars: [{ name, status: 'managed'|'legacy', knownGaps: ['env-ts', ...] }] }`; locations are `init-env`, `env-ts`, `config-server`, `config-ui`, and `env-local` (only checked when `.env.local` exists).
- Presence test per file: regex `(?<![A-Z0-9_])NAME(?![A-Z0-9_])` on the file text. Handles `init-env.js` lines (`RAG_BEHAVIOR_MODE=strict`), `config-server.js` (`getEnvValue('X')`, template strings), `config-ui/index.html` (`id="X"`, JS keys) and `env.ts` (`process.env.X`), and does not confuse `RAG_RERANKING` with `RAG_RERANKING_STRATEGY` or `NEXT_PUBLIC_RAG_CACHE_ENABLED` with `RAG_CACHE_ENABLED`.
- Fail when: (1) a manifest var is missing from a location not in its `knownGaps`; (2) a `knownGaps` entry is now actually present (stale; forces the list to shrink); (3) a `process.env.<RAG-ish>` used in `src/` is not in the manifest (discovery); (4) a `managed` var has any `knownGaps`. Seed the manifest from the measured matrix so the check passes today; every new var from this phase (`RAG_EVAL_SECRET`, `RAG_EVAL_ENDPOINT_ENABLED`, and any sidecar vars) is `managed` and must be added to all five places.
- Self-test: a Vitest/`node:test` case that copies the four files to a temp dir, deletes one occurrence, and asserts non-zero exit (this is the "CI fails when a var is missing" demonstration).

### Pattern 8: Fixture embedder and corpus

Measured with a 9-chunk trilingual corpus and 7 queries (raw PGlite cosine through the repo's function):
- **First attempt (character 1-3-grams over everything) is unusable:** unrelated English text scored 0.40-0.44 against English queries (shared letters), the right chunk 0.58, and Chinese sentences only 0.24 vs ~0.04 distractors. No-answer questions were retrieved at 0.44 > the correct chunk's neighbours, so thresholds could not separate them.
- **Second attempt (works):** NFKC + lowercase; tokens = Unicode letter/number runs; Latin: word token (weight 1.0) plus `#word#` character trigrams (0.3), drop a small per-language stoplist (en/it function words, zh `的 是 了 在 和 有 多少 可以 什么 ...`); CJK: character unigram (0.5) + bigram (1.0); each feature hashed with SHA-256 to a 1536-d signed bucket; L2-normalize. Results: right chunk 0.38-0.45, hard negatives 0.02-0.05, no-answer queries ~0 (often zero rows returned).
- Consequences for design: (a) with init-env defaults (`RAG_LOW_THRESHOLD=0.45`) the right chunk often falls **below** the primary threshold and is recovered by `fallbackRetrieval` at 0.28 (only when `< 3` results and `suggestedThreshold > 0.35`); with code defaults (`RAG_LOW_THRESHOLD` unset -> `0.35`) it does not fall back. **Pin the eval env** (`eval/config/rag-eval-env.json`), generated from the `RAG_*` lines of `scripts/init-env.js` (what real deployments get) and guarded by a test that the snapshot still equals those lines. (b) Retrieval is bimodal, so make the corpus **hard on purpose**: near-duplicate chunks with different numbers (annual vs monthly plan), stale vs current policy wording, table rows with many shared tokens, OCR-noisy "scanned" chunks (`l`/`1`, `O`/`0`, dropped diacritics), and no-answer **near-miss** questions that reuse corpus vocabulary (these are retrieved, so strict mode does not refuse, giving a real correct-refusal < 1) next to out-of-domain no-answer questions (which are refused). (c) Keep the embedder, stoplists and corpus under version control and include a hash of all three in the config hash.
- Size guidance: about 12 documents, 50-80 chunks, 72 questions (24 per language: ~10 plain, 3 multi-turn, 3 compound, 3 exact-term, 3 table, 2 scanned, 6 no-answer split near-miss/out-of-domain). Gold spans quote text that must appear verbatim in a corpus chunk (add a test that every `quote` occurs, normalized, in its named document).
- `multi_turn` items: today's route retrieves on the last user message only, so pronoun follow-ups should score poorly — that is the honest baseline for QRY-01. `general` is not defined in REQUIREMENTS (categories listed there omit it); treat it as plain single-fact lookup (Assumption A3).

### Pattern 9: Metrics, baseline, gate

- Matching (CONTEXT): chunk matches a span iff same document and the chunk text contains the quote after normalization (NFKC, casefold, strip whitespace and punctuation). Implement once in Python; unit-test with zh, it (accents) and width-variant digits.
- Recall@k (k = 5 and 10): over `answerable` items, mean over items of (gold spans hit in the top-k of `filtered` in final order) / (gold spans). MRR: reciprocal rank of the first matching chunk, 0 when none. Correct-refusal rate = refused / items with `answerable=false`; false-refusal rate = refused / items with `answerable=true`. Report counts `n` beside every rate; per language and per category slices.
- **Determinism consequence:** the system, embedder and corpus are deterministic, so the three baseline runs are identical, `spread = 0`, and the band is the 0.02 floor alone. Still run three separate processes (proves reproducibility and satisfies EVAL-09), record `config_hash` per run (sha256 of canonical JSON of pinned RAG env, embedder id/version, corpus hash, golden hash, repo SQL hashes; **exclude** git SHA, which goes in a separate field), and fail the baseline-recording command if hashes or metrics differ across the three.
- Per-language slices have n around 24, so one flipped item moves a rate by more than 0.04: any single flip in a gated slice fails. Recommend gating the overall metrics and each language, reporting categories without gating (n too small) — Open Question 3.
- Gate (`rag_eval.gate`): for each metric, `threshold = baseline_mean - max(3 * baseline_spread, 0.02)`; fail if a "higher is better" metric is below it (false-refusal rate is "lower is better": fail if above `mean + band`); exit code 1 and a Markdown table of offenders.
- Failing-PR demonstration: (1) pytest that feeds the gate a report produced from traces generated with a degraded config and asserts exit code 1; (2) a CI job that runs the harness with `maxResults=1` (request option; note the env var `RAG_FINAL_RESULT_COUNT` would not work because of the `env.ts` gap) and asserts the gate fails (`! python -m rag_eval.gate ...`).

### Pattern 10: Sidecar and Docker

- FastAPI app with: `GET /health` (liveness, no secret, no data), `GET /ready` (200 only when the secret is configured, 503 otherwise), and authenticated `/v1/*`. Auth dependency: refuse **every** non-probe request with 503 when `RAG_SIDECAR_SECRET` is unset; otherwise compare header `x-sidecar-secret` with `hmac.compare_digest` on bytes; 401 on missing/wrong. Whether probes are exempt from "every request is refused when the secret is unset" is Open Question 4. Header and env names are not fixed by CONTEXT (recommendation above) and must go in the five config locations.
- Do not log request bodies; no URL fetching; the sidecar must not import `deepeval`/`ragas`.
- Dockerfile pattern from the uv docs `[CITED: docs.astral.sh/uv/guides/integration/docker/]`: pinned `COPY --from=ghcr.io/astral-sh/uv:<pinned> /uv /uvx /bin/`; `python:3.12-slim`; `ENV UV_COMPILE_BYTECODE=1 UV_NO_DEV=1 UV_LINK_MODE=copy`; deps layer with `--mount=type=cache,target=/root/.cache/uv` and `--mount=type=bind,source=uv.lock,target=uv.lock` running `uv sync --frozen --no-install-project`; then copy source and `uv sync --locked`; `.dockerignore` includes `.venv`; non-root user; `CMD ["uv","run","--no-sync","uvicorn","rag_sidecar.main:app","--host","0.0.0.0","--port","8000"]` (the uvicorn command is inferred; the guide has no uvicorn example). `HEALTHCHECK` against `/health`.
- **No Docker daemon here**, so "builds from its Dockerfile" is proven in CI: a `docker-build` job (`docker build rag-sidecar`, no push) on GitHub-hosted runners, plus local proxies: `uv sync --locked --no-dev` succeeds and `uvicorn` boots and answers `/health` under `pytest`/`httpx`. hadolint is optional; it was not available to verify here.

### Pattern 11: GitHub Actions layout

`.github/` does not exist. Action major versions could not be verified (GitHub API denied for this session): pin to the current major of `actions/checkout`, `actions/setup-node`, `astral-sh/setup-uv`, `actions/upload-artifact` at write time `[ASSUMED]`.
- `pr-smoke.yml` (on `pull_request`): jobs `ts` (Node 22, `npm ci`, `npx vitest run`, the tsx `{{context}}` test, `node scripts/check-config.mjs`, `npm run typecheck:new`), `schema-parity` (setup-uv, export, gen-zod, `git diff --exit-code`), `sidecar` (`uv sync --locked`, `pytest`), `eval-smoke` (harness, runner, gate; upload `eval/out` as artifact), `gate-negative-control` (degraded run must fail), `docker-build`.
- `nightly.yml` (`schedule` + `workflow_dispatch`): runs the fixture harness then the judge tier; first step checks `secrets.OPENROUTER_API_KEY` (or the judge key) and, if empty, writes `::notice::judge key not configured, skipping` and exits 0. Set `DEEPEVAL_TELEMETRY_OPT_OUT: "1"`, `RAGAS_DO_NOT_TRACK: "true"` in `env:`.
- Type-check of new code: `ignoreBuildErrors: true` and the legacy code has existing errors. Measured: `tsc --noEmit -p` over a config including only `src/lib/enhanced-rag-retrieval.ts` reports **12 errors in transitive legacy files** (`semantic-chunker.ts` 6, `temporal-metadata-extractor.ts` 4, `title-generator.ts` 1, `title-generator-multimodal.ts` 1) in about 6 s. So `typecheck:new` must run `tsc` and **filter the output to new paths** (`src/lib/rag-eval/`, `src/app/api/internal/rag/`, `eval/harness/`, `tests/`) and fail only on errors there.

### Anti-Patterns to Avoid
- **Copying SQL function bodies into test fixtures:** load from `supabase/*.sql` so SQL drift is caught.
- **Importing `@/lib/*` before the placeholder env is set:** `env.ts` throws at import.
- **A fake embeddings endpoint that ignores `encoding_format`.**
- **Gating on `RAG_FINAL_RESULT_COUNT` to degrade the run:** it is ignored by the route today.
- **Putting deepeval/ragas into `rag-sidecar/pyproject.toml`.**
- **Real customer text anywhere under a committed path:** add `eval/golden/private/` to `.gitignore` and a test that `git check-ignore eval/golden/private/x.jsonl` succeeds and that nothing under that path is tracked.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| In-process Postgres + pgvector | Mock `rpc()` results or re-implement cosine in JS | PGlite + `pglite-pgvector` loading the repo SQL | Tests the real SQL (threshold `>`, ordering, `LIMIT`) |
| JSON Schema to Zod | A hand-written Zod mirror of each Pydantic model | `json-schema-to-zod` + the deref/normalize step above | Hand mirrors drift; this is the user's stated rule |
| Constant-time secret compare | `===` or manual loops | `hmac.compare_digest` (Python), SHA-256 + `crypto.timingSafeEqual` (Node) | Timing safety, equal-length requirement |
| Judge metrics | Own faithfulness/relevance prompts | DeepEval and Ragas metrics with a stub-able LLM wrapper | Locked by CONTEXT; stub interfaces exist |
| Python env/lock | pip + requirements.txt | `uv` with committed `uv.lock` | Locked by CONTEXT |
| Route-handler testing | Spinning up `next dev` | Direct `POST(new NextRequest(...))` | Verified in-process under tsx and Vitest |

**Key insight:** the cheap-looking shortcuts (mock the RPC, copy the SQL, hand-write Zod) are exactly the ones that make a green eval meaningless; every verified path above runs the real code.

## Runtime State Inventory

Not a rename/refactor/migration phase: omitted. (Config additions are covered by the check-config design.)

## Common Pitfalls

### Pitfall 1: Chinese queries pass Filter 1 unconditionally
**What goes wrong:** zh metrics look better (or no-answer zh items never refuse) because `queryTerms` becomes `[""]`.
**Why:** `.replace(/[^a-z0-9]/g, '')` strips all CJK, and `String.includes('')` is `true`.
**How to avoid:** replicate exactly (do not fix in Phase 1); record the quirk in the report notes; unit-test the replica with the measured zh and Italian examples.
**Warning signs:** zh false-refusal near 0 with zh correct-refusal also near 0.

### Pitfall 2: `check-config` red on commit one
**What goes wrong:** the CI step fails because 36 of 51 vars are legitimately missing somewhere.
**How to avoid:** manifest with `knownGaps` ratchet (Pattern 7); do not "fix" legacy gaps in this phase (config changes are out of scope).

### Pitfall 3: vitest 5 breaks under legacy-peer-deps
**What goes wrong:** `ERR_PACKAGE_PATH_NOT_EXPORTED ./module-runner`. **Why:** `llamaindex` brings `vitest@2.1.9` and hoists `vite@5.4.21`. **How to avoid:** declare `vite@7.3.8` explicitly; verify with `npm ls vite`.

### Pitfall 4: Fake OpenAI returns the wrong dimensionality
See Pattern 2 (`encoding_format: base64`). Warning sign: `different vector dimensions 1536 and 384`.

### Pitfall 5: `createEnhancedRAGPrompt` cannot run under Vitest
**What goes wrong:** `Cannot find module './rag-mode'` inside the route (every route test then returns an error SSE). **Why:** `thinking-rag-enhancer.ts` does `const { RAG_MODE_CONFIGS } = require('./rag-mode');` at call time; Node's CJS `require` cannot resolve a `.ts` file. **How to avoid:** in route-level tests mock `@/lib/thinking-rag-enhancer` (`createEnhancedRAGPrompt: (b, c) => b.replace('{{context}}', c)`, plus `enhanceQueryWithReasoning`, `intelligentSearch` stubs); run the real-function test under `tsx` (`node --import tsx --test`), where it works. Optional alternative the user may prefer: replace the lazy `require` with a static import (`rag-mode.ts` has no imports, so no cycle) — a production edit, so not recommended in this phase.

### Pitfall 6: OpenRouter key format gate in the route
Placeholder `OPENROUTER_API_KEY` must satisfy the route's own pattern (observed failure for 18 chars; `sk-or-` plus 32 chars passes).

### Pitfall 7: tsx entry files are CJS
Use `.mts`/`async main()` (Project Structure note).

### Pitfall 8: Zero-spread baseline hides non-determinism
If the three runs differ, something is non-deterministic (HNSW tie ordering, Date-based logic in `temporal-query-detector` for relative-time queries, logger side effects). The record command must fail loudly on differing runs rather than widening the band; keep date-relative phrases out of the fixture questions.

### Pitfall 9: Drafting tool hallucinated quotes
Reject any drafted item whose `quote` is not a normalized substring of the named document; this is the same predicate the metrics use.

### Pitfall 10: Telemetry variable value
`RAGAS_DO_NOT_TRACK=1` does **not** disable Ragas tracking; it must be `true`. DeepEval accepts `1`.

## Code Examples

### Fake embeddings response honouring base64
```ts
// Source: spike (repocopy/t2.mts); required by openai@4.104.0 default encoding_format
const vec = embed(text);                                    // number[1536], L2-normalised
const embedding = body.encoding_format === 'base64'
  ? Buffer.from(new Float32Array(vec).buffer).toString('base64')
  : vec;
```

### Gate core
```python
# rag_eval/gate.py (shape)
def threshold(base, higher_is_better=True, floor=0.02, k=3):
    band = max(k * base["spread"], floor)
    return base["mean"] - band if higher_is_better else base["mean"] + band
```

### Stub judge for both libraries (fills any Pydantic model)
```python
# Source: spike (pyspike/stub_both.py); verified offline, zero outbound connections
def fill(model):                       # build a valid instance from model_fields
    return model(**{n: value_for(f.annotation, n) for n, f in model.model_fields.items()})
class StubJudge(DeepEvalBaseLLM):      # DeepEval
    def load_model(self): return self
    def get_model_name(self): return "stub-judge"
    def generate(self, prompt, schema=None): return fill(schema) if schema else "{}"
    async def a_generate(self, prompt, schema=None): return self.generate(prompt, schema)
class StubInstructorLLM(InstructorBaseRagasLLM):   # Ragas
    def generate(self, prompt, response_model): return fill(response_model)
    async def agenerate(self, prompt, response_model): return fill(response_model)
```

### Split rule
```python
split = "dev" if int(hashlib.sha256(item_id.encode()).hexdigest()[:8], 16) % 100 < 70 else "test"
# consult eval/golden/split-manifest.json first; never reassign an existing id
```

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `@electric-sql/pglite/vector` subpath | Separate `@electric-sql/pglite-pgvector` package with exact peer pin | Install both, pin exactly |
| Ragas `ragas.metrics.Faithfulness` etc. (LangChain wrappers) | `ragas.metrics.collections.*` with instructor LLMs | Old names deprecated, removal planned for v1.0 |
| DeepEval `DEEPEVAL_TELEMETRY_OPT_OUT=YES` folklore | Settings-validated `parse_bool` tokens | `1` works |

**Deprecated/outdated:** `json-schema-to-zod` output targeting Zod 4 internals for unions (use the `anyOf` rewrite for zod 3).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | GitHub Action major versions (`checkout`, `setup-node`, `setup-uv`, `upload-artifact`) are current when pinned | Pattern 11 | CI file needs a bump; low |
| A2 | OpenRouter's OpenAI-compatible endpoint works with instructor JSON mode for the pinned judge | Pattern 6 | Judge tier needs a different Ragas LLM adapter; only seen at first live run |
| A3 | Category `general` means a plain single-fact lookup | Pattern 8 | Fixture mix and meaning of per-category slice differ from the user's intent |
| A4 | Ragas `collections` metrics have no prompt-adaptation API (grep-only) | Pattern 6 | zh/it judging quality plan changes |
| A5 | Gating per language (n about 24) is acceptable despite one-item flips exceeding the floor | Pattern 9 | Over-strict gate; adjust to overall-only |
| A6 | Probes (`/health`, `/ready`) may be unauthenticated | Pattern 10 | Needs a different probe design if the user means literally every request |
| A7 | `tsc` output filtering to new paths is an acceptable "type-check of new code" | Pattern 11 | A stricter definition would require fixing legacy errors |
| A8 | The pinned judge's family prefix is derivable from the OpenRouter id (`provider/model`) | Pattern 6 | Family check misclassifies; use an explicit `family` field in `judge.json` |

## Open Questions

1. **Edge fakes versus an in-process adapter.**
   - Known: edge fakes need no production edit and were verified; CONTEXT says "behind a Supabase-compatible `rpc()` adapter" (the fake PostgREST is that adapter at the wire level).
   - Unclear: whether the user reads the decision as requiring an in-process object.
   - Recommendation: use edge fakes; fall back to the three-line `setRetrievalDependencies` seam only if needed.
2. **Replicate or extract the route's filters?** Recommendation: replicate plus sentinel test now; Phase 2 extracts.
3. **Which slices gate?** Recommendation: overall + per language; categories report-only.
4. **Are health/readiness probes exempt from "refuse every request when the secret is unset"?** Recommendation: exempt `/health`, make `/ready` return 503 when unset.
5. **Judge model id.** Needs a user choice of the pinned non-Claude OpenRouter model; not resolvable without a live key.
6. **Fixing `RAG_FINAL_RESULT_COUNT` (absent from `env.ts`).** Out of scope here (no behavior change); worth recording for Phase 2.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | harness, Vitest, tsx | yes | v22.23.5 | — |
| npm / registry | installs | yes | 10.9.9, reachable | — |
| `node_modules` | all TS work | no (not installed in repo) | `npm ci` took 48 s in scratch copy | install in plan task 1 |
| Python | sidecar, eval | yes | 3.13 system; `uv venv --python 3.12` worked | uv-managed 3.12 |
| uv | Python envs | yes | 0.11.32 | — |
| pydantic | contracts | yes | 2.14.4 system-wide | uv env |
| FastAPI | sidecar | no | 0.165.0 on PyPI | `uv add` |
| Docker daemon | Dockerfile build | no (CLI only) | — | CI `docker build` job; local boot test |
| psql client | — | yes | — | not needed (PGlite) |
| Live vendor keys / Supabase | live tier, judge, drafting | no | — | stubbed judge, fixture workspace, live verification |
| `.github/` | CI | no | — | create |

**Missing dependencies with no fallback:** none for the verifiable scope.
**Missing with fallback:** Docker daemon (CI proves the build), live keys (recorded as live verification).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Frameworks | Vitest 5.1.1 (TS), `node --import tsx --test` (real `createEnhancedRAGPrompt`), pytest 9.2.0 (sidecar, eval) |
| Config files | `vitest.config.ts` (alias `@` -> `src`, `environment: 'node'`, `setupFiles: ['tests/setup-env.ts']`), `rag-sidecar/pyproject.toml`, `eval/pyproject.toml` — all Wave 0 |
| Quick run | `npx vitest run <file>`; `uv run --project rag-sidecar pytest -q`; `uv run --project eval pytest -q <file>` |
| Full suite | `npm test && node scripts/check-config.mjs && npm run typecheck:new && npm run test-rag` plus both pytest projects |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EVAL-01 | Health/ready answer; wrong/missing secret rejected; all refused when unset | unit (httpx TestClient) | `uv run --project rag-sidecar pytest tests/test_auth.py tests/test_health.py` | Wave 0 |
| EVAL-01 | Image builds | CI job | `docker build rag-sidecar` (CI only; no daemon here) plus `uv sync --locked --no-dev` | Wave 0 |
| EVAL-02 | Zod regenerated equals committed; round trip parses | script + vitest | `npm run gen:schemas && git diff --exit-code && npx vitest run tests/contracts.test.ts` | Wave 0 |
| EVAL-03 | `GoldenItem` rejects chunk ids / bad enums; quotes occur in corpus | pytest | `uv run --project eval pytest tests/test_golden_contract.py` | Wave 0 |
| EVAL-04 | Fixture corpus/golden cover zh/en/it and all categories | pytest | `uv run --project eval pytest tests/test_fixture_coverage.py` | Wave 0 |
| EVAL-05 | Drafting writes to gitignored path, split frozen, stub LLM, fixture workspace | pytest | `uv run --project eval pytest tests/test_draft.py` | Wave 0 |
| EVAL-06 | Route: auth matrix (missing/wrong/unset/prod-disabled), trace shape | vitest | `npx vitest run tests/eval-route.test.ts` | Wave 0 |
| EVAL-06 | Real retrieval against PGlite returns expected chunk | vitest/tsx | `npx vitest run tests/eval-harness.test.ts` | Wave 0 |
| EVAL-07 | Recall@k, MRR, refusal rates on hand-built traces (zh/it normalization) | pytest | `uv run --project eval pytest tests/test_metrics.py` | Wave 0 |
| EVAL-08 | Stub judge produces three metrics per language/category; telemetry env set; family check | pytest | `uv run --project eval pytest tests/test_judge.py` | Wave 0 |
| EVAL-09 | Baseline recorder rejects differing runs; file has hash+mean+spread | pytest | `uv run --project eval pytest tests/test_baseline.py` | Wave 0 |
| EVAL-10 | Gate passes baseline, fails degraded | pytest | `uv run --project eval pytest tests/test_gate.py` | Wave 0 |
| EVAL-10 | Workflows lint | CI | `actionlint` `[ASSUMED available in CI]` | Wave 0 |
| EVAL-11 | `npm run test-rag` exits 0 on fixtures | e2e | `npm run test-rag` | Wave 0 |
| EVAL-12 | Four behaviors locked | vitest + tsx | `npx vitest run tests/chat-*.test.ts && node --import tsx --test tests/prompt-context.test.mts` | Wave 0 (spiked) |
| EVAL-13 | Passes today's tree; fails when a var is removed or an unlisted var appears | node:test | `node --test scripts/check-config.test.mjs && node scripts/check-config.mjs` | Wave 0 |

### Sampling Rate
- **Per task commit:** the single relevant quick command above.
- **Per wave merge:** `npm test`, `node scripts/check-config.mjs`, both pytest projects.
- **Phase gate:** full suite green plus `npm run test-rag` plus the negative-control run before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `vitest.config.ts`, `tests/setup-env.ts` (placeholder env incl. `sk-or-` + 32 chars)
- [ ] `tests/chat-strict.test.ts`, `tests/chat-websearch.test.ts`, `tests/chat-source-images.test.ts`, `tests/prompt-context.test.mts`, `tests/eval-route.test.ts`, `tests/contracts.test.ts`
- [ ] `rag-sidecar/` and `eval/` pyproject, `uv.lock`, pytest configs
- [ ] `eval/fixtures/*` corpus and golden, `eval/config/*`, `eval/baselines/`
- [ ] `.gitignore` entries: `eval/golden/private/`, `eval/out/`, `.venv`
- [ ] Framework install: `npm i -D` set above (add `vite@7.3.8`)

**Live verification (recorded, not automated here):** docker image build and run on a real runner, real-workspace drafting with Claude and Ragas, nightly judge run with a pinned key plus 20-item hand check per language, real-KB baseline.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (shared secrets) | Constant-time compare, fail closed on unset, secrets only via env |
| V3 Session Management | no | Stateless service-to-service |
| V4 Access Control | yes | Eval route returns document content: disabled in production by default (`RAG_EVAL_ENDPOINT_ENABLED`), 404 not 403 when off |
| V5 Input Validation | yes | Zod (`zod/v3`) generated from Pydantic on TS side, Pydantic in Python; `extra='forbid'` on request models |
| V6 Cryptography | yes (minimal) | `hmac.compare_digest`, SHA-256 + `timingSafeEqual`; no custom crypto |
| V7 Logging | yes | No document text or secrets in logs; log presence only |
| V14 Configuration | yes | Placeholders only in tests; pinned lockfiles (`package-lock.json`, `uv.lock`) |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Timing attack on secret compare | Information disclosure | Constant-time compare on equal-length digests |
| Eval endpoint as data-exfiltration surface | Information disclosure | Prod off by default, secret header, tenant scope arrives in Phase 2 (`organization_id` in the request is not trusted beyond eval use) |
| Customer data committed via golden drafting | Information disclosure | `eval/golden/private/` ignored, `git check-ignore` test, nothing under it tracked |
| Judge/telemetry leakage of document text | Information disclosure | `DEEPEVAL_TELEMETRY_OPT_OUT=1`, `RAGAS_DO_NOT_TRACK=true`, socket-spy test |
| Fake edge server reachable off-host | Elevation | Bind `127.0.0.1`, ephemeral port, test-only |
| SSRF / file read in sidecar | Tampering | No URL or path inputs accepted in Phase 1 endpoints |
| `trust_remote_code` / model downloads | Tampering | Not used in Phase 1 (HHEM is Phase 5) |

## Project Constraints (from CLAUDE.md)

- Match existing patterns: kebab-case modules, `@/` alias, `zod/v3` imports, structured JSON errors with 400 on invalid input, bracketed log prefixes, no new `any`.
- New `.env.local` variables must be mirrored in `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js` and the Config UI (this is exactly what `check-config` enforces); the five model locations stay synchronized.
- Keep `RAG_SYSTEM_PROMPT` strings intact with `{{context}}`; strict-mode refusal, webSearch+Exa, `source_images`, voice and embed paths must not change.
- Never commit secrets, real phone numbers or customer data; use placeholders in tests and docs.
- Keep comments minimal; touch documentation only on explicit request (so do not edit `scripts/rag/README.md` or `AGENTS.md` unless asked).
- Run lint, type checks and relevant scripts before handoff; `npm run lint` is explicit because `.eslintignore` ignores everything.
- Large files (`chat/route.ts` ~4,500 lines): high regression risk; avoid edits in this phase.
- GSD workflow: file-changing work goes through a GSD command.
- Prefer Zustand selectors/`useShallow` for UI (not applicable here).

## Sources

### Primary (HIGH confidence)
- Repo files read this session: `src/lib/enhanced-rag-retrieval.ts`, `src/lib/env.ts`, `src/lib/supabase.ts`, `src/lib/supabase/client.ts`, `src/lib/document-processor.ts` (embedding path), `src/lib/temporal-query-detector.ts` (thresholds L92-97), `src/lib/thinking-rag-enhancer.ts` (`createEnhancedRAGPrompt`), `src/types/chat.ts`, `src/app/api/chat/route.ts` (L1180-1230, 1838-1895, 1895-2600, 2593-2720, 3575-3650, 3925-4135, 4200-4360), `src/app/api/internal/voice-rag/route.ts`, `src/lib/api-middleware.ts`, `supabase/single-tenant-setup.sql` (L10-66, 270-340), `supabase/multi-tenant-setup.sql` (L685-835), `scripts/init-env.js`, package.json, tsconfig.json, `.planning/*`.
- Spikes run in scratch copies (this session): PGlite+SQL load and shim minimality; edge-fake retrieval; fixture embedder tuning; json-schema-to-zod conversion; Vitest route tests; tsx `{{context}}`; DeepEval and Ragas stub runs with socket spy; `tsc` error census; env drift matrix.
- PyPI wheels `deepeval==4.3.4` and `ragas==0.4.4` unpacked and read (telemetry variables, `DeepEvalBaseLLM`, `InstructorBaseRagasLLM`, `BaseRagasEmbedding`, collections metrics).
- npm and PyPI registries (versions, engines, peer dependencies).
- `[CITED: docs.astral.sh/uv/guides/integration/docker/]` Dockerfile pattern.

### Secondary (MEDIUM confidence)
- `.planning/research/SUMMARY.md`, `STACK.md`, `PITFALLS.md` (project-level research; its Ragas/DeepEval telemetry names are now verified).

### Tertiary (LOW confidence)
- GitHub Action versions and `actionlint`/hadolint availability (not reachable this session).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — installed and run; versions read from registries.
- Architecture (seam, filters, refusal derivation): HIGH — code read and exercised.
- Pitfalls: HIGH for the ones reproduced; MEDIUM for Pitfall 8 (anticipated).
- CI layout and Docker: MEDIUM — cannot run Docker or Actions here.
- Judge-tier quality for zh/it: LOW until a live run.

**Research date:** 2026-11-23
**Valid until:** 2026-12-07 (PGlite, Vitest, FastAPI, Pydantic and Ragas all released within the last few weeks; re-check pins before install)
