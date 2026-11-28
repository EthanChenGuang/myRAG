---
quick_id: 261127-vhm
slug: phase-4-1-gate-hardening-g-03-g-11
type: quick
source: origin/verify/04.1 @ 94e4284d, 04.1-VERIFICATION.md (gaps G-03, G-04, G-05, G-06, G-07, G-09, G-11)
base: origin/ci/merge-train-39 @ c6f1b3f7
branch: exec/quick-41-gate-hardening
---

# Quick 261127-vhm: Phase 4.1 gate hardening

Only the code gaps listed by the owner; G-01, G-02, G-08, G-10, G-12 and the D-29 / revert question for G-05 are out of scope.
Every fix starts with a test that fails on the old code. Switch-off defaults must not change (legacy smoke `paired.all_zero` stays true).

## Task 1 — G-03 (first): regression incumbent follows the decision status
- files: eval/src/rag_eval/regression.py, eval/tests/test_regression.py, eval/tests/fixtures/regression/*.json
- action: `load_incumbent` applies the five DFLT values only when `status == "flip"` (as scripts/check-config.mjs); a not_flipped record yields the shipped values; a missing or unknown status is malformed input.
- verify: not_flipped fixture test fails on old code, passes after.

## Task 2 — G-04, G-05, G-07: gate and decision provenance
- files: eval/src/rag_eval/defaults_gate.py, eval/src/rag_eval/defaults_decision.py, their tests, the committed gate result and decision record
- action: gate JSON records `git_sha` and `evaluated_at`; decision records `git_sha`, `run_date`, optional `historical`; committed decision marked historical @12598da4; `derive` refuses when a gate result was taken on the criteria (unless `--before-run`); G1 checks carry `n` and `band`.
- verify: eval pytest.

## Task 3 — G-04 / G-09 CI, G-06 voice, G-11 hints
- files: .github/workflows/pr-smoke.yml, src/lib/rag/rerank/select.ts, tests/rag/rerank/auto-select.test.ts, scripts/config-ui/index.html, scripts/init-env.js, tests/ui/config-reranker-cohere-hint.test.ts
- action: report-only pr-smoke steps (check-current, v2-default, v2 negative control); voice out of AUTO_HOSTED_PROFILES unless it changes the switch-off default; one Cohere data-flow hint in the Config UI and init-env; web-design-guidelines on the touched Config UI file.
- verify: check-workflows, vitest, tsc, typecheck:new, check-config, test-rag default and legacy tiers.
