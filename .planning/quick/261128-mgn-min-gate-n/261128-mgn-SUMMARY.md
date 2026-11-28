---
quick_id: 261128-mgn
slug: min-gate-n
status: complete
branch: exec/quick-min-gate-n
base: origin/ci/merge-train-39
commits:
  red: 1f358713
  pre_registration: 50346847
  report_rendering_fix: ac0bc2e8
  rerun: e00a63be
---

# Summary: min_gate_n for the phase gates' no-slice-drop check

Owner decision 2026-11-28 (about 00:25Z, the owner in the orchestrator session): option (a) of proposal (c) in
`.planning/debug/phase42-scanned-slice-regression.md` (exec/debug-42-scanned, a5927a673). It is recorded in the 03.3, 04.2,
04.4 and 05.2 CONTEXT files under "Owner decision (2026-11-28): minimum n for the no-slice-drop check".

## Commits

| Commit | What |
| --- | --- |
| 1f358713 | RED: `eval/tests/test_min_gate_n.py`. 9 tests failed on assertions; the "n=10 still fails" case passed on the old code, as it should. |
| 50346847 | **Pre-registration (D-37).** The rule, the spec entries, the CONTEXT records and this plan. Pushed before any gate ran under it. |
| ac0bc2e8 | Reporting fix: the phase42/44 markdown renderers now list the `below_min_n` lines that `gates.json` already held. A RED test was checked against the old renderers (2 failed). Verdicts are unchanged. |
| e00a63be | Re-run of `rag_eval.phase42_gate` and `rag_eval.phase44_gate` on the full specs. Results are recorded as produced. |

## Rule (no_slice_drop_rule version 2)

- `rag_eval.phase_compare.SliceGateRule` (`version: 2`, `min_gate_n` default 10, `ge=1`) is on every spec model that runs
  the slice-drop check: `ComparisonSpec`, `SwitchComparisonSpec`, `Phase42GateSpec`, `Phase44GateSpec` and `Phase33GatesSpec`.
  A spec that leaves it out gets 10. Version 1 is the earlier rule, which had no minimum.
- `slice_drops` checks each noise-band offender's slice. If the slice has fewer than `min_gate_n` scored items on that metric,
  the offender moves into `skipped` as a note `<slice>:<metric> below_min_n (n=… < min_gate_n=…, reported, not gated): …`
  and does not count towards pass or fail. Absolute-zero offenders and mismatches are untouched. The spec's value reaches
  every comparison of a run through `with_min_gate_n` (a `NoiseConfig` subclass), so `noise.json` and its contract are unchanged.
- Where the notes are reported:
  - `no_slice_drop_check` and `category_noise_check` (phase 5.x/6, 3.3) list them in `detail`.
  - Phase 4 results carry them in `RecommendedCheck.below_min_n` and `SwitchResult.below_min_n`.
  - Phase 4.2/4.4 outcomes (`GateOutcome`, and phase 4.2's `RuleOutcome`) carry them in `below_min_n` and render them in
    the markdown.
- The spec entry `"no_slice_drop_rule": {"version": 2, "min_gate_n": 10}` is in `phase4-comparison.json`,
  `phase33-comparison.json`, `phase33-gates.json`, `phase42-gates.json`, `phase44-comparison.json`, `phase5-comparison.json`,
  `phase51-comparison.json`, `phase5.1.1-comparison.json`, `phase52-comparison.json` and `phase6-comparison.json`.
  `phase32-comparison.json` (an arm comparison with no slice-drop check) and `phase31-parse-gate.json` are not affected.
- Not changed: the CI regression gate (`rag_eval.gate.evaluate_gate`, `rag_eval.regression`, which already has its own
  `min_gate_n`), `eval/config/noise.json`, thresholds, noise bands and metrics.
- The existing band-arithmetic tests (`test_phase_compare.py`, `test_phase42_gate.py`, `test_phase44_gate.py`) use 1–7 item
  synthetic slices. They now pin `min_gate_n=1` so they keep testing the band. The rule itself is tested in `test_min_gate_n.py`.

## sha256 pins

No test pins a spec's sha256. Two committed decision records hold the sha256 that a spec had when those decisions were made:
`eval/decisions/04.2-lexical.json` (`phase42-gates.json`) and `eval/decisions/04.4-lexical-scoring.md` (`phase44-comparison.json`).
Under the owner's rule they are historical conclusions from before the registration, so they are not updated. A new decision
taken on the v2 rule records the new spec hash.

## Re-run results (e00a63be, recorded as produced)

The reports are in `eval/reports/phase-04.2/min-gate-n-v2/` and `eval/reports/phase-04.4/min-gate-n-v2/`. The earlier
`eval/reports/phase-04.2/gates.json` and `eval/reports/phase-04.4/gate.json` are not changed.

- **phase42_gate: PASS.**
  - Gates: off_identity, diversity, identifier, table, versions and dictionary all PASS.
  - Rules: stem_it `keep_off`; refusal_mode_cells `keep`.
  - The earlier FAIL cause, `category:scanned` (n=4) recall_at_10 and mrr on `v2-diversity-mmr` and `v2-identifier-on`
    against `v2-default`, is now listed as below_min_n.
  - `category:duplicate_flood` (n=6) is below_min_n in the stem_it rule.
- **phase44_gate: FAIL.**
  - off_identity PASS; cap_agreement PASS.
  - **on FAIL**: `v2-lexical-bm25-on-ingest` `category:scanned` recall_at_10 0.9286 < 0.9800 against `v2-default-ingest`
    1.0000. This slice has n=14 in ingest mode, which is at least `min_gate_n`, so it stays gated.
  - Below min_gate_n: `category:duplicate_flood` (n=6) recall_at_5 and recall_at_10 on prechunked, and recall_at_5 on ingest.
  - Report-only pair `v2-lexical-bm25-on-rerank-none-prechunked`: category:general mrr and category:multi_turn recall_at_5 moves.

## Gates run

- `uv run --all-extras --frozen python -m pytest -q -n auto` in eval/: 2802 passed (after the registration change).
- Gate tool tests after the rendering fix: `tests/test_min_gate_n.py`, `test_phase42_gate.py`, `test_phase44_gate.py`: 70 passed.
  `test_phase_compare.py`, `test_phase33_gate.py` and the same files earlier: 208 passed.
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-min-gate-n-ingest`: absolute gate PASS, gate PASS (8 skipped).
- `node scripts/ci/check-rag-boundary.mjs`, `scripts/check-config.mjs`, `scripts/ci/check-language-literals.mjs`,
  `scripts/ci/check-settings-classification.mjs`: all exit 0.
- `rag_eval.phase42_gate` and `rag_eval.phase44_gate` (full specs; after the rendering fix, re-rendered with `--reuse` from the same runs).
- Setup: `npm ci --ignore-scripts --onnxruntime-node-install-cuda=skip`, `uv sync --locked --all-extras` (eval),
  `python3 scripts/ci/fill-tiktoken-cache.py`.

## Deviations

- The RED test commit (1f358713) comes before the pre-registration commit. It holds tests only: no rule, spec or gate result.
- The rendering fix landed after the registration. It only displays notes the registered rule already writes to JSON.
- The rule was also written into the phase 4, 5, 5.1, 5.1.1, 6 and 3.3-comparison specs, because they share
  `phase_compare.slice_drops` and would otherwise use the default without naming it.

## Deferred

- The phase 4.4 `on` FAIL on ingest `category:scanned` (n=14) is a real gated drop under the v2 rule. It belongs to the
  4.2 gap plan for (b1)/(b2) in the debug note, or to a 4.4 follow-up. Nothing is tuned here.
- `eval/reports/phase-04.2/gates.json` and `eval/reports/phase-04.4/gate.json` still hold the pre-registration verdicts.
  Whether the v2 reports replace them is a coordinator or owner call.
