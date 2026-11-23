# Phase 4 Plan Index

45 plans in 14 waves. Plans in the same wave share no file in `files_modified`, and every file touched by two plans in different waves is ordered by a `depends_on` path. Every plan runs after Phase 3 is complete (cross-phase dependencies are named in each plan's objective). The phase tracer is 04-19 Task 1 (eval route to runRetrieval v2 to the pgvector backend to RRF to the renderer). Live-service checks are the three checkpoints of 04-43; everything else is automated (see `04-VALIDATION.md`).

Execution note for wave 1: 04-05, 04-06 and 04-07 share no file, but each runs tests that build PGlite databases through createFixtureDatabase, which applies every file in `supabase/migrations/` and the role shim 04-05 changes. Run them in separate worktrees. `.planning/config.json` sets `workflow.use_worktrees` to false, so in one working tree run 04-05 to completion first, then 04-06, then 04-07, never two at once; 04-01 to 04-04 may run alongside. Each of the three plans carries the same note.

## Waves

| Wave | Plans | Theme |
|------|-------|-------|
| 1 | 04-01, 04-02, 04-03, 04-04, 04-05, 04-06, 04-07 | Contracts and mintScope lower-casing; env switches and config; tokenizer v2; Pydantic contracts and initial config files; PGlite roles; lexical index SQL; parents, chunking-profile schema, tenant-key guard |
| 2 | 04-08, 04-09, 04-10, 04-11, 04-12, 04-13, 04-14, 04-15, 04-16 | Trace counts; Cohere and Voyage adapters; local_bm25 and fake reranker; RRF and dedupe; context helpers and compression; refusal gate and floor; query filters; `hybrid_search_chunks`; `rag:relex` |
| 3 | 04-17, 04-18, 04-44, 04-45 | pgvector adapter, registry, conformance suite, startup checks; selective-filter database and its report mode; retrieval params, profile settings, config hash and active chunking cache; rerank text and reranker selection |
| 4 | 04-19 | Tracer: first end-to-end v2 path (uses the 04-44 params and hash) and the search-group behaviour |
| 5 | 04-20, 04-21, 04-22 | Query group and refusal stage with strict routing; eval route, harness run configs, chat and embed filters; context stage |
| 6 | 04-23, 04-24, 04-25, 04-26, 04-27 | Rerank stage; translation seam; retrieval sweep; report slices, bounds and latency budgets; expand_parents |
| 7 | 04-28, 04-29, 04-30, 04-31, 04-37 | Voice under v2; exact-id third list and invoice filters; refusal calibration tool; parent-child chunker, writer, dual-write; doc types and selective_filter golden items |
| 8 | 04-32, 04-38, 04-41 | `rag:rechunk`; no-answer, cross-language and clause golden items with re-baseline; two-tenant matrix over every v2 path |
| 9 | 04-33, 04-39 | Chunking activation and rollback gates, validator parity, `rag:chunking`; fixture sweep and calibration runs |
| 10 | 04-35 | Chunking sweep, decide command, fixture report and decision |
| 11 | 04-34, 04-40 | Admin routes (chunking profiles, report, refusal status); final D-28 comparison tool and run |
| 12 | 04-36 | Config UI panels (chunking profiles, refusal calibration) |
| 13 | 04-42 | Fold migrations into setup files, full gates with defaults, AGENTS.md |
| 14 | 04-43 | Live verification checkpoints (autonomous: false) |

## Requirement coverage

| Requirement | Plans |
|-------------|-------|
| RET-01 | 04-01, 04-17, 04-19, 04-40, 04-41, 04-42 |
| RET-02 | 04-06, 04-11, 04-15, 04-17, 04-19, 04-29, 04-40, 04-42 |
| RET-03 | 04-03, 04-06, 04-15, 04-16, 04-17, 04-40, 04-42, 04-43 |
| RET-04 | 04-01, 04-05, 04-07, 04-15, 04-17, 04-41, 04-42, 04-43 |
| RET-10 | 04-02, 04-04, 04-15, 04-18, 04-26, 04-37, 04-40, 04-42, 04-43 |
| DATA-08 | 04-02, 04-04, 04-14, 04-15, 04-17, 04-20, 04-21, 04-29, 04-37, 04-41, 04-42 |
| RNK-01 | 04-09, 04-10, 04-23, 04-40, 04-42, 04-43, 04-45 |
| RNK-02 | 04-04, 04-21, 04-25, 04-39, 04-42, 04-43, 04-44 |
| RNK-03 | 04-12, 04-22, 04-40, 04-42 |
| RNK-04 | 04-12, 04-22, 04-40, 04-42 |
| RNK-05 | 04-04, 04-08, 04-13, 04-20, 04-21, 04-26, 04-30, 04-34, 04-36, 04-38, 04-39, 04-40, 04-42, 04-43 |
| RNK-06 | 04-02, 04-09, 04-13, 04-23, 04-26, 04-42 |
| CHK-03 | 04-07, 04-27, 04-31, 04-33, 04-35, 04-38, 04-40, 04-41, 04-42 |
| CHK-04 | 04-04, 04-07, 04-31, 04-32, 04-33, 04-34, 04-35, 04-36, 04-42, 04-43 |
| CHK-05 | 04-04, 04-26, 04-34, 04-35, 04-36, 04-42, 04-43 |
| LAT-01 | 04-08, 04-11, 04-19, 04-24, 04-25, 04-28, 04-39, 04-42, 04-44 |
| LAT-02 | 04-02, 04-23, 04-26, 04-28, 04-40, 04-42, 04-43, 04-44, 04-45 |
| XLG-03 | 04-10, 04-13, 04-14, 04-20, 04-23, 04-24, 04-30, 04-38, 04-39, 04-40, 04-41, 04-42, 04-43, 04-45 |

## Decision coverage (04-CONTEXT.md)

| Decision | Implemented in | Decision | Implemented in |
|----------|----------------|----------|----------------|
| D-01 | 04-01, 04-17, 04-41 | D-18 | 04-04, 04-30, 04-38, 04-39 |
| D-02 | 04-11, 04-19 | D-19 | 04-01, 04-08, 04-13, 04-20, 04-21 |
| D-03 | 04-17 | D-20 | 04-07, 04-27, 04-31, 04-41, 04-42 |
| D-04 | 04-05, 04-06, 04-07, 04-15, 04-42 | D-21 | 04-04, 04-07, 04-31, 04-32, 04-33, 04-34, 04-35, 04-36, 04-44 |
| D-05 | 04-14, 04-15, 04-20, 04-21, 04-29, 04-37, 04-41 | D-22 | 04-01, 04-10, 04-12, 04-15, 04-23, 04-24 |
| D-06 | 04-02, 04-15, 04-18, 04-40 | D-23 | 04-02, 04-03, 04-11, 04-17, 04-19, 04-21, 04-31, 04-35, 04-42 |
| D-07 | 04-03, 04-06, 04-17 | D-24 | 04-01, 04-02, 04-13, 04-19, 04-27, 04-29, 04-44 |
| D-08 | 04-03, 04-06, 04-16 | D-25 | 04-19, 04-26, 04-28, 04-44 |
| D-09 | 04-01, 04-09, 04-10, 04-23, 04-45 | D-26 | 04-04, 04-26, 04-37, 04-38 |
| D-10 | 04-02, 04-23, 04-45 | D-27 | 04-09, 04-10 |
| D-11 | 04-09, 04-13, 04-23 | D-28 | 04-21, 04-39, 04-40, 04-42 |
| D-12 | 04-02, 04-04, 04-19, 04-25, 04-39, 04-44 | D-29 | rollout order across all plans |
| D-13 | 04-08, 04-11, 04-19, 04-24 | D-30 | 04-13, 04-20, 04-23, 04-34, 04-42 |
| D-14 | 04-04, 04-21, 04-25, 04-39 | D-31 | 04-20, 04-41 |
| D-15 | 04-12, 04-22, 04-27 | D-32 | 04-26, 04-38 |
| D-16 | 04-12, 04-22 | D-33 | 04-01, 04-41 |
| D-17 | 04-04, 04-13, 04-30, 04-34, 04-36, 04-39 | | |

Deferred ideas (filter UI, stemming, MMR, removing legacy voice heuristics, per-tenant chunking pointers, SQL BM25) appear in no plan.

## ROADMAP success criteria

| # | Shown by |
|---|----------|
| 1 | 04-15, 04-17 (zh/en/it exact terms on `legs.lexical`, filters before search, anon refused); 04-43 Task 1 live |
| 2 | 04-09, 04-10, 04-45, 04-23 (switchable rerankers, enlarged pool, failure keeps fused order and turns refusal off) |
| 3 | 04-12, 04-22 (edges, merge, budget; compression only when on) |
| 4 | 04-25, 04-30 (tools), 04-39 (fixture runs and refusal outcome); 04-43 Task 3 live |
| 5 | 04-17 (conformance), 04-40 (no language slice beyond noise) |
| 6 | 04-27, 04-31, 04-38 (clause items), 04-40 (clause-slice gain, no other drop) |
| 7 | 04-11, 04-44, 04-19, 04-24, 04-28 (parallel variants, dedupe, cap, voice budget) |
| 8 | 04-24, 04-38, 04-39, 04-40 (translated lexical path and local_bm25; cross-lingual calibration) |
| 9 | 04-31 to 04-36 (configure, validate, build side by side, activate, roll back, sweep report, recorded decision) |
| 10 | 04-18 (including its `--report` mode), 04-37, 04-40 (selective_filter category, iterative scan off and on, exact path equals exact search) |
| Live | 04-43 |

## Audit notes (this revision)

- 04-01 to 04-32: structure, frontmatter and endings valid (no truncation). Fixed: 04-03 and 04-12 acceptance greps whose literal tripped the exact-count rule; 04-31 now depends on 04-19 (it reads `src/lib/rag/chunking/active.ts`); 04-04 ChunkingSweepReport gains a per-profile gate block and ChunkingDecision gains gate_passed, regressions and build_run_id (needed by the 04-33 activation gate); 04-18 and 04-27 now point to 04-40 as the final comparison.
- New: 04-33 to 04-43 close D-21 (activation, admin routes, sweep, Config UI), D-26 and D-32 (golden additions in two plans), success criterion 4 runs, D-28 (comparison), a cross-tenant matrix over every v2 path, phase close and live verification.
- Admin auth follows the Phase 3 plan-check W1 decision: every `/api/rag/admin/*` route in 04-34 gates with the merged S7 guard (`checkAdmin` / `requireAdminOrDeny` in `src/lib/admin-route-auth.ts`: signed `admin_session` cookie, else the `requireRagAdmin` session or Bearer path); the Config UI panels in 04-36 use the 03-43 `rag-fetch.js` helper with that cookie. No other credential path.
- Golden and corpus changes (04-37, 04-38) prove "zero paired differences on old items" by comparing `.items[id]` between the previous and the re-recorded baselines in both modes, because the gate refuses any run whose corpus or golden hash differs from its baseline.
- Remaining warnings: 04-07, 04-15, 04-31 and 04-42 carry `one-way` reversibility without a `checkpoint:decision`; D-04 and D-20 settle those one-way doors in CONTEXT, so no checkpoint is added.

## Revision after plan-check pass 1

- Blocker 1 (04-33 and `maxInputTokens`): 04-33 now owns the field. `src/lib/rag/embeddings/registry.ts` and `tests/rag/embeddings/registry.test.ts` are in its `files_modified`; Task 2 adds `maxInputTokens` to each of the three registered providers (OpenAI 8191, Voyage 32000, Qwen3 32768) and `maxInputTokensFor`, with no conditional wording; acceptance `grep -cE "maxInputTokens:[[:space:]]*[0-9]+" registry.ts` >= 3. To keep every task at five files or fewer, profile-ops moved from Task 2 to Task 3 (tested in `tests/rag-db/chunking-cli.test.mts`). No other plan touches `registry.ts`; wave 9 partner 04-39 does not.
- Warning 2 (04-42): Task 1 now has named per-mode cases (`single-tenant setup ...`, `multi-tenant setup ...`) for clean apply on fresh PGlite, equality with the migrated schema and idempotent re-application; acceptance runs each mode alone through `--test-name-pattern` and requires `# fail 0` and at least 3 passed. 04-42 Task 2 records both runs in its SUMMARY and 04-43 Task 1 has that as a precondition.
- Warning 1 (context pressure): the flagged plans had 3 tasks each, not 4 (`verify plan-structure` reports task_count 3 for each; a count of 4 matches counting the `<tasks>` wrapper too), but 04-19 (95K estimate), 04-23 and 04-40 split cleanly without moving any existing wave. 04-19 Task 2 became 04-44 (wave 3, 2 tasks), 04-23 Task 1 became 04-45 (wave 3, 2 tasks), and 04-40 Task 2 (selective-filter `--report` mode) moved to 04-18 as Task 3 next to the builder it reports on. 04-19, 04-23 and 04-40 now have 2 tasks each. Dependents now name 04-44 or 04-45 where they read those modules (04-22, 04-28, 04-31, 04-33, 04-34). 04-44 exports `refreshActiveChunkingProfiles`, so 04-33 no longer edits `active.ts`.
- Info 1: the wave-1 execution note above is also in 04-05, 04-06 and 04-07.
- Acceptance gates checked against HEAD 525dae5: four negative `grep -v | grep -c` gates (04-06, 04-09, 04-17, 04-24) printed 0 on a missing file and passed vacuously; each now starts with `test -f` (HEAD=error:1). The 04-34 guard gate has the same existence check. Two test-run lines that passed at HEAD (04-01 tenant-brand, 04-02 config) now require new named cases and more passing tests. The 04-26 baseline annotation was corrected (the file exists: HEAD=0).
- Legacy gating (D-23, "with RAG_PIPELINE=legacy nothing in this phase runs"): chat and embed routes read `retrievalFilters` only under v2 (04-21); ingestion dual-write runs only under v2 (04-31; 04-35 run configs that seed profiles must set v2); named legacy cases or legacy-differential guards were added to 04-01, 04-02, 04-08, 04-17 and 04-19. Two stored-data changes run on every path by locked decision and are proven by parity instead of a switch: tokenizer v2 lexical_text (D-07, D-08; 04-03 now runs both legacy smoke tiers and sends only whole and joined identifier forms to the exact-id lookup) and mintScope lower-casing (D-33). Operator commands (`rag:relex`, `rag:rechunk`, `rag:chunking`), admin routes and the Config UI panels are explicit actions, not request paths.
- Security scan: no plan adds `Access-Control-Allow-Origin: *` or any CORS header, prints a key value, or logs query or chunk text. 04-43 now also keeps real queries, terms, chunk text, document names and tenant ids out of its SUMMARY.
- Cross-wave ordering: 04-33 now depends on 04-21 (both edit `src/lib/rag/index.ts`) and 04-35 on 04-24 (both edit `eval/harness/run-eval.mts`); before, only wave numbers ordered them.
