---
quick_id: 261128-w1r
slug: diversity-reregister
branch: exec/quick-42-w1-reregister
base: origin/ci/merge-train-39 (3f4f5e715)
source: 04.2-VERIFICATION.md W-1 (origin/verify/04.2, 32cb5cd44)
status: complete
phase_verdict: 04.2 stays human_needed
---

# Quick 42: W-1, re-register the diversity gate and re-run (owner option b)

## Owner decision
Option (b). The owner made it in person in the orchestrator session, 2026-11-27 about 23:37Z, in these words: "按建议选(b)".
The post-failure change of e05b77f90 is not accepted as made. Re-register first, then re-run. Recorded in
`handoffs/04.2-32-gate-diversity.md`.

## Commits (in order; the order is the evidence)
| # | Commit | What |
| --- | --- | --- |
| 1 | 98d6ea325 | Pre-registration, pushed before any run: `eval/config/phase42-gates.json` diversity `version: 2` with `redundancy_measure` (unit `cluster_value_signature`, definition, supersedes v1), `noise_band` (source `eval/config/noise.json`, max(3 x spread, 0.02), spread 0 → 0.02), `max_chunks_per_unit: 1`. The spec model (`DiversityGate`, `RedundancyMeasure`, `NoiseBandSource` in `eval/src/rag_eval/phase42_gate.py`) refuses a v1 spec. The gate fails an item that keeps a clustered chunk when its trace has no app value, so the scorer's cluster-only fallback is not accepted. Tests in `eval/tests/test_phase42_gate.py`. Handoff records the decision and the threshold choice. |
| 2 | 661ac8c5d | Re-run of `uv run --directory eval python -m rag_eval.phase42_gate --spec eval/config/phase42-gates.json --out eval/reports/phase-04.2`: gates.json, README.md and the result section of the handoff |
| 3 | 30f5a4a5e | `supabase/migrations/0863_retrieval_log_redundancy.sql` line 1 comment now states the v2 unit. It is a `--` comment with no SQL change, so no new migration is needed. |

Threshold: kept at 1/k (the original D-22 rule). It is the only number backed by data from before any gate run, and keeping
it means no number was fitted to a result. Only the counting unit changes. The v2 unit was written after the round-2
failure had been seen, and the handoff says so.

## Re-run result (exit 1, FAIL), per cell
| Gate / rule | Verdict | Cells |
| --- | --- | --- |
| off_identity (D-37) | PASS | nonzero_cells 0 for off-prechunked, off-ingest, v2-default-phase42-off |
| diversity (D-22 v2) | FAIL | collapse: intent_coverage 1.0, items 6, max_redundancy_over_limit 0.0. mmr: 1.0, 6, 0.0. Offenders: v2-diversity-mmr `category:scanned` recall_at_10 0.7500 < 0.9800 (ref 1.0000), mrr 0.7500 < 0.7657 (ref 0.7857) |
| identifier (D-32) | FAIL | precision 1.0 (n 12), leakage 0.0 (n 12), descriptive 196 items, R@5 0.7088 / R@10 0.7206 / MRR 0.6251, each equal to the reference. Offenders: `category:scanned` recall_at_10 0.75 vs 1.00, mrr 0.75 vs 0.7857 |
| table | PASS | items 3, items_with_leg 3 |
| versions | PASS | items 3, superseded_kept 3 |
| dictionary | PASS | no slice drop |
| stem_it | keep_off | |
| refusal_mode_cells | keep | |

- The diversity v2 criteria themselves (redundancy and intent coverage) pass. Both FAILs come only from the
  `category:scanned` slice-drop check. That slice was added after Phase 4.2, and the orchestrator reports the same drop on a
  fresh merge-train-39 run without this change. It does not depend on the redundancy measure. A separate debug task owns it.
- Recomputed under the old v1 measure from the same traces: the scanned drop is the same. v2-diversity-collapse would also
  fail on `zh-duplicate-flood-002` (0.25 > 1/8), as in round 2. Every other item is equal under v1 and v2.
- Nothing was adjusted after the run. Phase 4.2 stays `human_needed`.

## Deviations
- The task asked for single-tenant and multi-tenant fixture runs. `phase42_gate` has no deployment-mode option: the eval pin
  fixes `single-tenant` (`eval/harness/eval-env.mts`). The run covers both fixture modes of the spec, prechunked and
  ingest. A multi-tenant gate run would need a tool change, which is out of scope here.

## Gates run
- `cd eval && uv run --all-extras python -m pytest -q`: 2789 passed
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: pass
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-42-ingest`: gate PASS, absolute gate PASS
- `ruff check` on the changed Python files: no new findings (18 existed before)
- Install: `npm ci --ignore-scripts --onnxruntime-node-install-cuda=skip`, `uv sync --locked --all-extras` (eval)
