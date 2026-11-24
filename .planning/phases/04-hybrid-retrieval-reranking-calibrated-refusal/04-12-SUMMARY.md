---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 12
subsystem: rag
tags: [context-assembly, compression, token-budget, edge-order]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: cl100k_base token counting in ingest/text/tokens.ts
  - phase: 02-rag-context
    provides: buildContext renderer and byte-identity tests
provides:
  - edgeOrder, mergeAdjacent, selectWithinBudget, countContextTokens
  - buildContext groupOrder and keptByOverride
  - compressChunks with MIN_COMPRESS_TOKENS guard
affects: [04-22, 04-27]

actuals:
  tokens: 72000
  tasks: 3
  commits: 4
  plan_head_before: 124b51335ecd57e21f15aa974c76a944d844b550
  plan_head_after: "4622880e529e916f3a65a35245d5ad77a5e11663"

tech-stack:
  added: []
  patterns:
    - "Pattern 6 helpers: budget before order; edge order permutes document groups"
    - "Extractive compression with codepoint span offsets and Intl.Segmenter sentences"

key-files:
  created:
    - src/lib/rag/context/edge-order.ts
    - src/lib/rag/context/merge-adjacent.ts
    - src/lib/rag/context/budget.ts
    - src/lib/rag/context/compress.ts
    - tests/rag/context/assembly-helpers.test.ts
    - tests/rag/context/build-context-order.test.ts
    - tests/rag/context/compress.test.ts
  modified:
    - src/lib/rag/context/assemble.ts

key-decisions:
  - "Image-document chunks are selected without consuming token budget"
  - "Provider spans map on codepoint indices; spans wholly in rerank prefix are dropped"
  - "Legacy assemble output is unchanged when groupOrder and keptByOverride are absent"

requirements-completed: [RNK-03, RNK-04]

coverage:
  - id: D1
    description: "Edge order, merge-adjacent runs, and rank-order token budget"
    requirement: RNK-03
    verification:
      - kind: unit
        ref: "tests/rag/context/assembly-helpers.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "buildContext accepts groupOrder and keptByOverride without legacy drift"
    requirement: RNK-03
    verification:
      - kind: unit
        ref: "tests/rag/context/build-context-order.test.ts"
        status: pass
      - kind: unit
        ref: "tests/rag-assemble-differential.test.mts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Extractive compression with span and local scoring guards"
    requirement: RNK-04
    verification:
      - kind: unit
        ref: "tests/rag/context/compress.test.ts"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 12: Context assembly helpers and compress Summary

**Pure v2 context helpers (edge order, merge, budget, compress) extend the Phase 2 renderer with optional group order while legacy bytes stay identical.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3/3
- **Commits:** 4 on `exec/04-12`

## Accomplishments

- Implemented `edgeOrder`, `mergeAdjacent`, and `selectWithinBudget` with cl100k_base counting shared with ingest.
- Extended `buildContext` with `groupOrder` and `keptByOverride`; differential and oracle suites unchanged.
- Added `compressChunks` (provider spans with prefix adjustment, local sentence scoring, 150-token minimum).

## Deviations from Plan

None — plan executed as written.

## Self-Check

- `src/lib/rag/context/edge-order.ts` — FOUND
- `src/lib/rag/context/merge-adjacent.ts` — FOUND
- `src/lib/rag/context/budget.ts` — FOUND
- `src/lib/rag/context/compress.ts` — FOUND
- `tests/rag/context/assembly-helpers.test.ts` — FOUND
- `tests/rag/context/build-context-order.test.ts` — FOUND
- `tests/rag/context/compress.test.ts` — FOUND
- Commits `a1a247c`, `941cc73`, `575237e` — FOUND

## Self-Check: PASSED