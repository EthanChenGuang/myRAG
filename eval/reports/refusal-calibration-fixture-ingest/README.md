# Fixture similarity floor, ingest mode (plan 03.3-25)

Source of `eval/config/fixture-score-calibration.ingest.json`. Eval harness only: the floor is read for the `eval` embedding
profile (`evalFloorCalibration`) when the harness runs `--fixture-mode ingest`, and only by the v2 similarity-floor refusal.
Production profiles keep their own `score_calibration`; the legacy pipeline's keep rule (0.65) is not read from this file.

- Command (Python entry of `python -m rag_eval.calibrate refusal --fixture-mode ingest --write-thresholds`, as plan 05.3-15 did
  for the prechunked floor; the threshold cells went to a scratch copy, so `eval/config/refusal-thresholds.json` is unchanged):
  `run_refusal_calibration(eval/config/runs/v2-recommended.json, eval/out/03.3-25-calibrate-ingest, write=True, fixture_mode="ingest", thresholds_path=<scratch copy>)`
- Base run: `v2-recommended` (same base as the prechunked floor), ingest fixture, merged golden 500 items (sha256 in the result file).
- Fit: dev split only, best dense similarity per item, target false refusal 0.05 (`eval/config/refusal-calibration.json`).
- Result: `context_threshold` 0.1599; dev answerable 199, no-answer 51; dev false refusal 0.040 (95% upper 0.071); dev correct
  refusal at the floor alone 0.196.
- No gate file or threshold in `eval/config/quality-gates.json` or `eval/config/phase33-gates.json` was changed.
