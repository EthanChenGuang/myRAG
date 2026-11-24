---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 11
subsystem: rag
tags: [rrf, fusion, dedupe, retrieval]

requires:
  - phase: 04-01
    provides: RankedHit and backend leg types
provides:
  - Shared rrf() over dense/lexical/exact_id ranked lists
  - dedupeAndCap() with span-ready counts
affects: [04-19, v2 pipeline fuse stage]

actuals:
  tokens: 12000
  tasks: 2
  commits: 3
  plan_head_before: 4e7687153b0442fec8c90f3d4fc981fbe3059e06
  plan_head_after: e80800b24c93df976650c43b045080727938bf67

tech-stack:
  added: []
  patterns:
    - "Fixed list-id sort before RRF float summation for determinism"
    - "First-seen RankedHit payload wins in fusion"

key-files:
  created:
    - src/lib/rag/fusion/rrf.ts
    - src/lib/rag/fusion/dedupe.ts
    - tests/rag/fusion/rrf.test.ts
    - tests/rag/fusion/dedupe.test.ts
    - tests/rag/fusion/helpers.ts
  modified: []

key-decisions:
  - "Sort RankedList by id before scoring so input array order cannot change floats"
  - "Parent dedupe only when parentId is non-null; null parents never collapse"

patterns-established:
  - "FusedHit = RankedHit + RRF score + per-list rank map"

requirements-completed: [RET-02, LAT-01]

coverage:
  - id: D1
    description: Deterministic RRF including single-list identity (D-02, D-23)
    requirement: RET-02
    verification:
      - kind: unit
        ref: tests/rag/fusion/rrf.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Chunk/parent dedupe, cap, and counts (D-13, LAT-01)
    requirement: LAT-01
    verification:
      - kind: unit
        ref: tests/rag/fusion/dedupe.test.ts
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 11: RRF + dedupe fusion Summary

**Shared TypeScript RRF and dedupe/cap primitives with deterministic ties and trace counts.**

## Performance

- **Duration:** 25 min
- **Tasks:** 2 / 2
- **Commits:** 3

## Accomplishments

- `rrf()` fuses weighted legs with `k` default 60, tie-break by `chunkId`, and records each list's rank per hit.
- `dedupeAndCap()` removes duplicate chunks and optional sibling parents, slices to cap, and emits `candidates_in`, `deduped`, `rerank_input`, `capped_from`.
- Ten unit tests lock ordering, weights, single-list identity, and cap math.

## Deviations from Plan

None — behavior matches PLAN.md and Pattern 3 in 04-RESEARCH.md.

TDD RED-only commits were folded into green commits (tests and implementation landed together).

## Gate results

| Gate | Result |
|------|--------|
| `npx vitest run tests/rag/fusion` | pass (10 tests) |
| `node scripts/ci/check-rag-boundary.mjs` | pass |
| `node scripts/check-config.mjs` | pass |
| `python3 scripts/ci/check-workflows.py` | pass |
| `npx tsc --noEmit` | fail (pre-existing: `tests/rag/lexical/chunk-text.test.ts`, `tests/ui/config-rag-panels.test.ts`) |
| `npx vitest run` (full) | 12 failures pre-existing in other suites (e.g. `search-rpc-grants.test.ts`) |

## Self-Check: PASSED

- FOUND: src/lib/rag/fusion/rrf.ts
- FOUND: src/lib/rag/fusion/dedupe.ts
- FOUND: tests/rag/fusion/rrf.test.ts
- FOUND: tests/rag/fusion/dedupe.test.ts
- FOUND: e4898bb (task 1)
- FOUND: e80800b (task 2)