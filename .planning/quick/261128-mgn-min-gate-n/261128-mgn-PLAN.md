---
quick_id: 261128-mgn
slug: min-gate-n
status: planned
branch: exec/quick-min-gate-n
base: origin/ci/merge-train-39
files_modified:
  - eval/src/rag_eval/phase_compare.py
  - eval/src/rag_eval/phase42_gate.py
  - eval/src/rag_eval/phase44_gate.py
  - eval/src/rag_eval/phase33_gate.py
  - eval/config/phase4-comparison.json
  - eval/config/phase33-comparison.json
  - eval/config/phase33-gates.json
  - eval/config/phase42-gates.json
  - eval/config/phase44-comparison.json
  - eval/config/phase5-comparison.json
  - eval/config/phase51-comparison.json
  - eval/config/phase5.1.1-comparison.json
  - eval/config/phase52-comparison.json
  - eval/config/phase6-comparison.json
  - eval/tests/test_min_gate_n.py
  - eval/tests/test_phase_compare.py
  - eval/tests/test_phase42_gate.py
  - eval/tests/test_phase44_gate.py
  - .planning/phases/04.2-retrieval-tuning-additions/04.2-CONTEXT.md
  - .planning/phases/04.4-true-bm25-lexical-scoring/04.4-CONTEXT.md
  - .planning/phases/03.3-templated-collection-ingestion/03.3-CONTEXT.md
  - .planning/phases/05.2-grounded-answers-and-output-safety/05.2-CONTEXT.md
---

# Plan: min_gate_n for the phase gates' no-slice-drop check

Owner decision 2026-11-28 (about 00:25Z, orchestrator session): option (a) of proposal (c) in
`.planning/debug/phase42-scanned-slice-regression.md` (exec/debug-42-scanned, a5927a673).

1. RED: `eval/tests/test_min_gate_n.py`. A 4-item slice with one flipped item is reported as `below_min_n` and does not
   block; a 10-item slice with one flip still fails; specs register the rule; a spec without it defaults to 10.
2. Rule registration (D-37 pre-registration, one commit, pushed before any gate runs):
   `phase_compare.SliceGateRule` (`version: 2`, `min_gate_n` default 10) on every spec model that runs slice drops
   (`ComparisonSpec`, `SwitchComparisonSpec`, `Phase42GateSpec`, `Phase44GateSpec`, `Phase33GatesSpec`);
   `slice_drops` moves noise-band offenders on slices with n < `min_gate_n` into `skipped` as `below_min_n` notes;
   phase42/44 outcomes carry them in `below_min_n`, outside `passed`; `no_slice_drop_check` and `category_noise_check`
   list them in `detail`. The specs name the rule explicitly. The decision goes into the 03.3, 04.2, 04.4 and 05.2 CONTEXT
   files, applying to gate runs after the registration only. Existing band-arithmetic tests pin `min_gate_n=1`.
3. Re-run (separate commit): `rag_eval.phase42_gate` and `rag_eval.phase44_gate` on the full specs, results recorded as
   they come out. No threshold or noise band changes.
4. Gates: eval pytest (`--all-extras`), tsc, `npm run test-rag -- --fixture-mode ingest`, the gate tool tests.
