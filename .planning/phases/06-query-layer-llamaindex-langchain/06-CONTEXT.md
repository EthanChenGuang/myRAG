# Phase 6: Query Layer (LlamaIndex & LangChain) - Context

**Gathered:** 2026-11-24
**Status:** Ready for planning
**Mode:** `--auto`. Every gray area was resolved with the recommended option, per the user's standing instruction "all questions follow your recommendations". The locked specs `.planning/specs/query-rewrite-gate.md` (LAT-03) and `.planning/specs/semantic-cache.md` (CACHE-01) were not re-opened; the decisions below only settle what those specs leave open.

<domain>
## Phase Boundary

This phase adds a query layer in front of the Phase 4 `RAG_PIPELINE=v2` retrieval inside `src/lib/rag/`. It does six things:
- a rule-based rewrite gate (locked spec) and a router that reuses the existing query classifier, so each query runs only the transforms it needs;
- native TypeScript ports of the LlamaIndex methods (condense-question rewrite, query fusion with RRF, HyDE, sub-question generation without answer synthesis), with no framework call at query time (default framework);
- a switchable LangChain implementation built on `@langchain/classic`, confined to one adapter that wraps the `src/lib/rag/` pipeline as its retriever, with zod 4 isolated from the app's zod 3;
- the real small-model query translator (XLG-01) plugged into the Phase 4 D-22 `translate` slot;
- a reduced voice profile (history rewrite and date normalization only, then the Phase 4 hybrid + fast-rerank path);
- a semantic answer cache (locked spec), default backend pgvector, optional RedisVL in the sidecar.

Every transform has its own switch, timeout and latency budget; the original query is always retrieved. Both frameworks are compared in eval with paired differences per language and category.

In scope: QRY-01 to QRY-08, LAT-03, XLG-01, CACHE-01.

Out of scope:
- New retrieval backends, sync and the full RET-08 canary suite on Weaviate and Qdrant: Phase 7. This phase adds the cache cases to the canary suite that already exists on pgvector.
- Changing the Phase 4 contracts (`RetrievalBackend`, RRF module, reranker interface, refusal calibration, `retrievalConfigHash`). This phase consumes them.
- Citations and groundedness scoring: Phase 5. The cache reads Phase 5's citation record and groundedness status when they exist.
- Prompt-injection tagging: Phase 5.1. This phase only makes sure the rewrite output cannot widen scope or bypass Phase 5.1 handling.
- Choosing shipped defaults: Phase 7 (ADM-02). The query layer and the cache stay off by default.

</domain>

<decisions>
## Implementation Decisions

### Module layout and the framework seam
- **D-01:** Everything lives under `src/lib/rag/query/` (and `src/lib/rag/cache/` for CACHE-01):
  - `rewrite-gate.ts` and `rewrite-gate.lexicon.json`, exactly as the locked spec names them.
  - `router.ts`: gate result + classifier result + switches + profile → the list of transforms to run.
  - `dates.ts`: deterministic relative-time normalization (R2).
  - `protected.ts`: protected-token extraction (R4/R7) and the post-rewrite verbatim check, shared by both frameworks.
  - `llm.ts`: the one query-LLM client (D-11), used by the native implementation.
  - `llamaindex/`: native ports (condense, fusion variants, HyDE, sub-questions) and their prompts.
  - `langchain/`: the only place LangChain may be imported (D-15).
  - `plan.ts`: builds the `QueryPlan` and hands its variants to the Phase 4 `queryVariants` seam.
- **D-02:** One framework interface, `QueryTransformer { framework: 'llamaindex' | 'langchain'; condense; expand; hyde; decompose; translate }`. Each method takes the shared inputs (standalone query, history window, language, protected tokens, limits, `AbortSignal`) and returns the shared Zod-validated outputs. The gate, router, date normalization, protected-token check, variant caps, budgets and tracing are framework-independent and run identically under both. Only the LLM-generating step differs between frameworks.
- **D-03:** The output contract is a Pydantic `QueryPlan` (generated to Zod through `npm run gen:schemas`):
  - `original`, `standalone` (condensed text or the original), `language`, `gate` (the spec's `GateResult`), `dateRange?`;
  - `variants: { text, language, kind: 'original' | 'condensed' | 'expanded' | 'hyde' | 'sub_question' | 'translated', subQuestionIndex?, protectedOk }[]`;
  - `subQuestions: string[]` (0 to 4), `skipped: { transform, reason }[]`, `framework`.

  The per-transform LLM outputs are their own Pydantic models: `CondensedQuery`, `QueryVariants`, `HypotheticalDocument`, `SubQuestions`, `QueryTranslation`. Both frameworks must return these exact shapes; the comparison tests assert shape equality on the fixture inputs.
  - **Reversibility:** costly — the eval trace, the LangChain adapter, the cache key and the Phase 7 regression all read this contract.

### Pipeline integration
- **D-04:** The query layer runs only under `RAG_PIPELINE=v2`, behind a master switch `RAG_QUERY_LAYER` (default `false`). With the switch off, or under `legacy`, the pipeline is byte-identical to Phase 4 (the Phase 2/4 parity tests stay green). Setting it under `legacy` logs once and does nothing.
- **D-05:** New optional stages in the Phase 2 stage runner, before `embed`: `query_gate`, `condense`, `normalize_dates`, `translate` (the existing Phase 4 slot, now served by the real translator), `expand`, `hyde`, `decompose`, and `semantic_cache` for the cache lookup. These names become `stage_latency_ms` keys (Pydantic `StageName` and `StageTimeoutsMs` extended) and Langfuse span names. Order: `query_gate` → `condense` → (`normalize_dates`, `translate`, `expand`, `hyde`, `decompose` in parallel on the standalone query) → `semantic_cache` (chat/embed) → `embed` → the Phase 4 v2 graph.
- **D-06:** Retrieval of variants reuses Phase 4 D-13 unchanged: every variant is searched in parallel through `hybrid_search_chunks` with the shared signal, all lists are fused once by the shared `fusion/rrf.ts` (k = 60, equal weights, chunk-ID tie-break), deduplicated, capped, and reranked once. All variant texts are embedded in one `embedBatch` call. The rerank query and the refusal decision always use the standalone query, never a HyDE text or a variant, so HyDE cannot turn a no-answer item into an answer (Pitfall: HyDE false answers).
- **D-07:** Sub-question coverage: after the single rerank, the final top-k reserves the best chunk of each sub-question that has none in the top-k (at most 4 reservations, replacing the lowest-ranked entries). It is a field in `eval/config/retrieval-params.json` (`subQuestionCoverage`, default `true` when decomposition ran) so the sweep can turn it off. No per-sub-question rerank.
- **D-08:** Variant limits (LAT-03): at most 2 LLM variants by default (`expand` + `hyde` + `condensed` combined, the original not counted), at most 2 translated variants, at most 4 sub-questions, and a hard cap of 8 parallel searches per request. The limits live in a committed `eval/config/query-params.json` (Pydantic `QueryParams`), read at startup, with eval-only per-request overrides, following the Phase 4 D-12 pattern.

### Router and gate
- **D-09:** The router combines the locked gate with the existing `classifyQuery` result:
  - The route already calls `classifyQuery` once per request; it passes the result into `runRetrieval` (new optional `classification` input). The pipeline does not call the classifier a second time and adds no new classifier logs. Embed, voice-rag and the eval endpoint call it once at their entry and pass it in the same way.
  - `conversational` → no transforms (and R12 small talk → `skipRetrieval`).
  - `tool_required` → no query transforms (MCP path unchanged).
  - `multi_step` / `complex` → adds `decompose` as a hint even when R3/R6 did not fire.
  - `document_search` → gate rules only.
  - The gate's fired rules are the primary signal; the classifier only suppresses or adds `decompose`.
- **D-10:** R12 small talk under `RAG_QUERY_LAYER=true`: retrieval is skipped and the strict-mode "information not available" response does not fire; the model answers conversationally without knowledge-base context. With the layer off, today's behaviour is unchanged. A characterization test covers both.
- **D-11:** R2 relative time: `dates.ts` computes an absolute range from `ctx.now` in the request's time zone (the client's IANA zone when the chat or embed body sends one, validated; otherwise UTC; the zone used is traced). The range becomes a DATA-08 date filter with `includeUndated: true`, so chunks without `doc_date` are kept (filters still only narrow the tenant scope). If the Phase 4 filter object lacks null inclusion, this phase adds the flag. The absolute dates are also appended to the standalone query text used for the dense leg. The existing temporal analyzer keeps handling explicit dates; for relative expressions the gate's range wins.
- **D-12:** The gate lexicon is the single data file of the spec. The personal-data and first-person patterns the cache needs (D-33) are added to the same file under a separate key, so one file holds all query-side word lists.

### Query LLM and prompts
- **D-13:** One small fast model for every query transform, called through the existing OpenRouter AI SDK provider with `generateObject` (structured output, temperature 0) and the generated Zod schemas: `RAG_QUERY_LLM_MODEL` (the researcher proposes the default from cheap, fast models with zh/en/it quality and structured-output support; recorded as a decision), no new provider key. Calls live in `src/lib/rag/query/llm.ts`, injected through `RagDeps` so a fake plugs in. The boundary check gains a rule: query-LLM calls only under `src/lib/rag/query/`.
- **D-14:** Prompts:
  - LlamaIndex path: ports of LlamaIndex's own prompts (the condense-question prompt, the `QueryFusionRetriever` query-generation prompt, `HyDEQueryTransform`'s HyDE template, the `SubQuestionQueryEngine` question-generator prompt with tool descriptions dropped), stored as versioned data files with the source version noted.
  - LangChain path: LangChain's own prompts (the history-aware retriever's contextualize prompt, `MultiQueryRetriever`'s default prompt, the `HydeRetriever` template, LangChain's query-decomposition prompt).
  - Both get the same mandatory suffix: answer in the query's language, keep every protected token verbatim, return at most N items, return the input unchanged when it is already standalone or not compound. So the comparison measures framework prompts and plumbing, not different rules.
  - HyDE prompts are written per language (zh/en/it), as research advises.
- **D-15 (shared post-checks):** After any LLM transform, under both frameworks:
  - a variant missing any protected token is discarded and logged (spec rule), and the original is used;
  - a variant longer than 4× the input or 500 characters is discarded;
  - a condensed query equal to the input after normalization counts as "standalone, passed through";
  - sub-questions beyond 4 are cut; an empty list means "not compound";
  - the rewrite output only changes query text; it never changes the scope, filters other than the R2 range, the RAG mode or tool use.
- **D-16:** History window for `condense`: the last 6 turns (3 exchanges), each turn truncated to 1,000 characters, assistant turns stripped of source lists, citation markup and `source_images` before they are sent. The window comes from the chat and embed request bodies already in hand; no new storage reads.

### LangChain adapter and zod isolation
- **D-17:** `src/lib/rag/query/langchain/` is one module (a directory with an `index.ts`), loaded with a dynamic `import()` only when `RAG_QUERY_FRAMEWORK=langchain`, so the default path never loads LangChain. It uses `createHistoryAwareRetriever`, `MultiQueryRetriever`, a native HyDE port with LangChain's template (never `HydeRetriever` over a LangChain `VectorStore`), `EnsembleRetriever` RRF for variant fusion, and LangChain's decomposition prompt with structured output.
- **D-18:** The retriever it wraps is a `BaseRetriever` subclass over a narrow port exported by `src/lib/rag/` (`searchVariant(variant)` returning fused-leg candidates, then `finishRetrieval(candidates)` for dedupe, rerank, refusal and assembly). The `TenantScope` is bound when the port is created on the server; LangChain input never carries or chooses a scope. The adapter may import only `@langchain/*`, the query contracts and that port.
- **D-19:** CI boundary rules (extend `scripts/ci/check-rag-boundary.mjs` with self-tests):
  - any `@langchain/*` import outside `src/lib/rag/query/langchain/` fails;
  - the adapter importing backend, embedding, reranker, Supabase or tenant-minting modules fails;
  - any app file importing zod v4 (`zod/v4`, `zod@4`) fails.
- **D-20:** zod isolation: the root `zod` stays 3.25.x; `@langchain/core` resolves its own zod 4 as a nested dependency; LangChain outputs are converted to plain objects and validated with the app's zod/v3 generated schemas at the adapter boundary. A CI step asserts with `npm ls zod` that the root resolves to 3.x and LangChain to 4.x, and `next typegen && tsc --noEmit` plus `next build` pass. The researcher verifies the install mechanics (nested install vs `overrides`, `.npmrc` `legacy-peer-deps`, server bundling via `serverExternalPackages` if needed).
- **D-21:** The LangChain chat model is `ChatOpenAI` from `@langchain/openai` (already a dependency of `@langchain/classic`) pointed at the OpenRouter base URL with the same `RAG_QUERY_LLM_MODEL` and key. `@langchain/openrouter` is not added. Packages to pin (researcher re-verifies versions and age): `@langchain/core@1.5.0`, `@langchain/classic@1.0.62`, `@langchain/openai` at the version `@langchain/classic` requires. Install needs the user's package approval (see Specifics).
  - **Reversibility:** costly — dependency, lockfile and CI checks; removing it means deleting one module and its CI rules.
- **D-22:** The framework switch applies to chat, embed and eval. Voice always uses the native condense (lowest latency, no dynamic import); this is documented in the Config UI help text.

### Translation (XLG-01)
- **D-23:** Query language detection extends the gate's detector to the XLG-01 rule (script ratio plus zh/en/it stopword scores; mixed queries by dominant script). Knowledge-base language shares come from a new server-role SQL function `rag_tenant_language_shares(p_tenant_key)` over current, ready documents' `language` (Phase 3 DATA-02), under the same tenant-key checks as `hybrid_search_chunks`, cached in process per tenant for 10 minutes. Translation fires (R8) when the query language's share is ≤ 20%; targets are the top two KB languages with a share > 20%.
  - **Reversibility:** one-way — a published SQL function and grant, added as a `supabase/migrations/` file mirrored into both setup files (Phase 3 D-05).
- **D-24:** The translator is a `translate` transform of `QueryTransformer` (both frameworks), served into the Phase 4 D-22 slot. `RAG_LEXICAL_TRANSLATION`'s fixture table stays for eval only. Translated variants keep protected tokens verbatim (D-15). Switches: `RAG_QUERY_TRANSLATE` (default `true` under the master switch) and `RAG_QUERY_TRANSLATE_DISABLED_PROFILES` (comma list of embedding-profile ids where the eval shows the multilingual embedding alone is enough).
- **D-25:** Answer language: when the query language differs from the language of any document in the assembled context, the generation prompt gains one appended instruction (answer in the asker's language; keep quoted text in the source language). It is appended by `createEnhancedRAGPrompt`, never by editing `RAG_SYSTEM_PROMPT`, so `{{context}}` substitution is unchanged. A characterization test asserts the prompt is byte-identical when the languages match.

### Switches, timeouts and budgets
- **D-26:** New env vars (all in the five config locations and `managed` in `scripts/rag/env-manifest.json`):
  - `RAG_QUERY_LAYER=false` (master)
  - `RAG_QUERY_FRAMEWORK=llamaindex` (`llamaindex | langchain`)
  - `RAG_QUERY_LLM_MODEL=` (default per D-13)
  - `RAG_QUERY_CONDENSE=true`, `RAG_QUERY_EXPAND=true`, `RAG_QUERY_DECOMPOSE=true`, `RAG_QUERY_TRANSLATE=true`, `RAG_QUERY_DATE_NORMALIZE=true`, `RAG_QUERY_HYDE=false`
  - `RAG_QUERY_TRANSLATE_DISABLED_PROFILES=`
  - `RAG_QUERY_VOICE_TRANSFORMS=condense_history,normalize_dates` (allow-list; `translate` may be added; `expand`, `hyde` and `decompose` are rejected for voice even if listed, with a config warning)
  - `RAG_SEMANTIC_CACHE=off` (`off | pgvector | redisvl`), `RAG_SEMANTIC_CACHE_TTL=3600`, `RAG_SEMANTIC_CACHE_REFUSAL_TTL=600`, `RAG_SEMANTIC_CACHE_MAX_DISTANCE=0.05`

  Sub-switches default to the recommended profile but are inert while the master switch is off, so turning on one switch gives the recommended setup and turning it off restores Phase 4 behaviour. The legacy names `RAG_QUERY_ENHANCEMENT`, `NEXT_PUBLIC_RAG_QUERY_ENHANCEMENT_ENABLED`, `RAG_CACHE_ENABLED` and `NEXT_PUBLIC_RAG_CACHE_*` are not reused; they stay `legacy` in the manifest.
- **D-27:** Per-transform timeouts (code defaults per profile, overridable via `RAG_STAGE_TIMEOUTS`): chat and embed — `condense` 600 ms, `translate` 600 ms, `expand` 700 ms, `decompose` 800 ms, `hyde` 900 ms, `semantic_cache` 150 ms; voice — `condense` 300 ms; eval — none. The parallel group also has a group deadline (chat 900 ms after `condense` ends) after which unfinished transforms are aborted and the plan proceeds with what finished. `query_gate` is pure and must stay under 1 ms (a unit benchmark asserts p99 < 1 ms on the fixture table).
- **D-28:** Overrun and failure follow Phase 2 D-05 unchanged: a skipped transform is recorded (`skipped`, reason `timeout | error | aborted | protected_token_lost`) and the result is `degraded`; a transform off by config is `disabled`, not degraded. Because the original query is always retrieved, a skipped transform never removes the original results, and Phase 4 D-31 (`empty`/`below_threshold` precedence) still applies. An injected-delay test per transform proves the request completes.
- **D-29:** Latency budgets are added to `eval/config/latency-budgets.json` (Pydantic `LatencyBudgets`), report-only on fixtures: a `query` group per profile — chat/embed p50 600 ms / p95 1,200 ms for the whole pre-retrieval stage, keeping chat retrieval within the ~2 s before-first-token starting budget; voice p95 300 ms for the query stage within its 800 ms total; per-transform p95 equal to the D-27 timeouts. Live verification replaces them with measured numbers.

### Voice profile (QRY-07)
- **D-30:** Voice condensation moves server-side into the pipeline's voice profile:
  - `/api/internal/voice-rag` accepts an optional `history` field (at most 6 turns, size-capped, Zod-validated);
  - the voice profile runs only `query_gate`, `condense` and `normalize_dates` (plus `translate` if listed), then the Phase 4 D-25 path (hybrid, fast reranker, 250 ms rerank timeout, smaller budget);
  - HyDE, expand and decompose can never run for voice (hard-coded, plus the D-26 validation);
  - the voice wire contract `{results, source_images}` (plus `debug_info`) is unchanged.
- **D-31:** The voice agent gains `VOICE_SERVER_QUERY_REWRITE` (voice-agent env, default `false`, documented in its env template). When `true` it sends the history to voice-rag and skips its own `rewriteQueryWithContext`; when `false` today's agent-side rewrite runs unchanged. An injected-delay test keeps the voice profile under its 800 ms p95 budget with a fake LLM and a fake fast reranker, skipping `condense` rather than exceeding the budget.

### Semantic cache (CACHE-01, locked spec)
- **D-32:** Placement: the `semantic_cache` check runs after `condense` (it needs the standalone query and its embedding, which is reused by `embed`), only for chat and embed, only for RAG modes `strict` and `balanced`, only under v2. A hit streams the cached answer, sources and citations through the normal UI message stream and skips retrieval and generation; the message metadata marks `cache: hit` and keeps the original trace ID. `store` runs after the response finishes (in `after()`), never on the streaming path. Voice is not cached (voice-rag returns context, not answers).
- **D-33:** Bypass detection follows the spec list, all deterministic: protected tokens non-empty (gate), relative time (R2), personal data (phone, e-mail, ID-number patterns and first-person lexicon from the gate lexicon file, D-12), webSearch, MCP tools or `source_images` in the turn, groundedness status `possibly_unreliable`, an uncondensed follow-up (spec rule 2), `skipRetrieval` turns, and a `degraded` or `error` retrieval status. When Phase 5's groundedness status is absent, `not_checked` is storable; only `possibly_unreliable` is not. The bypass reason is traced.
- **D-34:** pgvector backend:
  - a table `rag_semantic_cache` (`id`, `tenant_key`, `key_hash` over answer language + RAG mode + generator model + `retrievalConfigHash` + query framework, `embedding_profile_id`, `embedding halfvec`, `query_text_masked`, `answer jsonb` (`CachedAnswer`), `source_versions jsonb`, `is_refusal`, `created_at`, `expires_at`);
  - lookups prefilter by `(tenant_key, key_hash, embedding_profile_id, expires_at > now())` on a btree index and compute exact cosine distance over that small set (no HNSW index);
  - server-role SQL functions `rag_cache_check`, `rag_cache_store`, `rag_cache_invalidate`, `SECURITY INVOKER`, revoked from `PUBLIC`, `anon` and `authenticated`, tenant passed as `p_tenant_key` with the same malformed-key exceptions as `hybrid_search_chunks`; RLS on with no client policies;
  - a hit is re-validated against `source_versions` (all still `is_current`), else a miss;
  - invalidation by a statement trigger or the existing publish/soft-delete functions (Phase 3 D-11 `rag_publish_document_version`, Phase 3.1 D-27 `rag_soft_delete_document`) deleting the tenant's rows, in the same transaction; expired rows are removed lazily on store plus by a bounded cleanup in `rag_cache_store`.
  - **Reversibility:** one-way — new table, functions and grants via a `supabase/migrations/` file mirrored into both setup files.
- **D-35:** RedisVL backend: sidecar endpoints `POST /v1/cache/check`, `/v1/cache/store`, `/v1/cache/invalidate` behind the existing shared-secret auth, Pydantic request and response models, RedisVL `SemanticCache` with tag fields for `tenant_key` and `key_hash` and a TTL, in a new optional `cache` extra (`redisvl`, `redis`), `REDIS_URL` read by the sidecar only. The app adapter calls it over HTTP; the app emits the invalidation call from the same seams as D-34 (best-effort, plus the per-entry source-version check on hit). Tests use a fake sidecar and recorded responses; a real Redis run is live verification.
- **D-36:** Failure is fail-open to a miss: any cache error, timeout (150 ms) or abort means "miss", recorded as `skipped` in the `semantic_cache` span, and never makes the request `degraded` or `error` (the cache is outside retrieval quality). Store failures are logged with the `[Semantic Cache]` prefix and dropped.
- **D-37:** Threshold calibration: `python -m rag_eval.calibrate cache` picks the largest distance on the dev split with a near-miss wrong-hit rate of 0 and the best paraphrase hit rate, checks it on the test split, and writes `eval/config/semantic-cache.json` (Pydantic `SemanticCacheCalibration`, per embedding profile). The app uses the calibrated value when present, else `RAG_SEMANTIC_CACHE_MAX_DISTANCE`. Pairs use `cache_paraphrase` and `cache_near_miss` golden categories with a `pair_of` item reference.

### Evaluation and completion
- **D-38:** Eval endpoint: `RagRunOptions` gains eval-only `query_framework`, `query_layer`, `query_transforms` (per-transform on/off) and `semantic_cache` overrides. `RagTrace` gains `query_plan` (the D-03 contract) and fills the existing `query_transforms` list; gate rule IDs and skipped reasons are scored in reports.
- **D-39:** A deterministic fake query LLM serves both frameworks in CI: scripted outputs per item and transform from `eval/fixtures/query-llm/*.json`, plus latency and failure injection. The LangChain path gets it through a minimal fake chat model that reads the same table. No test calls a live LLM.
- **D-40:** Framework comparison: `python -m rag_eval.compare frameworks` runs the golden set under `llamaindex` and `langchain`, writes paired differences per language, category and language pair, and a Markdown report. It is a CI job on fixtures; live comparison is the live verification item.
- **D-41:** Golden additions, made only after parity with the layer off is re-confirmed (Phase 2 D-25 pattern):
  - `multi_turn` items whose follow-up contains a protected code (the R1+R4 case), elliptical follow-ups (R5) and relative-time follow-ups, ≥ 2 per language;
  - `compound` items with 3–4 parts, ≥ 2 per language;
  - cross-language items asking in en or it about zh-only documents (SC 6), ≥ 4 per direction, reusing the Phase 3 D-41 `cross_lingual` category and `evidence_language`;
  - `cache_paraphrase` and `cache_near_miss` pairs (different code, number, language, product, date), ≥ 4 pairs each per language;
  - small-talk items (R12) checked as "no retrieval, no refusal".

  The baseline is re-recorded with zero paired differences on pre-existing items.
  - **Reversibility:** costly — persisted golden files and baseline.
- **D-42:** Phase completion, all on fixtures:
  - (a) with `RAG_QUERY_LAYER=false` every paired difference against the Phase 4 baseline is zero;
  - (b) under the default framework with the layer on, the `multi_turn`, `compound` and `cross_lingual` slices hold or improve and no slice drops beyond the noise band on Recall@k, MRR or refusal rates;
  - (c) both frameworks produce schema-identical outputs on the fixture inputs, and the paired framework report is written;
  - (d) every transform passes its injected-delay and failure test; voice stays inside budget;
  - (e) with the cache on, hits have much lower p95 than misses in the eval report, the near-miss wrong-hit rate is 0 (CI gate), cache off equals the baseline, and the two-tenant canary suite includes cache cases (same text in two tenants, after delete, after version replace, after re-embed / profile change).
- **D-43:** Rollout order inside the phase:
  1. contracts (`QueryPlan`, transform outputs, cache models, params files) and schema generation;
  2. rewrite gate, lexicon, protected tokens and date normalization with the spec's fixture table;
  3. router and stage wiring with the master switch and parity proof;
  4. query LLM client and the fake;
  5. native transforms (condense, expand, HyDE, decompose) and post-checks;
  6. language shares SQL and the translator in the D-22 slot;
  7. variant fusion and sub-question coverage;
  8. voice profile and the voice-agent switch;
  9. LangChain adapter, zod isolation and boundary rules;
  10. cache SQL, pgvector backend, bypass rules and invalidation;
  11. RedisVL sidecar backend;
  12. Config UI panel and five-location config;
  13. golden additions and re-baseline;
  14. calibration, framework comparison and the final comparison.

### Config UI
- **D-44:** One Config UI panel, "Query layer":
  - master switch, framework select (LlamaIndex default, LangChain), query model;
  - per-transform switches and timeouts, with a warning that HyDE is off by default and never used in voice;
  - the voice allow-list;
  - cache backend select, TTLs and the calibrated distance (read-only, from `semantic-cache.json`), and a "clear cache for tenant" admin action through an authenticated `/api/rag/admin/semantic-cache` route (Phase 3 D-45 pattern: `admin_users` auth, Zod, structured errors, fail closed).

  Env edits use the existing config-server flow. A warning appears when the cache is on while `RAG_PIPELINE=legacy`, or when LangChain is selected but its packages are not installed.

### Claude's Discretion
- File layout inside `src/lib/rag/query/` and `src/lib/rag/cache/` beyond the paths named above.
- Exact wording of the shared prompt suffix and the per-language HyDE prompts.
- The exact personal-data regexes (ID-number formats for CN, IT and generic), within the spec list.
- Trace reason strings, Config UI labels and help text.
- Whether the group deadline in D-27 is a separate stage or a runner feature.

### Decision index
- **D-01:** layout `src/lib/rag/query/` (gate + lexicon per spec, router, dates, protected, llm, llamaindex/, langchain/, plan) and `src/lib/rag/cache/`
- **D-02:** `QueryTransformer` interface; gate, router, post-checks, budgets and tracing shared; only LLM generation differs per framework
- **D-03:** Pydantic `QueryPlan` + per-transform output models → Zod; both frameworks return identical shapes (costly)
- **D-04:** query layer only under v2, master `RAG_QUERY_LAYER` default false; off = byte-identical to Phase 4
- **D-05:** stages query_gate, condense, normalize_dates, translate, expand, hyde, decompose, semantic_cache before embed; names = stage_latency_ms keys and spans
- **D-06:** variants via Phase 4 D-13 (parallel hybrid RPC, one RRF, dedupe, cap, single rerank); one embedBatch; rerank and refusal on the standalone query, never HyDE
- **D-07:** sub-question coverage reservation after rerank (≤ 4), switchable in retrieval-params.json
- **D-08:** ≤ 2 LLM variants, ≤ 2 translations, ≤ 4 sub-questions, ≤ 8 searches; `eval/config/query-params.json`
- **D-09:** router = gate rules + classifyQuery result passed in by each entry point (no second classifier call); conversational/tool → none; multi_step/complex → decompose hint
- **D-10:** R12 small talk skips retrieval and strict refusal only when the layer is on
- **D-11:** R2 absolute range in request time zone (else UTC) → DATA-08 date filter with includeUndated; dates appended to dense query; temporal analyzer keeps explicit dates
- **D-12:** personal-data and first-person lists live in the gate lexicon file
- **D-13:** one small model `RAG_QUERY_LLM_MODEL` via OpenRouter AI SDK `generateObject`, temperature 0, injected via RagDeps; boundary rule for query-LLM calls
- **D-14:** LlamaIndex-path prompts ported from LlamaIndex, LangChain-path prompts from LangChain, same mandatory suffix; per-language HyDE prompts
- **D-15:** shared post-checks: protected tokens verbatim else discard, length caps, pass-through detection, ≤ 4 sub-questions, rewrite never changes scope/mode/tools
- **D-16:** condense history = last 6 turns, 1,000 chars each, assistant markup stripped, from the request body
- **D-17:** LangChain adapter dir loaded by dynamic import; createHistoryAwareRetriever, MultiQueryRetriever, HyDE port with LangChain template, EnsembleRetriever RRF, decomposition prompt
- **D-18:** adapter wraps a narrow `searchVariant`/`finishRetrieval` port; TenantScope bound server-side; adapter imports only @langchain/*, contracts and the port
- **D-19:** boundary rules: @langchain only in the adapter; adapter cannot reach backend/embedding/rerank/Supabase/tenant; no zod v4 in app code
- **D-20:** root zod 3.25.x, LangChain's zod 4 nested; plain objects validated with zod/v3 at the boundary; `npm ls zod` CI check; tsc and build pass
- **D-21:** ChatOpenAI via OpenRouter base URL; no @langchain/openrouter; pins @langchain/core 1.5.0, @langchain/classic 1.0.62, @langchain/openai as required; needs package approval (costly)
- **D-22:** framework switch covers chat, embed, eval; voice always native condense
- **D-23:** XLG-01 detection; `rag_tenant_language_shares` server-role SQL with tenant-key checks, 10-min per-tenant cache; translate when query-language share ≤ 20% into top two KB languages > 20% (one-way)
- **D-24:** translator in the Phase 4 D-22 slot under both frameworks; fixture table kept for eval; `RAG_QUERY_TRANSLATE`, `RAG_QUERY_TRANSLATE_DISABLED_PROFILES`
- **D-25:** cross-language answer instruction appended in createEnhancedRAGPrompt; RAG_SYSTEM_PROMPT and `{{context}}` untouched; byte-identical when languages match
- **D-26:** env vars listed above, five locations, managed in env-manifest; sub-switches inert under the master; legacy query/cache names not reused
- **D-27:** timeouts chat/embed condense 600, translate 600, expand 700, decompose 800, hyde 900, cache 150 ms; voice condense 300 ms; eval none; group deadline 900 ms; gate p99 < 1 ms benchmark
- **D-28:** skipped transform → degraded per Phase 2 D-05; disabled ≠ degraded; original always retrieved; injected-delay tests
- **D-29:** query budgets in latency-budgets.json: chat/embed p50 600 / p95 1,200 ms; voice query p95 300 ms; report-only
- **D-30:** voice-rag optional `history`; voice profile = gate + condense + normalize_dates (+ translate if listed) then Phase 4 D-25 path; HyDE/expand/decompose never; wire contract unchanged
- **D-31:** voice-agent `VOICE_SERVER_QUERY_REWRITE` default false (off = today's agent-side rewrite); voice budget test with fakes
- **D-32:** cache check after condense for chat/embed, strict/balanced, v2 only; hit streams cached answer and skips retrieval and generation; store in after(); voice not cached
- **D-33:** deterministic bypass list (protected tokens, R2, personal data, webSearch/MCP/source_images, possibly_unreliable, uncondensed follow-up, skipRetrieval, degraded/error); not_checked storable
- **D-34:** `rag_semantic_cache` table + server-role check/store/invalidate functions with tenant-key exceptions; btree prefilter + exact distance; source-version re-validation; invalidation in the publish/soft-delete transactions (one-way)
- **D-35:** RedisVL in sidecar `cache` extra with /v1/cache/* endpoints, tag fields, TTL, shared-secret auth; fake-sidecar tests; real Redis is live verification
- **D-36:** cache fail-open to miss (150 ms), never degrades retrieval; `[Semantic Cache]` logs
- **D-37:** `rag_eval.calibrate cache` → `eval/config/semantic-cache.json` per embedding profile; near-miss wrong-hit 0 on dev and test; pair categories with `pair_of`
- **D-38:** eval overrides query_framework/query_layer/query_transforms/semantic_cache; RagTrace gains query_plan
- **D-39:** deterministic fake query LLM for both frameworks from `eval/fixtures/query-llm/`
- **D-40:** `rag_eval.compare frameworks` paired report per language, category and pair; CI on fixtures
- **D-41:** golden additions after parity: protected-code follow-ups, elliptical, relative time, 3–4-part compound, en/it→zh cross-language, cache pairs, small talk; re-baseline zero diffs on old items (costly)
- **D-42:** completion: layer-off parity; default framework holds/improves multi_turn, compound, cross_lingual with no slice beyond noise; schema-identical frameworks; delay/failure tests; cache hit p95 ≪ miss, wrong-hit 0, cache-off = baseline, cache canary cases
- **D-43:** rollout order as listed
- **D-44:** "Query layer" Config UI panel and authenticated `/api/rag/admin/semantic-cache` clear action; warnings for cache under legacy and missing LangChain packages

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and requirements
- `.planning/ROADMAP.md` §"Phase 6: Query Layer (LlamaIndex & LangChain)": goal, the seven success criteria and the live verification item.
- `.planning/REQUIREMENTS.md`: QRY-01 to QRY-08, LAT-03, XLG-01, CACHE-01. Also read for constraints: OBS-01 (span fields), LAT-01, LAT-02, DATA-02 (`language`), DATA-08 (filters), GEN-03 and GEN-05 (cache answer record and bypass), RET-08 (canary suite), XLG-03.
- `.planning/PROJECT.md` §Constraints and §Key Decisions: LlamaIndex default + LangChain alternative, zod 4 isolation, semantic-cache backend choice, Langfuse, Pydantic → Zod, config sync, off switches.

### Locked specs
- `.planning/specs/query-rewrite-gate.md` — LAT-03 gate: output type, rules R0–R12, matching rules, lexicon file, safety checks, required fixture table. Implement as written.
- `.planning/specs/semantic-cache.md` — CACHE-01: backend choice, `check`/`store`/`invalidateTenant` contract, key scope, bypass rules, TTLs, invalidation, eval gate. Implement as written.

### Prior phase decisions
- `.planning/phases/01-evaluation-harness-baseline/01-CONTEXT.md`: eval endpoint contract, noise band, dev/test split, fixture edge.
- `.planning/phases/02-unified-retrieval-pipeline-tenant-scope/02-CONTEXT.md` (and "Adjustments after research"): D-01 `runRetrieval`, D-03/D-04 stage runner and timeouts, D-05 status, D-06 entry-point mappings, D-07 `TenantScope`, D-10 voice token, D-14 boundary check, D-18–D-21 Langfuse and budgets, D-25 golden-addition pattern.
- `.planning/phases/03-unified-ingestion-embedding-profiles/03-CONTEXT.md`: D-05 migrations, D-06/D-07 `language` and `tenant_key` columns, D-11 publish function, D-33–D-37 embedding profiles (cache embedding profile), D-41 `cross_lingual` golden items, D-45 admin route pattern.
- `.planning/phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/03.1-CONTEXT.md`: D-27 `rag_soft_delete_document` (cache invalidation seam).
- `.planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-CONTEXT.md`: D-02 RRF module, D-04 `hybrid_search_chunks` tenant-key checks (copied by D-23/D-34), D-05 filters, D-10/D-25 voice profile, D-11 rerank failure, D-12 params file pattern, D-13 parallel variants, D-17–D-19 refusal, D-22 `queryVariants` + `translate` slot, D-24 stage names and `retrievalConfigHash`, D-30/D-31 post-research refusal rules.

### Research
- `.planning/research/STACK.md` §0 items 3, 5, 13 and the query-layer table: `@langchain/classic` import paths, LlamaIndex.TS lacking `QueryFusionRetriever`/HyDE, `@langchain/core` needing zod 4, HyDE port advice, version pins.
- `.planning/research/SUMMARY.md` §"Phase 7: Query layer" (research numbering) and the "Avoid" list (HyDE/multi-query/decomposition on every query).
- `.planning/research/PITFALLS.md`: Pitfall 4 (latency stacking) and the identifier-loss and HyDE no-answer pitfalls.
- `.planning/research/ARCHITECTURE.md`: query stages, latency budgets.

### Code
- `src/lib/query-classifier.ts` (`classifyQuery`, categories) and its call in `src/app/api/chat/route.ts` (~L36, query extraction ~L1334).
- `src/lib/rag/` (Phase 2): `index.ts`, `pipeline.ts` (stage runner), `config.ts` (`StageName`, profile defaults), `types.ts`, `deps.ts`, `query/temporal-query-detector.ts`, `generation/prompt.ts` (`createEnhancedRAGPrompt`), `trace/*`, `tenant/*`.
- `src/app/api/embed/chat/route.ts`, `src/app/api/internal/voice-rag/route.ts`, `src/app/api/internal/rag/run/route.ts`.
- `voice-agent/src/voice_agent.ts` `rewriteQueryWithContext` (~L393) and `voice-agent/src/rag_client.ts`.
- `rag-sidecar/src/rag_sidecar/contracts/eval_run.py` (`ConversationTurn`, `StageName`, `RagRunOptions`, `TraceQueryTransform`, `RagTrace`) and `golden.py` (`Category` already has `multi_turn`, `compound`).
- `eval/config/latency-budgets.json`, `eval/fixtures/golden.jsonl`, `scripts/rag/env-manifest.json`, `scripts/ci/check-rag-boundary.mjs`, `scripts/check-config.mjs`, `scripts/config-server.js`, `scripts/config-ui/index.html`, `scripts/init-env.js`, `src/lib/env.ts`, `package.json` (`zod ^3.25.76`, unused `llamaindex ^0.8.30`), `.npmrc`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `classifyQuery` already classifies every chat query (`conversational`, `tool_required`, `document_search`, `complex`, `multi_step`); the router reuses its result instead of re-running it. It logs verbosely, so it must not be called again inside the pipeline.
- The eval contract already carries `conversation: ConversationTurn[]` on `RagRunRequest` and `query_transforms` on `RagTrace`, and the golden set already has 9 `multi_turn` and 9 `compound` fixture items; multi-turn eval needs no new request shape.
- The voice agent's `rewriteQueryWithContext` (pronoun-only prompt, last 6 messages, temperature 0, fallback to the original) is the behaviour that `VOICE_SERVER_QUERY_REWRITE=false` keeps.
- Phase 2 stage runner (`runStage`, `disabled`/`skipped` records, `RAG_STAGE_TIMEOUTS`), trace collector and Langfuse spans; Phase 4's `fusion/rrf.ts`, `queryVariants` seam, `translate` slot, `retrievalConfigHash` and `embedBatch`.
- `llamaindex ^0.8.30` is declared in `package.json` but not imported anywhere in `src/` or `scripts/`; the native ports do not need it.

### Established Patterns
- Pydantic is the source of every contract; Zod via `npm run gen:schemas`, `zod/v3` imports, CI drift check.
- Every new env var goes to the five locations and `env-manifest.json` as `managed`; legacy names such as `RAG_QUERY_ENHANCEMENT` and `RAG_CACHE_ENABLED` exist as `legacy` and are left alone.
- Server-role-only SQL functions with tenant-key exception checks and revoked anon/authenticated grants (Phase 4 D-04); migrations mirrored into both setup files.
- Committed eval config files written by tools (`retrieval-params.json`, `refusal-thresholds.json`), read at startup, eval-only overrides.
- Bracketed log prefixes (`[RAG Trace]`, `[Document Search]`); new ones: `[Query Layer]`, `[Semantic Cache]`.

### Integration Points
- `src/lib/rag/` pipeline stages before `embed`; `RunRetrievalInput` gains `history`, `classification`, `timeZone`.
- Chat, embed, voice-rag and eval routes: pass classification, history and time zone; chat and embed handle cache hits in their stream.
- `createEnhancedRAGPrompt` for the cross-language answer instruction.
- Supabase migrations for `rag_tenant_language_shares` and the cache table/functions; the publish and soft-delete functions for invalidation.
- `rag-sidecar/` cache endpoints and `cache` extra; `eval/src/rag_eval/` (`calibrate cache`, `compare frameworks`, report slices).
- `voice-agent/` env template and `processUserMessage`.
- Config UI panel and config-server routes; `scripts/ci/check-rag-boundary.mjs`; CI `npm ls zod` step.

</code_context>

<specifics>
## Specific Ideas

- Cross-tenant safety stays the top risk. The cache table and the language-share function are new server-role surfaces: both take the tenant only from `TenantScope`, raise on malformed keys, and are in the two-tenant canary tests. A rewritten query or LangChain input can never carry or change a scope.
- History text sent to the query LLM is untrusted. The rewrite output only becomes query text, is length-capped and validated, and cannot change mode, tools or filters (Phase 5.1 handles injection in the context).
- Identifier safety is a first-class check: any variant that loses a protected token is dropped, and this is visible in the trace and in eval reports.
- **Needs the user — package approvals** (same gate as Phase 3 03-05 and Phase 3.1 A-8): npm `@langchain/core@1.5.0`, `@langchain/classic@1.0.62`, `@langchain/openai` (version required by classic); Python sidecar optional `cache` extra with `redisvl` 0.32.x and `redis`. The researcher re-verifies versions, publishers, install scripts and age (≥ 2 weeks) before the checkpoint.
- **Needs the user — live verification only:** the default `RAG_QUERY_LLM_MODEL` choice is proposed by research and confirmed by live latency/quality numbers; real p50/p95 per transform for chat and voice replace the starting budgets; the live LlamaIndex vs LangChain comparison on the real golden set; a real Redis run for the RedisVL backend.
- Phase 4 (v2 pipeline, `queryVariants`, `translate` slot, `retrievalConfigHash`) and Phase 5 (citation record, groundedness status) are planned but not executed yet. Execution of this phase depends on those seams; planning can proceed against their CONTEXT contracts.

</specifics>

<deferred>
## Deferred Ideas

- Caching voice answers (would need the voice agent's LLM output to flow back to the app): later phase or backlog.
- A per-tenant or per-workspace query-model choice: backlog.
- LlamaIndex/LangChain Python in the sidecar for literal API parity: rejected for latency (research), kept as a note.
- Redis LangCache as a third cache backend: spec says "not now"; the contract allows adding it later.
- Learning router weights from eval data instead of rules: backlog, only if the eval shows the rule router limits recall.
- Removing the unused `llamaindex` npm dependency: a cleanup item outside this phase's scope (Phase 7 docs/closeout or a quick task).

</deferred>

---

*Phase: 06-query-layer-llamaindex-langchain*
*Context gathered: 2026-11-24*

## Adjustments after research (orchestrator, 2026-11-24)

Standing user instruction: follow the recommendations. These override the matching locked decisions.

- **A-1 (F-1, narrows D-09):** the router uses `classifyQuery` only for `tool_required` with `needsMcp` (no transforms) and `multi_step` (adds the decompose hint). `conversational`, `complex` and `document_search` are ignored; the gate rules decide. `NEXT_PUBLIC_MCP_SYSTEM_ENABLED` is pinned in `eval/config/rag-eval-env.json`.
- **A-2 (F-3, narrows D-28):** query-layer stages are soft. With zero results the status stays `empty` when every core stage and the original-query search succeeded; a skipped transform with results marks `degraded`. `semantic_cache` never affects status. Strict-mode "information not available" behaviour (PIPE-06, Phase 2 D-06) is preserved.
- **A-3 (F-4, narrows D-32/D-33):** the semantic cache stores only no-history turns whose raw message equals the standalone query; `key_hash` includes the entry profile (chat or embed) and the system-prompt hash; the store runs after the Phase 5 groundedness result (never for answers flagged unreliable); ghost/incognito chats are never stored; embed is check-only by default.
- **A-4 (F-2):** the LangChain adapter gives each document its chunk id as `pageContent` and uses one retriever per variant × leg, so fusion is one RRF over the same lists as native. Tie order is a reported framework difference.
- **A-5:** no LlamaIndex package; prompts vendored (MIT) with attribution. HyDE variants hit the dense leg only. Use `generateText` + `Output.object`, `maxRetries: 0` on both frameworks; LLM-output models have all fields required (nullable). The gate model is named `RewriteGateResult`.
- **A-6:** Phase 4's variant cap and `original | translated` type are widened; `hybrid_search_chunks` gains `p_include_undated` by dropping the old signature first. Cache invalidation uses three single-event triggers on `documents`; filter by embedding profile before computing distance.
- **A-7:** the parallel-group deadline is anchored at the gate start so chat query stages fit the 1.2 s p95 budget.
- **A-8:** default `RAG_QUERY_LLM_MODEL=openai/gpt-4.1-nano`; mistral-small-3.2-24b-instruct and gpt-4o-mini are the live-comparison alternates.
- **A-9 (packages, human checkpoint):** `@langchain/core@1.5.0`, `@langchain/classic@1.0.62`, `@langchain/openai@1.8.5` installed with `npm install --save-exact --before=<cutoff>` no earlier than 2026-12-04 (fallback 1.4.1 / 1.0.61 / 1.8.4; never classic ≤1.0.60). Optional sidecar `cache` extra `redisvl==0.32.0`, `redis==8.1.0`, locked with an exclude-newer cutoff. RedisVL uses a stub `CustomVectorizer`, `refresh_ttl_on_hit=False`, one index per embedding profile.
- **A-10:** remaining assumptions (HyDE protected-token exemption, Phase 3 ready status value, RedisVL import paths, `serverExternalPackages`, LangChain cold-import time) are resolved by the planner per the research recommendations with a test each.
