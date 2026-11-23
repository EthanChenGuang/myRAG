---
phase: 01-evaluation-harness-baseline
plan: 20
subsystem: testing
tags: [python, pydantic, gate, baseline, noise-band, eval, smoke]

requires:
  - phase: 01-evaluation-harness-baseline
    provides: "01-16 report.json and the rag_eval.runner score CLI; 01-14 pinned eval env; 01-15 golden fixture set; 01-10 run_config_hash; 01-05 Baseline, NoiseConfig, GateResult contracts"
provides:
  - "rag_eval.gate: evaluate_gate and CLI with exit 0 (pass), 1 (regression), 2 (data mismatch or invalid input)"
  - "rag_eval.baseline: record_baseline, NonDeterministicRunError and the three-process record CLI"
  - "eval/config/noise.json (k 3, floor 0.02, gated slices overall and language:)"
  - "eval/baselines/fixture-baseline.json: committed three-run baseline of today's system on the fixture corpus"
  - "npm run test-rag now runs harness, scorer and gate; npm run eval:baseline records the baseline"
affects: [01-21, 01-22, phase-2-and-later gating, nightly tier]

plan_head_before: cb824e100a33dfd7efcdbef3d953b3732933da21
plan_head_after: aa3357597d56b63f132f7b111cdeacc20e1c7290

actuals:
  tokens: 9300
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Gate opens baseline and noise read-only and writes only gate.json and gate.md under --out"
    - "Baseline recording runs the harness in separate processes and fails on any difference instead of widening the band"

key-files:
  created:
    - eval/src/rag_eval/gate.py
    - eval/src/rag_eval/baseline.py
    - eval/config/noise.json
    - eval/baselines/fixture-baseline.json
    - eval/tests/test_gate.py
    - eval/tests/test_baseline.py
    - tests/eval-env-pin.test.ts
  modified:
    - eval/harness/run-smoke.mts
    - package.json

key-decisions:
  - "run_config_hash, golden/corpus hashes and embedder identity must match across the three runs even with --allow-spread; --allow-spread only relaxes the per-metric value check"
  - "Gate data mismatch covers golden_sha256, corpus_sha256, embedder_id and embedder_version; config and request options are what is measured and never mismatch"
  - "Live baselines (--base-url) must be written under eval/golden/private/; the CLI refuses any other path (exit 2)"
  - "Recorder exit codes: 1 non-deterministic runs (nothing written), 2 bad arguments, 3 a harness run failed"

patterns-established:
  - "Degradation demonstration: npm run test-rag -- --max-results 1 exits 1 against the committed baseline"

requirements-completed: [EVAL-09, EVAL-11]

coverage:
  - id: D1
    description: "Gate fails beyond max(3 x spread, 0.02) on overall and per-language slices (higher and lower directions), passes exactly at the threshold, skips null slices, reports categories only"
    requirement: EVAL-10
    verification:
      - kind: unit
        ref: "eval/tests/test_gate.py (12 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Gate exits 2 on golden, corpus or embedder mismatch with a re-record message and never modifies the baseline or noise files"
    requirement: EVAL-10
    verification:
      - kind: unit
        ref: "eval/tests/test_gate.py::test_data_mismatch_exits_2_but_config_difference_does_not, ::test_gate_leaves_baseline_unchanged"
        status: pass
    human_judgment: false
  - id: D3
    description: "Baseline recorder rejects fewer than three runs, fails on differing config hash or metric values, records mean and sample stdev with allow_spread"
    requirement: EVAL-09
    verification:
      - kind: unit
        ref: "eval/tests/test_baseline.py (7 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Committed fixture baseline: three runs, one run_config_hash, spread 0, validates as Baseline"
    requirement: EVAL-09
    verification:
      - kind: other
        ref: "npm run eval:baseline; Baseline.model_validate_json check from the plan's acceptance criteria"
        status: pass
    human_judgment: false
  - id: D5
    description: "npm run test-rag exits 0 on the fixture set and writes report.json, report.md, gate.json, gate.md; --max-results 1 exits 1"
    requirement: EVAL-11
    verification:
      - kind: other
        ref: "npm run test-rag -- --out eval/out/smoke-final (exit 0); npm run test-rag -- --max-results 1 --out eval/out/degraded (exit 1)"
        status: pass
      - kind: unit
        ref: "tests/eval-env-pin.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "Real-knowledge-base live baseline with improvement targets"
    requirement: EVAL-09
    verification: []
    human_judgment: true
    rationale: "Needs the real knowledge base, live keys and the reviewed private golden set; targets are a user decision"

duration: 20min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 20: Baseline and Noise-Band Gate Summary

**Three-run fixture baseline committed and `npm run test-rag` now gates against it with a max(3 x spread, 0.02) noise band on overall and per-language slices; `--max-results 1` demonstrably fails with exit 1**

## Performance

- **Duration:** about 20 min
- **Tasks:** 2
- **Files:** 7 created, 2 modified

## Accomplishments
- `rag_eval.gate` compares an `EvalReport` with the `Baseline` per gated slice and metric (band = max(k x spread, floor); strictly beyond the threshold fails, exactly at it passes; null values go to `skipped`). Categories appear in `gate.md` as report-only deltas. Golden, corpus or embedder differences exit 2 with a re-record message.
- `rag_eval.baseline record` runs `run-smoke.mts --no-gate` in three separate processes, builds the `Baseline` (stdev_ddof1; overall, language and category slices; git sha per run) and writes it with sorted keys via temp file and rename. Differing hash or metric values exit 1 without writing.
- `run-smoke.mts` now runs harness, `rag_eval.runner score` and `rag_eval.gate`, with `--no-gate` and `--baseline`; a `--base-url` run needs one of them.
- Recorded baseline (fixture corpus, deterministic embedder, run_config_hash `b9df01728083...`, all spreads 0, git sha `32f44e1`): overall recall@5 and recall@10 0.608, MRR 0.633, correct refusal 0.500, false refusal 0.300. Per language: en recall 0.525 / false refusal 0.350, it 0.675 / 0.200, zh 0.625 / 0.350. Weak categories: table (recall 0.111) and multi_turn (0.222). The zh slices carry the Filter 1 empty-term quirk (every chunk passes Filter 1 for Chinese queries), so zh is not directly comparable to en.
- Degraded run: `--max-results 1` lowers recall@5 and recall@10 overall (0.575 vs 0.608, threshold 0.588) and in all three languages; 8 offenders, exit 1. MRR and refusal rates did not move.
- Suites green: eval pytest 185, rag-sidecar pytest 131, `npm test` 69, `npm run test-rag` exit 0, `eval-env --check` exit 0.

## Task Commits

1. **Task 1: noise-band gate, noise config, gate tests** - `32f44e1` (feat)
2. **Task 2: baseline recorder, fixture baseline, run-smoke orchestration, eval:baseline script, env-pin test** - `aa33575` (feat)

## TDD Evidence

Tests and implementation were written together and committed together per task (no separate RED commit); each test file was run green before commit. Not a strict RED/GREEN split.

## Deviations from Plan

None - plan executed as written. Two interpretation choices: `--allow-spread` relaxes only the metric-value check (the config hash must always match, since a baseline over different configs is meaningless), and the recorder exit codes (1 / 2 / 3) are as listed in key-decisions.

## Issues Encountered
None. The baseline came out fully deterministic (spread 0 on every slice and metric), so the 0.02 floor is the whole band, as research predicted. Per-language slices have n about 24, so one flipped item moves a rate by about 0.04 and fails the gate (the flagged EVAL-09 risk, unchanged).

## Known Stubs
None.

## Threat Flags
None. T-01-31: the gate opens baseline and noise read-only (test `test_gate_leaves_baseline_unchanged` hashes both). T-01-32: recorder exits 1 on differing hash or values. T-01-33: live baselines are refused outside `eval/golden/private/`; the secret is only inherited from the caller's env by the harness.

## User Setup Required
Manual, not done here: the real-knowledge-base live baseline (`RAG_EVAL_SECRET=<secret> uv run --directory eval python -m rag_eval.baseline record --runs 3 --base-url <url> --golden eval/golden/private/golden-v1.jsonl --allow-spread --out eval/golden/private/live-baseline.json`) and the improvement targets derived from it.

## Next Phase Readiness
- Plan 01-22 can wire `npm run test-rag` into CI as the PR smoke tier; EVAL-10 stays Pending until the workflows exist.
- EVAL-10 paired differences are available per item through the `items` rows in every report; no separate paired statistic was added (flagged assumption).

## Self-Check: PASSED

Created files exist (gate.py, baseline.py, noise.json, fixture-baseline.json, three test files); commits `32f44e1` and `aa33575` are ancestors of HEAD.

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
