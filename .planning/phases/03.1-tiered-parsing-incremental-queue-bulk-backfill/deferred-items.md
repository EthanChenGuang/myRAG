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

## 3. Parse fixture data limits the parser scores (found by 03.1-44)

`eval/reports/phase-03.1/parser-eval-details.json` shows three places where the fixture data, not a parser, lowers the scores:

- `expected/mixed-routing.json` lists 2 headings, but the PDF and every recorded output have 10 (Section 2-6, Table block 7-8,
  Embedded scan slip). `parse_specs.py` builds `facts["headings"]` for this fixture by hand and misses eight, so headings F1 for
  a faithful output is 0.333.
- The recorded outputs of `multi-column-en` page 2 hold only the heading; the two `ColumnParagraph` blocks are missing
  (`ingest/record_parse_results.py` does not emit them), so structured text similarity is 0.377 and reading order 0.3.
- Recorded premium markdown has no `#` headings and no pipe tables (`build_recorded.py` joins block texts), so premium headings F1
  and table F1 (invoice) are 0.

Fix in the fixture generator (03.1-13 files), then regenerate the recordings and rerun `python -m rag_eval.parser_eval`.
