---
phase: 03-unified-ingestion-embedding-profiles
plan: 19
subsystem: ingestion
tags: [chunking, legal-clauses, table-aware, docling-chunks, section-path, tiktoken, vitest]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "ingest() stage runner and the Markdown section chunker (03-13); stage registry, deadline and state persistence (03-13b); embedding text and cl100k_base token helpers (03-06); processing profiles with clause_patterns and lead_in_phrases as data (03-02); ParseResult contract with Docling chunks (03-02, 03-15)"
provides:
  - "chunkDocument(chunker, parse) and the CHUNKERS map in src/lib/rag/ingest/chunkers/index.ts, dispatching on profile.chunker.kind"
  - "chunkTableAware: rows never cut, header and separator on every piece of a split table, oversized_table_row warning"
  - "chunkLegalClauses: D-25 clause patterns from profile data, exception lead-in kept with its list, over-long clauses split at items with the heading on every piece"
  - "Docling chunk consumption (headings, pages, is_table, plain text) under markdown_sections and table_aware; legal_clauses always chunks the Markdown"
  - "IngestWork.parseChunks, the optional slot a Docling parse stage fills"
affects: [03-17, 03-27, 03-29, 03-32, 03-41]

tech-stack:
  added: []
  patterns:
    - "A chunker returns { chunks, warnings }; the chunk stage de-duplicates the warning codes into ctx.warnings"
    - "Chunker kinds are registered in one map; a kind with no entry raises ChunkerUnavailableError and the stage reports chunker_unavailable"
    - "Clause patterns are data: compiled once per source string with the u flag, applied to the first 200 characters of each line and accepted only when the match starts at the line start"

key-files:
  created:
    - src/lib/rag/ingest/chunkers/index.ts
    - src/lib/rag/ingest/chunkers/markdown-tables.ts
    - src/lib/rag/ingest/chunkers/table-aware.ts
    - src/lib/rag/ingest/chunkers/legal-clauses.ts
    - tests/rag/ingest/table-aware.test.ts
    - tests/rag/ingest/legal-clauses.test.ts
    - tests/rag/ingest/chunk-dispatch.test.ts
  modified:
    - src/lib/rag/ingest/chunkers/markdown-sections.ts
    - src/lib/rag/ingest/stages/chunk.ts
    - src/lib/rag/ingest/types.ts

key-decisions:
  - "Clause rank is by marker family: article-like (第X条, Art., Article, Articolo) above numbered (1. above 1.1 above 1.1.1) above bracketed (（一）). A heading ranked below the open clause is an item of it, so （一）, a., 1.1 inside a 第5条 stay in that clause, while a document with only numbered headings still gets one chunk per top-level number"
  - "A clause pattern counts only when its match starts at the line start (after at most three spaces). The D-25 pattern 第X条 is not anchored in the data, so without this rule a cross-reference such as 依据第5条的规定 would start a clause"
  - "Chapter headings are Markdown headings that are not clause headings plus plain 第X章 lines (outer level 2). A Markdown heading whose title matches a clause pattern, for example the fixture's '## 第一条 服务范围', is a clause heading with the hashes removed"
  - "A table chunk is chunk_kind table only when everything in it is table; a small table packed with its paragraphs is text, the same rule markdown_sections already applies"
  - "A heading longer than a quarter of max_tokens is labelled by its marker (第5条) in section_path and on continuation pieces; the first piece still starts with the original line. This keeps a one-line clause from eating the budget of its own path prefix"
  - "The chunk stage fails with chunker_unavailable for invoice and image_caption instead of the earlier silent markdown fallback, as the plan specifies; only invoice_receipt profiles are affected, and only under the unified pipeline"

patterns-established:
  - "Docling chunks are the preferred source for markdown_sections and table_aware; contract_legal ignores them (research P-5)"
  - "max_tokens bounds the embedding text (path prefix plus content) in every TypeScript chunker; overlap_tokens applies to prose only (table pieces and clause pieces have none)"

requirements-completed: [CHK-01, CHK-02, DATA-05]

actuals:
  tokens: 15700
  tasks: 3
  commits: 6

plan_head_before: 63a758b1dad8537a16d286c4c17692ff5a2d3931
plan_head_after: 9c9e300193e0c1d4caf0f887e4d21d6a517f0779

coverage:
  - id: D1
    description: "A Markdown table larger than max_tokens is split by rows with the header and separator rows on every piece, no row cut, every piece within max_tokens on the embedding text, every piece chunk_kind table; a row longer than max_tokens becomes its own chunk with the header and the oversized_table_row warning"
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "tests/rag/ingest/table-aware.test.ts#splits a 40-row table by rows, repeats the header and separator on every piece and respects max_tokens"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/table-aware.test.ts#gives a row longer than max_tokens its own chunk with the header and warns oversized_table_row"
        status: pass
    human_judgment: false
  - id: D2
    description: "A small table stays in one chunk with its paragraphs when it fits; text around tables is chunked exactly as markdown_sections does; pipes in code fences are text"
    requirement: CHK-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/table-aware.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "A zh, en or it clause with an exception lead-in and its list is one chunk when it fits, with section_path [chapter, clause heading]; numbered, bracketed and article headings are recognised and a digit without a following space is not a heading"
    requirement: CHK-02
    verification:
      - kind: unit
        ref: "tests/rag/ingest/legal-clauses.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "An over-long clause is split at item boundaries, every piece starts with the clause heading, carries the same section_path and repeats the lead-in; a single over-long item falls back to sentence splits with the heading repeated; patterns and lead-in phrases come from the profile data"
    requirement: CHK-02
    verification:
      - kind: unit
        ref: "tests/rag/ingest/legal-clauses.test.ts#splits an over-long clause at item boundaries with the heading and lead-in on every piece"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/legal-clauses.test.ts#falls back to sentence splits with the heading repeated for a single over-long item"
        status: pass
    human_judgment: false
  - id: D5
    description: "The chunk stage dispatches on profile.chunker.kind through CHUNKERS, uses Docling chunks (headings, pages, is_table, plain text) under markdown_sections and table_aware, ignores them under legal_clauses, and fails with chunker_unavailable for invoice and image_caption"
    requirement: DATA-05
    verification:
      - kind: unit
        ref: "tests/rag/ingest/chunk-dispatch.test.ts"
        status: pass
      - kind: integration
        ref: "tests/rag-db/ingest-tracer.test.mts"
        status: pass
    human_judgment: false
  - id: D6
    description: "Retrieval quality of table and clause chunks on the contract and table fixtures (golden item for the exceptions list, table header on every chunk in the recorded Docling fixtures)"
    requirement: CHK-02
    verification: []
    human_judgment: true
    rationale: "Proven by the ingest-mode eval run owned by plans 03-25 and 03-41, which need the recorded fixtures; this plan only proves the chunkers on synthetic text"

duration: 19min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 19: Legal and Table-Aware Chunkers Summary

**Table-aware chunker that never cuts a row and repeats the header on every split piece, a clause-aware legal chunker that keeps exception lists whole and names the clause on every piece, and profile-kind dispatch in the chunk stage that also consumes Docling's own chunks**

## Performance

- **Duration:** 19 min
- **Started:** 2026-11-24T02:40:24Z
- **Completed:** 2026-11-24T02:59:59Z (before this file's commit)
- **Tasks:** 3 (all TDD; six commits)
- **Files:** 7 created, 3 modified, 1181 insertions, 127 deletions

## Accomplishments
- `markdown-tables.ts` splits a section into text blocks and GFM tables (header plus separator plus rows, or a headerless run of pipe rows) and leaves pipes inside code fences alone. `table-aware.ts` packs rows under the repeated header against the embedding-text budget, keeps a table that fits whole (sharing a chunk with its paragraphs), gives an over-budget row its own chunk with the header and the `oversized_table_row` warning, and hands every non-table span to the section chunker.
- `legal-clauses.ts` reads the D-25 patterns and lead-in phrases from the profile data, builds the outer `section_path` from Markdown headings and 第X章 lines with the clause heading last, keeps a clause that fits as one chunk (lead-in and whole list included), and otherwise splits at item boundaries with the heading on every piece and the lead-in repeated on pieces that hold items of its list. One item longer than the budget falls back to sentence splits. Text before the first clause is chunked as ordinary sections.
- `chunkers/index.ts` holds `CHUNKERS` and `chunkDocument`. Under `markdown_sections` and `table_aware` Docling chunks win when present (headings as `section_path`, min and max page, `is_table` as `chunk_kind table`, plain `text` not `contextualized_text`); under `legal_clauses` they are ignored (research P-5). The chunk stage now calls `chunkDocument`, surfaces chunker warnings and fails with `chunker_unavailable` for `invoice` and `image_caption`.
- The section chunker's per-section body is now exported as `chunkSection` (no behaviour change; its seven tests pass untouched), which is what the other two chunkers build on.

## Task Commits

1. **Task 1: Markdown table parsing and the table-aware chunker (TDD)**
   - RED: `501e320` (test)
   - GREEN: `d2e1376` (feat)
2. **Task 2: The legal clause chunker (TDD)**
   - RED: `77271ca` (test)
   - GREEN: `bf7375b` (feat)
3. **Task 3: Kind-based dispatch and Docling chunk consumption (TDD)**
   - RED: `6774380` (test)
   - GREEN: `9c9e300` (feat)

**Plan metadata:** the commit that adds this file (docs: complete plan). `commits: 6` is measured from the plan ledger base `63a758b`.

## Files Created/Modified
- `src/lib/rag/ingest/chunkers/index.ts` - `CHUNKERS`, `chunkDocument`, `ChunkerUnavailableError`, Docling chunk conversion
- `src/lib/rag/ingest/chunkers/markdown-tables.ts` - `splitTableBlocks`
- `src/lib/rag/ingest/chunkers/table-aware.ts` - `chunkTableAware`
- `src/lib/rag/ingest/chunkers/legal-clauses.ts` - `chunkLegalClauses`
- `src/lib/rag/ingest/chunkers/markdown-sections.ts` - exports `chunkSection`, `splitSections`, `hardSplit`, `HEADING`, `FENCE`, sentence regexes
- `src/lib/rag/ingest/stages/chunk.ts` - calls `chunkDocument`, `chunker_unavailable`, warnings
- `src/lib/rag/ingest/types.ts` - `ChunkResult`, optional `IngestWork.parseChunks`
- `tests/rag/ingest/table-aware.test.ts` (7), `legal-clauses.test.ts` (9), `chunk-dispatch.test.ts` (8)

## Decisions Made
See `key-decisions` above. The two that later plans rely on: Docling chunks reach the chunk stage only through `ctx.work.parseChunks`, and an unregistered chunker kind is a hard stage failure (`chunker_unavailable`), not a fallback.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Edits to `types.ts` and `markdown-sections.ts`, neither in the plan's file list**
- **Found during:** Tasks 1 and 3
- **Issue:** Chunkers need a shared `{ chunks, warnings }` result for `oversized_table_row`, the stage needs somewhere to read Docling chunks from, and the table and legal chunkers must reuse the section chunker's per-section packing rather than copy it.
- **Fix:** Additive only. `types.ts` gains `ChunkResult` and an optional `IngestWork.parseChunks` (optional, so the three existing `work` literals in src and tests still compile). `markdown-sections.ts` exports its helpers and splits `chunkMarkdownSections` into a loop over a new exported `chunkSection`.
- **Verification:** `tests/rag/ingest/markdown-sections.test.ts` (7) and `tests/rag-db/ingest-tracer.test.mts` (10) pass unchanged; `tsc` 0 errors.
- **Committed in:** `501e320`, `d2e1376`, `bf7375b`, `9c9e300`

**2. [Rule 2 - Missing Critical] Heading-length cap and a bounded match window in the legal chunker**
- **Found during:** Task 2
- **Issue:** A one-line clause (第5条 followed by the whole clause text on the same line, common in Chinese contracts) would make its own `section_path` element huge and starve the content budget; a hostile very long line would be scanned in full by an unanchored pattern (threat T-03-54).
- **Fix:** A heading above a quarter of `max_tokens` is labelled by its marker in `section_path` and on continuation pieces; each line is matched on its first 200 characters only.
- **Verification:** `legal-clauses.test.ts#keeps a one-line clause that is longer than the heading allowance within the budget`.
- **Committed in:** `bf7375b`

**3. [Plan interpretation] `multiline` flag not used for clause patterns**
- The plan says to compile `^` patterns multiline. Patterns here are applied one line at a time, so `^` already anchors to the line and the flag would change nothing; they are compiled with `u` only, like `getClausePatterns` in the profile loader.

---

**Total deviations:** 3 (1 blocking, 1 missing-critical, 1 interpretation)
**Impact on plan:** No scope creep; every change serves a must-have truth or a listed threat.

## TDD Gate Compliance

All three tasks have a `test(03-19)` commit followed by a `feat(03-19)` commit; no refactor commits.

- **Task 1 RED (`501e320`):** 7 of 7 tests failed on assertions (for example `expected [] to have a length of 1 but got +0`, `expected [] to deeply equal [ 'oversized_table_row' ]`). Semantic assessment: each failing test exercised the planned behaviour against an inert stub; none failed on an import, syntax or fixture fault.
- **Task 2 RED (`77271ca`):** 9 of 9 failed on assertions (`expected [] to deeply equal [ [ '1. Definitions' ], [ '2. Term' ] ]`, `expected 0 to be greater than 2`). Same assessment.
- **Task 3 RED (`6774380`):** 7 of 8 failed on assertions (`expected { kind: 'next' } to deeply equal { kind: 'fail', ... }`, `expected [ 'chunker_fallback:table_aware' ] to deeply equal [ 'oversized_table_row' ]`); the eighth (stage fills metadata for the `general` profile) passed already and is a regression pin.
- **Stubs:** the RED commits carry inert stubs of `markdown-tables.ts`, `table-aware.ts`, `legal-clauses.ts` and `chunkers/index.ts` so the tests load and fail on assertions, not module-not-found.
- **Classifier:** `gsd_run check tdd-red-evidence` was not run. 03-13b recorded `INVALID_RED (invalid_record)` for vitest's TAP output in this project, and `workflow.tdd_mode` is not enabled, so the assessment is manual, from the vitest output of each RED commit.
- GREEN passed first run in each task. I checked the legal chunker's actual output on a sample contract by hand (heading, lead-in and items per piece) in addition to the assertions.

## Issues Encountered
- Pre-existing `no-unused-vars` warnings on type-only parameter names in `deps.ts` and `trace.ts` (not touched here). The new files use `_`-prefixed names in function types to stay clean.

## Gate Results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `npx vitest run` | 127 files, 1626 tests passed |
| `node --import tsx --test tests/*.test.mts` | 143 passed, 0 failed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 160 tests: 157 passed, 0 failed, 3 skipped (single-tenant variants skipped by design in earlier plans) |
| `node --import tsx --test tests/rag-db/ingest-tracer.test.mts` | 10 passed |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 693 files, no violations |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest | not run, sidecar untouched |
| `tests/rag/langfuse-pins.test.ts` | passed here, no ENOENT |

Acceptance: `grep -c "lead_in_phrases\|clause_patterns"` on `legal-clauses.ts` is 4 (EXPECT >=2); `grep -c "CHUNKERS"` on `chunkers/index.ts` is 2 (EXPECT >=1); `table-aware.test.ts` 7 passed (EXPECT >=4); `legal-clauses.test.ts` 9 passed (EXPECT >=7); `chunk-dispatch.test.ts` 8 passed (EXPECT >=4). `chunkDocument` is called from `stages/chunk.ts`. No doc-type comparison in the stage or the chunkers (boundary check passes). No model identifiers added.

## Threat Surface
T-03-54 (clause patterns on hostile text): patterns come from the validated profile data, are compiled once per source string, applied per line and only to its first 200 characters, and accepted only at the line start. No new network, auth or file surface.

## User Setup Required

None - no external service configuration, environment variable, migration or package change.

## Known Stubs

None. `IngestWork.parseChunks` is an intentional empty slot: nothing fills it until a Docling parse stage lands (the parse stage in `stages/parse.ts` handles text only today), so every document currently takes the Markdown chunkers, which is today's behaviour. I added no `.planning/WINDOWS.md` entry because it is a planned hand-off, not a defect.

## Next Phase Readiness
- The Docling parse stage (03-27, sidecar Docling client in `parse.ts`) must set `ctx.work.parseChunks` from `ParseResult.chunks`. Plan 03-17's rehydrate step recomputes `chunk` from `parse.md`; if it should reproduce Docling-chunked output on resume, it also has to restore the chunks (for example from the stored parse result), otherwise a resumed Docling document is re-chunked from the Markdown.
- 03-29 and 03-32 register `invoice` and `image_caption` in `CHUNKERS`; until then those kinds fail the chunk stage with `chunker_unavailable`.
- 03-25 and 03-41 can now check the table-header and exception-list success criteria end to end on the recorded fixtures.

## Self-Check: PASSED

All seven created files exist on disk. Commits `501e320`, `d2e1376`, `77271ca`, `bf7375b`, `6774380` and `9c9e300` are ancestors of HEAD; the measured count from the ledger is 6.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
