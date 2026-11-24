---
phase: 03-unified-ingestion-embedding-profiles
plan: 44
subsystem: testing
tags: [ingest-mode, typed-fixtures, golden, DATA-02]

requires:
  - phase: 03-41
    provides: ingest fixture mode, ingest baseline slot, mergeGoldenFiles
  - phase: 03-25
    provides: manifest fixtures and expected facts

provides:
  - Typed manifest ingestion inside buildIngestFixtureDatabase with harness feature switches
  - PGlite success-criteria tests for criteria 1, 2, 4, 6, 7, 9
  - golden-ingest.jsonl + pytest contract check
  - Re-recorded fixture-ingest-baseline.json (3 runs)

affects: [03-45]

tech-stack:
  added: []
  patterns:
    - "ingestModeGoldenPaths returns corpus golden plus ingest-only golden-ingest.jsonl"
    - "buildIngestFixtureDatabase records sidecar uploads and LlamaParse attempt count on FixtureDatabase"

key-files:
  created:
    - tests/rag-db/ingest-typed-fixtures.test.mts
    - tests/rag-db/write-path-metadata-parity.test.mts
    - eval/fixtures/ingest/golden-ingest.jsonl
    - eval/tests/test_ingest_golden.py
  modified:
    - eval/harness/ingest-mode.mts
    - eval/harness/ingest-fakes.mts
    - eval/harness/pglite-supabase.mts
    - eval/baselines/fixture-ingest-baseline.json
    - tests/rag-db/ingest-mode.test.mts

key-decisions:
  - "Contract exception golden quote uses markdown blank line after 除外： to match eval/fixtures/ingest/text/contract-zh.md"
  - "Write-path parity test uses distinct markdown per source to avoid content_hash dedup skips"
  - "image_upload parity supplies options.imageUrl like production chat upload"

patterns-established:
  - "Typed fixture DB tests set embedQuery via setRagDepsForTests for runRetrieval after ingest-mode build"

requirements-completed: [DATA-02, DATA-03, DATA-04, DATA-05, DATA-09, DATA-10, DATA-11, CHK-01, CHK-02, SEC-01]

coverage:
  - id: D1
    description: "Typed fixtures demonstrate success criteria through buildIngestFixtureDatabase"
    requirement: DATA-09
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/ingest-typed-fixtures.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "All five write paths store matching chunk metadata"
    requirement: DATA-02
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/write-path-metadata-parity.test.mts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Ingest-only golden items and re-recorded ingest baseline"
    requirement: CHK-01
    verification:
      - kind: unit
        ref: "uv run --directory eval pytest -q tests/test_ingest_golden.py"
        status: pass
      - kind: integration
        ref: "npm run test-rag -- --fixture-mode ingest --out eval/out/ingest-typed"
        status: pass
    human_judgment: false

actuals:
  tokens: 95000
  tasks: 3
  commits: 3

duration: 90min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 44: Typed fixture ingest evidence Summary

**Ingest mode now ingests eval/fixtures/ingest/manifest.json with harness switches on, PGlite tests lock success criteria 1/2/4/6/7/9, and a 12-item golden-ingest baseline gates CI.**

## Accomplishments

- Extended `buildIngestFixtureDatabase` to run every manifest fixture after the corpus with unified pipeline, quarantine, PDF image chunks, and exact-id lookup; recorded sidecar uploads and LlamaParse attempts on `FixtureDatabase`.
- Added `tests/rag-db/ingest-typed-fixtures.test.mts` (9 assertions) and updated `ingest-mode.test.mts` so corpus rows stay isolated from typed PDFs.
- Added `tests/rag-db/write-path-metadata-parity.test.mts` for chat, config, Nango, scraper, and image_upload metadata parity.
- Authored `eval/fixtures/ingest/golden-ingest.jsonl` (12 approved items), `eval/tests/test_ingest_golden.py`, and re-recorded `eval/baselines/fixture-ingest-baseline.json`.

## Deviations from Plan

- Contract exception list is asserted via `lead_in` plus each manifest list item in one chunk (chunker prefixes `- ` on list lines); golden quote uses the markdown text spec blank line after the lead-in.

## Verification

```bash
node --import tsx --test tests/rag-db/ingest-typed-fixtures.test.mts tests/rag-db/ingest-mode.test.mts
node --import tsx --test tests/rag-db/write-path-metadata-parity.test.mts
uv run --directory eval pytest -q tests/test_ingest_golden.py
npm run test-rag -- --fixture-mode ingest --out eval/out/ingest-typed
npm run test-rag -- --out eval/out/p3-prechunked-2
```

Prechunked gate: `paired.all_zero == true`. Ingest gate: `passed == true`.

## Commits

| Task | SHA | Message |
|------|-----|---------|
| 1 | `77ee195` | feat(03-44): typed ingest fixtures and success-criteria PGlite tests |
| 2 | `46da393` | test(03-44): write-path chunk metadata parity across five sources |
| 3 | `35b2404` | feat(03-44): ingest golden items, contract test, and re-recorded baseline |