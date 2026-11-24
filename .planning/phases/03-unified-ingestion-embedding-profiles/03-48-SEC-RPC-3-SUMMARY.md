---
phase: 03-unified-ingestion-embedding-profiles
plan: 03-48-sec-rpc-3
subsystem: database
tags: [supabase, security-definer, search-path, allow-list, pglite]
requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: 0410 SECURITY DEFINER grants and the ACL replay helpers (03-48-sec-rpc-2)
provides:
  - fixed search_path on the 13 multi-tenant SECURITY DEFINER functions that had none (MEDIUM-3)
  - 0411_security_definer_search_path.sql, guarded ALTER FUNCTION for databases created earlier
  - static and PGlite tests that fail on any public SECURITY DEFINER function without a fixed search_path
  - SECURITY DEFINER allow-list keyed by full signature (LOW-3)
status: complete
actuals:
  tokens: 21000
  tasks: 3
  commits: 4
plan_head_before: 99dfde2
plan_head_after: 00c565c2735f7dd49c796f8acd54fbb5c9a85181
key-files:
  created:
    - supabase/migrations/0411_security_definer_search_path.sql
    - tests/helpers/sql-function-search-path.ts
    - tests/rag/security-definer-search-path.test.ts
    - tests/rag-db/definer-search-path-pglite.test.mts
  modified:
    - supabase/multi-tenant-setup.sql
    - tests/helpers/security-definer-allow-list.ts
    - tests/helpers/sql-function-acl.ts
    - tests/rag/search-rpc-grants.test.ts
    - tests/rag-db/search-rpc-grants-pglite.test.mts
decisions:
  - "search_path value is `pg_catalog, public`, the form the single-tenant setup uses on its versions of the same functions and the one the review proposed."
  - "0411 is a new file; 0410 is unchanged."
---

# Phase 03 Plan 03-48-sec-rpc-3: SECURITY DEFINER search_path and signature-keyed allow-list Summary

Every public SECURITY DEFINER function now has a fixed `search_path`, enforced by a static scan and a PGlite catalog check, and the authenticated allow-list matches full signatures instead of names.

## What changed

**MEDIUM-3.** The 13 functions in `supabase/multi-tenant-setup.sql` that the review listed (`get_user_org_ids`, `get_user_role_in_org`, `get_user_current_org`, `can_view_org_member`, `delete_folder`, `get_folder_stats`, `move_chats_to_folder`, `share_chat`, `unshare_chat`, `get_admin_organization_id`, `share_personal_organization`, `check_admin_status`, `is_admin`) got `SET search_path = pg_catalog, public` in their CREATE statements. Bodies, signatures and grants are unchanged; none of them references an object outside `pg_catalog` or `public` unqualified (`auth.uid()` is already qualified). `single-tenant-setup.sql` already had the setting on all of its definers, so it needed no edit.

`supabase/migrations/0411_security_definer_search_path.sql` runs one `ALTER FUNCTION ... SET search_path = pg_catalog, public` per signature, each behind `to_regprocedure(...) IS NOT NULL`, in one transaction. 0411 was free; 0410 is untouched. It is a common (mode-less) migration, so single-tenant databases run it too and the guards skip signatures that do not exist.

**Tests (written first, committed red).**
- `tests/helpers/sql-function-search-path.ts` plus `tests/rag/security-definer-search-path.test.ts`: scans `CREATE FUNCTION` in both setup files, all migrations and all patches (more than 100 definers) and fails on any SECURITY DEFINER without `SET search_path`. It accepts `= a, b`, `= 'a', 'b'` and `TO ''`, ignores a `SET search_path` that appears only inside the function body, and fails if a DO block ever creates a SECURITY DEFINER function (the scanner could not see it). It also pins 0411: each of the 13 signatures is altered inside a guard, and the file contains no CREATE, GRANT or REVOKE.
- `tests/rag-db/definer-search-path-pglite.test.mts`: for both deployment modes, a fresh install (setup plus every migration) must show `search_path=` in `pg_proc.proconfig` for every `public` `prosecdef` function; an upgrade simulation (setup plus migrations except 0411, then `ALTER FUNCTION ... RESET search_path` on the formerly unfixed functions) must be open before 0411, fixed after it, and still fixed after a second run.

**LOW-3.** `AUTHENTICATED_ALLOW_LIST` keys are now normalised signatures such as `delete_folder(uuid,boolean)`. `allowListEntryFor(signature)` normalises (lowercase, no schema, no quotes, no blanks after commas) and looks up the full signature; `signatureKey` is exported from `sql-function-acl.ts`. `search-rpc-grants.test.ts` and `search-rpc-grants-pglite.test.mts` use it with `signatureKey(acl.name, acl.args)` and `regprocedure::text` respectively. New tests: key-format check; every key must match a real SECURITY DEFINER signature; synthetic overloads `delete_folder(uuid)`, `is_org_member(uuid)` and `check_admin_status(uuid)` granted to anon and authenticated are rejected (static replay and a PGlite database in both modes). The "four tenant search RPCs are never on the allow-list" test now compares the name part of each key, since indexing by bare name would have become vacuous.

## Commits

| Hash | Message |
|---|---|
| 41caaa0 | test: fail on SECURITY DEFINER functions without a fixed search_path |
| 3cf6706 | fix: fix search_path on 13 multi-tenant SECURITY DEFINER functions |
| 3e6fadc | test: require signature-keyed allow-list, reject allow-listed-name overloads |
| 00c565c | fix: key the SECURITY DEFINER allow-list by full signature |

## Deviations from Plan

None in scope. Notes:
- The red commit for LOW-3 introduces `allowListEntryFor` with the old name-keyed lookup so the new tests fail on behaviour rather than on a missing import; the next commit rekeys the list.
- In the green MEDIUM-3 commit the 0411 test's ALTER and `to_regprocedure` counts were changed to ignore comment lines (the header comment mentions both); a test bug, not a behaviour change.

## Verification

- `npx vitest run tests/rag/search-rpc-grants.test.ts tests/rag/security-definer-search-path.test.ts`: 39/39.
- `node --import tsx --test tests/rag-db/search-rpc-grants-pglite.test.mts tests/rag-db/definer-search-path-pglite.test.mts`: 12/12.
- `node --import tsx --test --test-name-pattern "safe to re-run" tests/rag-db/schema-equality.test.mts`: 2/2 (single-tenant and multi-tenant folded setup re-run leaves the catalog dump unchanged).
- `node scripts/ci/check-rag-boundary.mjs`: ok, 946 files, no violations.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.

## Known pre-existing failure (not caused by this plan)

The remaining tests in `tests/rag-db/schema-equality.test.mts` (10 of 19, the ones that build the frozen pre-phase3 fixture) fail with `[RAG Relex] rpc_failed:rag_relex_candidates` raised from `eval/harness/pglite-supabase.mts` `runFixtureRelex`. The same failure reproduces on an untouched export of base commit 99dfde2, so it predates these changes. Not investigated further; out of scope.

## Known Stubs

None.

## Threat Flags

None. No new endpoints, grants or trust boundaries.

## Self-Check: PASSED

- 0411 migration, the three new test files and the helper exist; the four commits are ancestors of HEAD; `git status` is clean (no fixture files modified).
