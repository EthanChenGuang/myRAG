# Deferred items (found by 03.1-25, outside its files)

Renumbered when the 03.1-47 lineage was merged onto 03.1-48: items 3-6 cited in the 03.1-42, 03.1-44 and 03.1-47 summaries are
items 5-8 here; the 03.1-48 items keep 3 and 4.

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

## 3. Progressive final run for an organization tenant may hit the same missing-owner error (found by 03.1-48)

`startProgressiveFinal` in `src/lib/rag/ingest/callbacks/advance.ts` calls `writer.begin` with the scope from
`scopeFromIngestionJob`, which for an `o:<org>` job has no user. In multi-tenant mode `rag_begin_document_version` raises
`invalid_argument: p_user_id is required` without one. 03.1-48 fixed the same gap for backfill begin (`backfillDocumentScope`,
the organization owner); the progressive path should probably carry the previous version's `user_id` instead. Not reproduced
here (no org-tenant progressive test exists); needs a failing test first.

## 4. tests/rag-e2e/queued-callbacks-two-tenant.test.mts: 3 failures on the 03.1-46 base (seen by 03.1-48)

Same 3 failures with the base `advance.ts` (c8967f53) restored: "modes and phases that this plan does not handle are refused
with 400" (advance `phase: 'begin'` now answers 200, the 03.1-22 case predates begin from 03.1-46), "each tenant parses its own
copy of the same bytes" (3 cache rows, expected 2) and "parse-external is idempotent". Not caused by 03.1-48; the test needs
updating for begin and the parse-cache row count needs a look.

## 5. (03.1-42) L3 is not run by the queue worker

`run_tiered` calls `run_preflight` without a `vlm_app`, so a job whose snapshot has `vlm_detect` on never reaches the detect-vlm
route (03.1-41's note asked 03.1-40 to build `LoopVlmApp`; it was not done, and a `LoopVlmApp` cannot cross into a process pool).
The SC2 e2e (`tests/rag-e2e/escalation-and-cloud-off.test.mts`) mounts detect-vlm with a counting vision stub and proves zero
calls with the cloud off, but with L3 never wired the vision side of that proof is guarded only by l3_refine's own snapshot check.
Wiring belongs to a later plan (thread-side bridge or a detect step outside the pool).

## 6. (03.1-42) Recorded fast pages of the scanned fixtures are invalid Docling JSON

`eval/fixtures/parse/recorded/<sha>/fast/page-N.json` for scan-en, scan-it, scan-zh and mixed-routing page 9 have `texts: []` but
`body.children` still points at `#/texts/0..3`, so `DoclingDocument.load_from_json` raises (the `vlm/` recordings fail validation
too). `RecordedRangeConverter` would crash on these pages under the fast preset; preflight never routes them there, so no current
test hits it. The 03.1-42 tests use their own empty pages instead. Fix belongs to the recording script (03.1-13).

## 7. Parse fixture data limits the parser scores (found by 03.1-44)

`eval/reports/phase-03.1/parser-eval-details.json` shows three places where the fixture data, not a parser, lowers the scores:

- `expected/mixed-routing.json` lists 2 headings, but the PDF and every recorded output have 10 (Section 2-6, Table block 7-8,
  Embedded scan slip). `parse_specs.py` builds `facts["headings"]` for this fixture by hand and misses eight, so headings F1 for
  a faithful output is 0.333.
- The recorded outputs of `multi-column-en` page 2 hold only the heading; the two `ColumnParagraph` blocks are missing
  (`ingest/record_parse_results.py` does not emit them), so structured text similarity is 0.377 and reading order 0.3.
- Recorded premium markdown has no `#` headings and no pipe tables (`build_recorded.py` joins block texts), so premium headings F1
  and table F1 (invoice) are 0.

Fix in the fixture generator (03.1-13 files), then regenerate the recordings and rerun `python -m rag_eval.parser_eval`.

Status (03.1-47): the fast-page half of item 6 is fixed (`build_recorded.py` clears `body.children` on scanned fast pages;
the four recordings regenerated); the `vlm/` recordings are untouched. The second bullet of item 7 is fixed (the recorder
emits `ColumnParagraph` blocks, so multi-column-en page 2 holds both columns in every preset). The first and third bullets
remain.

## 8. (03.1-47) A queued quarantined document ends with status failed, not quarantined

`rag_advance_ingestion_job` (0353) sets the unpublished document of a job that ends `failed` or `quarantined` to
`status = 'failed'`. The inline path leaves a quarantined document at `quarantined`, which is what the quarantine admin lists
and releases (0316: `WHERE d.status = 'quarantined'`). So an injection hit found through the queue is out of retrieval (correct)
but cannot be reviewed or released from the quarantine admin. The ingest mode under `--routing` accepts a job status of
`quarantined` with an unpublished document as the queued equivalent. Fix: a 03xx migration that keeps `quarantined` for that
transition (the function body must be copied from its latest definition), plus a PGlite test through the worker.

## 9. (03.1-51) The L1 threshold sweep is flat on the synthetic dev fixtures

`eval/reports/phase-03.1/threshold-sweep.json`: all 150 grid candidates (garbled ratio 0.03-0.08, ruling-path minimum 2-6, scanned
character limit 20-60) route the 12 dev pages identically (tier accuracy 1.0, projected dev Recall@5 1.0), so the tie rule kept
the current values. The fixtures are far from every threshold (scans have no text layer, tables have many ruling paths, no page
is garbled), which confirms the values but cannot tune them. Rerun `npm run eval:parse-gate` after
`python -m rag_eval.parse_gate sweep --write-config` once dev fixtures near the thresholds exist (thin-ruled tables, scans with a
short text stamp, partly garbled text layers, ideally real documents from a backfill dry run).

## 10. (03.1-51) The worker labels a text upload named like an image as doc_class image

`classify_input` in `rag-sidecar/src/rag_sidecar/ingest/tiered.py` decides by extension before the MIME type, so a Config UI
caption uploaded as `text/markdown` under `floor.png` is recorded with `doc_class = 'image'` and parser `text/image`. Parsing is
correct since 03.1-51 (native mode uses the text input), but the ledger row and the backfill dry-run projection (which prices an
image at `IMAGE_TOKENS`) see an image. Fix: a text MIME type wins over an image extension in `classify_input`, with a failing test
first.

## 11. (03.1-52) eval's PDF determinism test rewrites the committed parse fixtures in place

`eval/tests/test_parse_fixtures.py::test_generation_is_deterministic` takes `tmp_path` but runs
`eval/fixtures/ingest/generate_pdfs.py --target parse` against the repository, so on a host whose CJK font differs from the one the
fixtures were made with it overwrites `eval/fixtures/parse/manifest.json` and the four scanned/mixed PDFs. Three parse-fixture tests and
two parser-eval tests then fail in the same run, and any tiered node test running at the same time fails with `recorded_miss`
(seen in the 03.1-52 full run; all pass again after `git checkout -- eval/fixtures/parse`). Fix: generate into `tmp_path`, with a failing
test first; never commit the rewritten files.

## 12. (03.1-52) Phase 3.1 definers use `SET search_path = public`

The SECURITY DEFINER functions of 0351-0356 (and the 0353 topic rules) pin `search_path = public`, which satisfies the 0411 check but is
not the `''` with schema-qualified names that 0357-0359 and 0424 use. The fold copies them verbatim, so a hardening needs a new migration
that redefines each function (and the setup sections refreshed with it), not an edit of the setup files.

## 13. (03.1-52) parse-gate-details.json item counts are stale

`npm run eval:parse-gate` on the 03.1-52 tree passes (26 paired metrics within the noise band) but rewrites
`eval/reports/phase-03.1/parse-gate-details.json` with larger `n` per category (the golden set grew in merged plans). The committed file was
left unchanged to avoid conflicts; refresh it when the phase report is regenerated.
