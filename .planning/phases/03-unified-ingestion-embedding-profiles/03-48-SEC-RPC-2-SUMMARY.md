---
phase: 03-unified-ingestion-embedding-profiles
plan: 03-48-sec-rpc-2
subsystem: database
tags: [supabase, rls, security-definer, grants, pglite]
requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: 0409 four-search-RPC revoke (03-48-sec-rpc)
provides:
  - 0410_security_definer_rpc_grants.sql, a guarded REVOKE/GRANT over all 109 SECURITY DEFINER signatures
  - folded REVOKE/GRANT in multi-tenant-setup.sql and single-tenant-setup.sql
  - static ACL replay test and PGlite full-inventory test
status: complete
actuals:
  tokens: 36000
  tasks: 2
  commits: 2
plan_head_before: feb9555ec71be06e766dd8d92c2eac86fc9fc2fe
plan_head_after: 0a6db8a7c7c409277b69a85c01b9234017909e13
key-files:
  created:
    - supabase/migrations/0410_security_definer_rpc_grants.sql
    - tests/helpers/sql-function-acl.ts
    - tests/helpers/security-definer-allow-list.ts
  modified:
    - supabase/migrations/0409_search_rpc_revoke.sql
    - supabase/multi-tenant-setup.sql
    - supabase/single-tenant-setup.sql
    - tests/rag/search-rpc-grants.test.ts
    - tests/rag-db/search-rpc-grants-pglite.test.mts
    - eval/harness/pglite-supabase.mts
key-decisions:
  - "Rule: every public SECURITY DEFINER function is service_role only unless it is on tests/helpers/security-definer-allow-list.ts (each entry carries a reason). A new definer function without a REVOKE fails the vitest replay."
  - "Only is_org_member, is_org_owner, is_org_admin and check_admin_status keep anon: policies without a TO clause evaluate them for anon, so revoking would turn empty results into permission errors."
  - "Allow-listed functions revoke from PUBLIC (and anon where not kept) but never from authenticated, so re-running the setup file leaves the ACL order unchanged (schema-equality re-apply test)."
---

# Phase 3 Plan 03-48-sec-rpc-2: Full SECURITY DEFINER EXECUTE inventory Summary

**One-liner:** Every public SECURITY DEFINER function is now service_role only unless allow-listed, enforced by migration 0410, the folded setup files, a static replay of setup plus migrations, and a PGlite catalog test that simulates hosted Supabase default function grants.

## Tasks

| Task | Commit | Files |
|------|--------|-------|
| 1. RED: inventory tests (static ACL replay, PGlite full inventory) | `17f5b29` | `tests/rag/search-rpc-grants.test.ts`, `tests/rag-db/search-rpc-grants-pglite.test.mts`, `tests/helpers/*`, `eval/harness/pglite-supabase.mts` |
| 2. GREEN: 0410, setup fold, 0409 guard | `0a6db8a` | `supabase/migrations/0409*`, `0410*`, both setup files |

## Locked inventory

- **Service_role only (96 signatures):** the four search RPCs, `match_chunks_by_profile`, `get_workspace_context`, `get_user_org_ids`, `get_admin_organization_id`, `get_documents_by_type_slug*`, every `rag_*` writer, queue, budget, parse-cache, re-embed, quarantine and profile function, trigger functions, plus the folder and sharing functions nothing calls (`share_chat`, `unshare_chat`, `get_folder_stats`) and the unused org helpers (`get_user_role_in_org`, `get_user_current_org`, `can_view_org_member`).
- **authenticated + service_role (no anon):** `delete_folder`, `move_chats_to_folder`, `share_personal_organization`, `create_organization_safe`, `is_admin`, `is_subscribed`, `get_nango_stats`, `kb_writes_locked`, `rag_ingest_realtime_topic_allowed`.
- **authenticated + anon + service_role (RLS helpers evaluated for anon):** `is_org_member`, `is_org_owner`, `is_org_admin`, `check_admin_status`.
- Nothing is executable by PUBLIC. The live catalog of 23 could not be read (no live access); the migration covers every definer signature the repository defines, and the PGlite upgrade test starts from an all-open state.

## Deviations from Plan

**1. [Rule 1 - Bug] 0409 aborted the single-tenant migration chain**
- **Found during:** Task 2 (replaying single-tenant migrations)
- **Issue:** 0409 is a common migration but REVOKEs `match_documents_by_workspace` and `match_document_chunks_by_org`, which exist only in multi-tenant. Every single-tenant migration run failed at 0409, taking down tests/security-gaps-rls and the schema tests on trunk.
- **Fix:** each statement guarded with `to_regprocedure`; same effect on multi-tenant.
- **Commit:** `0a6db8a`

**2. [Plan wording] The tenant-id heuristic inventory test was replaced, not extended.** It counted duplicate definitions and could not express the full inventory; the replay test is a strict superset (four-RPC tests, the no-grant-to-anon test and the patch cross-check are kept). Test count is 18, not 11.

**3. Harness:** `createEmptyFixtureDatabase` gained an opt-in `supabaseFunctionDefaults` (default off, no effect on other tests). Without it PGlite never gives anon EXECUTE, so no test could see the hole.

**4. Worktree note:** `tests/helpers/sql-function-acl.ts`, `tests/helpers/security-definer-allow-list.ts` and the first rewrite of `tests/rag/search-rpc-grants.test.ts` appeared in the worktree mid-run (13:03 to 13:04 UTC) from a writer other than this executor. They were reviewed, matched the plan, and were committed in `17f5b29`.

## Tests

| Command | Result |
|---------|--------|
| `npx vitest run tests/rag/search-rpc-grants.test.ts` | 18/18 pass (4 failed before 0410 and the setup fold) |
| `node --import tsx --test tests/rag-db/search-rpc-grants-pglite.test.mts` | 6/6 pass (2 failed before) |
| `node scripts/ci/check-rag-boundary.mjs` | ok |
| `npx tsc --noEmit -p tsconfig.json` | 0 errors |
| schema-migrations, schema-equality, security-gaps-rls and 12 other setup-touching rag-db files | identical failure set to trunk with only the 0409 guard applied; no new failures |

## Deferred Issues (pre-existing, not caused by this plan)

- `rag_relex_candidates` fails through the fixture RPC client (`RelexInputError rpc_failed`), failing about 22 tests in schema-equality and schema-migrations. Trunk shows the same.
- tests/security-gaps-rls.test.mts test 4 (both single-tenant variants): `permission denied for function rag_lexical_tsvector`; 0401 revokes the generated-column function from authenticated.
- `rag_ingest_realtime_topic_allowed` is executable by authenticated by design (0353), which the schema-migrations check "trigger functions are not callable by anon or authenticated" flags.
- Multi-tenant `share_chat`, `unshare_chat`, `delete_folder` and friends lack `SET search_path`; not touched here.

## Operator

- Apply `0409` then `0410` on live after promote. Both issue `NOTIFY pgrst, 'reload schema'`. Afterwards list anything still open (read-only):
  `SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND (has_function_privilege('anon',p.oid,'EXECUTE'))`
  Expected: only `is_org_member`, `is_org_owner`, `is_org_admin`, `check_admin_status`. Any other name is a live-only function the repository does not define.
- `revoke authenticated` on `share_chat`, `unshare_chat`, `get_folder_stats`, `get_user_role_in_org`, `get_user_current_org`, `can_view_org_member` assumes no caller; none exists in `src/`, `scripts/` or the voice and WhatsApp services.

## Self-Check: PASSED

- 0410 migration, both helpers and this file exist; commits `17f5b29`, `0a6db8a` are on `exec/03-48-sec-rpc-2`.
