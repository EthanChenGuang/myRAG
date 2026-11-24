---
phase: 03-unified-ingestion-embedding-profiles
plan: 07
subsystem: tenant-scope
tags: [tenant-scope, ingest, admin-guard, membership, nango, fail-closed]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: mintScope and scopeKey (tenant/scope.ts), isOrganizationMember (tenant/membership.ts), the TenantResolveFailure result shape (tenant/resolve-chat.ts), requireRagAdmin and isAdminUser (tenant/admin.ts, admin security fix)
provides:
  - resolveAdminWorkspaceScope (Config UI upload scope: s:default, membership-checked o:<id>, or personal u:<admin>)
  - nangoOwnerScope (Nango sync scope from the owner id of the server-side connection row)
  - IngestScopeResult, ResolveAdminWorkspaceScopeInput and NangoOwnerScopeInput types, all exported from @/lib/rag
  - two regression locks on the delivered requireRagAdmin (signal identity, already-aborted signal)
affects: [03-23, 03-24, 03-31, 03-32, 03-33, 03-37, 03-39, 03-40]

requirements-completed: [DATA-01, DATA-10, SEC-01]

actuals:
  tokens: 3400
  tasks: 2
  commits: 3
plan_head_before: ccfcd7e0e02d332cc60a779fc7a84197888bf557
plan_head_after: 196506ff63c9c7372eddb1e4fb4475ad7d97c2b2

tech-stack:
  added: []
  patterns:
    - "Resolvers mint the scope only after a server-side check and lowercase every id once at the boundary, as the delivered 02-10 resolvers do; tenant/scope.ts is not modified"
    - "Refusal logs are `[RAG Tenant] <label> refused` with a reason only: no ids, no tokens"
    - "Result shape is { ok: true, scope } | { ok: false, status, reason }, reusing TenantResolveFailure"

key-files:
  created:
    - src/lib/rag/tenant/ingest-scope.ts
    - tests/rag/ingest-scope.test.ts
  modified:
    - src/lib/rag/index.ts
    - tests/rag/rag-admin-guard.test.ts

key-decisions:
  - "The admin guard is verified, not rewritten: src/lib/rag/tenant/admin.ts already met every must_have, so it is unchanged and only the two missing regression cases were added"
  - "resolveAdminWorkspaceScope never returns a null scope: an admin always has an id, so no organization gives u:<admin> (unlike chat, which returns no_tenant for anonymous callers)"
  - "resolveAdminWorkspaceScope in multi-tenant mode refuses an admin id that is not a UUID with 503 invalid_user before any query; in single-tenant mode it ignores every input and makes no Supabase call"
  - "nangoOwnerScope is synchronous and does no I/O: the caller reads nango_connections by connection_id (UNIQUE) and passes the row's user_id; a null, empty, 'null' or 'single-tenant-user' owner is 503 invalid_owner in multi-tenant mode"
  - "Resolver refusal logs use their own labels ('admin workspace scope', 'nango owner scope') under the [RAG Tenant] prefix"

patterns-established:
  - "Write-path scope resolvers live in tenant/ingest-scope.ts, the only module besides the delivered resolvers that calls mintScope"

coverage:
  - id: D1
    description: "requireRagAdmin contract verified against the plan: the delivered 15 cases cover every contract line; two new cases lock that the admin_users query receives the caller's own AbortSignal object (cookie and Bearer paths) and that an already aborted signal gives 503 with no admin_users query"
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "tests/rag/rag-admin-guard.test.ts (17 tests) and tests/api/admin-auth.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Config UI workspace scope: single-tenant s:default with no Supabase call; multi-tenant o:<id> only after a membership row, 403 not_member / invalid_organization, personal u:<admin> without an organization, lowercase keys, 503 on query error, missing client, aborted signal or non-UUID admin id"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest-scope.test.ts (9 resolveAdminWorkspaceScope tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Nango owner scope: u:<owner lowercased> from the connection row owner, s:default in single-tenant mode, non-UUID or missing owner refused with 503 invalid_owner"
    requirement: DATA-10
    verification:
      - kind: unit
        ref: "tests/rag/ingest-scope.test.ts (3 nangoOwnerScope tests)"
        status: pass
    human_judgment: false

duration: 5min
completed: 2026-11-24
---

# Phase 3 Plan 07: Ingest scope resolvers and admin guard check Summary

**Server-side scope resolvers for Config UI uploads (membership-checked workspace) and Nango syncs (connection-row owner), plus two regression locks on the delivered fail-closed `requireRagAdmin`**

## Performance

- **Duration:** 5 min
- **Started:** 2026-11-24T00:25:00Z
- **Completed:** 2026-11-24T00:30:10Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Verified the delivered `requireRagAdmin` against the plan contract. All must_haves held, so `src/lib/rag/tenant/admin.ts` was not touched. There is still exactly one definition of `requireRagAdmin` under `src/`.
- Added the two missing regression cases to `tests/rag/rag-admin-guard.test.ts` (15 to 17 cases). They passed on first run, as the plan expected.
- Added `resolveAdminWorkspaceScope` and `nangoOwnerScope` in `src/lib/rag/tenant/ingest-scope.ts`. Neither takes a raw user or organization id as authority: the first checks `organization_members` for the admin, the second takes the owner id the caller read from the server-side connection row.
- Exported both resolvers and their types from `@/lib/rag`. The existing `requireRagAdmin` and `isAdminUser` exports are untouched.

## Task Commits

1. **Task 1: Lock in the delivered requireRagAdmin against this plan's contract** - `88840b8` (test)
2. **Task 2: Config UI workspace and Nango owner scope resolvers** (TDD)
   - RED: `069fc16` (test). A stub module refused everything, so 12 of 12 tests failed on behaviour (not on a missing module).
   - GREEN: `196506f` (feat)

**Plan metadata:** the docs commit that adds this SUMMARY.md

## TDD notes

- RED (Task 2): `npx vitest run tests/rag/ingest-scope.test.ts` gave 12 failed, 0 passed against the refusing stub. The failures were assertion errors (expected 403/503 reasons or scopes, got `503 not_implemented`). The vitest report was inspected by hand; the `check tdd-red-evidence` classifier was not run, because the project's tests run under vitest and this plan is `type: execute`, not `type: tdd`.
- GREEN: 12 of 12 pass. No REFACTOR commit was needed.
- Task 1 is a regression lock, so its two new cases passed at once (no RED commit, as the plan allows).

## Files Created/Modified

- `src/lib/rag/tenant/ingest-scope.ts` - the two resolvers; calls `mintScope` and `isOrganizationMember`
- `tests/rag/ingest-scope.test.ts` - 12 cases (9 for the admin workspace resolver, 3 for the Nango owner)
- `src/lib/rag/index.ts` - value and type exports for the new module
- `tests/rag/rag-admin-guard.test.ts` - two new cases: signal identity (`toBe` on the exact object, both paths) and already-aborted signal

## Decisions Made

See `key-decisions` above. In short: the guard stays as delivered; the admin resolver always yields a scope (never `no_tenant`); `nangoOwnerScope` does no lookup of its own.

## Deviations from Plan

None - plan executed exactly as written.

The plan asked the SUMMARY to record which guard cases were added and whether `admin.ts` changed. Added: "the admin_users query receives the very AbortSignal the caller passed" and "an already aborted caller signal is refused with 503 and makes no admin_users query". `admin.ts` did not change.

## Issues Encountered

- The commit trailer differs between sources: the executor brief names one model in the `Co-Authored-By` line and the session attribution reminder names another. The commits use the session reminder's line, and the orchestrator can amend if it wants the other. No model identifier appears in code or comments.

## Gate results (in the worktree)

| Gate | Result |
|---|---|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no errors |
| `npx vitest run` | 109 files, 1347 tests passed (includes `tests/rag/langfuse-pins.test.ts`) |
| `node --import tsx --test tests/*.test.mts` | 136 pass, 0 fail |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 622 files, no violations |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 79 variables match the manifest |
| rag-sidecar pytest | not run: rag-sidecar untouched |

Plan acceptance criteria: Task 1 greps 2 / 1 / 4 / 17 (expect 2 / 1 / >=1 / >=17), 43 vitest tests passed across the two guard files (expect >=37). Task 2 greps `isOrganizationMember` 2 (>=1), exported resolver names 2 (==2), `requireRagAdmin` in index.ts 1 (>=1), 12 ingest-scope tests passed (>=8).

## Known Stubs

None. The RED-commit stub in `ingest-scope.ts` was replaced by the real implementation in the GREEN commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 03-23, 03-24, 03-31, 03-32 and 03-33 can call `resolveTenantScope` (delivered), `resolveAdminWorkspaceScope` and `nangoOwnerScope` from `@/lib/rag`.
- 03-33 must still read the connection row by `connection_id` itself and pass its `user_id` to `nangoOwnerScope`; this plan deliberately adds no lookup.
- No blockers.

## Self-Check: PASSED

- `src/lib/rag/tenant/ingest-scope.ts`, `tests/rag/ingest-scope.test.ts`: present.
- Commits `88840b8`, `069fc16`, `196506f` are ancestors of HEAD; `git rev-list --count ccfcd7e..HEAD` was 3 before this SUMMARY commit.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
