---
phase: 03-unified-ingestion-embedding-profiles
plan: 01
subsystem: database
tags: [postgres, pgvector, supabase, migrations, pglite, rag, tenant-isolation]

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: scopeKey semantics for tenant_key, the PGlite fixture harness, the two-tenant fixture, the smoke tier and its paired-difference gate
provides:
  - supabase/migrations/ with ordered idempotent migrations 0301-0306 (documents identity, versions, status, type, hashes, parser and profile columns; widened source; source_key identity index; promoted chunk columns; legacy-compat triggers; D-08 retrieval filter)
  - eval/harness/migrations.mts (migrationFiles, applyMigrationFiles, applyMigrations) used by PGlite and mirrored by scripts/setup-database.sh --list-migrations
  - tests/rag-db suite (schema-migrations, schema-equality) and the frozen pre-Phase-3 setup files
  - CI step that runs tests/rag-db and a check-workflows needle that requires it
affects: [03-02, 03-09, 03-10, 03-13, 03-16, 03-30, 03-47]

actuals:
  tokens: 19400
  tasks: 3
  commits: 7
plan_head_before: ccfcd7e0e02d332cc60a779fc7a84197888bf557
plan_head_after: 138e3744aad1eee728fac14c3b5813583a2e3a56

tech-stack:
  added: []
  patterns:
    - "Migrations sort by name without the mode suffix, a common file before its mode variant; one loader, one shell function"
    - "BEFORE INSERT triggers fill what a legacy writer omits and never overwrite a supplied value, except a chunk's tenant_key which always follows its document"
    - "Retrieval functions are replaced with CREATE OR REPLACE, byte-identical to the setup definition plus one predicate, proven by a test"

key-files:
  created:
    - supabase/migrations/0301_documents_versions.sql
    - supabase/migrations/0301_documents_versions.single-tenant.sql
    - supabase/migrations/0301_documents_versions.multi-tenant.sql
    - supabase/migrations/0302_documents_source.sql
    - supabase/migrations/0303_documents_identity.sql
    - supabase/migrations/0304_chunks_promoted.sql
    - supabase/migrations/0305_legacy_compat_triggers.sql
    - supabase/migrations/0306_retrieval_filters.single-tenant.sql
    - supabase/migrations/0306_retrieval_filters.multi-tenant.sql
    - eval/harness/migrations.mts
    - tests/rag-db/schema-migrations.test.mts
    - tests/rag-db/schema-equality.test.mts
    - tests/fixtures/sql/pre-phase3-single-tenant-setup.sql
    - tests/fixtures/sql/pre-phase3-multi-tenant-setup.sql
  modified:
    - eval/harness/pglite-supabase.mts
    - scripts/setup-database.sh
    - .github/workflows/pr-smoke.yml
    - scripts/ci/check-workflows.py
    - scripts/tests/test_check_workflows.py

key-decisions:
  - "Migration order is the name without the mode suffix, common file first (plain name sort would run 0301.<mode>.sql before 0301.sql and break it)"
  - "Legacy documents inserts are normalised by a trigger; parser_used 'llamaparse' and parser_version 'legacy' are stamped only when lineage_id is NULL, so a writer that supplies a lineage keeps its own parser values"
  - "A chunk's tenant_key is always copied from its document by a SECURITY DEFINER trigger, whatever the writer sent, so a direct client insert cannot place a chunk in another tenant"
  - "search_chunks_by_keywords (single-tenant, granted to authenticated) gets the D-08 predicate too"
  - "Migration hashes are not added to the run manifest sqlSha256 (tests/fixture-edge.test.mts pins its keys to the setup file)"

patterns-established:
  - "Phase 3 SQL objects named rag_* are not executable by anon or authenticated; tests/rag-db checks every rag_ function"
  - "Idempotency proof is a catalog dump compared across frozen+migrations, current+migrations and migrations applied twice, with a negative control"

requirements-completed: [DATA-02, DATA-06, DATA-07]

coverage:
  - id: D1
    description: "Documents carry identity, version, status, type, hash, parser and profile columns; existing rows backfill to version 1, current, ready, general, own lineage, legacy parser, source_key legacy:<id>, with tenant_key equal to scopeKey semantics in both schemas"
    requirement: "DATA-06"
    verification:
      - kind: integration
        ref: "tests/rag-db/schema-migrations.test.mts#existing rows become version 1, current, ready, general, own lineage, legacy parser, source_key legacy:<id>"
        status: pass
      - kind: integration
        ref: "tests/rag-db/schema-migrations.test.mts#tenant_key on documents"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every legacy insert shape (upload, nango, scrape, google-drive, omitted, unknown) still succeeds in both schemas and comes out current, ready, own lineage, with a widened source and the original in metadata.legacy_source; chunk inserts without tenant_key get it from the document"
    requirement: "DATA-02"
    verification:
      - kind: integration
        ref: "tests/rag-db/schema-migrations.test.mts#every legacy documents insert shape succeeds and comes out current, ready, own lineage, with a widened source"
        status: pass
      - kind: integration
        ref: "tests/rag-db/schema-migrations.test.mts#a legacy chunk insert gets tenant_key, version, doc_type and source from its document"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every search function that returns chunks (four per schema) returns only is_current and status ready rows, with no switch; the smoke tier passes with all paired differences zero"
    requirement: "DATA-07"
    verification:
      - kind: integration
        ref: "tests/rag-db/schema-migrations.test.mts#legacy search functions only see current, ready chunks (D-08)"
        status: pass
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/p3-migrations (gate.json passed true, paired.all_zero true)"
        status: pass
      - kind: integration
        ref: "tests/rag-legacy-differential.test.mts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Migrations are idempotent and guarded against drift: frozen setup plus migrations equals current setup plus migrations, applying twice equals once, and PGlite, setup-database.sh and CI apply the same order"
    requirement: "DATA-06"
    verification:
      - kind: integration
        ref: "tests/rag-db/schema-equality.test.mts"
        status: pass
      - kind: other
        ref: "python3 scripts/ci/check-workflows.py; python3 -m unittest discover -s scripts/tests -p test_check_workflows.py"
        status: pass
    human_judgment: false
  - id: D5
    description: "Applying the migrations to the real Supabase project (table rewrite for the generated tenant_key column, backfill UPDATEs, pgvector and constraint inventory) is a live step"
    verification: []
    human_judgment: true
    rationale: "No live Supabase project is reachable from the executor; the order and quiet-window advice are in the operator actions below"

duration: 28min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 01: Schema foundation migrations Summary

**Ordered idempotent Postgres migrations 0301-0306 give documents identity, versions, status, type, hashes and a generated tenant_key, give chunks promoted columns, keep every legacy writer valid through BEFORE INSERT triggers, and hide non-current and quarantined chunks from all search functions with no switch, proven by legacy-shape tests in both schemas and a zero-difference smoke gate.**

## Performance

- **Duration:** 28 min
- **Started:** 2026-11-24T00:27:00Z
- **Completed:** 2026-11-24T00:55:00Z
- **Tasks:** 3 (each a RED, GREEN pair, plus one fix commit)
- **Files modified:** 19 (14 created, 5 modified; two of the created files are the frozen setup copies)

## Accomplishments

- `documents` gains lineage_id, source_key, version, is_current, superseded_by, status (processing, ready, quarantined, failed, deleted), processing_status and state, doc_type and doc_type_origin, doc_date, language, file_sha256, content_hash, parser_used and version, profile id and version, original_path, and a stored generated `tenant_key` (`s:default`; `o:<organization_id>` or `u:<user_id>` in multi-tenant). Existing rows backfill without a manual step.
- 0302 finds and drops the old `source` CHECK through `pg_constraint` (column-based, so the live name does not matter), maps legacy values, keeps the original in `metadata.legacy_source`, widens the CHECK and sets the default to `config_upload`. 0303 backfills `source_key` (file id on the newest Nango or scraper row, `legacy:<id>` elsewhere) and creates the partial unique identity index.
- `document_chunks` gains the D-07 columns, backfilled from the parent; chunks with an image URL become `image` chunks; legacy vectors record `embedding_model` and `embedding_dims` in metadata.
- Two BEFORE INSERT triggers keep legacy writers working; `lineage_id` and `source_key` are NOT NULL after them.
- 0306 re-creates the chunk-returning search functions with `AND dc.is_current AND dc.status = 'ready'`. Functions changed:
  - single-tenant: `match_document_chunks`, `match_documents`, `match_document_chunks_optimized`, `search_chunks_by_keywords`
  - multi-tenant: `match_documents_by_organization`, `match_documents_by_workspace`, `match_document_chunks`, `match_document_chunks_by_org`
- A test proves each replaced definition equals the setup definition plus exactly the predicate lines, so nothing else drifted.
- One loader (`eval/harness/migrations.mts`) for PGlite, `scripts/setup-database.sh --list-migrations <mode>` for fresh installs (plus an optional `psql -v ON_ERROR_STOP=1` apply when `DATABASE_URL` is set), and a CI step for `tests/rag-db/*.test.mts` guarded by a `check-workflows.py` needle.

## Task Commits

1. **Task 1: Documents migrations and loader** - RED `be5405c` (test), GREEN `0410deb` (feat)
2. **Task 2: Chunk columns, triggers, D-08 filter** - RED `a77c5c6` (test), GREEN `cfb59a0` (feat)
3. **Task 3: Equality guard, setup-database.sh order, CI step** - RED `606d0fb` (test), GREEN `f664faf` (feat), follow-up `138e374` (fix: type-check of the new test)

**Plan metadata:** the docs commit that adds this file.

## TDD Evidence

Tasks 1-3 carry `tdd="true"`; the plan is `type: execute`, so the plan-level gate sequence does not apply, but each RED was classified with `gsd_run check tdd-red-evidence` (records under the git-ignored `.gsd/tdd-evidence/03-01/`).

- **RED 1** (`be5405c`): 15 tests ran against an empty-stub loader and failed with ERR_ASSERTION (no Phase 3 columns, empty file list, source CHECK not widened). Verdict `RED_EVIDENCE_OK`. The stub exists so the failure is an assertion, not a missing module. Two tests initially failed on SQL errors or passed vacuously; they were tightened (column precondition, effect assertion) before the commit.
- **RED 2** (`a77c5c6`): 26 tests, 17 pass (Task 1), 9 fail with ERR_ASSERTION (missing chunk columns, legacy shapes rejected by the widened CHECK, unfiltered RPCs, no 0306 files). Verdict `RED_EVIDENCE_OK`. "A writer that supplies identity, parser and state keeps its values" passes before and after: it is a regression guard for the triggers, not a RED target.
- **RED 3** (`606d0fb`): 11 tests, 5 fail with ERR_ASSERTION (list-migrations missing, frozen file not loaded); two Python unittests fail on the missing CI step. Verdict `RED_EVIDENCE_OK`. The catalog-equality, idempotency and negative-control cases are guards that hold by construction until the setup files are folded (plan 03-47), and the negative control proves the dump detects a missing migration.

## Files Created/Modified

- `supabase/migrations/0301_documents_versions.sql` - common documents columns, CHECKs, legacy backfill, `(lineage_id, version)` unique index
- `supabase/migrations/0301_documents_versions.{single,multi}-tenant.sql` - generated `tenant_key` and the two tenant-leading hash indexes
- `supabase/migrations/0302_documents_source.sql` - catalog-driven drop of the source CHECK, value rewrite, widened CHECK and default
- `supabase/migrations/0303_documents_identity.sql` - `source_key` backfill and the partial unique identity index
- `supabase/migrations/0304_chunks_promoted.sql` - promoted chunk columns, backfill, `(document_id, chunk_index)` index
- `supabase/migrations/0305_legacy_compat_triggers.sql` - the two triggers, grants revoked from anon and authenticated, NOT NULL on identity
- `supabase/migrations/0306_retrieval_filters.{single,multi}-tenant.sql` - D-08 predicate on the search functions
- `eval/harness/migrations.mts` - ordered file list and apply helpers
- `eval/harness/pglite-supabase.mts` - applies migrations after the setup SQL; `migrations` and `setupSqlPath` options
- `scripts/setup-database.sh` - `--list-migrations`, migration instructions, optional psql apply
- `tests/rag-db/*.test.mts`, `tests/fixtures/sql/pre-phase3-*.sql` - 39 tests and the frozen setup files (byte-identical to the setup files at the start of the plan)
- `.github/workflows/pr-smoke.yml`, `scripts/ci/check-workflows.py`, `scripts/tests/test_check_workflows.py` - CI step, needle and its unit test

## Decisions Made

- **Migration order.** Plain `sort` by file name puts `0301_documents_versions.single-tenant.sql` before `0301_documents_versions.sql` (`s` + `i` sorts before `s` + `q`), which would run the mode file before the columns it indexes. The order is therefore name without the mode suffix, common file first; the TypeScript loader and the bash function implement the same rule and a test compares them.
- **Parser stamp.** `parser_used = 'llamaparse'`, `parser_version = 'legacy'` are stamped by the trigger only when the insert has no `lineage_id`, which is the legacy shape. The unified writer must pass `lineage_id` (or its own parser) to avoid the stamp; the parse stage overwrites it anyway.
- **Chunk tenant_key authority.** See Deviations 3.
- **No NOT NULL on chunk columns.** Single-tenant `document_chunks.document_id` is nullable, so orphan chunks keep NULL denormalised values; `is_current` and `status` are NOT NULL with defaults, which is all the D-08 filter needs.
- **Manifest pins.** The run manifest's `sql_sha256` still lists only the setup file because `tests/fixture-edge.test.mts` asserts that key set; migration hashes are not pinned there yet.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] "Sorted by name" would run a mode file before its common file**
- **Found during:** Task 1 (loader design)
- **Issue:** The plan has mode files add `tenant_key` and then index `file_sha256` (a common-file column), and also says files are sorted by name; the two cannot both hold with a plain sort.
- **Fix:** Sort key is the name without the mode suffix, a common file before its variant, in `migrationFiles` and in the bash `migration_files` function; a test pins the first four files and the ordering rule, and another compares the script output with the loader.
- **Files modified:** eval/harness/migrations.mts, scripts/setup-database.sh, tests/rag-db/schema-migrations.test.mts
- **Committed in:** `0410deb`, `f664faf`

**2. [Rule 3 - Blocking] The plan's schema facts are older than HEAD**
- **Found during:** Task 1 and 2 (reading the setup files)
- **Issue:** The plan says single-tenant has no `user_id` and no `chunk_index`; at HEAD single-tenant `documents` has `user_id` (added by the security fix) and `document_chunks.chunk_index` exists through a DO block.
- **Fix:** Every column is added with `ADD COLUMN IF NOT EXISTS`, so both shapes work; `tenant_key` for single-tenant stays the constant `s:default` as specified. No behavioural change.
- **Files modified:** supabase/migrations/0304_chunks_promoted.sql
- **Committed in:** `cfb59a0`

**3. [Rule 2 - Missing critical] A chunk's tenant_key must follow its document, and the trigger functions must not be callable**
- **Found during:** Task 2 (threat model T-03-04)
- **Issue:** Multi-tenant RLS lets an authenticated user insert chunks directly. With a "fill NULL only" trigger a client could send any `tenant_key`, and later tenant-keyed searches (profile RPC) would then return that chunk to the victim tenant. PostgreSQL also grants EXECUTE on new functions to PUBLIC, and Phase 3's own test for `rag_*` functions would flag them.
- **Fix:** `rag_chunks_legacy_defaults` is SECURITY DEFINER with a pinned `search_path` and always sets `tenant_key` from the parent; both trigger functions are revoked from PUBLIC, anon and authenticated. Tests cover a forged tenant_key and loop over every `rag_*` function.
- **Files modified:** supabase/migrations/0305_legacy_compat_triggers.sql, tests/rag-db/schema-migrations.test.mts
- **Committed in:** `cfb59a0`

**4. [Rule 2 - Missing critical] search_chunks_by_keywords also returns chunk rows**
- **Found during:** Task 2
- **Issue:** The plan names `match_*` functions, but the single-tenant `search_chunks_by_keywords` returns `document_chunks` content and is granted to `authenticated`; leaving it out would let quarantined text out through a retrieval RPC.
- **Fix:** Added to 0306 single-tenant with the same predicate; it is covered by the filter test and the definition-equality test. It has no caller in `src/`.
- **Files modified:** supabase/migrations/0306_retrieval_filters.single-tenant.sql
- **Committed in:** `cfb59a0`

**5. [Rule 3 - Blocking] A Task 1 behaviour line depends on a Task 2 object**
- **Found during:** Task 1 (GREEN)
- **Issue:** "Corpus rows loaded after the migrations have lineage_id = id and the legacy parser" needs the 0305 trigger.
- **Fix:** Task 1's test checks the column defaults for loader-inserted rows and the full backfill on pre-existing rows (which exercises the 0301 UPDATE); the lineage and parser assertions for newly inserted rows live in Task 2's legacy-shape test.
- **Committed in:** `0410deb`, `cfb59a0`

**6. [Rule 3 - Blocking] Added one test file outside the plan's list**
- **Found during:** Task 3
- **Issue:** The behaviour "check-workflows.py fails when the ts job lacks the tests/rag-db/ step" needs a test, and check_pr reads a module-level path.
- **Fix:** Two unittests in `scripts/tests/test_check_workflows.py` point `PR` at a temporary workflow copy; that file already runs in the "Workflow structure check" CI step.
- **Committed in:** `606d0fb`

---

**Total deviations:** 6 (1 bug in the plan text, 2 missing-critical security hardenings, 3 blocking/adjustments)
**Impact on plan:** No scope creep; the security items strengthen T-03-01 and T-03-04, and the ordering fix makes the stated per-mode file split work.

## Issues Encountered

- `uv run --directory eval python ../scripts/ci/check-workflows.py` (the literal command in Task 3 `<verify>`) cannot run in this worktree: the eval virtualenv here has no PyYAML and installing it is out of bounds. The same script was run with `python3` (the gate in the brief) and passes; CI runs it through uv with a synced environment.
- `npm run typecheck:new` (a CI step) flagged one type error in the new list-migrations test (`env` typing); fixed in `138e374`.
- Vitest, tsx, tsc, boundary, config and workflow gates all pass; `tests/rag/langfuse-pins.test.ts` read its files without an ENOENT here.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: security-definer-trigger | supabase/migrations/0305_legacy_compat_triggers.sql | `rag_chunks_legacy_defaults` is SECURITY DEFINER (reads `documents` regardless of RLS to set the authoritative tenant_key); search_path is pinned and EXECUTE is revoked from PUBLIC, anon and authenticated |

## Observations for later plans

- **03-30 and other direct readers.** 0306 covers the search functions only. Code that reads `document_chunks` through the table (voice keyword fallback, `refs/resolve`, `context/fetch-rows`, the documents routes) does not get the D-08 filter from these migrations; 03-30 owns those readers.
- **Table read policies.** Single-tenant chunk SELECT is `USING (true)` (public read by design) and multi-tenant owners and members can SELECT their chunks, so quarantined chunks stay readable through the table API by their existing audience. D-08 as specified hides them from retrieval, not from table reads; the quarantine plan (03-37) may want to decide whether that is enough.
- **Writer contract.** The unified writer should set `lineage_id` (a new lineage uses its own id) so the legacy parser stamp is not applied, and may rely on the chunk trigger for denormalised columns.
- **Patches directory.** `supabase/patches/` is not touched; live databases take these changes through the migrations directory.

## User Setup Required

None - no external service configuration required. Applying the migrations to the real Supabase project is a live verification item (below).

## Operator actions (live, not done here)

1. Before migrating: `SELECT source, count(*) FROM documents GROUP BY 1`, list the CHECK constraints on `documents`, and `SELECT extversion FROM pg_extension WHERE extname = 'vector'`.
2. Back up, then apply the setup file and `supabase/migrations/` in the order printed by `bash scripts/setup-database.sh --list-migrations <mode>`. The generated `tenant_key` column rewrites `documents` once under an exclusive lock, and 0301, 0302, 0304 backfill with full-table UPDATEs: use a quiet window.
3. After migrating: run the eval smoke tier against the live project in `legacy` mode and expect all paired differences zero.

## Next Phase Readiness

- Wave-1 schema is in place for 03-02 (contracts), 03-09/03-10 (writer and dedup functions that call these columns), 03-13 (ingest core) and 03-30 (readers).
- Nothing blocks the next plan. The setup files are intentionally unchanged until 03-47 folds them; until then the equality test compares identical inputs and guards drift.

## Self-Check: PASSED

All 14 created files exist, all 7 commits are ancestors of HEAD, every task's acceptance criteria were re-run and hold (migrations 030[1-3] count 5, applyMigrations 2, pg_constraint 2, is_current 5, BEFORE INSERT 3, tests/rag-db/ 1, list-migrations 3, `cmp` exits 0, smoke gate `passed` true with `paired.all_zero` true).

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
