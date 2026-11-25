---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 42
subsystem: database
tags: [setup-fold, schema-equality, service-role, phase-close, agents-guide]
requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "03-47 fold pattern (verbatim migrations behind `-- >>>` markers) and the schema-equality test"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "migrations 0401-0413 (04-01..04-41, 03-48 follow-ups), phase comparison report (04-40/04-46)"
provides:
  - "Both setup files carry the final Phase 4 schema (0401-0413); setup alone plus the not-yet-folded migrations equals the frozen pre-Phase-3 setup plus every migration, per mode"
  - "Per-mode schema-equality cases with Phase 4 service-role-only and tenant-key-guard assertions"
  - "AGENTS.md Phase 4 subsection (switches, service-role RPCs, tools, eval-only fixture thresholds, chunking-profile gap rule) and the D-30 strict-mode line in section 14"
affects: [04-43, 03.1-52, 06-45]
tech-stack:
  added: []
  patterns:
    - "Fold = migration text verbatim behind `-- >>> supabase/migrations/<file>`; a migration that is redundant on a fresh install is folded as a note plus only the statements it still adds"
    - "schema-equality compares setup alone + unfolded migrations (FOLDED_MIGRATION regex) with frozen setup + all migrations"
key-files:
  created:
    - .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-42-SUMMARY.md
  modified:
    - supabase/single-tenant-setup.sql
    - supabase/multi-tenant-setup.sql
    - tests/rag-db/schema-equality.test.mts
    - tests/rag-db/fixture-relex.test.mts
    - AGENTS.md
key-decisions:
  - "Folded 0401-0413, not only 0401-0409: 0410-0413 are Phase 4 migrations added after the plan was written, and the equality claim needs them"
  - "Phase 3.1 (0351-0358, 0420-0423), 0424 and Phase 6 (0601/0602) stay unfolded; they belong to 03.1-52 and 06-45. The equality test applies them on top of the setup file, so it stays valid when those branches merge"
  - "0409 is folded as a note only (tenant search RPC grants already sit next to each function; multi-tenant only). 0410 is folded as a note plus the one thing a fresh install still lacks: the service_role grant on rag_chunk_embeddings_guard, rag_chunks_legacy_defaults and rag_reembed_pick. A verbatim 0409/0410 would duplicate GRANTs and break the static one-GRANT check in tests/rag/search-rpc-grants.test.ts"
  - "Trigger functions revoked from every role (rag_chunks_profile_status, rag_parent_currency_from_document) are exempt only from the service_role-can-execute check; anon/authenticated must still have no EXECUTE"
requirements-completed: [RET-01, RET-02, RET-03, RET-04, RET-10, DATA-08, RNK-01, RNK-02, RNK-03, RNK-04, RNK-05, RNK-06, CHK-03, CHK-04, CHK-05, LAT-01, LAT-02]
duration: 29min
completed: 2026-11-25
status: complete
actuals:
  tokens: 59000
  tasks: 3
  commits: 4
plan_head_before: 20b95fc1e26a80dd8f2b2d7e31ab1fa235d0c74f
plan_head_after: f5a580066d7bd25973b9e6c169275a675815f534
---

# Phase 4 Plan 42: Fold Phase 4 into the setup files and close the phase gates Summary

**Both setup files now include the Phase 4 schema (migrations 0401–0413) and match the migrated catalog in both modes. Every Phase 4 function is callable by service_role only, and every gate passes with the defaults, with zero paired differences in both smoke tiers.**

## Per-mode schema equality (read by 04-43)

| Run | pass | fail |
|---|---|---|
| `--test-name-pattern="single-tenant setup"` (eval/out/p4-42-single.tap) | 4 | 0 |
| `--test-name-pattern="multi-tenant setup"` (eval/out/p4-42-multi.tap) | 4 | 0 |
| `tests/rag-db/schema-equality.test.mts` (whole file) | 21 | 0 |

Each mode runs these cases:
- `applies cleanly on fresh PGlite`: the setup file alone, with no migrations. Every Phase 4 function exists, anon and authenticated cannot execute any of them, and service_role can execute every callable one. The Phase 4 tables exist. `rag_assert_tenant_key` accepts the mode's own keys, rejects the other mode's keys (`s:default` in multi-tenant, `u:`/`o:` in single-tenant) and rejects malformed keys.
- `equals the migrated schema`: no catalog differences, and the legacy `match_*` grants are unchanged.
- `is unchanged by re-applying migrations`.
- `folded setup is safe to re-run`.

## Gate run (defaults, all Phase 4 switches off)

| Command | Result |
|---|---|
| `npm run test-rag -- --out eval/out/p4-final` + `jq '.passed and .paired.all_zero'` | PASS, all_zero true (7 cross-lingual refusal slices skipped, as before) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/p4-final-ingest` + jq | PASS, all_zero true |
| `npx vitest run` | 249 files, 3971 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 996 pass, 0 fail, 4 skipped. The first run had 4 failures in fixture-relex, fixed below |
| `(cd eval && uv run --all-extras --frozen pytest -q)` | 635 passed with `test_generation_is_deterministic` deselected (pre-existing, see Deferred) |
| `(cd rag-sidecar && uv run --frozen --extra chunking pytest -q)` | 840 passed. 7 failed and 14 errored, all `ModuleNotFoundError: pypdfium2` (pre-existing environment problem, no Python touched) |
| `npm run gen:schemas` + `git diff --exit-code` on the contracts | no drift |
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | pass |
| `node scripts/ci/check-rag-boundary.mjs` + node test | pass |
| `node scripts/check-config.mjs` | pass |
| `python3 scripts/ci/check-workflows.py` (and the uv variant) | pass |
| `jq -e '.passed == true' eval/reports/phase-04/comparison.json` | true |

## Accomplishments
- Added a Phase 4 section to each setup file after 0320: the common migration files and that mode's own files (0403 tenant-key guard, 0405 document_parents RLS), copied verbatim behind `-- >>>` markers, as 03-47 did.
- The schema-equality test now compares the setup file alone (plus only the migrations not folded yet) with the migrated schema. Before this plan it compared setup plus all migrations, so it could not detect a missing fold. The RED commit showed the gap in both modes.
- Added a Phase 4 subsection to AGENTS.md §6, updated the folded-range line and added the D-30 line to §14.

## Task Commits
1. **Task 1 RED:** `c3a88d87` test(04-42): require the setup files alone to carry the Phase 4 schema
2. **Task 1 GREEN:** `4fd247cc` feat(04-42): fold the Phase 4 migrations 0401-0413 into both setup files
3. **Task 3:** `bff2045d` docs(04-42): describe Phase 4 switches, service-role RPCs and tools in AGENTS.md
4. **Task 2 fix:** `f5a58006` test(04-42): fixture-relex expects the relex RPCs in the folded setup

## Deviations from Plan

**1. [Rule 3 - Scope] Folded 0410–0413 as well as 0401–0409**
- 0410–0413 were added after the plan was written: the 03-48 follow-ups and plans 04-33 and later. Without them the setup file does not equal the migrated schema. No new migration number was used.

**2. [Rule 1 - Bug] 0409/0410 folded as notes instead of verbatim**
- Copying them verbatim duplicated the REVOKE/GRANT statements for the four tenant search RPCs and broke `tests/rag/search-rpc-grants.test.ts`.
- 0409 adds nothing to a fresh install. Of 0410, only the service_role grant on three Phase 3 functions was missing; that grant is folded explicitly. Schema equality confirms the result.

**3. [Rule 1 - Bug] tests/rag-db/fixture-relex.test.mts (owned by fix-relex-rpc) assumed the folded setup has no 0402**
- Now the `migrations:false` folded case asserts the RPC is present, and the frozen case asserts it is absent.
- The missing-RPC SQLSTATE case now runs on the frozen pre-Phase-3 setup.
- This is an intended consequence of the fold, not a weakened check: the case still proves 42883 is surfaced.

**4. [Scope] The equality test applies the unfolded migrations on top of the setup file.** Phase 3.1 is not folded yet (03.1-52 is open), so "setup alone" in the plan means setup plus the migrations outside `FOLDED_MIGRATION`.

**5. Brief rules followed.** STATE.md, ROADMAP.md and REQUIREMENTS.md were not touched. Decisions are listed in the hand-off report.

## TDD Gate Compliance
- RED `c3a88d87`: assertion failures in both modes (missing Phase 4 functions and catalog differences), not module errors.
- GREEN `4fd247cc`.
- No refactor commit.

## Deferred Issues
- `eval/tests/test_parse_fixtures.py::test_generation_is_deterministic` regenerates `eval/fixtures/parse/pdf/*.pdf` and `manifest.json` in place. In this environment the bytes differ, so the three later `recorded` tests fail. The files were restored with `git checkout -- <file>` and nothing under `eval/fixtures/parse/` was committed. The test should write to `tmp_path`. This is pre-existing and was not fixed.
- The rag-sidecar `chunking` extra lacks `pypdfium2` (preflight extra), so 21 sidecar tests fail at import. This is pre-existing; no package was installed.
- `0424_write_chunks_null_vector.sql` (exec/fix-write-chunks-null) and Phase 6 `0602` are not on this base. The equality design applies them as unfolded migrations, so they need no change here. Whoever folds 042x or Phase 6 extends `FOLDED_MIGRATION`.
- `node scripts/ci/check-frontend-design-summary.mjs` was not required (no UI surface) and was not run; the known gap of about 40 summaries without a design-skills table is unchanged (plan 04-47 narrows the gate to UI plans).
- XLG-03 and the strict refusal improvement stay open for 04-43, as recorded by 04-46. XLG-03 is not in `requirements-completed`.

## Self-Check: PASSED
- Files exist: both setup files, the schema-equality test, AGENTS.md and this SUMMARY.
- Commits c3a88d87, 4fd247cc, bff2045d and f5a58006 are ancestors of HEAD.
