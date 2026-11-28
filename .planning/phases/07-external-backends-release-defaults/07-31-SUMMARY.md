---
phase: 07-external-backends-release-defaults
plan: 31
subsystem: database
tags: [setup-fold, schema-equality, off-parity, d-01, d-10, d-24]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "0701-0707 (07-02, 07-06, 07-10, 07-11), canary factory and seed (07-14, 07-28), revision-4 plans 07-35..07-49, 07-51, 07-52, 07-53"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-45, last editor of both setup files and the schema-equality test before Phase 7"
  - phase: 05-verified-citations-groundedness
    provides: "05-25"
provides:
  - "Both setup files end with a Phase 7 section holding 0701-0707 verbatim (common files, identical in both modes), after the Phase 6.1 section"
  - "FOLDED_MIGRATION gains 070[1-7] only; 0708 onward (0740-0745 included) stay on the unfolded path"
  - "tests/rag-db/phase7-off-parity.test.mts: every Phase 7 switch off equals Phase 6 behaviour, both modes"
affects: [07-32, 07-33]

actuals:
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns: ["fold section appended verbatim under a `-- >>> path` line per file, as earlier folds"]

key-files:
  created:
    - tests/rag-db/phase7-off-parity.test.mts
  modified:
    - supabase/single-tenant-setup.sql
    - supabase/multi-tenant-setup.sql
    - tests/rag-db/schema-equality.test.mts

key-decisions:
  - "The Phase 7 section closes both setup files (after Phase 6.1); the order test and setupWithoutPhase31 were extended for it"
  - "No vendor client is proven absent by leaving QDRANT_URL and WEAVIATE_URL unset for the whole parity file: building either client throws, so any attempt would surface as a degraded or failed search, which every case rules out. Node's test runner has no module spy without an experimental flag"
  - "The pre-revision-4 Qdrant request is pinned as a literal computed with scoped-request.ts at 4af7babd~1 (before 07-39); the current module produces the same bytes with access groups off"
  - "The parity file injects the purge deps (db and lineage reader on the mode's own fixture), because the default reader uses the process-wide admin client that keeps the first mode's edge; this is a harness detail, not a behaviour change"

requirements-completed: [RET-05, RET-07, RET-09, ADM-01, LANG-10, LANG-11, SEC-11]

duration: ~1h45m
completed: 2026-11-28
---

# Phase 7 Plan 31: Phase 7 fold and off-state parity Summary

**Migrations 0701-0707 are folded into both setup files, so a fresh install from either setup file alone has the outbox, targets, index state, triggers and every Phase 7 function. The result is identical to the migrated schema in both modes and is unchanged when re-run. A new parity test shows that with every Phase 7 switch at its default, nothing Phase 7 runs.**

## Performance

- Tasks: 2, files: 4 (1 created, 3 modified)

## Accomplishments

- Both setup files have a Phase 7 section with 0701-0707 verbatim. There are no mode variants, so the two sections are identical. 0708, 0709, 0720-0728 and 0740-0745 remain migrations and are applied on top through the unfolded path.
- schema-equality covers 0701-0707 in both modes:
  - the folded setup equals frozen setup plus all migrations;
  - re-applying the migrations changes nothing;
  - re-running the setup file is safe;
  - `rag_vector_sync_claim` grants are equal.
- New `assertPhase7Secured` checks the setup file on its own:
  - all three tables have RLS on, no policy, no anon or authenticated privilege, and service_role read/write;
  - `rag_servable_chunks` is `security_invoker` and not readable by clients;
  - both target rows exist with `enabled = false`, and all ten statement triggers are present;
  - all 30 functions are closed to anon and authenticated, and every callable one is granted to service_role.
- The off-parity test, in both modes:
  - the full lifecycle (ingest, new version, quarantine and release, soft delete, lineage purge, re-embed and activation) writes no row to `vector_sync_outbox`, `rag_backend_index_state`, `vector_sync_purges`, `vector_sync_purge_targets`, `rag_rollouts` or `rag_rollout_tenants`;
  - chat, embed and voice under v2 and legacy are never degraded and call no `rag_backend_readiness`, `rag_rollout_*` or `rag_vector_sync_*` RPC; v2 searches pgvector;
  - `readEnabledTargets` returns no target;
  - enabling and then disabling qdrant, and selecting qdrant and then pgvector, restore the default results and config hash.
- The off-parity test also checks the pure defaults:
  - the pinned pre-Phase-7 hash `cd5802e6...`;
  - `RAG_LANG_CONFIDENCE` is `mapped` and gives 1, 0.5 and null;
  - the Qdrant request with access groups off is byte-identical to the pre-revision-4 one;
  - the drain route answers 503 on POST and GET without a secret;
  - `kickVectorSync` reads nothing outside a request.

## Task Commits

1. Task 1, fold: RED `35ad8d0f` (schema-equality expects the fold; it failed on assertions: "every Phase 7 table is defined by the setup file" and the section-order check), GREEN `a55673be` (setup files).
2. Task 2, off parity: `596ddb13`. This is a characterization test: it passed with no product change, as the plan expects. Guard mutation: setting `rag_vector_sync_targets.qdrant` to `enabled = true` before the lifecycle makes the "no outbox row" case fail in both modes (2 failed). It was run as a temporary copy that was then deleted.

## Behaviour changes

None for existing installs. Fresh installs from a setup file get the Phase 7 schema without running 0701-0707. Those migrations stay the upgrade path.

## Gates run

- `node --import tsx --test tests/rag-db/schema-equality.test.mts` (both modes, includes the per-mode "setup applies cleanly", "equals the migrated schema", "unchanged by re-applying migrations" and "safe to re-run" cases): 45 passed, 0 failed.
- `node --import tsx --test tests/rag-db/phase7-off-parity.test.mts`: 12 passed, 0 failed. The `--test-name-pattern="no outbox row"` run: 2 passed.
- Related rag-db and tsx files, foreground, both modes, 32 files: fixture-edge, security-gaps-rls, answer-checks-schema, calc-review-reasons, fixture-phase42-corpus, ingestion-ledger-pg, phase32-migrations-apply, phase53-migrations, search-path-empty, security-events, definer-search-path-pglite, hybrid-grants, lexical-stats-grants, purge-grants, search-rpc-grants-pglite, and every `*vector-sync*`, `*reconcile*` and `*activation*` file. Everything passed except one pre-existing failure (see below).
- `npx vitest run` on the vitest files that read the setup files, plus search-backend: backfill-inventory, refusal/floor, search-rpc-grants, security-definer-search-path, v2/search-backend. 5 files, 153 passed.
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `check-rag-boundary`, `check-config`, `check-language-literals`, `check-settings-classification`, `check-zod-isolation`, `check-release-defaults`, `gen-pipeline-doc --check`, `gen-vendor-doc --check`, `calibrate-language-confidence --check`, `rag_eval.red_team check`: all ok.
- `npm run test-rag -- --out eval/out/p7-final`: gate PASS, `passed` and `paired.all_zero` both true.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/p7-final-ingest`: gate PASS, `passed` and `paired.all_zero` both true.
- `npm run test-rag -- --run-config eval/config/runs/v2-all-off.json`: gate PASS.
- Not run:
  - The full `npx vitest run`, full `tests/rag-db`, both pytest suites, `gen:schemas` and `typecheck:new`. The speed rules apply: no shared src, contract or Python code changed, and the merge train runs the full suite.
  - `rag_eval.regression annotate ... --check`. It exits with "no run outputs for this plan in eval/out/regression/regression-plan-fixtures-b; annotate needs the stage-B runs". Producing those outputs means `regression run`, which writes the test-split ledger, and that stays at 26/25.
- eslint on both test files: 0 problems.

## Pre-existing failure

`tests/fixture-edge.test.mts` "an argument the function does not have returns 400 and is recorded" fails with `404 !== 400`. It fails identically on the base commit e817fa75 (checked in a separate worktree), so it is unrelated to this plan.

## Deviations

- The parity test lives in `tests/rag-db/` as a node:test file, as the plan names it, and reuses the vitest-free canary factory (`createCanaryEnv('pgvector', mode)`). Vendor-client absence is proven by unset URLs, not by spies (see key decisions).
- The voice v2 request returns no candidates for the canary sentence. The test only checks that it is not degraded or an error and makes no Phase 7 RPC.

## Deferred

- AGENTS.md §6 "Unified ingestion" and the README still say the Phase 6.1 section closes the setup files and that the 07xx block is not folded. That wording should now say 0701-0707 are folded and 0708 onward are not. This is a doc-only follow-up, left for an explicit doc request.
- The `fixture-edge` 404 vs 400 pre-existing failure above.

## Operator actions

None. Nothing touched production.

## Self-Check: PASSED

- The setup files contain `vector_sync_outbox`: 34 matches in each.
- The multi-tenant setup contains `rag_validate_chunks`: 8 matches.
- The schema-equality test contains `rag_vector_sync_claim`.
- Commits 35ad8d0f, a55673be and 596ddb13 are on `exec/07-31`.
