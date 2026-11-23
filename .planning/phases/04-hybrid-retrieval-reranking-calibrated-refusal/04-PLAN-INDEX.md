# Phase 4 Plan Index

43 plans in 14 waves. Plans in the same wave share no file in `files_modified`. Every plan runs after Phase 3 is complete (cross-phase dependencies are named in each plan's objective). The phase tracer is 04-19 Task 1 (eval route to runRetrieval v2 to the pgvector backend to RRF to the renderer). Live-service checks are the three checkpoints of 04-43; everything else is automated (see `04-VALIDATION.md`).

## Waves

| Wave | Plans | Theme |
|------|-------|-------|
| 1 | 04-01, 04-02, 04-03, 04-04, 04-05, 04-06, 04-07 | Contracts and mintScope lower-casing; env switches and config; tokenizer v2; Pydantic contracts and initial config files; PGlite roles; lexical index SQL; parents, chunking-profile schema, tenant-key guard |
| 2 | 04-08, 04-09, 04-10, 04-11, 04-12, 04-13, 04-14, 04-15, 04-16 | Trace counts; Cohere and Voyage adapters; local_bm25 and fake reranker; RRF and dedupe; context helpers and compression; refusal gate and floor; query filters; `hybrid_search_chunks`; `rag:relex` |
| 3 | 04-17, 04-18 | pgvector adapter, registry, conformance suite, startup checks; selective-filter database |
| 4 | 04-19 | Tracer: first end-to-end v2 path, retrieval params, config hash |
| 5 | 04-20, 04-21, 04-22 | Query group and refusal stage with strict routing; eval route, harness run configs, chat and embed filters; context stage |
| 6 | 04-23, 04-24, 04-25, 04-26, 04-27 | Rerank stage; translation seam; retrieval sweep; report slices, bounds and latency budgets; expand_parents |
| 7 | 04-28, 04-29, 04-30, 04-31, 04-37 | Voice under v2; exact-id third list and invoice filters; refusal calibration tool; parent-child chunker, writer, dual-write; doc types and selective_filter golden items |
| 8 | 04-32, 04-38, 04-41 | `rag:rechunk`; no-answer, cross-language and clause golden items with re-baseline; two-tenant matrix over every v2 path |
| 9 | 04-33, 04-39 | Chunking activation and rollback gates, validator parity, `rag:chunking`; fixture sweep and calibration runs |
| 10 | 04-35 | Chunking sweep, decide command, fixture report and decision |
| 11 | 04-34, 04-40 | Admin routes (chunking profiles, report, refusal status); final D-28 comparison |
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
| RNK-01 | 04-09, 04-10, 04-23, 04-40, 04-42, 04-43 |
| RNK-02 | 04-04, 04-21, 04-25, 04-39, 04-42, 04-43 |
| RNK-03 | 04-12, 04-22, 04-40, 04-42 |
| RNK-04 | 04-12, 04-22, 04-40, 04-42 |
| RNK-05 | 04-04, 04-08, 04-13, 04-20, 04-21, 04-26, 04-30, 04-34, 04-36, 04-38, 04-39, 04-40, 04-42, 04-43 |
| RNK-06 | 04-02, 04-09, 04-13, 04-23, 04-26, 04-42 |
| CHK-03 | 04-07, 04-27, 04-31, 04-33, 04-35, 04-38, 04-40, 04-41, 04-42 |
| CHK-04 | 04-04, 04-07, 04-31, 04-32, 04-33, 04-34, 04-35, 04-36, 04-42, 04-43 |
| CHK-05 | 04-04, 04-26, 04-34, 04-35, 04-36, 04-42, 04-43 |
| LAT-01 | 04-08, 04-11, 04-19, 04-24, 04-25, 04-28, 04-39, 04-42 |
| LAT-02 | 04-02, 04-23, 04-26, 04-28, 04-40, 04-42, 04-43 |
| XLG-03 | 04-10, 04-13, 04-14, 04-20, 04-23, 04-24, 04-30, 04-38, 04-39, 04-40, 04-41, 04-42, 04-43 |

## Decision coverage (04-CONTEXT.md)

| Decision | Implemented in | Decision | Implemented in |
|----------|----------------|----------|----------------|
| D-01 | 04-01, 04-17, 04-41 | D-18 | 04-04, 04-30, 04-38, 04-39 |
| D-02 | 04-11, 04-19 | D-19 | 04-01, 04-08, 04-13, 04-20, 04-21 |
| D-03 | 04-17 | D-20 | 04-07, 04-27, 04-31, 04-41, 04-42 |
| D-04 | 04-05, 04-06, 04-07, 04-15, 04-42 | D-21 | 04-04, 04-07, 04-31, 04-32, 04-33, 04-34, 04-35, 04-36 |
| D-05 | 04-14, 04-15, 04-20, 04-21, 04-29, 04-37, 04-41 | D-22 | 04-01, 04-10, 04-12, 04-15, 04-23, 04-24 |
| D-06 | 04-02, 04-15, 04-18, 04-40 | D-23 | 04-02, 04-11, 04-19, 04-21, 04-42 |
| D-07 | 04-03, 04-06, 04-17 | D-24 | 04-01, 04-02, 04-13, 04-19, 04-27, 04-29 |
| D-08 | 04-03, 04-06, 04-16 | D-25 | 04-19, 04-26, 04-28 |
| D-09 | 04-01, 04-09, 04-10, 04-23 | D-26 | 04-04, 04-26, 04-37, 04-38 |
| D-10 | 04-02, 04-23 | D-27 | 04-09, 04-10 |
| D-11 | 04-09, 04-13, 04-23 | D-28 | 04-21, 04-39, 04-40, 04-42 |
| D-12 | 04-02, 04-04, 04-19, 04-25, 04-39 | D-29 | rollout order across all plans |
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
| 2 | 04-09, 04-10, 04-23 (switchable rerankers, enlarged pool, failure keeps fused order and turns refusal off) |
| 3 | 04-12, 04-22 (edges, merge, budget; compression only when on) |
| 4 | 04-25, 04-30 (tools), 04-39 (fixture runs and refusal outcome); 04-43 Task 3 live |
| 5 | 04-17 (conformance), 04-40 (no language slice beyond noise) |
| 6 | 04-27, 04-31, 04-38 (clause items), 04-40 (clause-slice gain, no other drop) |
| 7 | 04-11, 04-19, 04-24, 04-28 (parallel variants, dedupe, cap, voice budget) |
| 8 | 04-24, 04-38, 04-39, 04-40 (translated lexical path and local_bm25; cross-lingual calibration) |
| 9 | 04-31 to 04-36 (configure, validate, build side by side, activate, roll back, sweep report, recorded decision) |
| 10 | 04-18, 04-37, 04-40 (selective_filter category, iterative scan off and on, exact path equals exact search) |
| Live | 04-43 |

## Audit notes (this revision)

- 04-01 to 04-32: structure, frontmatter and endings valid (no truncation). Fixed: 04-03 and 04-12 acceptance greps whose literal tripped the exact-count rule; 04-31 now depends on 04-19 (it reads `src/lib/rag/chunking/active.ts`); 04-04 ChunkingSweepReport gains a per-profile gate block and ChunkingDecision gains gate_passed, regressions and build_run_id (needed by the 04-33 activation gate); 04-18 and 04-27 now point to 04-40 as the final comparison.
- New: 04-33 to 04-43 close D-21 (activation, admin routes, sweep, Config UI), D-26 and D-32 (golden additions in two plans), success criterion 4 runs, D-28 (comparison), a cross-tenant matrix over every v2 path, phase close and live verification.
- Admin auth follows the Phase 3 plan-check W1 decision: every `/api/rag/admin/*` route in 04-34 gates with the merged S7 guard (`checkAdmin` / `requireAdminOrDeny` in `src/lib/admin-route-auth.ts`: signed `admin_session` cookie, else the `requireRagAdmin` session or Bearer path); the Config UI panels in 04-36 use the 03-43 `rag-fetch.js` helper with that cookie. No other credential path.
- Golden and corpus changes (04-37, 04-38) prove "zero paired differences on old items" by comparing `.items[id]` between the previous and the re-recorded baselines in both modes, because the gate refuses any run whose corpus or golden hash differs from its baseline.
- Remaining warnings: 04-07, 04-15, 04-31 and 04-42 carry `one-way` reversibility without a `checkpoint:decision`; D-04 and D-20 settle those one-way doors in CONTEXT, so no checkpoint is added.
