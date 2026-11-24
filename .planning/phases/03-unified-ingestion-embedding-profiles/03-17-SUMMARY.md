---
phase: 03-unified-ingestion-embedding-profiles
plan: 17
subsystem: ingestion
tags: [ingest, object-store, supabase-storage, resume, rehydrate, tenant-scope]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "ingest tracer, stage runner and writer RPCs (03-13); deadline, resume and the IngestDeps.rehydrate seam (03-13b)"
provides:
  - "Private bucket rag-originals (public false, 20 MB, no storage.objects policy) and rag_get_ingest_origin, in migration 0311"
  - "ObjectStore with a Supabase implementation on the admin client, getObjectStore/setObjectStoreForTests/resetObjectStoreForTests, OBJECT_KEY_PATTERN, assertObjectKey"
  - "artifacts.ts: versionPrefix, originalName/originalKey, saveArtifact, loadArtifact, removeArtifacts, PARSE_ARTIFACT, DOCLING_ARTIFACT"
  - "store_original stage and parse.md persistence for every unified version"
  - "rehydrateFromStore: resumeIngest continues a processing document from storage with no caller bytes"
affects: [03-18, 03-19, 03-20, 03-27, 03-29, 03-32, 03-38]

tech-stack:
  added: []
  patterns:
    - "Object keys are <tenant_key>/<lineage_id>/<version>/<fixed ASCII basename>; a filename never enters a key"
    - "Only object-store.ts names the bucket (a test scans src for it)"
    - "Per-module test seam for the store, like deps.ts: set/reset, never a global flag"

key-files:
  created:
    - supabase/migrations/0311_rag_originals_bucket.sql
    - src/lib/rag/ingest/object-store.ts
    - src/lib/rag/ingest/artifacts.ts
    - tests/helpers/fake-object-store.ts
    - tests/rag/ingest/object-store.test.ts
    - tests/rag-db/ingest-originals.test.mts
  modified:
    - src/lib/rag/ingest/runner.ts
    - src/lib/rag/ingest/status.ts
    - src/lib/rag/ingest/writer.ts
    - src/lib/rag/ingest/types.ts
    - src/lib/rag/ingest/deps.ts
    - src/lib/rag/ingest/stages/store-original.ts
    - src/lib/rag/ingest/stages/parse.ts
    - src/lib/rag/ingest/stages/dedup.ts
    - tests/helpers/ingest-fakes.ts
    - tests/rag/ingest/runner.test.ts
    - tests/rag/ingest/ingest-trace.test.ts
    - tests/rag-db/ingest-tracer.test.mts
    - tests/rag-db/ingest-resume.test.mts

key-decisions:
  - "The origin of a version (lineage_id, original_path, source, source_key) comes from a NEW function rag_get_ingest_origin, not from a widened rag_get_ingest_document: changing that function's result columns makes migration 0310 fail when the whole chain is applied a second time (cannot change return type), and the migration test requires the chain to be re-appliable. Same tenant check; a two-tenant test pins it."
  - "A failure to store parse.md fails the run (store_parse_output_failed) instead of warning, because a type change and a resume start from it and a storage outage hits both objects alike"
  - "A content-hash duplicate removes the objects it stored and clears original_path, so a skipped duplicate leaves nothing behind"
  - "rehydrate returns true, false or { failed }: false keeps the run processing (resume_input_unavailable), { failed } marks the version failed (original_unavailable)"
  - "The resumed context carries an empty file instead of text '' so the parse stage can run again from the stored bytes"
  - "chunk, enrich and extract each run again in rehydrate when they had finished (extract added at the coordinator's request, so 03-18's in-memory per-chunk metadata is rebuilt); extract.ts is untouched"

patterns-established:
  - "saveArtifact records the key in state.artifacts, so processing_state names what the store holds"
  - "original_path is only trusted when it lies under the version prefix built from the minted scope; anything else is original_unavailable and is never read"

requirements-completed: [DATA-01, DATA-10]

actuals:
  tokens: 48000
  tasks: 3
  commits: 6

plan_head_before: 63a758b1dad8537a16d286c4c17692ff5a2d3931
plan_head_after: 532061a6792a7d29bbe09143a95c0309d7b97a2e

coverage:
  - id: D1
    description: "A private rag-originals bucket (public false, 20 MB, no storage.objects policy naming it or covering every bucket) exists in both deployment modes, and re-applying the migration resets a public or resized bucket"
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-originals.test.mts#rag-originals bucket migration"
        status: pass
    human_judgment: false
  - id: D2
    description: "Object keys come only from tenant key, UUIDs, version and a fixed basename; zh and accented filenames never enter a key; every key passes the Supabase pattern and has no dot segment; the in-memory store refuses what Supabase refuses"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/object-store.test.ts#object keys"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-originals.test.mts#bytes named 合同.txt are stored as original.txt"
        status: pass
    human_judgment: false
  - id: D3
    description: "Each version's original and parse.md are stored under its prefix and documents.original_path records the key; a storage failure fails the run (store_original_failed, store_parse_output_failed) with no chunks written; a skipped duplicate stores nothing"
    requirement: DATA-10
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-originals.test.mts#ingest stores the original and the parse output"
        status: pass
    human_judgment: false
  - id: D4
    description: "resumeIngest rebuilds from the stored parse output or the stored original with no upload, re-runs chunk, enrich and extract, and ends with chunk ids, content and metadata equal to an uninterrupted run and no duplicate chunks, including after a process death in the middle of the embed batches"
    requirement: DATA-10
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-originals.test.mts#resume rebuilds its inputs from them"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/runner.test.ts#resume from the object store"
        status: pass
    human_judgment: false
  - id: D5
    description: "Only the service-role client reaches the bucket; another tenant can neither resume a document nor have its objects read through a tampered original_path"
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-originals.test.mts#another tenant cannot resume the document"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/object-store.test.ts#only object-store.ts names the bucket"
        status: pass
    human_judgment: false

duration: not measured
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 17: Private Original and Parse-Output Store Summary

**Each unified version keeps its original and parse.md in a private, tenant-prefixed bucket reachable only through the service key, and resumeIngest rebuilds a processing document from them with no caller bytes and the same chunks as an uninterrupted run**

## Accomplishments
- Migration 0311 inserts the `rag-originals` bucket (private, 20 MB, no `storage.objects` policy) and adds `rag_get_ingest_origin`, executable by service_role only.
- `ObjectStore` over the admin client (upsert for idempotent retries, key guard, 20 MB cap, error carrying operation and status only, abort ends the wait because the storage client takes no signal). An in-memory fake applies the Supabase key pattern.
- `artifacts.ts` builds keys only from tenant key, UUID lineage, version and a fixed basename (`original.<ext>`, `parse.md`, `docling.json`); an extension outside `[a-z0-9]{1,8}` becomes `bin`.
- `store_original` saves the original and sets `original_path`; `parse` saves `parse.md`; a content-hash duplicate removes what it stored.
- `rehydrateFromStore` (default for `resumeIngest`): parse.md, else re-parse of the stored original, else `original_unavailable`; then chunk, enrich and extract again for each that had finished.

## Task Commits
1. **Task 1: bucket, ObjectStore, key rules** - RED `825b040`, GREEN `8017519`
2. **Task 2: store_original and parse output** - RED `b1ea9b1`, GREEN `44f89c3`
3. **Task 3: resume rehydration** - RED `24b7b84`, GREEN `532061a`

## Deviations from Plan

**1. [Rule 3 - Blocking] rag_get_ingest_origin instead of widening rag_get_ingest_document**
- **Found during:** Task 1 (migration test "applying all migrations a second time")
- **Issue:** The hand-off allowed extending `rag_get_ingest_document` in a new migration. Dropping and recreating it with more columns makes the unmodified 0310 fail on a second application (`cannot change return type of existing function`), and that re-application is a tested invariant. Editing 0310 is not allowed.
- **Fix:** A new function `rag_get_ingest_origin(uuid, text)` in 0311 with the same tenant check and the same grants; `IngestWriter.getOrigin` calls it. `rag_get_ingest_document` is unchanged. Resume now makes one more RPC.
- **Committed in:** `8017519`

**2. [Rule 2 - Missing Critical] Content-duplicate cleanup**
- `content_hash_dedup` runs after store_original and parse, so a content duplicate would have left a private original behind. It now removes the objects and clears `original_path` (`dedup.ts`, outside the plan's file list).

**3. [Rule 3 - Blocking] Edits outside the plan's file list**
- `types.ts` (`IngestDocumentRef.lineageId`, `originalPath`, `RehydrateResult`), `writer.ts` (`getOrigin`), `status.ts` (origin lookup, file instead of text in the resumed input, `{ failed }` handling), `deps.ts` (rehydrate type), and existing ingest tests (they install the in-memory store; the 03-13b tests that asserted `no_object_store` or an unresolvable resume now assert the new behaviour). `schema-migrations.test.mts` was not touched.

**4. [Coordinator request] extract re-run in rehydrate**
- A resumed run runs `extract` again when it had already finished, so per-chunk metadata that exists only in memory (03-18) is rebuilt. Done in `runner.ts`; `extract.ts` untouched. The metadata-equality test compares a resumed and an uninterrupted run (URL keys today; it will cover 03-18's temporal and financial keys once those are merged, since the test text carries dates).

**5. Task 1 commit state:** the Task 1 GREEN commit (`8017519`) left one 03-13b unit test failing (resume call list gained `rag_get_ingest_origin`); it is fixed in `44f89c3`.

## TDD Gate Compliance
Each task has a `test(03-17)` commit followed by a `feat(03-17)` commit. RED commits carry inert stubs (`object-store.ts`, `artifacts.ts`, a placeholder `0311`) so the tests load; the failures were assertions: Task 1 12 of 16 unit tests plus 5 DB tests (for example `expected '' to be 'o:3f2b...'`, `expected Set{} to deeply equal Set{ 'rag-originals' }`); Task 2 6 DB tests (`expected 'failed'`, `actual 'ready'`; `expected 4 actual 0`); Task 3 6 DB tests and 4 unit tests (`expected 'processing' to be 'ready'`). `gsd_run check tdd-red-evidence` was not run: it returned INVALID_RED for vitest and node TAP output in plan 03-13b and `workflow.tdd_mode` is off. One Task 3 DB test (stop before store_original stays processing) passed at RED by design, as a regression guard.

## Gate Results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 125 files, 1623 tests passed |
| `node --import tsx --test tests/*.test.mts` | 143 passed, 0 failed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 181 tests: 178 passed, 0 failed, 3 skipped (single-tenant variants skipped by design) |
| `tests/rag-db/ingest-originals.test.mts` | 21 passed (criteria: at least 4) |
| `tests/rag/ingest/object-store.test.ts` | 16 passed (criteria: at least 6) |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 691 files |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest, eval pytest | not run, untouched |

Acceptance greps: `rag-originals` in 0311 2 (EXPECT >=1); `create policy` in 0311 0 (EXPECT 0); `saveArtifact` in store-original.ts 2 (EXPECT >=1); `loadArtifact` in runner.ts 3 (EXPECT >=1).

## Threat Surface
T-03-50: private bucket, no policy (a test rejects any policy naming it or covering every bucket), service key only, only object-store.ts names the bucket. T-03-51: keys from scope-derived tenant key, UUIDs, version and a fixed basename; `assertObjectKey` and the fake refuse non-ASCII, dot and empty segments; an `original_path` outside the prefix is never read. T-03-52: 20 MB bucket limit plus a pre-check in `put`. No packages added.

## Known Stubs
None. `docling.json` is a named constant only; plan 03-27 stores it.

## Hand-offs
- 03-27/03-29: store `docling.json` with `saveArtifact(ctx, DOCLING_ARTIFACT, ...)`; a parser stage that re-runs from the original is reached through `parseStage` in rehydrate.
- 03-32/03-38: the `images` stage output is not rebuilt by rehydrate (non-deterministic); keep it in `processing_state.images`.
- Type-change plan: `loadArtifact(ctx, PARSE_ARTIFACT)` is the parse-output read.

## Self-Check: PASSED
Created files exist on disk; commits `825b040`, `8017519`, `b1ea9b1`, `44f89c3`, `24b7b84`, `532061a` are ancestors of HEAD; the ledger count is 6.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
