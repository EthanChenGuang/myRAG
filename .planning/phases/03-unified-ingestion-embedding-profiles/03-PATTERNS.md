# Phase 3: Unified Ingestion & Embedding Profiles - Pattern Map

**Mapped:** 2026-11-23
**Files analyzed:** 38 new/modified files or file groups (from 03-CONTEXT.md D-01..D-47 and 03-RESEARCH.md "Recommended Project Structure", "Current Write-Path Inventory", F-1..F-13)
**Analogs found:** 31 / 38

> **Phase 2 is still landing.** Plans 02-09 (`src/lib/rag/context/assemble.ts`, `context/fetch-rows.ts`, edits to `types.ts`, `pipeline.ts`, `index.ts`) and 02-10 (`src/lib/rag/tenant/membership.ts`, `resolve-chat.ts`, `embed.ts`, `voice-token.ts`, `voice.ts`, `index.ts`) are executing, and 02-20 rewrites `scripts/ci/check-rag-boundary.mjs` (not yet on disk). Every line number below for `types.ts`, `pipeline.ts`, `index.ts` is HEAD at mapping time and **will move**. The planner must re-read those three files and `src/lib/rag/tenant/` before writing actions. Contracts quoted here (RagDeps, TenantScope, RpcClient, scopeKey) are not touched by 02-09/02-10 file lists except `index.ts` exports and `types.ts` additions.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/lib/rag/ingest/index.ts` (`ingest()`, `resumeIngest()`) | service entry | batch / request-response | `src/lib/rag/pipeline.ts` (`runRetrieval`) | role-match |
| `src/lib/rag/ingest/runner.ts` (stage list, deadline, state) | service | batch, resumable | `src/lib/rag/pipeline.ts` L27-120 (`StageSpec`, `runStage`, `StageError`) | exact (pattern), different data flow |
| `src/lib/rag/ingest/types.ts` | model | n/a | `src/lib/rag/types.ts` | exact |
| `src/lib/rag/ingest/deps.ts` (`IngestDeps`) | provider / DI | n/a | `src/lib/rag/deps.ts` | exact |
| `src/lib/rag/ingest/config.ts` (RAG_INGEST_PIPELINE, RAG_PARSER, flags) | config | transform | `src/lib/rag/config.ts` | exact |
| `src/lib/rag/ingest/stages/*.ts` | service | batch | `src/lib/rag/backend/supabase-rpc.ts` (scope-asserting function with injected client/signal) | role-match |
| `src/lib/rag/ingest/writer.ts` (only caller of `rag_*` RPCs) | service / repository | CRUD via RPC | `src/lib/rag/backend/supabase-rpc.ts` | exact |
| `src/lib/rag/ingest/identity.ts`, `hash.ts` | utility | transform | `src/lib/rag/tenant/scope.ts` (`scopeKey`, pure helpers) + `src/lib/scrapers/scraper-adapter.ts` (`normalizeScrapedUrl`) | partial |
| `src/lib/rag/ingest/profiles/*` (load `processing-profiles.json`, `resolveDocType`) | config loader | transform | `src/lib/rag/config.ts` (`loadRagConfig`, memo + warnings) | role-match |
| `src/lib/rag/ingest/parsers/sidecar-docling.ts` (sidecar parse client) | client | request-response, polling | none in TS; Python side `rag-sidecar/src/rag_sidecar/auth.py` defines header | **no TS analog** |
| `src/lib/rag/ingest/parsers/llamaparse-v2.ts` | client | request-response, polling | `src/app/api/process-document/route.ts` (v1 upload L204 area) | partial (v1, monolithic) |
| `src/lib/rag/ingest/parsers/plain-text.ts`, `chain.ts` | utility | transform | none | no analog |
| `src/lib/rag/ingest/chunkers/*`, `text/*`, `security/injection-scan.ts` | utility | transform | `src/lib/rag/query/temporal-query-detector.ts` (pure, rule-driven module) | partial |
| `src/lib/rag/ingest/reembed/{run,cursor,cost,cli}.ts` | batch job | batch | `scripts/rag/reprocess-documents.js` | role-match (legacy, destructive) |
| `src/lib/rag/embeddings/{voyage,qwen,registry,profile,mrl}.ts` | provider | request-response | `src/lib/rag/embeddings/openai.ts` | exact |
| `src/lib/rag/backend/supabase-rpc.ts` (modified: profile switch, `match_chunks_by_profile`) | service | request-response | itself L50-102 | exact |
| `src/lib/rag/deps.ts` (modified: profile-aware embedder, ingest deps) | provider | n/a | itself | exact |
| `src/lib/rag/tenant/ingest-*.ts` (session, admin workspace, Nango connection owner, scraper job resolvers) | guard | request-response | `src/lib/rag/tenant/eval.ts` (+ 02-10 `resolve-chat.ts` once landed) | exact |
| `src/lib/rag/tenant/scope.ts` (modified: lowercase ids at mint, F-13) | guard | n/a | itself L22-51 | exact |
| `src/lib/rag/lexical/tokenize.ts`, `lang/detect.ts`, `retrieval/exact-id.ts` | utility | transform | `src/lib/rag/query/temporal-query-detector.ts` | partial |
| `src/instrumentation.ts` (D-37 startup check) | config/hook | event-driven | none | no analog |
| `supabase/migrations/0301_*.sql`..`030N_*.sql` (columns, triggers, `embedding_profiles`, `chunk_embeddings`, writer functions, `match_chunks_by_profile`) | migration | CRUD | `supabase/multi-tenant-setup.sql` L692-740 (`match_documents_by_workspace`) | role-match (no migrations dir exists yet) |
| `supabase/single-tenant-setup.sql`, `multi-tenant-setup.sql` (modified, fresh installs) | migration | CRUD | themselves | exact |
| `src/app/api/process-document/route.ts` (modified, legacy/unified switch) | route | request-response | itself L548-640 (session + org check) | exact |
| `src/app/api/upload/route.ts` (modified, `after()`) | route | event-driven | itself L170-200 | exact |
| `src/lib/nango/document-adapter.ts`, `sync-manager.ts` (5 call sites) | adapter | batch | `src/lib/nango/document-adapter.ts` L19-39 | exact |
| `src/lib/scrapers/scraper-adapter.ts` (markdown, `ingest`) | adapter | request-response | itself L24-70 | exact |
| `src/app/api/ai-to-rag/route.ts` (session scope, D-01) | route | request-response | `src/app/api/process-document/route.ts` session block | role-match |
| `src/app/api/rag/ingest/[id]/route.ts`, `.../resume/route.ts` | route | request-response | `src/app/api/internal/rag/run/route.ts` L1-40 + `src/app/api/documents/route.ts` L1-30 | role-match |
| `src/app/api/rag/doc-type-defaults/route.ts`, `src/app/api/rag/admin/**/route.ts` | route (admin) | CRUD | `src/app/api/internal/rag/run/route.ts` (validation/JSON errors) + `src/lib/admin-utils.ts` `isUserAdmin` L8 | role-match |
| `rag-sidecar/src/rag_sidecar/contracts/ingest.py` | model (Pydantic) | n/a | `rag-sidecar/src/rag_sidecar/contracts/sidecar.py` | exact |
| `rag-sidecar/src/rag_sidecar/export_schemas.py` (modified, register contracts) | config | file-I/O | itself L9-50 | exact |
| `rag-sidecar/src/rag_sidecar/main.py` (modified, `/v1/parse/jobs`, `/v1/extract/invoice`) | controller | request-response | itself L11-41 | exact |
| `rag-sidecar/src/rag_sidecar/parse/*.py`, `extract/*.py` | service | batch / async job | none in sidecar (stateless today) | no analog |
| `src/lib/rag-eval/contracts.generated.ts` (or a new generated ingest contracts file) | model (Zod, generated) | n/a | itself, produced by `scripts/gen-zod.mjs` | exact |
| `eval/harness/fake-edge.mts` (modified: new RPC names) | test harness | request-response | itself L26-35, L146-160 | exact |
| `scripts/check-config.mjs`, `scripts/rag/env-manifest.json`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, `scripts/config-ui/index.html` | config | n/a | existing `RAG_SIDECAR_URL` / `RAG_PIPELINE` entries | exact |
| `tests/rag/ingest/*.test.ts`, `tests/rag/embeddings/*.test.ts`, `tests/helpers/ingest-fakes.ts`, `tests/rag-*.test.mts`, `rag-sidecar/tests/test_*.py` | test | n/a | `tests/rag/helpers/pipeline-fakes.ts`, `tests/two-tenant-fixture.test.mts`, `rag-sidecar/tests/test_health.py` | exact |

## Pattern Assignments

### `src/lib/rag/ingest/deps.ts` and modified `src/lib/rag/deps.ts` (provider / DI)

**Analog:** `src/lib/rag/deps.ts` (whole file, 43 lines)

Copy the defaults + overrides + test setters shape exactly:
```typescript
export interface RagDeps {
  anonClient: () => RpcClient;
  adminClient: () => SupabaseClient | null;
  embedder: (text: string, opts: { signal: AbortSignal }) => Promise<number[]>;
  now: () => number;
  randomId: () => string;
  ragEnv: () => RagEnvInput;
}
const defaults: RagDeps = { anonClient: () => getSupabase() as unknown as RpcClient, adminClient: () => getSupabaseAdmin() as SupabaseClient | null, embedder: embedText, now: () => Date.now(), randomId: () => randomUUID(), ragEnv: () => ({ RAG_PIPELINE: env.RAG_PIPELINE, ... }) };
let overrides: Partial<RagDeps> = {};
export function getRagDeps(): RagDeps { return { ...defaults, ...overrides }; }
export function setRagDepsForTests(partial: Partial<RagDeps>): void { overrides = { ...overrides, ...partial }; }
export function resetRagDepsForTests(): void { overrides = {}; }
```
Rules to carry over:
- Clients are thunks (lazy); never construct at import time.
- Env is read through an injectable `ragEnv()` snapshot (02-08 decision), so `IngestDeps.ingestEnv()` should mirror `ragEnv()` and feed a pure `loadIngestConfig(env)`.
- `IngestDeps` members per research: `db` (an `RpcClient` bound to the **admin** client — writer RPCs are `service_role` only), `objectStore`, `sidecar`, `llamaparse`, `captioner`, `embedders` (registry), `now`. Keep `embedder` in `RagDeps` as the single-function default for `RAG_EMBEDDING_PROFILES=off`; add a registry lookup alongside, do not change its signature.
- `match_chunks_by_profile` is service_role only, so the profile-aware search path uses `adminClient()`; legacy RPCs keep `anonClient()` (deps.ts L19-20).

---

### `src/lib/rag/ingest/runner.ts` and `ingest/index.ts` (service, resumable batch)

**Analog:** `src/lib/rag/pipeline.ts` L27-120 (moves under 02-09)

Stage spec and error class shape (L27-56):
```typescript
export interface StageSpec { name: StageName; enabled: boolean; timeoutMs: number; onFail: 'skip' | 'throw'; }
export class StageError extends Error {
  readonly stage: string; readonly reason: StageFailureReason; readonly original: unknown;
  constructor(stage: string, reason: StageFailureReason, original?: unknown) {
    super(`[RAG Pipeline] stage ${stage} ${reason}`); this.name = 'StageError'; ...
  }
}
```
Abort/timeout composition (L93-116): `AbortSignal.any([parent, AbortSignal.timeout(spec.timeoutMs)])`, race via `runAgainstSignal`, `signal.throwIfAborted()` after every await (postgrest resolves on abort — 02-08 key pattern), and classify `aborted | timeout | failed` from the signal, never from error text.

Trace recording: every stage calls `collector.record({ name, status, startedAt, endedAt, ... })` (L87-107). Reuse `createTraceCollector` from `src/lib/rag/trace/collector.ts` L41-81 with `tenantKey: scopeKey(scope)`; finish with `finishTrace` (`trace/finish.ts`). `Profile` union (`types.ts` L6) has no `ingest` member — adding `'ingest'` to `Profile` changes `PROFILE_STAGE_DEFAULTS` (config.ts L28) which is `Record<Profile, …>`, so either add an `ingest` row there or give the ingest collector its own options type. Flag for planner.

Differences from the analog (from RESEARCH Pattern 1): ingest uses a **request deadline** (`ctx.deadline - deps.now() < stage.minMsNeeded` → yield `processing`) rather than per-stage timeouts, persists `processing_state` after each stage via `writer.saveState`, and stores intermediates in the object store. Log prefix `[Ingest]` (D-46), never document text.

---

### `src/lib/rag/ingest/types.ts` (model)

**Analog:** `src/lib/rag/types.ts` L1-71. Use `import type` for cross-module types (L1-4), string-literal unions for statuses (L8 `RetrievalStatus`, L22 `StageRunStatus`), `interface` for object shapes. `IngestResult.status` values (`ok | skipped_duplicate | processing | failed | quarantined`) follow the same union style. Where a shape crosses the sidecar boundary (`ParseResult`, `ProcessingProfile`, `InvoiceFields`, `DocTypeDetection`, `InjectionRuleSet`) import the **generated Zod type** instead of hand-writing it (see Shared Patterns: Contracts).

---

### `src/lib/rag/ingest/config.ts` and `ingest/profiles/*` (config loader)

**Analog:** `src/lib/rag/config.ts`
- Pure function of an env snapshot, memoised by `JSON.stringify` of the inputs (L131-149).
- One-time deduplicated warnings with a bracketed prefix (L63-71 `problem()` → `console.warn('[RAG Config] ...', data)`); use `[Ingest Config]` / `[Embedding Profile]`.
- Unknown values fall back to the safe default and warn (L84-90 `parsePipeline` always returns `'legacy'`). `RAG_INGEST_PIPELINE`, `RAG_PARSER`, `RAG_EMBEDDING_PROFILES`, `RAG_INJECTION_SCAN` must follow this: an invalid value means legacy/off.
- Integer bounds parsing (L106-129) for `RAG_PARSE_POLL_BUDGET_MS`.
- Export `reset…ForTests()` (L151-154).
`processing-profiles.json` / `injection-rules.json` load: validate with the generated Zod schema (`ProcessingProfileSchema.parse`) and memoise the same way.

---

### `src/lib/rag/ingest/writer.ts` and modified `src/lib/rag/backend/supabase-rpc.ts` (RPC repository)

**Analog:** `src/lib/rag/backend/supabase-rpc.ts` L1-102

Imports and typed client (L1-20):
```typescript
import { logger } from '@/lib/logger';
import { assertTenantScope, workspaceRpcArgs, type TenantScope } from '../tenant/scope';
export interface RpcClient { rpc(fn: string, args: Record<string, unknown>): RpcRequest; }
```
Call + abort + error pattern (L57-77):
```typescript
assertTenantScope(scope);
const response = await client.rpc('match_document_chunks', { ... }).abortSignal(signal);
signal.throwIfAborted();
if (response.error) {
  logger.error('Enhanced RAG', 'Error in single-tenant vector search', { code: response.error.code });
  throw new RetrievalBackendError('match_document_chunks', response.error.code ?? null);
}
```
Copy for `rag_begin_document_version`, `rag_write_chunks`, `rag_publish_document_version`: derive `p_tenant_key` only from `scopeKey(scope)` inside the module (02-07 pattern "RPC name and tenant arguments are derived only from the scope"), add an `IngestWriterError` mirroring `RetrievalBackendError` (L30-40, carries `rpc` and `code`, never row content). Log error codes, never payloads.

Profile search switch: add a third branch in `vectorSearch` that calls `match_chunks_by_profile` on the admin client when `RAG_EMBEDDING_PROFILES` is on and the active profile is non-legacy; keep the two existing branches byte-identical (pinned by `tests/rag-legacy-differential.test.mts`). Map an `embedding_profile_mismatch` SQL error to `status: 'error'`, `reason: 'embedding_profile_mismatch'` (no type change needed, `RetrievalResult.reason: string`).

`RpcResponse.data` is typed `unknown[] | null` (L9-12); writer RPCs returning a single row/object need `data` widened or a separate response type — flag for planner.

---

### `src/lib/rag/tenant/ingest-*.ts` and modified `tenant/scope.ts` (guard)

**Analog:** `src/lib/rag/tenant/eval.ts` L1-23 (and 02-10's `resolve-chat.ts`, `embed.ts` once landed — prefer those as the closer analog when present)
```typescript
import { mintScope, type TenantScope } from './scope';
export type EvalScopeOutcome = { ok: true; scope: TenantScope } | { ok: false; status: 403; error: string };
export function evalScope(input: EvalScopeInput): EvalScopeOutcome {
  ...
  try {
    if (input.deploymentMode !== 'multi-tenant') return { ok: true, scope: mintScope('single', null, null) };
    if (input.organizationId) return { ok: true, scope: mintScope('org', input.userId || null, input.organizationId) };
    return { ok: true, scope: mintScope('personal', input.userId, null) };
  } catch { return { ok: false, status: 403, error: 'Scope not allowed' }; }
}
```
- Resolvers live in `src/lib/rag/tenant/` because `mintScope` is tenant-internal (`scope.ts` L33). Ingest code outside `tenant/` imports only `assertTenantScope`, `scopeKey`, `tenantPredicate` (02-20 boundary must restrict `mintScope` only — research F-13; 02-20 is not on disk yet, coordinate).
- Session resolver: reuse the membership check that process-document does today (`verifyUserOrganizationAccess`, `src/app/api/process-document/route.ts` L600-616) — 02-10 `membership.ts` is expected to wrap it.
- Nango resolver: `connRecord.user_id` → `mintScope('personal', …)`. Scraper: verified `organizationId` or user; single-tenant today passes `'single-tenant-user'` which `requireUuid` (L26-31) rejects — the resolver must map single-tenant to `mintScope('single', null, null)`.
- F-13: lowercase ids inside `mintScope` (L34-51) since `UUID_RE` is case-insensitive (L22) and SQL `::text` is lowercase.

---

### `src/lib/rag/embeddings/{voyage,qwen,registry,profile,mrl}.ts` (provider)

**Analog:** `src/lib/rag/embeddings/openai.ts` L1-37
```typescript
import OpenAI from 'openai';
import { env } from '@/lib/env';
const BATCH_SIZE = 100;
let client: OpenAI | null = null;
function getClient(): OpenAI { if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY }); return client; }
export async function embedBatch(texts: string[], opts: { signal: AbortSignal }): Promise<number[][]> {
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const response = await getClient().embeddings.create({ model: embeddingModel(), input: texts.slice(i, i + BATCH_SIZE) }, { signal: opts.signal });
    ...
```
- Lazy module-level client, signal passed to every request, batch loop.
- Keep `embedText`/`embedBatch` signatures unchanged (exported from `index.ts` L14). New registry providers return an `EmbedOutput` `{ vectors, model, usage, host }` (D-37 model assertion, dry-run cost, `embedding_host` for Qwen fallback).
- DeepInfra Qwen is OpenAI-compatible: reuse the `openai` SDK with `baseURL: env.DEEPINFRA_BASE_URL`. Voyage has no SDK in the repo — use `fetch` with `truncation: false`. Do not send `dimensions`/`input_type` to Qwen; truncate + L2-normalize in `mrl.ts`. Qwen query format exactly `Instruct: ${task}\nQuery:${query}` (F-5).
- Never log key values (CLAUDE.md logging rule); log `[Embedding Profile]` with presence only.

---

### `src/lib/rag/ingest/parsers/sidecar-docling.ts` (sidecar parse client) — no TS analog

There is no TypeScript client of the sidecar in `src/` today (only `env.ts` reads `RAG_SIDECAR_URL`/`RAG_SIDECAR_SECRET`, L168-169; the eval harness drives the sidecar via `uv`). Build from:
- Header contract from `rag-sidecar/src/rag_sidecar/auth.py` L9-10: `PROBE_PATHS = {"/health", "/ready"}`, header `x-sidecar-secret`; 401 `unauthorized`, 503 `sidecar secret not configured` bodies are `SidecarError` (`contracts/sidecar.py` L25-26) → parse with the generated `SidecarErrorSchema`.
- Validate every response with the generated Zod schema (`ParseResultSchema.parse`), like `src/app/api/internal/rag/run/route.ts` L6 imports `RagRunRequestSchema, RagTraceSchema`.
- Inject through `IngestDeps.sidecar` so tests use a fake; poll with backoff under `RAG_PARSE_POLL_BUDGET_MS`; 404 on poll → resubmit once (research Pattern 1).

---

### Legacy writer adapters (modified)

**`src/lib/nango/document-adapter.ts` L19-39** — single seam for all five sync-manager call sites (`sync-manager.ts` L322, L473, L613, L1171, L1277). Put the `RAG_INGEST_PIPELINE` switch here, not at each call site:
```typescript
export async function processDocumentWithMetadata(filename: string, buffer: Buffer, options: ProcessDocumentOptions): Promise<string> {
  const metadata = { user_id: options.userId, source: options.source || 'nango', source_provider: ..., source_file_id: ..., source_connection_id: ... } as Parameters<typeof processDocument>[2];
  const documentId = await processDocument(filename, buffer, metadata);
```
Unified branch: `ingest({ scope: nangoScope(userId), source: 'nango', sourceKey: options.sourceFileId, file })`, return the current version id so `nango_sync_records.document_id` keeps pointing at the current version.

**`src/lib/scrapers/scraper-adapter.ts` L24-70** (and `crawlAndProcess` L82-122): same switch around `processDocument(filename, buffer, metadata)`; unified asks Firecrawl for markdown and calls `ingest({ source: 'scraper', sourceKey: normalizedUrl, text })`. Note this file uses 4-space indentation — match it.

**`src/app/api/process-document/route.ts` L548-640**: keep the session/org verification block as-is (L600-630) and hand its result to the session resolver; the temporary path (L726) stays out of `ingest()`. The local `storeDocument` (L394-545) stays as the legacy branch untouched.

**`src/app/api/upload/route.ts` L170-195**: the un-awaited `processImageDocument(...).catch(...)` becomes `after(() => ingest({ source: 'image_upload', ... }))` in the unified branch; keep `logger.error('Upload API', ...)` style.

**`src/app/api/ai-to-rag/route.ts` L190+**: replace body `userId` with the session resolver (D-01); copy the session lookup from process-document.

---

### New routes `src/app/api/rag/**/route.ts`

**Analog:** `src/app/api/internal/rag/run/route.ts` L1-40
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { validateRequest } from '@/lib/api-middleware';
export const runtime = 'nodejs';
export async function POST(req: NextRequest) {
  const access = checkEvalAccess(req.headers, {...});
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const parsed = await validateRequest(req, RagRunRequestSchema);
  if (!parsed.success) return parsed.response;
  ...
  if (!scope.ok) { console.warn('[RAG Eval] scope refused:', { deploymentMode, hasOrganization: !!organizationId, hasUser: !!userId }); return NextResponse.json({ error: scope.error }, { status: scope.status }); }
```
- Session routes: `createClient` from `@/lib/supabase/server` + `getSupabaseAdmin()` (`src/app/api/documents/route.ts` L1-16), then the tenant resolver.
- Admin routes: `isUserAdmin()` from `src/lib/admin-utils.ts` L8; respond 403 JSON otherwise.
- Dynamic segment params are async in Next 16 — see `tests/routes/async-params.test.ts` for the established check.
- Ownership on `GET /api/rag/ingest/{id}`: compare the row's `tenant_key` with `scopeKey(scope)`; return 404 (not 403) on mismatch to avoid id probing.

---

### Sidecar Python: `contracts/ingest.py`, `main.py` routes, `export_schemas.py`

**Contracts analog:** `rag-sidecar/src/rag_sidecar/contracts/sidecar.py` L1-26
```python
class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
class SidecarInfo(_Contract):
    service: Literal["rag-sidecar"]
```
Every new model (`ProcessingProfile`, `ParseJobRequest`, `ParseResult`, `InvoiceFields`, `InjectionRuleSet`, `DocTypeDetection`) subclasses `_Contract`; re-export from `contracts/__init__.py`; register in `export_schemas.py` `CONTRACTS` list (L36-50) with `"validation"` for request bodies and `"serialization"` for responses; add samples to `contracts/samples.py` (feeds `tests/fixtures/contracts/samples.json`). Golden `Category` literal lives in `contracts/golden.py` L8 — add `cross_lingual` after 02-25's additions.

**Routes analog:** `rag-sidecar/src/rag_sidecar/main.py` L11-41 — `create_app(settings)` factory, `APIRouter(prefix="/v1")`, `response_model=` on each route, error bodies as `JSONResponse(status_code=…, content=Model.model_dump(mode="json"))` (L24-25). New `/v1/parse/jobs`, `/v1/parse/jobs/{id}`, `/v1/parse/jobs/{id}/artifacts/{name}` (F-4), `/v1/extract/invoice` go on the same `v1` router so `SharedSecretMiddleware` covers them. Bump `CONTRACTS_SCHEMA_VERSION` (L8).

Dependencies: `rag-sidecar/pyproject.toml` pins exact versions (`fastapi==0.165.0`); Docling goes in an optional extra (`docling`), plus `huggingface_hub` (P-4) and `python-multipart==0.0.34`, `python-stdnum==2.2`.

---

### Migrations `supabase/migrations/03NN_*.sql` (no directory exists yet)

**Analog:** `supabase/multi-tenant-setup.sql` L692-740
```sql
CREATE OR REPLACE FUNCTION public.match_documents_by_workspace(p_query_embedding vector(1536), ...)
RETURNS TABLE (...) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN RETURN QUERY ... END; $$;
GRANT EXECUTE ON FUNCTION public.match_documents_by_workspace TO authenticated;
```
Deviations required by research: writer functions and `match_chunks_by_profile` end with `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;` (not anon/authenticated like the analog). `match_chunks_by_profile` reads dims from `embedding_profiles` and uses `format()` (F-8). Idempotent (`IF NOT EXISTS`, catalog lookup to drop the `source` CHECK, F-1), PostgreSQL 15-compatible (no `uuidv7()`, no virtual generated columns). Both setup files must also receive the same objects for fresh installs, and `tests/rag-schema-equality.test.mts` asserts setup+migrations equal. `scripts/setup-database.sh` must apply the migrations directory.

---

### `eval/harness/fake-edge.mts` (modified) — the fake PostgREST edge limitation

**Analog:** itself L26-35, L146-160, L290-294
```typescript
const RPC_ARGUMENTS: Record<string, { vector: string; allowed: string[] }> = {
  match_document_chunks: { vector: 'query_embedding', allowed: [...] },
  match_documents_by_workspace: { vector: 'p_query_embedding', allowed: [...] },
};
...
if (method !== 'GET') throw new Rejection(405, `unsupported method ${method} for ${pathname}`);
```
- Unknown RPCs → 404, unknown args → 400, table writes → 405. Because table requests are GET-only, **every unified write must be an RPC** (this is why research Pattern 2 puts all writes in SQL functions). Add `rag_begin_document_version`, `rag_write_chunks`, `rag_publish_document_version`, `match_chunks_by_profile` (+ any status/state RPC) to `RPC_ARGUMENTS`.
- `toVectorText` (L111) converts only the one named `vector` arg; `rag_write_chunks` sends vectors inside `p_embeddings jsonb`, so its spec needs `vector: ''`-style handling (no conversion) — extend the spec type rather than special-casing.
- Fake edge does not emulate role grants (it runs SQL as the PGlite superuser), so `service_role`-only grants must be tested directly in PGlite (`SET ROLE anon` assertions), not via the edge.
- `TABLE_COLUMNS` (L37-42) whitelists readable columns; new columns read by legacy-path readers under the D-08 filter (`is_current`, `status`, `tenant_key`) must be added.
- Storage: no fake object store exists. `tests/helpers/ingest-fakes.ts` needs an in-memory store applying the Supabase key regex `/^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$/` (F-2, P-13).

---

### Env/config sync (D-44 variables)

**Analog:** the existing `RAG_SIDECAR_URL` / `RAG_PIPELINE` entries in all locations:
- `src/lib/env.ts` L168-171: `RAG_PIPELINE: process.env.RAG_PIPELINE || 'legacy',`
- `scripts/init-env.js` L326-339: commented block under a `# ----` section header (`# RETRIEVAL PIPELINE`), one comment line per variable.
- `scripts/config-server.js`: three templates — L534-538 (`${fullValues.X !== undefined ? `X=${fullValues.X}` : 'X=default'}`), L1303-1306 and L1637-1640 (`X=${getEnvValue('X') || 'default'}`); secrets also join the short-secret list at L207.
- `scripts/config-ui/index.html` L6378-6420: `form-control` blocks with `input id="<VAR>"`, password + 👁️ toggle for secrets (L6394-6398); secret length check list at L9299.
- `scripts/rag/env-manifest.json` L405-466: `{ "name": "...", "status": "managed", "knownGaps": [] }`, alphabetical.
- `scripts/check-config.mjs` L16 `NAME_PATTERN` must be extended with `VOYAGE_[A-Z0-9_]+|DEEPINFRA_[A-Z0-9_]+` (as 02-03 did for `LANGFUSE_`); `scripts/check-config.test.mjs` covers it.
- `LLAMA_CLOUD_API_KEY` already exists (`env.ts` L112) — reuse, add nothing (F-6).

## Shared Patterns

### DI via RagDeps
**Source:** `src/lib/rag/deps.ts` L9-43. **Apply to:** ingest runner, writer, embeddings registry, parsers, re-embed job. All external I/O behind a thunk in deps; tests swap via `setRagDepsForTests` / `resetRagDepsForTests` (or an `IngestDeps` twin with the same three functions).

### Tenant scope at every boundary
**Source:** `src/lib/rag/tenant/scope.ts` L57-68 (`assertTenantScope`, `scopeKey`), `backend/supabase-rpc.ts` L57. **Apply to:** every ingest stage, writer function, route. First line of any scope-taking function is `assertTenantScope(scope)`; `tenant_key` = `scopeKey(scope)` (`s:default`, `o:<id>`, `u:<id>`). SQL functions re-check `p_tenant_key` against the row.

### Contracts: Pydantic → JSON Schema → Zod
**Source:** `rag-sidecar/src/rag_sidecar/export_schemas.py` (writes `rag-sidecar/schemas/*.schema.json`), `scripts/gen-zod.mjs` (writes `src/lib/rag-eval/contracts.generated.ts`, header `// GENERATED ... do not edit`, `import { z } from 'zod/v3'`), `npm run gen:schemas`, parity enforced by `tests/schema-parity.test.ts` and `rag-sidecar/tests/test_contract_export.py`. **Apply to:** every sidecar request/response, `processing-profiles.json`, `injection-rules.json`, `DocTypeDetection`, golden items. Never hand-write a Zod schema for these. If ingest contracts go into a separate generated file, `gen-zod.mjs` already supports `--out` / `--schemas-dir` (L8-17); otherwise extend the single generated file.

### Validation and errors in routes
**Source:** `src/lib/api-middleware.ts` (`validateRequest`, `withValidation`), `src/app/api/internal/rag/run/route.ts` L26-39. `z` from `zod/v3`; `NextResponse.json({ error }, { status })`; `[Prefix]` log before returning; never log text or keys.

### Logging
`[Ingest]`, `[Ingest Config]`, `[Ingest Trace]`, `[Embedding Profile]` prefixes; `logger.error('<Area>', msg, { code })` as in `supabase-rpc.ts` L72; structured second argument; no document text (D-46).

### Test helpers
- **Unit (vitest, `tests/rag/**`)**: `tests/rag/helpers/pipeline-fakes.ts` — `fakeRpcClient({ rows, delayMs, error, throwOnCall })` records `{ fn, signal }` calls and honours abort (L39-76); `fakeEmbedder` (L83-108); `installDeps` / `uninstallDeps` reset config memo too (L110-118). `tests/helpers/ingest-fakes.ts` should extend these (record RPC **args** as well as fn, since writer tests assert payloads; fake object store with key regex; fake sidecar job sequence; fake LlamaParse v2).
- **DB-level (`tests/*.test.mts`, `node:test`)**: `tests/two-tenant-fixture.test.mts` L1-30 — `createTwoTenantDatabase()` / `createFixtureDatabase({ deploymentMode, corpusDir })` from `eval/harness/pglite-supabase.mts` L43-75 (PGlite + vector + pg_trgm, applies the setup SQL), call SQL functions directly with named args, `TWO_TENANT_IDS` fixed UUIDs, `@example.invalid` emails. Migrations need applying after the setup SQL in `createFixtureDatabase` (planner: add a `migrations` option).
- **Route-level (vitest)**: `tests/helpers/route-fixture.ts` L1-40 — `startFakeEdge({ db })`, `fixtureProcessEnv(edge.url)`, `loadRoute(path)`; placeholder secrets (`INTERNAL_API_KEY = 'test-internal-api-key-placeholder'`).
- **Sidecar (pytest)**: `rag-sidecar/tests/test_health.py` L1-20 — `TestClient(create_app(SidecarSettings(secret=SecretStr("s" * 48))))`, validate responses with the Pydantic model. Docling tests must `pytest.importorskip` when the `docling` extra is absent (P-4).
- `tests/rag-legacy-differential.test.mts` is the parity guard for any edit to `supabase-rpc.ts` / `pipeline.ts`.

## No Analog Found

| File | Role | Data Flow | Reason / Use instead |
|---|---|---|---|
| `src/lib/rag/ingest/parsers/sidecar-docling.ts` | client | polling | No TS sidecar client exists; build from `auth.py` header + generated schemas (above) |
| `src/lib/rag/ingest/parsers/plain-text.ts`, `chain.ts` | utility | transform | No fallback chain today; RESEARCH Pattern 4 and F-11 |
| `src/lib/rag/ingest/stages/store_original.ts` + object store | file-I/O | file-I/O | Only public `chat-images` uploads exist (`upload/route.ts`); private `rag-originals` bucket is new (F-2) |
| `rag-sidecar/src/rag_sidecar/parse/jobs.py`, `docling_adapter.py`, `extract/*.py` | service | async job | Sidecar is stateless today; RESEARCH Pattern 4 code and Docling facts (MarkdownTableSerializer F-3, RapidOCR `lang=["ch"]`) |
| `src/instrumentation.ts` | hook | event-driven | No instrumentation file; RESEARCH "Next.js instrumentation" (3 s, never throws, nodejs only) |
| `src/lib/rag/ingest/reembed/*` keyset cursor and `--derive-from` | batch | batch | `scripts/rag/reprocess-documents.js` is destructive and unscoped; use only for CLI arg style; RESEARCH Patterns 7-8 |
| `match_chunks_by_profile` dynamic SQL, `halfvec` partial indexes, triggers | migration | CRUD | No dynamic SQL or triggers in setup files; RESEARCH Patterns 3 and 6 (verified in PGlite) |

## Metadata

**Analog search scope:** `src/lib/rag/**`, `src/lib/rag-eval/`, `src/lib/nango/`, `src/lib/scrapers/`, `src/app/api/{process-document,upload,ai-to-rag,documents,admin,internal/rag}`, `rag-sidecar/**`, `eval/harness/**`, `tests/**`, `scripts/{check-config.mjs,gen-zod.mjs,init-env.js,config-server.js,config-ui,rag}`, `supabase/*.sql`
**Files scanned:** ~45
**Not verified:** git-tracked status of analogs (git commands were out of scope for this run); all named paths are source paths, none are generated mirrors except `contracts.generated.ts`, which is a committed generated file.
**Pattern extraction date:** 2026-11-23
