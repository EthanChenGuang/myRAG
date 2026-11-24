---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 30
subsystem: eval
tags: [rag, eval, refusal, calibration, holdout, clopper-pearson, pydantic]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: RefusalThresholds and RefusalCalibrationConfig contracts (04-04), harness_runner and dev_only_golden (04-25), bounds.upper_bound (04-26), trace retrieval_versions, query_language and refusal fields (04-21)
provides:
  - python -m rag_eval.calibrate refusal (fit per cell on dev, one-shot holdout check, JSON result, Markdown report, guarded thresholds write)
  - rag_eval.calibrate.refusal API (assign_cell, fit_threshold, fit_cells, holdout_check, calibrate_cells, run_refusal_calibration, compare_cross_same, merge_thresholds)
affects: [04-39, 04-40]

actuals:
  tokens: 20600
  tasks: 3
  commits: 6
plan_head_before: 82413cd2b250105e4ca40d0b878103ee2ce661ca
plan_head_after: 211b2f3615f6ba436376915c4cf83f9f640db9c0

tech-stack:
  added: []
  patterns:
    - "Calibration rows carry their split; the fit drops every non-dev row before computing anything, and the holdout step takes test rows only and returns counts and rates"
    - "Holdout evaluations are counted by input hash (cell rows + calibration config hash + retrieval config hash + versions), so an unchanged re-run is byte-identical"

key-files:
  created:
    - eval/src/rag_eval/calibrate/__init__.py
    - eval/src/rag_eval/calibrate/__main__.py
    - eval/src/rag_eval/calibrate/refusal.py
    - eval/tests/test_calibrate_refusal.py
    - eval/tests/test_calibrate_holdout.py
  modified:
    - eval/src/rag_eval/harness_runner.py

key-decisions:
  - "A cell is keyed provider|model|query_language|pairing. Provider comes from the run-config env RAG_RERANKER and model from overrides.rerank_model, because a trace carries neither; a run-config without a reranker on or a named model is a usage error"
  - "The top score is the highest finite rerank_score among the trace candidates (the gate's reranked[0]); a missing, null or NaN score excludes the trace with no_rerank_score and is never counted as low"
  - "A fit where no threshold beats never-refuse (all tied at correct refusal 0) is recorded as status uncalibrated with threshold null (fit_status no_separation); -inf cannot be stored and a calibrated cell needs a threshold"
  - "Holdout minimums and the pass rule come from refusal-calibration.json; the pass comparison is inclusive with a 1e-12 tolerance; the exact one-sided binomial p-value against the target is recorded in the result JSON only (RefusalCell is strict and has no field for it)"
  - "A cell short on dev data or with no separating threshold never touches the test split: holdout block is zero counts, holdout_evaluations is carried from before"
  - "Thresholds file provenance is calibration; each cell's source is fixture without --base-url and live with it, and dev/holdout minimums follow the same label"
  - "Cross versus same compares holdout false-refusal rates when both cells were read, else dev; the band is the noise.json floor because a single run has no spread"

patterns-established:
  - "The harness output of a calibration run lives under <out>/harness/ so the calibration report.md never collides with the harness report"

requirements-completed: [RNK-05, XLG-03]

coverage:
  - id: D1
    description: "Cell assignment by the A-4 rule (pairing from the top reranked candidate's language, null language is same) and a dev-only per-cell fit that picks the highest correct-refusal rate at false-refusal <= 0.05; cells under the dev minimums have no threshold; poisoning every test-split score leaves every threshold identical"
    requirement: RNK-05
    verification:
      - kind: unit
        ref: "eval/tests/test_calibrate_refusal.py -k 'assign_cell or fit_'"
        status: pass
    human_judgment: false
  - id: D2
    description: "One-shot holdout check: pass rule false_refusal_test <= target + max(noise_floor, 1/n_test_answerable), holdout minimums, statuses calibrated / failed_holdout / insufficient_data, 95% upper bound and p-value, counts and rates only, evaluation count increments only when the input hash changes"
    requirement: RNK-05
    verification:
      - kind: unit
        ref: "eval/tests/test_calibrate_holdout.py"
        status: pass
    human_judgment: false
  - id: D3
    description: "CLI writes result JSON and report without touching refusal-thresholds.json; --write-thresholds merges valid cells, replaces same keys, drops stale tokenizer or rerank-text versions, labels fixture or live; the run-config forces RAG_REFUSAL_THRESHOLD off and traces showing an applied gate are rejected"
    requirement: RNK-05
    verification:
      - kind: unit
        ref: "eval/tests/test_calibrate_refusal.py -k 'run or write or stale or cli or merge or collect or run_config'"
        status: pass
    human_judgment: false
  - id: D4
    description: "Report compares cross with same cells per query language and states whether the cross false-refusal rate exceeds the same-language rate by more than the noise band"
    requirement: XLG-03
    verification:
      - kind: unit
        ref: "eval/tests/test_calibrate_refusal.py -k 'compare_cross_same or report'"
        status: pass
    human_judgment: false
  - id: D5
    description: "Live calibration: real thresholds per provider and language on a hosted run"
    requirement: RNK-05
    verification: []
    human_judgment: true

duration: 55min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 30: Refusal calibration tool (Python eval side) Summary

**`python -m rag_eval.calibrate refusal` runs the eval with threshold refusal forced off, fits a threshold per (provider, model, query language, same|cross) cell on dev rows only, checks each once on the frozen test split with the pass rule fixed in `refusal-calibration.json`, records every count, rate and Clopper-Pearson bound, and reports cross-lingual against same-language false refusal.**

## Accomplishments

- `assign_cell` and `fit_threshold` / `fit_cells`: pairing comes from the top reranked candidate's language (null counts as same); candidates are ascending midpoints so the lowest best threshold wins; `fit_cells` filters to `split == 'dev'` before any computation, so a test row cannot reach a threshold (T-04-54). A cell under the dev minimums is `insufficient_data` with no threshold.
- `holdout_check` / `calibrate_cells`: counts and rates only, pass rule inclusive, holdout minimums per environment, `false_refusal_rate_upper_bound` on every block, exact binomial p-value kept in the result JSON. A failed cell keeps its threshold for the record and is never re-fitted. `holdout_evaluations` moves only when the input hash changes; an unchanged re-run is byte-identical (result JSON and report).
- `run_refusal_calibration` and the CLI: forces `RAG_REFUSAL_THRESHOLD=false` in the run-config handed to the harness and keeps the reranker on; rejects traces whose gate decision is `refuse` or `answer` (refusal was on); hands the harness both splits (harness output under `<out>/harness/`); writes `refusal-calibration-result.json` and `report.md`. `--write-thresholds` merges `RefusalThresholds`-valid cells into `eval/config/refusal-thresholds.json` (provenance `calibration`, atomic write), replacing same-key cells and dropping cells whose tokenizer or rerank-text version differs from the run's. Cell `source` is `fixture` without `--base-url`, `live` with it (T-04-55). Without the flag the committed file is never written; tests assert it byte-identical.
- Report: cell table with dev and holdout counts, rates, 95% upper bounds and evaluation counts; excluded-trace counts by reason; stale cells; an XLG-03 section with one verdict line per query language ("cross exceeds / does not exceed the same-language rate by more than the noise band").

## Task Commits

| Task | Commit | Subject |
| ---- | ------ | ------- |
| 1 RED | f9f47bc | test(04-30): RED for refusal cell assignment and the dev-only threshold fit |
| 1 GREEN | 48437ff | feat(04-30): refusal cell assignment and the dev-only threshold fit |
| 2 RED | 95715da | test(04-30): RED for the one-shot holdout check, statuses, bounds and idempotency |
| 2 GREEN | 7bbf6d2 | feat(04-30): one-shot holdout check with statuses, bounds and idempotent evaluation counts |
| 3 RED | 035c55f | test(04-30): RED for the calibration CLI, thresholds merge and the cross-versus-same report |
| 3 GREEN | 211b2f3 | feat(04-30): refusal calibration CLI, thresholds merge and the cross-versus-same report |

RED commits carry stubs (data models, wrong-valued functions) so the tests fail on assertions or empty results, not on a missing module.

## Deviations from Plan

**1. [Rule 3 - Blocking] `harness_runner.py` gained an opt-in `splits` argument**
- **Found during:** Task 3
- **Issue:** `run_harness` always hands the harness a dev-only golden file, but the one-shot holdout check needs test-split traces and the plan's flow ("Split by item.split") needs both splits in one run. The file is not in the plan's `files_modified`.
- **Fix:** new `golden_for_splits(path, dest, splits)` (rule split and split field must agree and be in `splits`); `dev_only_golden` now delegates to it with `("dev",)`; `run_harness(..., splits=("dev",))` default unchanged, so the sweep and its tests behave as before. Both-splits files are named `golden.dev-test.jsonl`; the dev name `golden.dev.jsonl` is unchanged. Covered by `test_harness_runner_hands_over_both_splits_only_when_asked`; `test_sweep_retrieval.py` still passes (26).
- **Commit:** 211b2f3

**2. `assign_cell(trace, reranker)` takes the reranker identity**
- The plan writes `assign_cell(trace)` giving `(cohere, fake-quality-v1, zh, cross)`. A trace carries neither provider nor model, so the identity is a second argument resolved by `reranker_identity(run_config)` (env `RAG_RERANKER`, override `rerank_model`).

**3. Choices where the plan was silent**
- A fit with no separating threshold is `uncalibrated` with a null threshold (see key decisions); the plan only said the result is `-inf`.
- Extra exclusion reasons beyond `no_rerank_score`: `no_query_language`, `no_retrieval_versions`, `no_config_hash`, `unknown_item`, `duplicate_trace`, `split_mismatch`.
- Traces from a run with refusal applied are rejected outright rather than silently scored, because candidates may have been emptied.
- A live run (`--base-url`) cannot force the refusal switch (the harness drops the env overlay against a deployed app); the post-run trace check is what enforces refusal-off there.

## Verification

- Plan verification: `uv run --frozen --directory eval pytest -q tests/test_calibrate_refusal.py tests/test_calibrate_holdout.py` 73 passed (plan needs at least 14).
- Acceptance greps: `def fit_threshold` 1, `def holdout_check` 1.
- `tests/test_sweep_retrieval.py` 26 passed (harness_runner change is backward compatible); eval suite excluding the `deepeval` / `ragas` modules passes.
- `node scripts/ci/check-rag-boundary.mjs`: ok, 968 files scanned, no violations.
- Not run on purpose: the real harness over the fixture golden file (it would read the fixture test split); the CLI is exercised with a stub runner. Fixture numbers would be uninformative anyway (04-21: the v2 floor 0.65 refuses nearly all fixture items).

## Known Stubs

None.

## Deferred Issues / Observations

- Live calibration (real provider scores, live minimums 20 / 10 dev, 6 / 3 holdout) is a live-verification item; the committed `refusal-thresholds.json` stays at zero cells.
- `<out>/harness/traces.jsonl` holds per-item scores for both splits as the harness wrote them; it is local scratch under `--out`, and the result JSON and report carry aggregates only. Do not commit an `--out` directory.
- The Phase 7 regression report must state that thresholds were screened on the same test split (A-2).
- `refusal-thresholds.json` records `holdout_evaluations` per cell but no input hash; a re-run against a fresh `--out` increments the count once more (conservative).
- 04-37 changes golden fixtures and `corpus.py`; the fixture cell counts per language and pairing should be re-checked after it merges.

## Threat Flags

None beyond the plan's register. T-04-54 mitigated (dev-only filter before the fit, poisoned-score tests at fit and record level, aggregates-only holdout object, no re-fit of failed cells). T-04-55 mitigated (source label from the run mode, nothing written without `--write-thresholds`). No package installed.

## Self-Check: PASSED

All created files exist and the six commits are ancestors of HEAD on `exec/04-30`; `eval/uv.lock` and `eval/fixtures/parse/*` unchanged.
