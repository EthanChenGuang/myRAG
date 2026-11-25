# Phase 2: Unified Retrieval Pipeline & Tenant Scope - Pattern Map

**Mapped:** 2026-11-23
**Files analyzed:** ~45 new/modified (grouped below)
**Analogs found:** 41 / 45 (the Langfuse exporter, the stage runner and the trace sampler have no in-repo analog; use RESEARCH.md Patterns 2-4)

`src/lib/rag/` does not exist yet. Every analog below is git-tracked source (Phase 1 outputs or legacy modules).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `src/lib/rag/index.ts` | barrel (only public entry) | n/a | none (first barrel); export style of `src/lib/rag-eval/auth.ts` | partial |
| `src/lib/rag/types.ts` | model | n/a | `src/lib/rag-eval/legacy-post-filter.ts` L1-30 (interfaces) | role-match |
| `src/lib/rag/config.ts` | config | parse env | `src/lib/rag-eval/auth.ts` `parseAllowedScopes` (L49-56) + `src/lib/env.ts` L160-169 | role-match |
| `src/lib/rag/deps.ts` | provider (DI seam) | n/a | `tests/helpers/chat-route-fakes.ts` (what tests must replace) + `src/lib/supabase.ts` getters | partial |
| `src/lib/rag/pipeline.ts` (stage runner, status) | service | request-response, AbortSignal | none; RESEARCH Pattern 2 | no analog |
| `src/lib/rag/tenant/scope.ts` | model + guard | n/a | RESEARCH Pattern 1; key format of `evalScopeKey` (`auth.ts` L58+) | partial |
| `src/lib/rag/tenant/resolve-chat.ts` | middleware | request-response (Supabase) | `src/app/api/chat/route.ts` L2114 (`sbSSR.auth.getUser()`) + `src/lib/auth/organization-handler.ts` L54/L103 (`organization_members`) | exact |
| `src/lib/rag/tenant/embed.ts` | middleware | env -> scope | `src/lib/rag-eval/auth.ts` `checkEvalScope` (result union) | role-match |
| `src/lib/rag/tenant/voice-token.ts` | utility (HMAC) | transform | `src/lib/rag-eval/auth.ts` L1-37 (`timingSafeEqual` over sha256, `MIN_SECRET_LENGTH = 32`) | exact |
| `src/lib/rag/tenant/eval.ts` | middleware | env -> scope | `src/lib/rag-eval/auth.ts` `checkEvalScope` / `evalScopeKey` (wrap, do not rewrite) | exact |
| `src/lib/rag/legacy/enhanced-retrieval.ts` | service | CRUD (RPC) | `src/lib/enhanced-rag-retrieval.ts` (move verbatim, then stop swallowing RPC errors) | exact |
| `src/lib/rag/query/temporal-query-detector.ts` | utility | transform | `src/lib/temporal-query-detector.ts` (move) | exact |
| `src/lib/rag/embeddings/openai.ts` | service | request-response | `src/lib/document-processor.ts` `getQueryEmbedding` | exact |
| `src/lib/rag/context/assemble.ts` | service | transform + 2 batched `in()` reads | `src/lib/rag-eval/legacy-post-filter.ts` (replica of chat post-filter) | exact |
| `src/lib/rag/context/voice.ts`, `voice/keyword-fallback.ts` | service | CRUD | `src/app/api/internal/voice-rag/route.ts` (inline heuristics) | exact |
| `src/lib/rag/context/media.ts` | service | CRUD | `src/app/api/generate-image/route.ts` L273, `generate-video/route.ts` L230 | exact |
| `src/lib/rag/rerank/local-hybrid.ts` | utility | transform | `src/lib/reranker-local.ts` `hybridRerank` (fix 6x TS2790) | exact |
| `src/lib/rag/refs/*` | service | CRUD | chat route @mention / document-part blocks (~L1898-2400) | exact |
| `src/lib/rag/generation/prompt.ts` | utility | transform | `src/lib/thinking-rag-enhancer.ts` `createEnhancedRAGPrompt` | exact |
| `src/lib/rag/trace/collector.ts`, `log.ts` | utility | event | `src/lib/rag-eval/trace.ts` (`buildEffectiveConfig`, sensitive-name redaction) | role-match |
| `src/lib/rag/trace/langfuse.ts`, `sample.ts` | service | streaming export (OTLP) | none; RESEARCH Patterns 3-4 | no analog |
| `src/lib/rag/trace/mask.ts` | utility | transform | `src/lib/rag-eval/trace.ts` `SENSITIVE_NAME` / `URL_WITH_CREDENTIALS` regex style | role-match |
| `src/app/api/chat/route.ts` | route | streaming SSE | itself (keep strict-refusal path L2580 `buildNoKnowledgeBaseResponse`) + `src/lib/error-stream.ts` | exact |
| `src/app/api/internal/rag/run/route.ts` | route | request-response | itself (Phase 1); swap `enhancedRetrieveChunks` + `applyLegacyPostFilter` for `runRetrieval` | exact |
| `src/app/api/embed/chat/route.ts` | route | streaming | chat route post-migration | exact |
| `src/app/api/internal/voice-rag/route.ts`, `voice-chat/route.ts` | route | request-response | `internal/rag/run/route.ts` (auth-first, `validateRequest`, JSON errors) | role-match |
| `src/app/api/generate-image/route.ts`, `generate-video/route.ts` | route | request-response | same file; context lookup replaced by `runRetrieval({profile:'media'})` | exact |
| `src/app/api/livekit/token/route.ts` | route | request-response | `internal/rag/run/route.ts` structure + `resolveTenantScope` | role-match |
| `voice-agent/src/rag_client.ts`, `agent.ts` | client | request-response | itself; add `x-rag-scope-token` header | exact |
| `scripts/ci/check-rag-boundary.mjs` | utility (CI) | file-I/O scan | `scripts/check-config.mjs` (walkSrc, regex scan, exported constants) | exact |
| `scripts/tests/check-rag-boundary.node-test.mjs` | test | file-I/O | `scripts/tests/gen-zod.node-test.mjs` (tmp dir + spawnSync) | exact |
| `scripts/ci/check-workflows.py` | test (CI) | file-I/O | itself: extend `PR_JOBS` (L20) | exact |
| `.github/workflows/pr-smoke.yml`, `nightly.yml` | config | n/a | `pr-smoke.yml` `ts` job steps | exact |
| `scripts/typecheck-new.mjs` (ratchet, then removed) | utility (CI) | file-I/O | itself: extend `PHASE1_PATHS` to `src/lib/rag/` + per-file baseline | exact |
| `tsconfig.json`, `next.config.js` | config | n/a | `tsconfig.typecheck-new.json` (`allowImportingTsExtensions`) | exact |
| `rag-sidecar/src/rag_sidecar/contracts/golden.py`, `baseline.py`, `report.py`, `judge.py`, new `latency.py`, `review.py` | model (Pydantic) | n/a | `contracts/golden.py` (`_Contract`, `Literal` enums) | exact |
| `src/lib/rag-eval/contracts.generated.ts` | generated | n/a | `npm run gen:schemas` only, never hand-edited | exact |
| `eval/src/rag_eval/gate.py` (ignore `degrade`) | service | batch | itself (`EXIT_*` codes L11-14) | exact |
| `eval/src/rag_eval/paired.py`, `review_queue.py`, `online_judge.py` | service/CLI | batch | `eval/src/rag_eval/baseline.py` (argparse `main(argv)`, `_record`) | role-match |
| `eval/config/latency-budgets.json` | config | n/a | `eval/config/noise.json` | exact |
| `eval/tests/test_paired.py` etc. | test (pytest) | n/a | `eval/tests/test_gate.py` | exact |
| `tests/rag/*.test.ts` (tenant, pipeline, assemble, query-count, trace, voice-token, embed/voice characterization) | test (vitest) | n/a | `tests/chat-strict.test.ts`, `tests/eval-route-auth.test.ts`, `tests/legacy-post-filter.test.ts` | exact |
| `tests/rag/tenant-brand.test-d.ts` | type test | n/a | none (compiled by `typecheck:new`) | partial |
| env files (5 places + manifest) | config | n/a | `RAG_EVAL_*` rows in `src/lib/env.ts` L165-169 and `scripts/rag/env-manifest.json` | exact |
| `package.json`, `.nvmrc`, `voice-agent/Dockerfile` | config | n/a | `pr-smoke.yml` already `node-version: '22'` | exact |
| Type-fix areas (MCP, WhatsApp, UI, lib, route params) | mixed | mixed | see "Type-error fix areas" | n/a |

## Pattern Assignments

### Tenant module (`src/lib/rag/tenant/*`)

**Analog:** `src/lib/rag-eval/auth.ts`

Result-union style to copy for every resolver (L6, L40):
```typescript
export type EvalAccessResult = { ok: true } | { ok: false; status: 401 | 404 | 503; error: string };
export type EvalScopeResult = { ok: true } | { ok: false; status: 403; error: string };
```
Use `{ ok: true; scope: TenantScope } | { ok: false; status: 401 | 403 | 503; reason: string }`. Routes map it to `NextResponse.json({ error }, { status })` before any streaming starts (D-08: non-member returns 403 before streaming).

Constant-time compare for the voice token (L1-37):
```typescript
import crypto from 'node:crypto';
const MIN_SECRET_LENGTH = 32;
function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}
if (!crypto.timingSafeEqual(sha256(provided), sha256(secret))) {
  return { ok: false, status: 401, error: 'Unauthorized' };
}
```
For HMAC use `crypto.createHmac('sha256', secret)`, then compare the digests with `timingSafeEqual`. A secret shorter than 32 characters returns 503 ("not configured"), the same as the eval secret.

Config is passed in explicitly, not read inside: `checkEvalAccess(headers, { nodeEnv, endpointEnabled, secret })`. Copy this so the tests in `tests/eval-route-auth.test.ts` stay simple. `evalScope()` wraps `checkEvalScope` and `parseAllowedScopes`. Do not fork them.

Membership check: copy the `.from('organization_members')` query shape from `src/lib/auth/organization-handler.ts` L54 / L103 (select by `organization_id` + `user_id`). Session: chat route L2114 `const { data: userRes } = await sbSSR.auth.getUser();` with `createClient` from `@/lib/supabase/server` (tests mock it: `vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }))`). The predicate must match `match_documents_by_workspace` (`supabase/multi-tenant-setup.sql` L692; quoted in RESEARCH §"SQL semantics").

Brand: RESEARCH Pattern 1 (module-private `unique symbol` plus a `WeakSet` runtime check). Log refusals with `[RAG Tenant]` and booleans only, as in the eval route: `console.warn('[RAG Eval] scope refused:', { deploymentMode, hasOrganization: !!organizationId, hasUser: !!userId })`.

---

### `src/lib/rag/config.ts`

**Analogs:** `src/lib/env.ts` L160-169, `auth.ts` `parseAllowedScopes`
```typescript
RAG_EVAL_ENDPOINT_ENABLED: process.env.RAG_EVAL_ENDPOINT_ENABLED || 'false',
RAG_EVAL_SECRET: process.env.RAG_EVAL_SECRET || '',
```
```typescript
export function parseAllowedScopes(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => e !== ''));
}
```
Read through `env` from `@/lib/env`, never `process.env` directly. The eval route today uses the anti-pattern `(env as unknown as Record<string, string | undefined>).RAG_FINAL_RESULT_COUNT`. D-28 adds `RAG_FINAL_RESULT_COUNT` to env.ts, so remove that cast. Log an unknown `RAG_PIPELINE` value or a core stage named in `RAG_DISABLED_STAGES` once, under the `[RAG Config]` prefix.

---

### `src/lib/rag/legacy/enhanced-retrieval.ts`, `query/temporal-query-detector.ts`, `rerank/local-hybrid.ts`, `generation/prompt.ts`, `embeddings/openai.ts`

**Analogs:** `src/lib/enhanced-rag-retrieval.ts`, `src/lib/temporal-query-detector.ts`, `src/lib/reranker-local.ts`, `src/lib/thinking-rag-enhancer.ts`, `src/lib/document-processor.ts` (`getQueryEmbedding`)

- Move with `git mv`-equivalent content. Keep algorithm, thresholds and boosts byte-identical (D-02). The only intended change is that an RPC `error` now throws into the stage runner instead of returning `[]` (D-05). The `search` stage then reports `error`.
- Thread `signal` through: `.abortSignal(signal)` on PostgREST builders, `{ signal }` on the OpenAI call. After an await, call `signal.throwIfAborted()` (RESEARCH P-04: postgrest resolves on abort).
- Keep the `[Document Search]` log lines (AGENTS.md §6).
- Supabase clients come from `deps.ts`, which defaults to `getSupabase()` / `getSupabaseAdmin()` from `@/lib/supabase`. Existing tests mock `@/lib/supabase`, `@/lib/document-processor`, `@/lib/enhanced-rag-retrieval` and `@/lib/thinking-rag-enhancer` (see `tests/chat-strict.test.ts` L13-29). Retarget those mocks to `@/lib/rag` or `setRagDepsForTests()` in the same plan that moves each module.

---

### `src/lib/rag/context/assemble.ts`

**Analog:** `src/lib/rag-eval/legacy-post-filter.ts`. Its tests: `tests/legacy-post-filter.test.ts`, `tests/legacy-post-filter-sentinel.test.ts`.

Imports and input shape to keep (L1-30):
```typescript
import { formatURLsForContext, type ExtractedURL } from '@/lib/url-extractor';
export type LegacyKeptBy = 'similarity' | 'name' | 'image';
export interface LegacyPostFilterInput {
  queryText: string;
  candidates: LegacyCandidate[];
  documents: Map<string, LegacyDocumentRow>;
  chunkMetadata: Map<string, Record<string, unknown> | null>;
  chunkUrlMetadata: Map<string, Record<string, unknown> | null>;
  isGPTModel: boolean; ragMode: LegacyRagMode; webSearchEnabled: boolean;
```
- The pure function takes pre-fetched Maps. Build the Maps with exactly one `.in('id', ids)` query for documents and one for chunk metadata (D-17).
- Promote this file into `assembleContext()`. Delete the replica only after the differential byte-identity test passes (RESEARCH §"Differential byte-identity test").
- Retarget the sentinel test digests in the same plan.

Query-counting test: RESEARCH §"Code Examples / Query-counting test", on the fake edge `eval/harness/fake-edge.mts` + `pglite-supabase.mts` (as in `tests/fixture-edge.test.mts`).

---

### `src/lib/rag/trace/*`

**Analog (partial):** `src/lib/rag-eval/trace.ts`
```typescript
import crypto from 'node:crypto';
const SENSITIVE_NAME = /SECRET|KEY|TOKEN|PASSWORD|PASSWD|PWD|CRED|AUTH|DSN|PRIVATE|COOKIE|SESSION/;
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i;
```
- Put the PII patterns in `mask.ts` as module-level SCREAMING_SNAKE regex constants, in the same style.
- The collector output must stay compatible with `RagTraceSchema` (`contracts.generated.ts`), which the eval route already emits. Map `stage_latency_ms` keys to the stage names.
- The fallback is a single `console.log('[RAG Trace]', { traceId, tenantKey, profile, status, stages })` per request, with no query or chunk text.
- `langfuse.ts` and `sample.ts`: use RESEARCH Patterns 3 (isolated `BasicTracerProvider`, span replay) and 4 (`scheduleAfterResponse` wrapping `after()`).

---

### `src/app/api/chat/route.ts` and `src/app/api/embed/chat/route.ts` (streaming)

**Analog:** the chat route itself, plus `src/lib/error-stream.ts`.
```typescript
export function formatErrorSSE(message: string): string {
  const errorPart = JSON.stringify({ type: 'error', errorText: message });
  return `data: ${errorPart}\n\ndata: [DONE]\n\n`;
}
```
- Status `empty`: keep the existing strict path (L2580 `buildNoKnowledgeBaseResponse(fallbackLanguage)`, L594).
- Status `error`, or `degraded` with zero results: stream a localized "temporarily unavailable" message (zh/en/it) through the same mechanism as `buildNoKnowledgeBaseResponse` and `formatErrorSSE`.
- Keep the `source_images` / `usedDocuments` custom chunks (AGENTS.md §14). Cast them in one helper, not as `data-*` parts.
- Import only `from '@/lib/rag'`.
- The workspace prompt lookup (~L2615) must use `scope.organizationId`, not the body value.
- Tests: extend the `tests/chat-*.test.ts` harness (`createChatRouteHarness`, `readSse`, `chatRequest` in `tests/helpers/chat-route-fakes.ts`). Load the route with `vi.resetModules(); return import('@/app/api/chat/route')`.

### `src/app/api/internal/rag/run/route.ts`, `internal/voice-rag`, `internal/voice-chat`, `livekit/token`, `generate-image`, `generate-video` (request-response)

**Analog:** `src/app/api/internal/rag/run/route.ts` L1-40. Its order is: access check, then `validateRequest`, then scope, then `try`.
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { validateRequest } from '@/lib/api-middleware';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const access = checkEvalAccess(req.headers, { ... });
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const parsed = await validateRequest(req, RagRunRequestSchema);
  if (!parsed.success) return parsed.response;
```
- Define new request schemas with `z` from `zod/v3` (voice-rag body; livekit token query params). Eval contracts stay generated from Pydantic.
- voice-rag keeps its `MYRAG_INTERNAL_API_KEY` check (L22-28, `[Internal RAG]` prefix). It additionally requires `x-rag-scope-token`, and returns 401 on a bad token and a structured 503 on `error`.
- Remove the `userId` body trust at L35-59 and the global fallback.
- `livekit/token` currently trusts `searchParams.get('username')` (L9) and passes it as `identity`. Replace that with a server-derived `user-<uid>-<random>`, a fixed room, and the minted voice token in participant metadata.
- Media routes: replace `supabaseAdmin.rpc('match_document_chunks', …)` (image L273, video L230) with `runRetrieval({ scope, profile: 'media', … })`.
- The eval route keeps `checkEvalAccess`, mints its scope via `evalScope()`, and accepts `degrade: 'drop_top_candidate'` (eval-only).

---

### `scripts/ci/check-rag-boundary.mjs` + self-test

**Analog:** `scripts/check-config.mjs`
```javascript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);
function walkSrc(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    ...
```
- The script sits one level deeper (`scripts/ci/`), so the root is `'..', '..'`.
- Export the rule list as constants, as `TRACKED` is exported.
- Accept a `--root` argument so the self-test can point it at a temp dir. Rules come from RESEARCH §"Boundary Check". `scripts/rag/reprocess-documents.js` is an allow-listed ingestion script.

Self-test analog: `scripts/tests/gen-zod.node-test.mjs` (`node:test`, `assert/strict`, `fs.mkdtempSync(path.join(os.tmpdir(), …))`, `spawnSync(process.execPath, [SCRIPT, …], { cwd: ROOT, encoding: 'utf8' })`).

Wire it into `pr-smoke.yml` job `ts` next to `- name: Config drift check`. Add the self-test to the `node --test` line. If it becomes a new job, update `PR_JOBS` in `scripts/ci/check-workflows.py` L20.

---

### Eval gate and contracts

- **Pydantic** (`rag-sidecar/src/rag_sidecar/contracts/golden.py`): extend the `Literal` aliases in place:
  - `Category = Literal[..., "colloquial", "ambiguous", "typo"]`
  - `Provenance = Literal[..., "production"]`

  New models subclass `_Contract` (`ConfigDict(extra="forbid", frozen=True)`). After the change, run `npm run gen:schemas` and commit `rag-sidecar/schemas`, `src/lib/rag-eval/contracts.generated.ts` and `tests/fixtures/contracts/samples.json`; the schema-parity job diffs exactly these files.
- **gate.py**: keep the exit codes `EXIT_PASS=0, EXIT_MISMATCH=2, EXIT_REGRESSION=10, EXIT_INTERNAL=70`. Ignore `degrade` in the options-identity comparison the same way `max_results` is ignored. Add a test in `eval/tests/test_gate.py`, whose helpers `_slice_values` and `NOISE_PATH` (L1-20) you reuse.
- **New CLIs** (`paired.py`, `review_queue.py`, `online_judge.py`): copy the `baseline.py` shape (`def main(argv: list[str] | None = None) -> int`, argparse, `resolve_cli_path` from `rag_eval.paths`). Bootstrap uses a fixed seed. The online judge prints the `SKIP_NOTICE`-style `::notice::` line when keys are missing (`check-workflows.py` L25).
- **`eval/config/latency-budgets.json`**: copy the format of `noise.json` and validate it with a Pydantic `LatencyBudgets`.

---

### Type-error fix areas (D-15)

| Area | Files | Pattern to apply |
|---|---|---|
| TS-A config | `tsconfig.json`, CI | exclude `voice-agent`, `baileys-whatsapp`; add `allowImportingTsExtensions` (copy from `tsconfig.typecheck-new.json`); CI `npx next typegen && npx tsc --noEmit` |
| ratchet | `scripts/typecheck-new.mjs` | extend `PHASE1_PATHS` with `src/lib/rag/` + rewritten routes; reuse `filterDiagnostics` regexes `DIAGNOSTIC`/`GLOBAL_DIAGNOSTIC` for a per-file count baseline; self-test in `scripts/typecheck-new.test.mjs` |
| catch `unknown` | all | `err instanceof Error ? err.message : String(err)` |
| globalThis indexing | lib | one `declare global` block |
| custom stream chunks | chat route L4323/4327 | single helper `as unknown as UIMessageChunk` with a one-line reason comment |
| AI SDK v6 drift | chat route L4002-4258, `chat/approve/route.ts`, `src/lib/mcp/*` | `args→input`, `result→output`, `experimental_providerMetadata→providerMetadata`, `CoreTool→Tool`; each listed as an intended behaviour change |
| async params | `folders/[id]`, `mcp/servers/[id]`, `organizations/[id]/*`, `invites/[token]`, `config/system-prompts/[lang]` | `{ params }: { params: Promise<{ id: string }> }` then `const { id } = await params` |
| TS2304 ReferenceErrors | `approve/route.ts:2981`, `whatsapp/connect:53`, `whatsapp/conversations:123`, `streaming-markdown.tsx:38`, `universal-discovery.ts:289`, `semantic-chunker.ts:314+` | fix to intended behaviour, with a test per fix; `semantic-chunker` touches ingestion (note for Phase 3) |
| final flip | `next.config.js` | `typescript.ignoreBuildErrors: false` in its own last plan |

## Shared Patterns

### Validation and errors
**Source:** `src/lib/api-middleware.ts` (`validateRequest`, `withValidation`). **Apply to:** all rewritten routes.

Use `z` from `zod/v3`. A 400 has the shape `{ success: false, error, details: [{ path, message }] }`. Other errors use `NextResponse.json({ error }, { status })`. Streams use `formatErrorSSE`.

### Logging prefixes
`[Document Search]` (retrieval, required), `[RAG Trace]`, `[RAG Tenant]`, `[RAG Config]`, `[RAG Eval]`, `[Internal RAG]`. Pass structured objects as the second argument. Never log secret values or query/chunk text; log presence or booleans only.

### Env and five-place sync
Add every new var to `scripts/init-env.js`, `src/lib/env.ts` (`NAME: process.env.NAME || '<default>'`, next to L165-169), `scripts/config-server.js`, `scripts/config-ui/index.html` and `.env.local`. Mark it `"status": "managed"` in `scripts/rag/env-manifest.json`. `node scripts/check-config.mjs` enforces this. Note that its `NAME_PATTERN` (`RAG_*|LLAMACLOUD_*|OPENAI_EMBEDDING_MODEL`) does not cover `LANGFUSE_*`, so extend it and its self-test (`scripts/check-config.test.mjs`). Secrets get placeholder values only.

### Tests
- TS unit and route tests: vitest, files `tests/**/*.test.ts` (`vitest.config.ts`; the `@` alias and `tests/setup-env.ts` are already configured). Mock modules with `vi.hoisted` + `vi.mock` as in `tests/chat-strict.test.ts`. Save and restore env vars through an `ENV_NAMES` list, as in `tests/eval-route-auth.test.ts`.
- `.mts` harness tests: `node --import tsx --test`.
- Script self-tests: `node --test`.
- Python: pytest under `eval/tests/`.
- Multi-tenant tests use two tenants (personal and org), a non-member and a forged token.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/lib/rag/pipeline.ts` | service | AbortSignal stage runner | no staged pipeline exists; RESEARCH Pattern 2 |
| `src/lib/rag/trace/langfuse.ts` | service | OTLP export | no OpenTelemetry in repo; RESEARCH Pattern 3 |
| `src/lib/rag/trace/sample.ts` / `after()` wrapper | utility | event | RESEARCH Pattern 4 |
| `tests/rag/tenant-brand.test-d.ts` | type test | n/a | no `@ts-expect-error` type tests exist yet |

## Metadata

**Analog search scope:** `src/lib/rag-eval/`, `src/app/api/{chat,embed,internal,livekit,generate-*}`, `src/lib/{auth,env,error-stream,enhanced-rag-retrieval}.ts`, `scripts/`, `scripts/ci/`, `scripts/tests/`, `eval/`, `rag-sidecar/src/rag_sidecar/contracts/`, `tests/`, `.github/workflows/`
**Pattern extraction date:** 2026-11-23
