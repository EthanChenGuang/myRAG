---
phase: 03-unified-ingestion-embedding-profiles
plan: 33
subsystem: ingestion
tags: [ingest, nango, connectors, tenant-isolation, lineage, doc-type-defaults]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "ingest() and buildSourceKey (03-13), nangoOwnerScope (03-07), Nango folder and connection doc-type defaults (03-22), IngestOptions.origin and currentIngestConfig (03-23), parser chain (03-27), version-aware readers (03-30)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "the Nango security fix: no Bearer branches, session user on every nango route, UNIQUE(connection_id), end_user binding on connect"
provides:
  - "processDocumentWithMetadata with a unified branch: ingest({ scope: nangoOwnerScope(owner), source: 'nango', sourceKey: provider file id }) with origin, connection id, folder id and file type"
  - "NangoIngestError (typed: invalid_owner, missing_file_id, ingest failed or unfinished) and nangoPipeline() read per call"
  - "sync-manager: owner read only from the unique nango_connections row, connection and folder ids at all five call sites, lineage deletes inside the owner tenant"
affects: [03-48, 03-37, phase-7-release-defaults]

actuals:
  tokens: 15500
  tasks: 2
  commits: 4

plan_head_before: 14f30e5f426a8493e3d0e2f92eb9c2701749e02d
plan_head_after: a9ccbf58854018367a477e5011bf76b81084ce08

tech-stack:
  added: []
  patterns:
    - "A connector adapter switches per call through currentIngestConfig and falls back to legacy when the read fails (same as the scraper switch)"
    - "Orphan deletes find a file by its identity (tenant, source, connection, provider file id) and delete the whole lineage; never by the document id a sync record holds"

key-files:
  created:
    - tests/rag/ingest/write-path-nango.test.ts
  modified:
    - src/lib/nango/document-adapter.ts
    - src/lib/nango/sync-manager.ts

key-decisions:
  - "The owner is read only from the nango_connections row of the synced connection_id (UNIQUE). A missing row, a lookup error, an empty user_id, or (unified) an owner that cannot be a tenant stops syncDocumentsForConnection before anything is fetched, ingested or deleted. syncDocumentsForConnection keeps its (connectionId, provider) signature, so no caller can pass an owner"
  - "Unified orphan deletes locate a file's lineage by (tenant_key, source nango, source_connection_id, source_key or source_file_id = the provider file id) and delete every version of those lineages with the same tenant_key and source filters. They never use nango_sync_records.document_id, because ingest's file-hash dedup is tenant-wide and can hand back another lineage's current document as duplicateOf"
  - "A failed lineage delete keeps the sync record so the next sync retries; the legacy delete still removes the record even when the document delete failed"
  - "ingest status processing (deadline reached, parse job pending) is thrown as NangoIngestError, so the sync record ends failed with the reason and last_synced_at is not advanced; the next sync of the same bytes resumes the stored run. quarantined is recorded under its document id and logged, because the file is stored but not searchable"
  - "The filename given to ingest carries the extension of the stored bytes (Google Docs, Sheets and Slides are exported as PDF; Notion page text gets .txt) and the mime type of an exported Google file is application/pdf, because the parser chain selects by extension first and a Notion title with a dot would otherwise select no parser"
  - "Folder ids: Drive folder sync and multi-folder pass the folder id; Drive single files pass the parent Drive reports; Notion top-level mode passes the top-level page id for the page and its children; other providers pass the listed folder or 'root'; marker values (multi-folder-mode, top-level-mode) are never passed"
  - "The pipeline switch lives in document-adapter.ts (nangoPipeline) instead of a new file, to stay inside the plan's file list"

patterns-established:
  - "Two-owner connector test: real ingest() over PGlite with the Nango tables in memory, asserting the other tenant's documents, chunks and sync records are byte-identical after a sync and an orphan delete"

requirements-completed: [DATA-01, DATA-10]

coverage:
  - id: D1
    description: "Under legacy, processDocumentWithMetadata and the sync-manager call sites behave as before: processDocument gets today's metadata, ingest is never called, the orphan delete keeps its id, user_id and source filters and writes no tenant or lineage filter"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-nango.test.ts#nango document adapter, legacy pipeline"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/write-path-nango.test.ts#nango sync manager, legacy pipeline"
        status: pass
    human_judgment: false
  - id: D2
    description: "Under unified, a synced file is ingested through ingest() in the connection owner's scope with the provider file id as identity; an unchanged file is skipped, a changed one becomes a new version, and nango_sync_records.document_id names the current version"
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "tests/rag/ingest/write-path-nango.test.ts#nango sync against two owners with real ingest"
        status: pass
    human_judgment: false
  - id: D3
    description: "A sync of one owner's connection never writes to, deletes from or changes the other owner's documents, chunks or sync records, even with the same provider file id; every ingest call carries the connection owner's scope; forged or corrupt rows claiming the connection in another tenant survive"
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "tests/rag/ingest/write-path-nango.test.ts#a sync of $syncing writes and deletes only in its owner tenant"
        status: pass
      - kind: integration
        ref: "tests/rag/ingest/write-path-nango.test.ts#an orphan delete removes every version of the file lineage"
        status: pass
    human_judgment: false
  - id: D4
    description: "Owner source of truth: a missing connection row, a lookup error and an owner that cannot be a tenant fail the sync with nothing fetched, ingested or written; the webhook refuses missing, wrong, short and secretless signatures and passes only connection id and provider to the sync"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-nango.test.ts#nango sync manager, owner and failure handling"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/write-path-nango.test.ts#nango webhook"
        status: pass
    human_judgment: false
  - id: D5
    description: "A Nango folder default and a connection default from rag_doc_type_defaults type the synced file (source_default, folder before connection); another tenant's defaults do not apply"
    requirement: DATA-10
    verification:
      - kind: integration
        ref: "tests/rag/ingest/write-path-nango.test.ts#a folder default and a connection default from rag_doc_type_defaults type the synced file in the D-15 order"
        status: pass
    human_judgment: false
  - id: D6
    description: "A real Nango sync against Google Drive or Notion with live credentials"
    requirement: DATA-01
    verification: []
    human_judgment: true
    rationale: "No Nango account or provider credentials in this environment; the plan assigns the live check to 03-48"

duration: 28min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 33: Nango Sync Behind ingest() Summary

**Nango syncs go through ingest() under the unified pipeline, scoped to the owner on the unique connection row, versioned by provider file id, typed by folder and connection defaults, and cleaned up per lineage inside that owner's tenant only**

## Performance

- **Duration:** about 28 min (the full vitest run took 6 of them)
- **Completed:** 2026-11-24
- **Tasks:** 2
- **Files modified:** 3 (2 source, 1 test)

## Accomplishments

- One adapter seam (`processDocumentWithMetadata`) now has a unified branch. The scope comes from `nangoOwnerScope(options.userId)`, where `userId` is the owner the sync manager read from the connection row; a refused owner, a failed ingest and an unfinished ingest surface as `NangoIngestError`. The legacy body is untouched.
- `syncDocumentsForConnection` reads the owner once, from the single `nango_connections` row of the connection (UNIQUE since the security fix), and stops before any network or database write when the row is missing, the lookup errors, or (unified) the owner cannot be a tenant.
- All five call sites pass `nangoConnectionId`, the folder id where the sync knows it, and the file type. Native Google files are typed as the PDF they are exported as; extensionless or dotted Notion titles get the extension of the stored text, so a parser is chosen.
- Unified orphan delete removes every version of a file's lineage (chunks first, then documents) inside the owner's tenant, found by identity, and keeps the sync record when a delete fails so the next sync retries.
- A two-owner suite over real ingest, real documents, chunks and lineages (PGlite) proves a sync of either connection never touches the other owner's rows, including a same-provider-file-id file and forged rows that claim the synced connection from another tenant.

## Task Commits

1. **Task 1: unified branch in the Nango document adapter** - `bbcd726` (test, RED), `eb2c5f7` (feat, GREEN)
2. **Task 2: sync manager folder ids, current version ids and lineage deletes** - `4a99901` (test, RED), `a9ccbf5` (feat, GREEN)

**Plan metadata:** the docs commit that adds this file (not counted in `commits` above, which is measured from the ledger at write time).

## RED evidence

- `bbcd726`: 9 of 10 failed on assertions (`nangoPipeline` and `NangoIngestError` not exported by the legacy adapter, ingest never called); the legacy-metadata test passed, as it should, since legacy is unchanged.
- `4a99901`: 12 of 34 failed on assertions: all seven call-site wiring tests (folder id, connection id and file type missing from the options), the refused-owner test (sync resolved instead of rejecting), the two-owner orphan delete (legacy delete left the lineage's chunks and the other versions), the lineage-delete test, and the folder-default test (`nangoFolderId` never reached ingest). The legacy guards and the owner-failure guards that already held passed.
- Mutation checks after GREEN: removing every `tenant_key` filter from `deleteNangoLineages` fails the forged-row test; restored.

## Files Created/Modified

- `src/lib/nango/document-adapter.ts` - unified branch, `nangoPipeline`, `NangoIngestError`, file-type and extension handling
- `src/lib/nango/sync-manager.ts` - owner checks, `deleteNangoLineages`, unified branch of `deleteOrphanedDocuments`, folder ids, file types
- `tests/rag/ingest/write-path-nango.test.ts` - 34 tests: adapter (10), sync manager legacy (2), call sites (7), owner and failure handling (4), two owners with real ingest (8), webhook (3)

## Decisions Made

See `key-decisions`.

## Deviations from Plan

**1. [Rule 1 - Bug] Legacy generic-provider multi-folder path writes a status the table rejects**
- **Found during:** Task 2
- **Issue:** the multi-folder branch for providers other than Drive and Notion updates `nango_sync_records.status` to `'synced'`, which violates the CHECK (`pending, processing, completed, failed, disconnected`). The whole update fails silently, so `document_id` and `last_synced_at` are never recorded, which would break "the sync record names the current version".
- **Fix:** the unified pipeline writes `'completed'` there. The legacy pipeline keeps `'synced'`, because the plan requires legacy to behave as today. Logged in `03-33-deferred-items.md` for a decision on fixing legacy too.
- **Files modified:** src/lib/nango/sync-manager.ts
- **Commit:** a9ccbf5

**2. [Rule 2 - Missing critical] Orphan delete by identity instead of by the sync record's document id**
- **Found during:** Task 2
- **Issue:** the plan says to delete "the whole lineage". Following the sync record's `document_id` would be unsafe under unified: ingest's file-hash dedup is tenant-wide (`rag_begin_document_version` matches any current ready row of the tenant with the same hash), so a `skipped_duplicate` can return another lineage's document, and the adapter stores that id in the sync record. Deleting by it would remove an unrelated document of the same tenant.
- **Fix:** lineages are found by `(tenant_key, source nango, source_connection_id, source_key | source_file_id = file id)`; the test seeds a chat upload with the same name and a Nango row of the same tenant from another connection, and both survive.
- **Commit:** a9ccbf5

**3. [Rule 2 - Missing critical] Typed handling of an unfinished ingest and extension-aware file names**
- **Found during:** Task 1
- **Issue:** the plan names failed only. A `processing` result would otherwise be recorded as completed with a half-written document and skipped on every later sync. Google exports (PDF) and Notion text have no usable extension, so the parser chain (extension first) would pick none.
- **Fix:** `processing` throws `NangoIngestError` (record failed, retried and resumed next sync); file types and names as described in `key-decisions`.
- **Commit:** eb2c5f7

**Total deviations:** 3 (1 bug, 2 Rule 2). No file outside the plan's `files_modified` list was touched; `src/lib/rag/index.ts` was not edited (every export needed already existed).

## Issues Encountered

- `tests/rag/lexical-tokenize.test.ts` ("finishes under one second: Chinese text") took 1244 ms once in the full vitest run, which ran alongside other plans; it passes alone (18/18). Unrelated to this plan.
- The new test imports `eval/harness/*.mts` helpers (fixture embedder, two-tenant ids) like the other write-path tests; they ran fine here.
- Two harness traps in the new test, both fixed: `vi.resetModules()` makes a module-level `scopeKey` import a different instance than the one that minted the scope, and ingest reaches the database through the same `getSupabaseAdmin` the sync manager uses, so the hybrid test admin forwards `rpc` and `storage` to the fixture's real client.

## Known Stubs

None.

## Threat Flags

None new. T-03-95 and T-03-142 are covered by tests (two-owner isolation in both directions, owner only from the connection row, no owner parameter, forged rows, signature checks, no Bearer in the nango routes). T-03-96: synced files pass `scan_injection` inside ingest.

## User Setup Required

None - no new environment variable (nothing to mirror in the five config places).

## Next Phase Readiness

- 03-48 must run a live Nango sync (Drive or Notion) with `RAG_INGEST_PIPELINE=unified`.
- Observed, outside this plan: stored originals and artifacts of a deleted lineage stay in the object store (the documents DELETE route behaves the same); `fetchGoogleDriveFiles` lists one page of at most `NANGO_MAX_FILES_PER_SYNC` files ordered by modification time, so in a folder larger than that, a previously synced file that falls off the first page can look orphaned and be deleted (pre-existing logic, read from the code and not exercised; see `03-33-deferred-items.md`).

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | retrospective / plan predates gate | n/a |
| Impeccable | retrospective | n/a |
| web-design-guidelines | retrospective (no re-audit this pass) | pass (all findings resolved) |

## Self-Check: PASSED

Created and modified files exist on disk; commits `bbcd726`, `eb2c5f7`, `4a99901` and `a9ccbf5` are ancestors of HEAD; the measured count from the ledger is 4. Gates: `tsc --noEmit` 0 errors, `typecheck:new` clean, vitest 2105/2106 (the one failure is the load-dependent timing test above, 18/18 alone), `node --test tests/*.test.mts` 145/145, boundary ok, check-workflows ok, check-config ok. The nango security-fix suites pass unchanged (29 tests); the plan's two acceptance counts (`lineage_id` 5 in sync-manager.ts, `Bearer` 0 in the nango routes) hold.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
