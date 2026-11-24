# Phase 7 Plan Index

33 plans in 13 waves, 83 tasks. Plans in the same wave share no file in `files_modified`, every file touched by two Phase 7 plans is ordered by a `depends_on` path, every plan's wave comes after the waves of its Phase 7 dependencies, and the graph is acyclic (checked by script, see "Checks run"). The phase tracer is 07-06 Task 1 (a chunk written through the Phase 3 writer reaches the outbox, one drain slice puts it in the fake store with the D-03 payload only, an external backend returns it to its own tenant hydrated from Supabase through `rag_validate_chunks`, the other tenant gets nothing, and a delete removes it). Plans 07-01, 07-32 and 07-33 are not autonomous: 07-01 Task 1 is the package-legitimacy checkpoint for @weaviate/node 3.15.5 (with @weaviate/core) and @qdrant/js-client-rest 1.20.0 (blocking-human, never auto-approvable); 07-32 holds the Vercel-plan and scheduler decision, the hosting, region and read-only-key decision, and the backend-canary branch-protection action; 07-33 is the final live-verification plan. Everything else is automated (see `07-VALIDATION.md`).

## Execution order and cross-phase dependencies

- The backend half (07-01 to 07-16, 07-28) functionally needs only Phases 3, 3.1 and 4 (CONTEXT "Dependencies"); the closeout half (07-17 to 07-27, 07-29 to 07-33) needs Phases 5, 5.1 and 6, and each of those plans carries a precondition that halts before any edit unless `05-VERIFICATION.md`, `05.1-VERIFICATION.md` and `06-VERIFICATION.md` say `passed` or `human_needed`.
- Cross-phase ids name the plan that last edits a shared file (for example 04-42 for the boundary check and Phase 4 close, 05-05 and 06-22 for package.json, 05-10 and 06-40 for the five config locations, 05-07 and 06-34 for the contract registry, 05-04 and 06-32 for the search stage and pipeline, 05-21 and 06-40 for `src/lib/rag/index.ts`, 06-43 for pr-smoke.yml) or the closing automated plan of a phase (05-25, 06-45). They are file-order constraints and do not change wave numbers. Phases 1 and 2 are executed, so their ids appear only where a draft cites the owner of a module.
- Phase 5.1's plan ids are not final: its planning was in progress in a concurrent session while Phase 7 was completed (draft files 05.1-01 to 05.1-12 appeared, with no index and the ROADMAP still saying planning not started). Its only ordering guard is the `05.1-VERIFICATION.md` precondition; once its plan index exists, add its closing plan id to the closeout plans and to any plan that shares a file with it (likely the five config locations, the contract registry, the eval route and the pipeline).
- Migrations 0701 to 0707 are common files (no mode variants): 0701 to 0703 in 07-02, 0704 and 0705 in 07-06, 0706 in 07-10, 0707 in 07-11; folded into both setup files by 07-31. `supabase/optional/vector-sync-schedule.sql` (07-13) is an operator recipe, never a migration.
- PGlite note: every PGlite test applies every file in `supabase/migrations/`. With `workflow.use_worktrees` false, run 07-10 to completion before the PGlite-backed tasks of 07-07 and 07-08 in wave 3, and 07-11 before 07-12 in wave 4 (each plan carries the note).
- 07-10 sits in wave 3 and 07-17 and 07-18 in wave 7 although their dependencies would allow earlier waves: 07-10 must not share a wave with the tracer's migrations, and 07-17 and 07-18 open the closeout half after the backend half (D-26 order).

## Waves

| Wave | Plans | Theme |
|------|-------|-------|
| 1 | 07-01, 07-02, 07-03, 07-04, 07-05 | Package checkpoint, exact-pinned installs, vector-store boundary rule and digest-pinned compose (autonomous: false); outbox, sync targets, index state, statement triggers and claim RPCs; canonical lower-case tenant key and the Qdrant scoped-request wrapper; the ten D-24 env names and RagConfig.backend; sync, reconcile and trace contracts |
| 2 | 07-06 | **Tracer** (one chunk out to an external store and back, re-validated); rag_validate_chunks and the servable view; sync read RPCs; the VectorStore interface, fake store and external-backend core |
| 3 | 07-07, 07-08, 07-09, 07-10 | Qdrant adapter, store, collection and conformance; Weaviate adapter, store, collection and conformance (two-tenant tests on both); full drain engine with paging, expansion, retries and the `[Vector Sync]` line; activation gate for enabled backends |
| 4 | 07-11, 07-12 | Reconcile with bucketed checksums, index state and outbox pruning; readiness, the backend factory with fallback, timeout and race, span fields and the config hash |
| 5 | 07-13, 07-14 | Drain route (POST and GET), after() kick, CLI and the pg_cron recipe; the cross-tenant canary suite with the planted foreign point |
| 6 | 07-15, 07-16, 07-28 | Index-compat and sync-target admin routes; the backend-canary CI job and real-store drift; the semantic-cache canary on every backend |
| 7 | 07-17, 07-18, 07-19 | Closeout contracts (DefaultsDecision, RegressionPlan, VendorDataFlow, ReviewPromotion, FailureReport); manifest metadata and check-config rules; Test-connection probes and the sidecar probe |
| 8 | 07-20, 07-21, 07-22, 07-23, 07-24, 07-26 | Generated Config UI section with masked secrets; vendor data-flow inventory; promotion with near-duplicate confirm; retrieved ids in traces and the review-chunks route; regression statistics and protocol; failure report and the nightly job |
| 9 | 07-25, 07-29 | External backends in the eval harness and the fixture regression with the provisional record; the review-queue panel with execFile promotion |
| 10 | 07-27, 07-30 | README_RAG_PIPELINE.md, the `.env` template groups and AGENTS.md; the shipped-defaults check in CI |
| 11 | 07-31 | Fold 0701 to 0707 into both setup files, off-state parity, full gates with the defaults |
| 12 | 07-32 | Human decisions and action: scheduler from the Vercel plan, hosting, region and read-only keys, backend-canary branch protection (autonomous: false) |
| 13 | 07-33 | Final live verification: hosted backends and live canary, Test-connection and vendor terms, voice latency, the live regression, then the shipped defaults from the live record (autonomous: false) |

## D-26 rollout order

| Step | Plans |
|------|-------|
| 1 migrations (outbox, targets, index state, triggers, validate RPC, grants, anon refusal) | 07-02, 07-06, 07-10, 07-11 |
| 2 sync module and drain route with fake stores | 07-06 (tracer), 07-09, 07-13 |
| 3 Qdrant wrapper and adapter with the conformance suite | 07-03, 07-07 |
| 4 Weaviate adapter with the conformance suite | 07-08 |
| 5 re-validation and fallback | 07-06, 07-12 |
| 6 reconcile and drift tests | 07-11, 07-16 |
| 7 canary suite and CI service containers | 07-14, 07-16, 07-28 |
| 8 activation-gate extension | 07-10 |
| 9 manifest metadata, generated Config UI section, masked secrets | 07-04 (names), 07-18, 07-20 |
| 10 Test-connection and index-compat | 07-15, 07-19, 07-20 |
| 11 vendor inventory and its check | 07-17, 07-21 |
| 12 docs | 07-27 |
| 13 review-queue panel, promote, failure report | 07-22, 07-23, 07-26, 07-29 |
| 14 regression runner and the fixture defaults record | 07-17, 07-24, 07-25, 07-30 |
| 15 live defaults checkpoint | 07-32, 07-33 |

Deviations from the literal order, all from interface-first dependencies: the D-24 env names (step 9) come first in 07-04 because every backend plan reads them; the tracer (07-06) runs steps 2 and 5 on one thin path before either vendor adapter; the activation gate (step 8) runs in wave 3 because it needs only the tables of step 1.

## Requirement coverage

| Requirement | Plans |
|-------------|-------|
| RET-05 | 07-02, 07-05, 07-06, 07-07, 07-08, 07-09, 07-10, 07-11, 07-13, 07-16, 07-31, 07-32, 07-33 |
| RET-06 | 07-01, 07-03, 07-07, 07-08, 07-14, 07-32, 07-33 |
| RET-07 | 07-01, 07-03, 07-06, 07-12, 07-14, 07-28, 07-31, 07-33 |
| RET-08 | 07-14, 07-16, 07-28, 07-32, 07-33 |
| RET-09 | 07-02, 07-04, 07-05, 07-08, 07-10, 07-11, 07-12, 07-14, 07-15, 07-25, 07-31, 07-33 |
| ADM-01 | 07-04, 07-15, 07-18, 07-19, 07-20, 07-31, 07-33 |
| ADM-02 | 07-17, 07-24, 07-25, 07-30, 07-33 |
| ADM-03 | 07-27 |
| ADM-04 | 07-17, 07-21, 07-27, 07-32, 07-33 |
| EVAL-17 | 07-17, 07-22, 07-23, 07-26, 07-29 |
| RET-01, RET-02, RET-03, RET-10 (every-backend clauses, verified here) | 07-07, 07-08, 07-12, 07-16 |

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
| D-08 | 07-03, 07-07 | D-21 | 07-17, 07-22, 07-23, 07-29 |
| D-09 | 07-01, 07-07, 07-08, 07-32 | D-22 | 07-17, 07-22, 07-29 |
| D-10 | 07-06, 07-14, 07-28, 07-31 | D-23 | 07-17, 07-26 |
| D-11 | 07-02, 07-04, 07-05, 07-11, 07-12 | D-24 | 07-04, 07-12, 07-13, 07-15, 07-31 |
| D-12 | 07-14, 07-16, 07-28, 07-32, 07-33 | D-25 | 07-05, 07-09, 07-12 |
| D-13 | 07-07, 07-08 | D-26 | rollout order across all plans (each objective names its step) |

| Adjustment | Implemented in | Adjustment | Implemented in |
|------------|----------------|------------|----------------|
| A-1 (@weaviate/node, boundary names) | 07-01, 07-08 | A-7 (one trigger per event, live-lease exclusion, backoff via lease_until) | 07-02, 07-09 |
| A-2 (Qdrant full-text BM25, tenant IDF) | 07-07 | A-8 (race pgvector past the search budget) | 07-05, 07-12 |
| A-3 (prefetch and idf.corpus scoping, forbidden selectors) | 07-03, 07-07 | A-9 (digest pins, pull retry, wait loop, missing backend fails) | 07-01, 07-14, 07-16 |
| A-4 (tenant not ready, names, empty BM25, quantizer none) | 07-03, 07-08 | A-10 (paired bootstrap, pre-registration, Holm, min n, confirmatory run) | 07-17, 07-24, 07-25 |
| A-5 (lower-case tenant key helper) | 07-03, 07-06 | A-11 (lexical_text and vectors as content) | 07-17, 07-21, 07-27 |
| A-6 (pg_cron default, optional Vercel Cron with GET) | 07-13, 07-27, 07-32 | A-12 (legacy_column branch 07-06, cursor column 07-02 and 07-09, pruning 07-11, PGlite canary 07-14 with real-Postgres concurrency in 07-33) | 07-02, 07-06, 07-09, 07-11, 07-14, 07-33 |

Deferred ideas (legacy path removal, per-tenant vendor opt-out, native backend fusion, a rule and profile editor in the Config UI, Qdrant JWT tenant claims) appear in no plan. Research Open Question 3's optional `RAG_BACKEND_HEDGE_MS` is not added: A-8 settles the race inside the existing budget without a new switch.

## ROADMAP success criteria

| # | Shown by |
|---|----------|
| 1 | 07-02 and 07-09 (every change type reaches the stores through outbox and drain, cascade included), 07-11 and 07-16 (drift injected on the fake store and on real Weaviate and Qdrant, detected and repaired), 07-07 and 07-08 (Weaviate tenant per workspace; Qdrant shared collection per profile with is_tenant and the tenant filter on every query and prefetch); 07-33 Task 1 live |
| 2 | 07-14 and 07-28 (canary cases on pgvector, Weaviate and Qdrant, including the planted foreign point and the cache), 07-16 (backend-canary job that cannot pass by skipping), 07-32 Task 3 (required check), 07-06 (ids failing re-validation are dropped) |
| 3 | 07-07, 07-08 and 07-16 (Phase 4 conformance unchanged on both, zh exact term included), 07-12 (not ready or failing falls back to pgvector with `degraded`) |
| 4 | 07-04, 07-18 and 07-20 (every provider and switch, masked secrets), 07-19 (Test-connection), 07-15 and 07-20 (index-compatibility warning) |
| 5 | 07-24 and 07-25 (regression on backend, profile and reranker combinations with a fixture decision record), 07-30 (shipped defaults follow the record), 07-27 (AGENTS.md, `.env` template, README_RAG_PIPELINE.md), 07-21 (vendor data-flow inventory); 07-33 Tasks 3 and 4 live |
| 6 | 07-29 (panel: open a case, write the answer and spans, promote), 07-22 (provenance production, frozen split, next eval run includes it), 07-23 (retrieved chunks for review), 07-26 (failure report by layer and category) |

## Threat register

T-07-01 to T-07-110 are unique across the phase (no reuse), plus the reserved T-07-SC in every plan. The package gate's T-07-SC is `mitigate` in 07-01 and `accept` (no install) elsewhere.

## Checks run

- `node .claude/gsd-core/bin/gsd-tools.cjs query frontmatter.validate <plan> --schema plan`: valid for all 33 plans.
- `node .claude/gsd-core/bin/gsd-tools.cjs query verify.plan-structure <plan>`: valid, exit 0, no errors for all 33 plans; the only warnings are the `one-way` reversibility notes on 07-02, 07-06, 07-11 and 07-31, whose decisions (D-01, D-10) are settled in CONTEXT and need no checkpoint.
- Dependency script: every `depends_on` id exists as a plan file; every Phase 7 dependency is in an earlier wave; no two plans of one wave share a file; every file touched by two Phase 7 plans is ordered by a dependency path.
- Every `grep -c` acceptance gate was replayed against the current tree and its HEAD baseline matches.
