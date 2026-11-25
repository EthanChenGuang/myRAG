---
phase: 06-query-layer-llamaindex-langchain
plan: 24
subsystem: rag-query-layer
tags: [relative-dates, include-undated, dense-suffix, pgvector, d-11, a-6]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: 06-06 normalizeRelativeDates, 06-08 migration 0602 p_include_undated, 06-11 RetrievalFilters.include_undated contract, 06-13 mergeLayerDateRange and dateRange.includeUndated, 06-20 QueryVariant.denseText and variantDenseTexts
  - phase: 04-hybrid-retrieval-reranking
    provides: 04-17 pgvector adapter
provides:
  - p_include_undated passthrough in src/lib/rag/backend/pgvector.ts (only when the merged filter keeps undated rows)
  - denseDateSuffix(from, to) in src/lib/rag/query/dates.ts
  - planToVariants sets denseText on the original and condensed variants when the plan has a date range
affects: [06-25, 06-32]

actuals:
  tokens: 40000
  tasks: 2
  commits: 4
plan_head_before: aae1f56

tech-stack:
  added: []
  patterns:
    - "Optional RPC arguments are spread in only when set, so callers that do not use them send the Phase 4 argument object unchanged"

key-files:
  created:
    - tests/rag-db/query-dates-undated.test.mts
  modified:
    - src/lib/rag/backend/pgvector.ts
    - src/lib/rag/query/plan.ts
    - src/lib/rag/query/dates.ts
    - tests/rag/backend/pgvector-adapter.test.ts
    - tests/rag/v2/variants-fusion.test.ts

requirements-completed: [LAT-03]
---

# Phase 6 Plan 24: Relative-date range end to end

The query layer's relative-date range now reaches SQL with undated rows kept, and the dense leg embeds the absolute dates.

## Commits
| Task | Commit |
|------|--------|
| 1 RED | `989f915` test(06-24): add failing tests for p_include_undated passthrough and the dense date suffix |
| 1 GREEN | `7e72a16` feat(06-24): pass p_include_undated to hybrid_search_chunks and append the dates to the dense query |
| 2 | `af636b0` test(06-24): relative-date retrieval on PGlite keeps undated chunks of the tenant only |

## Behaviour changes
Everything sits behind `RAG_QUERY_LAYER=true` under `RAG_PIPELINE=v2`. Off is unchanged.
- The pgvector adapter adds `p_include_undated: true` only when `filters.dateRange.includeUndated === true`. Only `mergeLayerDateRange` sets that flag. Every other call sends exactly the Phase 4 argument object; the test deep-equals it with `toStrictEqual`.
- With a plan date range, `planToVariants` sets `denseText = text + " (YYYY-MM-DD to YYYY-MM-DD)"` on the original and condensed variants. `text` is unchanged, so lexical tokens (`queryLexicalTokens(variant.text)`) and rerank text are unchanged. Expanded, HyDE and sub-question variants get no suffix.

## Tests that failed before the fix
- RED `989f915`: the adapter flag test (`p_include_undated` undefined) and the dense-suffix test (no `denseText`) failed on assertions.
- `query-dates-undated.test.mts` with the old adapter (pgvector.ts from `989f915`): 3/3 failed on assertions because the tenant's undated chunk was missing. With the fix: 3/3 pass.

## Gate results
| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 388 files, 6504 passed, 4 skipped |
| `node --import tsx --test tests/*.test.mts` | 172 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1967 pass, 0 fail, 4 skipped |
| `check-rag-boundary` + node test | ok (1443 files), 52 pass |
| `node scripts/check-config.mjs` | ok, 190 variables |
| `check-workflows.py` | OK |
| `npm run test-rag -- --out eval/out/06-24` | gate PASS (7 skipped) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/06-24-ingest` | gate PASS (7 skipped) |
| Python, `gen:schemas`, frontend design | not applicable: no Python, contracts or UI were touched |

## Deviations
1. **`src/lib/rag/query/dates.ts` was edited, although it is outside `files_modified`.** `denseDateSuffix` is exported, so `normalizeRelativeDates` and `planToVariants` share one suffix format. Its output is unchanged.
2. **The PGlite test does not call `verifyV2Startup`.** The startup check probes `pg_extension`, which the fake edge does not serve. That probe would have shown up in `edge.errors`. `injection-check-v2-two-tenant.test.mts` makes the same choice.
3. **The fixture chunk text repeats the query wording** ("What was revenue last year? Synthetic … record."). Without that, the fixture n-gram embedder scores below the v2 similarity floor (0.65), and the run is refused before it can show which chunks were retrieved.

## Threats
- T-06-54: the flag only widens the date predicate inside the tenant predicate (0602). The PGlite two-tenant case shows that A never sees B's undated chunk and B never sees A's chunks.

## Operator actions / deferred
None. Migration 0602 (06-08) must already be applied. That operator action comes from 06-08.
