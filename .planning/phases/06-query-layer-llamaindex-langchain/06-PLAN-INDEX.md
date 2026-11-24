# Phase 6 Plan Index

46 plans in 13 waves, 114 tasks. Plans in the same wave share no file in `files_modified`, and every file touched by two Phase 6 plans in different waves is ordered by a `depends_on` path (checked by script, see "Checks run"). The phase tracer is 06-13 Task 1 in wave 4 (eval route to the v2 query stage, rewrite gate, native condense with the fake query LLM, QueryPlan, the Phase 4 variant seam, hybrid search and the trace). Two plans are not autonomous: 06-22 (package legitimacy, blocking-human, wave 5) and 06-46 (live verification, wave 13). Everything else is automated (see `06-VALIDATION.md`).

## Execution order and cross-phase dependencies

- Every plan runs after Phase 4 and Phase 5 are complete. Plans name the Phase 3, 3.1, 4 or 5 plan that last edits a file they change, for example 04-02 (config), 04-15 (hybrid_search_chunks), 04-19 to 04-24 (v2 stages, variant seam), 04-28 (voice under v2, v2/pipeline.ts, v2/result.ts), 04-30 (calibrate dispatcher), 04-34 and 04-36 (admin guard, Config UI panels), 04-40 (phase_compare), 04-41 (two-tenant matrix), 04-42 (setup-file fold), 04-44 (params and config hash).
- **Phase 5 and Phase 5.1 run before Phase 6** (ROADMAP order 5, 5.1, 6). Phase 5's 26 plans are final (05-PLAN-INDEX.md, plan check passed), so Phase 6 now names real Phase 5 ids. For every file a Phase 6 plan changes, the last Phase 3, 3.1, 4 or 5 plan that edits it is an ancestor through `depends_on` (checked by script). Direct Phase 5 edges:
  - file last-editors: 06-01 (05-01 `contracts/__init__.py`, 05-07 `eval_run.py`), 06-02 (05-02 manifest, 05-10 the five env locations and `check-config.test.mjs`), 06-05 (05-07 samples and generated files), 06-13 (05-04 `types.ts`, 05-22 eval route), 06-22 (05-05 `package.json`, lockfiles, `pyproject.toml`, `test_dependency_boundary.py`), 06-27 (05-16 chat route, 05-21 `index.ts`), 06-29 (05-22 `run-eval.mts`, `run-smoke.mts`), 06-30 (05-12 sidecar `main.py`, `settings.py`), 06-33 (05-22 `rag-eval/answer.ts`), 06-34 (05-07 `latency.py`, `report.py`; 05-24 `latency-budgets.json`, `eval/src/rag_eval/report.py`), 06-41 (05-19 `calibrate/__main__.py`), 06-44 and 06-45 (05-25 `phase_compare.py`, setup files, `schema-equality.test.mts`, `AGENTS.md`);
  - contract seams: 06-09 and 06-17 (05-01 CitationRecord and AnswerGroundedness labels), 06-33 (05-08 `decorateSystemPrompt`, which appends the citation instruction to the output of `createEnhancedRAGPrompt`; Phase 5 does not edit `prompt.ts`), 06-36 (05-13 answerId and `scheduleAnswerFinish`, 05-18 the post-stream groundedness label).
  The 06-09 and 06-36 `<precondition>` lines now name those plans.
- Older last-editor ids that were only named in prose are now in `depends_on` as well: 06-09 (03-11 `test_golden_contract.py`), 06-21 (03-13 publish stage, 03.1-39 soft-delete module).
- **Phase 5.1 has no plan files yet** (CONTEXT, research and patterns only). Its CONTEXT names these files that Phase 6 also changes: `src/app/api/chat/route.ts` (06-27), `src/lib/rag/generation/prompt.ts` (06-33), `rag-sidecar/src/rag_sidecar/main.py` (06-30), `contracts/golden.py` (06-09), `export_schemas.py` (06-05), `eval/src/rag_eval/report.py` (06-34), and the five env locations plus `scripts/rag/env-manifest.json` (06-02). When Phase 5.1 is planned, add the Phase 5.1 plan that last edits each file to the `depends_on` of the Phase 6 plan in brackets. Until then, the ROADMAP order (5.1 before 6) is the only guard, and the objectives of 06-27, 06-33 and 06-45 say so.
- Migration numbers 0601 to 0603 follow Phase 4's 0401 to 0409; Phase 5 and 5.1 use 05xx numbers, so ordering by filename stays correct.
- PGlite note: 06-04 (wave 1), 06-08 (wave 2) and 06-12 (wave 3) each add a migration that every PGlite test applies; they are in different waves and chained by `depends_on`; with `workflow.use_worktrees` false, never run two of them at once.

## Waves

| Wave | Plans | Theme |
|------|-------|-------|
| 1 | 06-01, 06-02, 06-03, 06-04 | Pydantic query contracts and query-params.json; 16 env names in the five places and the eval pin (MCP flag, A-1); rewrite gate, lexicon, protected tokens, gate p99 benchmark; language-share SQL (0601) |
| 2 | 06-05, 06-06, 06-07, 06-08, 06-09 | Generated Zod for query contracts; R2 date normalization; post-checks, group deadline, prompt renderer and suffix; hybrid_search_chunks p_include_undated (0602); cache and golden contracts |
| 3 | 06-10, 06-11, 06-12 | Config stages and switches, query-LLM client and fake; generated cache, golden and retrieval schemas; semantic-cache table, functions and triggers (0603) |
| 4 | 06-13, 06-14, 06-15, 06-16, 06-17, 06-18 | **Tracer** (gate plus condense end to end); router and query params; native expand, HyDE, decompose; KB shares client and native translate; cache key and bypass rules; boundary rules |
| 5 | 06-19, 06-20, 06-21, 06-22 | Layer orchestration (parallel group, deadline, soft status, small talk); variant caps, dense-only HyDE, one fusion; cache backends and RedisVL invalidation emission; **package approval checkpoint**, installs, zod isolation CI |
| 6 | 06-23, 06-24, 06-25, 06-26, 06-27, 06-28, 06-29, 06-30 | Translate through the Phase 4 slot; date filter end to end; sub-question coverage and standalone rerank/refusal; LangChain retrieval port; chat and embed inputs and small talk; voice profile; eval overrides and run configs; RedisVL sidecar endpoints |
| 7 | 06-31, 06-32, 06-33, 06-34, 06-35, 06-38 | Voice-agent switch; cache stage in the pipeline; answer-language instruction; report sections and query budgets; LangChain adapter part 1; golden additions part 1 |
| 8 | 06-36, 06-37, 06-39 | Cache hits and stores in chat and embed; LangChain adapter part 2 (ensemble, framework switch); golden cache pairs |
| 9 | 06-40, 06-41, 06-42 | Admin clear route and Config UI panel; cache-pair run, calibration and wrong-hit gate; two-tenant canary with cache and query-layer rows |
| 10 | 06-43 | Framework comparison tool, fixture report, CI jobs |
| 11 | 06-44 | Phase comparison (D-42 a to e) |
| 12 | 06-45 | Fold migrations into setup files, full gates with defaults, AGENTS.md |
| 13 | 06-46 | Live verification checkpoints (autonomous: false) |

## Requirement coverage

| Requirement | Plans |
|-------------|-------|
| QRY-01 | 06-01, 06-07, 06-13, 06-27, 06-38, 06-44, 06-46 |
| QRY-02 | 06-01, 06-15, 06-19, 06-20, 06-44 |
| QRY-03 | 06-01, 06-14, 06-15, 06-19, 06-20, 06-25, 06-44 |
| QRY-04 | 06-01, 06-11, 06-15, 06-19, 06-25, 06-38, 06-44 |
| QRY-05 | 06-01, 06-02, 06-03, 06-07, 06-10, 06-13, 06-14, 06-19, 06-20, 06-23, 06-27, 06-29, 06-34, 06-44, 06-45, 06-46 |
| QRY-06 | 06-01, 06-05, 06-10, 06-13, 06-15, 06-18, 06-44 |
| QRY-07 | 06-02, 06-10, 06-14, 06-28, 06-31, 06-34, 06-44, 06-46 |
| QRY-08 | 06-02, 06-05, 06-18, 06-22, 06-26, 06-29, 06-35, 06-37, 06-40, 06-42, 06-43, 06-44, 06-45, 06-46 |
| LAT-03 | 06-01, 06-03, 06-05, 06-06, 06-07, 06-08, 06-11, 06-13, 06-14, 06-19, 06-20, 06-24, 06-27, 06-34, 06-38, 06-44, 06-45 |
| XLG-01 | 06-01, 06-02, 06-03, 06-04, 06-16, 06-23, 06-33, 06-38, 06-42, 06-44, 06-45, 06-46 |
| CACHE-01 | 06-02, 06-09, 06-11, 06-12, 06-17, 06-21, 06-22, 06-29, 06-30, 06-32, 06-34, 06-36, 06-39, 06-40, 06-41, 06-42, 06-44, 06-45, 06-46 |

## Decision coverage (06-CONTEXT.md)

| Decision | Implemented in | Decision | Implemented in |
|----------|----------------|----------|----------------|
| D-01 | 06-03, 06-13, 06-17 | D-02 | 06-07, 06-13, 06-19, 06-26, 06-37 |
| D-03 | 06-01, 06-05, 06-13, 06-35, 06-37 | D-04 | 06-10, 06-13, 06-27, 06-32, 06-33, 06-36, 06-45 |
| D-05 | 06-01, 06-10, 06-13, 06-19, 06-32 | D-06 | 06-15, 06-19, 06-20, 06-25, 06-26 |
| D-07 | 06-01, 06-11, 06-25 | D-08 | 06-01, 06-14, 06-15, 06-16, 06-19, 06-20 |
| D-09 | 06-13, 06-14, 06-19, 06-27, 06-28 | D-10 | 06-14, 06-19, 06-27 |
| D-11 | 06-01, 06-06, 06-08, 06-11, 06-13, 06-24, 06-27 | D-12 | 06-03 |
| D-13 | 06-10, 06-13, 06-15, 06-18 | D-14 | 06-07, 06-13, 06-15, 06-35, 06-37 |
| D-15 | 06-07, 06-13, 06-15, 06-16 | D-16 | 06-07, 06-13, 06-27 |
| D-17 | 06-35, 06-37 | D-18 | 06-18, 06-26, 06-35, 06-37, 06-42 |
| D-19 | 06-18 | D-20 | 06-18, 06-22, 06-35 |
| D-21 | 06-22, 06-35 | D-22 | 06-14, 06-19, 06-23, 06-37, 06-40 |
| D-23 | 06-03, 06-04, 06-16, 06-23, 06-42, 06-45 | D-24 | 06-14, 06-16, 06-23 |
| D-25 | 06-33 | D-26 | 06-02, 06-10, 06-14 |
| D-27 | 06-03, 06-07, 06-10, 06-19, 06-28 | D-28 | 06-14, 06-19 |
| D-29 | 06-28, 06-34, 06-46 | D-30 | 06-10, 06-14, 06-19, 06-28, 06-31 |
| D-31 | 06-28, 06-31 | D-32 | 06-17, 06-32, 06-36 |
| D-33 | 06-09, 06-17, 06-32, 06-36 | D-34 | 06-09, 06-11, 06-12, 06-21, 06-45 |
| D-35 | 06-09, 06-11, 06-21, 06-22, 06-30, 06-46 | D-36 | 06-21, 06-32, 06-36 |
| D-37 | 06-09, 06-11, 06-39, 06-41, 06-46 | D-38 | 06-01, 06-13, 06-19, 06-29, 06-34, 06-41 |
| D-39 | 06-10, 06-29, 06-35, 06-38 | D-40 | 06-43, 06-46 |
| D-41 | 06-09, 06-38, 06-39 | D-42 | 06-34, 06-37, 06-42, 06-43, 06-44 |
| D-43 | rollout position stated in every plan's objective | D-44 | 06-02, 06-37, 06-40 |

Adjustments after research (override the matching decisions):

| Adjustment | Implemented in |
|------------|----------------|
| A-1 classifier used only for tool_required with needsMcp and multi_step; MCP flag pinned | 06-02, 06-14, 06-19 |
| A-2 soft query stages; empty wins with zero results; semantic_cache never affects status | 06-19, 06-32 |
| A-3 store only history-free pass-through turns; entry profile and prompt hash in the key; store after groundedness; no ghost chats; embed check-only by default (new switch RAG_SEMANTIC_CACHE_EMBED_STORE=false) | 06-02, 06-07, 06-17, 06-32, 06-36, 06-42 |
| A-4 chunk-id pageContent, one retriever per variant and leg, tie order reported | 06-26, 06-37 |
| A-5 vendored prompts, HyDE dense only, generateText + Output.object, maxRetries 0, required nullable LLM fields, RewriteGateResult name | 06-01, 06-05, 06-10, 06-15, 06-35 |
| A-6 widened variant type and cap; p_include_undated with DROP of the old signature; three single-event triggers; profile filter before distance | 06-08, 06-12, 06-20, 06-24, 06-45 |
| A-7 group deadline anchored at the gate start | 06-07, 06-19 |
| A-8 default RAG_QUERY_LLM_MODEL=openai/gpt-4.1-nano; alternates in the live comparison | 06-02, 06-10, 06-46 |
| A-9 package pins, cutoff, fallback set, RedisVL extra and settings | 06-22, 06-30 |
| A-10 open assumptions resolved with a test each (see below) | 06-04, 06-07, 06-15, 06-22, 06-30, 06-37 |

Deferred ideas (voice answer caching, per-tenant query model, Python LangChain or LlamaIndex in the sidecar, Redis LangCache, learned router weights, removing the unused `llamaindex` dependency) appear in no plan.

## ROADMAP success criteria

| # | Shown by |
|---|----------|
| 1 | 06-13, 06-15, 06-19 (native condense, expand with RRF, HyDE only when on, at most four sub-questions; no framework call); 06-01, 06-05 (Pydantic-generated Zod); 06-38 (fixture multi-turn and compound items) |
| 2 | 06-14, 06-19 (router reuses the classifier, per-transform switch, timeout and budget, injected delays, original retained); 06-28, 06-31 (voice reduced profile within budget, never HyDE, multi-query or decomposition) |
| 3 | 06-35, 06-37 (adapter on @langchain/classic with history-aware retriever, MultiQueryRetriever, HyDE port, RRF ensemble, decomposition prompt; same shapes); 06-26 (wraps the pipeline through the port); 06-18 (CI boundary check) |
| 4 | 06-02, 06-40 (Config UI switch, five locations); 06-22 (zod 4 isolated, type-check and build) |
| 5 | 06-29, 06-34, 06-43 (both frameworks on the fixture golden set, paired differences per language and category); 06-44 (multi-turn and compound hold or improve, no slice beyond noise) |
| 6 | 06-03, 06-14 (rewrite only when routed, at most two variants); 06-10 (small model); 06-16, 06-23, 06-38 (en and it questions about zh documents through translated-query fusion); 06-33 (answer in the asker's language) |
| 7 | 06-32, 06-36, 06-41, 06-44 (hit p95 much lower than miss); 06-12, 06-21 (invalidation on any document change); 06-42 (canary suite includes the cache) |
| Live | 06-46 |

## Multi-source coverage audit

| Source | Items | Status |
|--------|-------|--------|
| GOAL (ROADMAP Phase 6) | follow-up, vague and compound questions retrieve as well as standalone ones under either framework, within budgets, voice fast | COVERED by 06-13 to 06-31 and proven in 06-44 |
| REQ | QRY-01 to QRY-08, LAT-03, XLG-01, CACHE-01 | COVERED (table above) |
| RESEARCH | F-1 to F-4, ambiguities A-1 to A-7, P-1 to P-16, Package Legitimacy Audit, Validation Architecture | COVERED: F-1 06-14; F-2 06-37; F-3 06-19; F-4 06-17, 06-36; research A-1 (generateText) 06-10; research A-2 (vector reuse) 06-32; research A-3 (deadline) 06-07; research A-4 (variant type) 06-20; research A-5 (undated) 06-08; research A-6 (shared translate prompt) 06-16, 06-37; research A-7 (hash) 06-32; P-2 06-01; P-4 06-01, 06-10; P-5 06-12; P-6 06-15, 06-20; P-7 06-37; P-8 06-08; P-9 06-07; P-10 06-35, 06-37, 06-40; P-11 06-28; P-12 06-03; P-13 06-23, 06-41; P-15 06-22; P-16 06-12, 06-36 |
| CONTEXT | D-01 to D-44, A-1 to A-10 | COVERED (tables above); `check.decision-coverage-plan` reports 88 of 88 trackable decisions |

No item is missing, split or deferred beyond the CONTEXT's own deferred list.

## Planner resolutions (A-10 and interpretation notes)

- HyDE is exempt from the protected-token check (it drives only the dense leg and never rerank or refusal): 06-07 implements and tests it, 06-15 asserts it.
- Phase 3's finished-document status literal: 06-04 and 06-12 read it from the Phase 3 migration (research assumes 'ready') and their PGlite tests fail if it is wrong.
- RedisVL import paths and tag escaping: confirmed against the installed 0.32.0 wheel in 06-30 Task 1 (case runs with the `cache` extra).
- `serverExternalPackages`: added in 06-22 and proven by `npm run build` plus the langchain-mode end-to-end test in 06-37.
- LangChain cold import: pre-warmed at module load in langchain mode with `import_ms` traced (06-37).
- Package install timing (A-9, confirmed by the orchestrator in this revision): the LangChain trio is never installed before 2026-12-04. 06-22's checkpoint precondition and Task 2 both stop earlier. The install is `npm install --save-exact --before=<install date minus 7 days, 00:00:00Z>`, which is 2026-11-27 on 2026-12-04 and matches the research cutoff. The direct pins (published 2026-11-20) are then at least 14 days old, and every package the cutoff admits is at least 7 days old. The earlier draft's 2026-12-11 date was stricter than A-9 and is withdrawn. The RedisVL extra (`redisvl==0.32.0`, `redis==8.1.0`) stays optional: the human can drop it at the checkpoint, Task 4 is skipped, and 06-30's precondition stops with a report.
- Classifier calls: embed, voice-rag and the eval route call `classifyQuery` once at entry only when `RAG_QUERY_LAYER` is true, so the layer-off path stays byte-identical (D-04, D-09); the chat route keeps its single existing call.
- Eval timeouts: D-27 says "eval: none"; query-layer stages get 60000 ms for the eval profile, the Phase 4 precedent for a stage with no effective timeout (06-10).
- New eval-only contract field `cache_seed_answer` (06-01) lets the fixture cache-pair run store an anchor answer without a live generator (06-41).
- Answer-language detection for D-25 prefers the kept chunk's document language and falls back to the Phase 3 detector on the chunk text (06-33).
- The adapter imports no env or Supabase module; transformer.ts passes the model id and key in (06-35), which the `langchain-adapter-reach` allow-list enforces (06-18).

## Security summary

Threat ids T-06-01 to T-06-98 are unique across the phase; every plan also carries T-06-SC. Critical threats and their mitigations: cross-tenant language shares (T-06-07, guard plus two-tenant test), undated rows across tenants (T-06-14, T-06-54), cross-tenant cache hits (T-06-21, T-06-45, T-06-65, T-06-69, T-06-91), variants searched outside the tenant (T-06-44), the framework choosing a scope (T-06-56, T-06-74, T-06-80; scope bound in the port closure, adapter allow-list), adapter reaching internals (T-06-37), anon reaching new functions on the live project (T-06-97). Every new SQL function calls `rag_assert_tenant_key` first and is revoked from PUBLIC, anon and authenticated; the cache table has RLS on with no client policies. No plan adds a CORS header, logs a key, query, rewrite or chunk text, or commits a secret.

Switches and two-tenant coverage (completion revision):
- Every new component has a switch whose off state is today's behaviour: `RAG_QUERY_LAYER` (off means run-layer.ts is never imported and parity holds, 06-13 and 06-44 a), the sub-switches inert under the master (06-10), `RAG_QUERY_FRAMEWORK=llamaindex` (06-37), `RAG_SEMANTIC_CACHE=off` (06-21, 06-32, a byte-identical chat stream in 06-36, cache off equal to the baseline in 06-44 e), `RAG_SEMANTIC_CACHE_EMBED_STORE=false` (06-36), `VOICE_SERVER_QUERY_REWRITE=false` (06-31), `subQuestionCoverage` (06-25), `p_include_undated DEFAULT false` (06-08), the layer-gated answer-language line (06-33) and the delegate-free search stage (06-26). The 0603 triggers are always installed. With the cache empty they delete nothing, and 06-12 Task 3 now also runs the Phase 3 publish and Phase 3.1 soft-delete PGlite suites unchanged.
- Two-tenant tests: SQL and PGlite in 06-04, 06-08, 06-12, 06-21 Task 1 and 06-24; the canary matrix and route level in 06-42; LangChain end to end in 06-37. This revision adds explicit two-tenant cases to the shares cache (06-16), the RedisVL HTTP client (06-21 Task 2), the scope-bound port (06-26), the sidecar cache service (06-30), the pipeline cache stage (06-32), the chat and embed cache routes (06-36) and the admin clear route (06-40). Every component that reads or writes tenant data now has one.

## Checks run

Completion revision (2026-11-24, current working tree; git was not run, so `@e6dea83` stays the recorded baseline label):

- `frontmatter.validate --schema plan`: 46 of 46 valid.
- `verify.plan-structure`: 46 of 46 valid, exit 0, no errors; the same 4 warnings, all "one-way without a preceding checkpoint:decision" on 06-04, 06-08, 06-12 and 06-45. CONTEXT already settles these doors (D-23, D-34, D-11 with A-6, Phase 3 D-05), so no checkpoint is added, the same resolution as Phase 4 and Phase 5.
- `check.decision-coverage-plan` with 06-CONTEXT.md: passed, 88 of 88.
- Wave and overlap script: every wave equals max(in-phase dependency wave) + 1; no file appears in two plans of one wave; every file shared by two Phase 6 plans is ordered by a `depends_on` path; every cross-phase id names an existing plan file; at most 14 files and 4 tasks per plan.
- Cross-phase last-editor script: for each file in a Phase 6 plan's `files_modified`, the last Phase 3, 3.1, 4 or 5 plan that edits it is an ancestor through the combined dependency graph. 0 gaps after the edges above (there were 10 before this revision).
- Section script: every plan has objective, execution_context, context, tasks, threat_model, verification, success_criteria and output. Every auto task has files, action, an `<automated>` verify and done, and every `tdd="true"` task has a behavior block (06-34 Task 2 gained one). No fenced code sits in an action (06-18 Task 2's action was expanded), and no plan has TBD or scope-reduction wording. Threat ids T-06-01 to T-06-98 are unique, with T-06-SC in every plan.
- Acceptance baselines: all 161 grep and test gates re-run on the current tree. 160 match their recorded HEAD value. In the other, 06-21 Task 3's `invalidateTenant` gate on `src/lib/rag/ingest/stages/publish.ts`, the file was created by plan 03-13 while this revision ran (Phase 3 execution was running at the same time: the 03-13 and 03-14 SUMMARYs appeared), so its baseline is now 0, recorded as `@tree-after-03-13`. That gate still fails before 06-21, as it should. Because Phase 3 is still executing, baselines on Phase 3 files can drift again; the executor should re-measure any gate whose file a later Phase 3, 3.1, 4 or 5 plan creates.
