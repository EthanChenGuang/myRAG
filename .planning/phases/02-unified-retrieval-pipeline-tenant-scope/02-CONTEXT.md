# Phase 2: Unified Retrieval Pipeline & Tenant Scope - Context

**Gathered:** 2026-11-23
**Status:** Ready for planning
**Mode:** `--auto` (every gray area resolved with the recommended option; the user's standing instruction is "all questions follow your recommendations")

<domain>
## Phase Boundary

Text chat, embedded chat and voice (plus every other server path that searches the knowledge base) get their context from one module, `src/lib/rag/`, that can only search a tenant verified on the server. With `RAG_PIPELINE=legacy` and every new switch off, answers are unchanged from the Phase 1 baseline.

In scope:
- `src/lib/rag/` with a branded `TenantScope`, `resolveTenantScope()` (chat), embed-config scope, signed voice token scope, a stage runner (switch, timeout, degrade-to-skip, `AbortSignal`), a discriminated result status (`ok | empty | error | degraded`) and one shared context-assembly step without N+1 lookups.
- Re-homing today's live retrieval logic (`enhancedRetrieveChunks`, the chat route post-filter, `createEnhancedRAGPrompt`, the voice local reranker) and deleting the unused retrieval modules; a CI boundary check.
- Langfuse tracing (one trace per request, one span per stage) with a `[RAG Trace]` log fallback; latency budgets and per-stage p50/p95 in eval reports.
- Eval additions: legacy-parity proof, paired-difference tool, a stronger negative control, `colloquial` / `ambiguous` / `typo` categories, provenance slices, a production review queue and an online judge.
- Node.js 22 as the enforced runtime.

Out of scope (other phases): hybrid search, new RPCs, rerankers (Phase 4); ingestion unification and embedding profiles (Phase 3); citations and groundedness (Phase 5); query transforms, rewrite gate, semantic cache (Phase 6); Weaviate/Qdrant (Phase 7). Phase 2 must leave clean seams for them (backend interface takes `TenantScope`; trace spans for later stages; the cache in Phase 6 reuses `TenantScope`).

</domain>

<decisions>
## Implementation Decisions

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
- **D-15:** Type-checking for success criterion 1: `src/lib/rag/**` and every file Phase 2 creates join `typecheck:new` (zero errors). The full `tsc --noEmit` gets a per-file ratchet against a committed baseline (312 errors today, mostly in WhatsApp, MCP and UI code): no file may gain errors and no `TS2307` may point at a removed module; the deletions lower the count. Fixing the legacy errors is out of scope

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

### Decision index
IDs cited by the plans; each entry summarizes a decision recorded above in this file.
- **D-01:** one public entry `runRetrieval({scope, query, profile, documentRefs, options, signal, trace})` in `src/lib/rag/` returning a `RetrievalResult`; routes import only `@/lib/rag` (costly)
- **D-02:** `RAG_PIPELINE=legacy|v2` default legacy; only legacy implemented (re-homed enhancedRetrieveChunks, identical behavior); unknown value logs once and runs legacy
- **D-03:** stage runner `{name, enabled, timeoutMs, onFail}`; stages analyze, embed, search, legacy_rank, post_filter, assemble (+ voice_keyword_fallback, local_rerank); core throws, optional skips; AbortSignal into every stage, fetch and Supabase query
- **D-04:** `RAG_DISABLED_STAGES` (optional stages only) and `RAG_STAGE_TIMEOUTS` override per-profile code defaults; per-request overrides only via the eval endpoint
- **D-05:** status: empty only when all core stages succeeded, nothing skipped, zero chunks; error on core failure/timeout/abort; degraded when an optional stage was skipped (costly)
- **D-06:** chat strict refusal only on status empty; error and degraded-without-results stream a localized in-band error; embed same; voice-rag returns structured 503
- **D-07:** branded TenantScope (single|personal|org, tenantKey s:default|u:<uuid>|o:<uuid>) minted only in `src/lib/rag/tenant/`; type test plus runtime brand check; predicate equals match_documents_by_workspace semantics (costly)
- **D-08:** chat scope: single-tenant s:default; multi-tenant user from SSR session, body organizationId verified against organization_members, non-member 403 before streaming, no org = personal, no session = empty/no_tenant
- **D-09:** embed scope from `RAG_EMBED_TENANT`; single-tenant default s:default; multi-tenant unset fails closed; body naming a different workspace gets 403; per-widget keys deferred
- **D-10:** voice scope from an HMAC-SHA256 voice RAG token minted by /api/livekit/token (server-derived identity, participant metadata, `RAG_VOICE_TOKEN_SECRET` >= 32 chars, `RAG_VOICE_TOKEN_TTL_SECONDS` 3600), forwarded as x-rag-scope-token; missing/expired/forged/bare userId gets 401; global fallback deleted (one-way)
- **D-11:** tenant enforcement has no off switch; eval endpoint keeps Phase 1 auth and mints via evalScope()
- **D-12:** generate-image, generate-video, the chat general-overview fallback and @mention/document-reference fetches go through the pipeline with the caller's scope; out-of-scope references ignored and logged
- **D-13:** delete retrieval-strategies, optimized-search, adaptive-retrieval, reranker-adapter, query-enhancer-local, bm25-scorer, mmr-scorer, dead thinking-rag-enhancer functions, searchSimilarChunks; re-home enhancedRetrieveChunks, temporal-query-detector, createEnhancedRAGPrompt, hybridRerank, OpenAI embedding; deletions in their own plan after extraction
- **D-14:** CI boundary check scripts/ci/check-rag-boundary.mjs with self-test: no embeddings.create, retrieval RPCs, retired-module imports, deep @/lib/rag/* imports or vector/reranker clients outside src/lib/rag/
- **D-15:** SC1 type-check = zero errors in src/lib/rag/** and new files via typecheck:new, plus a per-file ratchet over full tsc --noEmit against a committed baseline (312 today) with no TS2307 on removed modules
- **D-16:** one assembleContext() reproducing the chat post-filter and format byte-identically; embed uses it; voice keeps {context, sources, source_images}; embed/voice characterization tests first; voice heuristics move unchanged into a voice-only stage
- **D-17:** documents and chunk metadata fetched with one in() query each; query-counting test at 5/25/100 chunks; no RPC changes; legacy-post-filter replica replaced and sentinels retargeted
- **D-18:** Langfuse via @langfuse/tracing + @langfuse/otel 6.x on an isolated tracer provider, OTLP exporter pinned to the peer range; no legacy ingestion endpoint; scores via POST /api/public/scores; flush in after(); exporter errors fall back to the log (costly)
- **D-19:** LANGFUSE_ENABLED false, PUBLIC_KEY, SECRET_KEY, BASE_URL https://cloud.langfuse.com, SAMPLE_RATE 0.1, CAPTURE_CONTENT false; one trace per request tagged tenantKey; span per stage with latency_ms, candidates_in/out, status, rules; span names = stage_latency_ms keys; trace ID in message metadata
- **D-20:** one internal trace collector feeds eval traces and Langfuse; `[RAG Trace]` single log line fallback without content; fake OTLP endpoint test
- **D-21:** budgets: text/embed retrieval p50 1000 ms / p95 2000 ms (embed 200, search 400, assemble 100 p95); voice p50 400 / p95 800; eval/config/latency-budgets.json (Pydantic LatencyBudgets); report-only in Phase 2
- **D-22:** parity proven first on the unchanged Phase 1 golden set and baseline (gate exit 0, all paired diffs zero) before golden changes
- **D-23:** baseline gains per-item rows; rag_eval.paired computes per-item paired diffs, mean and fixed-seed bootstrap 95% interval per gated slice in the gate report; noise-band rule kept
- **D-24:** eval-only `degrade: drop_top_candidate` override; CI negative control asserts exit 10 and >= 0.05 margin on overall MRR; max_results=1 kept as second control
- **D-25:** Category += colloquial, ambiguous, typo; Provenance += production; >= 2 approved fixture items per new category per language; by_provenance and by_provenance_category; gate on production items when present; baseline re-recorded with zero paired diffs on old items (costly)
- **D-26:** LANGFUSE_REVIEW_SAMPLE_RATE (default 0) exports PII-masked content tagged review_candidate; rag_eval.review_queue pull/promote to gitignored eval/golden/private/review-queue/; rag_eval.online_judge posts faithfulness and answer relevance scores; nightly, skipped without keys; fake Langfuse + stub judge tests
- **D-27:** Node 22: engines >=22.12.0, .nvmrc 22, voice-agent Dockerfile node:22-slim, docs updated, CI runtime/engines check; baileys stays on 20; Vercel setting is live verification
- **D-28:** all new env vars in the five config locations and managed in env-manifest; RAG_FINAL_RESULT_COUNT added to env.ts; placeholder secrets only
- **D-29:** order: embed/voice characterization, rag core, one entry point per plan, deletions + boundary check, parity, then golden-set changes

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and requirements
- `.planning/ROADMAP.md` §"Phase 2: Unified Retrieval Pipeline & Tenant Scope" — goal, seven success criteria, live verification
- `.planning/REQUIREMENTS.md` — PIPE-01..PIPE-10, OBS-01, OBS-02, EVAL-14, EVAL-15
- `.planning/PROJECT.md` §Constraints and §Key Decisions — Langfuse Cloud Hobby (locked), semantic cache (Phase 6, reuses TenantScope), config sync, no secrets

### Research
- `.planning/research/ARCHITECTURE.md` — `src/lib/rag/` layout, TenantScope sketch, stage runner, consolidation table, latency budgets, open questions on embed and voice tenancy (answered by D-09, D-10)
- `.planning/research/PITFALLS.md` — cross-tenant leakage, latency stacking, monolithic route refactor, logging
- `.planning/research/SUMMARY.md` §"Phase 2"
- `.planning/specs/semantic-cache.md` — Phase 6 contract that consumes TenantScope and a `semantic_cache` span (seam only)
- `.planning/specs/query-rewrite-gate.md` — Phase 6 rule IDs that later fill the span `rules` field (seam only)

### Phase 1 artifacts
- `.planning/phases/01-evaluation-harness-baseline/01-CONTEXT.md` — D-01..D-25 (fixture edge fakes, eval endpoint contract, noise band, gate, judge)
- `.planning/phases/01-evaluation-harness-baseline/01-VERIFICATION.md` — advisories: thin negative-control margin (0.5532 vs 0.5545), no paired-difference tool
- `.planning/phases/01-evaluation-harness-baseline/01-REVIEW.md` — WR-01 (eval scope allow-list), WR-05/06 (gate identity, live scoping)

### Code
- `src/app/api/chat/route.ts` (~L1898-2600 retrieval, document references, post-filter, assembly, strict refusal; ~L2615 workspace prompt lookup by body organizationId)
- `src/app/api/embed/chat/route.ts`, `src/app/api/internal/voice-rag/route.ts`, `src/app/api/internal/voice-chat/route.ts`, `src/app/api/livekit/token/route.ts`
- `voice-agent/src/agent.ts` (identity parsing ~L320), `voice-agent/src/voice_agent.ts`, `voice-agent/src/rag_client.ts`
- `src/app/api/generate-image/route.ts` (~L268), `src/app/api/generate-video/route.ts` (~L210)
- `src/lib/enhanced-rag-retrieval.ts`, `src/lib/reranker-local.ts`, `src/lib/thinking-rag-enhancer.ts`, `src/lib/document-processor.ts` (`getQueryEmbedding`), `src/lib/supabase.ts`
- `src/app/api/internal/rag/run/route.ts`, `src/lib/rag-eval/*`, `eval/harness/*`, `eval/src/rag_eval/*`, `rag-sidecar/src/rag_sidecar/contracts/*`
- `supabase/multi-tenant-setup.sql` (`organization_members` L96, `is_org_member` L564, `match_documents_by_workspace` L692)
- `scripts/rag/env-manifest.json`, `scripts/check-config.mjs`, `scripts/typecheck-new.mjs`, `.github/workflows/pr-smoke.yml`, `.github/workflows/nightly.yml`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 1 eval stack: fake PostgREST edge on PGlite and fake embeddings (`eval/harness/fake-edge.mts`, `pglite-supabase.mts`), in-process route invocation, the gate and baseline (`eval/src/rag_eval/gate.py`, `baseline.py`), Pydantic → Zod generation (`npm run gen:schemas`), check-config manifest.
- `tests/helpers/chat-route-fakes.ts` and the characterization tests (`tests/chat-strict.test.ts`, `chat-websearch`, `chat-source-images`, `prompt-context`) lock the behaviors that must survive.
- `src/lib/rag-eval/legacy-post-filter.ts` is an exact replica of the chat post-filter; it is the starting point for `assembleContext()`.
- `src/lib/rag-eval/auth.ts` has constant-time secret comparison to reuse for the voice token.
- `src/lib/error-stream.ts` `formatErrorSSE` for in-band errors; `buildNoKnowledgeBaseResponse` for localized messages.

### Established Patterns
- Zod via `zod/v3`, `validateRequest`, structured JSON errors; bracketed log prefixes (`[Document Search]`, `[RAG Trace]`); env read through `src/lib/env.ts`.
- `enhancedRetrieveChunks` swallows RPC errors into `[]` (the root cause of errors becoming "information not available"; D-05 fixes it).
- Tenant handling today: chat trusts body `organizationId`; embed passes no scope; voice trusts caller `userId` and falls back to a global search; generate-image/video search globally; `/api/livekit/token` is unauthenticated and trusts `username`.

### Integration Points
- New `src/lib/rag/` tree; the three entry routes, eval route, media routes, LiveKit token route and the voice agent.
- `package.json` (engines, new deps), `.nvmrc`, CI workflows (boundary check, tsc ratchet, runtime check, stronger negative control, online judge in nightly).
- Contracts: `GoldenItem` categories/provenance, `Baseline` per-item rows, `EvalReport` provenance slices and latency percentiles, new `ReviewQueueItem`, `LatencyBudgets`.

</code_context>

<specifics>
## Specific Ideas

- Langfuse Cloud Hobby is locked (PROJECT.md Key Decisions); switching to self-hosted must need only `LANGFUSE_BASE_URL` and keys.
- Multi-tenant safety is the top risk: every new read path must be tested with a two-tenant fixture (personal vs organization, non-member, forged token).
- No live keys, Supabase project or Docker daemon here; live checks are the ROADMAP live verification items.

</specifics>

<deferred>
## Deferred Ideas

- Per-widget embed keys (several widgets per tenant, stored in a table) — new capability, later phase or backlog.
- WhatsApp tenancy in multi-tenant mode (scope from the session owner) — backlog; Phase 2 keeps today's empty retrieval for anonymous calls.
- Voice token refresh for sessions longer than the TTL — backlog.
- Removing voice's hard-coded keyword and image heuristics — after eval shows they are unnecessary (Phase 4 or later).
- Revoking the `anon` grants on legacy RPCs (`match_documents_by_workspace`) — tracked in `.planning/codebase/CONCERNS.md`, separate security work.
- Gating on latency budgets — later phases, on live measurements.

</deferred>

---

*Phase: 02-unified-retrieval-pipeline-tenant-scope*
*Context gathered: 2026-11-23*
