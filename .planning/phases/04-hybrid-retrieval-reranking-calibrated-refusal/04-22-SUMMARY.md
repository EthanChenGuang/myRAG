---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 22
subsystem: rag
tags: [context-assembly, token-budget, edge-order, compression, v2-pipeline]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: edgeOrder, mergeAdjacent, selectWithinBudget, compressChunks (04-12); context stage group (04-19); profile token budgets (04-44)
provides:
  - v2 assemble stage with budgeted selection, merged document groups and best-at-edges ordering
  - optional compress stage behind RAG_CONTEXT_COMPRESSION, never run for voice
  - ContextRerankInput hook (ran, spansByChunk, prefixLengthByChunk) for plan 04-23 to feed
affects: [04-23, 04-27]

actuals:
  tokens: 5700
  tasks: 2
  commits: 4
  plan_head_before: 7a9b96f
  plan_head_after: "f4ec110e43e97aa0065b817cf7e56a2862487146"

tech-stack:
  added: []
  patterns:
    - "Select by rank within the budget first, then order document groups (F-24)"
    - "Compression re-renders with the same group order and swaps only the context string"

key-files:
  created:
    - tests/rag/v2/context-stages.test.ts
  modified:
    - src/lib/rag/v2/stages/context.ts
    - src/lib/rag/context/assemble.ts

key-decisions:
  - "Chunk text inside a document stays as buildContext sorts it today (chunk number from the legacy prefix, else similarity); merge feeds group ranks and the one-header count, not a content rewrite"
  - "Image-only documents are left out of the group list that edge order permutes, so they never take an edge slot"
  - "kept[].rank keeps the candidate's true rank after the budget drops chunks"
  - "Compression changes only the rendered context; kept, usedDocuments and relevantChunks keep the assembled (budget-truncated) text"

requirements-completed: [RNK-03, RNK-04]

coverage:
  - id: D1
    description: "Budgeted rank-order selection, per-document merge, edge order on or rank order off, Phase 2 format"
    requirement: RNK-03
    verification:
      - kind: unit
        ref: "tests/rag/v2/context-stages.test.ts"
        status: pass
      - kind: unit
        ref: "tests/rag-assemble-differential.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Compress stage: spans or local scoring, off byte-identical, voice disabled, failure skipped"
    requirement: RNK-04
    verification:
      - kind: unit
        ref: "tests/rag/v2/context-stages.test.ts"
        status: pass
    human_judgment: false

completed: 2026-11-24
status: complete
---

# Phase 4 Plan 22: Budgeted edge-ordered assembly and compress stage Summary

**The v2 context group now selects chunks by rank inside the profile token budget, orders document groups best-at-edges behind RAG_CONTEXT_EDGE_ORDER, and optionally compresses behind RAG_CONTEXT_COMPRESSION, all in the unchanged Phase 2 render format.**

## Accomplishments

- `assemble` runs `selectWithinBudget` (RAG_CONTEXT_TOKEN_BUDGET for chat, embed and eval; 2000 for voice via `v2ProfileSettings`), groups the selection with `mergeAdjacent`, and passes `groupOrder` (`edgeOrder` when the switch is on, rank order when off) plus `keptByOverride` (`rerank` when the rerank stage ran, else `fused`) to `buildContext`. Counts recorded: `selected`, `budget_tokens`, `used_tokens`, `groups`.
- `compress` runs after assemble only when the switch is on and the profile allows it. It feeds `compressChunks` with provider spans when `rerank.spansByChunk` is supplied, local sentence scoring otherwise, then re-renders with the same group order. Counts: `compressed`, `saved_tokens`. Switch off or voice: recorded `disabled`, context byte-identical. A throwing compression is recorded `skipped` (run status degraded) and the uncompressed context is kept.
- With every v2 switch off the output equals the tracer rank-order rendering byte for byte (test compares against `assembleContext`); the frozen differential oracle still passes.
- TDD: both tasks had a RED commit that failed on assertions before the implementation commit.

## Task Commits

| Task | Commit | Subject |
| ---- | ------ | ------- |
| 1 RED | daca286 | test(04-22): failing tests for budgeted, merged, edge-ordered v2 assembly |
| 1 GREEN | 0ecfb1c | feat(04-22): budgeted, merged, edge-ordered v2 context assembly (D-15) |
| 2 RED | ec19e10 | test(04-22): failing tests for the compress stage behind RAG_CONTEXT_COMPRESSION |
| 2 GREEN | f4ec110 | feat(04-22): compress stage behind RAG_CONTEXT_COMPRESSION (D-16) |

## Deviations from Plan

**1. [Rule 3 - Blocking] `IMAGE_EXTENSIONS` exported from `assemble.ts`**
- The budget helper needs the image extension list; `assemble.ts` held it privately. Added `export`, no behaviour change. File was not in the plan's `files_modified`.
- Commit: 0ecfb1c

**2. [Rule 1 - Test bug] Compress test fixtures**
- The RED fixtures used lowercase sentence starts, which the ICU sentence segmenter treats as one sentence, so local scoring had nothing to cut. Fixtures now start sentences with a capital; fixed in the Task 2 GREEN commit. The other four Task 2 RED failures were genuine assertion failures.
- Commit: f4ec110

**3. Interface for 04-23**
- The rerank stage does not exist yet (plan 04-23). `runContextStages` takes an optional `rerank: { ran, spansByChunk?, prefixLengthByChunk? }`; absent means fused, no spans. 04-23 must pass it from `runRankStages` through `runV2Pipeline`.

## Deferred Issues

- `tests/rag-db/v2-tracer.test.mts` fails with "expected at least one kept chunk" on this branch and identically on base 7a9b96f (verified by restoring base `context.ts`): the fixture query is refused by the similarity floor (top 0.396 vs 0.65) in the rank stage, before assemble. Not caused by this plan; belongs to the refusal plans (04-20 area).
- `RAG_CONTEXT_TOKEN_BUDGET=0` is accepted by config parsing and now makes rank 1 truncate to a one-token body. The plan does not define 0; left literal. Consider a minimum or a documented "0 = unlimited" in a config plan.
- Chunk order inside one document still follows `buildContext` (chunk number from the legacy prefix, else similarity), so adjacent chunks without the prefix are not forced into `chunk_index` order. Changing it would alter the legacy renderer, which the plan keeps byte-identical.

## Known Stubs

None.

## Threat Flags

None. T-04-44 mitigated: budget per profile with cl100k_base counting, rank 1 truncated when alone over budget (tested).

## Self-Check

- `src/lib/rag/v2/stages/context.ts` — FOUND
- `tests/rag/v2/context-stages.test.ts` — FOUND
- Commits `daca286`, `0ecfb1c`, `ec19e10`, `f4ec110` — FOUND on `exec/04-22`
- Acceptance greps: `edgeOrder` 2, `selectWithinBudget` 2, `compressChunks` 2 (all >= 1)
- `npx vitest run tests/rag/v2 tests/rag/assemble.test.ts` 90 pass; `node --import tsx --test tests/rag-assemble-differential.test.mts` 3 pass; `check-rag-boundary` ok; `tsc --noEmit` 0 errors

## Self-Check: PASSED
