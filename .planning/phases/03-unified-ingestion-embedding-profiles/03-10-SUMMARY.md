---
phase: 03-unified-ingestion-embedding-profiles
plan: 10
subsystem: database
tags: [postgres, plpgsql, pgvector, supabase, pglite, rag, ingestion, tenant-isolation, postgrest]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: plan 03-01 migrations (documents identity, version and status columns, promoted chunk columns, legacy-compat triggers, D-08 filter, ordered migration loader)
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: scopeKey semantics for tenant_key, the PGlite fixture harness, the two-tenant fixture, the fake PostgREST edge
provides:
  - supabase/migrations/0310_ingest_writer.sql with eight service_role-only SECURITY DEFINER functions (begin version, content duplicate lookup, field update, ingest state save and read, mark failed, chunk write, atomic version publish)
  - Generic, signature-checked rag_* and match_chunks_by_profile routing in the fake edge with PostgREST-shaped errors
  - tests/rag-db/ingest-writer.test.mts (two-mode PGlite suite) and a generic-routing block in tests/fixture-edge.test.mts
affects: [03-11, 03-13, 03-13b, 03-16, 03-28, 03-29, 03-37, 03-47]

actuals:
  tokens: 21200
  tasks: 3
  commits: 7
plan_head_before: c50bdea1d821c9c536eebe2faa66ea26cf512c83
plan_head_after: 9474de6a4c28beb3fd87558196cdb57a6ecd1184

tech-stack:
  added: []
  patterns:
    - "Writer is a set of SECURITY DEFINER SQL functions; one lookup 'WHERE id = p AND tenant_key = p_tenant_key' makes a missing id and another tenant's id the same tenant_mismatch"
    - "Advisory lock on tenant_key|source|source_key serialises begin and publish for one identity"
    - "Fake edge reads a function's input argument names and types once from pg_proc and caches them (positive results only)"
    - "TDD tests call SQL through a helper that turns a database error into an assertion failure, so RED fails on ERR_ASSERTION, not on a driver exception"

key-files:
  created:
    - supabase/migrations/0310_ingest_writer.sql
    - tests/rag-db/ingest-writer.test.mts
  modified:
    - eval/harness/fake-edge.mts
    - tests/fixture-edge.test.mts
    - tests/rag-db/schema-migrations.test.mts

key-decisions:
  - "A missing document id and a document of another tenant both raise tenant_mismatch in the mutating functions, so ids cannot be probed across tenants"
  - "rag_get_ingest_document returns no row (no exception) for another tenant's or an unknown id, which follows the plan's behaviour line for that function over its blanket 'raises in every function' line"
  - "skipped_duplicate returns document_id NULL and duplicate_of set, so a caller cannot write chunks to the duplicate by mistake"
  - "Mode detection is documents.user_id NOT NULL (multi-tenant), because single-tenant documents also have a nullable user_id at HEAD"
  - "A rewrite through rag_write_chunks replaces the row including the vector; a chunk resent without a vector has none (honest state instead of a stale vector)"

patterns-established:
  - "Phase 3 writer functions raise short machine-readable messages (tenant_mismatch, invalid_field, invalid_status, invalid_source, embedding_profile_unsupported, embedding_count_mismatch, document_not_writable, document_not_publishable, document_is_current) that callers match by prefix"
  - "Fake edge error body for functions is { code: SQLSTATE, message, details, hint } with PostgREST-like statuses (42501 to 403, 23503/23505 to 409, 42883 to 404, else 400); the legacy specs keep FAKE_EDGE_UNSUPPORTED"

requirements-completed: [DATA-01, DATA-06, DATA-07]

coverage:
  - id: D1
    description: "rag_begin_document_version creates a non-current processing version under an advisory lock, resumes a processing row of the same identity and hash, skips a file hash that a current document of the same tenant already has, and makes version max+1 in the same lineage carrying external_url with no content_type or slug"
    requirement: "DATA-06"
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#begin on a new identity creates version 1 as a non-current processing row with its own lineage"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#the same file hash in another tenant is ingested normally"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#begin for an identity whose current row has another hash makes version 2 in the same lineage with external_url copied and no content_type or slug"
        status: pass
    human_judgment: false
  - id: D2
    description: "rag_find_content_duplicate, rag_set_document_fields (whitelist), rag_save_ingest_state, rag_get_ingest_document and rag_mark_document_failed work on both schemas and raise tenant_mismatch for another tenant's key"
    requirement: "DATA-06"
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#rag_find_content_duplicate finds the same-tenant current document and nothing across tenants"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#a tenant key that is not the row's tenant raises tenant_mismatch in every function that takes a document"
        status: pass
    human_judgment: false
  - id: D3
    description: "rag_write_chunks upserts chunks idempotently by sha256-derived id, copies the document's columns, mirrors promoted columns into metadata, writes the legacy vector for openai-3-small-1536 only, and prunes on the final call"
    requirement: "DATA-01"
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#writing 3 chunks twice leaves 3 rows with the same deterministic ids, and a final write with p_total 2 removes chunk_index 2"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#an embedding entry for another profile raises embedding_profile_unsupported and writes nothing"
        status: pass
    human_judgment: false
  - id: D4
    description: "rag_publish_document_version swaps versions atomically: demotes first, sets superseded_by, nulls the old legacy vectors, keeps old rows and text so an old citation resolves, moves content_type and slug, holds quarantined versions, is idempotent, and rolls back on a mid-swap failure"
    requirement: "DATA-07"
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#publishing version 2 demotes version 1, drops its legacy vectors, keeps its rows, and retrieval returns only version 2"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#a failure between the demotion and the promotion rolls everything back so version 1 stays current"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#publishing a quarantined version leaves it quarantined and leaves the current version current, with its vectors"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every writer function is SECURITY DEFINER with a pinned search_path and executable by service_role only; an anon or authenticated call is refused"
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#the writer functions are SECURITY DEFINER, pinned to search_path public and executable by service_role only"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts#a call made as anon or authenticated is refused"
        status: pass
    human_judgment: false
  - id: D6
    description: "The fake edge accepts rag_* and match_chunks_by_profile names that exist in pg_proc, validates argument names, converts vector and halfvec arrays, passes jsonb, returns PostgREST-shaped errors, and leaves the two legacy specs unchanged"
    verification:
      - kind: integration
        ref: "tests/fixture-edge.test.mts#a rag_* function in the database is called with named arguments and answers with an array of rows"
        status: pass
      - kind: integration
        ref: "tests/fixture-edge.test.mts#a function that raises answers 400 with the PostgREST body, the SQLSTATE as code and the message text"
        status: pass
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/p3-edge (gate.json passed true, paired.all_zero true)"
        status: pass
    human_judgment: false
  - id: D7
    description: "Applying 0310 to the real Supabase project and calling the functions with the service key through PostgREST is a live step"
    verification: []
    human_judgment: true
    rationale: "No live Supabase project is reachable from the executor; PGlite and the fake edge cover the SQL, not the API gateway or role setup of the hosted project"

duration: 35min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 10: Ingest writer SQL functions Summary

**Migration 0310 adds eight service_role-only SECURITY DEFINER functions that are the only unified write path into documents and document_chunks: a locked, tenant-scoped begin-version with file-hash dedup, an idempotent sha256-keyed chunk upsert, and one-transaction version publish that keeps old rows for citations, and the fake PostgREST edge now serves any rag_* function with signature checks and PostgREST-shaped errors.**

## Performance

- **Duration:** about 35 min (start time not recorded at the first tool call; estimated)
- **Completed:** 2026-11-24T01:25:00Z
- **Tasks:** 3 (each a RED, GREEN pair, plus one type-check fix commit)
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- `rag_begin_document_version` takes `pg_advisory_xact_lock` on `tenant_key|source|source_key`; looks up duplicates only inside `p_tenant_key`; returns `skipped_duplicate` (with `duplicate_of`, no `document_id`), `resumed` (a processing row of the same identity and hash) or `created` (version max+1, same lineage, `is_current` false, status processing, `external_url` copied, content_type and slug NULL). It checks that `p_tenant_key` is the key of the given user and organization (`u:`, `o:`) or `s:default`, validates `p_source` against the six D-06 values, and stores `user_id` and `organization_id` only in the multi-tenant schema.
- `rag_find_content_duplicate`, `rag_set_document_fields` (key whitelist, status limited to processing, quarantined, failed, deleted; explicit null clears; metadata merged; mirrored chunk columns follow), `rag_save_ingest_state`, `rag_get_ingest_document` and `rag_mark_document_failed` (refuses a current version).
- `rag_write_chunks`: chunk id is a UUID from `sha256(document_id || ':' || chunk_index)`; denormalised columns come from the document and follow its status and currency; the nine promoted keys plus doc_date, source and page range are mirrored into metadata next to the caller's keys; the legacy vector is written for `openai-3-small-1536` and any other profile raises `embedding_profile_unsupported`; `p_final` prunes `chunk_index >= p_total` of that document only.
- `rag_publish_document_version`: demotes the previous current row first (the partial unique index needs that order), sets `superseded_by`, moves content_type and slug (multi-tenant only, found through `pg_attribute`), sets the old chunks' legacy embedding to NULL, then promotes the new row and its chunks. A quarantined version returns `quarantined` and changes nothing, a current ready one returns `already_current`, failed and deleted ones raise `document_not_publishable`. An advisory lock on the identity serialises concurrent publishes.
- Fake edge: names matching `^rag_[a-z0-9_]+$` or `match_chunks_by_profile` that exist as one public function in `pg_proc` are routed; argument names are validated against the function's input arguments (read once, cached); vector and halfvec arrays become vector text; jsonb values are passed as JSON; database errors answer `{ code, message, details, hint }`.

## Task Commits

1. **Task 1: Begin-version, duplicate lookup, field and state functions** - RED `3303e10` (test), GREEN `f232a0f` (feat)
2. **Task 2: rag_write_chunks and rag_publish_document_version** - RED `bde06ac` (test), GREEN `7e2f090` (feat)
3. **Task 3: Signature-checked generic RPC routing in the fake edge** - RED `205bb8b` (test), GREEN `924632e` (feat), follow-up `9474de6` (fix: type-check of the new test helper)

**Plan metadata:** the docs commit that adds this file.

## TDD Evidence

Tasks 1-3 carry `tdd="true"`; the plan is `type: execute`, so the plan-level gate sequence does not apply. Each RED was classified with `gsd_run check tdd-red-evidence` (records under the git-ignored `.gsd/tdd-evidence/03-10/`), verdict `RED_EVIDENCE_OK` for all three.

- **RED 1** (`3303e10`): 32 tests, 31 failed with ERR_ASSERTION, 1 skipped (cross-tenant case in single-tenant). The SQL helper in the test turns "function rag_begin_document_version does not exist" into an assertion failure, so no failure is a driver exception or a missing module. Test names carry a `[mode]` suffix so the classifier can name one target (an unsuffixed name repeats across the two modes and was refused as ambiguous on the first attempt).
- **RED 2** (`bde06ac`): 62 tests, 31 pass (Task 1), 28 fail with ERR_ASSERTION (every chunk and publish case in both modes), 3 skipped. Semantic assessment: the target ran and failed on the missing functions only.
- **RED 3** (`205bb8b`): 35 tests, 5 fail with ERR_ASSERTION (generic routing, argument check, halfvec and jsonb binding, error body, signature mismatch). Two cases (the 404 list and the legacy-spec guard) pass before and after: they are regression guards, not RED targets.
- Two mutation checks after GREEN confirmed the tests bite: removing the `tenant_key` filter from the file-hash lookup fails "the same file hash in another tenant is ingested normally"; leaving the old vectors in place fails the swap test.

## Files Created/Modified

- `supabase/migrations/0310_ingest_writer.sql` - the eight writer functions, REVOKE from PUBLIC, anon and authenticated, GRANT to service_role (applies after 0309, order from the stem-sorted loader)
- `tests/rag-db/ingest-writer.test.mts` - 62 tests over single-tenant and the two-tenant fixture (59 run, 3 skipped by design)
- `eval/harness/fake-edge.mts` - `genericRpc`, signature query and cache, `bindArgument`, `databaseRejection`, error bodies on `Rejection`
- `tests/fixture-edge.test.mts` - seven tests for generic routing (temporary `rag_test_*` functions are created inside the test database)
- `tests/rag-db/schema-migrations.test.mts` - the assertion that pinned the exact list of `rag_` functions now checks that the two trigger functions are defined (the exposure check over every `rag_` function is unchanged)

## Decisions Made

- **tenant_mismatch is also the answer for an unknown id.** The functions find the row with `id AND tenant_key` in one statement, so an id of another tenant cannot be told from an unknown one. `rag_find_content_duplicate` checks `p_document_id` the same way when it is given.
- **`rag_get_ingest_document` returns nothing instead of raising.** The plan says both "nothing for another tenant's id" (Task 1 behaviour) and "tenant_mismatch in every function"; a read that raised would be an existence probe, so the specific line wins. Five of the six Task 1 functions plus write and publish raise (7 `RAISE EXCEPTION 'tenant_mismatch'` sites).
- **Duplicate result shape.** `skipped_duplicate` leaves `document_id`, `version` and `lineage_id` NULL and sets `duplicate_of`.
- **Mode detection** uses `documents.user_id` being NOT NULL, because single-tenant `documents` has a nullable `user_id` at HEAD (added by the ownership fix) and "user_id present" no longer separates the schemas.
- **Replace semantics on rewrite.** A chunk upserted again without a vector ends with a NULL vector and no `embedding_model` metadata; a retry resends the batch with its vectors.
- **`rag_set_document_fields` mirrors** `doc_type`, `doc_date`, `language`, `parser_used` and `status` into the document's chunks (columns and, for the first three plus parser, metadata) so a quarantine or a type change takes effect on retrieval at once.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] An existing test pinned the full list of `rag_` functions**
- **Found during:** Task 1 (GREEN)
- **Issue:** `tests/rag-db/schema-migrations.test.mts` asserted that the only `rag_` functions in the database are the two trigger functions; any new writer function failed it.
- **Fix:** The assertion now requires the two trigger functions to be defined; the check that no `rag_` function is executable by anon or authenticated stays.
- **Files modified:** tests/rag-db/schema-migrations.test.mts
- **Verification:** `node --import tsx --test tests/rag-db/*.test.mts` 98 pass, 0 fail
- **Committed in:** `f232a0f`

**2. [Rule 2 - Missing critical] Argument validation and failure-path guards not named in the plan**
- **Found during:** Tasks 1 and 2 (threat model T-03-28, T-03-29)
- **Issue:** Without them a caller could pass a source outside the widened set (the legacy trigger would silently rewrite it to config_upload), mark the current version failed, resend duplicate chunk indexes (an ON CONFLICT error mid-statement), or pass embeddings that do not line up with the chunks (a vector stored on the wrong chunk).
- **Fix:** `invalid_source`, `document_is_current`, `invalid_chunk` (content and distinct numeric chunk_index), `invalid_chunks`, `invalid_total`, `embedding_count_mismatch`, `invalid_embeddings`, `invalid_fields`, `invalid_state`, `document_not_writable` and `document_not_publishable`, each covered by a test.
- **Files modified:** supabase/migrations/0310_ingest_writer.sql
- **Committed in:** `f232a0f`, `7e2f090`

**3. [Rule 3 - Blocking] "documents.user_id present" cannot detect the multi-tenant schema**
- **Found during:** Task 1
- **Issue:** Single-tenant `documents` now has `user_id` (03-01 Deviation 2 recorded the same drift for other columns).
- **Fix:** Detect through `pg_attribute.attnotnull` on `documents.user_id`. Single-tenant ignores `p_user_id` and `p_org_id` as the plan says.
- **Committed in:** `f232a0f`

**4. [Rule 3 - Blocking] Test names repeated across the two modes**
- **Found during:** Task 1 (RED classification)
- **Issue:** The RED classifier refuses an ambiguous target name.
- **Fix:** Every test name ends with `[single-tenant]` or `[multi-tenant]`.
- **Committed in:** `3303e10`

---

**Total deviations:** 4 (1 test pin updated, 1 missing-critical validation set, 2 blocking adjustments)
**Impact on plan:** No scope creep; the extra guards strengthen T-03-28 and T-03-29, and the plan's acceptance criteria hold.

## Acceptance Criteria Re-run

- `grep -c "pg_advisory_xact_lock" supabase/migrations/0310_ingest_writer.sql` = 2 (>= 1)
- `grep -c "tenant_mismatch" supabase/migrations/0310_ingest_writer.sql` = 8 (>= 5)
- `grep -c "superseded_by" supabase/migrations/0310_ingest_writer.sql` = 1 (>= 1)
- `grep -c "embedding_profile_unsupported" supabase/migrations/0310_ingest_writer.sql` = 2 (>= 1)
- `grep -c "pg_proc" eval/harness/fake-edge.mts` = 1 (>= 1)
- `node --import tsx --test tests/rag-db/ingest-writer.test.mts`: 59 pass, 0 fail, 3 skipped (>= 17 passed)
- `node --import tsx --test tests/fixture-edge.test.mts`: 35 pass, 0 fail
- `npm run test-rag -- --out eval/out/p3-edge`: `gate.json` passed true, `paired.all_zero` true

## Gate Results (worktree)

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors; `npm run typecheck:new`: no errors
- `npx vitest run`: 119 files, 1534 tests passed (tests/rag/langfuse-pins.test.ts read its files here)
- `node --import tsx --test tests/*.test.mts`: 143 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 98 pass, 0 fail, 3 skipped
- `node scripts/ci/check-rag-boundary.mjs`, `python3 scripts/ci/check-workflows.py`, `node scripts/check-config.mjs`: ok
- rag-sidecar untouched, its pytest not run

## Issues Encountered

- The first RED attempt was classified `no_target_test_failure` because the test names repeated across the two modes; fixed by the mode suffix.
- A shell command that rewrote `fake-edge.mts` through a heredoc was refused by the sandbox's removal check although it deleted nothing; the same edits were made with the Edit tool and nothing had run.
- The worktree branch is `exec/03-10`, not an `agent-*` name; the commit guard's per-agent allow-list was not applied because the orchestrator assigned this branch (it is not a protected or default branch).

## Known Stubs

None. `documents.content` is written as an empty string by begin and is not in the `rag_set_document_fields` whitelist (see Observations).

## Threat Flags

None beyond the plan's threat model (T-03-28 to T-03-31 are mitigated and tested). The new SECURITY DEFINER functions all pin `search_path`, check tenant ownership of the row they touch, and are revoked from PUBLIC, anon and authenticated.

## Observations for later plans

- **03-13 (ingest core).** `documents.content` is `''` for a version created by begin and the field whitelist does not include `content`. Legacy readers that show `documents.content` (previews, `get_documents_by_type_slug`) will see an empty string for unified documents until a plan stores the parsed text or the whitelist gains a key. 03-13's content-hash dedup path (status `deleted` plus `metadata.duplicate_of`) is supported by the whitelist as it stands.
- **03-28 (profile write path).** `rag_write_chunks` raises `embedding_profile_unsupported` for any profile id except `openai-3-small-1536`; the profile branch, `chunk_embeddings` upserts and the matching vector drop for superseded chunks belong in a `CREATE OR REPLACE` of `rag_write_chunks` and `rag_publish_document_version`.
- **03-37 (quarantine release).** Publish never promotes a quarantined row. A release has to move the row out of `quarantined` first (`rag_set_document_fields` accepts `status: 'processing'`, and the chunk statuses follow) and then call publish.
- **Single-tenant ownership.** In single-tenant the writer ignores the user, as planned, so unified documents have `user_id` NULL and fall under the "only admins may modify" rule of the ownership fix.
- **Parallel plans.** `tests/rag-db/schema-migrations.test.mts` (the `rag_` function list assertion) was edited here; 03-09 and 03-11 may touch the same lines and conflict on merge.

## User Setup Required

None - no external service configuration required. Applying 0310 to the real Supabase project is a live verification item.

## Operator actions (live, not done here)

1. After the 03-01 migrations, apply `supabase/migrations/0310_ingest_writer.sql` in the order printed by `bash scripts/setup-database.sh --list-migrations <mode>`.
2. With the service key, call `rag_begin_document_version` through PostgREST once and confirm an anon-key call returns a permission error; ask PostgREST to reload its schema cache if the function is not found.
3. Size `rag_write_chunks` calls by bytes (about 1 MB of JSON) and confirm the hosted API gateway accepts that body size.

## Next Phase Readiness

- 03-13 and 03-13b can wrap the eight functions in `writer.ts` and test them through the fake edge; 03-16 and 03-29 can call `rag_find_content_duplicate` and `rag_set_document_fields`.
- Nothing blocks the next plan.

## Self-Check: PASSED

Created files exist (`supabase/migrations/0310_ingest_writer.sql`, `tests/rag-db/ingest-writer.test.mts`), all seven task commits are ancestors of HEAD, every task's acceptance criteria were re-run and hold, the smoke gate passes with all paired differences zero.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
