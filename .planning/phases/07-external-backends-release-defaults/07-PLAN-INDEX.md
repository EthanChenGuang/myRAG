# Phase 7 Plan Index

34 plans in 13 waves, 86 tasks. Plans in the same wave share no file in `files_modified`, every file touched by two Phase 7 plans is ordered by a `depends_on` path, every plan's wave comes after the waves of its Phase 7 dependencies, and the graph is acyclic (checked by script, see "Checks run"). The phase tracer is 07-06 Task 1 (a chunk written through the Phase 3 writer reaches the outbox, one drain slice puts it in the fake store with the D-03 payload only, an external backend returns it to its own tenant hydrated from Supabase through `rag_validate_chunks`, the other tenant gets nothing, and a delete removes it). Plans 07-01, 07-32 and 07-33 are not autonomous: 07-01 Task 1 is the package-legitimacy checkpoint for @weaviate/node 3.15.5 (with @weaviate/core) and @qdrant/js-client-rest 1.20.0 (blocking-human, never auto-approvable), after which the orchestrator, never an executor, runs `npm install --save-exact @weaviate/node@3.15.5 @qdrant/js-client-rest@1.20.0` and commits the lock itself (Task 2 only verifies the exact pins and edits the boundary script); 07-32 holds the Vercel-plan and scheduler decision, the hosting, region and read-only-key decision, and the backend-canary branch-protection action; 07-33 is the final live-verification plan. Everything else is automated (see `07-VALIDATION.md`).

## Execution order and cross-phase dependencies

- The backend half (07-01 to 07-16, 07-28, 07-34) functionally needs only Phases 3, 3.1 and 4 (CONTEXT "Dependencies"); the closeout half (07-17 to 07-27, 07-29 to 07-33) needs Phases 5, 5.1 and 6, and each of those plans carries a precondition that halts before any edit unless `05-VERIFICATION.md`, `05.1-VERIFICATION.md` and `06-VERIFICATION.md` say `passed` or `human_needed`.
- Cross-phase ids name the plan that last edits a shared file (for example 04-42 for the boundary check and Phase 4 close, 05-05 and 06-22 for package.json, 05-10 and 06-40 for the five config locations, 05-07 and 06-34 for the contract registry, 05-04 and 06-32 for the search stage and pipeline, 05-21 and 06-40 for `src/lib/rag/index.ts`, 06-43 for pr-smoke.yml) or the closing automated plan of a phase (05-25, 06-45). They are file-order constraints and do not change wave numbers. Phases 1 and 2 are executed, so their ids appear only where a draft cites the owner of a module.
- Phase 5.1's plan ids are not final; see "Pending 5.1 edges" below.
- Migrations 0701 to 0707 are common files (no mode variants): 0701 to 0703 in 07-02, 0704 and 0705 in 07-06, 0706 in 07-10, 0707 in 07-11; folded into both setup files by 07-31. `supabase/optional/vector-sync-schedule.sql` (07-13) is an operator recipe, never a migration.
- PGlite note: every PGlite test applies every file in `supabase/migrations/`. With `workflow.use_worktrees` false, run 07-10 to completion before the PGlite-backed tasks of 07-07 and 07-08 in wave 3, and 07-11 before 07-12 in wave 4 (each plan carries the note).
- 07-10 sits in wave 3 and 07-17 and 07-18 in wave 7 although their dependencies would allow earlier waves: 07-10 must not share a wave with the tracer's migrations, and 07-17 and 07-18 open the closeout half after the backend half (D-26 order). The same-wave migration pairs (07-10 with 07-07 and 07-08; 07-11 with 07-12) are declared in `coupling_justified`: both orders give a correct tree, and the execution notes forbid running them at the same instant.
- 07-34 (voice and embed canaries) reuses 07-14's factory, so it runs in wave 6 next to 07-16 rather than in 07-14's wave; 07-28 builds its voice and embed cache cases on 07-34's drivers and runs in wave 7.

## Pending 5.1 edges

Phase 5.1 was being planned in a concurrent session (draft files 05.1-01 to 05.1-12, no plan index, ROADMAP still "planning not started"), so no 5.1 plan id appears in any `depends_on`. Until the final ids arrive, each closeout plan halts on its `05.1-VERIFICATION.md` precondition. When the coordinator sends them, add the closing 5.1 plan id (and, for shared files, the last 5.1 editor) to:

| Plan | Why it needs a 5.1 edge |
|------|-------------------------|
| 07-04 | the five config locations, the manifest and the eval pin (5.1 adds RAG_CONTEXT_TAGGING, RAG_INJECTION_CHECK and the Lakera and Prompt Guard settings) |
| 07-05 | the contract registry, eval_run.py and the generated Zod (5.1 adds injection trace fields) |
| 07-12 | the pipeline and the v2 search and context stages (5.1 tags and filters retrieved chunks) |
| 07-25 | the eval route and run-eval.mts overlay (the injection slice and the 5.1 switches in the ablation) |
| 07-17 to 07-27, 07-29, 07-30 | the closeout half, which documents, configures, inventories and regresses every 5.1 switch and vendor |

07-31 to 07-34 inherit the edge through these plans.

## Waves

| Wave | Plans | Theme |
|------|-------|-------|
| 1 | 07-01, 07-02, 07-03, 07-04, 07-05 | Package checkpoint, the orchestrator-run exact-pinned install, the pin check, the vector-store boundary rule and digest-pinned compose (autonomous: false); outbox, sync targets, index state, statement triggers and claim RPCs; canonical lower-case tenant key and the Qdrant scoped-request wrapper; the ten D-24 env names and RagConfig.backend; sync, reconcile and trace contracts |
| 2 | 07-06 | **Tracer** (one chunk out to an external store and back, re-validated); rag_validate_chunks and the servable view; sync read RPCs; the VectorStore interface, fake store and external-backend core |
| 3 | 07-07, 07-08, 07-09, 07-10 | Qdrant adapter, store, collection and conformance; Weaviate adapter, store, collection and conformance (two-tenant tests on both); full drain engine with paging, expansion, retries and the `[Vector Sync]` line; activation gate for enabled backends |
| 4 | 07-11, 07-12 | Reconcile with bucketed checksums, index state and outbox pruning; readiness, the backend factory with fallback, timeout and race, span fields and the config hash |
| 5 | 07-13, 07-14 | Drain route (POST and GET), after() kick, CLI and the pg_cron recipe; the cross-tenant canary suite with the planted foreign point |
| 6 | 07-15, 07-16, 07-34 | Index-compat and sync-target admin routes; the backend-canary CI job and real-store drift; voice-scope (with RAG_RETRIEVAL_BACKEND_VOICE) and embed-scope canaries on every backend with filter-ignoring negative controls |
| 7 | 07-17, 07-18, 07-19, 07-28 | Closeout contracts (DefaultsDecision, RegressionPlan, VendorDataFlow, ReviewPromotion, FailureReport); manifest metadata and check-config rules; Test-connection probes and the sidecar probe (no key, URL or host in any response); the semantic-cache canary for chat, embed and voice on every backend |
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
| 7 canary suite and CI service containers | 07-14, 07-16, 07-28, 07-34 |
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
| RET-07 | 07-01, 07-03, 07-06, 07-12, 07-14, 07-28, 07-31, 07-33, 07-34 |
| RET-08 | 07-14, 07-16, 07-28, 07-32, 07-33, 07-34 |
| RET-09 | 07-02, 07-04, 07-05, 07-08, 07-10, 07-11, 07-12, 07-14, 07-15, 07-25, 07-31, 07-33, 07-34 |
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
| D-10 | 07-06, 07-14, 07-28, 07-31, 07-34 | D-23 | 07-17, 07-26 |
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

Deferred ideas (legacy path removal, per-tenant vendor opt-out, native backend fusion, a rule and profile editor in the Config UI, Qdrant JWT tenant claims) appear in no plan. Research Open Question 3's optional `RAG_BACKEND_HEDGE_MS` is not added: A-8 settles the race inside the existing budget without a new switch.

## ROADMAP success criteria

| # | Shown by |
|---|----------|
| 1 | 07-02 and 07-09 (every change type reaches the stores through outbox and drain, cascade included), 07-11 and 07-16 (drift injected on the fake store and on real Weaviate and Qdrant, detected and repaired), 07-07 and 07-08 (Weaviate tenant per workspace; Qdrant shared collection per profile with is_tenant and the tenant filter on every query and prefetch); 07-33 Task 1 live |
| 2 | 07-14, 07-28 and 07-34 (canary cases on pgvector, Weaviate and Qdrant through the chat, voice and embed entry points, including the planted foreign point, the cache and filter-ignoring negative controls dropped by the Supabase re-check), 07-16 (backend-canary job that cannot pass by skipping), 07-32 Task 3 (required check), 07-06 (ids failing re-validation are dropped) |
| 3 | 07-07, 07-08 and 07-16 (Phase 4 conformance unchanged on both, zh exact term included), 07-12 (not ready or failing falls back to pgvector with `degraded`) |
| 4 | 07-04, 07-18 and 07-20 (every provider and switch, masked secrets), 07-19 (Test-connection), 07-15 and 07-20 (index-compatibility warning) |
| 5 | 07-24 and 07-25 (regression on backend, profile and reranker combinations with a fixture decision record), 07-30 (shipped defaults follow the record), 07-27 (AGENTS.md, `.env` template, README_RAG_PIPELINE.md), 07-21 (vendor data-flow inventory); 07-33 Tasks 3 and 4 live |
| 6 | 07-29 (panel: open a case, write the answer and spans, promote), 07-22 (provenance production, frozen split, next eval run includes it), 07-23 (retrieved chunks for review), 07-26 (failure report by layer and category) |

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

## Threat register

T-07-01 to T-07-118 are unique across the phase (no reuse), plus the reserved T-07-SC in every plan. The package gate's T-07-SC is `mitigate` in 07-01 and `accept` (no install) elsewhere.

## Checks run

- `node .claude/gsd-core/bin/gsd-tools.cjs query frontmatter.validate <plan> --schema plan`: valid for all 34 plans.
- `node .claude/gsd-core/bin/gsd-tools.cjs query verify.plan-structure <plan>`: valid, exit 0, no errors for all 34 plans; the only warnings are the `one-way` reversibility notes on 07-02, 07-06, 07-11 and 07-31, whose decisions (D-01, D-10) are settled in CONTEXT and need no checkpoint.
- Dependency script: every `depends_on` id exists as a plan file; every Phase 7 dependency is in an earlier wave; no two plans of one wave share a file; every file touched by two Phase 7 plans is ordered by a dependency path.
- Every `grep -c` acceptance gate was replayed against the current tree and its HEAD baseline matches.
