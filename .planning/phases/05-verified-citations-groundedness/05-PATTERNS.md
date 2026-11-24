# Phase 5: Verified Citations & Groundedness - Pattern Map

**Mapped:** 2026-11-24
**Files analyzed:** 27 new or modified (grouped below)
**Analogs found:** 24 / 27 (all paths are git-tracked source; no `.gsd` mirrors)

Phase 3, 3.1 and 4 are planned but only partly executed. Where the analog exists only in a plan, the plan is cited as `PLAN:` and the planner should treat that plan's file as the precedent, sequencing after it or copying the pattern directly.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `rag-sidecar/src/rag_sidecar/contracts/citations.py` (CitationRecord, AnswerRecord, GroundednessRequest/Result, FeedbackRequest) | model (Pydantic contract) | transform | `rag-sidecar/src/rag_sidecar/contracts/review.py` | exact |
| `rag-sidecar/src/rag_sidecar/contracts/__init__.py` | config (barrel) | n/a | itself | exact |
| `rag-sidecar/src/rag_sidecar/export_schemas.py` (add to `CONTRACTS`) | config | batch | itself, lines 37-57 | exact |
| `rag-sidecar/src/rag_sidecar/contracts/samples.py` | test fixture | transform | itself | exact |
| `rag-sidecar/schemas/*.schema.json`, `src/lib/rag-eval/contracts.generated.ts` | generated | n/a | `npm run gen:schemas` (package.json:19) | exact |
| `rag-sidecar/src/rag_sidecar/groundedness/{router,scorer,vectara,local_hhem}.py` | controller + service | request-response | `rag-sidecar/src/rag_sidecar/main.py` (v1 router); PLAN: 03-27 docling parse endpoint | role-match |
| `rag-sidecar/src/rag_sidecar/main.py` (include groundedness router) | config | request-response | itself, lines 27-37 | exact |
| `rag-sidecar/src/rag_sidecar/settings.py` (groundedness backend, Vectara key) | config | n/a | itself, lines 6-36 | exact |
| `rag-sidecar/Dockerfile` (`hhem` target) | config | n/a | PLAN: 03-05 (`docling` named target, slim default last stage) | exact (planned) |
| `rag-sidecar/pyproject.toml` (`hhem` extra) | config | n/a | PLAN: 03-05 (`chunking`/`docling` extras, pytorch-cpu index) | exact (planned) |
| `rag-sidecar/tests/test_groundedness.py` | test | request-response | `rag-sidecar/tests/test_auth.py`, `test_review_contract.py` | role-match |
| `src/lib/rag/generation/citations/blocks.ts` | utility | transform | `src/lib/rag/context/assemble.ts` | role-match |
| `src/lib/rag/generation/citations/strategy.ts` | service (selector) | request-response | `src/lib/rag/trace/config.ts` (env-at-call-time reader) | partial |
| `src/lib/rag/generation/citations/marker-parser.ts` | utility (pure) | streaming | none | no analog |
| `src/lib/rag/generation/citations/transforms.ts` | middleware (StreamTextTransform) | streaming | `src/app/api/chat/route.ts:3930-3975` (stream wrapping) | partial |
| `src/lib/rag/generation/citations/claude.ts` | service (provider) | streaming | `src/app/api/chat/route.ts:3423-3480, 3543` (OpenRouter streamParams) | partial; do not copy Sonnet branch |
| `src/lib/rag/generation/citations/record.ts` | utility | transform | `src/lib/rag/trace/mask.ts` / `collector.ts` | partial |
| `src/lib/rag/generation/citations/instructions.ts` | utility (i18n strings) | transform | `src/lib/rag/generation/messages.ts` | exact |
| `src/lib/rag/generation/prompt.ts` (cite instruction, keep `{{context}}`) | utility | transform | itself | exact |
| `src/lib/rag/generation/groundedness.ts` (sidecar client, eligibility) | service | request-response | PLAN: 03-27 `src/lib/rag/ingest/parsers/sidecar-docling.ts`; header auth from `rag-sidecar/src/rag_sidecar/auth.py` | role-match (planned) |
| `src/lib/rag/generation/feedback.ts` (Langfuse scores POST) | service | request-response | `eval/src/rag_eval/langfuse_api.py` + `online_judge.py:96-108` (Python) ; config from `src/lib/rag/trace/config.ts` | partial (cross-language) |
| `src/app/api/chat/route.ts` (strategy wiring, Claude path, fallback, `answerId` metadata, post-stream scheduling) | controller | streaming | itself, lines 1162-1167, 3930-3975 | exact |
| `src/app/api/rag/answers/route.ts` (`?chatId=`), `[answerId]/route.ts` | controller | CRUD read | `src/app/api/chats/share/route.ts:7-66` | role-match |
| `src/app/api/rag/answers/[answerId]/feedback/route.ts` | controller | request-response | `src/app/api/chats/share/route.ts` + `src/lib/api-middleware.ts` (`validateRequest`) | role-match |
| `supabase/migrations/05xx_rag_answer_records{.sql,.single-tenant.sql,.multi-tenant.sql}` | migration | CRUD | PLAN: 03-01 (migrations layout, generated `tenant_key`), PLAN: 04-07 (`0405_document_parents_rls.*` split RLS); live RLS idiom `supabase/multi-tenant-setup.sql:1497-1513, 1776-1810` | exact (planned) |
| `src/types/chat.ts` (carry `answerId` alongside `ragTraceId`) | model (conversion) | transform | itself, lines 177, 212-247, 369-389 | exact |
| badge UI in `src/components/ui/chat-message.tsx` (+ citation popover component) | component | event-driven (poll) | `src/components/ui/sources-button.tsx`, `src/components/providers/sources-provider.tsx` | role-match |
| config five-place sync (`src/lib/env.ts`, `scripts/init-env.js`, `scripts/config-server.js`, `scripts/config-ui/index.html`, `scripts/rag/env-manifest.json`) | config | n/a | existing `RAG_SIDECAR_*` / `LANGFUSE_*` entries | exact |
| `eval/src/rag_eval/metrics.py` (+ citation metrics), `eval/config/groundedness-thresholds.json` | utility | batch | `eval/src/rag_eval/metrics.py:57-100`; `eval/config/latency-budgets.json` | exact |
| tests `tests/rag/citations-*.test.ts`, route tests | test | streaming | `tests/helpers/chat-route-fakes.ts`, `tests/rag/chat-trace-flush.test.ts`, `tests/rag-langfuse-review.test.mts` | role-match |

## Pattern Assignments

### `rag-sidecar/src/rag_sidecar/contracts/citations.py` (Pydantic contract)

**Analog:** `rag-sidecar/src/rag_sidecar/contracts/review.py` lines 1-20

```python
from pydantic import BaseModel, ConfigDict, Field
from rag_sidecar.contracts.golden import Language

class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

class ReviewQueueItem(_Contract):
    trace_id: str = Field(min_length=1)
    ...
    tags: list[str] = Field(default_factory=list)
```
- `extra="forbid"` is what produces `.strict()` in generated Zod. Use `Literal[...]` for labels (`grounded|ungrounded|uncertain|pending|unavailable|expired`) and strategy (`claude_citations|chunk_alias`); they become `z.enum`.
- Add `schema_version: Literal[1] = 1` like `Baseline`/`EvalReport` (visible in `contracts.generated.ts`).
- Naming (RESEARCH P-14): avoid a name collision with existing contracts listed in `export_schemas.py:9-29`.

### `rag-sidecar/src/rag_sidecar/export_schemas.py`

**Analog:** itself, lines 9-57. Import new models into the `from rag_sidecar.contracts import (...)` block and append to `CONTRACTS`:
```python
CONTRACTS: list[tuple[type[BaseModel], Mode]] = [
    (ConversationTurn, "validation"),   # request bodies -> "validation"
    (RagTrace, "serialization"),        # responses/records -> "serialization"
    ...
]
```
Requests (`GroundednessRequest`, feedback body) use `"validation"`; `CitationRecord`, `GroundednessResult`, answer record use `"serialization"`. Add samples in `contracts/samples.py` (`build_samples`, written to `tests/fixtures/contracts/samples.json`). Regenerate with `npm run gen:schemas` (package.json:19 runs `export_schemas` then `scripts/gen-zod.mjs`); output header in `src/lib/rag-eval/contracts.generated.ts:1-2` (`import { z } from 'zod/v3'`). Never hand-edit the generated file.

### `rag-sidecar/src/rag_sidecar/groundedness/router.py` + `main.py`

**Analog:** `rag-sidecar/src/rag_sidecar/main.py` lines 11-41
```python
def create_app(settings: SidecarSettings | None = None) -> FastAPI:
    resolved = settings if settings is not None else load_settings()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(SharedSecretMiddleware, settings=resolved)
    ...
    v1 = APIRouter(prefix="/v1")

    @v1.get("/info", response_model=SidecarInfo)
    def info() -> SidecarInfo: ...
    app.include_router(v1)
```
- Add `POST /v1/groundedness` with `response_model=GroundednessResult`. Expose as `build_groundedness_router(resolved)` and `v1.include_router(...)` so settings stay injected (testable via `create_app(settings=...)`).
- Auth is automatic: every non-probe path goes through `SharedSecretMiddleware` (`auth.py:17-46`, header `x-sidecar-secret`, 401/503 bodies as `SidecarError`). Do not add per-route auth.
- Non-200 failure: copy `ready()` shape, `JSONResponse(status_code=503, content=SidecarError(...).model_dump(mode="json"))` (main.py:21-25) when the backend is unavailable, so the TS client maps to `unavailable`.
- Local HHEM: lazy-load the model once (module singleton) and only import torch/transformers inside `local_hhem.py` so the slim image never imports them (RESEARCH P-9, P-10).

### `rag-sidecar/src/rag_sidecar/settings.py`

**Analog:** itself lines 6-36: plain `BaseModel(frozen=True)`, `SecretStr` for keys, `load_settings()` reads `os.environ`. Add `groundedness_backend: Literal["off","vectara","local_hhem"]` and `vectara_api_key: SecretStr | None`, read in `load_settings()` exactly like `SECRET_ENV_VAR`.

### `rag-sidecar/Dockerfile` (`hhem` target) and `pyproject.toml` (`hhem` extra)

**Current file:** `rag-sidecar/Dockerfile` lines 1-34 (single stage, uv `sync --locked --no-dev`, uid 10001, `/health` HEALTHCHECK).
**Planned analog:** PLAN `03-unified-ingestion-embedding-profiles/03-05-PLAN.md` lines 26-38, 93: the default build is the last, slim stage; a named `docling` target runs `uv sync --locked --no-dev --extra docling` and bakes model files with `HF_HOME` set at build time; torch from `[[tool.uv.index]] pytorch-cpu (explicit = true)`. Copy it for an `hhem` target (`--extra hhem`, bake the HHEM repo plus the `flan-t5-base` tokenizer repo it loads at construction, P-9). If 03-05 has not run yet, this plan has to introduce the multi-stage layout itself; keep the existing stage last.

### `src/lib/rag/generation/groundedness.ts` (sidecar HTTP client)

**Planned analog:** PLAN `03-27-PLAN.md` → `src/lib/rag/ingest/parsers/sidecar-docling.ts` (first TS client of the sidecar). Header and secret: `x-sidecar-secret` (`auth.py:10`), env `RAG_SIDECAR_URL`/`RAG_SIDECAR_SECRET` (`src/lib/env.ts:169-170`).
**Access-check idiom (existing TS):** `src/lib/rag-eval/auth.ts:1-30` (min secret length 32, sha256 compare). Parse responses with the generated `GroundednessResultSchema.safeParse`, map any failure/timeout to `unavailable`; never throw into the route.

### `src/lib/rag/generation/feedback.ts` (Langfuse scores)

No TS scores client exists (RESEARCH P-11). Copy from Python:
- `eval/src/rag_eval/langfuse_api.py:12` `SCORES_PATH = "/api/public/scores"`; treat 202/207 as accepted.
- Payload from `eval/src/rag_eval/online_judge.py:96-108`:
```python
{"id": _score_id(item.trace_id, metric, chosen.judge_model), "traceId": ..., "name": metric,
 "value": value, "dataType": "NUMERIC", "timestamp": ..., "comment": "online judge", "metadata": {...}}
```
Deterministic id = sha256(`traceId|user_feedback`) (Pattern 8). Config via `readLangfuseConfig()` / `isLangfuseUsable()` (`src/lib/rag/trace/config.ts:23-38`); Basic auth with public/secret key; run inside `scheduleAfterResponse`. Mask comments with `maskPII` (`src/lib/rag/trace/mask.ts`). Review tagging precedent: `REVIEW_TAG` in `src/lib/rag/trace/langfuse.ts:15, 120` (P-12: tags on already-exported traces need a score/metadata, not a re-export).

### `src/lib/rag/generation/citations/instructions.ts`

**Analog:** `src/lib/rag/generation/messages.ts` lines 1-12 (localized record + own-property lookup, `en` fallback):
```ts
const UNAVAILABLE_MESSAGES: Record<string, string> = { en: '...', zh: '...', it: '...', es: '...' };
export function knowledgeBaseUnavailableMessage(language: string): string {
  return Object.prototype.hasOwnProperty.call(UNAVAILABLE_MESSAGES, language) ? UNAVAILABLE_MESSAGES[language] : UNAVAILABLE_MESSAGES.en;
}
```

### `src/lib/rag/generation/prompt.ts`

**Analog:** itself lines 3-21. Replacement uses function form `.replace('{{context}}', () => context)` to avoid `$` expansion; keep it. Append the cite instruction to the labelled context (or to `cleanedBasePrompt`) without removing `{{context}}` from `RAG_SYSTEM_PROMPT` (P-13). `bypass` mode gets no instruction.

### `src/lib/rag/generation/citations/blocks.ts`

**Analog:** `src/lib/rag/context/assemble.ts` (produces the context string from ranked rows today). Build `ContextBlock[]` first, then derive the labelled string, the alias map and Claude file parts from the same array (Pattern 1). Claude file part `data` must be `new TextEncoder().encode(text)`, never a string (P-1).

### `src/lib/rag/generation/citations/transforms.ts`, `claude.ts`

**Analog for stream plumbing:** `src/app/api/chat/route.ts` lines 3930-3975:
```ts
const stream = createUIMessageStream({
  execute: async ({ writer }) => {
    if (precomputedSourceImages.length > 0) { writeCustomChunk(writer, { type: 'source_images', ... }); writeCustomChunk(writer, { type: 'metadata', usedDocuments: ... }); }
    writer.merge(result.toUIMessageStream({
      sendStart: precomputedSourceImages.length === 0,
      messageMetadata: ({ part }) => {
        if (part.type === 'start') return ragTraceId ? { ragTraceId } : undefined;
        ...
        if (part.type !== 'finish') return undefined;
        return { ...(ragTraceId ? { ragTraceId } : {}), ...finishMetadata };
      },
    }));
  },
  onFinish: ({ isAborted, finishReason }) => { ...collector.record({ name: 'generation', ... }); finishRagTrace(); },
});
```
- Add `answerId` next to `ragTraceId` in both the `start` and `finish` metadata. Emit `start` once even when the Claude path falls back (Pattern 5).
- Transforms attach via `streamText({ experimental_transform: [...] })` (not used anywhere in the repo yet). Transform skeleton is RESEARCH Pattern 4. Route tests cannot see transforms through the fakes (P-2), so unit-test transforms directly with `ai/test` stream helpers.
- Claude path: new `createAnthropic({ baseURL, apiKey })` in `claude.ts`; do not reuse the OpenRouter `streamParams` and especially not the `isClaudeSonnet4` branch (route.ts:3423-3480, 3923). `maxRetries: 0`, no `temperature`, no `responseFormat`. Treat `ANTHROPIC_BASE_URL=''` as unset (P-3).
- `source_images` and `metadata` writes above must keep working on both strategies (AGENTS.md section 14).

### `src/lib/rag/generation/citations/record.ts` + post-stream scheduling in route

**Scheduling analog:** `src/lib/rag/trace/schedule.ts` lines 1-17 (`after()` with detached fallback, swallows errors). Insert the `pending` row and call the sidecar inside one scheduled task (Pattern 7). Trace hand-off precedent: `finishRagTrace` at `route.ts:1162-1167` (null the handle before finishing so it runs once); do the same for the answer-record task.
**Hash/mask:** `node:crypto` sha256 as in `src/lib/rag-eval/auth.ts:14-16`; masking via `src/lib/rag/trace/mask.ts`.

### `src/app/api/rag/answers/**/route.ts`

**Analog:** `src/app/api/chats/share/route.ts` lines 7-66:
```ts
const authHeader = request.headers.get('authorization');
if (!authHeader?.startsWith('Bearer ')) return NextResponse.json({ error: 'Missing or invalid authorization header' }, { status: 401 });
const supabaseClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: authHeader } } });
const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const { data: chat, error: chatError } = await supabaseClient.from('chats').select('*').eq('id', chatId).eq('user_id', user.id).single();
if (chatError || !chat) return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
```
- Read `rag_answer_records` with the user-token client so RLS (`user_id = auth.uid()`) is the enforcement; return 404 (not 403) for missing or foreign rows, which the client poll treats as "not yet" (P-4). Apply the 120 s `expired` read rule (D-15) at read time.
- Tenant scoping helpers if a service-role read is ever needed: `src/lib/rag/tenant/resolve-chat.ts`, `scope.ts`.
- Feedback POST: validate with `validateRequest(req, FeedbackRequestSchema)` from `src/lib/api-middleware.ts` using the generated Zod schema (400 `{ success:false, error, details }`). Add `export const runtime = 'nodejs'`.
- Route test fixtures: `tests/helpers/route-fixture.ts`, `tests/helpers/chat-route-fakes.ts` (`FAKE_USER_ID`, table-keyed fake store).

### `supabase/migrations/05xx_rag_answer_records*.sql`

**Planned analogs:** PLAN `03-01-PLAN.md` lines 7-48 (layout `supabase/migrations/NNNN_name.sql` + `.single-tenant.sql` / `.multi-tenant.sql`, applied by `eval/harness/migrations.mts`, `scripts/setup-database.sh`, CI in name order; generated `tenant_key` column expression on documents) and PLAN `04-07` (`0405_document_parents_rls.{single,multi}-tenant.sql`: split RLS per mode).
**Live idioms:** `supabase/multi-tenant-setup.sql:1497-1513` (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`), `:1776-1786` (`CREATE POLICY "Users can view chats" ON chats FOR SELECT USING (user_id = auth.uid() ...)`), `:791` (`REVOKE ... FROM PUBLIC, anon, authenticated`); single-tenant `supabase/single-tenant-setup.sql:895-916` uses `DROP POLICY IF EXISTS` before each `CREATE POLICY`.
Table per Pattern 6: generated `tenant_key` copying Phase 3's expression verbatim, FK `chat_id → chats(id) ON DELETE CASCADE`, `REVOKE ALL FROM anon`, SELECT-only policy for `authenticated`, indexes `(chat_id)`, `(user_id, created_at)`. Shared-chat policy must not be extended to this table. Also add the table to the PGlite schema tests (`tests/rag-db/schema-*.test.mts` per 03-01).

### `src/types/chat.ts`

**Analog:** itself. `DBMessage.metadata?: { ragTraceId: string }` (line 177), `ragTraceIdOf` (212-215), `toDBMessages` (217-231), `toExtendedMessage` (234-249), `buildMetadata` (369-389). Add `answerId` with an `answerIdOf` twin and thread it through `toDBMessages` **and** `toExtendedMessage` (P-5: the latter also drops unknown metadata). Strip `[S…]` markers from prior assistant turns in `toAPIMessage` (188) before sending history (P-7). Regression test: `tests/chat-messages-roundtrip.test.ts`.

### Badge UI (`src/components/ui/chat-message.tsx` + new `citation-badge.tsx`)

**Analog:** `src/components/ui/sources-button.tsx` lines 5-34 (reads `useSources()` from `src/components/providers/sources-provider.tsx`, filters by `source.type`). Follow repo conventions: kebab-case file, named `export function`, `cn()` from `src/lib/utils.ts`, `lucide-react` icons, no unconditional `console.log` (sources-button line 25 is the anti-example). Poll `/api/rag/answers/[answerId]` with 404 = pending for ~30 s; strings localized like `messages.ts`.

### Config sync

**Analog:** existing sidecar/Langfuse vars:
- `src/lib/env.ts:169-185` (`NAME: process.env.NAME || '<default>'`)
- `scripts/init-env.js:334-369` (commented section header, `NAME=default`)
- `scripts/config-server.js:218` (secret-masking name list; add new secrets like `VECTARA_API_KEY`, `ANTHROPIC_API_KEY` there) and `:546-561` (template lines `${fullValues.X !== undefined ? `X=${fullValues.X}` : 'X=default'}`)
- `scripts/config-ui/index.html` (Feature Toggles / RAG section; Claude model ids also go into the three fallback arrays per AGENTS.md section 7)
- `scripts/rag/env-manifest.json` (`{ "name", "status": "managed", "knownGaps": [] }`, alphabetical)
Read toggles at call time like `readLangfuseConfig(source = process.env)` (`src/lib/rag/trace/config.ts:23`), not cached at module load.

### Eval citation metrics

**Analog:** `eval/src/rag_eval/metrics.py` lines 24-100 (`score_items` per item, `_mean` → `MetricValue{n,value}`, `_slice`, `_group`, `aggregate`). Add citation precision/coverage and groundedness rate as new `MetricValue` fields; extend the Pydantic report contract (`contracts/report.py`) and regenerate. Thresholds file follows `eval/config/latency-budgets.json` with a `contracts/latency.py`-style model (`LatencyBudgets` is in `CONTRACTS`).

## Shared Patterns

### Sidecar auth
**Source:** `rag-sidecar/src/rag_sidecar/auth.py:9-46`. **Apply to:** all new sidecar routes (automatic) and the TS client (send `x-sidecar-secret`).

### Contract pipeline (Pydantic → JSON Schema → Zod)
**Source:** `export_schemas.py:37-57`, `package.json:19`, `src/lib/rag-eval/contracts.generated.ts`. **Apply to:** every structured payload in this phase. CI consistency test precedent: `rag-sidecar/tests/test_contract_export.py`.

### Post-response work
**Source:** `src/lib/rag/trace/schedule.ts:4-17`. **Apply to:** answer-record insert, groundedness call, feedback scores.

### API errors and validation
**Source:** `src/lib/api-middleware.ts` (`validateRequest`/`withValidation`, `z` from `zod/v3`), `NextResponse.json({ error }, { status })`. Streaming errors: `formatErrorSSE` in `src/lib/error-stream.ts`.

### Logging
Bracketed prefix (`[Citations]`, `[Groundedness]`), structured second arg, never key values (CLAUDE.md conventions).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/lib/rag/generation/citations/marker-parser.ts` | utility | streaming | No incremental stream parser exists; use RESEARCH Pattern 2 (pure, split-safe, no AI SDK imports) |
| `experimental_transform` usage | middleware | streaming | Not used anywhere; RESEARCH Pattern 4 + `ai` `TextStreamPart` types |
| `@ai-sdk/anthropic` provider setup | service | streaming | Package not yet used in `src/`; RESEARCH Pattern 3 and "Claude call skeleton" |

## Metadata

**Analog search scope:** `rag-sidecar/`, `src/lib/rag/**`, `src/lib/rag-eval/`, `src/app/api/{chat,chats}/`, `src/types/`, `src/components/ui/`, `supabase/`, `scripts/`, `eval/src/rag_eval/`, `tests/`, Phase 03/04 PLAN files
**Files scanned:** ~45
**Pattern extraction date:** 2026-11-24
