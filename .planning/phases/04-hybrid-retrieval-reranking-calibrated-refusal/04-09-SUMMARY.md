---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 09
subsystem: api
tags: [rerank, cohere, voyage, fetch, boundary, zod]

requires:
  - phase: 04-01
    provides: Reranker types and score semantics contract
provides:
  - completeScores and RerankError
  - createCohereReranker and createVoyageReranker fetch adapters
  - Recorded rerank fixtures under tests/fixtures/rerank/
  - rerank-http boundary rule
affects: [04-23, RNK-01]

actuals:
  tokens: 12000
  tasks: 3
  commits: 3
plan_head_before: placeholder
plan_head_after: placeholder

tech-stack:
  added: []
  patterns:
    - "Thin fetch adapters with zod/v3 passthrough parsing"
    - "completeScores enforces full index coverage before scoring"

key-files:
  created:
    - src/lib/rag/rerank/scores.ts
    - src/lib/rag/rerank/cohere.ts
    - src/lib/rag/rerank/voyage.ts
    - tests/rag/rerank/http-adapters.test.ts
    - tests/fixtures/rerank/*.json
  modified:
    - scripts/ci/check-rag-boundary.mjs
    - scripts/tests/check-rag-boundary.node-test.mjs

key-decisions:
  - "rerank-http matches fetch calls to vendor hosts, not bare env default strings"

patterns-established:
  - "RerankError exposes provider and status only (D-11)"

requirements-completed: [RNK-01, RNK-06]

coverage:
  - id: D1
    description: Cohere v2 rerank adapter with completeScores and recorded fixtures
    requirement: RNK-01
    verification:
      - kind: unit
        ref: tests/rag/rerank/http-adapters.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Voyage HTTP data[] rerank adapter
    requirement: RNK-01
    verification:
      - kind: unit
        ref: tests/rag/rerank/http-adapters.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: rerank-http boundary rule confines vendor fetch to rerank module
    requirement: RNK-06
    verification:
      - kind: unit
        ref: scripts/tests/check-rag-boundary.node-test.mjs
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 09: Cohere/Voyage rerank HTTP adapters Summary

**Thin fetch adapters for Cohere v2 and Voyage HTTP rerank with strict score completion, recorded fixtures, and a rerank-http boundary fence.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-11-24
- **Completed:** 2026-11-24
- **Tasks:** 3
- **Files modified:** 13

## Accomplishments

- `completeScores` and `RerankError` reject partial, duplicate, or non-finite vendor scores.
- `createCohereReranker` POSTs `/v2/rerank` without `top_n`; optional `relevant_spans`.
- `createVoyageReranker` POSTs `/v1/rerank` with `truncation` and `return_documents: false`; rejects SDK `results` shape.
- `rerank-http` rule keeps hosted rerank `fetch` inside `src/lib/rag/rerank/`.

## Task Commits

1. **Task 1: Cohere adapter + scores** - `6f38e8d` (feat)
2. **Task 2: Voyage adapter** - `28dcec3` (feat)
3. **Task 3: rerank-http boundary** - `dfd9677` (feat)

## Deviations from Plan

None — plan executed as written.

## Self-Check

- FOUND: src/lib/rag/rerank/scores.ts
- FOUND: src/lib/rag/rerank/cohere.ts
- FOUND: src/lib/rag/rerank/voyage.ts
- FOUND: tests/rag/rerank/http-adapters.test.ts
- FOUND: .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-09-SUMMARY.md
- FOUND: 6f38e8d, 28dcec3, dfd9677

## Self-Check: PASSED