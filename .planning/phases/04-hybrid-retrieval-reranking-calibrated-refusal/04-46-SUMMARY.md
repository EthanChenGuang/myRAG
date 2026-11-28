---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 46
subsystem: eval
tags: [d-28, gap-closure, phase-comparison, calibrated-refusal, matched-false-refusal, paired-bootstrap]
gap_closure: true
requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-40 phase comparison tool and report (rule b failed); 04-39 fixture floor and calibration; .planning/debug/04-40-rule-b.md diagnosis"
provides:
  - "Rule (b) refusal compared at matched false refusal: point estimates against v2-all-off, fit_threshold on v2-all-off dense scores at the baseline's false-refusal rate against the committed baseline"
  - "Category slices count as drops only with paired support (upper end below 0 or n_nonzero >= 2); other category moves are report-only"
  - "RecommendedResult.strict_improvement (improved/open) and gate_below_floor observations"
  - "eval/reports/phase-04/comparison.{json,md}: passed true"
affects: [04-42, 04-43, phase-4-verification]
tech-stack:
  added: []
  patterns:
    - "Matched operating point reuses calibrate.refusal.fit_threshold and _best_dense (image floor as in calibration); no new statistics code"
    - "Category significance reads GateResult.paired (paired.py bootstrap) already computed by evaluate_gate"
key-files:
  created:
    - .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-46-PLAN.md
  modified:
    - eval/src/rag_eval/phase_compare.py
    - eval/tests/test_phase_compare.py
    - eval/reports/phase-04/comparison.json
    - eval/reports/phase-04/comparison.md
    - .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-CONTEXT.md
    - .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-PLAN-INDEX.md
key-decisions:
  - "D-28(b) is read at the target false-refusal point (research D-28 row; coordinator decision 2026-11-25). Against v2-all-off: correct refusal not lower and false-refusal point estimate not higher. Against the committed baseline: a fit_threshold cut on v2-all-off dense scores at the baseline's false-refusal rate must reach the baseline's correct refusal; coverage of the baseline's refused set is recorded"
  - "The baseline's refused set is limited to the gated (dev) no-answer items, because baseline.items also holds test-split items that the v2 dense scores do not cover"
  - "Correct refusal 'strictly improves' is recorded as open for the live calibration (04-43), like XLG-03. The verdict becomes 'improved' only when both references show a strict gain at the matched point"
  - "The paired category rule applies to rule (b) only. Rule (c) switch comparisons keep the 04-40 behaviour (every category offender fails), because the decision was scoped to D-28(b) and rule (c) passes either way"
  - "A category offender with no paired statistic still counts as a drop (fails closed)"
  - "Rate comparisons use a 1e-9 tolerance: baseline means come from triplicated runs, so an equal rate can differ by one ulp"
requirements-completed: []
duration: ~25min
completed: 2026-11-25
status: complete
actuals:
  tokens: 11500
  tasks: 3
  commits: 5
plan_head_before: 036ca46e2d5d0d6eb50c59f78895c8a2b65558c7
plan_head_after: 775daab84d51b5a4c4b3de914ceb94eab50c72ea
---

# Phase 4 Plan 46: D-28(b) at matched false refusal (gap closure for 04-40) Summary

**Rule (b) now compares correct refusal at matched false refusal and judges category slices by paired support. The regenerated D-28 report passes (`jq -e '.passed == true'` exits 0). Legacy parity is still all-zero. Correct refusal "strictly improves" is recorded as open for 04-43, and the zh|same gate-below-floor observation is named.**

## Final rule results (eval/reports/phase-04/comparison.md)

| Rule | Verdict | Key numbers |
|---|---|---|
| (a) legacy parity | PASS | prechunked and ingest: all paired differences zero, no non-zero cells |
| (b) vs committed baseline | PASS | matched on v2-all-off dense scores at the baseline's FRR 0.3953: threshold 0.2808, FR 0.3837 (33/86), CR 0.6667 vs the baseline's 0.6667. The refused set contains all 14 legacy-refused dev no-answer items. No slice drop |
| (b) vs v2-all-off | PASS | CR 0.3333 vs 0.3333 (tie); FR 0.0116 (95% upper 0.0540) vs 0.0465. No overall or language drop |
| (b) report-only category moves | report | category:typo MRR 1.0 to 0.8333 (n=3, n_nonzero 1, CI [-0.5, 0]); category:scanned MRR 0.8333 to 0.8125 (n=4, n_nonzero 1, CI [-0.0625, 0]) |
| (b) strict improvement | open | no strict CR gain at the matched point on the fixture; decided by the live calibration (04-43) |
| (c) parent-child, compression, translation, iterative scan | PASS | unchanged from 04-40 |
| (d) conformance, voice budget | PASS | both vitest commands exit 0 |
| local_bm25 refusal (F-3) | PASS | 0 threshold decisions |
| XLG-03 | not_comparable | deferred to 04-43 |

Observation (report only): test-split no-answer item zh-no-answer-003 is answered by the rerank gate. The cell is `cohere|fake-quality-v1|zh|same`, threshold 0.0446, and the item's best dense score is 0.0595, below the similarity floor 0.1159. The gate supersedes the floor (D-30). It is the only gate answer below the floor in the run.

## Task Commits

1. Plan: `923a48f8` (04-46-PLAN.md, plan index wave 12, requirement and decision rows, gap-closure note).
2. Task 1:
   - `d85ceb09` RED. 11 new tests failed on assertions, after the new result models were stubbed with the old behaviour. The multi-item drop and interval-below-0 tests passed on the old code too, because the old rule failed every category drop; they guard against the new rule loosening too far.
   - `74e5d85b` GREEN: 33 of 33 pass.
3. Task 3: `bebd8ed9`, the D-28(b) reading in 04-CONTEXT.md.
4. Task 2: `775daab8`, the regenerated report.

The tests named in the brief are all in `eval/tests/test_phase_compare.py`:
- equal CR with lower FR passes;
- lower CR fails;
- equal CR with higher FR fails;
- at a matched FR, a v2 run refusing fewer no-answer items than legacy fails, with `covers_reference` false and the missing id listed (plus a passing counterpart);
- a single n=3 rank move from 1 to 2 is report-only;
- a multi-item (n_nonzero 2) category drop fails;
- a category drop with a paired upper end below 0 fails;
- an overall or language drop above 0.02 still fails.

Two existing tests changed meaning:
- `test_recommended_fails_when_correct_refusal_is_not_higher` became "equal CR and FR passes with the strict gain open".
- The end-to-end failing-rule test now makes v2-recommended refuse no no-answer item.

## Deviations from Plan

1. **CONTEXT section name.** 04-CONTEXT.md has no "Adjustments after research" heading. The matching section is "Post-research decisions", and the dated D-28(b) entry was added there.
2. **Debug file committed.** `.planning/debug/04-40-rule-b.md` was untracked in the worktree, and both the plan and CONTEXT cite it. It is committed with this SUMMARY so the reference stays valid.
3. **Plan index updated.** 04-46 sits in wave 12 next to 04-36, and the two plans share no file. It is also added to the D-28, RNK-05 and XLG-03 rows, and a "Gap closure" section was added.

No production code, refusal-thresholds.json, fixture-score-calibration.json, fake reranker, golden item or fixture was touched. Nothing under `eval/fixtures/parse/` changed.

## Gates

| Gate | Result |
|---|---|
| `uv run --all-extras --frozen pytest -q --ignore=tests/test_parse_fixtures.py` (eval) | 628 passed (617 + 11 new) |
| test_phase_compare.py | 33 passed |
| `python -m rag_eval.phase_compare --spec eval/config/phase4-comparison.json --out eval/reports/phase-04` | exit 0, PASS |
| `jq -e '.passed == true'` and `jq -e '.legacy_parity.runs \| all(.all_zero)'` | both true |
| conformance and voice-budget vitest (run by the tool) | exit 0 |
| check-rag-boundary, check-config, check-workflows | pass |

No TypeScript or rag-sidecar file changed, so per the brief the TypeScript suites and rag-sidecar pytest were not rerun. Migration number: none used.

## Deferred / observations
- **Run-to-run variance in the ingest-mode harness.** The regenerated report differs from 04-40's outside rule (b) in one value: parent-child-on's lexical hit@10 is 0.6566 instead of 0.6667.
  - One item, en-multi-turn-001, flipped `lexical_hit_at_10` from true to false.
  - The run config hash is identical, and every Recall, MRR and refusal value is unchanged.
  - No rule reads this value. It points to a tie or ordering instability in the ingest-mode lexical leg of the TypeScript harness, which this plan does not touch. It is left for a later look.
- **n=1 category slices.** With n=1, a one-item move gives a degenerate paired interval whose upper end is below 0, so the move counts as a drop. This follows the rule as decided. On the current fixture, no n=1 category moved.
- **Strict refusal gain and XLG-03** go to 04-43.

## Known Stubs
None.

## Threat Flags
None. T-04-81 is mitigated: the rule reading is a recorded decision tied to research's D-28 row. Overall and language bands are unchanged, the strict gain stays open, and no threshold, floor, golden item or fixture was tuned.

## Self-Check: PASSED
