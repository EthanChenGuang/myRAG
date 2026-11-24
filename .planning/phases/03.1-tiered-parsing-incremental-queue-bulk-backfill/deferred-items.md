# Deferred items (found by 03.1-25, outside its files)

## 1. Single-tenant PGlite fixtures fail on trunk: 0409_search_rpc_revoke.sql

`supabase/migrations/0409_search_rpc_revoke.sql` (Phase 4) runs `REVOKE/GRANT ... match_documents_by_workspace(...)`, a function that
exists only in the multi-tenant variant (`0306_retrieval_filters.multi-tenant.sql`). `applyMigrations(db, 'single-tenant')` therefore
throws `function public.match_documents_by_workspace(vector, integer, double precision, uuid, uuid) does not exist`, so every harness
fixture built with `migrations: true` in single-tenant mode fails. Seen in this worktree: `tests/rag-db/backfill-ledger.test.mts`
(single-tenant suites), `tests/fixture-edge.test.mts`, `tests/eval-answer.test.mts`, `tests/rag-assemble-differential.test.mts`,
`tests/rag/documents-versions.test.ts` (via the relex step) and others. The fix belongs in Phase 4 (split the migration into
`.single-tenant` / `.multi-tenant` variants or guard with `IF EXISTS`). 03.1-25's own single-tenant PGlite test builds its database
with `migrations: false` and applies every single-tenant migration except 0409, so it does not depend on the fix.

## 2. tests/ingest-queue-contracts.test.ts "BackfillManifestEntry rejects a known invalid case" fails

The invalid sample is `{ source_key, path, url: 'http://...' }` (both locations, http url). The generated Zod
`BackfillManifestEntrySchema` accepts it because the "exactly one of path or url" and "https only" rules are Pydantic-side only
(03.1-02 summary: cross-field rules live in Pydantic). Either the test case must use an enum or range violation, or the Pydantic
model needs a schema-visible constraint (`oneOf`). 03.1-25's `listSource` enforces both rules itself after the Zod parse
(`manifest_location`, `manifest_https`) and tests them, so the backfill is safe either way.

## 3. (03.1-42) L3 is not run by the queue worker

`run_tiered` calls `run_preflight` without a `vlm_app`, so a job whose snapshot has `vlm_detect` on never reaches the detect-vlm
route (03.1-41's note asked 03.1-40 to build `LoopVlmApp`; it was not done, and a `LoopVlmApp` cannot cross into a process pool).
The SC2 e2e (`tests/rag-e2e/escalation-and-cloud-off.test.mts`) mounts detect-vlm with a counting vision stub and proves zero
calls with the cloud off, but with L3 never wired the vision side of that proof is guarded only by l3_refine's own snapshot check.
Wiring belongs to a later plan (thread-side bridge or a detect step outside the pool).

## 4. (03.1-42) Recorded fast pages of the scanned fixtures are invalid Docling JSON

`eval/fixtures/parse/recorded/<sha>/fast/page-N.json` for scan-en, scan-it, scan-zh and mixed-routing page 9 have `texts: []` but
`body.children` still points at `#/texts/0..3`, so `DoclingDocument.load_from_json` raises (the `vlm/` recordings fail validation
too). `RecordedRangeConverter` would crash on these pages under the fast preset; preflight never routes them there, so no current
test hits it. The 03.1-42 tests use their own empty pages instead. Fix belongs to the recording script (03.1-13).
