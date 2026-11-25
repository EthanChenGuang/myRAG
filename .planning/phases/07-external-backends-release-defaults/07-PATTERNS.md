# Phase 7: External Backends & Release Defaults - Pattern Map

**Mapped:** 2026-11-24
**Files analyzed:** 58 new or modified files, in 14 groups
**Analogs found:** 52 / 58. 31 are executed code in the repo; 21 are plan-only analogs from Phases 3, 3.1 and 4, cited by plan id.

**Read first:** Phases 3 (from 03-09), 3.1, 4, 5, 5.1 and 6 are mostly **unexecuted**. When an analog is a plan id such as `04-17`, the planner must make the Phase 7 plan `depends_on` it and must not assume the file exists today. Every repo path cited below was checked with `git ls-files` and is tracked; there are no mirror paths. Context adjustments A-1 to A-12 override D-xx and are applied below.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `supabase/migrations/0701_vector_sync_outbox.sql` (outbox, targets, index_state tables, RLS server-only) | migration | CRUD | plan 03.1-01 `0351_ingestion_schema.sql`; repo `supabase/migrations/0305_legacy_compat_triggers.sql` | role-match |
| `supabase/migrations/0702_vector_sync_triggers.sql` (statement triggers, 3 per table) | migration | event-driven | `supabase/migrations/0305_legacy_compat_triggers.sql` | role-match |
| `supabase/migrations/0703_vector_sync_claim.sql` (claim, complete, fail RPCs) | migration | batch | plan 03.1-07 `0352_ingestion_claim.sql` | exact (plan) |
| `supabase/migrations/0704_rag_validate_chunks.sql` | migration (server-only RPC) | request-response | plan 04-15 `0407_hybrid_search_chunks.sql` + 04-07 `rag_assert_tenant_key` | exact (plan) |
| `supabase/migrations/0705_activation_gate_external.sql` (extends the D-40 gate) | migration | CRUD | plan 03-09 `0309_profile_activation.sql` | exact (plan) |
| `supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql` (fold) + `tests/rag-db/schema-equality.test.mts` | config | n/a | plan 04-42 (fold step) | exact (plan) |
| `src/lib/rag/backend/tenant-key.ts` (`canonicalTenantKey`, `weaviateTenantName`, A-5 lowercase) | utility | transform | `src/lib/rag/tenant/scope.ts:63-68` `scopeKey`; plan 04-01 (mintScope lowercase) | exact |
| `src/lib/rag/backend/revalidate.ts` | service | request-response | `src/lib/rag/backend/supabase-rpc.ts` | exact |
| `src/lib/rag/backend/readiness.ts` (30 s TTL) | service | CRUD (read) | `src/lib/rag/tenant/admin.ts:36-48` (admin query shape); plan 04-17 `isReady` seam | role-match |
| `src/lib/rag/backend/factory.ts` / extend plan-04-17 `registry.ts` (fallback, A-8 race) | service | request-response | plan 04-17 `src/lib/rag/backend/registry.ts` + `pgvector.ts` | exact (plan) |
| `src/lib/rag/backend/qdrant/{client,scoped-request,collection,adapter}.ts` | service (adapter) | request-response | plan 04-17 `pgvector.ts`; RESEARCH Pattern 3 and 5 | role-match |
| `src/lib/rag/backend/weaviate/{client,collection,adapter}.ts` | service (adapter) | request-response | plan 04-17 `pgvector.ts`; RESEARCH Pattern 4 and 5 | role-match |
| `src/lib/rag/sync/{drain,claim,servable,reconcile}.ts`, `stores/{qdrant,weaviate,fake}.ts` | service | batch | plan 03.1-22 `runner.ts` + 03.1-07 claim wrappers; plan 03.1-48 `backfill/orchestrate.ts` | role-match |
| `src/lib/rag/sync/kick.ts` (`after()` kick) | utility | event-driven | plan 03.1-55 `src/lib/rag/ingest/wake.ts` | exact (plan) |
| `src/app/api/internal/vector-sync/drain/route.ts` (POST secret, GET CRON_SECRET) | route | batch | `src/app/api/internal/rag/run/route.ts` + `src/lib/rag-eval/auth.ts` + `src/lib/internal-api-key.ts` | exact |
| `src/lib/rag/sync/cli.ts` + `package.json` scripts `rag:vector-sync`, `rag:reconcile` | utility (CLI) | batch | plan 03.1-48 `src/lib/rag/ingest/backfill/cli.ts`; plan 03-40 `src/lib/rag/embeddings/cli.ts` | exact (plan) |
| `docs/` or README section: pg_cron + pg_net + Vault SQL (operator-run, not a migration) | config (docs) | n/a | RESEARCH "pg_cron + pg_net scheduler" (lines 627-643) | no repo analog |
| `src/lib/rag/v2/stages/search.ts` (span fields `backend`, `fallback_reason`, `tenant_validation_dropped`) | service | request-response | plan 04-19 `v2/stages/search.ts`; `src/lib/rag/trace/log.ts` | exact (plan) |
| `src/lib/rag/sync/log.ts` (`[Vector Sync]` slice line) | utility | transform | `src/lib/rag/trace/log.ts:29-32` | exact |
| `scripts/ci/check-rag-boundary.mjs` + `scripts/tests/check-rag-boundary.node-test.mjs` | config (CI) | transform | itself, lines 32, 223-235, 236-250 | exact |
| `tests/rag/sync/*.test.ts` (triggers, claim, drain, route, activation gate) | test | batch | plan 03.1-07 `tests/rag-db/ingestion-ledger-claim.test.mts`; `eval/harness/migrations.mts` | exact (plan) |
| `tests/rag/backend/{qdrant-scoped,weaviate-adapter,validate-chunks,fallback,tenant-key}.test.ts` | test | unit | plan 04-17 `tests/rag/backend/pgvector-adapter.test.ts`; plan 04-15 `tests/rag-db/hybrid-grants.test.mts` | exact (plan) |
| `tests/rag/backend-conformance/{qdrant,weaviate}-factory.ts` + `*.test.ts` | test | unit | plan 04-17 `pgvector-factory.ts` / `pgvector.test.ts` | exact (plan) |
| `tests/rag/canary/**` (factory, service guard, cases incl. reconcile drift) | test | event-driven (end-to-end) | plan 04-41 `eval/harness/two-tenant-v2.mts` + `tests/rag-db/v2-two-tenant-matrix.test.mts`; plan 04-17 `cases.ts` | role-match |
| `.github/workflows/pr-smoke.yml` (new `backend-canary` job with services) | config (CI) | batch | `.github/workflows/pr-smoke.yml:109-130` (`schema-parity` job) | role-match (no service containers yet) |
| `.github/workflows/nightly.yml` (failure report step) | config (CI) | batch | `.github/workflows/nightly.yml:60-104` (`online-judge` skip pattern) | exact |
| `scripts/rag/env-manifest.json` (metadata `group,label,type,options,requires`) | config | n/a | itself (entries shape) | exact |
| `scripts/check-config.mjs` + `scripts/check-config.test.mjs` (metadata completeness, inventory rule) | utility (CI) | transform | `scripts/check-config.mjs:67-149` | exact |
| `scripts/config-server-security.js` (last-4 masking) | utility | transform | itself, lines 70-88 `isSecretConfigEntry`, `maskConfig` | exact |
| `scripts/config-server.js` (generated RAG section endpoints, review-queue endpoints, execFile promote) | controller (Express) | request-response | itself: lines 77-82 `withAuthHeaders`, 174, 205-223 | exact |
| `scripts/config-ui/rag-panels/rag-pipeline.js` (generated section) + `review-queue.js` + `scripts/config-ui/index.html` | component (vanilla JS) | request-response | plan 03-43 `rag-panels/rag-fetch.js`, `embedding-profiles.js`; plan 04-36 `rag-panels/*` | exact (plan) |
| `tests/ui/config-rag-pipeline-panel.test.ts`, `tests/ui/config-review-queue-panel.test.ts` | test | unit | plan 03-43 `tests/ui/config-rag-panels.test.ts` | exact (plan) |
| `src/app/api/rag/admin/providers/test/route.ts` | route (admin) | request-response | plan 03-40 / 03-37 admin routes + `src/lib/rag/tenant/admin.ts` `requireRagAdmin` | exact |
| `src/app/api/rag/admin/index-compat/route.ts` | route (admin) | request-response | same as above; plan 03.1-24 `src/app/api/rag/admin/parse-budget/route.ts` (GET status) | exact (plan) |
| `src/app/api/rag/admin/review/chunks/route.ts` | route (admin) | request-response | same guard + `src/lib/rag/backend/supabase-rpc.ts` tenant-scoped read | role-match |
| `src/lib/env.ts`, `scripts/init-env.js`, `scripts/config-server.js` (3 templates), `scripts/config-ui/index.html` (D-24 vars) | config | n/a | `RAG_EVAL_SECRET` / `RAG_PIPELINE` lines in each | exact |
| `eval/src/rag_eval/regression.py` + `eval/tests/test_regression.py` | service (CLI) | batch | `eval/src/rag_eval/paired.py`, `gate.py`; plan 04-40 `phase_compare.py` | exact |
| `rag-sidecar/src/rag_sidecar/contracts/defaults.py` (`DefaultsDecision`), `.../vendor.py` (`VendorDataFlow`) + regenerated schemas/Zod | model | n/a | `rag-sidecar/src/rag_sidecar/contracts/baseline.py` | exact |
| `eval/config/release-defaults.json`, `eval/decisions/defaults-<date>.md` | config / report | n/a | plan 04-40 `eval/config/phase4-comparison.json`, `eval/reports/phase-04/comparison.md` | exact (plan) |
| shipped-defaults check (`scripts/check-release-defaults.mjs` or a pytest) | utility (CI) | transform | `scripts/check-config.mjs` shape | role-match |
| `eval/src/rag_eval/review_queue.py` (promote via JSON file, 3-gram Jaccard) + `eval/tests/test_review_queue.py` | service (CLI) | file-I/O | itself, lines 22, 226-282, 285-308 | exact |
| `eval/src/rag_eval/golden_io.py` / `split.py` (loader fails on missing manifest id) | utility | file-I/O | themselves | exact |
| `eval/src/rag_eval/failure_report.py` + `eval/tests/test_failure_report.py` | service (CLI) | batch | `review_queue.py` CLI/exit codes + `gate.py:158-215` markdown renderer | role-match |
| `config/rag/vendor-data-flow.json`, `docs/vendor-data-flow.md` (generated), generator script | config + generator | transform | `scripts/gen-zod.mjs` + `npm run gen:schemas` check in `pr-smoke.yml:127-130` | role-match |
| `README_RAG_PIPELINE.md` | docs | n/a | `README_DEPLOYMENT_MODES.md` (structure) | role-match |
| `AGENTS.md` + `tests/rag/agents-guide.test.ts` | docs + test | n/a | `tests/rag/agents-guide.test.ts:1-29`; plan 04-42 AGENTS.md edit | exact |
| `vercel.json` | config | n/a | — (A-6: **no** `crons` entry is committed) | n/a, do not edit |

## Pattern Assignments

### Migrations 0701-0705 (migration, event-driven / batch)

**Numbering and loading.** Use `07NN_<snake>.sql`; mode-specific variants use `.single-tenant.sql` / `.multi-tenant.sql`. The loader enforces the name (`eval/harness/migrations.mts:10`):
```typescript
const MIGRATION_FILE = /^(\d{4}_[a-z0-9_]+)(?:\.(single-tenant|multi-tenant))?\.sql$/;
```
Common files run before their mode variant (lines 16-28). PGlite applies every file, so 0701-0705 must run on PGlite 18.7 (statement triggers with transition tables were probe-verified there).

**Header, transaction, function style** (`supabase/migrations/0305_legacy_compat_triggers.sql:1-12, 41-46`):
```sql
-- 0305: BEFORE INSERT triggers that keep today's legacy writers valid (Phase 3, F-1).
BEGIN;

CREATE OR REPLACE FUNCTION rag_documents_legacy_defaults() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
...
CREATE OR REPLACE FUNCTION rag_chunks_legacy_defaults() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
```
Copy: a numbered header comment naming the phase and decision, `BEGIN;`/`COMMIT;`, `CREATE OR REPLACE`, pinned `search_path`. The outbox trigger functions need `SECURITY DEFINER` (as 0305 does, for the same reason: an inserting role cannot write the server-only outbox). Add a comment saying why.

**Tables.** Follow plan 03.1-01 (`0351_ingestion_schema.sql`): `CREATE TABLE IF NOT EXISTS public.<name>`, check constraints for enum columns (`status IN ('pending','leased','done','dead')`, `target IN ('weaviate','qdrant')`), RLS enabled with no policies for `anon`/`authenticated`, grants to `service_role` only. A-12: add `cursor text` to `vector_sync_outbox` (RESEARCH Open Q6).

**Triggers.** RESEARCH Pattern 1 (lines 415-419): three statement-level triggers per table (`AFTER INSERT`, `AFTER UPDATE OF <synced cols>`, `AFTER DELETE`), each `FOR EACH STATEMENT REFERENCING NEW TABLE/OLD TABLE`, one set-based `INSERT ... SELECT` per enabled target, early exit when no target is enabled. A-7: one trigger per event.

**Claim RPC** (plan 03.1-07, `0352_ingestion_claim.sql`, truth line 23): "claims queued jobs whose run_after has passed and active jobs whose lease expired ... with FOR UPDATE SKIP LOCKED, sets locked_by ... and a 120 s lease". Phase 7 differences (RESEARCH Pattern 2, A-7): exclude any `(target, entity, entity_id)` with a live lease; backoff reuses `lease_until` (`least(2^attempts, 3600) s`); `dead` at 8 attempts. Test analog: 03.1-07 `tests/rag-db/ingestion-ledger-claim.test.mts`; PGlite is single-connection, so test concurrency as sequential claims plus lease expiry (03.1-53 shows the optional real-Postgres check).

**`rag_validate_chunks`** — copy plan 04-15 `0407_hybrid_search_chunks.sql` (plan lines 25, 94, 101, 182):
- first statement `PERFORM public.rag_assert_tenant_key(p_tenant_key);` (guard from plan 04-07 `0403_tenant_key_guard.*.sql`, raises on a malformed key);
- `SECURITY INVOKER`, `SET search_path = pg_catalog, public`;
- predicate `c.tenant_key = p_tenant_key AND c.is_current AND status ...` plus `EXISTS` on `chunk_embeddings` for `p_profile_id` (resolve the `legacy_column` branch per A-12 / RESEARCH Open Q8);
- ends with `REVOKE ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;` on the full signature, then `NOTIFY pgrst, 'reload schema';`.
Grants test: copy plan 04-15 `tests/rag-db/hybrid-grants.test.mts` (real roles through `SET ROLE` on PGlite, shim from plan 04-05).

**Activation gate (0705)** — extend plan 03-09 `0309_profile_activation.sql` and its `tests/rag-db/activation-gate.test.mts`; the refusal message names the backend (D-06).

**Fold into setup files** — plan 04-42 pattern: append to both `supabase/*-setup.sql` and keep `tests/rag-db/schema-equality.test.mts` green.

---

### `src/lib/rag/backend/tenant-key.ts` (utility, transform) — A-5

**Analog:** `src/lib/rag/tenant/scope.ts:63-68`
```typescript
export function scopeKey(scope: TenantScope): string {
  assertTenantScope(scope);
  if (scope.kind === 'single') return 's:default';
  if (scope.kind === 'org') return `o:${scope.organizationId}`;
  return `u:${scope.userId}`;
}
```
`UUID_RE` in scope.ts line 22 is case-insensitive (`/i`), so an upper-case UUID passes `mintScope`. Plan 04-01 lower-cases in `mintScope`; Phase 7's helper must still lower-case at the exit point (`canonicalTenantKey(scope) = scopeKey(scope).toLowerCase()`), and `weaviateTenantName` maps `:` to `_` (A-4). Lowercasing precedent in the repo: `src/lib/rag-eval/auth.ts:58-61` (`evalScopeKey` uses `.trim().toLowerCase()`). Throw messages use the `[RAG Tenant]` prefix (scope.ts line 28).

---

### `src/lib/rag/backend/revalidate.ts` (service, request-response)

**Analog:** `src/lib/rag/backend/supabase-rpc.ts`
- Imports (lines 1-2): `import { logger } from '@/lib/logger';` and `import { assertTenantScope, ... type TenantScope } from '../tenant/scope';`
- Injected client interfaces (lines 4-21): `RpcClient`, `RpcRequest.abortSignal(signal)`. Reuse them; do not import supabase-js here.
- Error class (lines 30-41): `RetrievalBackendError(rpc, code)` with a `[RAG Backend]` message. Reuse it for the RPC failure.
- Entry shape (lines 51-59): `assertTenantScope(scope)` first, then destructure `{ client, signal }`.
The dropped-ID count goes in the search span, and a non-zero count is logged as `[RAG Security]` at error level with IDs counted, never content (D-10).

---

### `src/lib/rag/backend/readiness.ts` (service, read with TTL)

**Analog for the admin query:** `src/lib/rag/tenant/admin.ts:36-48`
```typescript
signal.throwIfAborted();
const { data, error } = await admin
  .from('admin_users').select('id').eq('id', userId).abortSignal(signal).maybeSingle();
signal.throwIfAborted();
if (error) throw new Error('[RAG Admin] admin_users query failed');
```
Same shape on `rag_backend_index_state` keyed by `(target, profile_id, tenant_key)`, through `getRagDeps().adminClient()` (admin.ts line 52). The 30 s TTL map is new. A read error means "not ready" (fail toward pgvector), not a throw.

---

### `src/lib/rag/backend/{qdrant,weaviate}/*` and `factory.ts` (adapter, request-response)

**Contract analog:** plan 04-01 `src/lib/rag/backend/types.ts` (plan line 120): `RetrievalBackend {id, search, health, isReady(scope)}`, `BackendSearchRequest {scope, embeddingProfileId, denseVector, lexicalTokens, filters, denseLimit, lexicalLimit, signal}`, `BackendLegs {dense, lexical, meta}`, `RankedHit` with a 1-based `rank` per leg. `BackendId` already includes `weaviate | qdrant`.

**Adapter analog:** plan 04-17 `src/lib/rag/backend/pgvector.ts` (plan line 31): empty filter arrays sent as null; vendor errors become `RetrievalBackendError` with a code; rows are split into dense and lexical legs keeping rank order; the signal is attached and checked after the await. The external adapters then call `revalidate.ts` to hydrate `content`/`document` from Supabase (D-03), because the stores hold no text.

**Registry/factory:** plan 04-17 `registry.ts`; add the fallback wrapper (not ready → pgvector `degraded: backend_not_ready`; error/timeout → `backend_error`; A-8 race), voice selection via `RAG_RETRIEVAL_BACKEND_VOICE`, and legacy ignore-and-log-once.

**Qdrant wrapper:** no repo analog. Use RESEARCH Pattern 3 (lines 427-447) verbatim as the starting point, extended by A-3 (reject `lookup_from`, `shard_key`, `idf: 'global'`). **Collection specs:** RESEARCH Pattern 5 (lines 455-482). **Weaviate tenant-only access:** RESEARCH Pattern 4 (lines 449-453), A-4.

**Client files:** `client.ts` is the only file importing the vendor package (enforced by the boundary check below). Use `@weaviate/node@3.15.5` and `@qdrant/js-client-rest@1.20.0` pinned exactly (A-1); the install sits behind a blocking checkpoint.

---

### `src/lib/rag/sync/*` (service, batch)

**Analogs:**
- Claim/complete/fail wrappers: plan 03.1-07 TS wrappers over `rag_claim_ingestion_jobs`, plus the injected `RpcClient` style from `supabase-rpc.ts:4-21`.
- Time-sliced loop: plan 03.1-22 `src/lib/rag/ingest/runner.ts` (time-sliced internal routes under 60 s, 03.1 D-07).
- Same loop with no time slice for the CLI: plan 03.1-48 `backfill/orchestrate.ts` + `cli.ts`.
- `servable.ts` is pure (current, ready, vector present → upsert, else delete). Keep it free of I/O so the fake-store tests cover it.
- `stores/fake.ts`: copy the fake-dependency style of `tests/helpers` / `helpers-fakes.test.ts` (Phase 2 fakes).

**Kick after ingest:** plan 03.1-55 `src/lib/rag/ingest/wake.ts` (plan line 26): "best-effort POST ... inside after() with a 1 s timeout ... swallows every error and is a no-op when [URL] is unset or outside a request scope, so the 202 is never delayed". Copy this exactly, with the drain route and `RAG_VECTOR_SYNC_SECRET`.

**Slice log line:** `src/lib/rag/trace/log.ts:29-32`
```typescript
/** One structured line per request; the field list is fixed so query and chunk text can never reach the log sink. */
export function logRagTrace(collector: TraceCollector, result: RetrievalResult, sink: TraceLogSink = defaultSink): void {
  sink(`[RAG Trace] ${JSON.stringify(buildTraceLogPayload(collector, result))}`);
}
```
→ `logVectorSync(slice, sink)` emitting `[Vector Sync] {claimed, upserted, deleted, failed, dead, lagSeconds}` with a fixed field list and an injectable sink for the "no text in the log" test.

---

### `src/app/api/internal/vector-sync/drain/route.ts` (route, batch)

**Analog:** `src/app/api/internal/rag/run/route.ts:1-17, 32-41`
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
...
export const runtime = 'nodejs';
...
export async function POST(req: NextRequest) {
  const access = checkEvalAccess(req.headers, { nodeEnv: process.env.NODE_ENV, endpointEnabled: ..., secret: env.RAG_EVAL_SECRET });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }
```
**Secret check analog:** `src/lib/rag-eval/auth.ts:4, 23-35`, a fail-closed 503 below 32 characters, then 401, then constant-time compare:
```typescript
const MIN_SECRET_LENGTH = 32;
...
if (secret.length < MIN_SECRET_LENGTH) return { ok: false, status: 503, error: 'Eval endpoint is not configured' };
const provided = headers.get(EVAL_SECRET_HEADER);
if (!provided) return { ok: false, status: 401, error: 'Unauthorized' };
if (!crypto.timingSafeEqual(sha256(provided), sha256(secret))) return { ok: false, status: 401, error: 'Unauthorized' };
```
Use `internalApiKeyMatches` from `src/lib/internal-api-key.ts:8-11` for the compare (RESEARCH "Don't Hand-Roll"). Parse `Authorization: Bearer` like `BEARER_RE` in `src/lib/rag/tenant/admin.ts:18`. Validate the body (`{ mode?: 'drain' | 'reconcile' }`) with `validateRequest` (run/route.ts line 43). Add `GET` for optional Vercel Cron with `CRON_SECRET` (A-6). Route test analogs: `tests/rag/internal-api-key.test.ts`, `tests/eval-route-auth.test.ts`; plan 03.1-55 `tests/rag/ingest/internal-callbacks.test.ts`.

---

### `scripts/ci/check-rag-boundary.mjs` (CI)

Line 32 today: `export const VECTOR_OR_RERANK_PACKAGES = ['weaviate-client', '@qdrant/js-client-rest', 'cohere-ai', 'voyageai'];`. The rule at lines 223-235 applies to `outsideRag`, so all of `src/lib/rag` is allowed. Phase 7 needs:
1. a separate `VECTOR_STORE_PACKAGES` list with the four Weaviate names (`@weaviate/node`, `weaviate-client`, `@weaviate/core`, `weaviate-ts-client`; confirm the exact list against A-1) plus `@qdrant/js-client-rest` and `@qdrant/qdrant-js`;
2. a new rule whose `appliesTo` allows only `src/lib/rag/backend/weaviate/`, `src/lib/rag/backend/qdrant/` and `src/lib/rag/sync/`. Copy the `mint-scope` rule's `outsideTenant` predicate shape (lines 236-250).
Tests: extend `scripts/tests/check-rag-boundary.node-test.mjs`.

---

### Tests: sync, backend, conformance, canary

- **Conformance factories:** plan 04-17 (plan line 137): `runConformance(name, factory)`, where `factory()` returns `{backend, scopes, embed(text), queryTokens(text), close()}`. `cases.ts` imports nothing backend-specific, and "Phase 7 adds factories without editing cases.ts" (line 33). New `qdrant-factory.ts` and `weaviate-factory.ts` seed through ingest → outbox → drain (D-12), never through direct writes.
- **Canary:** plan 04-41 `eval/harness/two-tenant-v2.mts` + `tests/rag-db/v2-two-tenant-matrix.test.mts` (two-tenant matrix over every v2 path), parametrized by the same factory. Add a service guard that fails (does not skip) when `RAG_CANARY_BACKENDS` names a backend without a healthy URL (A-9, RESEARCH Pitfall 10).
- **DB tests:** PGlite via `createFixtureDatabase` (plan 04-05 `eval/harness/pglite-supabase.mts`) applying all migrations; the repo has `.mts` DB tests under `tests/rag-db/` run with `node --import tsx --test`. Choose `.mts` under `tests/rag-db/` for SQL tests to match, or Vitest `.test.ts` as RESEARCH lists; keep one convention per plan.

---

### `.github/workflows/pr-smoke.yml` — new `backend-canary` job

**Analog:** `pr-smoke.yml:109-130` (`schema-parity`): `runs-on: ubuntu-latest`, `timeout-minutes`, checkout pinned by SHA `actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`, `actions/setup-node@49933ea5... # v4.4.0` with `node-version: '22'`, `cache: npm`, `npm ci --ignore-scripts`. No job in the repo has `services:` yet. Use the RESEARCH skeleton (lines 644-685) for services with images pinned by digest, a pull retry, and a Qdrant wait loop (A-9). Path filter: `src/lib/rag/**`, `supabase/**`. Validate with `scripts/ci/check-workflows.py` (`scripts/tests/test_check_workflows.py`).

### `.github/workflows/nightly.yml` — failure report step

**Analog:** `nightly.yml:60-104` (`online-judge`): an `env: HAS_...: ${{ secrets.X != '' }}` flag, a first step `if: env.HAS_... != 'true'` that echoes `::notice::... skipping`, every later step gated `if: env.HAS_... == 'true'`, then `uv sync --directory eval --locked --all-extras` and `uv run --directory eval python -m rag_eval.<module>`. Run `rag_eval.failure_report` the same way, gated on private data being present.

---

### Config: env vars (D-24) in five locations

Copy the existing `RAG_EVAL_SECRET` / `RAG_PIPELINE` placement in each file:
- `src/lib/env.ts:167-172`: `RAG_PIPELINE: process.env.RAG_PIPELINE || 'legacy',`
- `scripts/init-env.js:325-342`: group banner `# -----` / `# RETRIEVAL PIPELINE` / `# -----`, one comment line per variable, secrets empty (`RAG_EVAL_SECRET=`). D-19 group comments come from the manifest `group`.
- `scripts/config-server.js`: three templates at lines ~544-550, ~1330-1335 and ~1681-1686 (`${getEnvValue('X') || '<default>'}`); add `RAG_VECTOR_SYNC_SECRET` to the at-least-32-characters warning list at line 218.
- `scripts/config-ui/index.html` (~6371: `<input type="password" id="RAG_EVAL_SECRET"`), or render them from the generated section once D-14 lands.
- `scripts/rag/env-manifest.json` entries: `{ "name", "status": "managed", "knownGaps": [] }` plus the new metadata keys.

### `scripts/check-config.mjs` (metadata and inventory rules)

**Analog:** itself, lines 101-112 (per-entry validation pushes `{ name, location: 'manifest', message }`). Add the checks in the same loop: managed entries need `group`, `label`, `type` ∈ `bool|enum|number|string|secret|url`, `options` for `enum`; a `url`/`secret` var whose provider has no entry in `config/rag/vendor-data-flow.json` → violation. Keep the sorted output (line 147). Tests: `scripts/check-config.test.mjs`.

### `scripts/config-server-security.js` (masking)

**Analog:** lines 70-88:
```javascript
/** Splits an env map into values safe to show and the names of secrets that are set. Secret values never leave the server. */
function maskConfig(config) {
  const visible = {};
  const secretsSet = [];
  for (const [name, value] of Object.entries(config)) {
    if (isSecretConfigEntry(name, value)) {
      if (value !== '') secretsSet.push(name);
    } else { visible[name] = value; }
  }
  return { config: visible, secretsSet };
}
```
Extend with a `secretHints` map (last 4 only when length ≥ 20, per RESEARCH Open Q5); export it through `module.exports` (line 133). Consumer: `config-server.js:174`.

### `scripts/config-server.js` (review queue, promote, forwarding)

- Admin forwarding: `withAuthHeaders(req, headers)` at lines 78-83 (Cookie and Authorization forwarded to `/api/rag/admin/*`). Reuse it for `providers/test`, `index-compat` and `review/chunks`.
- Child processes: line 5 imports `{ exec, spawn }`; add `execFile` and **do not** use `exec` (D-22: no shell). Pass a validated temporary JSON file inside `eval/golden/private/`.
- Panels: plan 03-43 `scripts/config-ui/rag-panels/rag-fetch.js` (shared fetch helper with CSRF header `x-config-ui`, see `config-server-security.js:3`) and `embedding-profiles.js`; plan 04-36 adds more panels in the same folder and wires them in `index.html`. Test: plan 03-43 `tests/ui/config-rag-panels.test.ts`.

### Admin routes: `providers/test`, `index-compat`, `review/chunks`

**Guard analog:** `src/lib/rag/tenant/admin.ts:54-92` `requireRagAdmin({ headers, signal })` → `{ ok: false, status: 401|403|503, reason }`, with the refusal logged as `[RAG Admin] admin request refused` (lines 20-23). Route shape: plans 03-40 (`embedding-profiles/route.ts`), 03-37 (`quarantine/...`) and 03.1-24 (`parse-budget/route.ts` for a GET status). Each route: `export const runtime = 'nodejs'`, guard first, `validateRequest` with a Zod `z.enum([...providers])` for `{ provider }`, then `NextResponse.json({ ok, latencyMs, code, message })`. Never put a key in the response or the log (CLAUDE.md logging rule: presence or length only). Guard test analog: `tests/rag/rag-admin-guard.test.ts`.
`review/chunks` must read chunk text only for the queue item's recorded chunk IDs under the recorded `tenant_key`, through a server-only path. Reuse `rag_validate_chunks` (0704) with `canonicalTenantKey` rather than a new query, and log `{ adminId, itemId, count }` with no text.

---

### `eval/src/rag_eval/review_queue.py` (promote extension)

**Analog:** itself.
- Exit codes (line 22) stay: `EXIT_OK, EXIT_INPUT, EXIT_API, EXIT_PRIVATE = 0, 2, 4, 6`.
- Private-path guard (lines 233-242): every path through `assert_private_path(...)`, `PrivatePathError` → `EXIT_PRIVATE`.
- Duplicate check to replace (lines 255-262): `normalize_text(item.question) == normalize_text(question)` → 3-gram Jaccard ≥ 0.85 with an explicit `--confirm-near-duplicate`, recorded on the item.
- Item construction (lines 263-275): today it hard-codes `category="no_answer"`, `answerable=False`, `gold_evidence=[]`; take them from the JSON file (`--item-json PATH`), validated by `GoldenItem` (from `rag_sidecar.contracts.golden`). Keep `provenance="production"` and `split=assignments.get(golden_id) or assign_split(golden_id)` then `freeze_splits(...)`.
- CLI (lines 285-308): add arguments to the existing `promote` subparser; do not add a delete command.

### `eval/src/rag_eval/regression.py` and `failure_report.py` (CLI, batch)

- Statistics: `eval/src/rag_eval/paired.py:13-14, 54-60`, reused directly (`SEED = 20261123`, `RESAMPLES = 10000`, `_bootstrap_interval`), and `is_gated_slice` (line 38) for the slice gates. Do not write new bootstrap code (A-10).
- Gate and markdown: `gate.py` `evaluate_gate` (line 61), `render_gate_markdown` (line 158), `_write_text` (line 206), `main` (line 257).
- Multi-config comparison precedent: plan 04-40 `phase_compare.py` + `eval/config/phase4-comparison.json` + `eval/reports/phase-04/comparison.{json,md}`.
- CLI shape: `argparse` with subcommands and integer exit codes as in `review_queue.py:285-308`.

### Pydantic contracts `DefaultsDecision`, `VendorDataFlow`

**Analog:** `rag-sidecar/src/rag_sidecar/contracts/baseline.py:1-40`
```python
from pydantic import BaseModel, ConfigDict, Field
class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
```
Then regenerate with `npm run gen:schemas`; CI `schema-parity` (`pr-smoke.yml:127-130`) fails if `rag-sidecar/schemas`, `src/lib/rag-eval/contracts.generated.ts` or `tests/fixtures/contracts/samples.json` drift. Add sample fixtures for both models.

### Vendor inventory generator → `docs/vendor-data-flow.md`

Generate the doc from the JSON with a script in the style of `scripts/gen-zod.mjs` (tests in `scripts/tests/gen-zod.node-test.mjs`), and add a "committed output equals regenerated output" step like `pr-smoke.yml:127-130`. A-11: list `lexical_text` and vectors as content.

### Docs: `README_RAG_PIPELINE.md`, `AGENTS.md`

- AGENTS.md test: extend `tests/rag/agents-guide.test.ts:7-21` (`test.each([...fragments])('mentions %s', ...)`) with the new fragments (`README_RAG_PIPELINE.md`, `RAG_RETRIEVAL_BACKEND`, `[Vector Sync]`). Keep the lines 23-28 assertions untouched (strict mode, Exa, `source_images`).
- README: follow `README_DEPLOYMENT_MODES.md` (table of contents, then sections). The switch tables are generated from the manifest metadata, so the docs test compares them with the manifest.

## Shared Patterns

### Tenant scope at every boundary
**Source:** `src/lib/rag/tenant/scope.ts:57-68` (`assertTenantScope`, `scopeKey`), plus the new `tenant-key.ts`.
**Apply to:** revalidate, readiness, both adapters, the Qdrant wrapper, sync stores, `review/chunks`, the canary. A tenant value only ever comes from a minted `TenantScope` (`mintScope` stays forbidden outside `src/lib/rag/tenant/`, boundary rule lines 236-250).

### Fail-closed secrets and constant-time compare
**Source:** `src/lib/internal-api-key.ts:8-11`, `src/lib/rag-eval/auth.ts:23-35`.
**Apply to:** the drain route (POST and GET), the Test-connection route (no key echo).

### Admin guard
**Source:** `src/lib/rag/tenant/admin.ts` `requireRagAdmin`.
**Apply to:** `providers/test`, `index-compat`, `review/chunks`.

### Server-only SQL functions
**Source:** plan 04-15 (`0407`) and plan 04-07 (`rag_assert_tenant_key`); existing `SECURITY DEFINER` precedent in `0305`.
**Apply to:** `rag_validate_chunks`, the claim/complete/fail RPCs, the index-state writers: `SECURITY INVOKER` unless a comment justifies DEFINER, pinned `search_path`, REVOKE from `PUBLIC, anon, authenticated`, GRANT to `service_role`, `NOTIFY pgrst, 'reload schema';`.

### Logging
**Source:** `src/lib/rag/trace/log.ts` (a fixed field list and an injectable sink); CLAUDE.md bracketed prefixes.
**Apply to:** `[Vector Sync]`, `[RAG Security]` (dropped IDs, error level), `[RAG Backend]` errors, `[RAG Admin]`. No chunk text and no `lexical_text` (RESEARCH Pitfall 12) in any log.

### Config sync
**Source:** the five locations listed under "Config: env vars"; `scripts/check-config.mjs`.
**Apply to:** every D-24 variable, and the shipped-defaults change in the final checkpoint.

### Python CLI conventions
**Source:** `eval/src/rag_eval/review_queue.py:22, 233-242, 285-308`.
**Apply to:** `regression.py`, `failure_report.py`, promote: integer exit codes, `assert_private_path` for anything private, `argparse` subcommands, `[Review Queue]`-style bracketed stdout lines.

## No Analog Found

| File | Role | Data Flow | Reason / use instead |
|---|---|---|---|
| `src/lib/rag/backend/qdrant/scoped-request.ts` | utility | transform | No vendor vector client exists yet; use RESEARCH Pattern 3 + A-3 |
| `src/lib/rag/backend/{qdrant,weaviate}/collection.ts` | service | admin | Use RESEARCH Pattern 5 (probe-verified specs) |
| `src/lib/rag/backend/weaviate/adapter.ts` tenant handling | service | request-response | Use RESEARCH Pattern 4 + A-4 |
| pg_cron + pg_net + Vault scheduler SQL (operator doc, not a migration) | docs | n/a | RESEARCH lines 627-643; pg_net timeout 58 s (A-6) |
| `backend-canary` `services:` block | CI | n/a | No service containers in the repo; RESEARCH lines 644-685 + A-9 |
| 3-gram Jaccard near-duplicate function | utility | transform | New; put it beside `normalize_text` (`eval/src/rag_eval/matching.py`) |

## Metadata

**Analog search scope:** `src/lib/rag/**`, `src/lib/rag-eval/`, `src/app/api/internal/**`, `src/lib/internal-api-key.ts`, `supabase/migrations/`, `eval/harness/`, `eval/src/rag_eval/`, `rag-sidecar/src/rag_sidecar/contracts/`, `scripts/` (config-server, security, check-config, ci, rag), `.github/workflows/`, `tests/rag/`, and the `files_modified` lists of the Phase 3, 3.1 and 4 plans.
**Files scanned:** about 45 repo files and 25 plan files.
**Tracked-source gate:** all cited repo paths verified with `git ls-files`.
**Pattern extraction date:** 2026-11-24
