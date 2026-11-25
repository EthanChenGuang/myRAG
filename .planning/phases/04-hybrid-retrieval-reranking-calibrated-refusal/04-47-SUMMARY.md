---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 47
subsystem: database
tags: [gap-closure, security-definer, search-path, setup-fold, frontend-design-gate, config-ui]
requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-42 Phase 4 fold (0401-0413) and 04-VERIFICATION gaps 1 and 2"
  - phase: 03.1-tiered-parsing-incremental-queue-bulk-backfill
    provides: "03.1-52 fold of 0351-0359 (before Phase 4) and 0420-0424 (after Phase 4), merged into this branch"
provides:
  - "Migration 0425 (common, single-tenant, multi-tenant): SET search_path = '' and schema-qualified bodies for every public SECURITY DEFINER function, every trigger function and every function created from 0301 on; folded after the 0420-0424 section"
  - "tests/rag-db/search-path-empty.test.mts: catalog, body and callee checks in both modes, from setup plus unfolded migrations and from the frozen setup plus all migrations"
  - "check-frontend-design-summary.mjs scoped to UI plans, with scripts/tests/check-frontend-design-summary.node-test.mjs"
  - "web-design-guidelines fixes on the 04-02 Config UI switches and the 04-02 Design skills record"
affects: [04-43, 05, 06-45]
tech-stack:
  added: []
  patterns:
    - "Function rewrites are generated from pg_get_functiondef with the session search_path empty, so headers come out schema-qualified; bodies change only by public. qualifiers and OPERATOR(public.<=>), checked by stripping them"
    - "A migration that replaces functions it did not create starts with a DO block that raises when any target is missing, so CREATE OR REPLACE never creates one with default PUBLIC execute"
key-files:
  created:
    - supabase/migrations/0425_search_path_empty.sql
    - supabase/migrations/0425_expected_pre_hashes.json
    - supabase/migrations/0425_search_path_empty.single-tenant.sql
    - supabase/migrations/0425_search_path_empty.multi-tenant.sql
    - tests/rag-db/search-path-empty.test.mts
    - tests/ui/config-phase4-switches.test.ts
    - scripts/tests/check-frontend-design-summary.node-test.mjs
    - .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-47-PLAN.md
    - .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-47-SUMMARY.md
  modified:
    - supabase/single-tenant-setup.sql
    - supabase/multi-tenant-setup.sql
    - tests/rag-db/schema-equality.test.mts
    - tests/rag-db/rechunk.test.mts
    - tests/rag-db/ingestion-schema.test.mts
    - tests/rag-db/reembed.test.mts
    - tests/helpers/sql-function-acl.ts
    - tests/rag/search-rpc-grants.test.ts
    - scripts/config-ui/index.html
    - scripts/ci/check-frontend-design-summary.mjs
    - .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-02-SUMMARY.md
    - .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-42-SUMMARY.md
    - .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-PLAN-INDEX.md
key-decisions:
  - "One migration, 0425 (next free number after 0424 on every exec/* and ci/merge-train-* branch). Before 03.1-52 merged, the Phase 3.1 functions needed a second, unfolded migration; after the merge every target is last defined by a folded migration or the setup file, so 0425 covers all of them and is folded after 0424"
  - "Scope is wider than the brief's minimum: every trigger function, legacy ones included. A trigger runs with the search_path of the statement that fired it, so a trigger without its own path broke under an empty-path writer (update_org_storage failed with relation organizations does not exist inside rag_begin_document_version). The test also requires that no empty-path body calls a public function with no search_path"
  - "No allow-list: every legacy SECURITY DEFINER function could be rewritten"
  - "No GRANT or REVOKE in 0425: CREATE OR REPLACE keeps each ACL, so production grants (including any Supabase default privileges the fixture does not model) stay as they are. The static ACL simulator now models the existence check instead"
  - "The frontend design gate checks a summary only when its PLAN files_modified or SUMMARY key-files name UI surface; a UI-SPEC still marks the phase as UI. The Design skills heading must start a line"
requirements-completed: [RET-04, CHK-04]
duration: 105min
completed: 2026-11-25
status: complete
actuals:
  tokens: 157000
  tasks: 2
  commits: 18
plan_head_before: c7a7ad3375796403185c8bd0617edf33774f9e34
plan_head_after: 9ba5fcf028002ece0c440d9abe65a637d5f4fdc6
---

# Phase 4 Plan 47: search_path '' everywhere and a frontend design gate scoped to UI plans Summary

**Migration 0425 gives 142 functions (126 single-tenant, 135 multi-tenant definitions) `SET search_path = ''` with schema-qualified bodies, including every trigger function. It is folded after 0424 in both setup files. The 04-02 Config UI switches meet web-design-guidelines, and the design gate now checks only UI plans and exits 0 on Phase 4.**

## Performance

- Duration: about 105 minutes
- Tasks: 2 (plus the plan file)
- Files: 28 changed outside the merge (the migration and the two fold sections are about 4,900 lines each way)

## Accomplishments

### Gap 2: search_path '' (security)

- `tests/rag-db/search-path-empty.test.mts` builds four databases: each mode, from the setup file plus the migrations it does not fold (found by its `-- >>>` markers), and from the frozen pre-Phase-3 setup plus every migration. In all four it requires:
  - search_path `""` on every public SECURITY DEFINER function, every trigger function and every function created from 0301 on (the legacy set is the frozen setup's function names);
  - no unqualified public relation, row type, vector or halfvec cast, public-only function call or pgvector operator in any empty-path body, including SQL text built for EXECUTE;
  - no empty-path body calling a public function that has no search_path.
- 0425 rewrites each function from `pg_get_functiondef` with search_path empty. Bodies are tokenised (comments, quotes, nested dollar quotes and dynamic-SQL literals handled) and only `public.` prefixes and `OPERATOR(public.<=>)` are inserted. Stripping them gives back the old body for all 261 definitions. pgvector lives in `public` in both modes (`CREATE EXTENSION vector` without a schema, as 0413 and 0602 assume), so no `extensions.` qualifier is needed.
- Functions fixed, by the migration that last defined them (distinct names; 142 in total):

| Source | Count | Source | Count |
|--------|-------|--------|-------|
| legacy setup only | 19 | 0351 | 3 |
| legacy, search_path set by 0411 | 13 | 0352 | 4 |
| legacy, recreated by 0306 (multi-tenant) | 2 | 0353 | 12 |
| 0305 | 2 | 0354 | 8 |
| 0307 / 0308 / 0309 | 2 / 2 / 2 | 0355 | 7 |
| 0310 / 0311 / 0312 | 4 / 1 / 4 | 0356 | 8 |
| 0313 / 0314 | 3 / 2 | 0359 | 1 |
| 0315 | 14 | 0423 | 2 |
| 0316 / 0317 / 0318 / 0319 | 5 / 3 / 1 / 1 | 0401 / 0402 / 0403 / 0404 / 0406 | 3 / 2 / 1 / 1 / 1 |
| | | 0412 | 9 |

- Phase 4 total: 17 final definitions. The verifier's other Phase 4 functions (hybrid_search_chunks, rag_write_profile_chunks, rag_fetch_parents and the 0413 set) were already `''` in their final definitions: 0413, then 0602 for hybrid_search_chunks. 0425 does not touch hybrid_search_chunks, so 0602's include-undated rule and the 0413 image/invoice_header rule stay as they are.
- Allow-list entries: none.
- Files: `0425_search_path_empty.sql` (111 functions identical in both modes), `.single-tenant.sql` (15), `.multi-tenant.sql` (24). Each file starts with a DO block that raises `55000` when pgvector is not in schema `public` or when any of its targets is missing. The block proves only that the targets exist; it does not compare their bodies.

### Gap 1: frontend design gate

- web-design-guidelines on the 04-02 hunks found 11 unassociated labels, no `name` on 17 controls, missing autocomplete/spellcheck/inputmode, a text-typed URL field, placeholders without an ellipsis, an unnamed key reveal button without `type`, help text not tied to its control, code tokens without `translate="no"` and an unbalanced heading. All are fixed under `tests/ui/config-phase4-switches.test.ts` (RED ec48e52a, GREEN 1c5832b6, 9ba5fcf0). 04-02-SUMMARY now has the Design skills table.
- 04-42-SUMMARY line 122 no longer quotes the heading.
- The script decides per summary from PLAN `files_modified` and SUMMARY `key-files`. UI surface means `scripts/config-ui/`, `src/components/`, `src/app/**/page|layout.*` and `*.css`; `src/app/api/**` is not UI, and neither is a path mentioned in prose. The 40-odd non-UI summaries are untouched.

## Design skills

This plan changed `scripts/config-ui/index.html`, so it is a UI plan.

| Skill | Outcome | What it found and changed |
|-------|---------|---------------------------|
| frontend-design | n/a: controls inside existing panels, no new interface | The changes add only attributes and wrappers to the 04-02 controls in the existing Retrieval pipeline card. No page, layout or visual direction was added. |
| Impeccable | n/a: controls inside existing panels, no new interface | Same scope: attributes on existing form controls. |
| web-design-guidelines (pinned `references/command.md`, the 3236cc7e hunks) | all findings resolved | The findings and fixes are the ones listed in the 04-02 Design skills table. Kept by decision: sentence-case labels (04-UI-SPEC section 12); placeholders that show the default value keep no ellipsis; selects take their colours from the DaisyUI theme. |

## Task Commits

1. Task 1, Gap A: RED b07bd1ee and 8702d95a, GREEN e2319f2a
2. Task 2, Gap B: UI RED ec48e52a, UI GREEN 1c5832b6 and 9ba5fcf0; script RED 3424279a, GREEN 7237c6c3; records 2340200f
3. Plan: b5fb95a2. Merge of origin/exec/03.1-52: b70fc1b8, at the coordinator's request.

## TDD Gate Compliance

| Gate | Commit | Fails on assertions before the fix |
|------|--------|------------------------------------|
| RED search_path | b07bd1ee | 8 of 10 (proconfig not `""`; empty-path inventory 27, expected over 100) |
| RED triggers and callees | 8702d95a | trigger and legacy-trigger scope |
| RED UI switches | ec48e52a | 6 of 6 (`name` undefined, no autocomplete, placeholder, button type, describedby, heading) |
| RED gate scope | 3424279a | 4 of 8 (non-UI and api-only plans, inline heading quote, prose mention) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Legacy trigger functions without a search_path broke under empty-path writers**
- **Found during:** Task 1 (full rag-db run)
- **Issue:** `update_org_storage` (multi-tenant, no search_path) inherits `''` from rag_begin_document_version, so `organizations` did not resolve, and dozens of multi-tenant ingest tests failed.
- **Fix:** every trigger function is now in scope, plus a test rule against empty-path bodies calling unpinned functions. A test-only trigger in reembed.test.mts got `SET search_path = ''`, for the same reason.
- **Commit:** 8702d95a, e2319f2a

**2. [Rule 3 - Blocking] The static ACL simulator read 0425 as creating legacy definers with PUBLIC execute (migrations-only scenario)**
- **Fix:** a function that a DO block first requires via `to_regprocedure` and `RAISE EXCEPTION` is a replacement whose ACL the files do not show. It gets a unit test in search-rpc-grants.test.ts. No grant statement was added, because adding them could change production ACLs.
- **Commit:** e2319f2a

**3. [Rule 3] Tests that pinned the old state**
- rechunk.test.mts expected `search_path=pg_catalog, public`. ingestion-schema "applying 0351 twice" now re-runs 0425 after 0351, as migration order does. The 03.1-52 fold checks in schema-equality now expect the 0425 section after 0420-0424.
- **Commit:** e2319f2a

**4. [Rule 3] check-config read the help-text ids `RAG_PIPELINE_help` as env names.** They were renamed to kebab-case ids. Commit 9ba5fcf0.

**5. Plan shape:** after 03.1-52 merged, the planned split into 0425 and an unfolded 0426 for Phase 3.1 was no longer needed, and 0426 was not created.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 254 files, 4070 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166/166 |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1075 passed, 4 failed: all in ingest-mode-routing, `ModuleNotFoundError: No module named 'docling_core'` (rag-sidecar venv lacks the chunking extra; environment, not SQL; no package installed). schema-equality, definer-search-path, search-rpc-grants, hybrid-*, two-tenant matrices, selective-filter, chunking-activation, ingest-writer, profile-chunk-writer, backfill-*, ingestion-*, rechunk and reembed all pass |
| search-path-empty (new) | 14/14 across 4 builds |
| `tests/rag/security-definer-search-path.test.ts`, `tests/rag/search-rpc-grants.test.ts` | 40/40 |
| `node scripts/ci/check-rag-boundary.mjs` + node tests | ok; scripts/tests 75/75 |
| `node scripts/check-config.mjs` | ok (125 variables) |
| `python3 scripts/ci/check-workflows.py` | OK |
| `npm run test-rag -- --out eval/out/04-47` | gate PASS, all paired differences zero |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/04-47-ingest` | gate PASS, all paired differences zero |
| `node scripts/ci/check-frontend-design-summary.mjs <phase 4 dir>` | PASS, exit 0 (3 UI plan summaries: 04-02, 04-36, 04-47) |

Python, contracts and golden data were not touched, so pytest and gen:schemas were not run. Nothing under `eval/fixtures/parse/` was touched.

## Deferred Issues

- Phases 01, 02 and 03.1 still fail the narrowed design gate on real UI plans (01-11, 02-33, 03.1-03 and others) that predate the gate. They are out of scope here.
- The ingest-mode-routing suite needs `docling_core` in the rag-sidecar venv (pre-existing environment gap, same family as the `pypdfium2` note in 04-42).

## Operator Actions

- Check pgvector's schema first: `SELECT extname, extnamespace::regnamespace FROM pg_extension WHERE extname = 'vector'` must show `public`. Each 0425 file stops with `55000` otherwise. Do not act on Supabase lint 0014 (`extension_in_public`) for `vector`.
- Run the read-only dry run in the header of `supabase/migrations/0425_search_path_empty.sql`. Paste in the contents of `supabase/migrations/0425_expected_pre_hashes.json` and the deployment mode. Each row it returns is a function whose live body differs from the one expected before 0425. Resolve every row before applying.
- Apply `0425_search_path_empty.sql`, then the file for the deployment mode, after 0424. The precheck proves only that the replaced functions exist: it stops with `55000` if one is missing, and it compares neither bodies nor grants. 0425 overwrites every live body with the repository's version. A body hot-fixed by hand, or one left behind by a skipped body-only migration, is replaced without notice. A skipped ACL-only migration (0409 to 0411) stays skipped. The common file and the mode file are separate transactions; if the mode file stops, re-run both.
- Re-run 0425 (the common file, then the mode file) after re-running any earlier migration. Re-running a migration below 0425 puts back that migration's search_path and body.
- A fresh install from either setup file already includes 0425.

## Self-Check: PASSED
