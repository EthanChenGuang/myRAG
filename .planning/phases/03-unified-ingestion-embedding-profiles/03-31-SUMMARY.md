---
phase: 03-unified-ingestion-embedding-profiles
plan: 31
subsystem: ingestion
tags: [ingest, process-document, config-ui, tenant-scope, session-auth, admin-guard, write-path]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "ingest() and buildSourceKey (03-13, 03-13b), object store (03-17), doc-type resolution with picked and auto (03-22), currentIngestConfig (03-23), parser chain (03-27), resolveAdminWorkspaceScope (03-07)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "resolveTenantScope, repairOwnerMembership, checkAdmin and the signed admin_session cookie, checkSingleTenantKbWrite"
provides:
  - "process-document unified branch: a permanent upload goes to ingest() as chat_upload or config_upload with a server-verified scope, the picked doc_type and the source key <folder or root>/<NFKC filename>"
  - "config_upload decision through checkAdmin: honoured only after the session check, only when the form says so, only when the guard's userId equals the session user; 503 refuses; 401, 403 or another user falls back to chat_upload"
  - "413 over 20 MB and 415 outside the MIME and extension allow-list before any parse (unified only)"
  - "Config UI proxy marks process-document and /api/upload requests with upload_source=config_upload and forwards doc_type"
affects: [03-32, 03-39, 03-41, 03-42, 03-43, phase-7-release-defaults]

actuals:
  tokens: 13300
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Write route order: HEAD's session and organization checks first and unchanged, then the pipeline switch (currentIngestConfig, legacy when unreadable), then form validation, limits, source decision, scope resolution, ingest"
    - "The source of a Config UI upload is decided on the server from the admin guard's userId equal to the session user, never from a cookie or a form field alone"

key-files:
  created:
    - tests/rag/ingest/write-path-process-document.test.ts
    - tests/rag/ingest/write-path-process-document-two-tenant.test.ts
  modified:
    - src/app/api/process-document/route.ts
    - scripts/config-server.js

key-decisions:
  - "The switch is read with currentIngestConfig (03-23's accessor) inside a try/catch that returns legacy, not with loadIngestConfig directly: tests/rag/single-tenant-writes.test.ts mocks @/lib/rag with two exports and must pass unchanged, and a configuration that cannot be read is today's behaviour"
  - "doc_type is validated against DocTypeDetectionSchema.shape.doc_type from the generated contract plus 'auto', so no hand-copied list of the six types exists in the route"
  - "A file is accepted when its extension is on the list (or it has none and the MIME type is specific) and its MIME type is on the list; an empty or application/octet-stream type is taken from the extension. A text/plain file named tool.exe is refused (415), so the MIME type cannot launder an unknown extension"
  - "Both upload sources call repairOwnerMembership before the scope resolver, so an organization owner without a members row behaves as in the legacy path"
  - "A refused or failed ingest answers a generic 500 with status failed and no reason, as 03-24 does; the reason is logged with the [ProcessDocument] prefix"
  - "The Config UI proxy overwrites upload_source itself and builds the form from a whitelist, so a browser-supplied upload_source never passes through"

patterns-established:
  - "Two-tenant route test that stubs only the admin guard result (checkAdmin) and the session, and runs the real ingest() and writer SQL, with the fixture corpus ids excluded from the assertions"

requirements-completed: [DATA-01, DATA-03]

coverage:
  - id: D1
    description: "Under legacy (unset, legacy or an invalid value) the route is unchanged: LlamaParse, the character chunker with the Document prefix, storeDocument, the legacy 400 for an oversized file; upload_source, doc_type and an admin cookie are ignored and checkAdmin is never called"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-process-document.test.ts#process-document write path: legacy"
        status: pass
      - kind: unit
        ref: "tests/rag/single-tenant-writes.test.ts (unchanged, 15 passed)"
        status: pass
    human_judgment: false
  - id: D2
    description: "In both pipelines and both modes a knowledge-base upload with no session gets 401, a failing lookup 503 (single-tenant), a non-member organization 403, all before any parse, ingest, storeDocument or admin lookup; a valid, unsigned or tampered admin cookie without a session still gets 401"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-process-document.test.ts#the session check comes first in both pipelines and both modes"
        status: pass
      - kind: integration
        ref: "tests/rag/ingest/write-path-process-document-two-tenant.test.ts#an admin guard 503 writes nothing, and no session gets 401 / refuses a request with no session"
        status: pass
    human_judgment: false
  - id: D3
    description: "Under unified a chat upload reaches ingest() as chat_upload with s:default, u:<session user> or o:<member organization>, the picked doc_type or auto, source key <folder or root>/<NFKC filename>, the file bytes and a deadline under 60 s; a non-member organization is 403; the session is looked up once"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-process-document.test.ts#unified chat_upload"
        status: pass
      - kind: integration
        ref: "tests/rag/ingest/write-path-process-document-two-tenant.test.ts (personal, organization, duplicate, second user, single-tenant)"
        status: pass
    human_judgment: false
  - id: D4
    description: "config_upload only when checkAdmin is ok for the verified session user; a non-admin, a forged, tampered, expired or foreign-key cookie, a cookie for admin A with the session of user B and a bearer token of admin A with the session of user B all give chat_upload with the session scope; a guard 503 returns 503 with nothing parsed, ingested or stored"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-process-document.test.ts#unified config_upload (T-03-88, T-03-150)"
        status: pass
      - kind: integration
        ref: "tests/rag/ingest/write-path-process-document-two-tenant.test.ts#a config_upload by admin A / the admin guard naming admin A for the session of user B"
        status: pass
    human_judgment: false
  - id: D5
    description: "doc_type (six types or auto), upload_source and folder_id are validated with a structured 400; 413 over 20 MB and 415 outside the allow-list come before parsing; ready answers 200 with status, version and parserUsed, processing 202, a duplicate the existing id, a failure a generic 500"
    requirement: DATA-03
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-process-document.test.ts#unified chat_upload"
        status: pass
    human_judgment: false
  - id: D6
    description: "The Config UI proxies add upload_source=config_upload to both upload requests and forward doc_type, with the forwarded Cookie and Authorization unchanged and no credential of their own"
    requirement: DATA-01
    verification:
      - kind: command
        ref: "grep -c upload_source scripts/config-server.js = 2; grep -c SERVICE_ROLE = 10 before and after; node --check; node scripts/check-config.mjs"
        status: pass
    human_judgment: true
    rationale: "No test drives the Config UI proxy end to end (the script starts an Express server and a live main app); a real Config UI upload as a signed-in admin under RAG_INGEST_PIPELINE=unified should confirm the row source is config_upload"

duration: not measured
completed: 2026-11-24
status: complete
plan_head_before: 14f30e5f426a8493e3d0e2f92eb9c2701749e02d
plan_head_after: f048df66a38c41c950a35e8f3a8bb5c7ab7c499e
commits: 3
---

# Phase 3 Plan 31: process-document and Config UI uploads behind ingest() Summary

**Chat and Config UI knowledge-base uploads go through ingest() under RAG_INGEST_PIPELINE=unified, with the source decided on the server (config_upload only when the admin guard names the verified session user), the scope minted from that session, the picked document type passed through, and the Phase 2 session-first checks left exactly where they were in both pipelines.**

## Accomplishments

- `uploadThroughIngest` in `src/app/api/process-document/route.ts` runs only after POST's own session and organization checks, for a permanent upload when `currentIngestConfig().pipeline` is `unified`. Order: form validation (400), size and MIME limits (413, 415), the config_upload decision, scope resolution, ingest with the request signal and a deadline of 50 s minus the time already spent (never under 5 s), response mapping.
- config_upload rule as specified: `checkAdmin(request)` is called only for `upload_source=config_upload`; ok with a `userId` equal to the session user gives `config_upload` and `resolveAdminWorkspaceScope`; 401, 403 or another user gives `chat_upload` with `resolveTenantScope`; 503 returns `adminDenied(503)` with nothing done. Chat uploads never call it.
- Temporary attachments (`isTemporary=true`) keep the legacy parse call in both pipelines and persist nothing. Every legacy line is untouched; the diff to the legacy body is the new imports, a `startedAt` line and a five-line switch before `console.log('Processing file:'...)`.
- Config UI: the process-document proxy appends `upload_source=config_upload` and forwards `doc_type`; the `/api/upload` proxy appends `upload_source=config_upload` (plan 03-32 reads it).

## Task Commits

1. **Task 1: Unified branch in process-document (TDD)**
   - RED `087457f` (test): 24 of 41 failed on assertions, 17 passed as guards for HEAD behaviour
   - GREEN `f994f4a` (feat): 41 unit tests and the new two-tenant file (8 tests) pass
2. **Task 2: Config UI proxy marks the source and forwards the type** - `f048df6` (feat)

`commits: 3` is measured from the ledger base `14f30e5`.

## Behaviour changes

All under `RAG_INGEST_PIPELINE=unified`; legacy is byte-for-byte the HEAD behaviour.

- A permanent upload is written by ingest(): a versioned, deduplicated document in the caller's tenant (`s:default`, `u:<user>` or `o:<org>`) instead of the route's own inserts and the `Document: X. Chunk n of m. Content:` prefix. Re-uploading an identical file answers `skipped_duplicate` with the existing id.
- The response keeps `id`, `name`, `type`, `successfulChunks`, `totalChunks` (the dashboard reads `id`), adds `documentId`, `filename`, `status`, `version`, `parserUsed`; `processing` answers 202.
- 413 (over 20 MB) and 415 (MIME or extension outside the list) replace the legacy 400 for size; a doc_type outside the six types and auto, or an unknown upload_source, is a 400 with `{ success: false, error, details: [{ path, message }] }`.
- Single-tenant unified documents carry no `user_id` (the scope is `s:default`), the same as 03-23 and 03-24.
- The Config UI now sends `upload_source=config_upload`; legacy ignores it.

## Deviations from Plan

**1. [Interpretation] Truth 2 says a failing session lookup returns 503 "in both deployment modes"**
- HEAD's multi-tenant block has no try/catch around `auth.getUser()`, so a throwing lookup reaches the outer catch and answers 500 (nothing is parsed or written). The plan also says legacy is unchanged from HEAD and the behaviour list names 503 only for single-tenant. I kept the multi-tenant lines unchanged and pinned "not a success, nothing runs". If 503 is wanted there too, it is a three-line try/catch in the multi-tenant block that also changes legacy; the coordinator should decide.

**2. [Rule 2 - Missing critical] Extension check next to the MIME check**
- A plain MIME allow-list lets a file named `tool.exe` through as `text/plain`. The extension (when there is one) must also be on the list, and a prototype key such as `.constructor` is not an extension. Tests cover both.

**3. [Rule 2 - Missing critical] repairOwnerMembership also before the admin workspace scope**
- The plan names it for chat_upload only. `resolveAdminWorkspaceScope` needs a members row, so an owner without one would get 403 for a config_upload that the legacy path accepts. The same call runs for both sources.

**4. [Plan interpretation] The response does not carry `text`**
- The legacy response returns the parsed `text`. ingest() does not return it and the plan's response contract lists only ids, names, counts, status, version and parserUsed. `document-dashboard.tsx` falls back when `text` is absent and the Config UI ignores it. `src/app/page.tsx` (the `fileType === 'document'` branch) throws "Invalid response from document processing" without `text`; nothing in `unified-upload-button.tsx` reaches it for documents (temporary uploads stay on the legacy parse, which still returns text), but it is the one consumer to look at before Phase 7 makes unified the default.

**5. [Plan interpretation] Unit tests plus a second test file**
- The plan lists one test file. The brief asks for a two-tenant test per auth change and for DB tests with the fake object store, so `write-path-process-document-two-tenant.test.ts` was added; it stubs only `checkAdmin` and the session and runs the real ingest() and writer SQL in both deployment modes.

**Total deviations:** 5 (1 open question, 2 Rule 2, 2 interpretations). **Impact:** none on the security rules; every must_haves truth holds except the literal 503 wording of deviation 1.

## TDD Gate Compliance

Task 1 has `test(03-31)` `087457f` then `feat(03-31)` `f994f4a`. `gsd_run check tdd-red-evidence` was not run (workflow.tdd_mode is off and earlier plans found it rejects vitest output); RED was assessed by hand. At `087457f` 24 of 41 tests failed on assertions (`ingest was called`, `expected 200 to be 202`, `expected 400 to be 413`, `expected 200 to be 503`, the response key list); the 17 that passed are guards for HEAD (legacy branch, session-first 401 and 503 in both pipelines and modes, forged and valid cookies without a session, non-member 403, temporary parse, read_only_doc_dashboard). Mutation checks after GREEN: replacing the userId equality with `admin.ok` fails the bearer-token-of-another-admin test and the two-tenant mismatch test; removing the 503 branch fails the unit and the two-tenant 503 tests. The two-tenant file was written after the implementation (verification).

## Gate Results (worktree /home/user/wt/03-31, branch exec/03-31)

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 149 files, 2121 tests: 2120 passed, 1 failed (`tests/rag/injection-scan.test.ts` 1 MB timing assertion under full-suite load; 45 of 45 when run alone, same flake 03-24 and 03-26 recorded) |
| `node --import tsx --test tests/*.test.mts` | 145 passed, 0 failed |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 754 files |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest, eval pytest | not run, untouched |
| `tests/rag/langfuse-pins.test.ts` | 15 passed, no ENOENT |
| Plan verification: `single-tenant-writes`, `write-path-process-document` (2 files), `tests/api/admin-auth.test.ts`, `tests/api/config-admin-routes.test.ts` | 120 passed |

Acceptance: `config_upload` in route.ts 6 (EXPECT >=1); `Document: ${` 1 (>=1); `Authentication required` 2 (>=2); `single-tenant-writes` 15 passed (>=8); `checkAdmin` 2 (>=1); `requireRagAdmin` 0 (==0); `mintAdminSessionValue` in the test 4 (>=1); `write-path-process-document.test.ts` 41 passed (>=18); `upload_source` in config-server.js 2 (>=2); `SERVICE_ROLE` 10 before and after.

## Threat Surface

T-03-88: config_upload needs the session check, `upload_source=config_upload`, and a guard result whose userId equals the session user; non-admin, forged or expired cookie, foreign-key cookie, cookie-for-A with session-of-B and bearer-of-A with session-of-B all give chat_upload (tests, plus mutation check). T-03-89: scope comes from the membership-checked resolvers and the HEAD organization check; a non-member is 403 before ingest, against the real database for a second tenant. T-03-139 and T-03-150: the HEAD 401/503 check is first for both pipelines; a valid cookie without a session is 401 and the admin_users lookup, parse, ingest and store never run. T-03-90: 413 and 415 before the file is read into memory by the route. T-03-91: the filename is data only (source key and the file name passed to ingest; storage keys come from 03-17). LlamaParse spend stays behind the verified session: the unified branch is reached only after it, and the temporary path keeps the legacy check. No new endpoint, no package.

## Known Stubs

None.

## User Setup Required

None. No new environment variable, migration or package; the config sync rule has nothing to mirror.

## Operator actions

- None are required to keep today's behaviour (the default pipeline is legacy).
- Before enabling `RAG_INGEST_PIPELINE=unified` for uploads: apply migrations 0301 to 0312, and set at least one parser (`LLAMA_CLOUD_API_KEY` or `RAG_SIDECAR_URL` with `RAG_SIDECAR_SECRET`); plain text, Markdown and CSV need none. Without a parser a PDF answers 500 `failed` and the reason is in the `[ProcessDocument]` log.
- One live check is still open: upload once from the Config UI as a signed-in admin (the admin_session cookie and the Supabase session in the same browser) and confirm `documents.source = 'config_upload'`; a Config UI upload without the Supabase session gets the existing 401 and the Config UI's "sign in to the main myRAG app in this browser" message.

## Next Phase Readiness

- 03-32 reads `upload_source` on `/api/upload`; the proxy now sends it. 03-39 and the picker plans can send `doc_type` through the proxy.
- Phase 7: remove the legacy branch (still listed in `LEGACY_WRITERS`), and decide the `text` question for `page.tsx` (deviation 4) and the multi-tenant 503 (deviation 1).

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | retrospective / plan predates gate | n/a |
| Impeccable | retrospective | n/a |
| web-design-guidelines | retrospective (no re-audit this pass) | pass (all findings resolved) |

## Self-Check: PASSED

Created files exist on disk (both test files); commits `087457f`, `f994f4a` and `f048df6` are ancestors of HEAD; the measured count from the ledger is 3.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
