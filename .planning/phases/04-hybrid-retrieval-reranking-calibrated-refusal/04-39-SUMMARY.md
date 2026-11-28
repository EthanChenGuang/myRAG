---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 39
subsystem: eval
tags: [refusal-calibration, retrieval-sweep, similarity-floor, fixture, xlg-03, outcome]
requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-25 sweep tool, 04-30 calibration tool, 04-21/04-23 run configs and rerank stage, 04-38 calibration-cell golden items"
provides:
  - "eval/config/refusal-thresholds.json with fixture cells (fake-quality-v1; en/it/zh same calibrated, cross insufficient_data)"
  - "eval/config/fixture-score-calibration.json: dev-fitted fixture similarity floor (context_threshold 0.1159), eval harness only"
  - "eval/reports/retrieval-sweep-fixture/retrieval-sweep.{json,md}"
  - "eval/reports/refusal-calibration-fixture/{refusal-calibration-result.json,report.md,outcome.json}"
  - "eval/tests/test_fixture_calibration_outputs.py over the committed outputs"
affects: [04-40, 04-43]
actuals:
  tokens: 24000
  tasks: 3
  commits: 17
plan_head_before: 1efbe9ee027cccddb9250da14e76230120aa6f34
plan_head_after: 9bd282ba5e219cc44e9a848a77c68f3df04025ef
key-files:
  created:
    - eval/config/fixture-score-calibration.json
    - eval/harness/fixture-floor.mts
    - eval/reports/retrieval-sweep-fixture/retrieval-sweep.json
    - eval/reports/retrieval-sweep-fixture/retrieval-sweep.md
    - eval/reports/refusal-calibration-fixture/refusal-calibration-result.json
    - eval/reports/refusal-calibration-fixture/report.md
    - eval/reports/refusal-calibration-fixture/outcome.json
    - eval/tests/test_fixture_calibration_outputs.py
    - eval/tests/test_calibrate_floor.py
    - tests/fixture-floor.test.mts
  modified:
    - eval/config/refusal-thresholds.json
    - eval/src/rag_eval/calibrate/refusal.py
    - eval/src/rag_eval/sweep/retrieval.py
    - eval/src/rag_eval/paths.py
    - eval/harness/run-eval.mts
    - src/lib/rag/refusal/floor.ts
    - src/lib/rag/v2/stages/rank.ts
    - src/lib/rag/v2/config-hash.ts
    - eval/tests/test_calibrate_refusal.py
    - eval/tests/test_sweep_retrieval.py
    - eval/tests/test_config_files.py
    - tests/rag/refusal/floor.test.ts
    - tests/rag/v2/params-hash.test.ts
    - .gitignore
key-decisions:
  - "Fixture similarity floor (coordinator decision, option 1): the calibration tool fits context_threshold on dev (best dense similarity per item, 0.05 target, fixture dev minimums) and writes eval/config/fixture-score-calibration.json (source fixture); the in-process harness installs it for the eval profile and the fixture mode it was fitted on; production keeps the legacy 0.65"
  - "The fixture floor is not part of the retrieval config hash, matching how a profile's score_calibration is already treated (identified by profile id)"
  - "Retrieval config hash includes the thresholds file only while RAG_REFUSAL_THRESHOLD is on; otherwise calibration fed its own output into its next input hash"
  - "Calibration rejects only threshold-gate decisions; D-30 floor decisions are expected with the switch off and leave candidates in the eval trace"
  - "XLG-03 not comparable on fixture — deferred to live calibration (04-43)"
requirements-completed: [RNK-02, LAT-01]
duration: 260min
completed: 2026-11-25
status: complete
---

# Phase 4 Plan 39: Fixture sweep, refusal calibration and outcome Summary

**Both tuning tools ran on the fixture with the fake quality reranker and their outputs are committed. Same-language threshold cells are calibrated for all three languages, and a dev-fitted fixture similarity floor replaces the 0.65 fallback for eval runs. With both applied, dev false refusals drop from 4 to 1 at the same correct-refusal rate. Correct refusal does not rise, so the plan's "correct refusal improves" criterion is not met on the fixture.**

## Results

**Refusal calibration** (`report.md`, fake-quality-v1, source fixture; holdout read once per cell, `holdout_evaluations` 1; a second run with unchanged inputs is byte-identical across all four written files):

| Cell | Status | Threshold | Dev ans / no-ans | Dev FRR (upper) | Holdout ans / no-ans | Holdout FRR (upper) |
|---|---|---|---|---|---|---|
| en same | calibrated | 0.1497 | 27 / 7 | 0.000 (0.105) | 7 / 1 | 0.143 (0.521) |
| it same | calibrated | 0.0785 | 18 / 5 | 0.000 (0.153) | 10 / 4 | 0.100 (0.394) |
| zh same | calibrated | 0.0446 | 28 / 4 | 0.000 (0.101) | 9 / 3 | 0.000 (0.283) |
| en cross | insufficient_data | - | 2 / 1 | - | - | - |
| it cross | insufficient_data | - | 4 / 1 | - | - | - |
| zh cross | insufficient_data | - | 3 / 3 | - | - | - |

Why the cross cells are short: pairing comes from the top reranked candidate's language (this matches the gate). v2-recommended runs with translation off, and the fixture reranker scores by word overlap, so evidence in another language almost never ranks first. 27 items labelled cross in the golden set land in same-language cells. **XLG-03: not comparable on fixture — deferred to live calibration (04-43).** It is not claimed as met.

**Fixture similarity floor** (`eval/config/fixture-score-calibration.json`): context_threshold 0.1159; dev 86 answerable / 21 no-answer; false refusal 0.047 (upper 0.103); correct refusal 0.333. It is fitted on dev only, and the test split is not read.

**Retrieval sweep** (dev only, thresholds and floor applied):
- Chosen: pool 25, cap 50, top-k 20 (recall@20 0.907, MRR 0.769).
- Best: pool 75/100, top-k 20 (0.919 / 0.770).
- Noise band: 0.020.
- `retrieval-params.json` is unchanged.
- The gains mostly reflect the lexical fixture embedder (F-9).

**Outcome** (`outcome.json`, both runs with the fixture floor):

| Split | Run | Correct refusal (upper) | False refusal (upper) |
|---|---|---|---|
| dev | v2-recommended | 0.333 (0.536), n=21 | 0.012 (0.054), n=86 |
| dev | v2-all-off | 0.333 (0.536) | 0.047 (0.103) |
| test | v2-recommended | 0.222 (0.550), n=9 | 0.067 (0.195), n=30 |
| test | v2-all-off | 0.333 (0.655) | 0.100 (0.239) |

- The dev false-refusal point estimate (0.012) is within target plus noise floor (0.07).
- Its upper bound (0.054) is above the 0.05 target, so the file does not claim the target is met (F-19).
- Refused answerable and answered no-answer items are listed by id.
- On dev, both runs refuse the same 7 no-answer items. The fake reranker's scores follow the fixture embedder, so the threshold cells refuse what the floor already refuses. The thresholds help only by cutting false refusals (it-selective-filter-004 remains).

**Reference numbers for 04-40** (v2-all-off now uses the fixture floor): dev recall@5 0.837, recall@10 0.872, MRR 0.756, correct refusal 0.333, false refusal 0.047. Before this plan they were 0.023 / 1.000 / 0.977. 04-40 reads these new all-off numbers. The floor is installed only for prechunked runs, because that is the mode it was fitted on. Ingest-mode v2 runs (04-40's parent-child comparison) still use the 0.65 floor.

## Task Commits
1. Task 2 deviations:
   - floor-aware refusal-off check: `7e5240c8` RED, `f88e7588` fix
   - config hash: `1e0ab5e8` RED, `d1fe1ad3` fix
   - repo-relative paths: `c7db1573` RED, `40bdd89a` fix
2. Task 2 calibration: `15d1e6a1`. Task 1 sweep: `e79ee8bc`.
3. Fixture floor (coordinator option 1):
   - tool: `d0723e8a` RED, `953327bc` GREEN
   - eval-only slot and harness loader: `4c328836` RED, `02aba2e2` GREEN
   - re-recorded calibration: `e8e9f1c9`
   - sweep re-run: `ef76c431`
4. Task 3: `3d1dc338` RED, `686460d4` outcome. Config test isolation: `9bd282ba`.

## TDD
Each fix and feature has a RED commit that fails on assertions; stubs are included where an import would otherwise fail.
- floor-aware check: 2 failed (CalibrationError on floor traces)
- hash: 1 failed (equal-hash assertion)
- paths: 2 failed (absolute path)
- floor tool: 6 failed
- TS slot and loader: 1 vitest + 1 node failure
- outcome: 9 failed on `OUTCOME.is_file()`

`gsd_run check tdd-red-evidence` was not run (this is an execute plan).

## Deviations from Plan

1. **[Rule 1] The calibration aborted on every fixture run.** The D-30 floor decides even with the switch off. The check now rejects only threshold-gate decisions. (`f88e7588`)
2. **[Rule 1] The retrieval config hash fed the thresholds file back into calibration.** `holdout_evaluations` went 1, 2, 3 on unchanged reruns. The thresholds hash now counts only while refusal is on. This changes retrieval_config_hash values for refusal-off v2 traces; it has no effect on behaviour. (`d1fe1ad3`)
3. **[Rule 2] Committed results carried absolute checkout paths.** They now record `repo_relative` paths, and the calibration tests use their own thresholds file. (`40bdd89a`)
4. **Sweep file names.** The tool writes `retrieval-sweep.json` / `retrieval-sweep.md`, not result.json / report.md. The tool's names were kept.
5. **Order.** Calibration ran before the sweep. Without thresholds and a usable floor, every sweep cell scored recall 0.023 because the floor refused everything.
6. **[Rule 4, decided by coordinator] Fixture similarity floor.** This adds the tool step, the `FixtureScoreCalibration` model, the eval-only slot in `floor.ts` (read by `rank.ts` for profile `eval` only), `eval/harness/fixture-floor.mts` and the harness install. A test asserts that `LEGACY_PROFILE` and the setup/migration SQL keep `context_threshold` 0.65. The new file name `eval/config/fixture-score-calibration.json` is not in the plan list. After the thresholds reset, only the cells' `recorded_at` changed (date rollover).
7. **Plan criterion not met.** "Correct refusal (dev) of v2-recommended > v2-all-off" ties at 0.333, so the plan's acceptance `jq -e '.dev.v2_recommended.correct_refusal > .dev.v2_all_off.correct_refusal'` returns false. The test asserts what the data shows instead: correct refusal not lower, false refusal strictly lower, and `comparison.dev_correct_refusal_improved` recorded truthfully (false). On the test split, v2-recommended's correct refusal is lower (0.222 vs 0.333).
8. **[Rule 3] `eval/tests/test_config_files.py` rewrote the committed config files.** It also assumed they were still at defaults. It now runs init under a temporary root, and checks that the committed calibrated thresholds file is protected. (`9bd282ba`)
9. **`.gitignore`** now ignores `eval/reports/*/{harness,inputs,cells}/`, the tool's scratch output (95 MB for the sweep).

Migration number: none used.

## Issues Encountered
- `tests/rag-db/v2-tracer.test.mts` now passes. It also passes with the floor file removed, so the floor is not what fixed it; earlier summaries recorded it failing on the 0.65 floor.
- Not run: the full vitest and rag-db suites (machine load). Targeted runs: tests/rag/refusal, tests/rag/v2, eval-route-v2, eval-harness, eval-corpus (179 passed), and the rag-db harness tests v2-tracer, v2-invoice-filters, ingest-eval-retrieval-env, in-process-eval-lifecycle, eval-v2-overlay, translation-seam-fixture (all pass).

## Gates
- `npx next typegen && npx tsc --noEmit`: 0 errors.
- `node --import tsx --test tests/*.test.mts`: 166 pass.
- check-rag-boundary and its node test (38 pass), check-config, check-workflows: pass.
- eval pytest without test_parse_fixtures: 579 pass, plus test_config_files (7 pass after the fix).
- `npm run test-rag` passed in both modes, legacy numbers identical to 04-38.
- `eval/fixtures/parse/*` untouched; no packages installed.

## Known Stubs
None.

## Threat Flags
None new. For T-04-67, the floor is applied only to profile `eval`, only from a file labelled source fixture, and only by the in-process harness. Production reads `LEGACY_PROFILE` or the DB profile, and the test pins the legacy 0.65.

## Self-Check: PASSED
