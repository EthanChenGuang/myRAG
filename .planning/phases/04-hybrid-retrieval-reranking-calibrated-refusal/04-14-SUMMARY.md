---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 14
subsystem: api
tags: [rag, zod, filters, temporal, language]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: detectLanguage in src/lib/rag/lang/detect.ts
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: RetrievalFiltersSchema from plan 04-04
provides:
  - parseRetrievalFilters and buildRetrievalFilters for D-05 narrow-only filters
  - timeframeToDateRange for trace-only derived_date_range (F-4)
  - queryLanguage wrapping detectLanguage for refusal cells (A-4)
affects:
  - 04-20 analyze stage wiring
  - 04-21 chat/embed body validation

actuals:
  tokens: 12000
  tasks: 2
  commits: 4
plan_head_before: e9e6e44fc4b9a816a617a8707a97695bf574da82
plan_head_after: 9ba98f2

tech-stack:
  added: []
  patterns:
    - "CamelCase request body validated, mapped once to snake_case RetrievalFiltersSchema"
    - "buildRetrievalFilters intersects explicit and referenced document ids"

key-files:
  created:
    - src/lib/rag/query/filters.ts
    - src/lib/rag/query/timeframe.ts
    - src/lib/rag/query/language.ts
    - tests/rag/query/filters.test.ts
    - tests/rag/query/timeframe.test.ts
    - tests/rag/query/language.test.ts
  modified: []

key-decisions:
  - "Empty filter arrays and inverted date ranges fail before RetrievalFiltersSchema; unrecognized_keys map to the offending camelCase field path"
  - "timeframeToDateRange stays pure and trace-only; explicit retrievalFilters.dateRange remains separate"

patterns-established:
  - "Query-side helpers live under src/lib/rag/query/ and export narrow pure functions for the v2 analyze stage"

requirements-completed: [DATA-08, XLG-03]

coverage:
  - id: D1
    description: "parseRetrievalFilters validates optional retrievalFilters with structured 400 issues"
    requirement: DATA-08
    verification:
      - kind: unit
        ref: "tests/rag/query/filters.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "buildRetrievalFilters narrows document ids and always sets currentOnly"
    requirement: DATA-08
    verification:
      - kind: unit
        ref: "tests/rag/query/filters.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "timeframeToDateRange maps analyzer timeframes without becoming a SQL filter"
    requirement: DATA-08
    verification:
      - kind: unit
        ref: "tests/rag/query/timeframe.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "queryLanguage reuses detectLanguage with >=90% golden agreement"
    requirement: XLG-03
    verification:
      - kind: unit
        ref: "tests/rag/query/language.test.ts"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 14: Query filters, timeframe, language Summary

**Zod-validated retrieval filter parsing with narrow-only build logic, trace-only timeframe ranges, and a single shared queryLanguage detector.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2/2
- **Commits:** 3 on `exec/04-14`

## Accomplishments

- `parseRetrievalFilters` accepts camelCase chat/embed bodies, rejects empty lists and unknown keys, and validates through `RetrievalFiltersSchema`.
- `buildRetrievalFilters` always sets `currentOnly: true`, intersects explicit and referenced `documentIds`, and copies explicit scalar filters only.
- `timeframeToDateRange` parses years, quarters, Chinese months, en/it month names, and explicit ISO spans for trace metadata.
- `queryLanguage` delegates to `detectLanguage` and meets the golden agreement floor in tests.

## Deviations from Plan

None — plan executed as written.

## Self-Check: PASSED

- FOUND: src/lib/rag/query/filters.ts
- FOUND: src/lib/rag/query/timeframe.ts
- FOUND: src/lib/rag/query/language.ts
- FOUND: tests/rag/query/filters.test.ts
- FOUND: tests/rag/query/timeframe.test.ts
- FOUND: tests/rag/query/language.test.ts
- FOUND commit ab6ed0d
- FOUND commit 3d4f620
- FOUND commit fc57d41