---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 08
subsystem: rag
tags: [trace, logging, counts, refusal, LAT-01, RNK-05]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    plan: 01
    provides: StageRecord.counts and RefusalRecord types

provides:
  - runStage counts option wired to collector on ok path
  - sanitizeStageCounts for finite numeric stage metrics
  - buildTraceLogPayload emits optional per-stage counts and refusal object
  - Distinctive-string trace-log guard extended to refusal/cellKey

affects:
  - 04-13+ refusal gate and v2 stages that report D-13 counts

actuals:
  tokens: 4200
  tasks: 2
  commits: 2
  plan_head_before: 5940841f8e96b940ffe5e4048e39553ed7cb0cf6
  plan_head_after: bb2d72ce

tech-stack:
  added: []
  patterns:
    - "sanitizeStageCounts shared between collector and log payload"
    - "sanitizeRefusalForLog whitelist with SAFE_CELL_KEY pattern"

key-files:
  created: []
  modified:
    - src/lib/rag/trace/collector.ts
    - src/lib/rag/trace/log.ts
    - src/lib/rag/pipeline.ts
    - tests/rag/stage-runner.test.ts
    - tests/rag/trace-log.test.ts

key-decisions:
  - "counts only on ok path; legacy stages without counts option keep record shape"
  - "refusal.reason null preserved in log when explicitly null at runtime"

patterns-established:
  - "Stage count keys must match ^[a-z][a-z0-9_]{0,63}$ with finite values"

requirements-completed: [LAT-01, RNK-05]

coverage:
  - id: D1
    description: "runStage counts reach StageRecord.counts without changing legacy records"
    requirement: LAT-01
    verification:
      - kind: unit
        ref: tests/rag/stage-runner.test.ts#counts on the ok path
        status: pass
      - kind: unit
        ref: node --import tsx --test tests/rag-legacy-differential.test.mts
        status: pass
    human_judgment: false
  - id: D2
    description: "Trace log carries counts and refusal without query or chunk text"
    requirement: RNK-05
    verification:
      - kind: unit
        ref: tests/rag/trace-log.test.ts#buildTraceLogPayload
        status: pass
      - kind: unit
        ref: tests/rag/trace-log.test.ts#runRetrieval trace wiring
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 08: Trace counts and pipeline trace Summary

**Per-stage numeric counts flow through runStage into `[RAG Trace]` lines, with a sanitized refusal object and no change to legacy stage records.**

## Performance

- **Duration:** 25 min
- **Tasks:** 2/2
- **Commits:** 2

## Accomplishments

1. Added `sanitizeStageCounts`, optional `counts` on `StageEntry`/`StageRecord`, and a `counts` callback on `StageRunOptions` applied only on successful stages.
2. Extended `buildTraceLogPayload` with optional per-stage `counts` and a `refusal` object filtered through finite-number checks and `SAFE_CELL_KEY` / reason-code patterns.
3. TDD tests in `stage-runner.test.ts` and `trace-log.test.ts` cover invalid count drops, non-ok paths, refusal shape, and distinctive-string absence.

## Deviations from Plan

None — plan executed as written.

## Self-Check: PASSED

- FOUND: src/lib/rag/trace/collector.ts
- FOUND: src/lib/rag/trace/log.ts
- FOUND: src/lib/rag/pipeline.ts
- FOUND: tests/rag/stage-runner.test.ts
- FOUND: tests/rag/trace-log.test.ts
- FOUND: 4a6633d
- FOUND: bb2d72c

## Verification

| Command | Result |
|---------|--------|
| `npx vitest run tests/rag/stage-runner.test.ts tests/rag/trace-log.test.ts tests/rag/status.test.ts` | 56 passed |
| `node --import tsx --test tests/rag-legacy-differential.test.mts` | 5 passed |
| `node scripts/ci/check-rag-boundary.mjs` | ok |
| `node scripts/check-config.mjs` | ok |
| `python3 scripts/ci/check-workflows.py` | OK |

**Note:** `tests/rag/langfuse-pins.test.ts` fails in worktree (missing root `package.json` read path); orchestrator reruns on trunk. Pre-existing `tests/ui/config-rag-panels.test.ts` tsc errors unchanged (6 total in worktree tsc).