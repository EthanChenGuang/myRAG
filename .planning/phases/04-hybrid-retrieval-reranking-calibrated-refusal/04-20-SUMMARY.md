---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 20
subsystem: rag
tags: [v2, refusal, query-filters, similarity-floor]

requires:
  - phase: 04-19
    provides: v2 search/context pipeline and runRetrieval dispatch
provides:
  - runQueryStages (refs, analyze, filters, variants)
  - runRankStages (calibrated gate + similarity floor refusal)
  - buildV2Result refusal precedence over deriveStatus
  - strict chat refusal under v2 defaults (characterization)
affects:
  - 04-23 (rerank before refusal in rank group)
  - 04-24 (translate variants in query group)

actuals:
  tokens: 186000
  tasks: 3
  commits: 1
plan_head_before: 4f75b19ebe8e2f019d6a06e7ddc2e6f2a7bc8e11
plan_head_after: 11c0e0fef339b05fac5d928cab5aff123738614b

tech-stack:
  added: []
  patterns:
    - "Refusal empty status overrides deriveStatus degraded from skipped analyze"
    - "Eval profile keeps pre-refusal candidates; chat clears candidates on refuse"

key-files:
  created:
    - src/lib/rag/v2/stages/query.ts
    - src/lib/rag/v2/stages/rank.ts
    - tests/rag/v2/refusal-routing.test.ts
  modified:
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/v2/result.ts
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/pipeline.ts
    - tests/chat-strict.test.ts
    - tests/rag/status.test.ts

key-decisions:
  - "Similarity floor runs whenever the calibrated gate is not_applied (default reranker none)"
  - "Refuse clears fused survivors before context assembly; referenced documents still assemble"

requirements-completed: [RNK-05, DATA-08, XLG-03]

duration: 45min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 20: v2 query group and refusal routing Summary

**v2 runs refs/analyze/filters before search, applies the similarity floor when the calibrated gate is off, and keeps strict chat “information not available” under default switches.**

## Accomplishments

1. **Query group (D-05):** `runQueryStages` runs exported `runRefsStage`, optional `legacyAnalyze` with trace-only `derived_date_range`, `queryLanguage`, and `buildRetrievalFilters`; filters flow into `runSearchStages`.
2. **Refusal stage (D-19/D-30/D-31):** `runRankStages` records `decideRefusal` (gate off with `reranker=none`) then `similarityFloor`; refuse drops survivors before `runContextStages`; `buildV2Result` forces `status: empty` with `below_similarity_floor` or `below_threshold` over `deriveStatus`.
3. **Strict chat:** `tests/chat-strict.test.ts` covers `RAG_PIPELINE=v2` with low dense similarity and web-search-on escape hatch; legacy cases unchanged.

## Deviations from Plan

### Auto-fixed Issues

None — plan executed as specified.

## Verification

- `npx vitest run tests/rag/v2/refusal-routing.test.ts tests/rag/v2/search-stages.test.ts tests/rag/status.test.ts tests/chat-strict.test.ts tests/chat-websearch.test.ts tests/rag/characterize-chat.test.ts` — pass
- `npx tsc --noEmit -p tsconfig.json` — pass
- `node scripts/ci/check-rag-boundary.mjs` — pass
- `python3 scripts/ci/check-workflows.py` — pass
- `node scripts/check-config.mjs` — pass

## Self-Check: PASSED

- FOUND: src/lib/rag/v2/stages/query.ts
- FOUND: src/lib/rag/v2/stages/rank.ts
- FOUND: tests/rag/v2/refusal-routing.test.ts
- FOUND: 11c0e0f