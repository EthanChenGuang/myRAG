---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 04
subsystem: rag-contracts
tags: [pydantic, zod, retrieval, refusal, chunking, eval-config]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: GoldenItem categories, RagRunOptions embedding_profile, export_schemas pattern
provides:
  - Phase 4 Pydantic contracts with generated Zod parity
  - Committed eval/config retrieval and refusal starting files
  - chunking-profile-cases.json shared validation table
affects: [04-11, 04-13, 04-19, 04-33, 04-35]

actuals:
  tokens: 152000
  tasks: 3
  commits: 3
plan_head_before: d19c727f2b0353ab1d6f43d054d17d6e187eabeb
plan_head_after: 60772fa
commits: 3

tech-stack:
  added: []
  patterns:
    - "Pydantic contracts as source of truth with npm run gen:schemas"
    - "chunking_profile_findings shared between validators and exported case table"
    - "eval config_files init with provenance-aware overwrite guard"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/contracts/retrieval.py
    - eval/src/rag_eval/config_files.py
    - eval/config/retrieval-params.json
    - eval/config/refusal-thresholds.json
    - eval/config/refusal-calibration.json
    - eval/reports/chunking-sweep.json
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
    - rag-sidecar/src/rag_sidecar/contracts/golden.py
    - src/lib/rag-eval/contracts.generated.ts

key-decisions:
  - "Broke golden↔retrieval import cycle by defining FilterLanguage in retrieval.py"
  - "Init refuses overwrite for any non-defaults provenance (sweep, calibration, fixture, live)"

patterns-established:
  - "Chunking warnings suppress ratio checks when parent_below_twice_child already fails"

requirements-completed: [RNK-02, RNK-05, CHK-04, CHK-05, DATA-08, RET-10]

duration: 28min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 04: Phase 4 contract surface and default eval configs

**Pydantic v2 defines retrieval, refusal, chunking, and trace fields once; Zod and committed eval configs are generated from those models with provenance guards.**

## Performance

- **Duration:** ~28 min
- **Tasks:** 3/3
- **Commits:** 3

## Accomplishments

1. Added `retrieval.py` with `RetrievalParams`, overrides, filters, refusal thresholds/calibration, chunking profile/sweep/decision models, shared chunking validation cases, and pytest coverage.
2. Extended `RagRunOptions`, `RagTrace`, `TraceCandidate`, `GoldenItem`, and `Category` for Phase 4 fields; regenerated JSON schemas, Zod, and contract samples.
3. Implemented `python -m rag_eval.config_files init` with idempotent writes and tool-provenance protection; committed the four default config/report files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Circular import eval_run ↔ retrieval ↔ golden**
- **Fix:** Use local `FilterLanguage` in `retrieval.py` instead of importing `Language` from `golden.py`.

**2. [Rule 2 - Missing critical] Chunking case table consistency**
- **Fix:** Skip ratio/budget warnings when parent-below-twice-child already fails; document combined warnings where both apply (128/1536).

None other — plan executed as specified.

## Gate Results

| Gate | Result | Notes |
|------|--------|-------|
| `pytest test_retrieval_contracts.py` | pass | 24 tests |
| `npm run gen:schemas` + contract vitest | pass | 126 tests in contracts + schema-parity |
| `pytest eval/tests/test_config_files.py` | pass | 6 tests |
| `check-rag-boundary.mjs` | pass | |
| `check-config.mjs` | pass | |
| `check-workflows.py` | pass | |
| `npx vitest run` (full) | partial | 9 failures (incl. langfuse-pins env); contracts suites pass |
| `npx tsc --noEmit` | fail | Pre-existing `tests/ui/config-rag-panels.test.ts` errors (unrelated) |
| `rag-sidecar pytest` full | partial | `test_boot` needs `uv` on PATH (worktree env) |
| `uv run pytest` (plan verify) | skip | `uv` not installed in cloud VM |

## Self-Check

- [x] `rag-sidecar/src/rag_sidecar/contracts/retrieval.py` — FOUND
- [x] `eval/config/retrieval-params.json` — FOUND
- [x] Commits 30349f4, 2a804f0, 60772fa — FOUND on branch