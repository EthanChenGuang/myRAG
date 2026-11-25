---
phase: 03-unified-ingestion-embedding-profiles
plan: 29
subsystem: ingestion
tags: [invoice, extraction, sidecar, docling, chunking, pgvector-schema, injection-scan, tenant-scope, tdd]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "sidecar POST /v1/extract/invoice and the tax-id vectors (03-14), extract stage and EXTRACTORS (03-18), table helpers and CHUNKERS (03-19), scanText and quarantine (03-20), doc-type resolution (03-22), invoice fixtures and recordings (03-25)"
provides:
  - "Migration 0314: six promoted invoice columns on documents, four tenant-first btree indexes, validated invoice keys in rag_set_document_fields, rag_find_invoices, rag_exact_id_documents (service_role only, tenant/current/ready in SQL)"
  - "findInvoices(scope, filters) exported from @/lib/rag (supplier, date range, amount range, currency, limit)"
  - "chunkInvoice registered in CHUNKERS: header block plus line-item table in one invoice_header chunk"
  - "invoice-client.ts (sidecar call with the shared secret, optional model fill-in) and a document-level invoice extractor registered in EXTRACTORS"
  - "Sidecar extractor tolerant of Docling-merged lines; _table_header finds a table anywhere in a chunk"
affects: [03-35, 03-37, 03-41, 03-44, 03-28]

actuals:
  tokens: 34400
  tasks: 3
  commits: 10
plan_head_before: 65c5b7fec2be3a12c7e444f38c1bc4f50f947053
plan_head_after: 375c2074f6ef780d0f7c3efcf88dffda23f4e1c7

tech-stack:
  added: []
  patterns:
    - "Document-level extractors: EXTRACTORS holds chunk functions and { level: 'document', run(ctx) } objects; the extract stage runs the second kind after the first"
    - "Failure is data: metadata.invoice_extraction = { status: 'failed', errors: [fixed codes] }; logs carry the error class only"
    - "Embedding header rendered at embed time from the promoted columns held in ctx.work.templateRow (null when extraction failed)"
    - "A line with two or more colons is cut before every label that follows whitespace (longest label at the leftmost position wins)"

key-files:
  created:
    - supabase/migrations/0314_invoice_columns.sql
    - src/lib/rag/retrieval/invoices.ts
    - src/lib/rag/ingest/invoice-client.ts
    - src/lib/rag/ingest/extractors/invoice.ts
    - src/lib/rag/ingest/chunkers/invoice.ts
    - tests/rag-db/invoices.test.mts
    - tests/rag-db/invoice-ingest.test.mts
    - tests/rag/ingest/invoice-chunker.test.ts
    - tests/rag/ingest/invoice-extract-stage.test.ts
    - tests/fixtures/ingest/invoice-llm-recorded.json
  modified:
    - rag-sidecar/src/rag_sidecar/extract/invoice.py
    - rag-sidecar/src/rag_sidecar/parse/docling_adapter.py
    - eval/fixtures/ingest/recorded/invoice-en.parse.json
    - eval/fixtures/ingest/recorded/invoice-it.parse.json
    - eval/fixtures/ingest/recorded/invoice-zh.parse.json
    - src/lib/rag/index.ts
    - src/lib/rag/ingest/chunkers/index.ts
    - src/lib/rag/ingest/chunkers/table-aware.ts
    - src/lib/rag/ingest/extractors/index.ts
    - src/lib/rag/ingest/stages/extract.ts
    - src/lib/rag/ingest/stages/embed-write.ts
    - src/lib/rag/ingest/text/embedding-text.ts
    - src/lib/rag/ingest/types.ts
    - src/lib/rag/ingest/writer.ts

key-decisions:
  - "An invoice is a documents row with doc_type invoice_receipt; rag_find_invoices filters tenant_key, is_current, status ready and that type in SQL, and takes the tenant key from scopeKey(scope) only"
  - "A supplier filter matches the name as text (case-insensitive position match, no LIKE pattern) or the tax id exactly, so a wildcard is never a pattern"
  - "rag_exact_id_documents returns a chunk once, as a column match, when it matches by column and by text; the text match is a whole word in which hyphens belong to the word (TP-7A100 does not match TP-7A1000 or 7A100)"
  - "Confidence 0 from the sidecar is a failure; the optional model pass runs only after a successful extraction and only fills empty fields, never replaces one, and is validated twice with the generated schema"
  - "The injection scan covers the extracted number, party names, tax ids and line item descriptions, one scanText call per string; a match quarantines the document and stores no invoice field; unloadable rules fail the run closed (the scan_injection stage already does the same earlier)"
  - "The sidecar client refuses redirects so the shared secret never follows one, and its errors are fixed codes (sidecar_http_<status>, sidecar_unreachable, sidecar_timeout, sidecar_invalid_body, sidecar_unconfigured, invoice_too_large)"
  - "Number and tax ids are prepended to every chunk's section_path of an invoice (not only the header chunks) so every chunk carries the identifier in lexical_text; the profile header template adds Invoice <number> | <supplier> | <tax id> to the embedding text from the stored columns"
  - "Real unmerged zh output stays at confidence 1.0; merged bare party headings without a colon are not supported (not seen in real Docling output)"

patterns-established:
  - "DB tests that run ingest() install the fake object store; invoice-ingest.test.mts does so in beforeEach"
  - "Setting the invoice columns when migration 0314 is missing fails the writer call with invalid_field; the extractor turns that into a recorded store_failed and the document still publishes"

requirements-completed: [DATA-09]

coverage:
  - id: D1
    description: "documents gains the six invoice columns and four (tenant_key, ...) btree indexes; rag_set_document_fields stores the keys, clears on null and refuses malformed currency, amount or date with invalid_field"
    requirement: DATA-09
    verification:
      - kind: integration
        ref: "tests/rag-db/invoices.test.mts#documents has the six invoice columns and four tenant-first btree indexes / #rag_set_document_fields stores the invoice keys and refuses a malformed currency, amount or date"
        status: pass
    human_judgment: false
  - id: D2
    description: "findInvoices filters by supplier name or tax id, date range, numeric amount range and currency; excludes quarantined, unfinished, superseded and non-invoice documents; tenant B never sees tenant A through any filter"
    requirement: DATA-09
    verification:
      - kind: integration
        ref: "tests/rag-db/invoices.test.mts (single-tenant and multi-tenant suites) and tests/rag-db/invoice-ingest.test.mts"
        status: pass
    human_judgment: false
  - id: D3
    description: "rag_exact_id_documents returns current ready chunks by invoice number, tax id (case-insensitive) or a whole-word token within one tenant, and refuses a malformed tenant key; service_role only"
    requirement: DATA-09
    verification:
      - kind: integration
        ref: "tests/rag-db/invoices.test.mts#rag_exact_id_documents ..."
        status: pass
    human_judgment: false
  - id: D4
    description: "The invoice chunker keeps the header block and line-item table with its header in one invoice_header chunk on the recorded zh, en and it invoices, splits an oversized table by rows with the header repeated, and is registered in CHUNKERS"
    requirement: DATA-09
    verification:
      - kind: unit
        ref: "tests/rag/ingest/invoice-chunker.test.ts; tests/rag/ingest/chunk-dispatch.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "The extract stage calls the sidecar once for an invoice_receipt, stores promoted columns, metadata.invoice and doc_date, amends section_path and lexical_text, renders the embedding header from the stored columns, and on any failure publishes plain text with metadata.invoice_extraction failed and a class-only log"
    requirement: DATA-09
    verification:
      - kind: unit
        ref: "tests/rag/ingest/invoice-extract-stage.test.ts"
        status: pass
      - kind: integration
        ref: "tests/rag-db/invoice-ingest.test.mts"
        status: pass
    human_judgment: false
  - id: D6
    description: "With RAG_INVOICE_LLM_EXTRACT=true a missing field is filled from the recorded answer and validated; off, the model is never called; party names and other extracted text pass scanText and a match quarantines the document"
    requirement: DATA-09
    verification:
      - kind: unit
        ref: "tests/rag/ingest/invoice-extract-stage.test.ts#optional model fill-in / #injection scan of the extracted text"
        status: pass
    human_judgment: false
  - id: D7
    description: "The sidecar reads merged en and it Markdown at confidence 1.0 with every field, zh stays at 1.0, and _table_header finds a table that starts after the sixth line"
    requirement: DATA-09
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_invoice_extract.py#test_merged_*; rag-sidecar/tests/test_docling_adapter.py#test_table_header_*"
        status: pass
    human_judgment: false
  - id: D8
    description: "Real Docling output of real en and it invoices is read correctly after the merged-line change; the merged sample is built from the synthetic recordings, not from a real Docling run"
    requirement: DATA-09
    verification: []
    human_judgment: true
    rationale: "No real Docling run was available in this worktree; the nightly real-docling report records invoice_extraction per invoice and should show confidence above 0 for en and it"

duration: not measured (start time was not recorded)
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 29: Invoice ingestion as structured data Summary

**Invoices are extracted by the sidecar from the extract stage into promoted, per-tenant indexed columns plus metadata.invoice, keep their line-item table with the header block in one chunk, carry the invoice number and tax ids into every chunk's path and lexical text, and are filterable with the tenant-scoped findInvoices; an extraction failure never blocks ingestion, and the sidecar now reads the merged lines real Docling returns.**

## Performance

- **Duration:** not measured (the start time was not captured; the session was also interrupted once by a usage limit)
- **Completed:** 2026-11-24
- **Tasks:** 3 plus the five hand-offs (10 commits)
- **Files:** 30 changed (10 created in src, tests and fixtures; 2305 insertions, 91 deletions)

## Accomplishments

- **Migration 0314** adds `invoice_number`, `supplier_name`, `supplier_tax_id`, `issue_date`, `gross_total numeric(20,4)` and `currency` to `documents`, four `(tenant_key, ...)` btree indexes, the extended `rag_set_document_fields` (the 0310 body plus six validated keys; a bad value raises `invalid_field: <name>` and never echoes content), `rag_find_invoices` and `rag_exact_id_documents`. Both read functions are SECURITY DEFINER, executable by service_role only, and refuse a malformed tenant key.
- **`findInvoices(scope, filters, deps?)`** validates its filters before any call, sends only `scopeKey(scope)`, and returns document id, filename, number, supplier, tax id, issue date, gross total (text, exact) and currency, newest issue date first.
- **Invoice chunker**: the header block and the line-item table with its header row become one `invoice_header` chunk when they fit 1024 tokens; a larger table is split by rows under a repeated header (kind `table`) and the header block keeps its own chunk; the rest follows the table-aware rules. `table-aware.ts` now exports `chunkTableSection` and `tableSegments` for reuse (no behaviour change).
- **Invoice extractor** (document level, registered in `EXTRACTORS` as `{ level: 'document', run }`): one sidecar call with the `x-sidecar-secret` header, promoted columns, `metadata.invoice`, `doc_date` from the issue date, `Invoice <number>` and `Tax ID <ids>` in front of every chunk's `section_path` with `lexical_text` recomputed, and the profile header template rendered from the stored columns in the embed stage.
- **Failures are data**: sidecar 5xx or other status, unreachable, timeout, invalid body, unconfigured, confidence 0, or a writer refusal (migration not applied) all publish the document as plain text with `metadata.invoice_extraction = { status: 'failed', errors }` and log `[Ingest] invoice extraction failed` with the error class only.
- **Optional model fill-in** behind `RAG_INVOICE_LLM_EXTRACT` (default off): fills only empty fields from a structured-output call validated with the generated `InvoiceFields` schema, with `llm_unavailable`, `llm_failed` and `llm_invalid` warnings recorded; the model id is asserted to be in the default OpenRouter list.
- **Injection scan**: the extracted number, party names, tax ids and line descriptions go through `scanText` under `RAG_INJECTION_SCAN=quarantine`; a match quarantines the document (status and `metadata.quarantine` as the scan stage writes them) and no invoice field is stored.
- **Sidecar**: `extract_invoice` cuts a line that holds two or more colons before every label that follows whitespace, so Docling-merged header and totals lines are read (en and it at confidence 1.0, every field); `_table_header` scans the whole chunk.

## Task Commits

1. **Hand-off 3: merged lines in the sidecar extractor** (TDD)
   - RED `d5ac498` (test): 8 tests failed on assertions (`None == 'INV-2025-00418'`, confidence `0.2 == 1.0`, `'Example: Holdings Ltd VAT No.: ...' == 'Example: Holdings Ltd'`)
   - GREEN `36e0916` (feat)
2. **Hand-off 4: `_table_header` after the sixth line** (TDD)
   - RED `950e65c` (test): 2 tests failed on `None == '| Description | Amount |\n| --- | --- |'`
   - GREEN `ef35025` (fix), with the three invoice recordings regenerated by the recorder (only `table_header` changed)
3. **Task 1: Invoice columns, lookup functions and findInvoices with the two-tenant test** (TDD)
   - RED `7b8a8e8` (test): 23 of 23 failed on assertions (the schema assertion for migration 0314, `accepted` for invalid filters); an inert `findInvoices` and the writer key types let the file load
   - GREEN `34780a7` (feat)
4. **Task 2: Invoice chunker** (TDD)
   - RED `121a741` (test): 8 failed on assertions (`expected [] to deeply equal [ 'invoice_header', 'text' ]`, `expected undefined to be 'invoice_header'`); an inert `chunkInvoice` was registered
   - GREEN `7c93a9f` (feat); also drops the `CHUNKERS.invoice` stand-in from `resolve-doc-type.test.ts` (hand-off 2)
5. **Task 3: Invoice extractor in the extract stage** (TDD)
   - RED `e6c05ec` (test): 15 of 20 stage tests failed on assertions plus the two updated runner/extractors tests (`expected +0 to be 1`, `expected 'Invoice' to be 'Invoice INV-2025-00418'`, `expected 'ready' to be 'quarantined'`); an inert extractor and client let the files load
   - GREEN `375c207` (feat), with `tests/rag-db/invoice-ingest.test.mts`

**Plan metadata:** the commit that adds this file (docs). `commits: 10` is measured from the ledger base `65c5b7f`.

## Hand-offs

1. `invoice` is registered in `CHUNKERS` (`chunkers/index.ts`) and in `EXTRACTORS` (`extractors/index.ts`).
2. `extractors.test.ts` and `runner.test.ts` now assert the real behaviour: invoice_receipt reaches extract, no `extractor_unavailable` remains, the sidecar is called once, and the failed record is stored. `chunk-dispatch.test.ts` lists `invoice` as registered (`image_caption` stays unavailable). The stand-in block is gone from `resolve-doc-type.test.ts`.
3. Merged lines: see the sidecar change above. The sample is built by a helper that joins each run of plain paragraphs of the recorded en and it invoices into one space-joined line, which is what the 03-25 report describes. zh is checked unmerged at confidence 1.0.
4. `_table_header`: fixed with a failing-first test.
5. `scanText` covers the extracted text, see above.

## Files Created/Modified

See `key-files` above. Notable: `src/lib/rag/ingest/extractors/invoice.ts` (the extractor), `src/lib/rag/ingest/invoice-client.ts` (client and model fill-in), `supabase/migrations/0314_invoice_columns.sql`.

## Decisions Made

See `key-decisions`. For plan 03-35: call `rag_exact_id_documents(p_tenant_key, p_tokens text[], p_limit)` with `scopeKey(scope).toLowerCase()`; it returns `chunk_id, document_id, content, metadata, matched_field`. For 03-37: a quarantined invoice has `metadata.invoice_extraction = { status: 'quarantined' }` next to `metadata.quarantine`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Commit branch guard does not fit the assigned branch**
- **Found during:** first commit
- **Issue:** the executor commit guard allows only `agent-*` branches in a linked worktree; the brief assigns `exec/03-29`, which is not a protected branch.
- **Fix:** committed on `exec/03-29` as briefed; no branch was created or switched.

**2. [Rule 1 - Bug] Tests that pinned behaviour this plan changes**
- **Found during:** Task 2 and Task 3
- **Issue:** `chunk-dispatch.test.ts` asserted invoice is unregistered and that the stage fails `chunker_unavailable` for invoice_receipt; `extractors.test.ts` asserted the registry holds two extractors.
- **Fix:** updated to the new behaviour (`image_caption` is the unregistered kind used for the stage failure case). Not in the plan's file list.
- **Committed in:** `121a741`, `7c93a9f`, `e6c05ec`

**3. [Rule 3 - Blocking] Edits outside the plan's file list**
- `src/lib/rag/ingest/stages/embed-write.ts` and `text/embedding-text.ts` (header template rendering from the stored columns, a must-have truth that no other plan wires), `types.ts` (`ChunkKind` gains `invoice_header`, `IngestWork.templateRow`), `writer.ts` (invoice keys on `DocumentFields`), `chunkers/table-aware.ts` (exports), `rag-sidecar` and the three invoice recordings (hand-offs 3 and 4), `tests/rag-db/invoice-ingest.test.mts` (end-to-end two-tenant test). All additive. **Conflict note:** plan 03-28 rewrites `embed-write.ts`; my edit there is two lines (`templateHeaderFor(...)` and `template_header` in the `buildEmbeddingText` call) and must be kept when the branches merge.

**4. [Interpretation] Invoice columns on every chunk's path**
- The plan says the "invoice chunks" gain the number and tax ids; I amend every chunk of an invoice document so each carries the identifier in `lexical_text`. `rag_exact_id_documents` still limits the column match to `invoice_header` and `table` chunks.

**5. [Interpretation] The invoice has no Docling page numbers**
- `invoice` is not in the Docling chunk kinds (a Docling chunk would not have the header-plus-table structure the chunker builds), so invoice chunks carry no `page_start` or `page_end`.

---

**Total deviations:** 5 (1 process, 1 bug in pinned tests, 1 blocking scope addition, 2 interpretations)
**Impact on plan:** none on scope; every edit serves a must-have truth or a hand-off.

## TDD Gate Compliance

Every task and both sidecar hand-offs have a `test(03-29)` commit followed by a `feat` or `fix` commit; no refactor commits. `gsd_run check tdd-red-evidence` was not run: `workflow.tdd_mode` is off and earlier plans found it rejects vitest's TAP output. RED was assessed from the runner output of each RED commit; every failure listed above is an assertion, never a missing module (inert stubs were committed with each RED).

## Issues Encountered

- The sidecar tests for the adapter and fixtures need the locked `chunking` extra; it was installed from the local uv cache with `--offline` (no new package, no lockfile change, `git status` clean afterwards).
- The first DB test run had my own test-data collisions (a tax id reused across tests, an ordering expectation); fixed in the test file before GREEN was committed.
- ruff reports 31 existing errors and 38 files that need reformatting in `rag-sidecar` (not enforced in CI, untouched by this plan).

## Gate Results (worktree /home/user/wt/03-29, branch exec/03-29)

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 135 files, 1850 tests passed |
| `node --import tsx --test tests/*.test.mts` | 145 passed, 0 failed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 256 tests: 253 passed, 0 failed, 3 skipped (single-tenant variants skipped by design in earlier plans) |
| `node --import tsx --test tests/rag-db/invoices.test.mts` | 23 passed (11 single-tenant, 12 multi-tenant); criterion at least 6 |
| `npx vitest run tests/rag/ingest/invoice-chunker.test.ts` | 7 passed; criterion at least 4 |
| `npx vitest run tests/rag/ingest/invoice-extract-stage.test.ts` | 20 passed; criterion at least 6 |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 724 files, no violations |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables (no new variable) |
| `(cd rag-sidecar && uv run --frozen pytest -q)` | 565 passed, 10 skipped (also with `--extra chunking`: same) |
| `(cd eval && uv run --frozen --offline --all-extras pytest -q)` | 364 passed |
| `tests/rag/langfuse-pins.test.ts` | 15 passed here, no ENOENT |

Acceptance greps: `(tenant_key, ...)` index lines in 0314 = 4 (EXPECT >= 4); `invoice:` in `chunkers/index.ts` = 1 (EXPECT >= 1); `invoice_extraction` in extractors/invoice.ts plus stages/extract.ts = 4 (EXPECT >= 1). No doc-type comparison was added in `src/`; no model identifier appears in comments or commit messages (the single id is the `INVOICE_LLM_MODEL_ID` constant the plan requires).

## Threat Surface

T-03-83 (cross-tenant invoice reads): tenant key from `scopeKey` only, tenant, current and ready predicates in SQL, two-tenant tests at the SQL and ingest level, service_role-only grants tested with real role checks. T-03-84 (injection in party names): `scanText` on every extracted string, quarantine on a match, fail closed when the rule set cannot load. T-03-85 (malformed extraction output): Zod validation of the sidecar and model answers, SQL validation of the six keys, failure path keeps plain text. The shared secret is sent only in the `x-sidecar-secret` header, redirects are refused, and a test captures every console method and finds neither the secret nor any document text. T-03-SC: no package changes. No new endpoint or auth path.

## Known Stubs

None.

## User Setup Required

None for configuration: no new environment variable (`RAG_INVOICE_LLM_EXTRACT`, `RAG_SIDECAR_URL`, `RAG_SIDECAR_SECRET` already exist and are in all five config places).

## Operator actions

- **Apply migration** `supabase/migrations/0314_invoice_columns.sql` (listed by `scripts/setup-database.sh --list-migrations`; apply 0301 to 0312 first, 0313 is claimed by plan 03-28). It is idempotent. Until it is applied, invoice ingestion under the unified pipeline records `invoice_extraction` as failed with `store_failed` and publishes plain text.
- Invoice extraction needs `RAG_SIDECAR_URL` and `RAG_SIDECAR_SECRET`; without them every invoice records `sidecar_unconfigured` and stays plain text.
- `RAG_INVOICE_LLM_EXTRACT=true` also needs `OPENROUTER_API_KEY`; without it the pass reports `llm_unavailable` and the sidecar fields stand.
- After the first nightly real-docling run, check `invoice_extraction` for the en and it invoices in the report artifact (D8).

## Next Phase Readiness

- 03-35 can call `rag_exact_id_documents`; 03-41 and 03-44 can use `findInvoices` and the promoted columns on the recorded zh, en and it invoices.
- Not done here and left to 03-30 and 03-37 (from the wave-5 follow-ups): the remaining quarantine-bypass readers.

## Self-Check: PASSED

Created files exist on disk (migration 0314, the invoice client, extractor, chunker, retrieval module and the four test files); commits `d5ac498`, `36e0916`, `950e65c`, `ef35025`, `7b8a8e8`, `34780a7`, `121a741`, `7c93a9f`, `e6c05ec` and `375c207` are ancestors of HEAD; the measured count from the ledger is 10.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
