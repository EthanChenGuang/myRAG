---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 19
subsystem: rag-v2-pipeline
tags: [v2, hybrid-search, rrf, eval-tracer, pgvector]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: pgvector backend, retrieval-params, config hash, fusion helpers
    plans: [04-02, 04-04, 04-08, 04-11, 04-12, 04-16, 04-17, 04-44]
provides:
  - runRetrieval lazy dispatch to runV2Pipeline for chat, embed, eval
  - v2 search, fuse, dedupe, assemble stage group
  - buildV2Result with retrievalConfigHash
  - tests/rag-db/v2-tracer.test.mts and tests/rag/v2/search-stages.test.ts
affects: [04-20, 04-23, 04-24, 04-28, 06-13]

actuals:
  tokens: 72000
  tasks: 2
  commits: 2
plan_head_before: 450662ec50050988824c51c76d012111de49e758
plan_head_after: 50fdb6f

tech-stack:
  added: []
  patterns:
    - "Lazy import of v2/pipeline from runRetrieval to avoid circular imports"
    - "Assembly rows built from RankedHit document payloads without a second fetch when possible"
    - "ragEnv reads process.env with env snapshot fallback for eval harness overrides"

key-files:
  created:
    - src/lib/rag/v2/pipeline.ts
    - src/lib/rag/v2/result.ts
    - src/lib/rag/v2/overrides.ts
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/v2/stages/context.ts
    - tests/rag-db/v2-tracer.test.mts
    - tests/rag/v2/search-stages.test.ts
  modified:
    - src/lib/rag/pipeline.ts
    - src/lib/rag/deps.ts
    - src/lib/rag/types.ts
    - eval/harness/run-eval.mts

key-decisions:
  - "StageRunStatus gains degraded for ICU-skipped lexical leg (deriveStatus treats it like skipped)"
  - "evalRetrievalOverrides maps camelCase stage overrides to snake_case RetrievalOverrides for the params loader"

patterns-established:
  - "V2_PROFILES dispatch gate excludes voice, media, and generalOverview"

requirements-completed: [RET-01, RET-02, LAT-01]

coverage:
  - id: D1
    description: End-to-end v2 hybrid retrieval through the eval route keeps exact-term evidence
    requirement: RET-02
    verification:
      - kind: integration
        ref: "tests/rag-db/v2-tracer.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: Legacy pipeline byte-identical for frozen golden questions
    requirement: RET-01
    verification:
      - kind: integration
        ref: "tests/rag-legacy-differential.test.mts"
        status: pass
    human_judgment: false
  - id: D3
    description: Search group fuses, caps, and fails closed under fakes
    requirement: RET-02
    verification:
      - kind: unit
        ref: "tests/rag/v2/search-stages.test.ts"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 19: v2 retrieval tracer Summary

**Eval and chat can run hybrid pgvector retrieval through a lazy v2 dispatch while legacy `runPipeline` stays unchanged when `RAG_PIPELINE` is unset.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 2/2
- **Commits:** 2

## Accomplishments

- Exported `stageSpec`, `requireValue`, `failure`, `degradedReason`, and `assembleDisabledStatus` from `pipeline.ts` and branched `runRetrieval` to `runV2Pipeline` when `RAG_PIPELINE=v2` for chat, embed, and eval (not voice, media, or overview).
- Implemented `runSearchStages` (parallel `backend.search`, RRF, dedupe/cap, disabled rerank record), `runContextStages` (Phase 2 assembler with `applyRelevanceFilter: false`), and `buildV2Result` with `computeRetrievalConfigHash`.
- Added `prepareInProcessEval({ envOverrides })` and dynamic `ragEnv()` reads so the PGlite harness can flip pipeline without re-importing `@/lib/env`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Critical] Eval harness must see `RAG_PIPELINE=v2` after pinned env apply**
- **Found during:** Task 1 tracer test
- **Issue:** `@/lib/env` snapshots at first import; pinned eval env forced legacy even when `process.env` was updated later.
- **Fix:** `readRagEnvInput()` prefers `process.env` for RAG keys; `envOverrides` merged into `applyFixtureProcessEnv` extras.
- **Files modified:** `src/lib/rag/deps.ts`, `eval/harness/run-eval.mts`
- **Commit:** `5d5c55f`

**2. [Rule 2 - Critical] `StageRunStatus` lacked `degraded` for ICU lexical skip**
- **Found during:** Task 2 typecheck
- **Fix:** Added `degraded` to `StageRunStatus` and counted it in `deriveStatus`.
- **Files modified:** `src/lib/rag/types.ts`, `src/lib/rag/pipeline.ts`
- **Commit:** `5d5c55f`

**3. [Rule 2] Eval `retrievalOverrides` shape mismatch with params loader**
- **Fix:** `evalRetrievalOverrides` adapter for eval-only snake_case fields.
- **Files modified:** `src/lib/rag/v2/overrides.ts`
- **Commit:** `5d5c55f`

## Self-Check

- PASSED: key created files present; commits `5d5c55f`, `50fdb6f` on `exec/04-19`.

## Verification (gates run)

- `npx tsc --noEmit -p tsconfig.json` — 0 errors
- `node --import tsx --test tests/rag-db/v2-tracer.test.mts tests/rag-legacy-differential.test.mts` — pass
- `npx vitest run tests/rag/v2/search-stages.test.ts tests/rag/status.test.ts` — 18 passed
- `node scripts/ci/check-rag-boundary.mjs` — ok
- `node scripts/check-config.mjs` — ok