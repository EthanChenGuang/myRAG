---
phase: 03-unified-ingestion-embedding-profiles
plan: 18
subsystem: ingestion
tags: [ingest, extractors, metadata, doc-date, processing-profile, temporal, financial]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "extract stage skeleton warning extractor_unavailable (03-13b), stage runner, writer.setFields and the 0310 rag_set_document_fields RPC (03-13, 03-03), processing profiles with extractors lists (03-02)"
provides:
  - "EXTRACTORS registry (dates, financial) and runChunkExtractors in src/lib/rag/ingest/extractors"
  - "Per-chunk temporal and financial metadata with the same values storeDocument computes, generic keys on every chunk"
  - "Document date (doc_date) from the highest-confidence full date, written once through writer.setFields"
affects: [03-17, 03-29, 03-16, 03-28]

actuals:
  tokens: 6500
  tasks: 2
  commits: 3

plan_head_before: 63a758b1dad8537a16d286c4c17692ff5a2d3931
plan_head_after: bf05d0dff74fef2b44bded5a6fd90aa188deea67

tech-stack:
  added: []
  patterns:
    - "extractEnhancedMetadata runs once per chunk (computeEnhancedMetadata in financial.ts); each extractor keeps its own keys, generic keys are always written"
    - "Stage reads profile.extractors only; an extractor without an implementation is reported as extractor_unavailable:<name>"

key-files:
  created:
    - src/lib/rag/ingest/extractors/index.ts
    - src/lib/rag/ingest/extractors/dates.ts
    - src/lib/rag/ingest/extractors/financial.ts
    - tests/rag/ingest/extractors.test.ts
  modified:
    - src/lib/rag/ingest/stages/extract.ts
    - tests/rag/ingest/runner.test.ts

key-decisions:
  - "Generic keys (section_type, key_terms, chunk_semantic_type) are written on every chunk whatever the profile lists, because storeDocument writes them for every document and legacy ranking reads them"
  - "doc_date candidates come from a separate full-date reader, not from the legacy temporal entities, which hold years, quarters, months and unnormalised slash dates but no Chinese or ISO full dates"
  - "A slash date is read only when one reading is impossible (day over 12) or both parts are equal; 03/04/2025 yields no candidate rather than a guess"
  - "doc_date choice: highest confidence (ISO and CJK 0.95, month name 0.9, slash 0.85), then earliest chunk, then earliest position"

requirements-completed: [DATA-02, DATA-04]

coverage:
  - id: D1
    description: "dates and financial write the same keys and values storeDocument computes for every chunk text of the eval fixture corpus, with generic keys on every chunk"
    requirement: DATA-02
    verification:
      - kind: unit
        ref: "tests/rag/ingest/extractors.test.ts#dates and financial write exactly the keys storeDocument computes for every fixture corpus chunk text"
        status: pass
    human_judgment: false
  - id: D2
    description: "The document date is the highest-confidence full date found, written once with writer.setFields and mirrored onto chunks by the writer; none is written when the text holds no full date"
    requirement: DATA-02
    verification:
      - kind: unit
        ref: "tests/rag/ingest/extractors.test.ts#doc_date is written once through setFields and the stage writes none when the text holds no full date"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/extractors.test.ts#pickDocDate takes the highest confidence and breaks ties by chunk order then position"
        status: pass
    human_judgment: false
  - id: D3
    description: "Which extractors run is read from profile.extractors: general gets temporal keys, financial_report both, product_technical neither; no extractor_unavailable remains for dates or financial; invoice stays pending"
    requirement: DATA-04
    verification:
      - kind: unit
        ref: "tests/rag/ingest/extractors.test.ts#extract stage"
        status: pass
      - kind: unit
        ref: "tests/rag/ingest/runner.test.ts#extract records extractor_unavailable only for profile extractors without an implementation and leaves urls to enrich"
        status: pass
      - kind: other
        ref: "node scripts/ci/check-rag-boundary.mjs"
        status: pass
    human_judgment: false

duration: not measured
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 18: Profile-selected metadata extractors Summary

**The extract stage now runs the dates and financial extractors named in profile.extractors, giving each chunk the same temporal and financial metadata storeDocument writes today and setting the document's doc_date from the highest-confidence full date**

## Performance

- **Duration:** not measured (the start time was not recorded)
- **Completed:** 2026-11-24
- **Tasks:** 2 (both TDD; three commits)
- **Files:** 4 created, 2 modified, 488 insertions, 10 deletions

## Accomplishments
- `EXTRACTORS` maps `dates` and `financial` to functions; `runChunkExtractors(names, chunk)` calls `extractEnhancedMetadata` once and keeps each listed extractor's keys plus the generic keys. Dates writes `temporal_entities`, `temporal_density`, `has_temporal_data`; financial writes `financial_entities`, `numerical_density`, `has_financial_data`, `is_high_value_chunk`; `section_type`, `key_terms`, `chunk_semantic_type` are on every chunk. Over every paragraph of the eval fixture corpus (en, it, zh) the output equals a restatement of storeDocument's key expressions.
- Full-date reader for doc_date: ISO and `YYYY/M/D`, `YYYY年M月D日`, `March 15, 2025`, `15 March 2025`, Italian month names (`1° marzo 2025`), and slash dates when unambiguous. Impossible calendar dates, bare years, quarters and months are not candidates. `报告期为2025年3月15日至2025年6月30日` gives 2025-03-15 and 2025-06-30; the first is chosen.
- The extract stage merges the metadata into each chunk, picks the document date with `pickDocDate` and writes it once with `writer.setFields`; `rag_set_document_fields` mirrors it onto chunks and `rag_write_chunks` reads it from the document. The stage has no doc-type comparison: general (dates, urls), financial_report (dates, financial) and product_technical (urls) differ only by data.
- `invoice` remains `extractor_unavailable:invoice` with the stage marked as a fallback, for plan 03-29. `urls` is still left to enrich.

## Task Commits

1. **Task 1: Dates and financial extractors with storeDocument parity (TDD)**
   - RED: `f689e1a` (test)
   - GREEN: `93bb3f7` (feat)
2. **Task 2: Extract stage runs the profile's extractors and sets doc_date (TDD)**
   - RED: the stage tests were written in `f689e1a` together with Task 1's and failed on assertions there and after Task 1's GREEN
   - GREEN: `bf05d0d` (feat)

**Plan metadata:** committed after this file (docs: complete plan)

## Files Created/Modified
- `src/lib/rag/ingest/extractors/index.ts` - EXTRACTORS, runChunkExtractors, hasExtractor, DateCandidate and extractor types
- `src/lib/rag/ingest/extractors/dates.ts` - temporal keys, full-date reader, pickDocDate
- `src/lib/rag/ingest/extractors/financial.ts` - financial keys and `computeEnhancedMetadata` (the single extractEnhancedMetadata call)
- `src/lib/rag/ingest/stages/extract.ts` - runs profile extractors, merges metadata, sets doc_date
- `tests/rag/ingest/extractors.test.ts` - 15 tests (10 extractor, 5 stage)
- `tests/rag/ingest/runner.test.ts` - the old extractor_unavailable test updated to the new behaviour

## Decisions Made
See `key-decisions`. The first one matters for ranking: `section_type`, `key_terms` and `chunk_semantic_type` are never profile-dependent. A product_technical document does lose the temporal and financial keys that storeDocument wrote for it, as the plan specifies.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Existing runner test asserted the behaviour this plan removes**
- **Found during:** Task 2
- **Issue:** `tests/rag/ingest/runner.test.ts` expected `extractor_unavailable:dates` and `:financial`; the plan's own truth ("no extractor_unavailable warning remains for dates or financial") contradicts it, and the plan's verify command runs that file.
- **Fix:** The test now expects no `extractor_unavailable` for general and financial_report and `extractor_unavailable:invoice` for invoice_receipt.
- **Files modified:** tests/rag/ingest/runner.test.ts
- **Committed in:** `bf05d0d`

**2. [Rule 2 - Missing Critical] Full-date reader added beside the legacy extractor**
- **Found during:** Task 1
- **Issue:** the legacy temporal entities carry no ISO or Chinese full dates and leave slash dates ambiguous (day-first or month-first), so doc_date could not be taken from them without guessing.
- **Fix:** `findDateCandidates` in dates.ts reads full dates and refuses ambiguous slash dates and impossible calendar dates. The legacy `temporal_entities` values are untouched, so parity holds.
- **Files modified:** src/lib/rag/ingest/extractors/dates.ts
- **Committed in:** `93bb3f7`

**3. [Plan interpretation] Task 2 has no RED commit of its own**
- The stage tests went into the Task 1 RED commit. They failed on assertions at `f689e1a` and still failed (5 of 15) after Task 1's GREEN, so the RED evidence for Task 2 is that run.

**4. [Plan interpretation] Where the extractEnhancedMetadata call lives**
- The acceptance grep requires `extractEnhancedMetadata` in financial.ts or dates.ts, and the plan says to call it once per chunk. `computeEnhancedMetadata` in financial.ts is that one call; index.ts passes its result to every extractor.

---

**Total deviations:** 4 (1 bug, 1 missing critical, 2 plan interpretations)
**Impact on plan:** no scope creep; one extra test edit outside the file list.

## TDD Gate Compliance

- **RED (`f689e1a`):** 15 of 15 tests failed on assertions against inert extractor stubs (for example `expected {} to deeply equal { temporal_entities: [...] }`, `expected [] to have a length of 1 but got +0`, `expected [...] to not include 'extractor_unavailable:dates'`). The stubs are what let the file load, so none failed on a missing module. Semantic assessment: each failure was the planned behaviour being absent; none was an import, syntax or fixture fault.
- **GREEN:** Task 1 (`93bb3f7`) turned 10 unit tests green; Task 2 (`bf05d0d`) turned the remaining 5 stage tests green.
- **Classifier:** `gsd_run check tdd-red-evidence` was not run. `workflow.tdd_mode` is not enabled here and 03-13b found the classifier rejects vitest's TAP output. The assessment is manual, from the vitest output.

## Issues Encountered
None.

## Gate Results

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 125 files, 1617 tests passed |
| `npx vitest run tests/rag/ingest/extractors.test.ts tests/rag/ingest/runner.test.ts` | 30 passed, 0 failed (extractors: 15) |
| `node --import tsx --test tests/*.test.mts` | 143 passed, 0 failed |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 690 files, no violations |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest | not run, sidecar untouched |
| `tests/rag-db/*.test.mts` | not run (needs the database); the tracer test there runs a general-profile upload and now also sees temporal keys and a doc_date |

Acceptance greps: `extractEnhancedMetadata` in financial.ts plus dates.ts 3 (EXPECT >=1); `profile.extractors` in extract.ts 2 (EXPECT >=1); extractors tests 15 passed (EXPECT >=5). No doc-type comparison in the stage or the extractors; no model identifier added; the extractors log nothing.

## Threat Surface
T-03-53: the extractor patterns are bounded (fixed-width digit groups, no nested quantifiers), run on one chunk at a time, and the candidate list is capped at 50 per chunk. T-03-SC: no package changes. No new endpoint, auth path or schema.

## Known Stubs
None. `invoice` is a planned hand-off to plan 03-29 and is reported as `extractor_unavailable:invoice`.

## User Setup Required
None - no external service configuration, environment variable, migration or package change.

## Next Phase Readiness
- Plan 03-17's rehydrator must rerun `extract` as well as `chunk` and `enrich` when it resumes after `lastCompleted` is `extract` or later: the chunk metadata this stage adds lives only in memory. doc_date itself is already on the document row.
- Plan 03-29 adds `invoice` to `EXTRACTORS`; `hasExtractor` then turns the warning off with no stage change.

## Self-Check: PASSED

All four created files exist on disk. Commits `f689e1a`, `93bb3f7` and `bf05d0d` are ancestors of HEAD; the measured count from the ledger is 3.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
