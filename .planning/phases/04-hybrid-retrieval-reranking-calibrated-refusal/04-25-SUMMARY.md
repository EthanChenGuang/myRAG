---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 25
subsystem: eval
tags: [rag, eval, sweep, retrieval, pydantic, noise-band]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: RetrievalParams and RetrievalOverrides contracts (04-04), harness --run-config and trace context_tokens (04-21)
provides:
  - rag_eval.harness_runner (run_harness, dev_only_golden, HarnessError) reusable by calibration (04-30) and the chunking sweep (04-35)
  - python -m rag_eval.sweep retrieval (grid sweep of pool x top-k on the dev split, D-14 selection rule, JSON and Markdown outputs, guarded params write)
affects: [04-30, 04-35, 04-39, 04-40]

actuals:
  tokens: 11600
  tasks: 2
  commits: 4
plan_head_before: 96ec63378737fb89a435888b7ab2c257a6ae57ae
plan_head_after: 694615f9beaf2cde58bc1173eea7f72265ca4ff8

tech-stack:
  added: []
  patterns:
    - "Python tools drive the Node eval harness through an injectable spawner; tests stub it and never need Node, one marked case runs the real harness"
    - "Sweeps read dev items only: dev_only_golden filters on the rule split and the split field, and the sweep re-checks every golden file the harness used"

key-files:
  created:
    - eval/src/rag_eval/harness_runner.py
    - eval/src/rag_eval/sweep/__init__.py
    - eval/src/rag_eval/sweep/__main__.py
    - eval/src/rag_eval/sweep/retrieval.py
    - eval/tests/test_sweep_retrieval.py
  modified:
    - eval/pyproject.toml

key-decisions:
  - "Size in the D-14 rule is the candidate pool size; ties on pool go to the lower mean context tokens, then the lower latency p95, then the lower top-k"
  - "Recall@k and MRR are computed from the traces at the cell's final top-k (the report carries only recall@5 and recall@10)"
  - "Single-run cells have no spread, so the noise band is the noise.json floor (0.02); choose_configuration takes an optional spread and uses max(k * spread, floor) like gate.py"
  - "A live run strips the run-config env overlay (the harness rejects an overlay with --base-url) and records that in the result notes"
  - "The sweep result is a local Pydantic model in eval, not a sidecar wire contract: no TypeScript consumer reads it"

patterns-established:
  - "Per-cell harness outputs live under <out>/cells/pool-<P>_k-<K>/ with the generated run-config and dev golden under inputs/"

requirements-completed: [RNK-02, LAT-01]

coverage:
  - id: D1
    description: "run_harness builds a dev-only golden file, writes the run-config with merged overrides, spawns run-smoke.mts with the exact flags and parses report, traces and manifest; a failed exit raises HarnessError with the last 20 stdout lines"
    requirement: RNK-02
    verification:
      - kind: unit
        ref: "eval/tests/test_sweep_retrieval.py -k harness"
        status: pass
    human_judgment: false
  - id: D2
    description: "Retrieval sweep: grid cells with cap clamp(pool, 50, 100), noise-band selection with tokens then latency tie-breaks, JSON and Markdown outputs, params written only with --write-params and a live --base-url"
    requirement: LAT-01
    verification:
      - kind: unit
        ref: "eval/tests/test_sweep_retrieval.py"
        status: pass
      - kind: integration
        ref: "eval/tests/test_sweep_retrieval.py::test_sweep_integration_two_real_cells_through_the_harness_with_v2_recommended"
        status: pass
    human_judgment: false

duration: 40min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 25: Retrieval sweep (Python eval side) Summary

**`python -m rag_eval.sweep retrieval` runs the eval harness once per pool x top-k cell on dev items only, picks the smallest pool within the noise band of the best Recall@k and MRR, and can write `retrieval-params.json` only from a live run.**

## Accomplishments

- `harness_runner.run_harness` is the shared Python entry to the harness. It filters the golden file with `dev_only_golden` (rule split and split field both `dev`), merges grid overrides over the base run-config's own overrides (for example `rerank_model`), writes the run-config under `<out>/inputs/`, and spawns `npx tsx eval/harness/run-smoke.mts --run-config ... --golden ... --no-gate --out ...` plus `--base-url` or `--fixture-mode`. It returns the parsed `EvalReport`, traces and manifest. A non-zero exit raises `HarnessError` with the exit code and the last 20 stdout lines.
- `rag_eval.sweep.retrieval`: grid default pool 25/50/75/100 x top-k 5/8/10/15/20, cell overrides `candidate_pool_size`, `rerank_input_cap = clamp(pool, 50, 100)` and `final_top_k`. Each cell is scored from its traces at its own top-k. `choose_configuration` keeps cells within the noise band on both metrics and takes the smallest pool, then lowest mean context tokens, then lowest latency p95.
- Outputs: `retrieval-sweep.json` (grid, per-cell metrics, chosen cell, noise band, run-config sha256, golden sha256, grid sha256, the would-be params with their `config_hash`) and `retrieval-sweep.md` (every cell, the chosen one marked, the dev-only rule stated).
- Write guard (T-04-48): `--write-params` without `--base-url` exits 2 before anything runs and leaves `eval/config/retrieval-params.json` byte-identical. With a live base URL it writes a `RetrievalParams` file with provenance `sweep`, keeping `rrf_k` and the leg weights from the existing file.
- Flags `--pools` and `--top-ks` narrow the grid (the integration case and quick checks use them).

## Task Commits

| Task | Commit | Subject |
| ---- | ------ | ------- |
| 1 RED | c55b649 | test(04-25): RED for the shared harness runner and dev-only golden files |
| 1 GREEN | 5c5800b | feat(04-25): shared harness runner with dev-only golden files |
| 2 RED | 0282be3 | test(04-25): RED for the retrieval sweep grid, selection rule and write guard |
| 2 GREEN | 694615f | feat(04-25): retrieval sweep over pool and top-k with the D-14 selection rule |

Each RED commit failed on assertions; stub modules carrying the data models were added so the tests import.

## Deviations from Plan

### Auto-fixed Issues

None needing a fix of existing code.

### Choices where the plan was silent

- **"Size" for the tie rule.** The plan says "if two cells tie on size, the lower mean context tokens wins". Distinct grid cells never tie on (pool, top-k), so size is the candidate pool size; cells with the same pool compete on context tokens (which follows top-k), then latency.
- **Recall@k from traces.** The report contract has only `recall_at_5` and `recall_at_10`, and its overall slice can shrink to the production population on live data. The sweep scores Recall@k and MRR over all answerable dev items from the traces, with a hit counted when the gold span's first match in `kept` is at rank <= the cell's top-k. Refused items score zero.
- **Grid hash in the params file.** `RetrievalParams` is strict and has no grid field, so the grid hash lives in `retrieval-sweep.json`; the result's `proposed_params.config_hash` equals the params file's `config_hash`, which links the two.
- **Local result model.** The sweep result is a Pydantic v2 model inside `eval/` (no Zod pair), because no TypeScript code reads it. This avoided editing `rag-sidecar` contracts that 04-26 owns.
- **Live env overlay.** The harness rejects a run-config env overlay with `--base-url`, so a live sweep writes the cell run-config with `env: {}` and notes it in the result.
- **Pytest marker.** Added `harness_integration` to `eval/pyproject.toml` (`[tool.pytest.ini_options]` only, `uv.lock` untouched). The CI smoke job runs `uv run --directory eval pytest -q`, so the two-cell case runs there; it skips when `npx` or `node_modules/.bin/tsx` is absent.
- **No `--params-path` flag.** The CLI always targets the committed path; tests use the Python API's `params_path` argument.

## Verification

- `uv run --frozen --directory eval pytest -q tests/test_sweep_retrieval.py`: 26 passed (10 harness, 15 sweep, 1 real two-cell integration through the harness with `v2-recommended`).
- Acceptance greps: `def dev_only_golden` 1, `def choose_configuration` 1; at least 7 passed.
- `node scripts/ci/check-rag-boundary.mjs`: ok, 968 files scanned, no violations.
- eval pytest overall (excluding modules that import `deepeval`): 347 passed, 8 skipped, 1 failed (`test_draft_cli::test_pinned_synthesizer_forces_style_and_length`, missing `ragas`, pre-existing and listed in 04-21).
- Fixture CLI run (`--pools 25,75 --top-ks 5,10`, v2-recommended): 4 cells, completes, no params write. Recall@k and MRR are 0.013 in every cell, which is the already documented fixture effect (legacy 0.65 similarity floor against ~0.3 fixture similarities, see 04-21 deferred items). It proves the tooling only; real numbers come from live verification.

## Known Stubs

None.

## Deferred Issues / Observations

- Fixture sweep numbers are uninformative until the 04-30 and 04-39 calibration fixes the floor for v2 on the fixture embedder.
- `noise.spread` is 0 for single-run cells. Repeated runs per cell (spread from several runs) could widen the band; `choose_configuration(..., spread=)` supports it but the CLI does not repeat runs.
- A full default grid is 20 harness runs (about 15 s each here); live runs should budget accordingly.

## Threat Flags

None. The only new trust boundary is the sweep-to-params write, covered by T-04-48 (refused without a live base URL, provenance `sweep`, hashes recorded). No package was installed.

## Self-Check: PASSED

Created files and all four commits were checked present on `exec/04-25`.
