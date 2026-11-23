---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 25
subsystem: testing
tags: [eval, golden, provenance, gate, pydantic, zod, report]

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: Pydantic contracts and schema export flow (02-02), EvalReport with latency block (02-24)
provides:
  - Category gains colloquial, ambiguous, typo; Provenance gains production
  - ItemResult.provenance (required) and EvalReport.by_provenance / by_provenance_category / gate_population
  - Baseline.gate_population (defaults to all, so the committed baseline still reads)
  - metrics.aggregate switches the gated slices to approved production items once they exist
  - gate mismatch (exit 2) when report and baseline gate_population differ
affects: [02-26 golden additions and baseline re-record, 02-27+ review queue promotion to production items]

status: complete
actuals:
  tokens: 14000
  tasks: 2
  commits: 4
plan_head_before: af41f9b217ef9cdc8745238d7f2ad2eabfaa22ef
plan_head_after: bb18714757f971e8e46fa7f27f93e6e370f0c315

tech-stack:
  added: []
  patterns:
    - "Gate population is decided inside aggregate: approved production items of the gated split if any, else the whole gated split; the choice is recorded as gate_population in report and baseline"
    - "Approval is passed to aggregate as a set of item ids (approved_ids) by build_report, because ItemResult carries no review_status"

key-files:
  created: []
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/golden.py
    - rag-sidecar/src/rag_sidecar/contracts/report.py
    - rag-sidecar/src/rag_sidecar/contracts/baseline.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/schemas/Baseline.schema.json
    - rag-sidecar/schemas/GoldenItem.schema.json
    - rag-sidecar/schemas/EvalReport.schema.json
    - rag-sidecar/schemas/DraftedItemBatch.schema.json
    - rag-sidecar/schemas/JudgeReport.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json
    - eval/src/rag_eval/metrics.py
    - eval/src/rag_eval/report.py
    - eval/src/rag_eval/gate.py
    - eval/src/rag_eval/baseline.py
    - rag-sidecar/tests/test_golden_contract.py
    - rag-sidecar/tests/test_contract_models.py
    - eval/tests/test_metrics.py
    - eval/tests/test_report_runner.py
    - eval/tests/test_gate.py
    - eval/tests/test_baseline.py
    - eval/tests/test_paired.py

key-decisions:
  - "by_language_category stays over the whole gated split even when the production population is active; only overall, by_language and by_category switch (as the plan states), and a report note says so"
  - "Draft production items never switch the gate population: build_report passes the ids of approved golden items to aggregate (approved_ids); a bare aggregate call without it treats every result as approved, which matches today's approved-only runs"
  - "gate_population is compared in _mismatches and required equal across baseline runs (T-02-67)"

requirements-completed: [EVAL-14]

coverage:
  - id: D1
    description: "Category accepts colloquial, ambiguous, typo; Provenance accepts production; slang and unknown provenance are rejected; ItemResult requires provenance; EvalReport/Baseline gate_population defaults to all and rejects other values; old report JSON without the new fields parses"
    requirement: "EVAL-14"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_golden_contract.py and test_contract_models.py (163 passed)"
        status: pass
      - kind: unit
        ref: "npx vitest run tests/contracts.test.ts tests/schema-parity.test.ts (50 passed)"
        status: pass
  - id: D2
    description: "aggregate returns by_provenance and by_provenance_category; the production population replaces the gated overall, by_language and by_category; draft or test-split production items do not switch it; the report records provenance per item, gate_population, a note and two markdown tables"
    requirement: "EVAL-14"
    verification:
      - kind: unit
        ref: "eval/tests/test_metrics.py, test_report_runner.py (written, NOT RUN in this session, see Environment limitation)"
        status: unrun
      - kind: integration
        ref: "npm run test-rag (out dir in the scratchpad): gate PASS, paired.all_zero true, report.json gate_population all with by_provenance.synthetic_fixture"
        status: pass
  - id: D3
    description: "the gate reports a mismatch naming gate_population when report and baseline differ; baseline recording requires and stores it"
    requirement: "EVAL-14"
    verification:
      - kind: unit
        ref: "eval/tests/test_gate.py, test_baseline.py (written, NOT RUN in this session, see Environment limitation)"
        status: unrun
---

# Phase 2 Plan 25: Eval contracts for real-user phrasing and production provenance Summary

**Three new categories (colloquial, ambiguous, typo), the production provenance, provenance slices in every report, and a gate that switches to approved production items once they exist and refuses to compare reports and baselines of different gate populations.**

## Accomplishments

- `Category` and `Provenance` literals extended in place; `ItemResult.provenance` is required; `EvalReport` gains `by_provenance`, `by_provenance_category` (default empty) and `gate_population` (`all` | `production`, default `all`); `Baseline` gains `gate_population` (default `all`, so the committed fixture baseline still validates unchanged).
- `npm run gen:schemas` regenerated five JSON schemas (Baseline, GoldenItem, EvalReport, DraftedItemBatch, JudgeReport, the last because it reuses `Category`), the Zod file and the sample fixture; contract and schema-parity vitest pass.
- `metrics.aggregate`: `by_provenance` and `by_provenance_category` over the gated split; when approved production items exist in the gated split they are the population for `overall`, `by_language` and `by_category`, everything else is report-only. `score_items` copies provenance from the golden item.
- `build_report` passes the ids of approved golden items, records `gate_population`, adds a note when production is the population, and `report.md` gains the header line "Gate population", "By provenance" and "By provenance and category" tables.
- `gate._mismatches` compares `gate_population` (exit 2, "re-record the baseline"); `record_baseline` requires equality across runs and stores it.
- Smoke tier with today's golden set (72 items, no production items): gate PASS, `paired.all_zero` true, `gate_population` `all`, `by_provenance` has `synthetic_fixture`. Existing slice values are unchanged.

## Task Commits

1. Task 1 RED: `e326239` contract tests (validation failures against the old literals and fields)
2. Task 1 GREEN: `1cb8157` contracts, regenerated schemas, Zod, samples
3. Task 2 RED: `a7c70f5` metrics, report, gate and baseline tests, existing ItemResult fixtures carry provenance
4. Task 2 GREEN: `bb18714` metrics, report, gate, baseline implementation

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Draft production items must not gate**
- **Found during:** Task 2 design
- **Issue:** the plan assumes production items reach `aggregate` only when approved, but `--include-drafts` runs score draft items too, and `ItemResult` has no review status. An unreviewed production item could then silently become the gate population.
- **Fix:** `aggregate` takes an optional `approved_ids`; `build_report` supplies the approved golden ids. Test `test_draft_production_items_do_not_switch_the_gate_population` and `test_only_approved_production_items_count_when_approved_ids_are_given` cover it.
- **Files modified:** eval/src/rag_eval/metrics.py, eval/src/rag_eval/report.py
- **Commit:** bb18714

**2. [Rule 3 - Blocking] JudgeReport schema regenerated**
- `JudgeReport.schema.json` also changed because it embeds `Category`; it was committed with the contracts (`1cb8157`), as the plan says to commit every regenerated file.

### Environment limitation

The harness guard in this session refuses any shell command that names the `eval` directory (it reports "runs a string through eval"), including `uv run --directory eval pytest`. The Task 2 RED commit therefore could not be confirmed failing, and the Task 2 GREEN commit could not be confirmed passing, with the eval pytest suite. The orchestrator needs to run:

`uv run --directory eval --all-extras --frozen pytest -q tests/test_metrics.py tests/test_report_runner.py tests/test_gate.py tests/test_baseline.py tests/test_paired.py`

(and ideally the whole eval suite). What was run instead: `rag-sidecar` pytest (163 passed), the contract and schema-parity vitest suites (50 passed), and `npm run test-rag` end to end (the harness drives the real `rag_eval` runner, report builder and gate; gate PASS, paired differences all zero), with the output directory in the scratchpad.

## Known Stubs

None.

## Threat Flags

None. T-02-67 is mitigated as planned: `gate_population` is recorded in report and baseline, a difference is a mismatch (exit 2), and baseline runs must agree on it.

## Self-Check: PASSED

- Modified files present in the worktree (contracts, schemas, generated Zod, samples, eval modules and tests).
- Commits e326239, 1cb8157, a7c70f5, bb18714 are ancestors of HEAD.
- `git rev-list --count af41f9b..HEAD` was 4 before this SUMMARY commit.
