---
phase: 03-unified-ingestion-embedding-profiles
plan: 41a
subsystem: ingestion
tags: [ingest, writer, documents-content, migration, eval, baseline, pglite]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "rag_set_document_fields (0310, 0314), the stage runner and write stage (03-13, 03-28), the ingest fixture mode and its baseline (03-41)"
provides:
  - "migration 0319: rag_set_document_fields accepts content (JSON string only)"
  - "the write stage stores the parsed text in documents.content once per version"
  - "eval/baselines/fixture-ingest-baseline.json re-recorded: ingest mode now equals prechunked (recall@5 0.519)"
affects: [03-44, 03-45, 03-46, 03-48]

actuals:
  tokens: 21000
  tasks: 2
  commits: 3
plan_head_before: 694b6962ca4a492006eb34ddd0c0bb7471b99109
plan_head_after: 0094b01d7c61a2ca897e89eda8b6ba1a96b8cb34
commits: 3

tech-stack:
  added: []
  patterns:
    - "A SECURITY DEFINER writer function is extended by a new migration that copies the newest definition (0314) and adds one key; the old migration is not edited"

key-files:
  created:
    - supabase/migrations/0319_document_content.sql
  modified:
    - src/lib/rag/ingest/writer.ts
    - src/lib/rag/ingest/stages/embed-write.ts
    - tests/rag-db/ingest-writer.test.mts
    - tests/rag-db/ingest-mode.test.mts
    - tests/rag/ingest/runner.test.ts
    - eval/baselines/fixture-ingest-baseline.json

key-decisions:
  - "0319 is based on 0314, the newest definition of rag_set_document_fields (0310 was superseded by it; 0313, 0315, 0316 do not define the function). The diff against 0314 is three hunks: 'content' in the allow-list, a string-only check, and one UPDATE assignment"
  - "content accepts a JSON string only; null, numbers, objects and arrays raise invalid_field (documents.content is NOT a clearable column: begin inserts '' and readers expect text)"
  - "The content write sits in the write stage (runWrite in embed-write.ts), after the chunks are written, from ctx.work.parseText: the text the chunk stage consumed, after the injection scan (which never changes it). Resume reloads parseText from the parse.md artifact, so a resumed run writes the same text"
  - "An empty parse text (a picture) writes nothing, so the column stays ''"

requirements-completed: [DATA-01, DATA-02]

coverage:
  - id: D1
    description: "Unified ingestion stores the parsed text in documents.content; every corpus document's content equals the text the chunker consumed"
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-mode.test.mts#documents.content holds the parsed text of every document, the text the chunker consumed"
        status: pass
    human_judgment: false
  - id: D2
    description: "rag_set_document_fields stores content, keeps it when the key is absent, refuses non-text values, and refuses another tenant's document (single and multi-tenant)"
    requirement: DATA-02
    verification:
      - kind: integration
        ref: "tests/rag-db/ingest-writer.test.mts (3 new tests x 2 modes; the whitelist-rejection test no longer lists content)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The ingest-mode baseline is re-recorded (3 runs, spread 0) and both smoke gates pass; prechunked baseline untouched"
    verification:
      - kind: integration
        ref: "npm run test-rag -- --fixture-mode ingest; npm run test-rag (both gate PASS)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Migration 0319 applies to a production Supabase database"
    verification: []
    human_judgment: true
    rationale: "Only PGlite ran it; the operator applies it after 0318"

duration: about 25 min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 41a: documents.content under unified ingestion Summary

**Unified ingestion now stores the parsed text in documents.content (migration 0319 adds content to rag_set_document_fields; the write stage sets it once per version), which lifts ingest-mode recall@5 from 0.273 to 0.519 and makes it equal the prechunked mode.**

## Performance

- **Started:** 2026-11-24T09:05:00Z (approximate)
- **Completed:** 2026-11-24T09:31:00Z
- **Tasks:** 2 (Task 1 TDD)
- **Commits:** 3 (RED, GREEN, baseline), measured from the ledger base `694b696`

## Accomplishments

- Migration `0319_document_content.sql` replaces `rag_set_document_fields` with the 0314 definition plus `content` (string only). SECURITY DEFINER, `search_path`, tenant check, every other field, REVOKE and GRANT are as 0314 left them.
- `DocumentFields.content` in `writer.ts`; `runWrite` in `src/lib/rag/ingest/stages/embed-write.ts` calls `setFields(document.id, { content: ctx.work.parseText })` once, after all chunks are written. `parseText` is the parse result's text (BOM stripped) that the chunk stage consumed; the injection scan runs before and does not change it. A quarantined document carries it too (readers filter status).
- The write stage was chosen over `parse.ts` or `dedup.ts` because it is the single place after the scan where the text is final and where a resume reloads it from the stored `parse.md`.
- The ingest-mode baseline was re-recorded with `python -m rag_eval.baseline record --runs 3 --fixture-mode ingest`: 3 runs, spread 0.

## Ingest-mode metrics (overall, dev split, n=77 answerable / 9 no-answer)

| Metric | Before (03-41 baseline) | After 0319 | Prechunked (unchanged) |
|--------|------------------------|-----------|------------------------|
| recall@5 | 0.273 | 0.519 | 0.519 |
| recall@10 | 0.273 | 0.519 | 0.519 |
| MRR | 0.279 | 0.526 | 0.526 |
| false refusal | 0.701 | 0.377 | 0.377 |
| correct refusal | 0.667 | 0.333 | 0.333 |

Correct refusal falls from 0.667 to 0.333 (6 of 9 no-answer items refused before, 3 of 9 after): the relevance filter now keeps more chunks, so no-answer questions that were refused because the filter dropped everything now get context (not analysed per item). This is the same value the prechunked mode has always had, so it is not a regression against a good state; it does show that the no-answer slice is weak in both modes and is a target for the later layers. With the old ingest baseline the gate failed on exactly this metric (`correct_refusal_rate: observed 0.3333 vs threshold 0.6467`) until the baseline was re-recorded.

## Task Commits

1. **Task 1: Writer stores the parsed text in documents.content (TDD)**
   - RED `a221e30` (test): 2 of the 3 new writer tests and the ingest-mode content test fail on assertions (`content is an allowed field`: got `invalid_field: content`; `shipping-handbook.en.md content`: `''` against the parsed text). The third writer test (another tenant cannot set content) passes at RED because the tenant check runs before the allow-list; it is a guard for GREEN, not RED evidence.
   - GREEN `50493eb` (feat): migration, writer type, write stage, resume test update
2. **Task 2: Re-record the ingest-mode baseline** - `0094b01` (test)

## Files Created/Modified

See `key-files`. `eval/baselines/fixture-baseline.json` (prechunked) is unchanged.

## Deviations from Plan

**1. [Rule 1 - Test adjusted to the new behaviour] Two existing tests**
- `tests/rag-db/ingest-writer.test.mts` listed `content` among the keys the allow-list must refuse; it is removed from that list (new tests cover content).
- `tests/rag/ingest/runner.test.ts` ("resuming the same state twice") asserted zero `rag_set_document_fields` calls on a resume after `images`; it now expects exactly one call carrying `{ content: <parse text> }`, the same on both runs.
- Committed in `50493eb`.

**2. [Plan interpretation] File list**
- The plan lists `tests/rag-db/schema-migrations.test.mts` to "add 0319 the way earlier migrations are listed". No migration after 0306 is listed there by name: `migrationFiles()` globs the directory and the loader test checks ordering only, so 0319 is picked up with no edit. The file is unchanged.
- `tests/rag-db/ingest-mode.test.mts` and `tests/rag/ingest/runner.test.ts` are touched although not in the plan list. The plan asks for a test that ingests a text document and checks `documents.content`; `ingest-writer.test.mts` works at SQL level, so the end-to-end assertion lives in ingest-mode (which runs the real `ingest()`).

**Total deviations:** 2 (1 test adjustment, 1 interpretation). **Impact:** none beyond the plan's intent.

## Issues Encountered

- A document's whole parse text now travels in one `rag_set_document_fields` call. Chunk writes are batched to about 1 MB; this call is not. Legacy ingestion stores the same text in one insert, but request size limits of the Supabase API were not checked here, so a multi-megabyte text is worth watching. Not changed (no plan scope).
- `tests/rag/langfuse-pins.test.ts` did not fail here.

## Known Stubs

None.

## Threat Flags

None. The new key goes through the existing tenant check (a foreign tenant key raises `tenant_mismatch` before any write, tested in both deployment modes); the function keeps SECURITY DEFINER, pinned `search_path`, and service_role-only EXECUTE.

## Operator actions

- Apply `supabase/migrations/0319_document_content.sql` after 0318. Documents ingested before it have `content = ''`; re-ingesting (or a re-embed that rewrites fields) is needed for them to get text. No backfill is included.

## Gate Results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 157 files, 2352 passed |
| `node --import tsx --test tests/*.test.mts` | 145 passed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 382 tests: 379 passed, 0 failed, 3 skipped |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 787 files |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| `npm run test-rag -- --fixture-mode ingest` | gate PASS (7 skipped), recall@5 0.519 |
| `npm run test-rag` (prechunked) | gate PASS (7 skipped), recall@5 0.519 |
| `(cd eval && uv run --all-extras --frozen pytest -q)` | 367 passed |
| rag-sidecar pytest | not run, sidecar untouched |

## Self-Check: PASSED

`supabase/migrations/0319_document_content.sql` and this file exist; commits `a221e30`, `50493eb`, `0094b01` are ancestors of HEAD; ledger count 3.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
