# Phase 4: Hybrid Retrieval, Reranking & Calibrated Refusal - Pattern Map

**Mapped:** 2026-11-23
**Files analyzed:** 46 new or modified files (grouped into 24 entries below)
**Analogs found:** 20 / 24 entries (4 have no in-repo analog)

## Facts at HEAD that change what the planner may assume

1. **The fake helpers live in `tests/rag/helpers/pipeline-fakes.ts`**, not `tests/helpers/pipeline-fakes.ts`. `tests/helpers/` holds only `chat-route-fakes.ts` and `route-fixture.ts`. Test imports use `./helpers/pipeline-fakes` from inside `tests/rag/`.
2. **Phase 3 has not landed.** At HEAD there is no `supabase/migrations/` directory, no `src/lib/rag/lexical/`, no `embedding_profiles`/`score_calibration`, no `tenant_key`/`is_current`/`lexical_text` columns, and no migrations option in `createFixtureDatabase`. Phase 4 plans that use these must depend on Phase 3's plans (03-01..03-06 exist as PLAN files only). Treat the Phase 3 objects as upstream contracts, named in `03-PATTERNS.md`.
3. **`mintScope` does not lower-case ids yet** (`src/lib/rag/tenant/scope.ts:34-51`, `UUID_RE` is `/i`). Per D-33, if Phase 3 has not done it, the first Phase 4 plan does.
4. **`scripts/ci/check-rag-boundary.mjs` does not exist** (`scripts/ci/` holds `check-node-runtime.mjs`, `check-workflows.py`, `tsc-ratchet.mjs` and the baseline JSON files). The rerank-HTTP boundary rule depends on Phase 2 plan 02-20.
5. **Test runners:** vitest collects only `tests/**/*.test.ts` (`vitest.config.ts:13`). DB-level `tests/*.test.mts` files use `node:test` + `node:assert/strict`. A conformance `cases.ts` must have no `.test` suffix.
6. **`eval/config/` has `draft.json`, `judge.json`, `noise.json`, `rag-eval-env.json`.** `retrieval-params.json`, `refusal-thresholds.json`, `refusal-calibration.json` and `latency-budgets.json` (02-24) are new files.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/lib/rag/config.ts` (mod: stage names, `pipeline: 'legacy' \| 'v2'`, D-23 env inputs, memo key) | config | transform | itself (`config.ts:3-11, 50-90, 131-149`) | exact |
| `src/lib/rag/deps.ts` (mod: `ragEnv()` fields, `reranker`/`fetch` seams) | provider / DI | request-response | itself (`deps.ts:9-43`) | exact |
| `src/lib/rag/types.ts` (mod: `KeptBy` + `'rerank' \| 'fused'`, `RetrievalResult.refusal`, `retrievalConfigHash`, `StageOverrides` + `retrievalOverrides`) | model | n/a | itself (`types.ts:61, 90-122`) | exact |
| `src/lib/rag/pipeline.ts` (mod: v2 branch dispatch) and `src/lib/rag/v2/pipeline.ts` (new stage graph) | service / orchestrator | request-response, streaming stages | `pipeline.ts:318-460` (`runPipeline`) and `471-555` (`runVoicePipeline`) | exact |
| `src/lib/rag/v2/profiles.ts` (per-profile timeouts and budgets) | config | n/a | `config.ts:19-45` (`STANDARD_TIMEOUTS`, `PROFILE_STAGE_DEFAULTS`) | exact |
| `src/lib/rag/backend/types.ts` (`RetrievalBackend`, `RankedHit`, `RetrievalFilters`) | model / interface | n/a | `backend/supabase-rpc.ts:4-40` | role-match |
| `src/lib/rag/backend/pgvector.ts` (adapter for `hybrid_search_chunks`) | repository / adapter | request-response (RPC) | `backend/supabase-rpc.ts:50-102` (`vectorSearch`) | exact |
| `src/lib/rag/backend/registry.ts` | factory | n/a | `src/lib/rag/deps.ts:20-43` (defaults + override) | partial |
| `src/lib/rag/lexical/tokenize.ts`, `rules.json`, `relex.ts`, `icu-check.ts` | utility (pure) | transform | `rerank/local-hybrid.ts:15-21` (`tokenize`) — and Phase 3's `lexical/tokenize.ts` v1 once it lands | partial |
| `src/lib/rag/fusion/rrf.ts`, `fusion/dedupe.ts` | utility (pure) | transform | `rerank/local-hybrid.ts` (pure scorer module) | role-match |
| `src/lib/rag/rerank/types.ts`, `cohere.ts`, `voyage.ts`, `select.ts`, `text.ts` | service / HTTP adapter | request-response | `src/lib/rag/embeddings/openai.ts` (provider fn taking `signal`) + `backend/supabase-rpc.ts:30-40` (error class) | role-match |
| `src/lib/rag/rerank/local-bm25.ts` | utility (pure scorer) | transform | `rerank/local-hybrid.ts:23-60` (`calculateBM25Score`, k1 1.2, b 0.75) | exact |
| `src/lib/rag/refusal/gate.ts`, `refusal/thresholds.ts` | utility (pure decision) + config loader | transform | `context/assemble.ts:239-243` (`refusalCandidate`) + `config.ts:63-68` (`problem()` warn-once) | role-match |
| `src/lib/rag/context/assemble.ts` (mod: group-order input to `buildContext`) + new `merge-adjacent.ts`, `edge-order.ts`, `budget.ts`, `compress.ts` | utility (pure) | transform | `context/assemble.ts:80-266` | exact |
| `src/lib/rag/parents/expand.ts` | repository | request-response (RPC) | `backend/supabase-rpc.ts:50-102` | role-match |
| `src/lib/rag/query/variants.ts`, `detect-language.ts`, `timeframe.ts`, `translate-fixture.ts` | utility | transform | `query/temporal-query-detector.ts` (`defaultQueryContext`) | role-match |
| `src/lib/rag/config/retrieval-params.ts`, `config/config-hash.ts` (static JSON import + Zod) | config loader | file-I/O (build-time) | `config.ts` + generated Zod under `src/lib/rag-eval/contracts.generated.ts` | role-match |
| `src/lib/rag/trace/collector.ts`, `trace/log.ts` (mod: per-stage counts/detail fields, F-22) | utility | event-driven | itself (`collector.ts:7-17, 53-66`; `log.ts:13-27`) | exact |
| `supabase/migrations/0401..0405_*.sql` + mirrored into both setup files | migration | CRUD | `supabase/multi-tenant-setup.sql` `match_documents_by_workspace` (per 03-PATTERNS L34) + `probe/pattern1.sql` (executed in PGlite) | role-match |
| `eval/harness/pglite-supabase.mts` (mod: role shim, migrations), `eval/harness/fake-edge.mts` (mod: role per apikey, `hybrid_search_chunks`, `/v2/rerank`, `/v1/rerank`) | test harness | request-response | themselves (`pglite-supabase.mts:28-36, 43-63`; `fake-edge.mts:26-35`) | exact |
| `tests/rag/helpers/pipeline-fakes.ts` (mod: `fakeReranker`, `fakeHybridRpc`) | test helper | n/a | itself (`pipeline-fakes.ts:27-147`) | exact |
| `tests/rag/backend-conformance/cases.ts` + `pgvector.test.ts`; `tests/rag/{rrf,dedupe,rerank-*,refusal-gate,edge-order,budget,v2-pipeline}.test.ts`; `tests/rag-hybrid-*.test.mts` | test | n/a | `tests/rag/stage-runner.test.ts:1-50`, `tests/rag/config.test.ts:1-40`, `tests/two-tenant-fixture.test.mts:1-30` | exact |
| `rag-sidecar/src/rag_sidecar/contracts/retrieval.py` (new), `eval_run.py` (mod: `retrieval_overrides`, `refusal_reason` Literal, `kept_by` Literal) + `npm run gen:schemas` | model (contract) | n/a | `contracts/eval_run.py:1-30` | exact |
| `eval/src/rag_eval/calibrate/{refusal,bounds}.py`, `eval/src/rag_eval/sweep/{retrieval,chunking}.py` + `eval/tests/test_*.py` | CLI / batch | batch | `eval/src/rag_eval/split.py`, `baseline.py`, `runner.py`; tests `eval/tests/test_baseline.py` | role-match |
| Env sync: `src/lib/env.ts`, `scripts/init-env.js`, `scripts/config-server.js` (3 places), `scripts/config-ui/index.html`, `scripts/rag/env-manifest.json` | config | n/a | the `RAG_STAGE_TIMEOUTS` entries at each site | exact |
| `scripts/rag/relex.*` (`npm run rag:relex`) | script / batch | batch | `scripts/rag/reprocess-documents.js` | partial |
| `src/app/api/internal/rag/run/route.ts` (mod: accept `retrieval_overrides`, eval only) | route | request-response | `pipeline.ts:164` eval-only override gate; route per Phase 2 plan 02-11 | role-match |

## Pattern Assignments

### `src/lib/rag/config.ts` (config, transform) — modify

**Analog:** itself.

Stage tables to extend (lines 3-15). Add `fuse` to `CORE_STAGES` (D-24); add `translate`, `exact_id_lookup`, `dedupe`, `rerank`, `refusal`, `expand_parents`, `compress` to `OPTIONAL_STAGES`. Keep the legacy names: legacy still runs through them.
```typescript
export const CORE_STAGES = ['embed', 'search'] as const;
export const OPTIONAL_STAGES = [
  'analyze', 'legacy_rank', 'post_filter', 'assemble', 'voice_keyword_fallback', 'local_rerank',
] as const;
export type StageName = CoreStageName | OptionalStageName;
```
`tests/rag/config.test.ts:28-38` pins these arrays with `toEqual`. Update that test in the same task.

Pipeline parse to widen (lines 81-87). Keep the warn-once `problem()` helper (lines 63-68) and the `[RAG Config]` prefix:
```typescript
function parsePipeline(raw: string | undefined, warnings: string[]): 'legacy' {
  const value = (raw ?? '').trim();
  if (value !== '' && value !== 'legacy') {
    problem(warnings, `pipeline:${value}`, 'Unsupported RAG_PIPELINE value, running legacy', { value });
  }
  return 'legacy';
}
```
Memo key (line 132). It must include every new D-23 input, or a changed switch is served stale:
```typescript
const snapshot = JSON.stringify([env.RAG_PIPELINE ?? '', env.RAG_DISABLED_STAGES ?? '', env.RAG_STAGE_TIMEOUTS ?? '']);
```
Map boolean switches (`RAG_LEXICAL_SEARCH=false`, `RAG_RERANKER=none`, `RAG_REFUSAL_THRESHOLD=false`, `RAG_CONTEXT_COMPRESSION=false`, `RAG_PARENT_CHILD=false`) into `disabledStages` so `stageSpec` records `disabled` (D-11). Do not add a second disable mechanism. Keep `resetRagConfigForTests()` (lines 151-154) clearing every new memo.

### `src/lib/rag/deps.ts` (DI) — modify

**Analog:** itself (lines 9-43). Add the new env fields to `ragEnv()` and add a `fetch`/`reranker` seam the same way `embedder` is injected:
```typescript
export interface RagDeps {
  anonClient: () => RpcClient;
  adminClient: () => SupabaseClient | null;
  embedder: (text: string, opts: { signal: AbortSignal }) => Promise<number[]>;
  now: () => number;
  randomId: () => string;
  ragEnv: () => RagEnvInput;
}
...
  ragEnv: () => ({
    RAG_PIPELINE: env.RAG_PIPELINE,
    RAG_DISABLED_STAGES: env.RAG_DISABLED_STAGES,
    RAG_STAGE_TIMEOUTS: env.RAG_STAGE_TIMEOUTS,
  }),
```
Tests override through `setRagDepsForTests` / `resetRagDepsForTests` (lines 36-43). Adapters read env only through `loadRagConfig(deps.ragEnv())`, never `process.env` (RESEARCH Pattern 2).

### `src/lib/rag/types.ts` (model) — modify

**Analog:** itself. Additive changes only:
- `KeptBy` (line 61): `'similarity' | 'name' | 'image'` gains `'rerank' | 'fused'`. The Pydantic `kept_by` Literal changes in the same plan, then `npm run gen:schemas`.
- `StageRecord` (lines 28-39): fields are `name, status, reason?, startedAt, endedAt, latency_ms, candidates_in, candidates_out, rules, detail?`. Status values are `StageRunStatus = 'ok' | 'skipped' | 'disabled' | 'error' | 'timeout' | 'aborted'` (line 24). Reasons are `StageFailureReason = 'failed' | 'timeout' | 'aborted'` plus `'disabled'` (line 26). A refusal is **not** a failure: the refusal stage records `ok` and puts the decision in `detail`/counts (RESEARCH F-22).
- `StageOverrides` (lines 90-93): add an optional `retrievalOverrides` object. It stays eval-only through the existing gate.
- `RetrievalResult` (lines 106-122): add `refusal: RefusalRecord | null` and `retrievalConfigHash: string`. `failure()` in `pipeline.ts:199-221` builds every result, so the defaults go there once.

### `src/lib/rag/pipeline.ts` + `src/lib/rag/v2/pipeline.ts` (orchestrator)

**Analog:** `runPipeline` (`pipeline.ts:318-460`) and `runVoicePipeline` (`471-555`).

**Imports pattern** (lines 1-37). `@/` for app-wide modules, relative `./` inside `src/lib/rag`, `type` imports for types:
```typescript
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { RetrievalBackendError, vectorSearch, type RawChunk, type RpcClient } from './backend/supabase-rpc';
import { CORE_STAGES, FALLBACK_STAGE_TIMEOUT_MS, loadRagConfig, type RagConfig, type StageName } from './config';
import { getRagDeps } from './deps';
import { assertTenantScope, scopeKey } from './tenant/scope';
import { createTraceCollector, type TraceCollector } from './trace/collector';
```
`v2/pipeline.ts` imports `runStage`, `StageError`, `deriveStatus` and `stageSpec` from `../pipeline`. Export `stageSpec`, `requireValue`, `failure` and `degradedReason` from `pipeline.ts`; do not copy them. Watch for a circular import if `pipeline.ts` imports `v2/pipeline.ts`. Either dispatch from `runRetrieval` via a lazy `await import('./v2/pipeline')`, or move the shared helpers to `stage.ts`.

**Dispatch point** (lines 305-316). Branch on `loadRagConfig(...).pipeline === 'v2'` here, after `assertTenantScope`:
```typescript
export async function runRetrieval(input: RunRetrievalInput): Promise<RetrievalResult> {
  if (input.scope !== null) assertTenantScope(input.scope);
  const ownsTrace = input.trace === undefined;
  const collector = input.trace ?? createTraceCollector({ profile: input.profile, tenantKey: input.scope ? scopeKey(input.scope) : 'none' });
  const result = input.profile === 'voice' ? await runVoicePipeline(input, collector) : await runPipeline(input, collector);
  if (ownsTrace) finishTrace(collector, result);
  return result;
}
```

**Stage registration via `runStage`** (lines 88-146 contract; usage lines 330-376). Core stages use `'throw'` wrapped in `requireValue`; optional stages use `'skip'` and fall back on `.skipped`:
```typescript
const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, input.stageOverrides);

const embedding = requireValue(
  await runStage(spec('embed', 'throw'), signal, (stageSignal) => deps.embedder(input.query, { signal: stageSignal }), collector),
  'embed',
);

const ranked = await runStage(
  spec('legacy_rank', 'skip'),
  signal,
  () => legacyRank(searched.results, analysed),
  collector,
  { candidatesIn: searched.results.length, candidatesOut: (value) => value.length },
);
candidates = ranked.skipped ? searched.results : ranked.value;
```
Every v2 stage (`translate`, `search` with `Promise.all` over variants sharing `stageSignal`, `exact_id_lookup`, `fuse` (throw), `dedupe`, `rerank` (skip; failure -> fused order), `refusal`, `expand_parents`, `assemble`, `compress`) follows this shape. Always pass `stageSignal` into I/O. `detail:` carries short non-content strings such as `value.retrievalStrategy` (line 365). Never put query or chunk text in it.

**Eval-only overrides gate** (lines 164-167). Copy this for `retrievalOverrides`:
```typescript
const requestOverrides = profile === 'eval' ? overrides : undefined;
```

**Status and reason codes** (lines 148-154, 223-226, 440-443). Existing reason strings are `ok`, `no_tenant`, `no_candidates`, `no_relevant_context`, `aborted`, `backend_error`, `${stage}_${reason}` (e.g. `embed_timeout`) and degraded `${name}_${reason}`. Phase 4 adds `below_threshold` and (D-30) `below_similarity_floor`, and `embedding_profile_mismatch` from the SQL message prefix. Per D-31 the refusal check runs before `deriveStatus` and wins over `degraded`:
```typescript
export function deriveStatus(records: StageRecord[], survivingCount: number): RetrievalResult['status'] {
  if (records.some((record) => record.status === 'error' || record.status === 'timeout' || record.status === 'aborted')) return 'error';
  if (records.some((record) => record.status === 'skipped')) return 'degraded';
  return survivingCount === 0 ? 'empty' : 'ok';
}
```
On refuse, set survivors to `[]`, still call `filterCandidates` + `buildContext` with `applyRelevanceFilter: false` so referenced documents survive (D-31), then set `status = 'empty'`. D-30: when the gate returns `not_applied`, apply the floor from the active profile's `score_calibration`, or 0.65 (the legacy constant at `assemble.ts:103`) when the profile has none.

**Error handling** (lines 426-438). Copy this catch block unchanged into the v2 runner:
```typescript
} catch (error) {
  if (error instanceof StageError) {
    if (error.reason === 'aborted') return failure(collector, 'error', 'aborted', queryContext);
    if (error.original instanceof RetrievalBackendError) {
      logger.error('RAG Pipeline', 'Backend error', { rpc: error.original.rpc, code: error.original.code });
      return failure(collector, 'error', 'backend_error', queryContext);
    }
    logger.error('RAG Pipeline', 'Stage failure', { stage: error.stage, reason: error.reason });
    return failure(collector, 'error', `${error.stage}_${error.reason}`, queryContext);
  }
  if (signal.aborted) return failure(collector, 'error', 'aborted', queryContext);
  throw error;
}
```

**Assembly-input builder** (lines 380-390). Under v2 the RPC rows feed `documents`/`chunkMetadata` directly. Use no `loadRows` round-trip, and only with `applyRelevanceFilter: false`, because the RPC returns `left(d.content, 200)`.

**Voice under v2** (D-25). Copy the shape of `runVoicePipeline` (`requireAdmin()` lines 480-484, `toVoiceChunk` 466-469 single-tenant id quirk, `assembleVoiceResults` fallback 536). Drop `voice_keyword_fallback` and use the fast tier with a 250 ms rerank timeout.

### `src/lib/rag/v2/profiles.ts` (config)

**Analog:** `config.ts:19-45`.
```typescript
const STANDARD_TIMEOUTS: StageTimeouts = { analyze: 1000, embed: 15000, search: 15000, legacy_rank: 2000, post_filter: 10000, assemble: 10000 };
export const PROFILE_STAGE_DEFAULTS: Record<Profile, StageTimeouts> = {
  chat: { ...STANDARD_TIMEOUTS }, embed: { ...STANDARD_TIMEOUTS }, eval: { ...STANDARD_TIMEOUTS }, media: { ...STANDARD_TIMEOUTS },
  voice: { analyze: 500, embed: 5000, search: 5000, voice_keyword_fallback: 3000, local_rerank: 1000, post_filter: 3000, assemble: 3000 },
};
```
Add rerank budgets (chat 600, voice 250) and the new stage timeouts here. Merging with env overrides stays `{ ...PROFILE_STAGE_DEFAULTS[profile], ...overrides }` (config.ts:142-144). That is F-16: the planner must decide whether v2 defaults are merged before or after the overrides.

### `src/lib/rag/backend/types.ts` + `backend/pgvector.ts` (adapter, RPC)

**Analog:** `backend/supabase-rpc.ts`.

Client and error types to reuse, not redefine (lines 4-40):
```typescript
export interface RpcClient { rpc(fn: string, args: Record<string, unknown>): RpcRequest; }
export class RetrievalBackendError extends Error {
  readonly rpc: string; readonly code: string | null;
  constructor(rpc: string, code: string | null) {
    super(`[RAG Backend] ${rpc} failed${code ? ` (${code})` : ''}`);
    this.name = 'RetrievalBackendError'; this.rpc = rpc; this.code = code;
  }
}
```
Call shape (lines 57-58, 82-95). Assert the scope first, attach the abort signal, call `signal.throwIfAborted()` after the await (postgrest resolves on abort), log the code only, then throw `RetrievalBackendError`:
```typescript
assertTenantScope(scope);
const response = await client
  .rpc('match_documents_by_workspace', { ...args, p_query_embedding: embedding, p_match_count: matchCount, p_min_similarity: threshold })
  .abortSignal(signal);
signal.throwIfAborted();
if (response.error) {
  logger.error('Enhanced RAG', 'Error in workspace vector search', { code: response.error.code });
  throw new RetrievalBackendError('match_documents_by_workspace', response.error.code ?? null);
}
```
Differences for v2: the only tenant input is `p_tenant_key: scopeKey(req.scope)` (`tenant/scope.ts:63-68`). Use `adminClient()`, and on `null` throw `RetrievalBackendError('hybrid_search_chunks', 'admin_unavailable')`; never fall back to `anonClient()`. Send empty filter arrays as `null` (P-12). Use `[Document Search]` as the log prefix for retrieval diagnostics (AGENTS.md §6). The `logger.db(...)` lines in the analog are not something to copy for hot paths.

### `src/lib/rag/rerank/local-bm25.ts` (pure scorer)

**Analog:** `rerank/local-hybrid.ts:1-60`. Keep the `ChunkWithScore`-style interfaces and the BM25 constants:
```typescript
const k1 = 1.2;
const b = 0.75;
...
const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5));
const normalizedTF = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgDocLength)));
```
Replace `tokenize()` (lines 15-21, which strips all non-ASCII through `.replace(/[^\w\s]/g, ' ')`, so Chinese gives zero tokens) with the shared `lexical/tokenize.ts`. Do not change `local-hybrid.ts`: voice legacy still uses it, and `tests/rag/local-hybrid.test.ts` pins it. Normalize by the pool maximum and set `scoreSemantics: 'relative'`.

### `src/lib/rag/rerank/{types,cohere,voyage,select,text}.ts` (HTTP adapters)

**Analog:** the provider-function shape of `embeddings/openai.ts` (takes `{ signal }`, injected through `RagDeps`) plus the error-class pattern above. No repo file does a raw `fetch` adapter with Zod response parsing, so use the RESEARCH Pattern 5 sketch with these repo conventions:
- `RerankError extends Error` with `provider` and `status` only, never the body or the key (same pattern as `RetrievalBackendError`).
- Use `z` from `zod/v3` (CLAUDE.md convention).
- `signal: AbortSignal.any([signal, AbortSignal.timeout(ms)])`, the same composition as `runStage` line 105.
- No retries. `completeScores` throws on partial responses, and `runStage` turns that into `skipped` -> `degraded`.
- `fetch` comes from deps (`deps.fetch`) so tests and the fake edge can intercept it.

### `src/lib/rag/refusal/gate.ts` + `thresholds.ts`

**Analog:** the strict refusal rule at `context/assemble.ts:239-243`, which must keep firing:
```typescript
const refusalCandidate =
  input.ragMode === 'strict' &&
  !input.webSearchEnabled &&
  usedDocuments.length === 0 &&
  context.trim().toLowerCase().startsWith('no relevant context found');
```
`gate.ts` is a pure function returning a `RefusalRecord` (RESEARCH Pattern 7 `decideRefusal`, with `not_applied` reasons `switch_off`, `reranker_disabled`, `reranker_unavailable`, `relative_scores`, `no_candidates`, `invalid_score`, `cell_*`, `cell_stale`). Add the D-30 floor branch. `thresholds.ts`: static `import thresholds from '../../../../eval/config/refusal-thresholds.json'` (`resolveJsonModule`), validated with the generated Zod schema at module load. Report problems through a warn-once helper copied from `config.ts:63-68`.

### `src/lib/rag/context/assemble.ts` (mod) + `merge-adjacent.ts`, `edge-order.ts`, `budget.ts`, `compress.ts`

**Analog:** itself. The relevance filter (line 103) is skipped when `applyRelevanceFilter` is false:
```typescript
if (!applyRelevanceFilter || chunk.similarity > 0.65 || isRelevantByName || (hasImage && chunk.similarity > 0.25)) {
  const keptBy: KeptBy = chunk.similarity > 0.65 ? 'similarity' : isRelevantByName ? 'name' : hasImage ? 'image' : 'similarity';
```
Under v2, `keptBy` must be `'rerank'`/`'fused'`. Add an optional input field for that; do not change the legacy expression. `kept[]` (lines 245-258) uses `rank: index + 1` over `input.candidates`, so pass candidates in reranked order. The one structural change is an optional group-order input to `buildContext`. When it is absent, the output must stay byte-identical (`tests/rag-assemble-differential.test.mts`, `tests/rag/assemble.test.ts`, `tests/rag/legacy-chat-assembly-oracle.test.ts`). New helpers are pure, generic modules (`edgeOrder<T>(byRank: T[]): T[]`). Image documents (`IMAGE_EXTENSIONS`, around line 56) do not count against the token budget. Create the `tiktoken` encoder once per process.

### `src/lib/rag/trace/collector.ts`, `trace/log.ts` (mod)

**Analog:** itself. `StageEntry` (collector lines 7-17) is mapped field by field into `StageRecord` (lines 53-66). Any new field (e.g. `counts: Record<string, number>` for `candidates_in`, `deduped`, `rerank_input`, `capped_from`) must be added to `StageEntry`, `StageRecord` (types.ts), the `record()` mapper, **and** the fixed whitelist in `log.ts:13-27`:
```typescript
stages: collector.stages().map((stage) => ({
  name: stage.name, status: stage.status,
  ...(stage.reason !== undefined ? { reason: stage.reason } : {}),
  latency_ms: stage.latency_ms, candidates_in: stage.candidates_in, candidates_out: stage.candidates_out, rules: stage.rules,
})),
```
Keep the rule in the `log.ts:31` doc comment: the field list is fixed so query and chunk text can never reach the log sink. Counts and numeric scores are fine; text is not. `tests/rag/trace-log.test.ts` asserts this.

### `src/lib/rag/tenant/scope.ts` (mod, D-33, only if Phase 3 has not done it)

**Analog:** itself, lines 34-51. Lower-case `userId`/`organizationId` after `requireUuid` and before `Object.freeze`. Test: `mintScope('org', null, UPPER)` and lower-case give the same `scopeKey`. Add it to `tests/rag/tenant-brand.test.ts`.

### `supabase/migrations/0401..0405_*.sql` (migration)

**Analog:** `probe/pattern1.sql` in this phase dir (executed in PGlite) for `hybrid_search_chunks`. For the grant and idempotence rules, follow `03-PATTERNS.md` "Migrations `supabase/migrations/03NN_*.sql`":
- `CREATE ... IF NOT EXISTS` / `CREATE OR REPLACE`, PostgreSQL 15-compatible.
- Every function ends with `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ON FUNCTION ... TO service_role;`. `0403` ends with `NOTIFY pgrst, 'reload schema';`.
- Mirror every object into `supabase/single-tenant-setup.sql` and `supabase/multi-tenant-setup.sql`. Phase 3's schema-equality test (`tests/rag-schema-equality.test.mts`, created by Phase 3) asserts setup + migrations are equal.
- The GIN index stays `IF NOT EXISTS` so a manual `CREATE INDEX CONCURRENTLY` beforehand is a no-op.

### `eval/harness/pglite-supabase.mts` (mod)

**Analog:** itself. Shim (lines 28-36) creates `service_role NOLOGIN` with no table grants. Per RESEARCH Pattern 9, append before the setup SQL:
```sql
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
```
DB construction (lines 54-58): `new PGlite({ extensions: { vector, pg_trgm } })`, then `exec(SUPABASE_SHIM_SQL)`, then `exec(setupSql)`. Apply migrations after the setup SQL through the Phase 3 `migrations` option and add their hashes to `sqlSha256`. Close the DB on error (lines 104-107). The selective-filter fixture (600 rows, 3% tenant, drop the HNSW index and rebuild it) is a separate factory in the style of `eval/harness/two-tenant.mts` (fixed-UUID `TWO_TENANT_IDS` object, lines 9-19).

### `eval/harness/fake-edge.mts` (mod)

**Analog:** itself. RPC allow-list (lines 26-35):
```typescript
const RPC_ARGUMENTS: Record<string, { vector: string; allowed: string[] }> = {
  match_document_chunks: { vector: 'query_embedding', allowed: ['query_embedding', 'match_count', 'similarity_threshold'] },
  match_documents_by_workspace: { vector: 'p_query_embedding', allowed: [...] },
};
```
Add `hybrid_search_chunks` with typed casts (`text[]`, `uuid[]`, `date`). Map the `apikey` header to a role, and run each RPC in a transaction after `SET LOCAL ROLE` so the `anon` refusal (`42501 ... for function`) is exercised. Add `/v2/rerank` (Cohere shape) and `/v1/rerank` (Voyage HTTP shape `data[]`) backed by the fake reranker. Record them in `calls` and `errors` like the existing handlers. `tests/fixture-edge.test.mts` is the test to extend.

### `tests/rag/helpers/pipeline-fakes.ts` (mod)

**Analog:** itself. Copy the `fakeEmbedder` abort-aware timer pattern (lines 83-108) for `fakeReranker({ delayMs, fail, partial })`. Copy `fakeRpcClient` (lines 39-76) for a hybrid RPC fake that returns leg-tagged rows and records `fn` and `signal`. Install it through the existing helper:
```typescript
export function installDeps(partial: Partial<RagDeps> & { ragEnv?: () => RagEnvInput }): void {
  resetRagConfigForTests();
  setRagDepsForTests({ adminClient: fakeAssemblyAdmin(), ...partial });
}
```
The D-27 fake reranker must be a pure function of query text, document text and options; a test asserts its signature. Put the shared scoring in `eval/harness/` (next to `fixture-embedder.mts`, which it reuses), so that `fake-edge.mts` and the vitest fakes share one implementation.

### Tests

- **Unit (vitest), analog `tests/rag/stage-runner.test.ts:1-50`:** imports `mintScope` from `@/lib/rag/tenant/scope`, `runRetrieval` from `@/lib/rag`, `runStage`/`StageError` from `@/lib/rag/pipeline`, `createTraceCollector`, and fakes from `./helpers/pipeline-fakes`. `beforeEach(uninstallDeps)` / `afterEach(uninstallDeps)`. Timeout tests set `env: { RAG_STAGE_TIMEOUTS: 'embed=25' }` (lines 214-229). Use the same pattern for `rerank=25` -> `degraded` with fused order and refusal `not_applied`.
- **Config tests, analog `tests/rag/config.test.ts:1-40`:** spy on `console.warn`, filter for `[RAG Config]`, and call `resetRagConfigForTests()` in `beforeEach`.
- **DB tests (`node:test`, `.test.mts`), analog `tests/two-tenant-fixture.test.mts:1-30`:** `before(createTwoTenantDatabase)`, `after(db.close)`, and SQL with named args (`p_query_embedding => $1`). Vectors come from `embedText(...)` as `[${...join(',')}]`.
- **Conformance:** `tests/rag/backend-conformance/cases.ts` exports `runConformance(factory)`, and `pgvector.test.ts` calls it. It covers the Chinese exact term, empty-array filters, anon refusal, cross-tenant zero rows and the iterative-scan negative control under `SET enable_seqscan = off; SET enable_bitmapscan = off;`.
- **Recorded vendor responses:** `tests/fixtures/rerank/{cohere,voyage}-*.json` (new dir; `tests/fixtures/contracts/samples.json` is the precedent for committed JSON fixtures). Use placeholder data only.

### `rag-sidecar/.../contracts/retrieval.py` + `eval_run.py` (contracts)

**Analog:** `contracts/eval_run.py:1-30`:
```python
class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

class RagRunOptions(_Contract):
    max_results: int | None = Field(default=None, ge=1, le=100)
    organization_id: str | None = None
    user_id: str | None = None
    generator_model: str | None = None
```
Add `retrieval_overrides: RetrievalOverrides | None = None` here. Widen `RagTrace.refusal_reason` (around line 101) to `Literal["no_relevant_context", "below_threshold", "below_similarity_floor"] | None`, and widen `kept_by`. New models (`RetrievalParams`, `RefusalThresholds`, `RefusalCalibrationConfig`, `ChunkingProfile`, `RetrievalFilters`) subclass `_Contract`. Then run `npm run gen:schemas` (`uv run --project rag-sidecar python -m rag_sidecar.export_schemas && node scripts/gen-zod.mjs`) and commit the regenerated `src/lib/rag-eval/contracts.generated.ts`. Register new models in `export_schemas` and `contracts/samples.py`. CI fails on drift, and `tests/contracts.test.ts` checks the samples.

### `eval/src/rag_eval/calibrate/*`, `sweep/*` (batch CLI)

**Analog:** `eval/src/rag_eval/split.py` (pure, stdlib, validated with Pydantic contracts from `rag_sidecar.contracts`), plus `baseline.py`/`runner.py` for calling the eval endpoint and writing outputs. Use `assign_split(item_id)` from `split.py:11-13` and do not re-implement it. Read the noise band from `eval/config/noise.json` (`floor` 0.02, `k` 3) and paired diffs from `paired.py`. Tests go in `eval/tests/test_calibrate_*.py` and `test_sweep_*.py`, following `test_baseline.py`, with stubs like `judge_stubs.py`. `bounds.py` is stdlib only (`math.comb`).

## Shared Patterns

### Env/config sync (AGENTS.md rule 5; CLAUDE.md constraint)
**Source:** the `RAG_STAGE_TIMEOUTS` entry at each site. Every D-23 variable (`RAG_LEXICAL_SEARCH`, `RAG_RERANKER`, `RAG_RERANK_TIER_CHAT`, `RAG_RERANK_TIER_VOICE`, `RAG_RERANK_VOYAGE_MODEL_BY_LANG`, `COHERE_API_KEY`, `COHERE_BASE_URL`, `RAG_REFUSAL_THRESHOLD`, `RAG_CONTEXT_EDGE_ORDER`, `RAG_CONTEXT_COMPRESSION`, `RAG_CONTEXT_TOKEN_BUDGET`, `RAG_PARENT_CHILD`, `RAG_HNSW_ITERATIVE_SCAN`, `RAG_EXACT_SCAN_CUTOFF`, translation switch) goes in all of:
1. `src/lib/env.ts:171-173` — `RAG_STAGE_TIMEOUTS: process.env.RAG_STAGE_TIMEOUTS || '',`
2. `scripts/init-env.js:342-343` — a `# comment` line, then `RAG_STAGE_TIMEOUTS=`
3. `scripts/config-server.js:540` — `${fullValues.X !== undefined ? \`X=${fullValues.X}\` : 'X=<default>'}`
4. `scripts/config-server.js:1308` and `:1642` — `X=${getEnvValue('X') || '<default>'}`
5. `scripts/config-ui/index.html:6438` — an `<input ... id="X">` field in the RAG section
6. `scripts/rag/env-manifest.json:474-477` — `{ "name": "X", "status": "managed", "knownGaps": [] }`
7. `src/lib/rag/deps.ts` `ragEnv()` and `RagEnvInput` in `config.ts`, plus the memo key
`scripts/check-config.mjs` (tests in `scripts/check-config.test.mjs`) enforces this list in CI. `COHERE_API_KEY` gets an empty placeholder everywhere. Log only whether it is set.

### Tenant scope at every boundary
`assertTenantScope(scope)` first in every adapter, and `scopeKey(scope)` as the only tenant value sent to SQL (`tenant/scope.ts:57-68`). Search, parents and exact-id lookups use the admin client only, and fail closed when it returns `null`.

### Abort and timeout propagation
Every I/O call takes the `stageSignal` from `runStage`. After any postgrest await, call `signal.throwIfAborted()`. Compose timeouts with `AbortSignal.any`.

### Logging
Use `logger.warn/error('RAG Pipeline', 'msg', { structured })` or `console.warn('[RAG Config] ...', data)`, and `[Document Search]` for retrieval diagnostics. Log codes and statuses only, never bodies, keys, query text or chunk text. Add no unconditional debug lines in per-candidate loops.

### Static JSON config + Zod
Load `eval/config/retrieval-params.json` and `refusal-thresholds.json` with a static `import` and parse them with the generated zod/v3 schema at module load. A runtime `fs.readFile` is not traced into the Vercel bundle.

### Switch-off = current behaviour
With `RAG_PIPELINE=legacy` (default) nothing changes. Legacy differential tests (`tests/rag-legacy-differential.test.mts`, `tests/rag-assemble-differential.test.mts`, `tests/rag/characterize-*.test.ts`, `tests/chat-strict.test.ts`) must pass unchanged. With v2 and every switch off, the result is dense-only through `hybrid_search_chunks` and the strict "information not available" response still fires (D-30).

## No Analog Found

| File | Role | Data Flow | Reason / what to use |
|---|---|---|---|
| `src/lib/rag/lexical/tokenize.ts` (+ `rules.json`, `icu-check.ts`) | utility | transform | Phase 3 creates v1. At HEAD the only tokenizer is the ASCII-only `local-hybrid.ts:15-21`. Use RESEARCH Pattern 4 and `probe/seg.mjs` (executed `Intl.Segmenter` observations) |
| `src/lib/rag/rerank/cohere.ts`, `voyage.ts` | HTTP adapter | request-response | No raw-`fetch` + Zod-response adapter exists in `src/lib/rag`. Use RESEARCH Pattern 5 with the error/abort conventions above |
| `hybrid_search_chunks` SQL | migration | CRUD | No hybrid or `tsvector` SQL in either setup file. Use `probe/pattern1.sql` + RESEARCH Pattern 1 |
| `eval/src/rag_eval/calibrate/*`, `sweep/*` | batch | batch | No calibration or sweep tooling exists. Use RESEARCH Patterns 7-8, reusing `split.py`, `paired.py` and `noise.json` |

## Metadata

**Analog search scope:** `src/lib/rag/**`, `tests/rag/**`, `tests/*.mts`, `eval/harness/**`, `eval/src/rag_eval/`, `eval/config/`, `rag-sidecar/src/rag_sidecar/contracts/`, `scripts/` (env sync sites, `ci/`, `rag/`), `supabase/`, phase 3 and 4 planning docs.
**Files scanned:** about 40.
**Tracked-source note:** all analog paths are repository source under `src/`, `tests/`, `eval/`, `scripts/`, `rag-sidecar/`, `supabase/`; no gitignored mirrors are cited (git commands were not run, per instruction).
**Pattern extraction date:** 2026-11-23
