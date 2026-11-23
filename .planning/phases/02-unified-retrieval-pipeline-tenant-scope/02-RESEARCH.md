# Phase 2: Unified Retrieval Pipeline & Tenant Scope - Research

**Researched:** 2026-11-23
**Domain:** Retrieval refactor of a Next.js 16 / Supabase RAG app into one tenant-scoped pipeline, plus Langfuse (OTel) tracing, eval-harness extensions and a full-repo type-error cleanup
**Confidence:** HIGH for code-grounded findings (every call site, SQL predicate and package API below was read this session); MEDIUM for Langfuse Cloud behaviour (docs + OpenAPI spec, not exercised against the live service); LOW items are listed in the Assumptions Log

<user_constraints>
## User Constraints (from CONTEXT.md)

The block below is copied verbatim from `02-CONTEXT.md` lines 26-74 (commit 95f7e83, which carries the revised D-15).

### Locked Decisions

### Pipeline shape and switches
- **D-01:** `src/lib/rag/` exposes one public entry, `runRetrieval({ scope, query, profile, documentRefs?, options?, signal, trace })`, where `profile` is `chat | embed | voice | media | eval`. It returns a `RetrievalResult` carrying `status`, candidates, the assembled context, used documents, `sourceImages`, links and per-stage records. Entry routes only call the public index (`@/lib/rag`): resolve a scope, call `runRetrieval`, render for their transport — **Reversibility:** costly — every entry point and every later phase builds on this signature
- **D-02:** `RAG_PIPELINE=legacy|v2`, default `legacy`. Phase 2 implements only `legacy`: today's `enhancedRetrieveChunks` algorithm (strategy switch, thresholds, boosts, lower-threshold retry) re-homed under `src/lib/rag/legacy/` with identical behavior. `v2` is reserved for Phase 4; an unknown or unimplemented value logs once and runs `legacy`
- **D-03:** Stage runner: each stage is `{ name, enabled, timeoutMs, onFail: 'skip' | 'throw' }`. Phase 2 stages: `analyze`, `embed`, `search`, `legacy_rank`, `post_filter`, `assemble`; the voice profile adds `voice_keyword_fallback` and `local_rerank` (today's `hybridRerank`). Core stages (`embed`, `search`) throw; optional stages skip. The request's `AbortSignal` flows into every stage, into `fetch` calls and into Supabase queries (`.abortSignal()`)
- **D-04:** Stage switches and timeouts: `RAG_DISABLED_STAGES` (comma list; only optional stages may be listed, a core stage there is rejected at config load and logged) and `RAG_STAGE_TIMEOUTS` (`stage=ms` list) override per-profile defaults kept in code. Per-request overrides exist only on the authenticated eval endpoint
- **D-05:** Status semantics: `empty` only when every core stage succeeded, no optional stage was skipped, and zero chunks survive; `error` when a core stage failed, timed out or was aborted; `degraded` when an optional stage was skipped (with or without results). `degraded` with zero results is not `empty` — **Reversibility:** costly — the strict-refusal contract and later phases' refusal logic depend on it
- **D-06:** Status mapping per entry point: chat keeps its strict refusal ("information not available") only for `status === 'empty'` plus the existing conditions (strict mode, webSearch off, no used documents). `error` (and `degraded` with no results) becomes an in-band streamed error message (`formatErrorSSE` style, localized "the knowledge base is temporarily unavailable"), logged under `[Document Search]`; `degraded` with results answers normally and is flagged in the trace. Embed returns the same error message; voice-rag returns a structured 503 the agent turns into a spoken "I can't reach the knowledge base right now"

### Tenant scope
- **D-07:** Branded `TenantScope` (`kind: single | personal | org`, `userId`, `organizationId`, `tenantKey` = `s:default | u:<uuid> | o:<uuid>`), mintable only inside `src/lib/rag/tenant/`. Retrieval and backend functions accept only `TenantScope`; a type test (`@ts-expect-error` on a hand-built literal) and a runtime brand check enforce it. The tenant predicate reproduces `match_documents_by_workspace` semantics exactly — **Reversibility:** costly — every backend adapter, the sync worker (Phase 7) and the cache (Phase 6) take this type
- **D-08:** Chat `resolveTenantScope()`: single-tenant mode → `s:default` for any caller (today's behavior). Multi-tenant → the user comes only from the SSR session (`auth.getUser()`); a requested `organizationId` from the body is checked against `organization_members` for that verified user; a non-member gets HTTP 403 JSON before streaming (logged, no retrieval); no organization → personal `u:<uid>`; no session → no scope, and retrieval returns `empty` with reason `no_tenant` (today such requests retrieve nothing, so strict refusal behavior, including anonymous WhatsApp calls in multi-tenant mode, is preserved)
- **D-09:** Embed scope comes from server-side embed configuration: new env `RAG_EMBED_TENANT` (`s:default | o:<uuid> | u:<uuid>`). Single-tenant default `s:default`. Multi-tenant with it unset → embed retrieval fails closed (status `error`, reason `embed_tenant_unconfigured`, logged). A request body naming a workspace (`organizationId`, `workspaceId`, `tenant`) that differs from the configuration → 403. The configured organization is checked to exist when the scope is minted. Per-widget embed keys are deferred
- **D-10:** Voice scope comes from a signed, expiring voice RAG token minted by the app. `/api/livekit/token` resolves the scope the same way as chat (session plus verified organization from a query parameter), derives the LiveKit identity server-side (`user-<uid>-<random>`, the caller-supplied `username` is no longer trusted), and puts a token in the participant metadata: HMAC-SHA256 over compact JSON `{ v, tk, uid, oid, iat, exp, aud: 'voice-rag' }`, base64url, secret `RAG_VOICE_TOKEN_SECRET` (at least 32 chars, otherwise minting and verification refuse), TTL `RAG_VOICE_TOKEN_TTL_SECONDS` (default 3600). The voice agent forwards it as `x-rag-scope-token` to `/api/internal/voice-rag` and `/api/internal/voice-chat` (in addition to `x-api-key`). The routes verify signature (constant time), expiry and audience, re-check organization membership, then mint the scope. A missing, expired or forged token, or a bare `userId`, gets 401; the global `match_document_chunks` fallback is deleted — **Reversibility:** one-way — wire contract between the app and the separately deployed `voice-agent/`; both must ship together and old agents stop getting knowledge-base answers
- **D-11:** Tenant enforcement has no off switch (fail closed); the "behind a switch" rule does not apply to security checks. The eval endpoint keeps its Phase 1 auth and scope allow-list and mints its scope through a dedicated `evalScope()` function inside the tenant module
- **D-12:** Every other knowledge-base read goes through the pipeline with the caller's scope: `generate-image` and `generate-video` context lookups (today a global `match_document_chunks` with the admin client), the chat route's "general information overview" fallback, and `@mention` / explicit document-reference fetches. A referenced document outside the scope is ignored and logged, never read

### Consolidation and boundary
- **D-13:** Delete `retrieval-strategies.ts`, `optimized-search.ts`, `adaptive-retrieval.ts`, `reranker-adapter.ts`, and the modules that become unreferenced with them (`query-enhancer-local.ts`, `bm25-scorer.ts`, `mmr-scorer.ts`), the never-called `enhanceQueryWithReasoning` / `intelligentSearch` in `thinking-rag-enhancer.ts`, and `searchSimilarChunks` in `src/lib/supabase.ts` once no caller remains. Re-home: `enhancedRetrieveChunks` → `src/lib/rag/legacy/`; `temporal-query-detector.ts` → `src/lib/rag/query/`; `createEnhancedRAGPrompt` → `src/lib/rag/generation/prompt.ts`; `hybridRerank` → `src/lib/rag/rerank/local-hybrid.ts`; the OpenAI embedding call → `src/lib/rag/embeddings/openai.ts`, with `document-processor.ts` and the ingestion routes calling it through `@/lib/rag` until Phase 3 unifies ingestion. Deletions land in their own plan and commit, after extraction
- **D-14:** CI boundary check `scripts/ci/check-rag-boundary.mjs` (in the PR smoke workflow): outside `src/lib/rag/`, fail on `embeddings.create`, on `.rpc('match_` and other retrieval RPC names, on imports of retired or re-homed modules, on deep imports into `@/lib/rag/*` other than the public index, and on vector-store or reranker client packages. Tests and `eval/harness/` fakes are allow-listed by path. The check has its own self-test
- **D-15:** Type-checking for success criterion 1 (user decision 2026-11-23, replaces the earlier ratchet reading): the full `tsc --noEmit` over the whole app must reach **zero errors**. All ~312 legacy errors (mostly WhatsApp, MCP and UI code, 35 in `chat/route.ts`) are fixed in this phase, in dedicated plans grouped by area, each fix behaviour-preserving (type annotations, narrowing, correct imports; no `any`, no `@ts-ignore`/`@ts-expect-error` unless a comment states why it is unavoidable) and covered by the existing test suites. Until zero is reached, a per-file ratchet against a committed baseline stops regressions; once zero, CI runs plain `tsc --noEmit` and `next.config.js` sets `typescript.ignoreBuildErrors: false` so type errors fail the build. Type fixes in `chat/route.ts` and retrieval code must keep the characterization tests and the eval gate green. `baileys-whatsapp/` and `voice-agent/` have their own tsconfigs and are covered only if their type-checks are part of the main `tsc --noEmit`; record what was checked

### Context assembly
- **D-16:** One `assembleContext()` in `src/lib/rag/context/` reproduces the chat route's current post-filter and format (similarity > 0.65, document-name match, image > 0.25, the Chinese empty-term behavior, per-document grouping, source labels, links section via `url-extractor`, `source_images`). Chat output is canonical and must be byte-identical; embed uses the same function; voice gets the same assembled blocks and keeps its response shape `{ context, sources, source_images }`. Characterization tests capture embed and voice outputs on the fixture corpus before they switch, and any intended difference is listed in the plan summary. Voice's hard-coded keyword and image heuristics move into the voice-profile-only stage unchanged
- **D-17:** No N+1: after search, documents are fetched in one `in('id', [...])` query and chunk metadata in one `in('id', [...])` query, so the query count is fixed regardless of chunk count. A query-counting test on the fake PostgREST edge at 5, 25 and 100 chunks asserts a constant count. SQL RPCs are not changed in this phase. The eval route's `legacy-post-filter.ts` replica is replaced by the shared module, and its sentinel tests are retargeted at the new module

### Observability
- **D-18:** Langfuse through its OpenTelemetry SDK: `@langfuse/tracing` and `@langfuse/otel` (`LangfuseSpanProcessor`) 6.x on an isolated tracer provider that is not registered globally, with `@opentelemetry/sdk-trace-base` and `@opentelemetry/exporter-trace-otlp-http` pinned to versions the Langfuse peer ranges accept (researcher confirms exact pins). The legacy `/api/public/ingestion` endpoint is not used (Langfuse Cloud sunset it on 2026-11-16). Scores go to `POST /api/public/scores`. The flush runs in Next.js `after()`, so the response is never delayed; exporter errors are caught, time-boxed and fall back to the log line — **Reversibility:** costly — new runtime dependencies (Node >= 22) and an OTel provider in the request path
- **D-19:** New env: `LANGFUSE_ENABLED` (default `false`), `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (default `https://cloud.langfuse.com`), `LANGFUSE_SAMPLE_RATE` (default `0.1`, sized for the Hobby quota of 50k units a month), `LANGFUSE_CAPTURE_CONTENT` (default `false`; query and chunk text masked unless true). One trace per request tagged with `tenantKey`, one span per stage with `latency_ms`, `candidates_in`, `candidates_out`, `status` and `rules` (empty until Phase 6). Span names equal the eval trace `stage_latency_ms` keys. The trace ID is stored in the assistant message metadata
- **D-20:** One internal trace collector feeds both the eval trace (`stage_latency_ms`, stage statuses) and the Langfuse exporter. When Langfuse is off, unsampled or unreachable, a single structured `[RAG Trace]` log line per request carries the same fields (no query or chunk text). A fake Langfuse OTLP endpoint in tests asserts one trace with one span per stage and that the response completes before the export
- **D-21:** Latency budgets (starting values, ratified by the live measurement): text chat and embed retrieval before generation p50 <= 1000 ms, p95 <= 2000 ms (embed stage p95 <= 200 ms, search <= 400 ms, assemble <= 100 ms); voice retrieval p50 <= 400 ms, p95 <= 800 ms. They live in `eval/config/latency-budgets.json` (Pydantic `LatencyBudgets`) and in the docs. Eval reports show per-stage p50/p95 against them; in Phase 2 this is report-only, because fixture latencies are not representative

### Evaluation
- **D-22:** Legacy parity (success criterion 3) is proven first, on the unchanged Phase 1 golden set and baseline: the smoke tier through the new pipeline exits 0 at the gate, and the paired differences on every item are zero (the fixture is deterministic). Only after that are golden items added and the baseline re-recorded
- **D-23:** Paired differences: the baseline gains per-item rows (item id → metric values per run), and a new `rag_eval.paired` computes per-item paired differences, mean difference and a fixed-seed bootstrap 95% interval per gated slice, written into the gate report. The existing noise-band gate rule is kept; the paired report is attached to it
- **D-24:** Stronger negative control: an eval-only override `degrade: 'drop_top_candidate'` (accepted only by the eval endpoint) removes the best candidate before post-filtering. The CI negative control uses it and asserts exit 10 plus a margin of at least 0.05 below the threshold on overall MRR; the `max_results=1` case stays as a second, thin control
- **D-25:** EVAL-14: `Category` gains `colloquial`, `ambiguous`, `typo`; `Provenance` gains `production`. The fixture golden set gains at least two approved items per new category per language (synthetic, same quote rules). Reports add `by_provenance` and `by_provenance_category`. When approved `production` items exist in the gated split, the gate is computed on them only and every other provenance is report-only. The baseline is re-recorded after the additions, and paired differences on the pre-existing items must be zero — **Reversibility:** costly — persisted golden files and the baseline schema change
- **D-26:** EVAL-15: a separate sample `LANGFUSE_REVIEW_SAMPLE_RATE` (default `0`) marks requests whose query, answer and context are exported after server-side PII masking (e-mail, phone, ID-number, IBAN and card patterns), tagged `review_candidate` and with the `tenantKey`. `python -m rag_eval.review_queue pull` reads them through the Langfuse public API (`GET /api/public/v2/observations` by time window and tag) and writes Pydantic `ReviewQueueItem` JSONL to the gitignored `eval/golden/private/review-queue/`; `promote` turns an item into a draft `GoldenItem` with provenance `production`. `python -m rag_eval.online_judge` scores a sample (`online_judge.sample_rate` in `eval/config/judge.json`) with the pinned Phase 1 judge (faithfulness, answer relevance) and posts the scores to the trace. It runs in the nightly workflow and is skipped with a notice without keys. It is tested with a fake Langfuse endpoint and the stub judge

### Runtime and config
- **D-27:** Node.js 22: root `package.json` `engines.node` `>=22.12.0`, `.nvmrc` `22`, `voice-agent/Dockerfile` on `node:22-slim`, AGENTS.md / `.claude/CLAUDE.md` / README updated (this requirement is the explicit documentation request), and a CI step that fails when the runtime major is not 22 or `engines` is missing. `baileys-whatsapp/` stays on Node 20. The Vercel project's Node setting is a live verification item
- **D-28:** Every new env var (`RAG_PIPELINE`, `RAG_DISABLED_STAGES`, `RAG_STAGE_TIMEOUTS`, `RAG_EMBED_TENANT`, `RAG_VOICE_TOKEN_SECRET`, `RAG_VOICE_TOKEN_TTL_SECONDS`, the six `LANGFUSE_*` vars and `LANGFUSE_REVIEW_SAMPLE_RATE`) is mirrored in the five config locations and marked `managed` in `scripts/rag/env-manifest.json`; `RAG_FINAL_RESULT_COUNT` is added to `src/lib/env.ts` and read through `env` (Phase 1 note). Secrets get placeholder values only
- **D-29:** Rollout order inside the phase: characterization tests for embed and voice first; then the `src/lib/rag/` core; then one entry point per plan (eval route, chat, embed, voice, media routes); then deletions and the boundary check; then parity; then eval additions that change the golden set

### Claude's Discretion
- File layout inside `src/lib/rag/` beyond the paths named above.
- Exact PII masking patterns and the masked placeholder text.
- Span attribute names beyond the required fields; sampling RNG (deterministic hash of the request ID is acceptable).
- Wording of the localized "knowledge base temporarily unavailable" messages (zh/en/it, same mechanism as `buildNoKnowledgeBaseResponse`).


### Deferred Ideas (OUT OF SCOPE)
- Per-widget embed keys (several widgets per tenant, stored in a table) — new capability, later phase or backlog.
- WhatsApp tenancy in multi-tenant mode (scope from the session owner) — backlog; Phase 2 keeps today's empty retrieval for anonymous calls.
- Voice token refresh for sessions longer than the TTL — backlog.
- Removing voice's hard-coded keyword and image heuristics — after eval shows they are unnecessary (Phase 4 or later).
- Revoking the `anon` grants on legacy RPCs (`match_documents_by_workspace`) — tracked in `.planning/codebase/CONCERNS.md`, separate security work.
- Gating on latency budgets — later phases, on live measurements.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (short) | Research support |
|----|---------------------|------------------|
| PIPE-01 | `src/lib/rag/` is the only caller of embedding providers, retrieval backends, rerankers; chat, embed, voice call it | §Current call graph (every call site listed with line numbers), §Boundary check, §Migration order |
| PIPE-02 | Branded `TenantScope` minted only after server-side membership verification; body `organizationId` never trusted | §Tenant resolution (SQL predicate read from `multi-tenant-setup.sql:692-736`), §TenantScope pattern |
| PIPE-03 | Embed tenant from server-side config | §Embed scope; pitfall P-09 (embed widget ignores `type:'error'` SSE) |
| PIPE-04 | Voice tenant from a signed expiring token; no global fallback | §Voice token (LiveKit metadata API verified), §Voice one-way deploy risk list |
| PIPE-05 | One shared context assembly, no N+1 | §assembleContext byte-identity rules, §Query-counting test design |
| PIPE-06 | Discriminated status; only verified `empty` refuses | §Status derivation; pitfall P-04 (postgrest aborts resolve, they do not reject) |
| PIPE-07 | Per-stage switch, timeout, degrade-to-skip, AbortSignal everywhere | §Stage runner, §AbortSignal propagation |
| PIPE-08 | Unused retrieval modules removed; live logic re-homed | §Deletion inventory (Runtime State Inventory) |
| PIPE-09 | `RAG_PIPELINE=legacy` reproduces the baseline within noise | §Parity proof, §Paired bootstrap |
| PIPE-10 | Node 22 documented and enforced | §Node 22 enforcement — `engines: ">=22.12.0"` deploys Node 26 on Vercel (finding F-1) |
| OBS-01 | Langfuse trace per request, span per stage, async, sampled, masked, `[RAG Trace]` fallback | §Langfuse integration (package internals read), §Fake OTLP endpoint |
| OBS-02 | Latency budgets; per-stage p50/p95 in reports | §Latency report |
| EVAL-14 | `colloquial`/`ambiguous`/`typo` categories, provenance slices, gate on `production` | §Contract changes, §Golden additions |
| EVAL-15 | Review queue from Langfuse + online judge scores on traces | §Review queue / online judge; findings F-3, F-4 (Scores API is a batch array; WR-12 family guard) |
| SC1 (D-15) | Full `tsc --noEmit` reaches zero | §Type-error cleanup (312 errors broken down; +7 hidden route-type errors) |
</phase_requirements>

## Summary

The retrieval code that Phase 2 must unify is smaller than the module list suggests but more spread out. There is exactly one live retrieval algorithm (`enhancedRetrieveChunks`), called from three routes (chat, embed, eval). Five other code paths reach the vector store or embeddings directly: voice-rag (its own RPC calls, three unscoped `document_chunks` keyword queries and `hybridRerank`), the chat route's empty-query "general information overview" fallback, `generate-image`, `generate-video` and the chat `@mention`/document-reference lookups. Every one of those five is cross-tenant today in multi-tenant mode. Two are global through the admin client: `match_document_chunks` called with no `auth.uid()` returns *every personal document of every user* (`multi-tenant-setup.sql:781-790`). `@mention` resolves filenames across all tenants with `ilike` on the admin client. The voice keyword fallback also reads `document_chunks` with no tenant predicate at all, even when a `userId` is supplied. So the "move voice heuristics unchanged" part of D-16 cannot be literal. Those queries must gain the tenant predicate. That narrowing is a behaviour change and belongs in the plan summary.

Byte-identical chat context is achievable but only if the batched assembly preserves five order-dependent quirks of the current loop. Iteration follows the candidate order, not the order the `in()` lookup returns. A document that fails `.single()` is skipped. Chunk metadata is merged only when `image_url` is missing. Chunks are grouped by *filename* (two documents with the same filename merge). Explicitly referenced documents are pushed into `usedDocuments` before the semantic loop, so their chunks survive the relevance filter. The Phase 1 replica `legacy-post-filter.ts` encodes most of this but not document references, the full `UsedDocument` shape or `normalize()` on array content. The legacy algorithm must also keep the same Supabase clients: RPCs on the anon/browser client (`enhanced-rag-retrieval.ts:148,175`) and lookups on the admin client (`chat/route.ts:1213`). Swapping clients changes results under RLS.

Langfuse 6.1.1 works on an isolated provider without a context manager. `startObservation(name, attrs, { startTime, parentSpanContext })` and `observation.startObservation(...)` take explicit parents, and `.end(endTime)` takes explicit times (read from `@langfuse/tracing@6.1.1` dist). The cleanest design records stage timings in an in-process collector during the request. It then replays them into spans inside `after()` and calls `forceFlush()` with a time box, so the request path never touches the exporter. Four findings change locked details. (1) `engines.node: ">=22.12.0"` makes Vercel deploy **Node 26**, not 22 (Vercel's own mapping table). Use `^22.12.0`. (2) `POST /api/public/scores` now takes a **JSON array** and answers 202/207, and a 207 must not be retried (Langfuse OpenAPI spec). (3) The Phase 1 judge family guard refuses `openai/gpt-5-mini` for any production trace generated by an `openai/*` model. (4) `@opentelemetry/sdk-trace-base@2.12.0`, the npm `latest`, is deprecated. Pin `2.12.1`, the exporter at `0.223.2` and `@opentelemetry/api` at `1.9.0`. The `0.301.x` exporter line is outside Langfuse's peer range and needs Node >= 22.15.

**Primary recommendation:** Build `src/lib/rag/` around an injectable `RagDeps` (clients, embedder, clock, trace sink). Re-home `enhancedRetrieveChunks` verbatim except for error surfacing. Write `assembleContext()` from `legacy-post-filter.ts` plus the document-reference prefix, then prove byte-identity with a differential test against the old chat-route code before deleting it. Do tracing as after-the-fact span replay.

## Architectural Responsibility Map

| Capability | Primary tier | Secondary tier | Rationale |
|---|---|---|---|
| Tenant resolution (session, membership, embed config, voice token) | API / Backend (`src/lib/rag/tenant/`) | Database (`organization_members`, `organizations`) | Must use the server-verified SSR session and admin reads. The browser never supplies a trusted tenant |
| Retrieval stages (analyze, embed, search, legacy_rank, post_filter, assemble, voice stages) | API / Backend (`src/lib/rag/`) | Database (pgvector RPCs) | One pipeline; RPCs unchanged in this phase |
| Tenant predicate enforcement | API / Backend (backend adapter) | Database (RPC `p_org_id`/`p_user_id`) | Legacy RPCs are `SECURITY DEFINER` and granted to `anon`. The predicate must come from a minted scope, never from the caller |
| Voice token minting | API (`/api/livekit/token`) | — | Needs the SSR session; HMAC secret stays server-side |
| Voice token forwarding | Voice agent service (`voice-agent/`) | LiveKit participant metadata | The agent never sees the user's session, only the signed token |
| Context rendering per transport | API route adapters | — | Chat SSE system prompt, embed prompt, voice JSON |
| Trace collection | API / Backend (in-request collector) | — | Pure in-memory, no I/O on the request path |
| Trace export | API / Backend inside `after()` | Langfuse Cloud (OTLP) | After the response; time-boxed; log fallback |
| Review queue pull / promote, online judge | Offline Python (`eval/src/rag_eval/`) | Langfuse public API | Nightly CI only; never in the request path |
| Golden set, baseline, paired stats | Offline Python + committed JSON | — | Phase 1 contracts extended |

## Standard Stack

### Core (new runtime dependencies, root `package.json`)

| Library | Exact pin | Purpose | Evidence |
|---|---|---|---|
| `@langfuse/tracing` | `6.1.1` | `startObservation`, `setLangfuseTracerProvider` | `npm view`: published 2026-11-03, engines `node >=22`, peer `@opentelemetry/api ^1.9.0` [VERIFIED: npm registry] |
| `@langfuse/otel` | `6.1.1` | `LangfuseSpanProcessor` (OTLP to `${baseUrl}/api/public/otel/v1/traces`) | peers: `@opentelemetry/api ^1.9.0`, `@opentelemetry/core ^2.0.1`, `@opentelemetry/sdk-trace-base ^2.0.1`, `@opentelemetry/otlp-exporter-base >=0.202.0 <0.300.0`, `@opentelemetry/exporter-trace-otlp-http >=0.202.0 <0.300.0` [VERIFIED: npm registry] |
| `@opentelemetry/sdk-trace-base` | `2.12.1` | `BasicTracerProvider` (isolated, never registered globally) | `2.12.1` is not deprecated; the package-level `deprecated` field ("Use @opentelemetry/sdk-trace package") comes from `2.12.0`, the npm `latest` tag. `latest-2` = `2.12.1`. Peer `@opentelemetry/api >=1.3.0 <1.10.0` [VERIFIED: npm registry] |
| `@opentelemetry/exporter-trace-otlp-http` | `0.223.2` | Peer of `@langfuse/otel` | Highest version inside `<0.300.0`; engines `^18.19.0 \|\| >=20.6.0`. `0.301.2` (npm latest) needs `@opentelemetry/api ^1.10.0` and Node `>=22.15.0` [VERIFIED: npm registry] |
| `@opentelemetry/otlp-exporter-base` | `0.223.2` | Peer of `@langfuse/otel` | Same range reasoning [VERIFIED: npm registry] |
| `@opentelemetry/core` | `2.12.1` | Peer of `@langfuse/otel` | `3.1.1` (npm latest) is outside `^2.0.1` and needs api 1.10 [VERIFIED: npm registry] |
| `@opentelemetry/api` | `1.9.0` | Already installed (dependency of `ai@6.0.3`, exact `1.9.0`); declare it directly so it cannot float to 1.10 | `node -e require('ai/package.json').dependencies` → `'@opentelemetry/api': '1.9.0'` [VERIFIED: node_modules] |

Do **not** add `@opentelemetry/sdk-node`, `@vercel/otel` or `@opentelemetry/context-async-hooks`. The isolated provider plus explicit parents needs none of them, and `sdk-node` would register globals. That conflicts with D-18's "not registered globally".

### Python (eval project)

| Library | Pin | Purpose |
|---|---|---|
| `httpx` | `0.28.1` (already pinned in the `draft` extra and in `eval/uv.lock`) | Langfuse public API client for `review_queue` and `online_judge`. Add a new extra `online = ["httpx==0.28.1"]`, or reuse `draft` |
| stdlib `random`, `statistics`, `hashlib` | — | Paired bootstrap (fixed seed), percentiles, deterministic sampling. No numpy needed (about 60 items × 10,000 resamples runs in well under a second in pure Python) |

### Alternatives considered

| Instead of | Could use | Tradeoff |
|---|---|---|
| Replaying spans in `after()` | Live spans via `startActiveObservation` | Needs an AsyncLocalStorage context manager registered globally (Langfuse docs: without one "all spans are dropped" for context-based APIs) and puts span work in the request path |
| `LangfuseSpanProcessor` default exporter | Custom `exporter` (e.g. `InMemorySpanExporter` from `@opentelemetry/sdk-trace-base`) | Use the custom exporter only in unit tests; production uses the default so Langfuse's batch byte limit and headers apply |
| Langfuse JS `@langfuse/client` for scores | Plain HTTP from Python | The scorer is Python (online judge); no JS client needed |

**Installation (exact pins, save-exact):**
```bash
npm install --save-exact @langfuse/tracing@6.1.1 @langfuse/otel@6.1.1 \
  @opentelemetry/sdk-trace-base@2.12.1 @opentelemetry/exporter-trace-otlp-http@0.223.2 \
  @opentelemetry/otlp-exporter-base@0.223.2 @opentelemetry/core@2.12.1 @opentelemetry/api@1.9.0
```
`.npmrc` sets `legacy-peer-deps=true`, so npm **will not** enforce or install these peers on its own. They must be listed explicitly as above, and a test should assert the resolved versions (pitfall P-14).

## Package Legitimacy Audit

Run via `gsd-tools query package-legitimacy check --ecosystem npm ...` this session. No package has a `postinstall` script (`npm view <pkg>@<ver> scripts.postinstall` returned empty for all seven pinned versions).

| Package | Registry | Age (pinned version) | Downloads/wk | Source repo | Verdict | Disposition |
|---|---|---|---|---|---|---|
| `@langfuse/tracing` | npm | 20 days (2026-11-03) | 4.7M | github.com/langfuse/langfuse-js | SUS (`too-new`) | Flagged: planner adds `checkpoint:human-verify` before install |
| `@langfuse/otel` | npm | 20 days | 4.4M | github.com/langfuse/langfuse-js | SUS (`too-new`) | Flagged: checkpoint |
| `@opentelemetry/sdk-trace-base` | npm | 2.12.1: 14 days | 125M | github.com/open-telemetry/opentelemetry-js | SUS (`deprecated`; applies to `2.12.0`, the `latest` tag) | Flagged: pin 2.12.1, which is not deprecated; checkpoint |
| `@opentelemetry/exporter-trace-otlp-http` | npm | 0.223.2: 11 days | 57M | opentelemetry-js | SUS (`too-new`) | Flagged: checkpoint |
| `@opentelemetry/otlp-exporter-base` | npm | 11 days | 86M | opentelemetry-js | SUS (`too-new`) | Flagged: checkpoint |
| `@opentelemetry/core` | npm | 14 days | 226M | opentelemetry-js | SUS (`too-new`) | Flagged: checkpoint |
| `@opentelemetry/api` | npm | 1.9.0 (already installed) | 158M | opentelemetry-js | OK | Approved |

**Packages removed due to SLOP verdict:** none.
**Packages flagged SUS:** the six above. Every flag is the age heuristic (or the deprecation of a version we do not pin) on an official, heavily downloaded package. If the human checkpoint prefers versions older than 30 days, use `@langfuse/*@6.0.2` (2026-10-22). That fallback has not been re-checked against the OTel peer ranges [ASSUMED].

## Current Retrieval Call Graph (what moves, from where)

Every line number below was read this session.

| # | Call site | What it does today | Tenant behaviour today | Moves to |
|---|---|---|---|---|
| 1 | `src/app/api/chat/route.ts:2117` `enhancedRetrieveChunks(queryText, {maxResults: env.RAG_FINAL_RESULT_COUNT‖25, …, organizationId, userId})` | Main retrieval | `organizationId` straight from the body (L2101-2102); `userId` from `sbSSR.auth.getUser()` (L2112-2115) | `runRetrieval({profile:'chat'})` → `rag/legacy/` |
| 2 | `chat/route.ts:2183-2205` per-chunk `documents … .eq('id').single()` and conditional `document_chunks select('metadata') .eq('id').single()` | N+1 lookups (up to 2 per chunk) | admin client (`supabase = getSupabaseAdmin()`, L1213) | `rag/context/assemble.ts` (one `in()` per table) |
| 3 | `chat/route.ts:2274-2282` third per-chunk `document_chunks select('metadata')` for `metadata.urls` | N+1 #3 | admin | same `in()` result reused |
| 4 | `chat/route.ts:1951-1997` `@mention` → `documents.ilike('filename', %name%).limit(1)`, then `.eq('filename')`, then a debug `select … limit(10)` | Resolves names **across all tenants** | admin, no predicate | `rag/refs/resolve.ts` with tenant predicate |
| 5 | `chat/route.ts:2006-2078` per document reference: `documents.single()`, `document_chunks.eq('document_id').limit(30)`, fallback `documents select('content, text')`, fallback `document_chunks select('*')` | Explicit refs (message `document` parts or mentions) | admin; ref ids come from the client message | `rag/refs/fetch.ts`; out-of-scope ref → ignored and logged (D-12) |
| 6 | `chat/route.ts:2356-2362` `getQueryEmbedding('general information overview')` + `.rpc('match_document_chunks', {match_count:5, similarity_threshold:0.5})` + per-doc lookups L2380-2450 | Empty-query fallback | admin + `match_document_chunks`. In multi-tenant this returns every user's personal docs (see SQL below) | `runRetrieval({profile:'chat', query:'general information overview', options:{generalOverview:true}})` |
| 7 | `chat/route.ts:2615-2622` `organizations.select('settings').eq('id', body.organizationId)` | Workspace prompt override | reads any org's settings from the body id | use `scope.organizationId` (after D-08 the 403 has already happened) |
| 8 | `src/app/api/embed/chat/route.ts:133` `enhancedRetrieveChunks` with **no** org/user | Embed retrieval | single-tenant: global; multi-tenant: `match_documents_by_workspace(null,null)` → always empty | `runRetrieval({profile:'embed'})` |
| 9 | `embed/chat/route.ts:150-185` per-chunk docName (cached) + per-chunk metadata | Embed assembly (no relevance filter, no image skip, no GPT hints) | admin | shared `assembleContext()` (embed output **changes** to the chat format, which D-16 intends) |
| 10 | `src/app/api/internal/rag/run/route.ts:45` + L59-75 N+1 on **anon** `supabase` | Eval | `checkEvalScope` allow-list | `runRetrieval({profile:'eval', scope: evalScope(...)})`; lookups move to admin like chat |
| 11 | `src/app/api/internal/voice-rag/route.ts:43,57,72` embedding + `match_documents_by_workspace(p_org_id:null, p_user_id: body.userId)` or global `match_document_chunks` | Voice vector search, `matchCount*5`, threshold 0.15 | trusts `userId`; global fallback | voice profile `search` stage |
| 12 | `voice-rag/route.ts:142-147, 210-214, 233-254` three `adminClient.from('document_chunks')` `.or(ilike…)` queries | Image intent, phrase match, keyword match | **no tenant predicate, ever** | `voice_keyword_fallback` stage **plus** tenant predicate |
| 13 | `voice-rag/route.ts:363` `hybridRerank(query, candidateChunks, {topK: matchCount, includeScores:true})` | Local rerank | — | `rag/rerank/local-hybrid.ts` (`local_rerank` stage) |
| 14 | `src/app/api/generate-image/route.ts:268-277` `getQueryEmbedding(prompt)` + module-level admin `match_document_chunks(0.3, 10)` | Image prompt context | global | `runRetrieval({profile:'media'})` |
| 15 | `src/app/api/generate-video/route.ts:213-234` `require('@/lib/document-processor').getQueryEmbedding` + admin `match_document_chunks(0.3, 10)` | Video prompt context | global | `runRetrieval({profile:'media'})` |
| 16 | `src/lib/document-processor.ts:30,55` `openai.embeddings.create`; `getQueryEmbedding` L100; also called by `process-document/route.ts:468`, `ai-to-rag/route.ts:143` | Ingestion embeddings | — | `rag/embeddings/openai.ts`, called through `@/lib/rag` (D-13) |
| 17 | `scripts/rag/reprocess-documents.js:122` `openai.embeddings.create` | Offline re-embed script | — | **Not under `src/`**. D-14's check must decide its scope; recommend scanning `src/` only and listing `scripts/rag/reprocess-documents.js` as a known exception until Phase 3 |
| 18 | `voice-agent/src/rag_client.ts:41-53` POST `{query, userId, matchCount:5}` with `x-api-key`; `voice_agent.ts:940-951` POST voice-chat `{userId, messages}` | Agent → app | `userId` parsed from identity `user-<uuid>-<n>` (`agent.ts:323-338`) | adds `x-rag-scope-token` |

Dead code confirmed (imported but never invoked from a live path): the chat route imports `comprehensiveRetrieval`, `aggregateChunks`, `requiresComprehensiveRetrieval` (L10), `optimizedSearch` (L11), `enhanceQueryWithReasoning`, `intelligentSearch` (L17) and `searchSimilarChunks` (L6). The only callers of `searchSimilarChunks` are `thinking-rag-enhancer.ts:137-220` (`intelligentSearch`, dead) and the chat import. `reranker-adapter.ts` is reached only from `optimized-search.ts:5`.

### SQL semantics the tenant predicate must reproduce (verbatim)

`supabase/multi-tenant-setup.sql:722-728` (`match_documents_by_workspace`, `SECURITY DEFINER`, granted to `authenticated` and `anon` at L735-736) [VERIFIED: supabase/multi-tenant-setup.sql:692-736]:
```sql
    AND (
      -- Personal workspace: user owns document and no organization
      (p_org_id IS NULL AND d.user_id = p_user_id AND d.organization_id IS NULL)
      OR
      -- Team workspace: document belongs to organization
      (p_org_id IS NOT NULL AND d.organization_id = p_org_id)
    )
```
So `o:<uuid>` means `d.organization_id = oid` (user ignored), `u:<uuid>` means `d.user_id = uid AND d.organization_id IS NULL`, and `s:default` (single-tenant) means no predicate. `p_user_id = NULL` with `p_org_id = NULL` matches nothing. That is today's "no session → empty".

`match_document_chunks` (multi-tenant) derives the tenant from `auth.uid()` and `user_preferences` (L761-790). With the admin client `auth.uid()` is NULL, so `current_org_id` is NULL and the predicate becomes `dc.organization_id IS NULL`: every flat-personal document of every user [VERIFIED: supabase/multi-tenant-setup.sql:742-794]. This is the leak behind call sites 6, 11 (fallback), 14 and 15.

Membership table `organization_members(organization_id, user_id, role)` with `UNIQUE(organization_id, user_id)` and index `idx_org_members_user_id` [VERIFIED: supabase/multi-tenant-setup.sql:96-110]. Single-tenant `match_document_chunks` returns `chunk_id, document_id, content, similarity` and **no metadata** [VERIFIED: supabase/single-tenant-setup.sql:277-303]. That explains the chat route's per-chunk metadata fetch and why assembly must keep fetching chunk metadata.

## Architecture Patterns

### System Architecture Diagram

```
 Browser chat (useChat) ──POST /api/chat──┐
 Embed widget (chat.js / window) ─POST /api/embed/chat──┐
 LiveKit room ← browser (token from GET /api/livekit/token: session → scope → HMAC token in participant metadata)
     └─ voice-agent reads participant.metadata ─POST /api/internal/voice-rag (x-api-key + x-rag-scope-token)─┐
 Eval harness ─POST /api/internal/rag/run (x-rag-eval-secret)─┐            Media UI ─POST /api/generate-{image,video}─┐
                                                              ▼                                                         ▼
                         ┌──────────── route adapter (auth, parse, render) ────────────┐
                         │ resolveTenantScope | embedScope | voiceScope | evalScope     │── reject: 401/403 JSON before streaming
                         └─────────────────────────────┬───────────────────────────────┘
                                                       ▼  TenantScope (branded)
   runRetrieval({scope, query, profile, documentRefs, options, signal, trace})
     ├─ refs: resolve @mentions / document parts → in-scope? else ignore+log
     ├─ stage runner (per stage: enabled? timeout? AbortSignal.any([req, timeout]); onFail skip|throw)
     │    analyze → embed ─(OpenAI, signal)→ search ─(RPC .abortSignal)→ legacy_rank
     │    [voice: voice_keyword_fallback (tenant-filtered) → local_rerank]
     │    → post_filter → assemble (documents in() + chunk metadata in(), fixed 2 queries)
     ├─ status: ok | empty | error | degraded (+ reason)
     └─ trace collector (in-memory stage records)
                                                       ▼
   route renders: chat SSE prompt / strict refusal (empty only) / in-band error (error, degraded-empty)
                  embed prompt | voice JSON {results, source_images} / 503 | eval RagTrace
                                                       ▼ response streamed
   after(): sampled? → replay spans into isolated BasicTracerProvider → LangfuseSpanProcessor
            → OTLP POST {LANGFUSE_BASE_URL}/api/public/otel/v1/traces (forceFlush, time box)
            otherwise or on failure → single "[RAG Trace]" log line
   Nightly: rag_eval.review_queue pull (GET /api/public/v2/observations) → JSONL (gitignored)
            rag_eval.online_judge → POST /api/public/scores (array body)
```

### Recommended layout of `src/lib/rag/` (Claude's discretion, D-01/D-13 paths honoured)

```
src/lib/rag/
├── index.ts                 # ONLY public entry: runRetrieval, scope resolvers, types, embedQuery/embedBatch (for ingestion), createEnhancedRAGPrompt
├── types.ts                 # RetrievalResult, Candidate, StageRecord, RetrievalStatus, Profile
├── config.ts                # RAG_PIPELINE, RAG_DISABLED_STAGES, RAG_STAGE_TIMEOUTS parsing, per-profile defaults, log-once
├── deps.ts                  # RagDeps {anonClient, adminClient, embedder, now, randomId}; setRagDepsForTests()
├── pipeline.ts              # stage runner + status derivation
├── tenant/scope.ts          # brand symbol, mintScope (module-private), isTenantScope, tenantPredicate
├── tenant/resolve-chat.ts   # resolveTenantScope(req, body)
├── tenant/embed.ts          # embedScope(env, body)
├── tenant/voice-token.ts    # mintVoiceToken / verifyVoiceToken (HMAC)
├── tenant/eval.ts           # evalScope(options) (wraps the Phase 1 allow-list)
├── legacy/enhanced-retrieval.ts   # re-homed enhancedRetrieveChunks (+ executeVectorSearch)
├── query/temporal-query-detector.ts
├── embeddings/openai.ts     # embedQuery(text, {signal}), embedBatch(texts, {signal})
├── refs/                    # @mention + document-part resolution with tenant predicate
├── context/assemble.ts      # assembleContext (chat canonical), context/voice.ts, context/media.ts
├── rerank/local-hybrid.ts   # hybridRerank (type errors fixed)
├── voice/keyword-fallback.ts
├── generation/prompt.ts     # createEnhancedRAGPrompt
└── trace/collector.ts, trace/langfuse.ts, trace/log.ts, trace/mask.ts, trace/sample.ts
```

### Pattern 1: Branded `TenantScope` with a module-private brand

**What:** a `unique symbol` brand that only `tenant/scope.ts` can attach, plus a runtime `WeakSet` check so a structural copy (spread, JSON round-trip) is rejected.
```typescript
// src/lib/rag/tenant/scope.ts  (sketch; values from D-07)
declare const scopeBrand: unique symbol;
export type TenantKind = 'single' | 'personal' | 'org';
export type TenantScope = Readonly<{
  [scopeBrand]: true;
  kind: TenantKind;
  userId: string | null;
  organizationId: string | null;
  tenantKey: string; // 's:default' | 'u:<uuid>' | 'o:<uuid>'
}>;
const minted = new WeakSet<object>();
/** @internal only tenant/* may import this */
export function mintScope(kind: TenantKind, userId: string | null, organizationId: string | null): TenantScope {
  const tenantKey = kind === 'single' ? 's:default' : kind === 'org' ? `o:${organizationId}` : `u:${userId}`;
  const scope = Object.freeze({ kind, userId, organizationId, tenantKey }) as unknown as TenantScope;
  minted.add(scope);
  return scope;
}
export function assertTenantScope(value: unknown): asserts value is TenantScope {
  if (typeof value !== 'object' || value === null || !minted.has(value)) throw new Error('[RAG Tenant] unminted scope');
}
```
Type test: `// @ts-expect-error` on `runRetrieval({ scope: { kind: 'single', userId: null, organizationId: null, tenantKey: 's:default' }, … })` in a `tests/rag/tenant-brand.test-d.ts` file that `typecheck:new` compiles. A plain `tsc` pass then proves the error exists, and an unused `@ts-expect-error` fails. Enforce "mintable only inside `src/lib/rag/tenant/`" with the boundary check: `mintScope` must not be imported outside `src/lib/rag/tenant/`.

### Pattern 2: Stage runner with AbortSignal composition

```typescript
// sketch: AbortSignal.any / AbortSignal.timeout exist on Node 22 (`node -e` printed "function function" this session)
async function runStage<T>(stage: StageSpec, parent: AbortSignal, fn: (s: AbortSignal) => Promise<T>, rec: TraceCollector) {
  if (!stage.enabled) { rec.skip(stage.name, 'disabled'); return { skipped: true as const }; }
  const signal = AbortSignal.any([parent, AbortSignal.timeout(stage.timeoutMs)]);
  const t0 = performance.now();
  try {
    const value = await fn(signal);
    signal.throwIfAborted();            // postgrest resolves on abort, see P-04
    rec.ok(stage.name, performance.now() - t0);
    return { skipped: false as const, value };
  } catch (err) {
    const reason = parent.aborted ? 'aborted' : signal.aborted ? 'timeout' : 'failed';
    rec.fail(stage.name, reason, performance.now() - t0);
    if (stage.onFail === 'throw' || parent.aborted) throw new StageError(stage.name, reason, err);
    return { skipped: true as const, reason };
  }
}
```
Status derivation (D-05): any core stage failure, timeout or abort gives `error`. Otherwise any skipped optional stage (disabled by config, or failed with `onFail:'skip'`) gives `degraded`. Otherwise zero surviving chunks **and** zero used documents gives `empty`. Otherwise the status is `ok`. Decide explicitly whether a stage disabled through `RAG_DISABLED_STAGES` counts as "skipped" for D-05. The literal reading says yes (`degraded`). That means disabling `legacy_rank` turns a true empty into `degraded` and suppresses strict refusal. The recommendation is to count only *runtime* skips (timeout or failure) as degraded and record config-disabled stages as `disabled`. Flag this for confirmation (Open Question 2).

### Pattern 3: After-the-fact span replay (no context manager, nothing exported in the request path)

```typescript
// src/lib/rag/trace/langfuse.ts (sketch; APIs read from @langfuse/tracing@6.1.1 and @langfuse/otel@6.1.1 dist)
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider, startObservation } from '@langfuse/tracing';

let processor: LangfuseSpanProcessor | null = null;
function init(): LangfuseSpanProcessor {
  processor ??= new LangfuseSpanProcessor({
    publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, baseUrl: env.LANGFUSE_BASE_URL,
    exportMode: 'batched', timeout: 3, mask: ({ data }) => maskPII(data),
    shouldExportSpan: () => true,      // our own spans are not "langfuse-sdk"-scoped GenAI spans
    mediaUploadEnabled: false,
  });
  setLangfuseTracerProvider(new BasicTracerProvider({ spanProcessors: [processor] }));  // NOT trace.setGlobalTracerProvider
  return processor;
}
export async function exportTrace(t: CollectedTrace): Promise<void> {
  const p = init();
  const common = { 'langfuse.trace.tags': t.tags, 'user.id': t.tenantKey };     // copy to EVERY span (Langfuse v4)
  const root = startObservation('rag-request', { metadata: { tenantKey: t.tenantKey, profile: t.profile, status: t.status } },
    { startTime: new Date(t.startedAt) });
  root.otelSpan.setAttributes(common);
  for (const s of t.stages) {
    const child = root.startObservation(s.name, { metadata: { latency_ms: s.latencyMs, candidates_in: s.in, candidates_out: s.out, status: s.status, rules: s.rules } },
      { startTime: new Date(s.startedAt) });
    child.otelSpan.setAttributes(common);
    child.end(new Date(s.endedAt));
  }
  root.end(new Date(t.endedAt));
  await Promise.race([p.forceFlush(), new Promise((_, rej) => setTimeout(() => rej(new Error('flush timeout')), 4000))]);
}
```
Verified internals: `startObservation` creates its span with `getLangfuseTracer().startSpan(name, {startTime}, createParentContext(parentSpanContext))`. `createParentContext` uses `trace.setSpanContext(context.active(), …)`, which works with the no-op context manager. The child method passes `parentSpanContext: this.otelSpan.spanContext()` explicitly, and `end(endTime?: TimeInput)` exists [VERIFIED: @langfuse/tracing@6.1.1 dist/index.mjs L455-486, L250; index.d.ts L223]. The processor posts to `${baseUrl}/api/public/otel/v1/traces` with `Authorization: Basic`, `x-langfuse-ingestion-version: "4"` and gzip by default (`compression` option or `LANGFUSE_OTEL_COMPRESSION`) [VERIFIED: @langfuse/otel@6.1.1 dist/index.mjs L447-494].

Trace ID for message metadata (D-19): the trace ID is needed at stream start, before the replay. Pre-generate 16 random bytes as 32 hex characters, then pass `parentSpanContext: { traceId, spanId: <8 random bytes hex>, traceFlags: TraceFlags.SAMPLED }` to the root `startObservation`. The root then carries that trace ID, with a dangling parent span ID that Langfuse records as `parentObservationId`. Whether the Langfuse UI shows such a root as a root observation is unverified [ASSUMED]. A fallback option is to mark the root with `langfuse.internal.as_root` (exists in `LangfuseOtelSpanAttributes`; its server semantics are unverified) [ASSUMED]. A live check belongs in ROADMAP live verification.

### Pattern 4: `after()` wrapper that tolerates no request scope

`after()` throws `` `after` was called outside a request scope `` when Next's work stores are absent [VERIFIED: node_modules/next/dist/server/after/after.js L13-19]. That happens in vitest and in the eval harness, which calls the route `POST` in-process. Wrap it:
```typescript
export function scheduleAfterResponse(task: () => Promise<void>): void {
  try { after(task); } catch { void task().catch(() => {}); }  // tests inject a sink instead (deps.traceSink)
}
```
`after` runs even when the response errored, and for streaming responses it runs after the stream finishes [CITED: node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md]. Vercel `maxDuration: 60` bounds it (`vercel.json`).

### Anti-patterns to avoid
- **Constructing `LangfuseSpanProcessor` when `LANGFUSE_ENABLED=false`.** The processor reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, `LANGFUSE_TIMEOUT`, `LANGFUSE_FLUSH_AT` and others from `process.env` on its own [VERIFIED: dist L447-501]. Our env var names collide with the SDK's, so build the processor lazily and only when enabled, and always pass explicit values from `env`.
- **Registering the provider globally.** `ai@6` emits OTel spans (`experimental_telemetry`) through the *global* tracer. A global provider would start exporting AI SDK spans and blow the Hobby quota.
- **Swapping Supabase clients during the re-home.** Keep anon for RPCs and admin for lookups (see Summary).
- **`in()` results in database order.** Always iterate the candidate list and look rows up in a `Map`.

## Tenant Resolution Details (D-07..D-11)

**Chat (`resolveTenantScope`)**
1. `isMultiTenant()` is false → `mint('single')`. Single-tenant documents carry `organization_id` only and are always NULL [VERIFIED: supabase/single-tenant-setup.sql:22-47].
2. Multi-tenant: `user = (await createClient()).auth.getUser()` from `@/lib/supabase/server`. No user → return `{ scope: null, reason: 'no_tenant' }`. Retrieval then returns `empty/no_tenant`, which preserves anonymous WhatsApp calls (`src/lib/whatsapp/webhook-handler.ts:371-395` posts with no cookies and no `organizationId`).
3. Body `organizationId`: treat `'null'`, `null` and `undefined` as personal (existing semantics, `chat/route.ts:2101-2102`). Otherwise require a UUID shape and run `admin.from('organization_members').select('organization_id').eq('organization_id', oid).eq('user_id', uid).maybeSingle()`. A missing row returns 403 JSON *before* any streaming. A query error returns `error` (fail closed), never personal.
4. Run the resolution before the `disableRAG` branch too, because L2615 reads org settings with the body id regardless of RAG.

**Embed (`embedScope`)**: parse `RAG_EMBED_TENANT` as `s:default | o:<uuid> | u:<uuid>`. Check that `o:` exists with `organizations.select('id').eq('id', oid).maybeSingle()`. The embed body schema (`embedChatSchema`, L32-38) has no tenant field today and Zod strips unknown keys. To give a body naming `organizationId`/`workspaceId`/`tenant` a 403, check the raw body before `embedChatSchema.parse`.

**Voice token** (D-10): format `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(secret, payloadB64))`. Verify with `crypto.timingSafeEqual` over equal-length buffers: compare the decoded signature length first, or compare SHA-256 digests of both as `rag-eval/auth.ts:14-37` does. Check `aud === 'voice-rag'`, `v === 1`, `exp > now` (allow ≤ 30 s skew) and `iat <= now + skew`, then re-check membership for `oid`.

LiveKit facts verified this session:
- `AccessToken` options accept `metadata?: string` and `attributes?: Record<string,string>` [VERIFIED: node_modules/livekit-server-sdk/dist/AccessToken.d.ts L19-25].
- "by default, a participant is not allowed to update its own metadata" (`canUpdateOwnMetadata`) [VERIFIED: livekit-server-sdk/dist/grants.d.ts L39-42]. Never grant it, or a user could paste another user's token into their own metadata.
- The agent's `@livekit/rtc-node@0.13.22` (locked in `voice-agent/package-lock.json`) exposes `participant.metadata` and the `participantMetadataChanged` event [VERIFIED: @livekit/rtc-node@0.13.22 dist/participant.d.ts L41-42, room.d.ts L155,189].

Participant metadata is visible to every participant in the room. The token is useless without `MYRAG_INTERNAL_API_KEY` but still leaks the uid/oid of the other user (Risk R-3).

**Shared room problem (Risk R-1).** All three frontends request `room=myrag-voice` (`voice-mode-container.tsx:120`, `VoiceWidget.tsx:63`, `voice-mode-overlay.tsx:90`). The agent joins the fixed room `'myrag-voice'` with fixed identity `voice-agent` (`agent.ts:159-166`). It keeps **one** `VoicePipeline` whose `userId` is overwritten by whichever user track was subscribed last (`agent.ts:323-333`). With two concurrent users, user A's question can be answered from user B's tenant. Phase 2 should at least (a) bind the scope token to the participant and set it at `TrackSubscribed`, as `setUserId` does today, (b) have the agent ignore audio from a second `user-*` participant while one is active and log it, and (c) have the token route ignore the client `room` parameter (server-fixed `myrag-voice`) and the client `username` (D-10). Per-user rooms would be the real fix, but they need agent dispatch changes. Raise that as an Open Question.

**Anonymous voice**: today anonymous users get identity `user-anon-<n>`, fail the UUID parse and hit the **global** fallback (`voice-rag/route.ts:70-83`). With D-10, single-tenant anonymous callers get a token with `tk: 's:default', uid: null` (same retrieval as today). Multi-tenant anonymous callers get a LiveKit token with no RAG token, so every voice-rag call returns 401 and the agent must speak the "can't reach the knowledge base" line for 401 as well as 503 (`rag_client.ts:105-108` currently swallows every error into empty context).

## assembleContext Byte-Identity Rules (D-16, D-17)

To be byte-identical with `chat/route.ts:2142-2346`, the shared function must:
1. Take the documents already pushed by explicit references (L2017-2025) as initial state. Their chunks pass the relevance filter through `relevantChunks` (L2250-2252) even if they would fail it, and their context sections (`=== DOCUMENT: "…" ===`) **precede** the semantic section in the same `context` string.
2. Compute `queryTerms` with `normalize(queryText)` (`chat/route.ts:546-552`: lowercase for strings, the first text part for arrays), then `.split(/\s+/).filter(t => t.length > 3).map(t => t.replace(/[^a-z0-9]/g,''))`. Chinese terms become `''`, and `docName.includes('')` is true for every chunk (the "Chinese empty-term behavior").
3. Iterate `similarChunks` in order. Skip a chunk whose document lookup fails (`.single()` error or a missing row). Merge chunk metadata as `{...chunk.metadata, ...dbMetadata}` only when `!chunk.metadata?.image_url`. The `urls` come from the DB row metadata (L2274-2282), and the DB row is fetched for **every** relevant chunk, including ones that already had `image_url`.
4. Group by `docInfo?.filename || docInfo?.name || 'Unknown Document'` (by filename, not id). Sort each group by `chunkNum` when both chunks have one, else by similarity descending. Skip filenames ending in an image extension. Apply the `[Source: …]` GPT rewrite only when `isGPTModel && c.chunkNum` (`isGPTModel` = `model.includes('gpt-4') || model.includes('o1') || model.includes('chatgpt')`, L1847). So `isGPTModel` is an assembly input.
5. Filter 2 (L2512-2540) runs **after** the context is built. Context may contain documents that Filter 2 later drops from `usedDocuments`. The refusal test therefore stays `usedDocuments.length === 0 && context.trim().toLowerCase().startsWith('no relevant context found')`, ANDed with `status === 'empty'` (D-06).
6. Return the full chat `UsedDocument` shape (`id, name, filename, created_at, content_preview (200 chars + '...'), similarity, matched_chunk (150 + '...'), explicitly_referenced, image_url, external_url`), because the stream and persistence (`chat/route.ts:4038-4116, 4315-4384`) read those fields.

Query budget: one `documents.in('id', uniqueDocIds)` selecting `id, filename, created_at, content, metadata` and one `document_chunks.in('id', chunkIds)` selecting `id, metadata`, so two queries regardless of N. Keep the URL list under PostgREST's URL-length limit: 25 chunks × 37-character UUIDs is about 1 KB. `max_results` is capped at 100 by `RagRunOptions` (`eval_run.py`, `le=100`), about 3.7 KB, which is fine [ASSUMED: PostgREST/Kong default URL limits are well above 8 KB]. The `content` column is full document text, the same payload the chat loop already fetched.

Embed today differs: it has no relevance filter, no image-document skip, no GPT hint and no per-group sort, and its no-result text is `'No relevant information found in the knowledge base for this query.'` (L214, L218). Switching embed to the shared function is an intended difference that must be listed (D-16). Note that embed's prompt branch `context.length > 0` uses `createEnhancedRAGPrompt(systemPrompt, context)` with the default mode (L281-283).

Voice wire shape: the route returns `{ results, source_images, debug_info }` (`voice-rag/route.ts:436-444`). `{context, sources, source_images}` is the *agent client's* derived `RAGResponse` (`rag_client.ts:18-25, 79-101`). The wire contract to preserve is `results[]` (items carry `chunk_id, document_id, content` (**with** the `\n[Metadata: …]` suffix added at L347), `similarity` (rerank score), `metadata`, `image_url`, plus reranker fields) and `source_images[]`. The characterization test must capture these, and the planner should read D-16's "response shape" as this wire shape (finding F-6). Remove `debug_info` when `query.includes('debug')` (L439): it is a user-triggerable debug leak (D-16 does not keep it).

## AbortSignal Propagation

| Layer | API | Behaviour on abort | Evidence |
|---|---|---|---|
| supabase-js / postgrest-js 2.76.1 | `.rpc(...).abortSignal(signal)`, `.from(...).select(...).abortSignal(signal)` | **Resolves** with `{ data: null, error: { message: 'AbortError: …' }, status: 0 }` unless `.throwOnError()`; it does not reject | [VERIFIED: node_modules/@supabase/postgrest-js/dist/cjs/PostgrestTransformBuilder.d.ts:81, PostgrestBuilder.js:164-178] |
| openai 4.104.0 | `openai.embeddings.create(body, { signal })` | Rejects (`APIUserAbortError`) | `RequestOptions.signal?: AbortSignal` [VERIFIED: node_modules/openai/core.d.ts:215]; error class name [ASSUMED] |
| Next route | `req.signal` | Aborts on client disconnect | [ASSUMED] (not verified for Next 16 dev and prod; tests should drive an explicit `AbortController`, not a real socket close) |
| Node 22 | `AbortSignal.any`, `AbortSignal.timeout` | — | `typeof` printed `function function` [VERIFIED: local node v22.23.5] |

The re-homed `executeVectorSearch` must stop returning `[]` on `error` (`enhanced-rag-retrieval.ts:157-160, 181-184`) and throw a typed `RetrievalBackendError`. Abort and timeout must be detected from the signal, not from the message text. This is the one intended deviation from "identical behavior" in D-02, and it is what D-05 requires. The fixture never produces RPC errors, so parity is unaffected.

## Langfuse Specifics (D-18..D-20, D-26)

- **v4 data model:** "Langfuse v4 queries observations directly". Trace-level attributes must be copied "to every span where they must be queryable": `user.id`/`langfuse.user.id`, `session.id`, `langfuse.trace.tags`, `langfuse.trace.metadata.<key>` [CITED: langfuse.com/integrations/native/opentelemetry/migration-to-v4]. So `tenantKey` and the `review_candidate` tag go on every stage span, or the review-queue tag filter misses them.
- **Attribute names** (from `LangfuseOtelSpanAttributes`): `TRACE_TAGS = "langfuse.trace.tags"`, `TRACE_USER_ID = "user.id"`, `TRACE_METADATA = "langfuse.trace.metadata"`, `OBSERVATION_METADATA = "langfuse.observation.metadata"`, `OBSERVATION_INPUT = "langfuse.observation.input"`, `OBSERVATION_OUTPUT = "langfuse.observation.output"`, `ENVIRONMENT = "langfuse.environment"`, `AS_ROOT = "langfuse.internal.as_root"` [VERIFIED: @langfuse/core@6.1.1 dist/index.d.ts enum LangfuseOtelSpanAttributes].
- **Quota:** Hobby is 50k units a month (PROJECT.md Key Decisions). With 1 root + 6-8 stage spans, a trace costs about 7-9 units, so roughly 5.5-7k sampled requests a month, or 55-70k requests at `LANGFUSE_SAMPLE_RATE=0.1`. Online-judge scores add units [ASSUMED: one unit per observation or score].
- **Sampling:** decide in code, not with an OTel sampler: `sampled = (parseInt(sha256('trace:'+requestId).slice(0,8),16) / 2**32) < LANGFUSE_SAMPLE_RATE`, and a separate hash prefix `'review:'` for `LANGFUSE_REVIEW_SAMPLE_RATE`. Review export implies trace export. Unsampled requests still log `[RAG Trace]`.
- **Masking** (discretion): run our own `maskPII` before attributes are set (content only exists when `LANGFUSE_CAPTURE_CONTENT=true` or the request is a review candidate), and again as the processor `mask` (defence in depth). Patterns: e-mail `/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi`→`[EMAIL]`; IBAN `/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g`→`[IBAN]`; card `/\b(?:\d[ -]?){13,19}\b/g` with a Luhn check →`[CARD]`; phone `/(?:\+|00)\d[\d ()-]{7,}\d/g` and `/\b1[3-9]\d{9}\b/g` (CN mobile)→`[PHONE]`; IDs: CN resident ID `/\b\d{17}[\dXx]\b/g`, IT codice fiscale `/\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/gi`→`[ID]`. Apply card before phone. The mask receives `data` that "is not always a string" (metadata values are decoded) [VERIFIED: @langfuse/otel d.ts example], so recurse into objects.
- **Review queue pull:** `GET /api/public/v2/observations?fromStartTime=…&toStartTime=…&fields=core,basic,io,metadata,trace_context&limit=1000&filter=<urlencoded [{"type":"arrayOptions","column":"tags","operator":"any of","value":["review_candidate"]}]>`, paginating while `meta.cursor` is present. A page can hold zero items while the cursor remains. `parseIoAsJson=true` now returns 400. I/O is returned as raw strings [VERIFIED: Langfuse OpenAPI spec cloud.langfuse.com/generated/api/openapi.yml, path `/api/public/v2/observations`].
- **Scores:** `POST /api/public/scores` body is `CreateScoresRequest` = **array** of `{id?, traceId?, observationId?, name, value, comment?, metadata?, environment?, dataType?, configId?, source?, timestamp?}`. It returns 202 `{"message":"Accepted"}` or 207 `{accepted, rejected, errors[]}`, and the spec says "Do not automatically retry a 207 batch". Use a deterministic `id` (e.g. `sha256(traceId+metric+judgeModel)`) plus a fixed `timestamp` for idempotent re-runs [VERIFIED: Langfuse OpenAPI spec, schemas CreateScoresRequest/CreateScoreRequest/CreateScoreBatchResults; CITED: langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk for idempotency]. D-26 says scores go to `POST /api/public/scores`. That still holds, only the body shape changed (finding F-3).
- **Legacy ingestion:** sunset on Langfuse Cloud 2026-11-16; scores remain supported [CITED: langfuse.com/docs/compatibility].

### Fake Langfuse endpoint for tests (D-20, D-26)
A `node:http` server on `127.0.0.1:0` (same style as `eval/harness/fake-edge.mts`) that:
- accepts `POST /api/public/otel/v1/traces`. The test sets `LANGFUSE_OTEL_COMPRESSION=none`, or passes `compression:'none'`, *or* the server gunzips on `content-encoding: gzip`. It parses OTLP/JSON `resourceSpans[].scopeSpans[].spans[]` and records them. The exporter's JSON encoding is the http/JSON flavour [ASSUMED: the `exporter-trace-otlp-http` default content type is `application/json`; the server should accept both and fail loudly on protobuf];
- serves `GET /api/public/v2/observations` from a fixture list, with `meta.cursor` paging;
- accepts `POST /api/public/scores` (array) and returns 202;
- can be told to hang or return 500, to test the time box and the `[RAG Trace]` fallback.

Assertions: exactly one trace ID, `1 + stages.length` spans, span names equal to the `stage_latency_ms` keys, and attributes `latency_ms`, `candidates_in`, `candidates_out`, `status`, `rules`. Prove "response completes before export" by resolving the HTTP handler only after the test has fully read the response body: with the scheduling wrapper, the route returns while the fake still holds the export request open.

## Eval Additions (D-22..D-26)

**Stage-latency keys change.** Today `stage_latency_ms` = `{retrieval, post_filter, generation?}` (`rag/run/route.ts:96-107`). D-19 requires span names = keys = stage names (`analyze, embed, search, legacy_rank, post_filter, assemble`). `RagTrace.stage_latency_ms` is `dict[str, float]` [VERIFIED: rag-sidecar/src/rag_sidecar/contracts/eval_run.py `RagTrace`], so no contract change is needed. Grep the Python report code for `'retrieval'` before renaming. Add `stage_status: dict[str, str]` to `RagTrace` (optional, default empty) for D-20.

**Config hash.** `buildEffectiveConfig()` folds every `RAG_*` env var except names matching `SECRET|KEY|TOKEN|…` into `rag_env` (`trace.ts:23-48`). `RAG_PIPELINE`, `RAG_DISABLED_STAGES`, `RAG_STAGE_TIMEOUTS` and `RAG_EMBED_TENANT` will enter the hash when set; `RAG_VOICE_TOKEN_*` are excluded by `TOKEN`. The gate does **not** compare config hashes (`gate.py:31-52` compares golden, corpus, embedder, tier, mode and request options), so parity is unaffected. Keep the new vars out of `eval/config/rag-eval-env.json` unless set deliberately.

**`degrade` option (D-24).** Adding `degrade: Literal['drop_top_candidate'] | None = None` to `RagRunOptions` makes the negative-control run's `request_options` differ from the baseline. `gate._scope` excludes only `max_results` (`gate.py:27-28`), so the run would exit **2 (mismatch)**, not 10. Exclude `degrade` in `_scope` too, and add a test. Apply the degrade on the candidate list *before* `post_filter` (drop index 0 of the ranked candidates), only in the `eval` profile, and only when the eval endpoint authorised the request. Margin assertion in CI: `jq` on `gate.json` offenders for `slice=="overall" and metric=="mrr"` with `threshold - observed >= 0.05`.

**Per-item baseline rows + paired bootstrap (D-23).** `EvalReport.items` already carries per-item results (`report.py` `ItemResult`: `refused, span_count, spans_hit_at_5/10, first_hit_rank`). Add to `Baseline` an optional `items: dict[str, dict[str, list[float | None]]] | None = None` (item_id → metric → per-run values). The committed baseline then still parses (`extra="forbid"` tolerates a missing optional field). Per-item metric values must equal `metrics._slice` exactly: recall@k = `hits/span_count` (answerable only), mrr = `1/first_hit_rank` else `0.0` (answerable), false_refusal = `1.0 if refused` (answerable), correct_refusal = `1.0 if refused` (unanswerable), `None` where not applicable.

`rag_eval.paired`:
- per slice, take the items present in both runs with non-None values and compute `d_i = new_i - base_i`, using the mean over baseline runs for `base_i`;
- report `mean_d`, `n`, `n_nonzero`, and a percentile bootstrap: `rng = random.Random(20261123)`; draw `B = 10000` resamples of size n with `rng.choices(range(n), k=n)`; take the 2.5th and 97.5th percentiles;
- with n = 0, report `None`; with all `d_i = 0` the interval is `[0, 0]`. That is the D-22 parity proof.

Write it into `gate.json`/`gate.md` as an attached `paired` block. The noise-band decision stays the only pass/fail rule. Order (D-22): (1) add the optional `items` field and teach `baseline record` to fill it; (2) re-record the baseline **from the pre-pipeline code** and check that every existing field is byte-identical; (3) switch the eval route; (4) parity run with all paired differences zero.

**EVAL-14 contracts.** `Category` adds `"colloquial", "ambiguous", "typo"`. `Provenance` adds `"production"` [current values VERIFIED: rag-sidecar/src/rag_sidecar/contracts/golden.py L7-10: `Category = Literal["multi_turn", "compound", "exact_term", "table", "scanned", "no_answer", "general"]`, `Provenance = Literal["synthetic_fixture", "claude_draft", "ragas_generated", "human"]`]. `ItemResult` needs `provenance` so the report can build `by_provenance` and `by_provenance_category`. `test_fixture_coverage.py` asserts `cells[(language, category)] >= 2` (L59), so the new categories need at least 2 items per language as soon as they enter the Literal. New items need split assignment by the frozen rule `sha256-first8hex-mod100-lt70-dev`, and they change `golden_sha256`, which forces a baseline re-record (D-25). Gate on production: in `metrics.aggregate`, if any approved `production` item is in the gated split, compute `overall`/`by_language` from those items only. The baseline must then be recorded on the same subset, otherwise `_mismatches` should flag it (add `gate_population` to `GoldenFilter` or to `EvalReport`).

**Review queue / online judge contracts.** New Pydantic: `ReviewQueueItem` (trace_id, observation_id, captured_at, tenant_key, language?, query_masked, answer_masked, context_masked, model, tags), `OnlineJudgeScore`, `OnlineJudgeConfig {sample_rate: float [0,1], seed: int}`, `LatencyBudgets`. `JudgeConfig` is `extra="forbid"` [VERIFIED: contracts/judge.py], so adding `online_judge` to `eval/config/judge.json` without a contract change fails `load_judge_config`. Add `online_judge: OnlineJudgeConfig | None = None`, then run `npm run gen:schemas` (the schema-parity CI job).

**Online judge feasibility (finding F-4).** `assert_judge_family_differs` (Phase 1 WR-12) refuses a judge from the generator's family. The pinned judge is `openai/gpt-5-mini` (`judge.json`). Production chats on OpenAI models (the embed default `openai/gpt-4o-mini`, the WhatsApp default `openai/gpt-4o-mini`) can't be judged, so skip them with `skipped_reason: 'same_family'` and count them. The judge also needs query, answer and context, which exist only on traces whose content was exported (review candidates or `LANGFUSE_CAPTURE_CONTENT=true`). With the D-26 default `LANGFUSE_REVIEW_SAMPLE_RATE=0`, the online judge has nothing to score by default. That is expected, but the nightly notice must say so. The chat route must record the final answer (the `onFinish` text) into the trace before `after()` exports it.

## Latency Report (D-21, OBS-02)

Add `latency: dict[str, {p50, p95, n}]` per stage to `EvalReport` (optional field) and render it against `eval/config/latency-budgets.json` (Pydantic `LatencyBudgets {profiles: {chat|embed|voice: {total_p50_ms, total_p95_ms, stages: {name: p95_ms}}}}`). Compute percentiles with `statistics.quantiles(values, n=100, method='inclusive')`, or nearest-rank for small n. Report only (D-21).

## Node 22 Enforcement (D-27) — finding F-1

Vercel maps `engines.node` ranges as follows: `26.x`, `^26.0.0` **and `>=22.0.0`** deploy the latest **26.x**; `22.x` and `^22.0.0` deploy the latest 22.x. 26.x is the default, and `engines` overrides the project setting [CITED: vercel.com/docs/functions/runtimes/node-js/node-js-versions, last updated 2026-02-27]. `">=22.12.0"` therefore runs Node 26 in production, which contradicts the D-27 CI rule "fails when the runtime major is not 22". Use **`"engines": { "node": "^22.12.0" }`**. It keeps the 22.12 floor and pins the major on Vercel. `@langfuse/*` need `>=22` [VERIFIED]. Local runtime is v22.23.5 and CI uses `node-version: '22'` [VERIFIED: .github/workflows/pr-smoke.yml]. Other details:
- `.nvmrc` = `22`.
- `voice-agent/Dockerfile` `FROM node:20-slim` → `node:22-slim`. The locked `@livekit/rtc-node@0.13.22` has `engines >= 18` [VERIFIED: voice-agent/package-lock.json]. `voice-agent` `@types/node ^20.11.24` should move to 22.
- CI step: `node -e "const v=process.versions.node.split('.')[0]; const e=require('./package.json').engines?.node; if(v!=='22'||!e) process.exit(1)"`, plus a check that `engines.node` does not admit 23+ (`semver.intersects` is available via npm's bundled semver, or check the `^22.` prefix literally).
- Record the Vercel project Node setting in live verification.
- `package.json` `packageManager: pnpm@10.28.1` does not affect `engines`.

## Boundary Check (D-14)

`scripts/ci/check-rag-boundary.mjs` scans `src/**/*.{ts,tsx,js,mjs}` outside `src/lib/rag/` and fails on:
- `/\.embeddings\.create\s*\(/`;
- `/\.rpc\(\s*['"\`](match_|hybrid_|search_chunks)/` (single-tenant also defines `search_chunks_by_keywords`, granted at `single-tenant-setup.sql:1400`);
- imports of `@/lib/(enhanced-rag-retrieval|retrieval-strategies|optimized-search|adaptive-retrieval|reranker-adapter|reranker-local|query-enhancer-local|bm25-scorer|mmr-scorer|temporal-query-detector|thinking-rag-enhancer)` and relative equivalents;
- `/from ['"]@\/lib\/rag\/(?!index)/` (deep imports);
- package imports `weaviate-client`, `@qdrant/js-client-rest`, `cohere-ai`, `voyageai`;
- any import of `tenant/scope` (`mintScope`) outside `src/lib/rag/tenant/`.

Allow-list `tests/**` and `eval/harness/**` by path. Also scan `voice-agent/src/**` for `.rpc(` and `embeddings.create`. Self-test: `node --test scripts/tests/check-rag-boundary.node-test.mjs` with temp-dir fixtures (pattern of `scripts/tests/gen-zod.node-test.mjs`). Add the job to the `check-workflows.py` expectations, because that script asserts the PR job list (`PR_JOBS`, L15).

## Type-Error Cleanup (revised D-15) — full breakdown

Commands run this session: `npx tsc --noEmit -p tsconfig.json` → **312 errors** [VERIFIED]. `npx next typegen && npx tsc --noEmit` → **319** (7 more, see below); the generated `.next/` was removed afterwards and `git status` stayed clean.

**By error code:** TS2339 68 · TS7006 47 · TS2345 38 · TS2307 35 · TS5097 21 · TS2322 20 · TS2304 12 · TS18046 12 · TS2353 8 · TS2790 6 · TS7017 5 · TS2554 5 · TS2503 4 · TS2305 4 · TS7053 3 · TS2769 3 · TS2731 3 · TS18048 3 · TS2741 2 · TS2551 2 · TS2420 2 · TS18047 2 · TS7016, TS2724, TS2698, TS2678, TS2515, TS2367, TS1117 1 each.

**By area (sums to 312):**

| Group | Errors | Content | Nature |
|---|---|---|---|
| G0a sibling packages | 67 | `baileys-whatsapp/**` 64 (31 `src/`, 30 `server.ts`, 3 `Example/`), `voice-agent/src/agent.ts` 3 | Configuration. Root `tsconfig.json` `include: ["**/*.ts", …]` excludes only `node_modules`, so both services **are** inside the main `tsc` but their dependencies are not installed at the root (35 × TS2307 `@hapi/boom`, `pino`, `@cacheable/node-cache`, `@livekit/*`, …; 29 × TS7006 and 1 × TS7016 follow from untyped `express`) |
| G0b eval/tests `.mts` imports | 21 | TS5097 "import path can only end with .mts when allowImportingTsExtensions" in `eval/harness/*.mts` and `tests/eval-*.test.ts` | Configuration (`tsconfig.typecheck-new.json` sets `allowImportingTsExtensions`, root does not) |
| G1 chat route | 35 | `src/app/api/chat/route.ts` | Mixed, see below |
| G2 MCP | 42 | `chat/approve/route.ts` 13, `src/lib/mcp/**` 29 | Many are AI SDK and MCP SDK drift |
| G3 retrieval modules | 15 | `retrieval-strategies` 6, `reranker-local` 6, `adaptive-retrieval` 2, `optimized-search` 1 | 9 disappear with the D-13 deletions; the 6 TS2790 in `reranker-local` are fixed while re-homing |
| G3b entry routes rewritten this phase | 9 | `embed/chat/route.ts` 5, `generate-image/route.ts` 4 | Fixed in the entry-point plans |
| G4 WhatsApp (app side) | 16 | `src/lib/whatsapp/**` 9, `src/app/api/whatsapp/**` 7 | Mixed |
| G5 UI | 48 | `src/components/**` 32, `src/app/embed/window/page.tsx` 11, `src/app/page.tsx` 2, hooks/shared 3 | Mostly trivial |
| G6 other lib + API | 59 | `system-prompt-manager.ts` 12, `config/system-prompts/validate` 7, `semantic-chunker.ts` 6, `auth/organization-handler.ts` 6, `chat-store.ts` 5, others ≤ 4 each | Mixed |
| **Hidden (only with route types)** | +7 | `.next/types/validator.ts` TS2344 for `api/config/system-prompts/[lang]`, `folders/[id]`, `invites/[token]`, `mcp/servers/[id]`, `mcp/servers/[id]/test`, `organizations/[id]/members/[userId]`, `organizations/[id]/share` | These handlers type `{ params }: { params: { id: string } }` (e.g. `folders/[id]/route.ts:7`); in Next 15+ `params` is a Promise |

**Trivial and mechanical (≈ 200):** TS7006 implicit-any parameters (annotate with the real type), TS18046 `unknown` in `catch` (narrow with `instanceof Error`), TS2345 `string | undefined` arguments (guard or default; e.g. `embed/chat/route.ts:169-175`, `chat/route.ts:2389-2399` are the `docData?.filename` caches), TS7017 `globalThis` indexing (one `declare global` block), TS2790 `delete` on required fields (make them optional in the type), TS2503 `JSX` namespace (`React.JSX`), TS2554 `useRef()` without an initial value under React 19 types.

**Configuration (88):** exclude `voice-agent` and `baileys-whatsapp` from the root `tsconfig.json`, then type-check each with its own config after its own install (`cd voice-agent && npm ci && npx tsc --noEmit`; `baileys-whatsapp` has `tsconfig.json`/`tsconfig.build.json` and uses yarn). Their own error counts were **not measured** this session, because their `node_modules` are absent (Open Question 6). For TS5097, either add `allowImportingTsExtensions: true` to the root config (allowed because `noEmit: true` is already set), or exclude `eval/**` and the `.mts`-importing tests from the root and keep them under `typecheck:new`. The first option is simpler. Verify that `next build` accepts it [ASSUMED].

**Risky (≈ 35-45): fixing the type changes runtime behaviour.** "Behaviour-preserving" is not possible for these, so each needs a test and a line in the plan summary:
- **TS2304 "Cannot find name"** are runtime `ReferenceError`s on those paths: `approve/route.ts:2981 paramsToUse`, `whatsapp/connect/route.ts:53 user`, `whatsapp/conversations/route.ts:123 supabase`, `components/ui/streaming-markdown.tsx:38,41 useState/useEffect`, `lib/mcp/universal-discovery.ts:289,373 experimental_createMCPClient`, `lib/semantic-chunker.ts:314,334,358,422,443 maxTokens`. `semantic-chunker` sits on the ingestion path (`document-processor.ts` imports `createSemanticChunks`). Fixing it changes chunking whenever those branches run, so coordinate with Phase 3 or prove the branches unreachable.
- **AI SDK v6 shape drift in `chat/route.ts`:** `ToolCallPart.args` (L4002, 4145, 4190, 4197) and `ToolResultPart.result` (L4070, 4135, 4171) are now `input`/`output`; `experimental_providerMetadata` (L4251-4258) is now `providerMetadata`. Today these read `undefined`, so reasoning capture and tool-arg logging silently do nothing. Renaming the field *activates* the code.
- **Custom stream chunks:** `{ type: 'source_images', source_images }` and `usedDocuments` written to `createUIMessageStream` (`chat/route.ts:4323, 4327`) are TS2353 because they are not `UIMessageChunk` types. The frontend reads `type: 'source_images'` and AGENTS.md §14 protects it. Do **not** convert them to `data-*` parts. Use a single typed helper that casts at one point (`as unknown as UIMessageChunk`) with a comment stating why; D-15 allows a stated reason.
- **Next 15+/16 async `params`** (7 hidden route-type errors): since Next 16 removed synchronous `params` access, `params.id` in those handlers is likely `undefined` at runtime today [ASSUMED: Next 16 removal of the sync compatibility shim; the upgrade guide `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md` discusses async request APIs]. Fixing them (`const { id } = await params`) changes behaviour.
- Wrong-import errors that are `undefined` at runtime: TS2305/TS2724 (`CoreTool` from `ai` in `mcp/production-router.ts:1` and `smart-router.ts:1`; `Folder` from `@/lib/supabase`; `supabaseAuth`; `createAdminClient` in `config/models/route.ts:3`). TS2420 (`SseTransport`/`StreamableHttpTransport` no longer match `McpTransport`). TS2515 (`KoyebWhatsAppClient` missing `sendMedia`). TS1117 duplicate key (`universal-client.ts:187`, where the last key wins today). TS2367/TS2551 (`webhook-handler.ts:101` compares `status.connected`, which is always false today).
- `src/app/page.tsx` has only 2 errors (L1637-1638 `ExtendedFormEvent.data`), so the file is low-risk despite its size.

**Suggested plan grouping (each ≤ about 50 errors, behaviour-preserving first):**
1. **TS-A config** (88 → 0): tsconfig excludes plus `allowImportingTsExtensions`; separate CI type-check jobs for `voice-agent` (needed anyway for the D-10 agent change) and `baileys-whatsapp` (record its count; if non-zero, ratchet it separately); commit the per-file ratchet baseline and the `next typegen && tsc --noEmit` CI step.
2. **TS-B retrieval and entry routes** (24): handled inside the extraction and entry-point plans (G3 + G3b).
3. **TS-C chat route** (35): split into C1 (trivial: TS7006, TS2345, TS18046, TS18048, TS7017, TS2731) and C2 (AI SDK v6 fields + stream chunk helper) with characterization tests. Run C2 only **after** the chat route has switched to `@/lib/rag`, so the sentinel digests and characterization tests are retargeted once.
4. **TS-D MCP** (42): `approve/route.ts` + `src/lib/mcp/**`; includes the `CoreTool`→`Tool` and transport-interface fixes. MCP has no tests today, so add a minimal import/smoke test per transport.
5. **TS-E WhatsApp app side** (16) + **TS-F UI** (48), as two plans.
6. **TS-G other lib/API** (59) + **TS-H route params** (7 hidden).
7. **TS-Z flip**: CI runs `npx next typegen && npx tsc --noEmit` with zero errors, `next.config.js` `typescript.ignoreBuildErrors: false`, and the ratchet is removed.

**Risk of flipping `ignoreBuildErrors` on Vercel.** (a) `next build` type-checks with the root `tsconfig.json`. If `voice-agent/` and `baileys-whatsapp/` stay included, the Vercel build fails on TS2307, because `.vercelignore` does not exclude them and their dependencies are not installed. TS-A must land first. (b) `next build` validates generated route types (`.next/types/validator.ts`), which plain `tsc --noEmit` misses unless `next typegen` ran first. That is why the 7 hidden errors exist. (c) Type errors in `eval/harness` or tests would fail production builds even though `.vercelignore` drops `tests/` (`eval/` is uploaded). Exclude `eval/` from the root config, or keep it at zero. (d) Build time grows with type-checking. (e) Any later dependency bump that adds type errors blocks deploys. That is intended, but say so in the docs. Keep the flip in its own final plan so it can be reverted alone.

## Runtime State Inventory (re-home and delete)

| Category | Items found | Action |
|---|---|---|
| Stored data | Chat messages persisted with `metadata` (`chat/route.ts:4379-4384`) gain a new `ragTraceId` field (additive). No stored keys reference the deleted module names. Golden files and baselines change schema (D-25), which is a data migration: re-record `eval/baselines/fixture-baseline.json` | Code edit + baseline re-record |
| Live service config | Langfuse Cloud project (keys) is new. The Vercel project Node.js setting (Settings → Build and Deployment), to be verified. The LiveKit project is unchanged | Manual (live verification) |
| OS-registered state | Fly.io app `myrag-voice-agent` (`voice-agent/fly.toml`) runs the old agent image. It must be redeployed together with the app (D-10 one-way) | Coordinated deploy |
| Secrets/env vars | New: `RAG_VOICE_TOKEN_SECRET` (app **and** nothing on the agent side; the agent only forwards), `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`. The existing `MYRAG_INTERNAL_API_KEY` is unchanged. The `.env.local` template comes via `scripts/init-env.js` | Placeholders only; Vercel env set manually |
| Build artifacts | `voice-agent/dist/` built inside the Docker image (`npm run build`); `.next/` caches on Vercel; the `eval/.venv` lock is unchanged unless the `online` extra is added (`uv lock`) | Rebuild the image; `uv lock` if the extra is added |

Check-config (D-28): `NAME_PATTERN` in `scripts/check-config.mjs` only discovers `(?:NEXT_PUBLIC_)?RAG_*`, `LLAMACLOUD_*` and `OPENAI_EMBEDDING_MODEL` [VERIFIED: scripts/check-config.mjs]. `LANGFUSE_*` will not be *discovered*. Extend the pattern with `LANGFUSE_[A-Z0-9_]+`, then add the seven `LANGFUSE_*` entries as `managed`.

## Common Pitfalls

- **P-01 Characterization tests mock modules that will no longer be imported.** `tests/chat-strict.test.ts:13-29` mocks `@/lib/enhanced-rag-retrieval`, `@/lib/document-processor`, `@/lib/supabase` and `@/lib/thinking-rag-enhancer` (also `chat-websearch`, `chat-source-images`). After the switch these mocks are inert and the real pipeline runs: an OpenAI call and fake-Supabase reads. Retarget them to `@/lib/rag/legacy/enhanced-retrieval` and `@/lib/rag/embeddings/openai`, or better to a `setRagDepsForTests()` seam, in the same commit as the switch. Assert that each mock was called, so an inert mock fails loudly.
- **P-02 `createSupabaseFake` treats `in`, `is`, `or`, `not`, `ilike` as no-ops** (`tests/helpers/chat-route-fakes.ts:43-46`). A batched `in('id', …)` returns *all* rows, so the tests pass for the wrong reason. Implement `in` and `is` properly and record every builder call for assertions.
- **P-03 The fake PostgREST edge accepts only `eq.` on `id`/`document_id` and only the `documents`/`document_chunks` tables** (`eval/harness/fake-edge.mts:37-43, 159-166`). D-17's query-counting test needs `in.(…)` (UUID list) and the voice fallback needs `or`/`ilike`/`not.is`. Extend the edge narrowly, keep rejecting everything else, and keep `edge_errors == 0` in the manifest.
- **P-04 Aborted postgrest calls resolve with an error object; they do not reject.** Check `signal.aborted` after every await.
- **P-05 Error vs empty.** `enhancedRetrieveChunks` returns `[]` on RPC errors and the embed route catches everything into "no relevant information". Make both throw into `error`, and keep `[]` only for true empties.
- **P-06 Strict refusal under `degraded`.** Make sure `degraded` with zero chunks never reaches `buildNoKnowledgeBaseResponse`. That builder supports only `es` and the English default (`chat/route.ts:594-613`); the new localized error message needs zh/en/it (plus es for parity).
- **P-07 `after()` outside a request scope** throws (Pattern 4).
- **P-08 Langfuse SDK picks up env implicitly** (anti-pattern above). A test must assert that with `LANGFUSE_ENABLED=false` and keys present, no HTTP request reaches the fake endpoint.
- **P-09 Embed error rendering.** The `chat.js` widget parses `0:`/`3:` lines and SSE `text-delta` only (`src/app/embed/chat.js/route.ts:929-990`); it ignores `{type:'error'}`. A `formatErrorSSE` error therefore shows nothing in third-party widgets (only `embed/window` via `useChat` would show it). Emit the localized message as a `text-delta` sequence as well, or add an `error` handler to `chat.js`. Its old `createErrorResponse` (`3:"…"` legacy v4) is the pattern CLAUDE.md forbids for new code.
- **P-10 Voice fallback queries are unscoped** (call graph #12). Add the tenant predicate with `documents!inner(user_id, organization_id)` and `.eq('documents.organization_id', oid)` / `.is('documents.organization_id', null).eq('documents.user_id', uid)` [ASSUMED: supabase-js inner-join filtering syntax; verify against the fake and live]. As a fallback, run a two-step lookup: first the in-scope document ids for the matching chunks, then filter.
- **P-11 `.or()` filter injection.** Voice builds `.or()` strings from user words (L138-140, 205-208, 239-247). `[^\w\s]` stripping removes commas, dots and parentheses (`\w` keeps `_`), so it is safe today. Keep that sanitiser byte-identical and add a test with `logo),id.eq.x`.
- **P-12 Sentinel digests.** `tests/legacy-post-filter-sentinel.test.ts:25-37` pins sha256 of two chat-route regions. Every chat-route edit breaks it, so retarget it at `src/lib/rag/context/assemble.ts` in the chat-switch plan (D-17).
- **P-13 `typecheck:new` path list.** `scripts/typecheck-new.mjs` `PHASE1_PATHS` and `tsconfig.typecheck-new.json` `include` must gain `src/lib/rag/**`, `scripts/ci/**` and the new tests, or new code is silently unchecked.
- **P-14 `legacy-peer-deps=true`.** npm will not install the Langfuse peers. Pin them explicitly and assert the versions (`npm ls @opentelemetry/sdk-trace-base`) in a test or CI step.
- **P-15 `RagRunOptions` changes reach the gate** (the `degrade` → exit 2 issue above).
- **P-16 `JudgeConfig` is `extra="forbid"`.** Add `online_judge` to the contract before editing `judge.json`.
- **P-17 Chat imports dead modules at module scope** (`retrieval-strategies` and friends, L10-17). Delete the imports in the chat-switch plan, *before* deleting the modules, or the deletion plan breaks the route at import time (the build ignores type errors until TS-Z, and `TS2307` would be the only signal).
- **P-18 OpenAI client instantiated at import** (`document-processor.ts:22-25`) and reading `OPENAI_BASE_URL` implicitly. The fixture harness relies on that (`fake-edge.mts:277-286`). The re-homed `embeddings/openai.ts` must keep the same construction, created lazily but from the same env.

## Code Examples

### Query-counting test (D-17)
```typescript
// tests/rag-assemble-query-count.test.mts (node --test via tsx, like fixture-edge.test.mts)
for (const n of [5, 25, 100]) {
  test(`assembleContext issues a fixed number of queries for ${n} chunks`, async () => {
    const edge = await startFakeEdge({ db });           // extended with in.() support
    const candidates = await seedCandidates(db, n);     // n chunks across ceil(n/3) documents
    edge.calls.length = 0;
    await assembleContext({ candidates, scope, adminClient: clientFor(edge.url), queryText: 'q', isGPTModel: false });
    const reads = edge.calls.filter(c => c.method === 'GET');
    assert.deepEqual(reads.map(c => c.path).sort(), ['/rest/v1/document_chunks', '/rest/v1/documents']);
  });
}
```
`FakeEdgeCall { method, path }` is already recorded per request [VERIFIED: eval/harness/fake-edge.mts:13-17, 134, 179].

### Differential byte-identity test (before deleting the inline code)
Copy the current inline loop (`chat/route.ts:2142-2346`) verbatim into `tests/fixtures/legacy-chat-assembly.ts`, including its N+1 calls. Run both implementations over the 72 fixture queries × `isGPTModel ∈ {true,false}` × `{no refs, one ref}` against the PGlite edge, and `assert.equal(newContext, oldContext)` plus deep-equal `usedDocuments`. Keep the copy as a frozen oracle until Phase 4.

## State of the Art

| Old approach | Current approach | When changed | Impact |
|---|---|---|---|
| Langfuse `POST /api/public/ingestion` (JS SDK ≤ v3) | OTLP `/api/public/otel/v1/traces` + `x-langfuse-ingestion-version: 4` | Sunset on Cloud 2026-11-16 | Use `@langfuse/otel` 6.x only |
| Trace entity with trace-level attributes | Observation-centric v4: copy tags/user/metadata to every span | Langfuse v4 | Tag filter for review queue depends on it |
| Single score object `POST /api/public/scores` | Array body, 202/207 | Current OpenAPI spec | Online judge client |
| `@opentelemetry/sdk-trace-base` | `@opentelemetry/sdk-trace` (base is a shim; 2.12.0 deprecated) | Nov 2026 | Pin base 2.12.1 because Langfuse peers on base |
| Sync `params` in route handlers | `params: Promise<…>` | Next 15 (sync removed in 16) | 7 hidden type errors are latent bugs |
| AI SDK v4 `args`/`result`/`experimental_providerMetadata` | v6 `input`/`output`/`providerMetadata` | AI SDK 5/6 | Chat-route reasoning capture is dead code today |

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|---|---|---|
| A1 | A root observation with a fabricated `parentSpanContext` shows as the trace root in Langfuse | Pattern 3 | Trace tree looks wrong in the UI; fallback is to store the OTel-generated trace ID after the replay (then message metadata is written later) |
| A2 | `exporter-trace-otlp-http` posts OTLP/JSON | Fake endpoint | The fake must decode protobuf instead |
| A3 | Hobby units = one per observation/score | Langfuse quota | Sample rate too high; costs or dropped data |
| A4 | Next 16 `req.signal` aborts on client disconnect | AbortSignal | Abort test passes but production never cancels; harmless for correctness |
| A5 | supabase-js `!inner` embedded filter syntax works for the voice tenant predicate | P-10 | Use the two-step lookup |
| A6 | `allowImportingTsExtensions` in the root tsconfig is accepted by `next build` | TS-A | Exclude `eval/` and `.mts` tests instead |
| A7 | Next 16 removed synchronous `params` access, so the 7 handlers misbehave today | TS cleanup | If a compatibility shim still exists, the fix is behaviour-preserving (lower risk) |
| A8 | PostgREST URL length is fine for 100 UUIDs | assembleContext | Chunk the `in()` into batches (query count still fixed per batch size) |
| A9 | `@langfuse/*@6.0.2` is a safe older fallback | Legitimacy | Re-run the peer check if used |
| A10 | `APIUserAbortError` is the openai v4 abort error class | AbortSignal | Detect abort from the signal instead (recommended anyway) |

## Open Questions

1. **D-27 range.** `>=22.12.0` deploys Node 26 on Vercel. Recommendation: `^22.12.0` (keeps D-27's intent).
2. **Does a config-disabled optional stage make the status `degraded`?** Recommendation: only runtime skips count; record config-disabled stages as `disabled`. Otherwise `RAG_DISABLED_STAGES=legacy_rank` disables strict refusal.
3. **Shared voice room.** Recommendation for Phase 2: single-active-user guard in the agent plus a server-fixed room. Per-user rooms go to the backlog.
4. **Embed error rendering** (P-09): emit text-delta, or patch `chat.js`.
5. **Online judge population** (F-4): judge only review-candidate traces with a non-OpenAI generator, or pin a second judge from another family for OpenAI-generated traces (a Phase 1 config decision).
6. **voice-agent / baileys own type-check counts** were not measured (no `node_modules`). Measure them in TS-A before committing to zero.
7. **`scripts/rag/reprocess-documents.js`** calls `embeddings.create` outside `src/`. In the boundary scope, or excepted until Phase 3?

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|---|---|---|---|---|
| Node.js | everything | ✓ | v22.23.5 | — |
| npm | install | ✓ | 10.9.9 | — |
| `uv` + Python 3.12 | eval/sidecar tests | ✓ (Phase 1 ran `uv run`) | uv 0.11.32 pinned | — |
| PGlite + pgvector (npm) | fixture edge | ✓ | `@electric-sql/pglite` 0.5.17 | — |
| `voice-agent/node_modules` | agent type-check and tests | ✗ | — | `npm ci` in a plan; never committed |
| Supabase project, Langfuse keys, LiveKit, Docker | live verification | ✗ | — | ROADMAP live items (human) |
| Network to npm registry | install | ✓ (via proxy) | — | — |

**Missing with no fallback:** none for automated work. Live items stay human.

## Validation Architecture

### Test framework
| Property | Value |
|---|---|
| Frameworks | vitest 5.1.1 (`tests/**/*.test.ts`), `node --test` via tsx 4.23.15 (`tests/*.test.mts`, `scripts/**/*.node-test.mjs`/`*.test.mjs`), pytest 9.2.0 (`eval/tests`, `rag-sidecar/tests`) |
| Config | `vitest.config.ts` (alias `@` → `src`, setup `tests/setup-env.ts`), `eval/pyproject.toml` |
| Quick run | `npx vitest run tests/rag` |
| Full suite | `npx vitest run && node --import tsx --test tests/*.test.mts && node --test scripts/check-config.test.mjs scripts/typecheck-new.test.mjs scripts/tests/*.node-test.mjs && uv run --directory eval pytest -q && uv run --directory rag-sidecar pytest -q && npm run test-rag` |

### Phase requirements → test map
| Req | Behaviour | Type | Automated command | Exists? |
|---|---|---|---|---|
| PIPE-01 | No embedding/RPC/reranker use outside `src/lib/rag/`; self-test | static | `node scripts/ci/check-rag-boundary.mjs && node --test scripts/tests/check-rag-boundary.node-test.mjs` | ❌ Wave 0 |
| PIPE-01 | Chat, embed, voice, media and eval call `runRetrieval` (spy) | unit | `npx vitest run tests/rag/entrypoints-call-pipeline.test.ts` | ❌ |
| PIPE-02 | Brand: hand-built literal rejected at type and runtime level | type + unit | `npm run typecheck:new && npx vitest run tests/rag/tenant-brand.test.ts` | ❌ |
| PIPE-02 | Non-member `organizationId` → 403 before stream, no retrieval; member → `o:`; none → `u:`; no session → `empty/no_tenant`; single-tenant → `s:default` | unit (two-tenant fake) | `npx vitest run tests/rag/resolve-chat-scope.test.ts` | ❌ |
| PIPE-02 | Two-tenant PGlite: personal B's chunks never returned to A through the real RPC; `@mention` of B's filename ignored | integration | `node --import tsx --test tests/rag-two-tenant.test.mts` | ❌ |
| PIPE-03 | `RAG_EMBED_TENANT` unset in multi-tenant → `error/embed_tenant_unconfigured`; body workspace mismatch → 403; nonexistent org → error | unit | `npx vitest run tests/rag/embed-scope.test.ts` | ❌ |
| PIPE-04 | Token mint/verify: forged, expired, wrong aud, short secret, bare userId → 401; membership revoked → 401/403; no global fallback RPC ever called | unit | `npx vitest run tests/rag/voice-token.test.ts tests/rag/voice-rag-route.test.ts` | ❌ |
| PIPE-04 | LiveKit token route: identity server-derived, metadata carries the token, no `canUpdateOwnMetadata` | unit | `npx vitest run tests/rag/livekit-token-route.test.ts` | ❌ |
| PIPE-04 | Agent forwards `x-rag-scope-token`, speaks the fallback on 401/503 | unit (voice-agent) | `cd voice-agent && npx tsx --test src/__tests__/rag_client.test.ts` | ❌ (needs voice-agent install) |
| PIPE-05 | Characterization of embed and voice outputs before the switch; chat byte-identical differential | unit/integration | `npx vitest run tests/rag/characterize-embed.test.ts tests/rag/characterize-voice.test.ts && node --import tsx --test tests/rag-assemble-differential.test.mts` | ❌ |
| PIPE-05 | Fixed query count at 5/25/100 chunks | integration | `node --import tsx --test tests/rag-assemble-query-count.test.mts` | ❌ |
| PIPE-06 | Fault injection: embed throws → `error`, RPC error → `error` (not `[]`), optional stage throws → `degraded`; refusal only on `empty`; chat streams localized error | unit | `npx vitest run tests/rag/status.test.ts tests/chat-strict.test.ts` | ❌ / ✅ (retarget) |
| PIPE-07 | Each optional stage disabled by `RAG_DISABLED_STAGES`; core stage listed → rejected and logged; timeout → skip; abort → all in-flight fetches see `signal.aborted` | unit | `npx vitest run tests/rag/stage-runner.test.ts tests/rag/config.test.ts` | ❌ |
| PIPE-08 | Deleted modules absent; no `TS2307` on them; ratchet | static | `node scripts/ci/check-rag-boundary.mjs && node scripts/ci/tsc-ratchet.mjs` | ❌ |
| PIPE-09 | Smoke tier through pipeline passes gate; all paired diffs zero | e2e | `npm run test-rag -- --out eval/out/smoke && jq -e '.paired.all_zero == true' eval/out/smoke/gate.json` | partial (✅ test-rag; ❌ paired) |
| PIPE-09 | Negative control: `degrade=drop_top_candidate` exits 10 with ≥ 0.05 MRR margin; `max_results=1` still 10 | e2e | `npm run test-rag -- --degrade drop_top_candidate --out eval/out/neg; test $? -eq 10` | ❌ |
| PIPE-10 | engines present, major 22, Dockerfile node:22, `.nvmrc` | static | `node scripts/ci/check-node-runtime.mjs && node --test scripts/tests/check-node-runtime.node-test.mjs` | ❌ |
| OBS-01 | One trace, span per stage, attributes, response finishes before export, fallback log when off/unreachable/unsampled, no content unless enabled, PII masked, no request with `LANGFUSE_ENABLED=false` | integration (fake OTLP) | `node --import tsx --test tests/rag-langfuse-export.test.mts` | ❌ |
| OBS-01 | Trace ID in assistant message metadata | unit | `npx vitest run tests/chat-messages-roundtrip.test.ts` | ✅ (extend) |
| OBS-02 | Report shows per-stage p50/p95 vs budgets; `LatencyBudgets` validates | unit | `uv run --directory eval pytest -q tests/test_latency_report.py` | ❌ |
| EVAL-14 | New categories/provenance validate; coverage ≥ 2 per language; `by_provenance(_category)`; gate on production subset | unit | `uv run --directory eval pytest -q tests/test_fixture_coverage.py tests/test_report_runner.py tests/test_gate.py` | ✅ (extend) |
| EVAL-14 | Paired bootstrap deterministic (fixed seed), zero diffs → [0,0] | unit | `uv run --directory eval pytest -q tests/test_paired.py` | ❌ |
| EVAL-15 | Review-queue pull pages via cursor and tag filter; promote → draft `GoldenItem(provenance=production)` into gitignored path only | unit (fake Langfuse) | `uv run --directory eval pytest -q tests/test_review_queue.py` | ❌ |
| EVAL-15 | Online judge with stub judge posts an array to `/api/public/scores`, handles 207 without retry, skips same-family, skips without keys | unit | `uv run --directory eval pytest -q tests/test_online_judge.py` | ❌ |
| SC1/D-15 | Zero tsc errors (ratchet until then) | static | `npx next typegen && npx tsc --noEmit -p tsconfig.json` | ❌ (312 today) |
| D-28 | New env vars in all five locations | static | `node scripts/check-config.mjs` | ✅ (extend pattern) |
| CI | Workflow structure incl. new jobs | static | `uv run --directory eval python ../scripts/ci/check-workflows.py` | ✅ (extend) |

### Sampling rate
- **Per task commit:** `npx vitest run tests/rag` + `node scripts/ci/check-rag-boundary.mjs` + `npm run typecheck:new`
- **Per wave merge:** full suite above
- **Phase gate:** full suite green, `npm run test-rag` gate PASS with all-zero paired diffs before golden changes, negative control exit 10, `tsc --noEmit` zero

### Wave 0 gaps
- [ ] `tests/helpers/chat-route-fakes.ts`: real `in`/`is` semantics and a call recorder (P-02)
- [ ] `eval/harness/fake-edge.mts`: `in.(uuid,…)` on `id`, plus the voice-fallback operators (P-03); `organization_members`/`organizations` tables in a two-tenant PGlite seed helper (not in the default corpus, so `corpus_sha256` is unchanged)
- [ ] `tests/helpers/fake-langfuse.mts`: OTLP + observations + scores fake
- [ ] `tests/rag/` directory registered in `tsconfig.typecheck-new.json` and `PHASE1_PATHS`
- [ ] `voice-agent` test runner: none exists; add `tsx --test` and a devDependency pin (record versions when added)

## Security Domain

### Applicable ASVS categories (Level 1)
| Category | Applies | Control |
|---|---|---|
| V2 Authentication | yes | Supabase SSR `auth.getUser()` (server-verified JWT), not `getSession()` |
| V3 Session management | yes | Voice token TTL 3600 s, `aud`, `exp`, `iat` checks; no refresh (deferred) |
| V4 Access control | yes | Membership check against `organization_members`; branded scope; fail closed; 403 before streaming |
| V5 Input validation | yes | Zod (`zod/v3`) on bodies; UUID shape for org ids; `.or()` sanitiser (P-11); raw-body workspace check for embed |
| V6 Cryptography | yes | `node:crypto` HMAC-SHA256 + `timingSafeEqual`; secret ≥ 32 chars; never hand-roll base64url (use `Buffer.toString('base64url')`) |
| V7 Logging | yes | `[RAG Trace]` without query or chunk text; never log tokens or keys (log presence and length); PII masking before export |
| V8 Data protection | yes | Content capture off by default; review queue JSONL in gitignored `eval/golden/private/review-queue/` (reuse `assert_private_path`) |

### Known threat patterns
| Pattern | STRIDE | Mitigation |
|---|---|---|
| Forged `organizationId` in body | Elevation | Membership check, 403 |
| Unscoped legacy RPC via admin client (`match_document_chunks`) | Info disclosure | Deleted from every path; boundary check bans `.rpc('match_` outside `rag/` |
| Voice token replay by another room participant | Spoofing | Token requires `x-api-key`; `canUpdateOwnMetadata` off; membership re-check; single-active-user guard |
| Timing attack on HMAC | Info disclosure | `timingSafeEqual` on fixed-length digests |
| Document-reference ids from the client | Info disclosure | Tenant predicate on ref fetch; ignore and log |
| PostgREST `.or()` injection | Tampering | Keep the sanitiser; test |
| PII in traces | Info disclosure | Masking, sampling, default off |
| `debug_info` leak in voice-rag | Info disclosure | Remove |

## Voice One-Way Deploy: Risk List (D-10)

- **R-1 Cross-user scope mixing in the shared room** (above). Highest. Mitigate in the agent.
- **R-2 Version skew.** An old agent sends no token and gets 401 → no knowledge-base answers; a new agent with an old app sends the header, which is ignored → still works (bare userId). Deploy order: **agent first** (it sends the header, harmless to the old app), then the app. Write that in the plan and the docs. The agent change must not *require* the token to exist in metadata before the app ships, so it tolerates missing metadata and sends no header.
- **R-3 Metadata visibility.** Other participants can read the token and uid. Keep the payload minimal (no e-mail).
- **R-4 TTL expiry mid-session** (3600 s, no refresh). After an hour, retrieval returns 401; the agent must say so. Refresh is deferred.
- **R-5 Agent swallows errors** (`rag_client.ts:105-108`) → silent empty context. Change it to a typed result so 401/503 produce the spoken message (D-06).
- **R-6 Node 22 image change** alongside the protocol change. `@livekit/rtc-node` ships native binaries. Build and smoke the image (LiveKit connect) before release [ASSUMED: binaries available for Node 22 linux-x64].
- **R-7 Secret drift.** `RAG_VOICE_TOKEN_SECRET` < 32 chars or unset → minting refuses → voice silently loses the knowledge base. Log at startup and have `check-config` treat it as required in multi-tenant.
- **R-8 voice-chat writes** start using token uid/oid instead of the body. Old agents saving chats get 401, so voice conversations are not saved until the agent is updated.
- **R-9 Rollback.** Rolling back only the app restores bare-userId behaviour (and the global fallback). Rolling back only the agent breaks retrieval. Document a paired rollback.

## Sources

### Primary (HIGH)
- Repository files read this session: `src/app/api/chat/route.ts` (L1-45, 546-613, 1213, 1880-2720), `src/app/api/embed/chat/route.ts`, `src/app/api/internal/voice-rag/route.ts`, `voice-chat/route.ts`, `livekit/token/route.ts`, `internal/rag/run/route.ts`, `generate-image` (L250-310), `generate-video` (L200-260), `src/lib/enhanced-rag-retrieval.ts`, `document-processor.ts` (L1-110), `supabase.ts`, `supabase/server.ts`, `rag-eval/{trace,auth,legacy-post-filter}.ts`, `voice-agent/src/{agent,rag_client,voice_agent}.ts`, `supabase/multi-tenant-setup.sql` (L90-240, 560-800), `single-tenant-setup.sql` (L270-330), `eval/harness/{fake-edge,pglite-supabase}.mts`, `eval/src/rag_eval/{gate,metrics,report}.py`, `rag-sidecar/src/rag_sidecar/contracts/{golden,baseline,eval_run,report,judge}.py`, `.github/workflows/{pr-smoke,nightly}.yml`, `scripts/ci/check-workflows.py`, `scripts/check-config.mjs`, `tsconfig*.json`, `next.config.js`, `.vercelignore`
- npm registry (`npm view`, `npm pack`): `@langfuse/{tracing,otel,core}@6.1.1` dist and d.ts; `@opentelemetry/*` versions, engines, peers; `@livekit/rtc-node@0.13.22`
- `node_modules`: `next@16.4.6` `after` implementation and bundled docs; `@supabase/postgrest-js@2.76.1`; `openai@4.104.0`; `livekit-server-sdk@2.15.0`
- Langfuse OpenAPI spec: https://cloud.langfuse.com/generated/api/openapi.yml (`/api/public/scores`, `/api/public/v2/observations`)
- `npx tsc --noEmit -p tsconfig.json` (312) and `npx next typegen` + tsc (319), run this session

### Secondary (MEDIUM)
- https://langfuse.com/docs/observability/sdk/typescript/setup ; https://langfuse.com/docs/observability/sdk/typescript/advanced-usage
- https://langfuse.com/integrations/native/opentelemetry/migration-to-v4
- https://langfuse.com/docs/compatibility (2026-11-16 sunset)
- https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk
- https://vercel.com/docs/functions/runtimes/node-js/node-js-versions

### Tertiary (LOW)
- Assumptions A1-A10

## Metadata

**Confidence breakdown:**
- Call graph, tenant SQL, assembly rules: HIGH (read line by line)
- Standard stack pins: HIGH (registry plus dist inspection); legitimacy flags are age-only
- Langfuse wire details: MEDIUM-HIGH (spec plus package internals; no live call)
- Type-error triage: HIGH for counts; MEDIUM for "risky" classification of the hidden route-param errors (A7)
- Pitfalls: HIGH

**Research date:** 2026-11-23
**Valid until:** 2026-12-07 (Langfuse and OTel move weekly; re-check pins at install time)
