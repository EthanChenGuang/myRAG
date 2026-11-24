---
phase: 03-unified-ingestion-embedding-profiles
plan: 34
subsystem: ingestion
tags: [ingest, status-route, resume-route, reaper, tenant-scope, zod, sidecar-resume]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "getIngestStatus, resumeIngest and the tenant-checked rag_get_ingest_document (03-13b); rehydrateFromStore and the private object store (03-17); parser chain, sidecar job client with saved job id, resume and one resubmit (03-27)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "requireSessionUser, resolveTenantScope, isAdminUser"
provides:
  - "GET /api/rag/ingest/{id}: { status, version, processingStatus, lastCompleted, parserUsed, docType, warnings } (plus reason on a failed version) for the caller's verified scope, 404 for any other id"
  - "POST /api/rag/ingest/{id}/resume: runs resumeIngest with the caller's scope and returns its result; ready rows return at once"
  - "getIngestStatusReport and STALE_PROCESSING_MS exported from @/lib/rag; the status read is the 24 hour reaper (reason stale_processing)"
  - "Proof against PGlite, the fake sidecar and the fake object store that an interrupted parse resumes to ready with one submit and no duplicate chunks"
affects: [03-35, 03-36, 03-37, 03-41, 03-48]

actuals:
  tokens: 11800
  tasks: 2
  commits: 3

plan_head_before: 14f30e5f426a8493e3d0e2f92eb9c2701749e02d
plan_head_after: 7220fc36d2e677a127535ed812edbb120d6fdfe0

tech-stack:
  added: []
  patterns:
    - "Route logic lives in src/app/api/rag/ingest/_lib/handlers.ts with an optional getUser seam; route.ts files are three-line wrappers that never pass it, so node:test can drive the handler without a cookie session"
    - "Another tenant's id and an unknown id take the same code path and return the same 404 body"

key-files:
  created:
    - src/app/api/rag/ingest/[id]/route.ts
    - src/app/api/rag/ingest/[id]/resume/route.ts
    - src/app/api/rag/ingest/_lib/handlers.ts
    - tests/rag/ingest/ingest-status-routes.test.ts
  modified:
    - src/lib/rag/ingest/status.ts
    - src/lib/rag/index.ts
    - tests/rag-db/ingest-resume.test.mts
    - tests/rag/ingest/ingest-trace.test.ts

key-decisions:
  - "The reaper is the status read, as the plan says: no cron or internal route exists, so no new secret and no new env variable. It acts only on a row of the caller's own tenant whose status is processing and whose created_at is strictly more than 24 h before deps.now(); an unreadable created_at is never reaped"
  - "A reaped version is failed through the existing rag_mark_document_failed (reason stale_processing). Failed is retryable because rag_begin_document_version only reuses a processing row: uploading the same file again creates a new version of the same lineage (tested)"
  - "Single-tenant resume is administrator-only. The unified writer stores user_id only in multi-tenant mode, so a non-admin cannot be shown to own a single-tenant document, and AGENTS.md 12 asks for owner-or-admin. Status stays open to any verified session (it returns no text, ids are UUIDs)"
  - "warnings in the GET body are short codes derived from persisted state (parse_pending while a parse job id is saved, embedding_gaps); processing_state keeps no run warnings, and IngestStatusView is unchanged so the 03-13b assertions still hold"
  - "The organization is chosen with ?organizationId= on both routes and honoured only through resolveTenantScope's membership check; a non-member gets 403 before any document lookup"

patterns-established:
  - "Route tests mock '@/lib/supabase' and '@/lib/supabase/server', run the real resumeIngest behind a spy, and use a stateful fake RpcClient whose tenant-checked functions mirror the SQL"

requirements-completed: [DATA-05, DATA-01]

coverage:
  - id: D1
    description: "GET status for a document of the caller's verified scope returns the seven documented fields and no filename, job id or text; another tenant's id returns 404 with the same body as an unknown id; a malformed id returns 400 with a structured error"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/ingest-status-routes.test.ts#returns the status object of the owner own document and nothing else"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/ingest-status-routes.test.ts#answers 404 for another tenant document with the same body as for an unknown id"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-resume.test.mts#another tenant sees no status for the interrupted document and cannot resume it; the sidecar is not touched"
        status: pass
    human_judgment: false
  - id: D2
    description: "Status and resume refuse with 401 when there is no session (multi- and single-tenant), 503 when the session lookup fails, 403 for an organization the caller is not a member of, and run no lookup or stage in any of those cases"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/ingest-status-routes.test.ts#answers 401 with no session (GET and POST, both modes), #answers 503 when the session lookup throws, #honours an organization query parameter only through the membership check"
        status: pass
    human_judgment: false
  - id: D3
    description: "POST resume calls resumeIngest with the caller's scope and returns its result; a ready document returns ready with no stage run; a processing document of another tenant is untouched; single-tenant resume needs an administrator"
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "tests/rag/ingest/ingest-status-routes.test.ts#continues a processing document through resumeIngest with the caller scope, #returns ready for a ready document without running a stage, #in single-tenant mode lets only an administrator resume"
        status: pass
    human_judgment: false
  - id: D4
    description: "A version processing for more than 24 hours is failed with stale_processing by the status read in the caller's own tenant only; at or under 24 h, ready, failed and unreadable-age rows are left alone; another tenant's stale row is neither reaped, reported nor logged; the log carries the id and age only"
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "tests/rag/ingest/ingest-status-routes.test.ts#marks a version that has been processing for more than 24 hours as failed, #leaves alone a processing version at or under 24 hours, #does not reap, report or log another tenant stale row, #logs the id of a reaped version and no filename or text"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-resume.test.mts#a version still processing after 24 hours is failed by the status read, only in its own tenant, and the same file can then be uploaded again as a new version"
        status: pass
    human_judgment: false
  - id: D5
    description: "A fixture PDF whose sidecar job outlasts the poll budget returns processing with the job id in processing_state; the resume route polls the same job (one submit, no second POST), reaches ready, and the chunks equal those of an uninterrupted run with contiguous indexes and derived ids; an expired job is resubmitted once and still reaches ready"
    requirement: DATA-05
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-resume.test.mts#a parse job that outlasts the poll budget returns processing with its job id, and the resume route polls the same job to ready without a second submit"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-resume.test.mts#a job the sidecar no longer knows is resubmitted once on resume and still reaches ready"
        status: pass
    human_judgment: false

duration: not measured
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 34: Ingest Status and Resume Routes with the 24 Hour Reaper Summary

**Authenticated, tenant-scoped GET status and POST resume routes for unified ingestion (another tenant's id is a 404 identical to an unknown id), a status-read reaper that fails versions processing for more than 24 hours, and a PGlite test that resumes an interrupted sidecar parse to ready through the route with one submit and no duplicate chunks**

## Performance

- **Duration:** not measured (start time not recorded)
- **Completed:** 2026-11-24T08:47Z
- **Tasks:** 2 (3 commits before this one)
- **Files:** 4 created, 4 modified, 975 insertions, 4 deletions

## Accomplishments
- `GET /api/rag/ingest/{id}` and `POST /api/rag/ingest/{id}/resume` (`runtime = 'nodejs'`, async params, zod/v3 id check, structured `{ success: false, error, details }` 400s). Order: verified session (`requireSessionUser`, 401 or 503), id and query validation, `resolveTenantScope` (403 for a non-member organization), then the lookup. The scope never comes from the request.
- Another tenant's id and an unknown id both come back from the tenant-checked `rag_get_ingest_document` as no row and take the same code path to `404 { error: 'Document not found' }`. Responses carry codes and numbers only: no filename, job id or document text. 503 bodies and logs never echo the database message.
- `getIngestStatusReport` (exported from `@/lib/rag`, with `getIngestStatus` as a thin wrapper) is the reaper. A processing row of the caller's tenant whose `created_at` is strictly more than 24 h before `deps.now()` is failed through `rag_mark_document_failed` with `stale_processing` and reported as failed; it logs `[Ingest] reaped stale processing version` with the document id and age in hours. Nothing else is touched.
- The D-21 case runs end to end: a fixture PDF with a job that outlasts the 5 s poll budget yields `processing` / `parse_pending` with `parseJob.jobId` saved; after the job succeeds the resume route reaches `ready` with the sidecar seeing one submit and then only GETs and the delete; chunks equal an uninterrupted run's (content, hash, kind, path, pages, metadata) and ids equal `chunkIdFor(documentId, index)`.

## Task Commits

1. **Task 1: routes, reaper (TDD)** - RED `602390e` (test), GREEN `38fe58f` (feat)
2. **Task 2: interrupt and resume (test only)** - `7220fc3` (test)

**Plan metadata:** committed after this file (docs: complete plan). `commits: 3` is measured from the ledger base `14f30e5`.

## Files Created/Modified
- `src/app/api/rag/ingest/[id]/route.ts`, `.../[id]/resume/route.ts` - three-line wrappers over the handlers
- `src/app/api/rag/ingest/_lib/handlers.ts` - session, validation, scope, status and resume handlers
- `src/lib/rag/ingest/status.ts` - `getIngestStatusReport`, `STALE_PROCESSING_MS`, reaper, warning and reason codes
- `src/lib/rag/index.ts` - two export lines appended at the end
- `tests/rag/ingest/ingest-status-routes.test.ts` - 21 route tests
- `tests/rag-db/ingest-resume.test.mts` - four tests appended in a nested describe
- `tests/rag/ingest/ingest-trace.test.ts` - one fixture line

## Decisions Made
See `key-decisions`. The two that later work should know: single-tenant resume is admin-only until the unified writer records an owner in single-tenant mode, and the reaper reads `created_at`, so a processing row that was re-uploaded (reused by `rag_begin_document_version`) keeps its original age.

## Deviations from Plan

**1. [Rule 3 - Blocking] Handler module beside the routes** - The plan lists only the two route files. The routes are wrappers over `src/app/api/rag/ingest/_lib/handlers.ts` so the node:test DB test can drive the resume logic: `requireSessionUser` calls `cookies()`, which throws outside a Next request. The handler takes an optional `getUser` seam that no route passes. The DB test therefore exercises the handler, not the `route.ts` file; the vitest route tests load the real `route.ts` files.

**2. [Rule 2 - Missing Critical] Single-tenant resume is administrator-only** - The plan says "owner". In single-tenant mode every verified session maps to the one `s:default` tenant and the unified writer does not store `user_id` there, so ownership cannot be shown for a non-admin. Failing closed (403) follows AGENTS.md 12 (owner-or-admin writes). Status is not restricted.

**3. [Rule 1 - Bug caused by this change] 03-13b status fixture** - `tests/rag/ingest/ingest-trace.test.ts` used `created_at: 2026-01-01` with the real clock for a processing row; the reaper correctly failed it. The fixture now uses the current time. No behaviour of 03-13b changed.

**4. [Plan interpretation] `warnings`** - Run warnings are not persisted, so `warnings` is derived from persisted state as short codes (`parse_pending`, `embedding_gaps`). `reason` is added to the body only when a version is failed.

**5. [Plan interpretation] No new migration, race note** - The reaper uses the existing `rag_mark_document_failed`, which refuses a current version (`document_is_current`) but does not check `status = 'processing'`. A run that quarantines a version in the instant between the status read and the mark could be failed; that needs a run still alive after 24 h, which the 60 s request cap rules out in practice. A conditional SQL function would need a migration and a `schema-migrations.test.mts` change; I did not add one.

**6. [Test design] Task 2 fixtures** - A tenant's ready file is a duplicate for that tenant, so the four DB tests use four fixture PDFs (`report-zh-table`, `scan-en`, `scan-zh`, `scan-it`).

**Total deviations:** 6 (1 blocking, 1 missing-critical, 1 fix to an existing fixture, 3 interpretations). No scope creep.

## TDD Gate Compliance

- **Task 1 RED (`602390e`):** all 21 route tests failed on assertions against inert 501 stubs (`expected 501 to be 401`, `expected 501 to be 200`, and so on); the commit carries the stubs so the tests load. This includes every auth check (401 GET and POST in both modes, 503, 403) and the two-tenant 404 tests. The reaper tests also fail against the reaper-less `getIngestStatusReport` of that commit. Semantic assessment: every failure was the planned assertion, none an import, syntax or fixture fault. `gsd_run check tdd-red-evidence` was not run (it rejects vitest TAP output, as 03-13b and 03-17 found; `workflow.tdd_mode` is off).
- **Task 1 GREEN (`38fe58f`):** 21 of 21 pass; the 03-13b status test failed once for the fixture reason in deviation 3 and was fixed in the same commit.
- **Task 2 (`7220fc3`):** no RED commit. The behaviour already existed (03-13b, 03-17, 03-27), and all four tests passed on their first run, so there was nothing to fix in a stage. To show the tests can fail, I temporarily made `savedJob` return null in the parse stage: the main resume test failed on the one-submit assertion; the file was restored with `git checkout` and is unchanged in the history. This commit is verification, not a RED/GREEN pair.

## Issues Encountered
- One of the first full runs of `node --import tsx --test tests/*.test.mts` reported 1 failure of 145 right after the vitest run; two reruns passed 145 of 145 (the load flake 03-22 and 03-27 recorded). I did not capture which test.

## Gate Results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 148 files, 2093 tests passed |
| `node --import tsx --test tests/*.test.mts` | 145 passed on rerun (1 failure on one earlier run under load, see above) |
| `node --import tsx --test tests/rag-db/*.test.mts` | 288 tests: 285 passed, 0 failed, 3 skipped (single-tenant variants) |
| `node --import tsx --test tests/rag-db/ingest-resume.test.mts` | 6 passed (criteria: at least 3) |
| `npx vitest run tests/rag/ingest/ingest-status-routes.test.ts tests/routes/async-params.test.ts` | 35 passed; status routes 21 (criteria: at least 7) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 756 files (a first draft deep-imported `@/lib/rag/deps`; fixed before the GREEN commit) |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables (no new variable) |
| rag-sidecar pytest, eval pytest | not run, untouched |

Acceptance: `grep -c "stale_processing" src/lib/rag/ingest/status.ts` = 2 (EXPECT >= 1).

## Threat Surface
T-03-97 (id probing): the tenant check sits in `rag_get_ingest_document`; another tenant's id and an unknown id return the same 404 body (unit and two-tenant DB tests); a malformed id is 400 before any lookup. T-03-98 (repeated resume): resume is idempotent, ready rows return with no stage run (tested), a second resume wrote nothing (tested); the advisory lock in `begin` is unchanged. Reaper: only the caller's tenant, only `processing`, strictly over 24 h, id and age in the log, no cron or internal route and therefore no secret to compare. T-03-SC: no package changes.

## Known Stubs
None.

## User Setup Required
None - no migration, environment variable or package change. The two routes are live as soon as the app is deployed; both require a Supabase session.

## Next Phase Readiness
- The Config UI status monitor and the chat upload poll can call `GET /api/rag/ingest/{id}` (`?organizationId=` for an organization workspace) and `POST .../resume`.
- A UI that wants non-admins to resume single-tenant uploads needs the unified writer to record `user_id` in single-tenant mode first.
- 03-48 live checks: the resume route against a real sidecar job is covered by the fake only.

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | retrospective / plan predates gate | n/a |
| Impeccable | retrospective | n/a |
| web-design-guidelines | retrospective (no re-audit this pass) | pass (all findings resolved) |

## Self-Check: PASSED

All created files exist on disk; commits `602390e`, `38fe58f` and `7220fc3` are ancestors of HEAD; the ledger count is 3.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
