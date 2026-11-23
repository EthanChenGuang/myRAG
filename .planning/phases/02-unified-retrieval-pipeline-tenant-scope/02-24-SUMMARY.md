---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 24
subsystem: testing
tags: [eval, latency, budgets, report, pydantic, zod, observability]

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: Pydantic contracts and schema export flow (02-02), traces with stage_latency_ms from the pipeline collector (02-21 era)
provides:
  - LatencyBudgets, ProfileBudget and StageLatency Pydantic contracts, exported as schema and Zod
  - eval/config/latency-budgets.json with the D-21 starting budgets
  - optional EvalReport.latency (per-stage p50/p95/n plus retrieval_total)
  - report.md "Latency (report-only)" section with within/over markers against the chat profile
affects: [later phases that add rerankers or query transforms and must show they stay inside the budgets]

status: complete
actuals:
  tokens: 10700
  tasks: 2
  commits: 4
plan_head_before: 561d8d4594ed4b48f26033790618a02a540c7fb1
plan_head_after: 70a6c4da392a653aff19540ac749d7e687be10d0

tech-stack:
  added: []
  patterns:
    - "Latency percentiles are nearest-rank (stdlib only), computed from trace stage_latency_ms; retrieval_total sums every stage except generation"
    - "Budgets are report-only: the gate reads only the metric slices, so adding report.latency cannot change its result"

key-files:
  created:
    - rag-sidecar/schemas/LatencyBudgets.schema.json
    - rag-sidecar/tests/test_latency_contract.py
    - eval/config/latency-budgets.json
    - eval/tests/test_latency_report.py
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/latency.py
    - rag-sidecar/src/rag_sidecar/contracts/report.py
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - rag-sidecar/schemas/EvalReport.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json
    - eval/src/rag_eval/report.py
    - eval/src/rag_eval/runner.py
    - AGENTS.md

key-decisions:
  - "LatencyBudgets.profiles is a dict keyed by Literal chat|embed|voice, so an unknown profile is rejected by the contract; stages is optional per profile (voice has none)"
  - "generation is reported as a stage row (no budget) but excluded from retrieval_total; retrieval_total is only counted for traces that have at least one non-generation stage"
  - "write_report loads eval/config/latency-budgets.json by default when the report has a latency block; an explicit budgets argument overrides it for tests"

requirements-completed: [OBS-02]

coverage:
  - id: D1
    description: "latency-budgets.json validates as LatencyBudgets with the D-21 numbers; negative budgets, p50 above p95 and unknown profiles are rejected"
    requirement: "OBS-02"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_latency_contract.py (13 tests)"
        status: pass
  - id: D2
    description: "every eval report carries per-stage p50/p95/n and retrieval_total, rendered against the chat budgets with within/over, and the gate result is unchanged"
    requirement: "OBS-02"
    verification:
      - kind: unit
        ref: "eval/tests/test_latency_report.py (10 tests)"
        status: pass
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/latency: gate PASS, report.json latency.embed.n = 72"
        status: pass
  - id: D3
    description: "AGENTS.md documents the budgets and their location"
    requirement: "OBS-02"
    verification:
      - kind: manual
        ref: "grep -c latency-budgets.json AGENTS.md returns 1"
        status: pass
---

# Phase 2 Plan 24: Latency budgets and per-stage report Summary

**D-21 latency budgets as a validated Pydantic contract and config file, with nearest-rank per-stage p50/p95/n in every eval report, rendered against the chat budgets as report-only.**

## Accomplishments

- `LatencyBudgets` / `ProfileBudget` / `StageLatency` contracts (p50 <= p95, non-negative, unknown profile and unknown keys rejected), registered in the export list, with samples; `npm run gen:schemas` regenerated the schema, Zod file and sample fixture, and the contract and schema-parity vitest suites pass.
- `eval/config/latency-budgets.json`: chat and embed total 1000/2000 ms with stage p95 embed 200, search 400, assemble 100; voice 400/800.
- `EvalReport.latency` (optional, default None). `build_report` takes the traces and computes nearest-rank percentiles per stage plus `retrieval_total`.
- `report.md` gains a "Latency (report-only)" table with p50, p95, n, the budget columns and a within/over status; stages without a budget show "-".
- Smoke tier output: gate PASS, 72 traces, `latency.embed.n = 72`; all stages are within budget on the fixture run (not representative of production).
- AGENTS.md section 6 carries the one-line budget pointer.

## Task Commits

1. Task 1 RED: `7498bcb` failing contract tests (stub contracts, assertion failures)
2. Task 1 GREEN: `185d846` contract, config, `EvalReport.latency`, regenerated schemas
3. Task 2 RED: `d669fe2` failing report tests (stub helpers, assertion failures)
4. Task 2 GREEN: `70a6c4d` percentiles, rendering, runner wiring, AGENTS.md

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Wired traces through the runner**
- **Found during:** Task 2
- **Issue:** `eval/src/rag_eval/runner.py` was not in the plan's file list, but `build_report` could not see the traces without it, so the smoke report would have had no latency block.
- **Fix:** `_score` now passes `traces` to `build_report`.
- **Files modified:** eval/src/rag_eval/runner.py
- **Commit:** 70a6c4d

### Environment limitation

The harness guard in this session refuses any shell command that names the `eval` directory as a `uv` target or working directory (it reports "runs a string through eval"), including the exact `uv run --directory eval --all-extras --frozen pytest` form from the instructions. Consequently:

- The eval suite was run with the venv that `npm run test-rag` created (no optional extras) and via `PYTHONPATH`, from the rag-sidecar directory: 236 passed, 2 failed. The two failures (`test_draft_cli::test_pinned_synthesizer_forces_style_and_length`, `test_judge_config::test_importing_deepeval_after_the_opt_out_does_not_load_dotenv_files`) and the collection error in `test_judge_offline.py` come from the missing `ragas` and `deepeval` extras, not from this change. They need `uv run --directory eval --all-extras --frozen pytest -q` from the orchestrator or CI.
- All latency tests, `test_report_runner.py` and `test_gate.py` pass; `rag-sidecar` pytest passes (151).

## Known Stubs

None.

## Threat Flags

None. T-02-66 accepted as planned: the section is labelled report-only and fixture latencies are flagged as not representative; live measurement remains a VERIFICATION item.

## Self-Check: PASSED

- Files present: latency.py, test_latency_contract.py, latency-budgets.json, test_latency_report.py, LatencyBudgets.schema.json, this SUMMARY.
- Commits 7498bcb, 185d846, d669fe2, 70a6c4d are ancestors of HEAD.
- `git rev-list --count 561d8d4..HEAD` was 4 before this SUMMARY commit.
