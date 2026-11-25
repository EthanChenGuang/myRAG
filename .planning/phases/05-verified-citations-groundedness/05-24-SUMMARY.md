---
phase: 05-verified-citations-groundedness
plan: 24
subsystem: eval
tags: [citations, groundedness, eval, report, latency-budgets, judge]

requires:
  - phase: 05-verified-citations-groundedness
    provides: "EvalReport citation fields, StrategySlice, GroundednessBudgets (05-07); traces carrying CitationRecord, citation_strategy, invalid_citations and groundedness (05-22)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "report slices, latency against budgets, latency-budgets.json (04-26)"
provides:
  - "rag_eval.metrics: citation_metrics (invalid_citation_rate, citation_coverage, cited_gold_hit, raw_invalid_markers), groundedness_label_counts, citation_is_valid, citation_run, strategy_key"
  - "rag_eval.report: compute_strategy_slices (by_strategy), compute_groundedness_latency, Citations / By citation strategy / Groundedness markdown sections (all report-only)"
  - "build_report(..., judge=JudgeReport) and `rag_eval.runner score --judge judge.json` fill Faithfulness per strategy"
  - "eval/config/latency-budgets.json groundedness section (report_only true)"
affects: [05-25, 05-26]

actuals:
  tokens: 14000
  tasks: 2
  commits: 8

tech-stack:
  added: []
  patterns:
    - "Answer-side report fields are filled only when the traces carry the data; reports of runs without it keep the contract defaults, so their JSON and markdown are byte-identical"

key-files:
  created:
    - eval/tests/test_citation_metrics.py
    - eval/tests/test_report_citations.py
  modified:
    - eval/src/rag_eval/metrics.py
    - eval/src/rag_eval/report.py
    - eval/src/rag_eval/runner.py
    - eval/config/latency-budgets.json
    - rag-sidecar/tests/test_answer_contracts.py

key-decisions:
  - "A citation record is valid only when `[alias]` labels a block in that trace's context and every chunk id is in the trace's kept chunks"
  - "Citation metrics cover every scored item (all splits), not only the gated dev population; they are report-only"
  - "cited_gold_hit population: answered (not refused, non-empty answer) items with gold spans; only valid citations can hit"
  - "Faithfulness per strategy is the per-item mean of the DeepEval and Ragas faithfulness scores, averaged over the strategy's items"
  - "judge.json unchanged: it has no tier list (JudgeConfig forbids extra keys) and the nightly judge tier already scores faithfulness for every item"

requirements-completed: []
requirements-advanced: [GEN-02, GEN-05, GEN-07]

coverage:
  - id: D1
    description: "invalid_citation_rate, citation_coverage, cited_gold_hit and raw_invalid_markers in eval reports"
    requirement: GEN-02
    verification:
      - kind: unit
        ref: "eval/tests/test_citation_metrics.py"
        status: pass
      - kind: integration
        ref: "npm run test-rag -- --citations --groundedness --out eval/out/05-24-cit"
        status: pass
  - id: D2
    description: "Groundedness label counts by scorer and language, groundedness latency against report-only budgets"
    requirement: GEN-05
    verification:
      - kind: unit
        ref: "eval/tests/test_report_citations.py"
        status: pass
  - id: D3
    description: "by_strategy slices with generation latency p50/p95 and Faithfulness per strategy"
    requirement: GEN-07
    verification:
      - kind: unit
        ref: "eval/tests/test_report_citations.py"
        status: pass

duration: ~1.5h
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 24: Citation metrics, strategy slices and report-only groundedness budgets

**Eval reports now turn citation and groundedness traces into numbers. A run with citations reports `invalid_citation_rate`, `citation_coverage`, `cited_gold_hit` and the dropped raw markers, a `by_strategy` table (chunk-alias, claude-citations, none) with generation latency and Faithfulness, and groundedness label counts and latency against new report-only budgets. A run without that data produces exactly the same report.json and report.md as before.**

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1. Citation metrics and groundedness counts (D-24) | `5952295`: 8 of 9 cases failed against stub functions | `a9c8f97` |
| 2. Strategy slices, report-only budgets, Faithfulness entry (D-23, D-24) | `2f4cc2f`: 8 of 10 cases failed (no slices, no sections, no budget section) | `bfc463b` |
| Contract test fix (deviation 1) | — | `ed077eb` |
| Domain-neutral test sentences (orchestrator rule) | — | `3f85cc3` |

## Behaviour

- **Validity.** A `CitationRecord` is valid when its `[S<n>]` label appears in that trace's context and all of its `chunkIds` are among the trace's kept chunks. `invalid_citation_rate` is invalid records over all records. On the fixture run with `--citations --groundedness`, the rate is 0.000 over 92 records.
- **Coverage and gold hit.** `citation_coverage` counts answered items (not refused, non-empty answer) with at least one valid citation: 0.974 (n=77) on fixtures. `cited_gold_hit` counts answered items with gold spans whose valid cited quote contains a gold span by `chunk_matches_span`: 0.779 (n=68). An invalid citation never scores a hit.
- **Dropped markers.** `raw_invalid_markers` is the sum of `invalid_citations` (14 on fixtures). It is informational and does not change the invalid rate.
- **When metrics appear.** Citation metrics and `by_strategy` appear when the manifest asked for citations or any trace has a strategy or a record. Groundedness counts and latency appear only when traces carry groundedness. Otherwise the fields keep their contract defaults (`None`, `{}`).
- **Groundedness.** Labels are counted by scorer (`none` for unscored results), then by the golden item's language; pending results are skipped. Latency per scoring scorer comes from `latencyMs` and is compared with `groundedness` budgets in `latency-budgets.json`: `hhem_2_1_open` p50 2500 / p95 5000, `hhem_2_3_vectara` p50 4000 / p95 8000, `report_only: true`. The chat profile and its total are unchanged. The gate never reads these numbers (test: same gate result with groundedness latency over budget).
- **By strategy.** One slice per `citation_strategy`, with `none` for traces without one (refused or ineligible). Each slice has an item count, the three metrics, dropped markers and generation-stage p50/p95.
- **Faithfulness.** `rag_eval.runner score --judge <judge.json>` (or `build_report(..., judge=...)`) fills Faithfulness per strategy. Without judge results, the strategy table shows `skipped` and the note "judge key not configured".
- **Unchanged reports.** A test pins the sha256 of report.json and report.md for a run without citation data to the bytes written before this plan. On the fixture corpus, scoring the same traces with the pre-plan code and with this code gives byte-identical files.

## Deviations

1. **Sidecar contract test (Rule 3).** `rag-sidecar/tests/test_answer_contracts.py::test_latency_budgets_groundedness_section_is_optional_and_report_only` built its "no groundedness section" case from the committed budgets file. The planned groundedness section made it fail. The helper now drops `groundedness` from that base first. This file was not in the plan's list.
2. **Runner flag.** The plan didn't say how judge results reach the report. I added `--judge` to `rag_eval.runner score` in `eval/src/rag_eval/runner.py`, which was not in the plan's list.
3. **judge.json not edited.** The file has no tier list, and `JudgeConfig` forbids extra keys. The nightly judge tier (`rag_eval.judge.run`) already scores faithfulness for every item, so Faithfulness was already in the nightly tier. Adding a key would have needed a contract change and `gen:schemas`.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 296 files, 4703 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 172 passed |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1457 passed |
| `check-rag-boundary` + node test | ok, 38 passed |
| `node scripts/check-config.mjs` | ok (144 variables) |
| `check-workflows.py` | OK |
| eval pytest | 757 passed |
| rag-sidecar pytest | 1393 passed, 11 skipped (after `ed077eb`) |
| `npm run gen:schemas` | no diff (contracts untouched) |
| `npm run test-rag -- --out eval/out/05-24` | gate PASS |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/05-24-ingest` | gate PASS |
| `npm run test-rag -- --citations --groundedness --out eval/out/05-24-cit` | gate PASS, invalid_citation_rate 0.000 (n=92) |

## Decisions for STATE

- Citation validity in reports means the alias labels a block of that trace and every chunk id was kept.
- Citation metrics are report-only and cover every scored item.
- Faithfulness per strategy is the mean of the per-item DeepEval/Ragas faithfulness scores. Judge results reach the report through `rag_eval.runner score --judge`.

## Operator actions

- None for fixtures. For nightly Faithfulness per strategy, the nightly workflow would run `run-nightly.mts --citations` and then `rag_eval.runner score --judge eval/out/nightly/judge.json`. The workflow was not changed here (live verification, 05-26).

## Deferred

- Wiring the nightly workflow's score step with `--judge` (see Operator actions).
- TTFT as its own stage: the traces have no first-token timing, so slices report the generation stage.
