# Phase 7 Plan Index

> **2026-11-24 — four plans RETIRED (Phase 5.1.1 integration):** EVAL-17 and D-21 to D-23 moved to Phase 5.1.1 (05.1.1-CONTEXT.md D-02). 07-22 (replaced by 05.1.1-19), 07-23 (05.1.1-12), 07-26 (05.1.1-20 and 05.1.1-21) and 07-29 (05.1.1-17 and 05.1.1-18) are retired: their files are kept for history with a RETIRED header and must not be executed. 07-17 is trimmed to the release, regression and vendor contracts; 07-27 depends on 05.1.1-22 instead of 07-26 and 07-29; 07-30 takes the Phase 4.1 decision (`eval/decisions/04.1-retrieval-defaults.json`) as its starting point. 30 active plans remain; the counts below are the original planning counts. See "Revision 3".

> **2026-11-25 — Revision 4 (requirement deltas):** Phase 7 gains LANG-10, LANG-11 and SEC-11, the RET-05 delta (the outbox carries DATA-24 purges; RET-14's source-of-truth recheck is always on for Weaviate and Qdrant), the ADM-02 delta (cost per 1,000 documents and queries, latency and per-language quality in the record; no enabled language below its baseline) and the SEC-12 adapter clause (Phase 4.3's access-group filter on every Weaviate and Qdrant query and prefetch). 17 new plans (07-35 to 07-52, 07-50 being the revision-4 live checks) and small edits to the held plans 07-17, 07-18, 07-25, 07-30, 07-31, 07-32 and 07-33. **52 plans (48 active) in 18 waves, 127 tasks in active plans.** Phases 4.3, 5.3 and 6.3 are not planned yet: plans that need them carry a precondition that halts before any edit unless that phase's VERIFICATION says `passed` or `human_needed` or the named symbols exist at HEAD. See "Revision 4".

Original planning count: 34 plans in 13 waves, 86 tasks (revision 4: 52 plans, 48 active, in 18 waves). Plans in the same wave share no file in `files_modified`, every file touched by two Phase 7 plans is ordered by a `depends_on` path, every plan's wave comes after the waves of its Phase 7 dependencies, and the graph is acyclic (checked by script, see "Checks run"). The phase tracer is 07-06 Task 1 (a chunk written through the Phase 3 writer reaches the outbox, one drain slice puts it in the fake store with the D-03 payload only, an external backend returns it to its own tenant hydrated from Supabase through `rag_validate_chunks`, the other tenant gets nothing, and a delete removes it). Plans 07-01, 07-32, 07-33 and 07-50 are not autonomous: 07-01 Task 1 is the package-legitimacy checkpoint for @weaviate/node 3.15.5 (with @weaviate/core) and @qdrant/js-client-rest 1.20.0 (blocking-human, never auto-approvable), after which the orchestrator, never an executor, runs `npm install --save-exact @weaviate/node@3.15.5 @qdrant/js-client-rest@1.20.0` and commits the lock itself (Task 2 only verifies the exact pins and edits the boundary script); 07-32 holds the Vercel-plan and scheduler decision, the hosting, region and read-only-key decision, and the backend-canary branch-protection action; 07-33 is the live-verification plan for the original scope and 07-50 runs the revision-4 live items after it. Everything else is automated (see `07-VALIDATION.md`).

## Execution order and cross-phase dependencies

- The backend half (07-01 to 07-16, 07-28, 07-34) functionally needs only Phases 3, 3.1 and 4 (CONTEXT "Dependencies"); the closeout half (07-17 to 07-27, 07-29 to 07-33; 07-22, 07-23, 07-26 and 07-29 retired 2026-11-24) needs Phases 5, 5.1 and 6, and each of those plans depends on 05-25, 05.1-22 and 06-45 (the closing automated plans of Phases 5, 5.1 and 6) and keeps, as a second check, a precondition that halts before any edit unless `05-VERIFICATION.md`, `05.1-VERIFICATION.md` and `06-VERIFICATION.md` say `passed` or `human_needed`.
- Cross-phase ids name the plan that last edits a shared file (for example 04-42 for the boundary check and Phase 4 close, 05-05 and 06-22 for package.json, 05-10 and 06-40 for the five config locations, 05-07 and 06-34 for the contract registry, 05-04 and 06-32 for the search stage and pipeline, 05-21 and 06-40 for `src/lib/rag/index.ts`, 06-43 for pr-smoke.yml) or the closing automated plan of a phase (05-25, 06-45). They are file-order constraints and do not change wave numbers. Phases 1 and 2 are executed, so their ids appear only where a draft cites the owner of a module.
- Phase 5.1 edges are real `depends_on` ids since revision 2: 05.1-22 (the 5.1 close, which depends on 05.1-01 to 05.1-21) on 16 plans, and 05.1-08 on 07-01; see "Phase 5.1 edges" below. 05.1-23 (the 5.1 live checks) shares no file with Phase 7 and is not a dependency.
- Migrations 0701 to 0707 are common files (no mode variants): 0701 to 0703 in 07-02, 0704 and 0705 in 07-06, 0706 in 07-10, 0707 in 07-11; folded into both setup files by 07-31. **Revision 4: migrations 0740 onward are NOT folded** (07-31 folds 0701 to 0707 only; FOLDED_MIGRATION gains 070[1-7] and nothing else): 0740 purge ledger, purge entity, status, must-be-absent and stale-repair functions (07-35), 0741 red-team review cases (07-42), 0742 access groups in the sync reads, group-change triggers and rag_validate_chunks_for_groups (07-38), 0743 per-language quality cells (07-46), 0744 rollouts (07-47). They are applied on top of the setup files through the unfolded path of the schema-equality test and on real projects by 07-33 Task 1. Phase 6.3 may use 0700 to 0739; Phase 3.2 uses 08xx. `supabase/optional/vector-sync-schedule.sql` (07-13) is an operator recipe, never a migration.
- PGlite note: every PGlite test applies every file in `supabase/migrations/`. 07-10 depends on 07-07 and 07-08, so their PGlite-backed conformance seeding finishes before migration 0706 exists. In wave 4, with `workflow.use_worktrees` false, run 07-10, then 07-11 (migration 0707), before 07-12 runs any PGlite-backed test; each of the three plans carries the note.
- 07-17 and 07-18 sit in wave 7 although their dependencies would allow earlier waves: they open the closeout half after the backend half (D-26 order). 07-10 sits in wave 4 because it depends on 07-07 and 07-08 (revision 2, replacing an execution-note ordering); 07-13 and 07-14 already depended on it in wave 5, so no other wave moved. The remaining same-wave migration pairs in wave 4 (07-10 with 07-11 and 07-12; 07-11 with 07-12) write different files that define unrelated functions, are declared in `coupling_justified`, and are kept apart by the execution notes.
- Revision 4 (2026-11-25): 07-36 (purge in the drain, stores and reconcile) runs in wave 6 next to 07-15, 07-16 and 07-34; 07-37 (forced recheck) in wave 7; 07-44 (purge and recheck canaries in the backend-canary tier, no workflow edit because the job runs the whole tests/rag/canary folder) and 07-40 (revision-4 contracts, the only registry editor after 07-17) in wave 8; 07-25 keeps wave 9 and now depends on 07-36 and 07-37; 07-43 (ADM-02 blocks) in wave 10 before 07-30 (wave 11); the SEC-12 plans 07-38 and 07-39 land after 07-25 (waves 10 and 11; the filter is off by default through Phase 4.3's RAG_DOC_ACCESS_GROUPS); 07-45 adds the two revision-4 switches after 07-27 (wave 11); 07-46, 07-47 and 07-48 in wave 12; 07-49 and 07-52 in wave 13; 07-51 (docs) in wave 14; 07-31, 07-32, 07-33 move to waves 15, 16 and 17; 07-50 is wave 18. PGlite coupling: 07-42 (0741) with 07-25 and 07-46 (0743) with 07-47 (0744) are declared in `coupling_justified`, with the same execution note as 07-35.
- Unplanned phases (revision 4): Phase 6.3 (RET-14, DATA-24) for 07-37 and, through it, 07-44; Phase 4.3 (SEC-12) for 07-38 and 07-39; Phase 5.3 (OBS-03, `eval/config/monitor-alerts.json`) for 07-46. Each such plan halts before any edit unless the phase's VERIFICATION says passed or human_needed or the named symbols exist at HEAD; where a Phase 5.3 or 6.3 file must receive one call site (the language_drop rule dispatch, the recheck skip), the plan names the symbol to find it by and limits the edit to that site.
- 07-34 (voice and embed canaries) reuses 07-14's factory, so it runs in wave 6 next to 07-16 rather than in 07-14's wave; 07-28 builds its voice and embed cache cases on 07-34's drivers and runs in wave 7.

## Phase 5.1 edges

Added in revision 2, from the coordinator's final 5.1 ids and a grep of the 5.1 plans' `files_modified`. 05.1-22 is the 5.1 close and depends on 05.1-01 to 05.1-21, so one edge to it orders a plan after every earlier 5.1 editor of a shared file. The `05.1-VERIFICATION.md` precondition stays in the closeout plans as a second check.

| Plan | Edge added | Shared files with 5.1 (5.1 editors) |
|------|------------|--------------------------------------|
| 07-01 | 05.1-08 (specific; 07-01 has no 05.1-22 edge) | scripts/ci/check-rag-boundary.mjs, scripts/tests/check-rag-boundary.node-test.mjs (05.1-08) |
| 07-04 | 05.1-22 | src/lib/env.ts, scripts/init-env.js, scripts/config-server.js, scripts/config-ui/index.html, scripts/rag/env-manifest.json, eval/config/rag-eval-env.json (05.1-04, 05.1-12); src/lib/rag/config.ts, tests/rag/config.test.ts (05.1-06) |
| 07-05 | 05.1-22 | the contract registry, samples, export_schemas.py, eval_run.py, RagRunRequest and RagTrace schemas, contracts.generated.ts, samples.json (05.1-03) |
| 07-12 | 05.1-22 | src/lib/rag/pipeline.ts, src/lib/rag/types.ts (05.1-06); src/lib/rag/trace/log.ts (05.1-13); src/lib/rag-eval/trace.ts, src/lib/rag/v2/config-hash.ts (05.1-14) |
| 07-17 | 05.1-22 | the contract registry, samples, export_schemas.py, contracts.generated.ts, samples.json (05.1-03) |
| 07-18 | 05.1-22 | scripts/rag/env-manifest.json (05.1-04) |
| 07-19 | 05.1-22 | rag-sidecar/src/rag_sidecar/main.py (05.1-07) |
| 07-20 | 05.1-22 | scripts/config-server.js, scripts/config-ui/index.html (05.1-04, 05.1-12) |
| 07-21 | 05.1-22 | .github/workflows/pr-smoke.yml (05.1-19) |
| 07-22 (RETIRED) | 05.1-22 | none (phase edge for the 5.1 attack-success result it reads) |
| 07-23 (RETIRED) | 05.1-22 | none (phase edge) |
| 07-24 | 05.1-22 | none (phase edge for the 5.1 switches in the ablation) |
| 07-25 | 05.1-22 | eval/harness/run-eval.mts (05.1-19) |
| 07-26 (RETIRED) | 05.1-22 | .github/workflows/nightly.yml, scripts/ci/check-workflows.py (05.1-19) |
| 07-27 | 05.1-22 | scripts/init-env.js (05.1-04); AGENTS.md, tests/rag/agents-guide.test.ts (05.1-22) |
| 07-29 (RETIRED) | 05.1-22 | scripts/config-server.js, scripts/config-ui/index.html (05.1-04, 05.1-12) |
| 07-30 | 05.1-22 | .github/workflows/pr-smoke.yml (05.1-19) |
| 07-37, 07-38 to 07-49, 07-51, 07-52 (revision 4) | 05.1-22 | none shared directly except eval/harness/run-nightly.mts, read by 07-42 (05.1-19); phase edge for the closeout half |

Covered without a new edge (through a Phase 7 ancestor that has the 05.1-22 edge): 07-16 shares pr-smoke.yml and check-workflows.py with 05.1-19 (through 07-14, which depends on 07-12); 07-33 shares the config locations with 05.1-04 and 05.1-12 (through 07-32 and 07-31). 07-28, 07-31, 07-32 and 07-34 share no file with 5.1.

## 07-30 and the Phase 4.1 decision

While the Phase 7 record is provisional, 07-30's expected map is the `defaults` map of `eval/decisions/04.1-retrieval-defaults.json` for the five DFLT variables, and every other variable keeps its incumbent value; 07-18's manifest `default` field carries the 04.1 values; 07-17 and 07-25 read the same file as the incumbent. (04.1 D-25) For every name in `implicit_in_templates` of `eval/decisions/04.1-retrieval-defaults.json` (today `RAG_PIPELINE`), the `scripts/init-env.js` template, the three `scripts/config-server.js` templates, the manifest default and the eval pin must hold the empty value, and only the `src/lib/env.ts` fallback and `DEFAULT_PIPELINE` are compared with the expected map.

## Waves

| Wave | Plans | Theme |
|------|-------|-------|
| 1 | 07-01, 07-02, 07-03, 07-04, 07-05 | Package checkpoint, the orchestrator-run exact-pinned install, the pin check, the vector-store boundary rule and digest-pinned compose (autonomous: false); outbox, sync targets, index state, statement triggers and claim RPCs; canonical lower-case tenant key and the Qdrant scoped-request wrapper; the ten D-24 env names and RagConfig.backend; sync, reconcile and trace contracts |
| 2 | 07-06 | **Tracer** (one chunk out to an external store and back, re-validated); rag_validate_chunks and the servable view; sync read RPCs; the VectorStore interface, fake store and external-backend core |
| 3 | 07-07, 07-08, 07-09 | Qdrant adapter, store, collection and conformance; Weaviate adapter, store, collection and conformance (two-tenant tests on both); full drain engine with paging, expansion, retries and the `[Vector Sync]` line |
| 4 | 07-10, 07-11, 07-12 | Activation gate for enabled backends (after 07-07 and 07-08); reconcile with bucketed checksums, index state and outbox pruning; readiness, the backend factory with fallback, timeout and race, span fields and the config hash |
| 5 | 07-13, 07-14, 07-35 | Drain route (POST and GET), after() kick, CLI and the pg_cron recipe; the cross-tenant canary suite with the planted foreign point; migration 0740 (purge entity, ledger, enqueue seam for Phase 6.3, status, must-be-absent, re-open, stale-repair enqueue) |
| 6 | 07-15, 07-16, 07-34, 07-36 | Index-compat and sync-target admin routes; the backend-canary CI job and real-store drift; voice-scope and embed-scope canaries; purge in the drain, both vendor stores and reconcile |
| 7 | 07-17, 07-18, 07-19, 07-28, 07-37 | Closeout contracts (with the ADM-02 blocks); manifest metadata and check-config rules (04.1 defaults, 04.1 D-25); Test-connection probes; the semantic-cache canary; RET-14 forced on for Weaviate and Qdrant in the one re-validation query, stale repair, Phase 6.3 purge-seam check |
| 8 | 07-20, 07-21, 07-24, 07-40, 07-44 | Generated Config UI section with masked secrets; vendor data-flow inventory; regression statistics and protocol; revision-4 contracts (trace languages, calibration, language cells and alert, rollout, red team); purge and recheck cases in the backend-canary tier |
| 9 | 07-25, 07-41, 07-42 | External backends in the eval harness and the fixture regression with the provisional record (incumbent: the 04.1 decision); chunk languages on traces, per-language judge scores, confidence calibration tool; red-team runner, corpus, report and review cases (0741) |
| 10 | 07-27, 07-38, 07-43 | README_RAG_PIPELINE.md, the `.env` template groups and AGENTS.md; access groups in the sync payload, group-change triggers and group-aware re-validation (0742); ADM-02 cost, latency and per-language blocks with the language rule in decide |
| 11 | 07-30, 07-39, 07-45 | The shipped-defaults check in CI (ADM-02 blocks, 04.1 D-25); access-group filter on every query and prefetch with canaries; RAG_ROLLOUTS and RAG_LANG_CONFIDENCE in every config location |
| 12 | 07-46, 07-47, 07-48 | Per-language cells (0743), the language_drop rule of the OBS-03 job, calibrated confidence; rollouts (0744) with the mixed-rollout canary; red-team Config UI panel |
| 13 | 07-49, 07-52 | Rollout promotion gated on per-language monitoring, admin route and Config UI panel; language addition and removal rules |
| 14 | 07-51 | Revision-4 documentation in README_RAG_PIPELINE.md and AGENTS.md |
| 15 | 07-31 | Fold 0701 to 0707 (only; 0740 onward stay unfolded) into both setup files, off-state parity including the revision-4 switches, full gates |
| 16 | 07-32 | Human decisions and action: scheduler from the Vercel plan, hosting, region and read-only keys, backend-canary branch protection (autonomous: false) |
| 17 | 07-33 | Live verification: hosted backends and live canary (migrations 0701 to 0707 and 0740 onward), Test-connection and vendor terms, voice latency, the live regression with the ADM-02 blocks, then the shipped defaults from the live record (autonomous: false) |
| 18 | 07-50 | Revision-4 live checks: purge, recheck and access groups on hosted backends, rollout and the LANG-10 alert channel, the red-team run from the Config UI (autonomous: false) |

Retired: 07-22, 07-23, 07-26 (originally wave 8) and 07-29 (originally wave 9).

## D-26 rollout order

| Step | Plans |
|------|-------|
| 1 migrations (outbox, targets, index state, triggers, validate RPC, grants, anon refusal) | 07-02, 07-06, 07-10, 07-11 |
| 2 sync module and drain route with fake stores | 07-06 (tracer), 07-09, 07-13 |
| 3 Qdrant wrapper and adapter with the conformance suite | 07-03, 07-07 |
| 4 Weaviate adapter with the conformance suite | 07-08 |
| 5 re-validation and fallback | 07-06, 07-12 |
| 6 reconcile and drift tests | 07-11, 07-16 |
| 7 canary suite and CI service containers | 07-14, 07-16, 07-28, 07-34 |
| 8 activation-gate extension | 07-10 |
| 9 manifest metadata, generated Config UI section, masked secrets | 07-04 (names), 07-18, 07-20 |
| 10 Test-connection and index-compat | 07-15, 07-19, 07-20 |
| 11 vendor inventory and its check | 07-17, 07-21 |
| 12 docs | 07-27 |
| 13 review-queue panel, promote, failure report | moved to Phase 5.1.1 (05.1.1-12, 05.1.1-17 to 05.1.1-21); 07-22, 07-23, 07-26, 07-29 retired |
| 14 regression runner and the fixture defaults record | 07-17, 07-24, 07-25, 07-30 |
| 15 live defaults checkpoint | 07-32, 07-33 |
| revision 4: purge and forced recheck (steps 1, 2, 5, 6, 7 extended) | 07-35, 07-36, 07-37, 07-44 |
| revision 4: access groups on external backends (steps 3 to 7 extended) | 07-38, 07-39 |
| revision 4: per-language monitoring, rollouts, language changes, red team, ADM-02 blocks | 07-40 to 07-43, 07-45 to 07-49, 07-51, 07-52; live 07-50 |

Deviations from the literal order, all from interface-first dependencies: the D-24 env names (step 9) come first in 07-04 because every backend plan reads them; the tracer (07-06) runs steps 2 and 5 on one thin path before either vendor adapter; the activation gate (step 8) runs in wave 4, after the two adapters (07-07, 07-08) whose PGlite seeding must run before its migration 0706 lands.

## Requirement coverage

| Requirement | Plans |
|-------------|-------|
| RET-05 | 07-02, 07-05, 07-06, 07-07, 07-08, 07-09, 07-10, 07-11, 07-13, 07-16, 07-31, 07-32, 07-33; delta (DATA-24 purges through the outbox) 07-35, 07-36, 07-44, 07-50, 07-51; delta (RET-14 always on for Weaviate and Qdrant) 07-37, 07-44, 07-50 |
| RET-06 | 07-01, 07-03, 07-07, 07-08, 07-14, 07-32, 07-33, 07-38, 07-39 |
| RET-07 | 07-01, 07-03, 07-06, 07-12, 07-14, 07-28, 07-31, 07-33, 07-34, 07-39 |
| RET-08 | 07-14, 07-16, 07-28, 07-32, 07-33, 07-34, 07-39, 07-44, 07-47 (mixed rollout canary), 07-50 |
| RET-09 | 07-02, 07-04, 07-05, 07-08, 07-10, 07-11, 07-12, 07-14, 07-15, 07-25, 07-31, 07-33, 07-34 |
| RET-14 (owned by Phase 6.3; Phase 7 forces it on for external backends) | 07-37, 07-44 (requirement field RET-05, whose delta it is) |
| ADM-01 | 07-04, 07-15, 07-18, 07-19, 07-20, 07-31, 07-33, 07-45 |
| ADM-02 | 07-17, 07-24, 07-25, 07-30, 07-33; delta (cost, latency, per-language quality, no language below baseline) 07-17, 07-43, 07-30, 07-33 |
| ADM-03 | 07-27, 07-51 |
| ADM-04 | 07-17, 07-21, 07-27, 07-32, 07-33 |
| LANG-10 | 07-40 (contracts), 07-41 (trace chunk languages, per-language judge scores, confidence calibration), 07-45 (RAG_LANG_CONFIDENCE), 07-46 (per-language cells and route, the language_drop rule of the OBS-03 job, calibrated confidence in the log), 07-49 (per-language monitoring before full activation), 07-31 (off parity), 07-50 (alert channel live), 07-51 (docs) |
| LANG-11 | 07-40 (contracts), 07-45 (RAG_ROLLOUTS), 07-47 (tenant and traffic-share rollouts of embedding profiles, chunking profiles and rebuild runs, per-tenant rollback, mixed-rollout canary), 07-49 (promotion gated on LANG-10 monitoring, admin route, Config UI panel), 07-52 (language addition and removal), 07-31, 07-32, 07-33, 07-50, 07-51 |
| SEC-11 | 07-40 (contracts), 07-42 (corpus, runner, per-technique and per-language report, review cases), 07-48 (Config UI start, admin-only), 07-31, 07-50, 07-51 |
| SEC-12 (owned by Phase 4.3; Phase 7 delivers the Weaviate and Qdrant adapter clause) | 07-38 (payload, group-change sync, indexes, group-aware re-validation), 07-39 (filter on every query and prefetch, canaries), 07-32, 07-33, 07-50 |
| RET-01, RET-02, RET-03, RET-10 (every-backend clauses, verified here) | 07-07, 07-08, 07-12, 07-16 |

EVAL-17 left Phase 7 on 2026-11-24 and is covered by Phase 5.1.1.

## Decision coverage (07-CONTEXT.md, adjustments A-1 to A-12 applied)

| Decision | Implemented in | Decision | Implemented in |
|----------|----------------|----------|----------------|
| D-01 | 07-02, 07-31 (fold) | D-14 | 07-04, 07-18, 07-20 |
| D-02 | 07-06, 07-07, 07-08, 07-09 | D-15 | 07-15, 07-19, 07-20, 07-33 |
| D-03 | 07-06, 07-07, 07-08, 07-09 | D-16 | 07-15, 07-20 |
| D-04 | 07-02, 07-06, 07-09, 07-13, 07-32 | D-17 | 07-05, 07-24, 07-25, 07-33 |
| D-05 | 07-05, 07-11, 07-13, 07-16 | D-18 | 07-17, 07-18, 07-24, 07-25, 07-30, 07-33 |
| D-06 | 07-03, 07-07, 07-08, 07-10 | D-19 | 07-27 |
| D-07 | 07-03, 07-08, 07-09 | D-20 | 07-17, 07-21, 07-33 |
| D-08 | 07-03, 07-07 | D-21 | Moved to Phase 5.1.1 |
| D-09 | 07-01, 07-07, 07-08, 07-32 | D-22 | Moved to Phase 5.1.1 |
| D-10 | 07-06, 07-14, 07-28, 07-31, 07-34 | D-23 | Moved to Phase 5.1.1 |
| D-11 | 07-02, 07-04, 07-05, 07-11, 07-12, 07-34 | D-24 | 07-04, 07-12, 07-13, 07-15, 07-31 |
| D-12 | 07-14, 07-16, 07-28, 07-32, 07-33, 07-34 | D-25 | 07-05, 07-09, 07-12 |
| D-13 | 07-07, 07-08 | D-26 | rollout order across all plans (each objective names its step) |

| Adjustment | Implemented in | Adjustment | Implemented in |
|------------|----------------|------------|----------------|
| A-1 (@weaviate/node, boundary names) | 07-01, 07-08 | A-7 (one trigger per event, live-lease exclusion, backoff via lease_until) | 07-02, 07-09 |
| A-2 (Qdrant full-text BM25, tenant IDF) | 07-07 | A-8 (race pgvector past the search budget) | 07-05, 07-12 |
| A-3 (prefetch and idf.corpus scoping, forbidden selectors) | 07-03, 07-07 | A-9 (digest pins, pull retry, wait loop, missing backend fails) | 07-01, 07-14, 07-16 |
| A-4 (tenant not ready, names, empty BM25, quantizer none) | 07-03, 07-08 | A-10 (paired bootstrap, pre-registration, Holm, min n, confirmatory run) | 07-17, 07-24, 07-25 |
| A-5 (lower-case tenant key helper) | 07-03, 07-06 | A-11 (lexical_text and vectors as content) | 07-17, 07-21, 07-27 |
| A-6 (pg_cron default, optional Vercel Cron with GET) | 07-13, 07-27, 07-32 | A-12 (legacy_column branch 07-06, cursor column 07-02 and 07-09, pruning 07-11, PGlite canary 07-14 with real-Postgres concurrency in 07-33) | 07-02, 07-06, 07-09, 07-11, 07-14, 07-33 |

Revision 4 extends decisions without changing them: D-03's payload gains `access_groups` (07-38); D-05 reconcile keeps purged documents absent (07-36); D-10 re-validation doubles as the RET-14 recheck and gains a group-aware variant used only with Phase 4.3's switch on (07-37, 07-39); D-12 canaries add purge, recheck, access-group and mixed-rollout cases (07-44, 07-39, 07-47); D-18's record gains the ADM-02 blocks (07-17, 07-43, 07-30).

Deferred ideas (legacy path removal, per-tenant vendor opt-out, native backend fusion, a rule and profile editor in the Config UI, Qdrant JWT tenant claims) appear in no plan. Research Open Question 3's optional `RAG_BACKEND_HEDGE_MS` is not added: A-8 settles the race inside the existing budget without a new switch.

## ROADMAP success criteria

| # | Shown by |
|---|----------|
| 1 | 07-02 and 07-09 (every change type reaches the stores through outbox and drain, cascade included), 07-11 and 07-16 (drift injected on the fake store and on real Weaviate and Qdrant, detected and repaired), 07-07 and 07-08 (Weaviate tenant per workspace; Qdrant shared collection per profile with is_tenant and the tenant filter on every query and prefetch); 07-33 Task 1 live |
| 2 | 07-14, 07-28 and 07-34 (canary cases on pgvector, Weaviate and Qdrant through the chat, voice and embed entry points, including the planted foreign point, the cache and filter-ignoring negative controls dropped by the Supabase re-check), 07-16 (backend-canary job that cannot pass by skipping), 07-32 Task 3 (required check), 07-06 (ids failing re-validation are dropped) |
| 3 | 07-07, 07-08 and 07-16 (Phase 4 conformance unchanged on both, zh exact term included), 07-12 (not ready or failing falls back to pgvector with `degraded`) |
| 4 | 07-04, 07-18 and 07-20 (every provider and switch, masked secrets), 07-19 (Test-connection), 07-15 and 07-20 (index-compatibility warning) |
| 5 | 07-24 and 07-25 (regression on backend, profile and reranker combinations with a fixture decision record), 07-30 (shipped defaults follow the record), 07-27 (AGENTS.md, `.env` template, README_RAG_PIPELINE.md), 07-21 (vendor data-flow inventory); 07-33 Tasks 3 and 4 live |
| 6 | Removed 2026-11-24: the criterion moved to Phase 5.1.1 with EVAL-17 (05.1.1-12, 05.1.1-17 to 05.1.1-21) |
| 7 | Trace chunk languages: 07-41; per-language judge scores, votes and information-not-available rate: 07-41, 07-46; the one-language-drops fixture alert: 07-46 Task 1 and Task 2; tenant or traffic-share activation and per-tenant rollback: 07-47, 07-49; adding a fixture language with its baseline and reprocessing only und, scanned and out-of-date documents: 07-52; red-team run from the Config UI with a review case per success: 07-42, 07-48; cost per 1,000 documents and queries in the defaults record: 07-17, 07-43, 07-30; live: 07-33 Task 3 and 07-50 |

## Revision 1 (plan-check pass 1)

| Plan | Change |
|------|--------|
| 07-01 | B1: the install moved out of the executor. Task 1 carries an `<orchestrator-only>` step: on approval the orchestrator runs `npm install --save-exact @weaviate/node@3.15.5 @qdrant/js-client-rest@1.20.0` (weaviate-client@3.15.3 on fallback) and commits the lock. Task 2 has a precondition on that commit, no package files in `<files>`, a node lock check instead of `npm ls`, and only edits the boundary script; the `npm ci` verification line is gone |
| 07-34 (new) | B2: voice-scope canary (resolveVoiceScope with minted tokens, RAG_RETRIEVAL_BACKEND_VOICE at default and set to each backend, not-ready fallback) and embed-scope canary (resolveEmbedScope with RAG_EMBED_TENANT, raw-body refusal) on pgvector, Weaviate and Qdrant; every case has a filter-ignoring negative control whose foreign ids rag_validate_chunks drops |
| 07-28 | B2: wave 6 to 7, depends on 07-34; new Task 3 for embed-scope cache isolation with a tenant-ignoring fake cache backend rejected by the Supabase source re-check, and voice never touching the cache (Phase 6 D-32) under every voice backend setting |
| 07-14 | points to 07-34 for the voice and embed cases; baseline re-measure note |
| 07-29 | W: every review endpoint, promote included, calls a new admin route GET /api/rag/admin/review/authorize (checkAdmin from admin-route-auth, admin_users) before any action, on top of CSRF and loopback; non-admin, no-session, unreachable and route tests |
| 07-19 | W: responses are { provider, ok, latencyMs, code, message } with a fixed message per code; a "never leaks endpoint" test over every provider and failure path asserts no URL, host or host:port reaches the response or logs (route and sidecar too) |
| 07-02, 07-06, 07-10, 07-13, 07-14, 07-34 | W: baseline note to re-measure every count gate at plan start; two drifted baselines (profile-ops.ts now exists) refreshed in 07-10 and 07-13 |
| 07-10, 07-11 | INFO 2: `coupling_justified` for the same-wave migration pairs |
| 07-33 | unchanged at 4 tasks (accepted by the coordinator) |

## Revision 2

| Plan | Change |
|------|--------|
| 07-01 | `depends_on` + 05.1-08 (the only 5.1 plan that shares the boundary check, not reached through 05.1-22) |
| 07-04, 07-05, 07-12 | `depends_on` + 05.1-22, with the shared 5.1 editors named in the objective |
| 07-17 to 07-27, 07-29, 07-30 | `depends_on` + 05.1-22; the precondition-only wording replaced, the 05.1-VERIFICATION.md precondition kept as a second check |
| 07-29 | the authorize route sends no Access-Control-Allow-Origin (or other Access-Control-*) header on any status, including requests with a foreign Origin, and has no OPTIONS handler; test, grep gate and threat T-07-119 |
| 07-10 | `depends_on` + 07-07 and 07-08 (real edge replacing the execution-note ordering); wave 3 to 4; `coupling_justified` now names 07-11 and 07-12; execution note updated |
| 07-07, 07-08 | execution note about 07-10 replaced by an ordering note (07-10 now depends on them) |
| 07-11, 07-12 | execution notes updated for 07-10 in wave 4 |

## Revision 3 (2026-11-24, cross-phase integration)

| Plan | Change |
|------|--------|
| 07-22, 07-23, 07-26, 07-29 | RETIRED: superseded by 05.1.1-19, 05.1.1-12, 05.1.1-20/05.1.1-21 and 05.1.1-17/05.1.1-18 (EVAL-17 and D-21 to D-23 moved to Phase 5.1.1). Files kept with a RETIRED header; not executed |
| 07-17 | Trimmed: `ReviewPromotion`, `ReviewEvidenceSpan`, `ReviewRetrievedChunk`, `FailureReport`, `FailureEntry`, the ReviewQueueItem additions and their schema outputs removed; EVAL-17 dropped from requirements; `DefaultsDecision` gains an optional `ship_check_ref` (ShipCheckResult, 05.1.1-01); `depends_on` + 05.1.1-22 |
| 07-27 | `depends_on`: 07-26 and 07-29 replaced by 05.1.1-22; the 5.1.1 CLIs and panels documented by reference |
| 07-30 | Phase 4.1 amendment (04.1-CONTEXT D-20): while the Phase 7 record is provisional, the expected map for the five DFLT variables comes from `eval/decisions/04.1-retrieval-defaults.json`; `depends_on` + 04.1-09 |
| ROADMAP | Phase 7 Requirements no longer list EVAL-17; success criterion 6 removed (moved to Phase 5.1.1) |

## Revision 4 (2026-11-25, requirement deltas)

| Plan | Change |
|------|--------|
| 07-35 (new) | Migration 0740: `purge` outbox entity, purge ledger and per-target table, rag_vector_sync_enqueue_purge (the seam Phase 6.3 calls), purge row, complete, status, must-be-absent listing (document_id, purge_id, lineage_id), purge re-open and the stale-repair enqueue |
| 07-36 (new) | Purge groups in the drain across every profile collection, deleteDocuments and countDocumentPoints on the fake, Qdrant and Weaviate stores, reconcile keeps purged documents absent (re-open and stale state) |
| 07-37 (new) | RET-14 forced on for Weaviate and Qdrant, composed into the one rag_validate_chunks call (no second query), stale_index_drop, bounded stale repair after the response, check of the Phase 6.3 purge call |
| 07-38, 07-39 (new) | SEC-12 adapter clause: access_groups in the payload, group-change triggers, indexes, rag_validate_chunks_for_groups (0742); filter on every query and prefetch, group-aware re-validation, canaries with a planted point missing the field |
| 07-40 (new) | Revision-4 Pydantic contracts and generated Zod |
| 07-41, 07-46 (new) | LANG-10: trace chunk languages, per-language judge scores, confidence calibration tool and file; per-language cells (0743) and route, the language_drop rule of the OBS-03 job, calibrated confidence behind RAG_LANG_CONFIDENCE |
| 07-42, 07-48 (new) | SEC-11: technique list, synthetic corpus, runner over the SEC-04 set and corpus, report per technique and language, review cases (0741); Config UI start, admin-only |
| 07-43 (new) | ADM-02 delta: cost, latency and per-language blocks, the language rule in decide, the annotated fixture record |
| 07-44 (new) | Purge and forced-recheck cases in the backend-canary tier |
| 07-45 (new) | RAG_ROLLOUTS and RAG_LANG_CONFIDENCE in every config location, parsed config |
| 07-47, 07-49, 07-52 (new) | LANG-11: rollouts (0744), mixed-rollout canary; promotion gated on per-language monitoring, admin route and panel; language addition and removal rules |
| 07-50, 07-51 (new) | Revision-4 live checks; revision-4 docs |
| 07-17 | DefaultsDecision gains cost (CostSummary, CostPer1000), latency (LatencySummary) and per_language (LanguageQuality); the incumbent is read from the 04.1 decision; `depends_on` + 04.1-09 |
| 07-18 | Phase 4.1 amendment: manifest defaults carry the 04.1 values and the 04.1 D-25 sentence; `depends_on` + 04.1-09 |
| 07-25 | `depends_on` + 07-36, 07-37, 04.1-09; the incumbent is the 04.1 decision; notes on 07-43 and the access-group plans |
| 07-30 | Wave 11, `depends_on` + 07-43; refuses a record without the ADM-02 blocks or with an adopted language below baseline; the 04.1 D-25 sentence and its test |
| 07-31 | Wave 15, `depends_on` + every revision-4 automated plan; folds 0701 to 0707 only (0740 onward unfolded); revision-4 off parity and extra checks in the full gates; requirements + LANG-10, LANG-11, SEC-11 |
| 07-32 | Wave 16; the required backend-canary check also gates the revision-4 canary files; requirements + LANG-11, SEC-12 |
| 07-33 | Wave 17; applies 0740 onward; Task 3 reviews the ADM-02 blocks; 07-50 follows; requirements + LANG-11, SEC-12 |

Planner resolutions recorded in the plans (owner rule): purge records carry document ids because the outbox is notification-only; applicable purge targets include disabled backends with index state; one query and two counters for the forced recheck; Phase 7 does not edit the Phase 6.3 purge flow or more than one call site of Phase 5.3 or 6.3 code; the access-group payload is always written and filtered only when Phase 4.3's switch is on; rollouts are per tenant (deterministic salted hash), never per request; promotion needs every enabled language measured and holding against the arm's own pre-rollout window; language removal is query-side only; the red-team run executes in config-server after an admin check because it exceeds the 60 s function limit; prices are never guessed (not_provided). Phase 7 has no UI-SPEC: the UI plans 07-48, 07-49 and 07-52 follow 07-UI-SPEC.md when it exists, otherwise the existing panel conventions, and record the `## Design skills` table.

## Threat register

T-07-01 to T-07-171 are unique across the phase (no reuse; T-07-120 to T-07-171 added by revision 4), plus the reserved T-07-SC in every plan. The package gate's T-07-SC is `mitigate` in 07-01 and `accept` (no install) elsewhere.

## Checks run

- `node .claude/gsd-core/bin/gsd-tools.cjs query frontmatter.validate <plan> --schema plan`: valid for all 34 original plans and, at revision 4, for every new and edited plan (07-17, 07-18, 07-25, 07-30 to 07-33, 07-35 to 07-52).
- `node .claude/gsd-core/bin/gsd-tools.cjs query verify.plan-structure <plan>`: valid, exit 0, no errors for all 34 original plans and for every revision-4 new and edited plan; the only warnings are the `one-way` reversibility notes on 07-02, 07-06, 07-11 and 07-31, whose decisions (D-01, D-10) are settled in CONTEXT and need no checkpoint.
- Dependency script (re-run at revision 4 over 48 active plans): every `depends_on` id exists as a plan file; no active plan depends on a retired one; every Phase 7 dependency is in an earlier wave; no two plans of one wave share a file; every file touched by two Phase 7 plans is ordered by a dependency path.
- Every `grep -c` acceptance gate was replayed against the current tree and its HEAD baseline matches.
