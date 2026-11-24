---
phase: 03-unified-ingestion-embedding-profiles
plan: 16
subsystem: ingestion
tags: [dedup, versioning, content-hash, backfill, tenant-isolation, pglite]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "ingest() tracer, stage runner, writer.ts and the 0310 writer RPCs (03-13, 03-13b); hash.ts normaliser (03-06)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "runRetrieval, TenantScope, two-tenant PGlite fixture and fake edge"
provides:
  - "DB-backed proof that dedup holds inside one tenant and never crosses tenants (DATA-06)"
  - "DB-backed proof of the version swap, current-only retrieval, old citations and atomic failure (DATA-07)"
  - "backfillContentHashes and `npm run rag:backfill-hashes -- [--tenant <key>] [--dry-run] [--batch-size <n>]` so legacy documents take part in content dedup"
  - "createContentHashBackfillWriter in writer.ts: the narrow operator write path that can set only content_hash and metadata.content_hash_version"
affects: [03-30, 03-31, 03-33, 03-39, 03-47]

tech-stack:
  added: []
  patterns:
    - "Operator jobs write under the tenant key stored on each row, through writer.ts; rag_set_document_fields refuses a row that is not in that tenant"
    - "Reader seam (ListLegacyDocuments) so the PGlite tests can page without widening the shared fake edge"

key-files:
  created:
    - src/lib/rag/ingest/backfill-hashes.ts
    - tests/rag-db/ingest-dedup-two-tenant.test.mts
    - tests/rag-db/ingest-versioning.test.mts
    - tests/rag-db/backfill-hashes.test.mts
  modified:
    - src/lib/rag/ingest/writer.ts
    - package.json

key-decisions:
  - "Hashes of legacy documents are filled only by the TypeScript backfill, never in SQL; file_sha256 stays NULL for legacy rows because their original bytes were never stored. A legacy document therefore deduplicates by normalised text only, and a re-upload of its exact original bytes is caught by content_hash_dedup, not by file_hash_dedup"
  - "The backfill reads only ready rows with content_hash NULL and skips blank text (counted as skippedEmpty), so empty documents never become duplicates of each other"
  - "Each row is written under the tenant key the row carries; a malformed key is refused in the writer and a key that is not the row's tenant is refused by the SQL function"
  - "dedup.ts needed no change: every case in the plan already held on the code 03-13 shipped"

patterns-established:
  - "Mutation check for proof-only tests: disabling the content-hash lookup in dedup.ts makes three of the dedup tests fail on assertions, then the file is restored"

requirements-completed: [DATA-06, DATA-07]

actuals:
  tokens: 13000
  tasks: 3
  commits: 4

plan_head_before: 63a758b1dad8537a16d286c4c17692ff5a2d3931
plan_head_after: 5fe522292ff98c4e3247fe52e3c602c335b14071

coverage:
  - id: D1
    description: "Same bytes, or different bytes with the same normalised text, in one tenant return skipped_duplicate with the existing document id and add no chunks; a discarded content duplicate is a deleted row with metadata.duplicate_of"
    requirement: DATA-06
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-dedup-two-tenant.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "The same content in the other tenant of the two-tenant fixture is ingested with its own document and chunks; neither tenant retrieves the other copy; a content-hash check never matches another tenant"
    requirement: DATA-06
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-dedup-two-tenant.test.mts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Two concurrent ingest() calls of one identity and bytes leave one version row and one contiguous chunk set"
    requirement: DATA-06
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-dedup-two-tenant.test.mts#two concurrent ingests of the same identity and bytes produce one version and one set of chunks"
        status: pass
    human_judgment: false
  - id: D4
    description: "New text for an identity becomes version 2 of the same lineage with v1 superseded_by v2; retrieval returns only v2 chunks, also when a superseded chunk still has an exact vector"
    requirement: DATA-07
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-versioning.test.mts"
        status: pass
    human_judgment: false
  - id: D5
    description: "A v1 chunk id and its document name still load by id after v2 is published (a stored citation resolves); a failure injected while promoting v3 leaves v2 current and retrievable"
    requirement: DATA-07
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-versioning.test.mts"
        status: pass
    human_judgment: false
  - id: D6
    description: "npm run rag:backfill-hashes fills content_hash and metadata.content_hash_version for legacy rows with the one normaliser, per tenant, with dry-run and tenant filter, and an exact re-upload of legacy text then deduplicates in its own tenant only"
    requirement: DATA-06
    verification:
      - kind: integration
        ref: "tests/rag-db/backfill-hashes.test.mts"
        status: pass
    human_judgment: false
  - id: D7
    description: "The CLI works against a real Supabase project (service-role read of documents, PostgREST filter syntax, large tables)"
    verification: []
    human_judgment: true
    rationale: "No live Supabase is available here; the reader is checked against a recording query builder and the write path against PGlite, not against PostgREST"

duration: not measured
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 16: Dedup and Versioning Semantics Summary

**The D-09, D-10 and D-11 semantics now have PGlite proof through the real ingest() on the two-tenant fixture, and `npm run rag:backfill-hashes` lets legacy documents join content dedup using the one TypeScript normaliser**

## Performance

- **Duration:** not measured (the start time was not recorded)
- **Completed:** 2026-11-24
- **Tasks:** 3 (Task 3 as a RED and GREEN pair; four commits)
- **Files:** 4 created, 2 modified, 975 insertions, 7 deletions

## Accomplishments
- Dedup is proved inside one tenant and across two: a new source key with the same bytes, a CRLF and doubled-space variant, and the same identity with the same bytes all skip as duplicates of the existing document and add no chunks. The discarded content duplicate is a `deleted` row carrying `metadata.duplicate_of`. The same text for the other tenant ingests normally, neither tenant's retrieval returns the other's copy, and a content-hash lookup never matches another tenant.
- Two concurrent `ingest()` calls for one identity and bytes were observed to begin before either published, and ended in one version row and one contiguous chunk set.
- Version swap is proved: version 2 shares the lineage, v1 points at it through `superseded_by`, retrieval returns only v2 chunks (also when a v1 chunk is given an exact-match vector by hand, which shows the current-only filter itself and not only the NULLed embedding), and a v1 chunk id and its document name still load by id through the same read the citation path uses. A trigger that raises while v3 is promoted leaves v2 current and retrievable and v3 `failed`.
- `backfillContentHashes` and the npm script fill `content_hash` and `metadata.content_hash_version` for ready legacy rows with no hash. Dry run writes nothing; `--tenant` limits the run; rows that already have a hash are never read; blank text gets no hash; a re-upload of a legacy document's exact text is then a duplicate of it in the same tenant and not in the other.

## Task Commits

1. **Task 1: Two-tenant dedup through ingest()** - `661f7c0` (test). No GREEN commit: all seven cases passed on the code 03-13 shipped, so dedup.ts is unchanged.
2. **Task 2: Version swap, current-only retrieval and old citations** - `79d5857` (test). No GREEN commit for the same reason.
3. **Task 3: Legacy content-hash backfill (TDD)**
   - RED: `790de9f` (test)
   - GREEN: `5fe5222` (feat)

**Plan metadata:** committed after this file (docs: complete plan)

## Files Created/Modified
- `tests/rag-db/ingest-dedup-two-tenant.test.mts` - 7 DB-backed cases for D-09 and D-10
- `tests/rag-db/ingest-versioning.test.mts` - 5 DB-backed cases for D-11
- `tests/rag-db/backfill-hashes.test.mts` - 9 cases for the backfill, its writer guard, option parsing and reader query shape
- `src/lib/rag/ingest/backfill-hashes.ts` - `backfillContentHashes`, `createSupabaseLister`, `parseBackfillArgs`, `main` (guarded CLI entry)
- `src/lib/rag/ingest/writer.ts` - `createContentHashBackfillWriter`, `isTenantKey`; the RPC call helper lifted out of `createIngestWriter` with no behaviour change
- `package.json` - `rag:backfill-hashes` script

## Decisions Made
See `key-decisions`. The one that later plans rely on: `writer.ts` stays the only file naming the writer RPCs, so the backfill reaches `rag_set_document_fields` through it and not directly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] writer.ts edited although it is not in the plan's file list**
- **Found during:** Task 3
- **Issue:** `IngestWriter` takes the tenant key from a minted `TenantScope`. The backfill has no request scope and walks the rows of every tenant, and `mintScope` is forbidden outside `src/lib/rag/tenant/` by the boundary check. Naming `rag_set_document_fields` inside backfill-hashes.ts would also have ended the rule that writer.ts is the only file naming the writer RPCs.
- **Fix:** Added `createContentHashBackfillWriter` to writer.ts. It can set `content_hash` and `metadata.content_hash_version` only, validates the tenant key shape, and writes under the key stored on the row; the SQL function still refuses a row that is not in that tenant. The existing RPC wrapper was lifted into a module-level `callRpc` with no change in behaviour.
- **Verification:** the 03-13 tracer and 03-13b resume tests pass unchanged; boundary check ok; a test proves a cross-tenant key is refused (`tenant_mismatch`) and a malformed key is refused before any RPC.
- **Committed in:** `5fe5222`

**2. [Rule 3 - Blocking] Reader seam instead of widening the shared fake edge**
- **Found during:** Task 3
- **Issue:** The plan says to page "via a read RPC or the admin client". The fake edge (eval/harness/fake-edge.mts, shared by other plans) allows no `content_hash`, `tenant_key` or `status` filter and no `gt` on `documents`, and a read RPC would need a new migration with setup-file and schema-equality changes.
- **Fix:** The production reader is `createSupabaseLister` on the admin client. `BackfillInput.list` is a seam; the PGlite tests pass a lister that runs the same predicate in SQL, and a separate test pins the exact PostgREST call chain (`is content_hash null`, `eq status ready`, `eq tenant_key`, `gt id`, `order id`, `limit`) with a recording builder. The writes in the tests still go through the real admin client, the fake edge and the real SQL function.
- **Verification:** `tests/rag-db/backfill-hashes.test.mts` 9 of 9.
- **Committed in:** `790de9f`, `5fe5222`

**3. [Plan interpretation] Tasks 1 and 2 are proof-only and have no RED**
- The plan says to write the tests first and adjust code only where a case fails. None failed, so there is no GREEN commit and no RED evidence for them; the dedup and versioning behaviour was already correct in 03-13 and the 0310 SQL. See TDD Gate Compliance.

**4. [Rule 2 - Missing Critical] Test additions beyond the plan's behaviour lists**
- Extra cases that serve the threat register: the content-hash check never matching across tenants (T-03-47), the same identity with different bytes and the same normalised text (D-10), the current-only filter with a vector restored on a superseded chunk (D-08 inside D-11), the backfill writer's tenant guard (T-03-47, T-03-49), blank content never hashed, and the CLI option parser.

---

**Total deviations:** 4 (2 blocking, 1 plan interpretation, 1 missing-critical test additions)
**Impact on plan:** No production behaviour changes outside the backfill; no new SQL, no migration, no package.

## TDD Gate Compliance

- **Tasks 1 and 2:** no `test` then `feat` pair, because the tests passed on first run against unchanged code (unexpected green, which for a proof-only task means the behaviour already existed). To show the tests are not vacuous, I disabled the content-hash lookup in `dedup.ts` and re-ran Task 1: tests 2, 4 and 5 failed on assertions, the other four passed, and the file was restored with `git checkout` (no diff remains). The trigger test in Task 2 fails visibly only if the swap is not atomic; I did not mutate the SQL function.
- **Task 3 RED (`790de9f`):** all 8 tests failed on assertions (for example `content_hash` still NULL, `expected 'skipped_duplicate'` but got `'ready'`, `error: 'not implemented'` from the parser stub). The commit carries inert stubs of `backfill-hashes.ts` so the tests load, as in 03-13b. `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK` (reason `target_test_failed`) on the node:test TAP report of that run; semantic assessment: the target test ran and failed on the planned assertion and the other seven failed the same way for the same reason, none on an import, syntax or fixture fault.
- **Task 3 GREEN (`5fe5222`):** 9 of 9 pass (one extra case, the writer guard, was added with the implementation).
- Two of my first GREEN runs failed on test mistakes, not on implementation: the fixture also carries 13 corpus documents of another tenant (totals now count them), and a reset between tests missed rows. Both were fixed in the test file before the GREEN commit.

## Issues Encountered
- The two-tenant fixture contains 13 corpus documents with no hash, owned by a third tenant, so an unfiltered backfill hashes them too. The tests count them instead of assuming three rows.

## Gate Results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 124 files, 1602 tests passed |
| `node --import tsx --test tests/*.test.mts` | 143 passed, 0 failed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 181 tests: 178 passed, 0 failed, 3 skipped (single-tenant variants skipped by design in earlier plans) |
| `node --import tsx --test tests/rag-db/ingest-dedup-two-tenant.test.mts` | 7 passed (criterion: at least 5) |
| `node --import tsx --test tests/rag-db/ingest-versioning.test.mts` | 5 passed (criterion: at least 4) |
| `node --import tsx --test tests/rag-db/backfill-hashes.test.mts` | 9 passed (criterion: at least 4) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 690 files, no violations |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest | not run, sidecar untouched |
| `tests/rag/langfuse-pins.test.ts` | passed here (inside vitest), no ENOENT |

Acceptance greps: `grep -c "rag:backfill-hashes" package.json` = 1 (HEAD 0, EXPECT 1). The writer RPC names still appear only in `src/lib/rag/ingest/writer.ts`. No model identifiers, secrets or real identifiers were added; the CLI prints counts per tenant key and never document text.

## Threat Surface
T-03-47 (cross-tenant dedup): two-tenant tests show B's identical upload is ingested normally and never linked to A, the content-hash lookup never matches another tenant, and the backfill writer is refused for a tenant key that is not the row's. T-03-48 (concurrent versions): the concurrency test shows one version and one chunk set. T-03-49 (backfill overwriting): only ready rows with a NULL hash are read, dry run writes nothing, the tenant filter works, and a pre-existing hash is untouched in the test. Residual: a hash set between the read and the write of one row would be overwritten with the same-rule hash of the same stored text, so the value would be identical. T-03-SC: no package changes.

## Known Stubs

None. `src/lib/rag/ingest/backfill-hashes.ts` has no placeholder branches.

## User Setup Required

None - no external service configuration, environment variable, migration or package change.

## Operator Actions
- Run once per deployment after the 0301..0312 migrations are applied and before relying on dedup of legacy text: `npm run rag:backfill-hashes -- --dry-run`, check the per-tenant counts, then `npm run rag:backfill-hashes`. It needs the usual `.env.local` (the shared env loader also demands `OPENAI_API_KEY`, although nothing is embedded) and `SUPABASE_SERVICE_ROLE_KEY`. Use `--tenant <key>` to go tenant by tenant and `--batch-size` (1 to 1000, default 200) for large tables. A non-zero exit means at least one row failed; rerun, because rows that already have a hash are skipped.
- Live check for the ROADMAP list: run the dry run against the real project once, to confirm the PostgREST filters (`content_hash is null`, `status eq ready`, `id gt`) and that `tenant_key` is readable through the API on both schemas.
- Known limit, documented and not hidden: legacy `documents.content` is the joined LlamaParse v1 chunk text, so a re-parse of the same file with another parser may normalise differently and not match. `file_sha256` stays NULL for legacy rows.

## Next Phase Readiness
- 03-30 (version readers), 03-39 (type change as a new version) and 03-47 (final gates) can rely on the proven swap and dedup behaviour.
- No blockers. No new packages were installed or locked.

## Self-Check: PASSED

All four created files exist on disk. Commits `661f7c0`, `79d5857`, `790de9f` and `5fe5222` are ancestors of HEAD; the measured count from the ledger is 4.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
