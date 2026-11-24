# Phase 6: Query Layer (LlamaIndex & LangChain) - Pattern Map

**Mapped:** 2026-11-24
**Files analyzed:** ~48 new/modified files, in 14 groups
**Analogs found:** 44 / 48. Tracked code covers 30. 14 come from Phase 3, 3.1 or 4 plans that are not executed yet.

All analog paths below are git-tracked, or they are files that an unexecuted plan will create. Those are marked **(plan)**. In the tracked tree today, `loadRagConfig` only accepts `RAG_PIPELINE=legacy` (`src/lib/rag/config.ts:84-90`). There is no `src/lib/rag/v2/`, no `fusion/rrf.ts`, no `supabase/migrations/` and no `src/app/api/rag/admin/*`. Phase 6 plans must depend on the Phase 4 plans that create them, and must not re-create them.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `src/lib/rag/query/rewrite-gate.ts` + `rewrite-gate.lexicon.json` | utility (pure) | transform | `src/lib/rag/lang/detect.ts` (word lists + pure fn); `src/lib/rag/query/temporal-query-detector.ts` | role-match |
| `src/lib/rag/query/language.ts` | utility | transform | `src/lib/rag/lang/detect.ts` (extend, do not fork, P-12) | exact |
| `src/lib/rag/query/router.ts` | service (pure) | transform | `src/lib/query-classifier.ts:9,62` (input type only) + `src/lib/rag/config.ts` parse style | partial |
| `src/lib/rag/query/dates.ts` | utility | transform | `src/lib/rag/query/temporal-query-detector.ts:42` `analyzeQuery`; Phase 4 date-range helper **(plan 04-14)** | role-match |
| `src/lib/rag/query/protected.ts`, `post-checks.ts`, `deadline.ts` | utility | transform | `src/lib/rag/config.ts` (pure, memo, `problem()` logging) | partial |
| `src/lib/rag/query/llm.ts` | service | request-response | `src/lib/rag/embeddings/openai.ts` (lazy client, `signal` passthrough) + `src/lib/rag/deps.ts` injection | role-match |
| `src/lib/rag/query/transformer.ts`, `plan.ts`, `llamaindex/*`, `prompts/*.json` | service | transform | `src/lib/rag/deps.ts` (interface + default + test override); Phase 4 `query/variants.ts`, `query/translate.ts` **(plan 04-24)** | role-match |
| `src/lib/rag/query/langchain/{index,port-retriever,capture,fake}.ts` | adapter | request-response | no in-repo LangChain code; seam = Phase 4 v2 search stage **(plan 04-19 `src/lib/rag/v2/stages/search.ts`)** | none (use RESEARCH Pattern 4) |
| `src/lib/rag/cache/{types,keys,bypass,pgvector,redisvl-http,index}.ts` | service | CRUD + request-response | `src/lib/rag/backend/supabase-rpc.ts` (RPC adapter + typed error); `src/lib/rag/embeddings/openai.ts` (HTTP with signal) | role-match |
| `src/lib/rag/config.ts`, `deps.ts`, `types.ts`, `pipeline.ts` / `v2/pipeline.ts` (stage additions) | config / service | event-driven stage runner | themselves: `config.ts:3-12,30-45`, `pipeline.ts:100-158,168-190` | exact |
| `src/lib/rag/generation/prompt.ts` (D-25 appended instruction) | utility | transform | itself, `createEnhancedRAGPrompt` | exact |
| `rag-sidecar/src/rag_sidecar/contracts/query.py` (QueryPlan, RewriteGateResult, per-transform outputs, QueryParams, SemanticCacheCalibration, cache req/resp) + `eval_run.py` edits | model (Pydantic) | contract | `contracts/eval_run.py`, `contracts/latency.py`, `contracts/ingest.py:204` (`DocTypeDetection` = LLM-output model) | exact |
| `rag-sidecar/schemas/*.schema.json`, `src/lib/rag-eval/contracts.generated.ts` | generated | contract | `export_schemas.py:47-60` CONTRACTS list; `scripts/gen-zod.mjs:11` | exact |
| `rag-sidecar/src/rag_sidecar/cache/{router,service}.py`, `main.py`, `pyproject.toml` extra | controller + service (Python) | request-response | `rag-sidecar/src/rag_sidecar/main.py:11-38`, `auth.py` | role-match |
| `supabase/migrations/06xx_language_shares.sql` | migration (RPC) | CRUD read | `0407_hybrid_search_chunks.sql` **(plan 04-15)**, tenant guard **(plan 04-07)** | exact (plan) |
| `supabase/migrations/06xx_semantic_cache.sql` | migration (table+RPC+triggers) | CRUD | `0355_parse_cache.sql` **(plan 03.1-10)**; `0357_soft_delete.sql` **(plan 03.1-39)** | exact (plan) |
| `supabase/migrations/06xx_hybrid_include_undated.sql` | migration | CRUD read | `0407_hybrid_search_chunks.sql` **(plan 04-15)**; DROP the old signature first (A-6, P-8) | exact (plan) |
| `supabase/single-tenant-setup.sql`, `multi-tenant-setup.sql` (mirror) | migration | — | fold step **(plan 04-42)** | exact (plan) |
| `src/app/api/rag/admin/semantic-cache/route.ts` | controller | request-response | `src/lib/rag/tenant/admin.ts` `requireRagAdmin`; route shape **(plans 03-40, 04-34)** | role-match |
| `src/app/api/chat/route.ts`, `src/app/api/embed/chat/route.ts` (pass classification/history/timeZone; stream cache hit) | controller | streaming | itself (`classifyQuery` at chat route L1358) | exact |
| `src/app/api/internal/voice-rag/route.ts` (optional `history`) | controller | request-response | itself, L9-12 (zod body) and L57-63 (`runRetrieval`) | exact |
| `src/app/api/internal/rag/run/route.ts` (eval overrides) | controller | request-response | itself, `toStageOverrides` L19-30 | exact |
| `voice-agent/src/voice_agent.ts`, `rag_client.ts`, `voice-agent/.env.example` | service | request-response | itself, `rewriteQueryWithContext` L393-466; env read style `voice-agent/src/agent.ts:63-74` | exact |
| `scripts/ci/check-rag-boundary.mjs` + `scripts/tests/check-rag-boundary.node-test.mjs` | config (CI) | batch | itself, `RULES` L184-280, `ALLOWLIST` L11-16 | exact |
| `npm ls zod` CI step (`.github/workflows/pr-smoke.yml` or `scripts/ci/*.mjs`) | config (CI) | batch | `scripts/ci/check-node-runtime.mjs` + RESEARCH "npm ls zod CI assertion" | role-match |
| `eval/src/rag_eval/compare/{__init__,__main__,frameworks}.py` | utility (CLI) | batch | `eval/src/rag_eval/paired.py` (L84 `paired_report`, L117 `main`), `draft/__main__.py` | exact |
| `eval/src/rag_eval/calibrate/cache.py` (+ `__main__` dispatch) | utility (CLI) | batch | `calibrate/refusal.py` **(plan 04-30)** | exact (plan) |
| `eval/config/query-params.json`, `semantic-cache.json`, `latency-budgets.json`, `rag-eval-env.json`; `eval/fixtures/query-llm/*.json` | config | file-I/O | `eval/config/latency-budgets.json`; `retrieval-params.json` **(plan 04-04/04-44)**; `eval/fixtures/translation-table.json` **(plan 04-24)** | exact |
| env five-place sync: `src/lib/env.ts`, `scripts/init-env.js`, `scripts/config-server.js` (x3 blocks), `scripts/config-ui/index.html`, `scripts/rag/env-manifest.json`, `scripts/check-config.mjs` | config | — | `RAG_PIPELINE` / `RAG_STAGE_TIMEOUTS` entries (lines below); full recipe **(plan 04-02)** | exact |
| `scripts/config-ui/rag-panels/query-layer.js` + `index.html` panel | component (vanilla JS) | request-response | "Retrieval pipeline" card `index.html:6417-6465`; panel modules **(plan 04-36)** | exact |
| tests (`tests/rag/query/*.test.ts`, `tests/rag/cache/*.test.ts`, `tests/rag-db/semantic-cache*.test.mts`, `rag-sidecar/tests/test_cache_*.py`, `eval/tests/test_calibrate_cache.py`, `test_compare_frameworks.py`) | test | — | `tests/eval-route-auth.test.ts`, `scripts/tests/check-rag-boundary.node-test.mjs`, `rag-sidecar/tests/test_auth.py`, `eval/tests/test_paired.py`, `tests/rag-search-rpc-grants.test.mts` | exact |

## Pattern Assignments

### `src/lib/rag/config.ts` (new stage names, query-layer switches)

**Analog:** itself. Phase 4 **(plan 04-02)** already widens this file to the v2 pipeline. Phase 6 builds on that version.

Stage lists, lines 3-16. Add `query_gate`, `condense`, `normalize_dates`, `expand`, `hyde`, `decompose` and `semantic_cache` to the optional stages. `translate` already exists from Phase 4. These names are the keys in `stage_latency_ms`, so the Pydantic `StageName` literal in `eval_run.py:15-25` and `StageTimeoutsMs` (L30-39) must change in the same commit.
```ts
export const CORE_STAGES = ['embed', 'search'] as const;
export const OPTIONAL_STAGES = ['refs', 'analyze', ..., 'local_rerank'] as const;
```
Per-profile defaults, lines 20-45. Put the D-27 timeouts here: chat/embed condense 600, translate 600, expand 700, decompose 800, hyde 900, semantic_cache 150; voice condense 300. Leave eval without timeouts.
Bad-value handling, lines 68-73 (`problem()` logs once per key with a bracketed prefix, then falls back). Use the same handling for the `RAG_QUERY_*` parsing in D-26, for example HyDE/expand/decompose listed for voice, or the cache set under `legacy`. Change the prefix to `[Query Layer]`.
Memo and test reset, lines 135-151 and 173-176. Every new loader needs `reset…ForTests`.

### `src/lib/rag/pipeline.ts` / `src/lib/rag/v2/pipeline.ts` (stage additions)

**Analog:** `runStage`, `pipeline.ts:100-158`. Use it unchanged. The `disabled` / `skipped` / `aborted` records follow D-28.
```ts
if (!spec.enabled) { collector.record({ name: spec.name, status: 'disabled', reason: 'disabled', ... }); return { skipped: true, reason: 'disabled' }; }
const signal = AbortSignal.any([parent, AbortSignal.timeout(spec.timeoutMs)]);
...
collector.record({ name: spec.name, status: 'skipped', reason, startedAt, endedAt, candidatesIn });
```
- Every query transform uses `stageSpec(...)` (`pipeline.ts:168-190`) with `onFail: 'skip'`. Eval-only overrides come through `requestOverrides = profile === 'eval' ? overrides : undefined` (L177). The D-38 overrides reuse that gate.
- `deriveStatus`, L160-166, marks any `skipped` record as degraded. A-2 needs an exception for `semantic_cache`: filter that stage out before calling it, and do not change the function's signature (P-3).
- Integration point: insert the new stages before `embed` (pattern at L486-493). The v2 equivalent is the query stage group in `src/lib/rag/v2/stages/query.ts` **(plan 04-20 / 04-24)**. The A-7 group deadline starts at the gate start time.
- `RunRetrievalInput`, `types.ts:110-119`, gains `history?`, `classification?` and `timeZone?`, all optional. `RetrievalResult`, L121-133, gains `queryPlan` and `cacheHit?`.

### `src/lib/rag/deps.ts` (inject query LLM and cache backend)

**Analog:** itself, lines 8-40. Add `queryLlm` and `semanticCache` fields to `RagDeps` the same way `embedder` is added, with defaults in `defaults` and fakes through `setRagDepsForTests`. Add the new env names to the object that `ragEnv()` returns (L21-25).

### `src/lib/rag/query/llm.ts`

**Analog:** `src/lib/rag/embeddings/openai.ts:1-25`. It creates the client lazily, reads the model from `env` with a default, and passes `signal` through.
```ts
let client: OpenAI | null = null;
function getClient(): OpenAI { if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY }); return client; }
export async function embedText(text: string, opts: { signal: AbortSignal }) { ... { signal: opts.signal } }
```
Differences from the analog:
- Use the AI SDK `generateText` + `Output.object` with `maxRetries: 0`, `temperature: 0` and `abortSignal` (A-5).
- Use the OpenRouter AI SDK provider, not the `openai` client. `src/lib/openrouter.ts:8-30` shows the guard for a missing key and a one-time warning.
- Validate the output with the generated `zod/v3` schemas.
- Never log the key (`OPENROUTER_API_KEY_STATUS` convention).
- A new boundary rule allows query-LLM calls only in this file (D-13).

### `src/lib/rag/query/language.ts` / `rewrite-gate.ts`

**Analog:** `src/lib/rag/lang/detect.ts:1-43`. It holds module-level `Set` stopword lists and a pure `detectLanguage()` that uses Han and Latin script ratios. Extend this detector rather than writing a second one (P-12). Either re-export it from `query/language.ts`, or move the word lists into `rewrite-gate.lexicon.json` and have both import them. Keep `HAN_SHARE_FOR_ZH`-style named constants. The gate should be a pure, synchronous function with no I/O, so the p99 < 1 ms benchmark can pass.

### `src/lib/rag/query/dates.ts`

**Analog:** `src/lib/rag/query/temporal-query-detector.ts:8-42` (`TemporalQueryContext`, `defaultQueryContext`, `analyzeQuery`). The trace-only date range comes from **plan 04-14**. Explicit dates stay with the temporal analyzer (D-11). `dates.ts` adds only R2 relative ranges, uses `Intl` with an IANA zone validated by `Intl.DateTimeFormat(…, { timeZone })` inside try/catch, falls back to UTC, and takes `now` from `deps.now()`.

### `src/lib/rag/query/router.ts`

**Input type:** `QueryClassification` from `src/lib/query-classifier.ts:9`. The caller passes it in and the router never calls `classifyQuery` again (D-09). Today the chat route calls it at `src/app/api/chat/route.ts:1358`. Under A-1, only `tool_required && needsMcp` (no transforms) and `multi_step` (decompose hint) are read.

### `src/lib/rag/query/transformer.ts`, `plan.ts`, `llamaindex/*`

**Analogs:** the interface, default and override pattern in `deps.ts`, and the Phase 4 seam **(plan 04-24: `src/lib/rag/query/variants.ts`, `translate.ts`)**. Phase 6 widens the variant type `original | translated` and the cap (A-6). It does not fork the seam. Fusion goes through `src/lib/rag/fusion/rrf.ts` + `dedupe.ts` **(plan 04-11)**: k=60, tie-break by chunk id. Never write a second RRF. Prompts are versioned JSON data files, following the lexicon-as-data rule from **plan 04-03** (rules moved into data).

### `src/lib/rag/query/langchain/*` (no in-repo analog)

- Load it with a dynamic `import()` only when `RAG_QUERY_FRAMEWORK=langchain`. The same lazy-import shape is in `src/lib/rag/tenant/admin.ts:24-29`:
```ts
async function sessionUser() { const { createClient } = await import('@/lib/supabase/server'); ... }
```
- The port it wraps is `searchVariant` / `finishRetrieval`. Export it from the v2 search stage **(plan 04-19 `src/lib/rag/v2/stages/search.ts`)** and bind the `TenantScope` in that module. The adapter must not import `tenant/`, `backend/`, `embeddings/`, `rerank/` or Supabase. D-19 boundary rules enforce this.
- Everything else follows RESEARCH Pattern 4 and A-4: chunk id as `pageContent`, one retriever per variant x leg.

### `src/lib/rag/cache/pgvector.ts`, `redisvl-http.ts`, `index.ts`, `bypass.ts`, `keys.ts`

**Analog for the RPC adapter:** `src/lib/rag/backend/supabase-rpc.ts` (102 lines). It holds the typed `RpcClient`, the `RetrievalBackendError` class, and the admin client from `deps.adminClient()` (see `requireAdminSearchClient`, `pipeline.ts:207-211`). Call only the server-role `rag_semantic_cache_*` functions.
**Analog for the HTTP adapter:** `embeddings/openai.ts` passes the signal through. Sidecar auth sends the `x-sidecar-secret` header (`rag-sidecar/src/rag_sidecar/auth.py:10`) with the secret from `env.RAG_SIDECAR_SECRET` and the URL from `env.RAG_SIDECAR_URL` (`src/lib/env.ts:169-170`).
**Fail-open (D-36):** wrap every call in `runStage(..., onFail: 'skip')` with a 150 ms timeout. A miss never degrades the request. Log store failures as `console.warn('[Semantic Cache] …', { tenantKeyHash, reason })`, never the query text.
**bypass.ts:** a pure function, following the RESEARCH "Bypass decision" code example (lines 587-605).

### `rag-sidecar/src/rag_sidecar/contracts/query.py` (+ `eval_run.py`, `latency.py`, `__init__.py`, `samples.py`)

**Base class:** `_Contract` with `extra="forbid", frozen=True` (`eval_run.py:6-7`). Import it the way `latency.py:5` does: `from rag_sidecar.contracts.golden import _Contract`.
**Model with a validator:** `latency.py:10-33` uses `@model_validator(mode="after")` for cross-field rules. Use it for the D-08 caps (≤2 LLM variants, ≤2 translations, ≤4 sub-questions, ≤8 searches) in `QueryParams`.
**Models for LLM output:** `ingest.py:204-208` (`DocTypeDetection`). Under A-5/P-4, every field is required and fields that may be empty are `X | None` with no default.
**Name collision:** `GateResult` already exists (`rag-sidecar/schemas/GateResult.schema.json`, the eval gate). Name the new model `RewriteGateResult` (P-2).
**Edits to `eval_run.py`:**
- `RagRunOptions`, L42-49, gains `query_framework`, `query_layer`, `query_transforms`, `semantic_cache`. All are optional and default to `None`. `disabled_stages` `max_length=9` (L48) must grow with the new stage count.
- `RagTrace`, L117-136, gains `query_plan: QueryPlan | None = None`.
- `TraceQueryTransform`, L101-103, is reused for `query_transforms`.
**`latency.py`:** `ProfileBudget.stages`, L22-25, is a free `dict[str, float]`. Add a `query` group per profile here, or as a sibling field (D-29).

### Generated schemas and Zod

**Analog:** `rag-sidecar/src/rag_sidecar/export_schemas.py:9-60`. Import each model, append `(Model, "validation" | "serialization")` to `CONTRACTS`, and add a sample to `contracts/samples.py` (`build_samples`) so `tests/fixtures/contracts/samples.json` and `tests/contracts.test.ts` / `tests/schema-parity.test.ts` cover it. Run `npm run gen:schemas` (`package.json:19`). The output is `src/lib/rag-eval/contracts.generated.ts` (`scripts/gen-zod.mjs:11`). App code imports from there with `zod/v3`.

### `rag-sidecar` cache endpoints

**Analog:** `rag-sidecar/src/rag_sidecar/main.py:11-38`. `create_app(settings)` sets up `SharedSecretMiddleware` and a `v1 = APIRouter(prefix="/v1")` with `response_model=`. Add `app.include_router(cache_router)` only when the optional `redisvl` import succeeds. Without the extra, `/v1/cache/*` returns 503 `SidecarError`, the same way `ready()` does (L22-25):
```python
not_ready = SidecarReady(status="not_ready", reason="sidecar secret not configured")
return JSONResponse(status_code=503, content=not_ready.model_dump(mode="json"))
```
Auth needs no change: every non-probe path is already covered (`auth.py:9,26-46`).
**`pyproject.toml`:** add `[project.optional-dependencies] cache = ["redisvl==0.32.0", "redis==8.1.0"]` next to `dependencies` (L6-11), and re-lock `uv.lock` (P-15).
**Tests:** `rag-sidecar/tests/test_auth.py`, `test_boot.py` (TestClient on `create_app`).

### SQL migrations

**Analogs (plans):**
- `rag_tenant_language_shares(p_tenant_key)`: copy the shape of `supabase/migrations/0407_hybrid_search_chunks.sql` **(plan 04-15)**. That means `security definer`, `set search_path`, a call to the mode-specific tenant-key guard **(plan 04-07)**, `revoke ... from anon, authenticated` and `grant execute ... to service_role`. Grant tests follow `tests/rag-search-rpc-grants.test.mts` (tracked) and `tests/rag-db/hybrid-grants.test.mts` **(plan 04-15)**.
- `rag_semantic_cache` table + `check` / `store` / `invalidate` functions: copy `0355_parse_cache.sql` **(plan 03.1-10)**, a tenant-keyed cache that "can only ever be found by the tenant that produced it". Filter by `tenant_key`, `key_hash` and embedding profile before computing distance (P-5, A-6).
- Invalidation: three single-event triggers on `documents` (A-6), next to `rag_publish_document_version` (Phase 3 D-11) and `rag_soft_delete_document` **(`0357_soft_delete.sql`, plan 03.1-39)**.
- `hybrid_search_chunks` + `p_include_undated`: `DROP FUNCTION` the old signature, then `CREATE` the new one (P-8). Otherwise a second overload is created and `retrieval-rpc` callers become ambiguous.
- Copy each migration into both `supabase/*-setup.sql` files, as **plan 04-42** does. PGlite fixture tests use `eval/harness/pglite-supabase.mts` and the role-enforcing edge **(plan 04-05)**.

### `src/app/api/rag/admin/semantic-cache/route.ts`

**Guard:** `src/lib/rag/tenant/admin.ts:52-92` (`requireRagAdmin`, exported from `@/lib/rag`). It fails closed with 401, 403 or 503 and checks `admin_users` on every call.
```ts
const auth = await requireRagAdmin({ headers: req.headers, signal: req.signal });
if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: auth.status });
```
**Body validation:** `validateRequest(req, Schema)` from `@/lib/api-middleware`, the same call as in `src/app/api/internal/rag/run/route.ts:3,42-45`. The body carries a `tenantKey`, validated by `parseTenantKey` (`@/lib/rag`). Copy the route layout from **plan 03-40** (`src/app/api/rag/admin/embedding-profiles/route.ts`) and **plan 04-34**. Use `export const runtime = 'nodejs'` and return structured `{ error }` JSON. Import only from `@/lib/rag`, which the `deep-import` rule enforces.

### `src/app/api/internal/voice-rag/route.ts`

**Analog:** itself. Add `history: z.array(z.object({ role: z.enum(['user','assistant']), content: z.string().min(1).max(1000) })).max(6).optional()` to `bodySchema` (L9-12), and pass `history` into `runRetrieval` (L57-63). The response shape (L72-82) must stay unchanged (D-30).

### `src/app/api/internal/rag/run/route.ts`

**Analog:** `toStageOverrides`, L19-30. Add a sibling mapper for the D-38 overrides, `query_framework`, `query_layer`, `query_transforms` and `semantic_cache`, and pass them only for the eval profile.

### `voice-agent/src/voice_agent.ts`, `rag_client.ts`, `.env.example`

**Analog:** `rewriteQueryWithContext`, L393-466. When `VOICE_SERVER_QUERY_REWRITE !== 'true'`, the path stays exactly as it is. When it is `true`, skip the call at L466 and send `history` (the last 6 non-system turns, as in L401-405) in the `rag_client.ts` request body. Read the env the way `voice-agent/src/agent.ts:63-74` does (`process.env.X || default`). Add the variable to `voice-agent/.env.example` with a placeholder. The voice agent must not call RPCs (rule `voice-agent-rpc`).

### `scripts/ci/check-rag-boundary.mjs` (D-19 rules)

**Analog:** itself. Rules are objects `{ id, description, appliesTo, find }` (L184-280), built from `importMatches` / `listImports` (L161-178). Example to copy, `vector-or-rerank-client` at L222-235:
```js
{ id: 'vector-or-rerank-client', appliesTo: outsideRag,
  find: (text) => importMatches(text, ({ spec, clause }) => { if (VECTOR_OR_RERANK_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) return spec; ... }) },
```
New rules:
- `langchain-import`: `@langchain/` only under `src/lib/rag/query/langchain/`.
- `langchain-adapter-reach`: from that directory, no imports of `../../tenant|backend|embeddings|rerank` or `@supabase/*` / `@/lib/supabase`.
- `zod-v4`: no `zod/v4` or bare `zod` v4 APIs in app code.
- `query-llm-call`: `generateText` / `generateObject` only in `query/llm.ts` and the adapter, within `src/lib/rag/`.

Define the directory constant next to `RAG_DIR` (L82-85). Self-tests go in `scripts/tests/check-rag-boundary.node-test.mjs`, using the `makeRoot(files)` + `rulesFor` helpers (L15-28). Each rule needs a positive case and a negative case.

### `eval/src/rag_eval/compare/*` (frameworks)

**Analog:** `eval/src/rag_eval/paired.py`:
- `paired_report`, L84-108, takes paired differences with a bootstrap (`SEED`, `RESAMPLES`, L13-14, and `_bootstrap_interval`, L54-61).
- `_slice_members`, L76-82, handles slices.
- `main(argv)`, L117+, uses argparse with `EXIT_OK`/`EXIT_INVALID` and `resolve_cli_path`.

Package entry: `eval/src/rag_eval/draft/__main__.py` (`raise SystemExit(main())`). Report models live in `rag_sidecar.contracts.baseline` (`PairedReport`, `PairedStat`). Tests copy `eval/tests/test_paired.py`.

### `eval/src/rag_eval/calibrate/cache.py`

**Analog:** `eval/src/rag_eval/calibrate/refusal.py` + `__main__.py` **(plan 04-30)**: fit on the dev split, check once on the holdout, record every number, write a committed JSON. Add a `cache` subcommand to the same `__main__` dispatcher.

### `eval/config/*.json`, `eval/fixtures/query-llm/*.json`

**Analog:** `eval/config/latency-budgets.json`, which has sorted keys and `schema_version: 1` and is validated by its Pydantic model (`LatencyBudgets`, `latency.py:36-38`). The writer/loader pair is `retrieval-params.json` + `src/lib/rag/v2/retrieval-params.ts` **(plans 04-04, 04-44)**: Pydantic defaults write the initial file, it is read once at startup, and eval-only overrides apply. Fake-LLM fixtures follow `eval/fixtures/translation-table.json` **(plan 04-24)**. Pin `NEXT_PUBLIC_MCP_SYSTEM_ENABLED` and every new `RAG_QUERY_*` / cache var in `eval/config/rag-eval-env.json`, next to `RAG_PIPELINE` at L40. `tests/eval-env-pin.test.ts` checks the pins.

## Shared Patterns

### Five-place env sync (every D-26 variable)
Use `RAG_STAGE_TIMEOUTS` as the template. Every location has a matching line:
- `src/lib/env.ts:174`: `RAG_STAGE_TIMEOUTS: process.env.RAG_STAGE_TIMEOUTS || '',`
- `scripts/init-env.js:338-346`: section header comment + one-line comment + `NAME=default`
- `scripts/config-server.js`: three template blocks, at L550-552 (`${fullValues.X !== undefined ? ... : 'X=default'}`), L1335-1337 and L1686-1688 (`X=${getEnvValue('X') || 'default'}`)
- `scripts/config-ui/index.html:6449-6459`: `form-control` with `id="NAME"`, placeholder and `label-text-alt` help
- `scripts/rag/env-manifest.json:466-470`: `{ "name", "status": "managed", "knownGaps": [] }`, checked by `scripts/check-config.mjs`
- `eval/config/rag-eval-env.json`: the pin

Leave the legacy names (`NEXT_PUBLIC_RAG_QUERY_ENHANCEMENT_ENABLED`, `NEXT_PUBLIC_RAG_CACHE_ENABLED`, `env-manifest.json:105,151`) alone. Full recipe: **plan 04-02**.

### Config UI panel
The card markup to copy is at `scripts/config-ui/index.html:6417-6465` ("Retrieval pipeline"). Admin actions call routes from a separate module, `scripts/config-ui/rag-panels/*.js` **(plans 03-43, 03.1-36, 04-36)**, and that module is tested from `tests/ui/`.

### Tenant isolation
`TenantScope` is created only in `src/lib/rag/tenant/` (rule `mint-scope`, boundary L237-251). The cache key and the SQL both carry `scopeKey(scope)`. Cross-tenant tests extend `tests/rag-two-tenant.test.mts` and the Phase 4 matrix **(plan 04-41)**.

### Logging
Use bracketed prefixes `[Query Layer]` and `[Semantic Cache]`. Log once per problem (`config.ts:68-73`). Pass structured objects as the second argument. Never log query text, history or keys. Pipeline warnings go through `logger.warn('RAG Pipeline', ...)` (`pipeline.ts:155`).

### Route errors
Return `NextResponse.json({ error }, { status })`. Validate with `zod/v3` through `validateRequest`. Wrap `req.json()` in try/catch and return 400 on failure (`voice-rag/route.ts:35-40`).

### Tests
Vitest (`package.json:15`). Fakes go through `setRagDepsForTests` / `resetRagDepsForTests` (`deps.ts:34-40`). Env-driven route tests follow `tests/eval-route-auth.test.ts:5-21,70-95`. DB tests are `.test.mts` on PGlite.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/lib/rag/query/langchain/*` | adapter | request-response | No LangChain code in the repo. Use RESEARCH Pattern 4 and A-4. |
| `rag-sidecar/src/rag_sidecar/cache/service.py` (RedisVL) | service | CRUD | No Redis use anywhere. Use RESEARCH Pattern 9. |
| `src/lib/rag/query/prompts/*.json` (vendored MIT prompts) | data | — | No vendored third-party prompt files exist. Add source, version and licence fields (A-5). |
| `npm ls zod` CI step | CI | batch | No dependency-tree check exists. Use the RESEARCH snippet and wire it beside `scripts/ci/check-node-runtime.mjs` in `.github/workflows/pr-smoke.yml`. |

## Metadata

**Analog search scope:** `src/lib/rag/**`, `src/app/api/internal/**`, `src/lib/{query-classifier,openrouter,env}.ts`, `rag-sidecar/**`, `eval/**`, `scripts/ci/**`, `scripts/tests/**`, `scripts/config-ui/index.html`, `scripts/{init-env,config-server}.js`, `scripts/rag/env-manifest.json`, `voice-agent/**`, `.planning/phases/03*/,03.1*/,04*/` plan frontmatter
**Files scanned:** ~70
**Pattern extraction date:** 2026-11-24
