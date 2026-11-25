---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 40
subsystem: eval
tags: [d-28, phase-comparison, noise-band, parent-child, compression, translation, iterative-scan, conformance]
requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-17 conformance suite, 04-18 selective-filter --report, 04-21 run configs, 04-24 translation seam, 04-27/04-31 parent-child, 04-28 voice budget, 04-35 chunking decision, 04-38 baselines, 04-39 fixture floor and calibration"
provides:
  - "eval/src/rag_eval/phase_compare.py: run_phase_comparison, PhaseComparison (python -m rag_eval.phase_compare --spec --out)"
  - "eval/config/phase4-comparison.json: the named runs and rule bindings"
  - "eval/reports/phase-04/comparison.{json,md}: the D-28 report (passed: false, rule b fails)"
  - "lexical_leg_hit_rate_at_10 now counts the per-variant lexical:<n> lists of v2 search"
affects: [04-42, 04-43, phase-4-verification, gap-closure]
tech-stack:
  added: []
  patterns:
    - "Slice checks reuse gate.evaluate_gate with a NoiseConfig copy widened to overall, language:* and category:* on Recall@5, Recall@10 and MRR"
    - "On/off pairs use profile_compare.baseline_from_report on the off run as the reference; no new statistics code"
key-files:
  created:
    - eval/src/rag_eval/phase_compare.py
    - eval/tests/test_phase_compare.py
    - eval/config/phase4-comparison.json
    - eval/reports/phase-04/comparison.json
    - eval/reports/phase-04/comparison.md
  modified:
    - eval/src/rag_eval/metrics.py
    - eval/tests/test_report_v2.py
key-decisions:
  - "Rule (b) is checked against both the committed (legacy) baseline, as the plan says, and v2-all-off, as research's D-28 row says; it passes only if both pass"
  - "Slice comparisons of v2 runs align request_options with the observed run, because a named run differs from its reference by design (rerank_model, chunking overrides); golden, corpus, embedder, tier and mode still have to match. Legacy parity uses the unmodified CI gate"
  - "Parent-child pair uses sweep candidate p128-512: the recorded contract_legal decision is legacy and no candidate passed its sweep gate; ranking is gate passed, fewest regressions, clause Recall@k, clause MRR, overall Recall@k, then report order (all three tie, so the first wins)"
  - "Compression must show strictly fewer context tokens (must_have truth), not merely no increase"
  - "Translation is judged on cross_lingual Recall@5 and @10, the overall lexical-leg hit rate and the cross_lingual-slice lexical hit rate, each at or above the local_bm25 off run"
  - "Iterative scan is judged on the synthetic database (off below k, relaxed and strict recall >= 0.9, exact recall 1.0 in both slices); the fixture selective_filter slice is reported only"
  - "XLG-03 not_comparable does not fail the report (deferred to 04-43); a comparable cell beyond the noise band would"
  - "The local_bm25 run fails the report if any trace refuses on basis rerank_threshold (F-3)"
requirements-completed: []
duration: ~45min (this continuation; the first executor's time before the restart is not known)
completed: 2026-11-25
status: complete
actuals:
  tokens: 25750
  tasks: 2
  commits: 6
plan_head_before: 2dcccafe4319e21f3cfbfdce4d19083e0db62b10
plan_head_after: 39d0b1f0a95fcd01049ad2cd7a1c62f5b146be8c
---

# Phase 4 Plan 40: D-28 phase comparison Summary

**The comparison tool ran all ten named runs, the synthetic selective-filter database and both vitest commands. The committed report says `passed: false`. Rules (a), (c) and (d) pass. Rule (b) fails: v2-recommended's correct refusal does not rise, and two category slices lose MRR beyond the noise band against v2-all-off. Per the plan, nothing was tuned. The failure is a gap for a gap-closure plan, so Phase 4 is not complete.**

## Verdicts (eval/reports/phase-04/comparison.md)

| Rule | Verdict | Key numbers |
|---|---|---|
| (a) legacy parity | PASS | prechunked and ingest: all paired differences zero, gate passed |
| (b) v2-recommended vs committed baseline | FAIL | correct refusal 0.333 vs 0.667; no Recall/MRR slice drop; false refusal 0.012 (upper 0.054) vs 0.395 |
| (b) v2-recommended vs v2-all-off | FAIL | correct refusal 0.333 vs 0.333 (tie); MRR drops: category:scanned 0.8125 vs threshold 0.8133 (ref 0.8333), category:typo 0.8333 vs threshold 0.98 (ref 1.0) |
| (c) parent-child (ingest, p128-512) | PASS | clause Recall@10 0.50 on vs 0.00 off; overall Recall@10 +0.030; no slice drop; context tokens 765 vs 613 |
| (c) compression | PASS | context tokens 694 vs 943 (-249); Recall and MRR unchanged on every slice |
| (c) translation with local_bm25 | PASS | cross_lingual Recall@5 0.824 vs 0.529, @10 0.882 vs 0.647; lexical hit@10 0.930 vs 0.884 (cross_lingual 0.882 vs 0.647) |
| (c) iterative scan | PASS | synthetic: off 1 and 4 rows (k 10); relaxed, strict and exact recall 1.0 in both slices; fixture selective_filter slice equal on and off (0.875), as F-6 predicts |
| (d) conformance suite | PASS | `npx vitest run tests/rag/backend-conformance` exit 0 |
| (d) voice budget | PASS | `npx vitest run tests/rag/v2/voice-budget.test.ts` exit 0 |
| local_bm25 refusal (F-3) | PASS | 0 rerank-threshold decisions; 11 similarity-floor refusals |
| XLG-03 | not_comparable | 0 comparable cross cells on the fixture; deferred to 04-43 |

Run table (dev, overall): legacy prechunked R@5 0.512 / MRR 0.517; v2-all-off 0.837 / 0.756 (matches 04-39's reference numbers); v2-recommended 0.860 / 0.767; translation-on 0.919 / 0.822.

The report states the noise band (max(3 x spread, 0.02)). It also says that fixture gains mostly reflect the lexical fixture embedder and dropping the legacy 0.65 post-filter (F-9), and that the shipped defaults stay off.

## Gap for gap closure (rule b)

1. **Correct refusal does not improve.** It is lower than the legacy baseline (0.333 vs 0.667) and ties v2-all-off. 04-39 already recorded the tie: on the fixture, the fake reranker's scores follow the fixture embedder, so the threshold cells refuse the same no-answer items the fitted floor refuses. The legacy baseline refuses more no-answer items because it also refuses 39.5% of answerable items.
2. **MRR drops beyond the noise band on two category slices against v2-all-off.**
   - category:typo: 1.0 to 0.833.
   - category:scanned: 0.8333 to 0.8125, which is 0.0008 below the threshold.
   - Both slices are small, and the CI gate does not check category slices. Against the legacy baseline, no slice drops.

Deciding whether the criterion should be read differently on the fixture (research D-28 row: "correct refusal improves at the target false-refusal point estimate"), or whether ranking or refusal needs work, is for the coordinator or a gap plan. This plan does not decide it.

## Task Commits

1. Old bug found while preparing the comparison: the lexical-leg hit rate ignored v2's per-variant `lexical:<n>` lists and read 0 on every v2 run.
   - `86b3b57b` RED, `9f33bf52` fix. Both were committed by the first executor.
2. Task 1:
   - `9982501c` RED: tests, the spec and a stub module. 18 tests failed on assertions; 3 failed with the stub's ComparisonError.
   - `4d770585` GREEN: 21 tests passed.
3. Task 1 fix (Rule 1): `fc7844ca`. The default runner read `golden.merged.jsonl`, which prechunked runs do not write. It now uses the golden path named in `run.json`. The new test fails on the previous code with HarnessError.
4. Task 2: `39d0b1f0`, the report as written.

## Deviations from Plan

1. **[Rule 1] Lexical-leg hit rate**: this is the pre-existing metrics bug above, fixed with a RED test first. Without the fix, the translation rule could not be measured.
2. **[Rule 1] Default runner golden lookup**: `fc7844ca`. This bug was in this plan's own new code and showed up on the first real run.
3. **The gate is not spawned per run.** Every run goes through `run-smoke.mts --no-gate`, and the tool calls `gate.evaluate_gate` in-process. A spawned gate exits with MISMATCH for any run that has `retrieval_overrides`, and v2-recommended has them (`rerank_model`). Legacy parity uses the unmodified gate, so its result is the same as `npm run test-rag`, which also passes.
4. **Rule (b) has two references**: the committed baseline and v2-all-off. See key-decisions.
5. **Spec file**: the first executor drafted `eval/config/phase4-comparison.json` but did not commit it. I reviewed it and committed it unchanged with the RED tests.
6. **Plan acceptance `jq -e '.passed == true'` exits 1.** This is the expected result of a failing rule, per the plan's own instruction ("record the failure, stop"). `grep -c "noise band"` returns 5 (EXPECT >= 1). `grep -c "def run_phase_comparison"` returns 1 and `grep -c "category:"` returns 2.

Migration number: none used.

## Gates

| Gate | Result |
|---|---|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 231 files, 3435 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166 pass |
| `node --import tsx --test tests/rag-db/selective-filter.test.mts` | 7 pass |
| check-rag-boundary and its node test | pass (38) |
| check-config, check-workflows | pass |
| eval pytest without test_parse_fixtures | 617 pass |
| test_phase_compare.py | 22 pass |
| `npm run test-rag` | prechunked and ingest: gate PASS, all paired differences zero |

- **test_parse_fixtures**: 3 failures, pre-existing. The recorded parse outputs under `eval/fixtures/parse/recorded/` are missing. 04-39 excluded this file too. Running it regenerated `eval/fixtures/parse/manifest.json` and four PDFs; I restored them with `git checkout -- <file>`, and nothing under `eval/fixtures/parse/` is committed.
- **rag-db suite**: 882 tests, 864 pass, 6 fail, 3 skipped. When rerun alone:
  - `selective-filter` passes (7/7). Under load in the full run it hit the 15 s build budget (15549 ms).
  - Three files also fail when run alone:
    - `ingest-identity-async`: 5 failures, assertion expected 0 actual 1.
    - `ingestion-dead-letter`: 1 failure, lease-expired dead letter, expected '1' actual '2'.
    - `ingestion-ledger-pg`: execSync error, subtests cancelled.
  - These are TypeScript ingest tests. This plan changed only eval Python, the spec and the reports, so they cannot be affected by it. They are reported as pre-existing and were not investigated.

## Deferred / observations
- With the lexical leg off, v2 traces record `stage_counts.search.lexical = 0`. The report then shows a lexical hit rate of 0.0 for v2-all-off instead of n/a. This is display only and no rule reads it. Fixing it is out of scope.
- XLG-03 goes to 04-43 (live calibration).
- `eval/reports/phase-04/harness/` holds the scratch run directories (gitignored by the existing `eval/reports/*/harness/` rule).

## Known Stubs
None.

## Threat Flags
None. The tool only reads thresholds, golden items and baselines. T-04-81 is mitigated: when rule (b) failed, nothing was tuned.

## Self-Check: PASSED
