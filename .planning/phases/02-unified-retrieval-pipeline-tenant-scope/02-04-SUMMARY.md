---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 04
subsystem: testing
tags: [eval, paired-difference, bootstrap, baseline, gate, pydantic, zod]

requires:
  - phase: 01-eval-foundation
    provides: baseline recorder, noise-band gate, EvalReport.items, schema-to-Zod generator
provides:
  - PairedStat and PairedReport contracts, Baseline.items and GateResult.paired, mirrored in JSON Schema and Zod
  - rag_eval.paired module and CLI (item_metrics, paired_report, main) with a fixed-seed percentile bootstrap
  - baseline record stores item id -> metric -> per-run values for every split
  - gate.json and gate.md carry the paired block next to the unchanged noise-band decision
  - fixture baseline re-recorded from the pre-pipeline code with 72 per-item rows
affects: [02-11, 02-21]

actuals:
  tokens: 16100
  tasks: 2
  commits: 5
plan_head_before: 43484cde51a9c3ce5fa789bdfa5d469019af5b7c
plan_head_after: 52c79040936dcaac29613afaea6ccd19f874a5d3

tech-stack:
  added: []
  patterns:
    - "Paired statistics are stdlib only: random.Random with a fixed seed, math.fsum, nearest-rank percentiles"
    - "A new optional contract field defaults to None so older baselines still load and the gate reports paired: null"

key-files:
  created:
    - eval/src/rag_eval/paired.py
    - eval/tests/test_paired.py
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/baseline.py
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/schemas/Baseline.schema.json
    - rag-sidecar/schemas/GateResult.schema.json
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json
    - eval/src/rag_eval/baseline.py
    - eval/src/rag_eval/gate.py
    - eval/tests/test_baseline.py
    - eval/tests/test_gate.py
    - eval/baselines/fixture-baseline.json

key-decisions:
  - "Slice membership comes from the report items of the gate split, filtered by noise.gated_slice_prefixes; the baseline rows only supply the reference values, so baseline.items needs no split or language fields"
  - "Each (slice, metric) cell gets its own random.Random(20261123), so an interval does not depend on which other cells exist or their order"
  - "all_zero is true only when at least one cell has data and no cell has a nonzero difference, so an empty comparison cannot pass as parity"
  - "All-zero cells skip the resampling and report an exact [0, 0] interval, identical to what the bootstrap would give"
  - "Runs over different item sets are NonDeterministicRunError (field 'item set'); a report with no items records items as None"

patterns-established:
  - "Per-item rows reuse the slice definitions (recall = hits/span_count, mrr = 1/first_hit_rank or 0) so a slice mean equals the mean of its rows"

requirements-completed: [PIPE-09]

coverage:
  - id: D1
    description: "Paired contracts (PairedStat, PairedReport, Baseline.items, GateResult.paired) in Pydantic, JSON Schema and Zod, with generated files committed and in parity"
    requirement: PIPE-09
    verification:
      - kind: unit
        ref: "rag-sidecar tests/test_contract_models.py, tests/test_contract_export.py; vitest tests/contracts.test.ts, tests/schema-parity.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "rag_eval.paired computes per-item metrics, per-slice n, n_nonzero, mean difference and a fixed-seed bootstrap interval; identical runs give [0, 0] and all_zero"
    requirement: PIPE-09
    verification:
      - kind: unit
        ref: "eval/tests/test_paired.py (10 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "baseline record stores per-item rows; the gate attaches and renders the paired block without changing the decision or exit codes 0/2/10/70"
    requirement: PIPE-09
    verification:
      - kind: unit
        ref: "eval/tests/test_baseline.py, eval/tests/test_gate.py (33 tests)"
        status: pass
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/paired; jq -e '.passed == true and .paired.all_zero == true' eval/out/paired/gate.json"
        status: pass
    human_judgment: false
  - id: D4
    description: "Committed baseline re-recorded from unchanged pre-pipeline code: slices and identity fields identical to the previous baseline, plus 72 item rows"
    requirement: PIPE-09
    verification:
      - kind: other
        ref: "old/new comparison script, differing keys outside items/run_config_hash/runs: []"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-11-23
status: complete
---

# Phase 2 Plan 04: Paired Differences and Per-Item Baseline Summary

**Per-item baseline rows plus a fixed-seed paired-difference report (seed 20261123, 10000 resamples) attached to the gate, with the fixture baseline re-recorded from unchanged pre-pipeline code so later parity runs can be proven item by item.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-11-23T14:20:00Z
- **Completed:** 2026-11-23T14:28:00Z
- **Tasks:** 2
- **Files modified:** 14

## Accomplishments
- `rag_eval.paired` turns each `ItemResult` into the same per-item values the slice metrics average, pairs report items against the mean of the recorded baseline runs, and reports n, n_nonzero, mean difference and a percentile bootstrap 95% interval per gated slice and metric. Identical runs give mean 0, interval [0, 0] and `all_zero` true.
- `baseline record` now stores `items` (item id -> metric -> per-run values) for every split; `GateResult.paired` and a "Paired differences" section in `gate.md` show the result. The pass/fail rule is still only the noise band.
- The committed baseline was re-recorded from the unchanged code and carries 72 item rows. A parity-style gate run on the same code gives `passed: true` and `paired.all_zero: true`.

## Task Commits

1. **Task 1: Paired contracts and the rag_eval.paired module** (TDD)
   - contracts and regenerated schemas, Zod and samples - `1a97972` (feat)
   - RED - `6d9bda4` (test)
   - GREEN - `4ed527d` (feat)
2. **Task 2: Baseline records items, gate attaches paired, baseline re-recorded**
   - recording and gate attachment with tests - `0b5b39b` (feat)
   - re-recorded baseline - `52c7904` (chore)

**Plan metadata:** the docs commit that adds this file.

## TDD Gate Compliance

- **RED:** `eval/tests/test_paired.py` (10 tests) was committed against a stub whose `item_metrics` returned `None` for every metric and whose `paired_report` returned an empty report with seed 0. All 10 failed on assertions or on missing slices in the stub's empty result, not on import errors. Machine check: `gsd_run check tdd-red-evidence` on the JUnit report of `test_answerable_item_with_partial_hits_scores_recall_and_mrr` returned `RED_EVIDENCE_OK` (reason `target_test_failed`). Semantic assessment: the target ran and failed on `{'mrr': None} != {'mrr': 0.5}` and the matching recall/refusal differences, which is the planned assertion for the intended reason.
- **GREEN:** `4ed527d`, all 10 pass.
- **REFACTOR:** none needed.

## Old/new baseline comparison (T-02-07)

Old baseline saved to `eval/out/baseline-before.json` before `npm run eval:baseline`. Comparison drops exactly `items`, `run_config_hash` and `runs` and compares the rest as sorted JSON:

```
python3 cmp.py   # loads old and new, strips {items, run_config_hash, runs}, diffs remaining keys
keys compared: corpus_sha256, deployment_mode, embedder_id, embedder_source_sha256, embedder_version,
               golden_filter, golden_sha256, request_options, schema_version, slices, spread_kind, tier
differing keys outside items/run_config_hash/runs: []
slices block byte-identical (json.dumps sort_keys equal): True
items rows: 72 (old baseline had none)
```

`run_config_hash` and the `runs[*]` metadata (run_id, created_at, git_sha, run_config_hash) differ, as expected after a fresh recording; no retrieval or route code was changed in this plan.

## Decisions Made
See `key-decisions` in the frontmatter. In short: slice membership is taken from report items of the gate split; one RNG per cell; `all_zero` needs at least one cell with data.

## Deviations from Plan

None - plan executed exactly as written.

Notes on small choices inside the plan's latitude: `gate._is_gated` now delegates to `paired.is_gated_slice` so the two modules share one prefix rule; the CLI `--out` is a file path for the PairedReport JSON.

## Issues Encountered
None.

## Known Stubs
None.

## Threat Flags
None. No network, auth or file-access surface was added; the work is stdlib statistics over local JSON.

## Self-Check
Verified before commit: all key files exist; commits `1a97972`, `6d9bda4`, `4ed527d`, `0b5b39b`, `52c7904` are ancestors of HEAD; acceptance criteria rerun (`PairedReport` class present, seed 20261123 present in `paired.py`, 10 paired tests pass, baseline `items` non-empty, `paired` referenced in `gate.py`); plan verification: eval pytest 239 passed, rag-sidecar pytest 138 passed, vitest contracts and schema parity 48 passed, `gen:schemas` leaves a clean tree, `npm run test-rag` passes with `paired.all_zero == true`.

## Self-Check: PASSED
