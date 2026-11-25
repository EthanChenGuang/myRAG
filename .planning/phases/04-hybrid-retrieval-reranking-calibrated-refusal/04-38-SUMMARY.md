---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 38
subsystem: eval
tags: [golden-set, calibration-cells, no-answer, cross-language, clause, baseline]
requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-37 selective_filter items, doc types and parity-checked baselines"
provides:
  - "18 new no-answer near-miss items (6 per language) and 2 new cross_lingual answerable items in eval/fixtures/golden.jsonl"
  - "test_golden_phase4.py: calibration cell minimums per language, pairing and split"
  - "4 clause items on the contract fixture in golden-ingest.jsonl"
  - "both baselines re-recorded; every pre-existing per-item result identical"
affects: [04-30, 04-39, 04-40]
actuals:
  tokens: 70000
  tasks: 3
  commits: 6
plan_head_before: 045ae01e9143a12e637e25914c89b49eacca80fe
plan_head_after: dc6a17b47ff000b2842d791ac78f6261be253fb0
key-files:
  created: [eval/tests/test_golden_phase4.py]
  modified:
    - eval/fixtures/golden.jsonl
    - eval/fixtures/split-manifest.json
    - eval/fixtures/translation-table.json
    - eval/fixtures/ingest/golden-ingest.jsonl
    - eval/tests/test_fixture_coverage.py
    - eval/tests/test_ingest_golden.py
    - eval/baselines/fixture-baseline.json
    - eval/baselines/fixture-ingest-baseline.json
    - tests/fixtures/characterization/chat.json
    - tests/fixtures/characterization/embed.json
    - tests/fixtures/characterization/voice.json
    - tests/fixtures/characterization/voice-v2.json
key-decisions:
  - "New no-answer ids 005 to 010 per language are consecutive; their hash splits (en 5 dev 1 test, it 3 dev 3 test, zh 4 dev 2 test) were checked before content was assigned, so every cross cell gets exactly 3 dev and 1 test no-answer items (rule in the test docstring, no outcome data)"
  - "Cross cells for answerable items were short only for en (dev 4) and it (test 1); two cross_lingual items fill them (xl-en-it-05 dev, xl-it-en-05 test)"
  - "Ingest en and it clause items use category cross_lingual with evidence_language zh because GoldenItem forbids evidence_language outside that category"
requirements-completed: [RNK-05, XLG-03, CHK-03]
duration: 150min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 38: Calibration cell golden additions Summary

**Every refusal-calibration cell (language x same/cross x dev/test) now reaches its fixture minimum, the contract fixture has four whole-clause items, and both baselines are re-recorded with all pre-existing items scoring exactly as before.**

## Accomplishments
- Prechunked golden 126 to 146 items, ingest-mode 138 to 162. Baseline `.items` counts: 126 to 146 (start 126, +20) and 138 to 162.
- Cell table after the change (language, pairing: dev no-answer/answerable, test no-answer/answerable): en same 5/26, 1/4; en cross 3/5, 1/4; it same 3/19, 3/11; it cross 3/7, 1/2; zh same 4/24, 2/6; zh cross 3/5, 1/3. All meet 3/5 dev and 1/2 test. English answerable test items: 8.
- no_answer items: 12 to 30 (each language 10: 4 old, 2 same-language near-miss, 4 cross-language near-miss). `cross_language` lines: 12.
- Cross-language near-miss topics exist only in a document of another language (topic terms found in that language's corpus, question-language terms absent from the question language's corpus; checked by test).
- Clause items: ingest-clause-scope-zh, ingest-clause-general-rule-zh, ingest-clause-scope-en, ingest-clause-scope-it; every quote inside contract clause 5.
- Slice numbers (RAG_PIPELINE=legacy smoke, gate population): prechunked no_answer correct_refusal 0.667 (n=21), overall recall@5 0.512 (n=86); ingest no_answer correct_refusal 0.542 (n=24), overall recall@5 0.626 (n=99), general (clause-bearing) recall@5 0.833 (n=18). Both gates passed with paired.all_zero true.

## Task Commits
1. Task 1 RED `c7b5182f` (test), GREEN `4df35da8` (feat)
2. Task 2 RED `bcc58c50` (test), GREEN `ffacf809` (feat)
3. Task 3 baselines `95c6f5d2` (feat)
4. Characterization snapshots `dc6a17b4` (test)

## TDD
RED evidence: `uv run --frozen pytest -q tests/test_golden_phase4.py tests/test_fixture_coverage.py` failed with 17 assertion failures (short cross cells, missing ids, count pins) and no import errors; the ingest RED failed on `assert 0 >= 4` (no clause items). Semantic assessment: the failing tests are the target tests and fail on the planned assertions. The classifier command `gsd_run check tdd-red-evidence` was not run (plan type is execute, not tdd).

## Deviations from Plan

**1. [Rule 3 - Blocking] translation-table.json extended**
- Issue: tests/rag/v2/translation-seam.test.ts requires a fixture translation for every approved cross_lingual item; the two new items need entries.
- Fix: two entries appended (en to it, it to en). Not in the plan's file list.
- Commit: 4df35da8

**2. [Rule 3 - Blocking] Characterization snapshots updated**
- Issue: chat, embed, voice and voice-v2 characterization tests iterate the golden questions, so new items fail them by design.
- Fix: regenerated with UPDATE_CHARACTERIZATION=1; the diff is 1181 insertions and 0 deletions, so no existing entry changed.
- Commit: dc6a17b4

**3. [Scope] No translation entries for the cross-language no-answer items.** The translation-seam test rejects entries that are not cross_lingual questions, so the 12 cross near-miss items run without a fixture translation (same as production when the translator returns nothing). Revisit in 04-39 if the fixture translated path should exercise them.

**4. split-manifest.json** was rewritten by `write_manifest` (sorted keys); all 126 earlier assignments are unchanged, 20 added.

Migration number: none used.

## Issues Encountered
- `tests/test_parse_fixtures.py` (3 tests) fails and rewrites tracked `eval/fixtures/parse/manifest.json` and four PDFs when run; reproduced alone, independent of golden changes. I reverted those files each time (never committed). Pre-existing at base 045ae01.
- Under load average about 40: `tests/rag/injection-scan.test.ts` and `tests/rag/lexical-tokenize.test.ts` wall-clock "under one second" tests failed (1.4 s, 1.7 s); unrelated to this plan, flaky under load.
- Per the orchestrator note, the full vitest and rag-db suites were not re-run after the snapshot update, and the full rag-db run died without a summary (load). Run instead: characterization, translation-seam, injection-scan, lexical-tokenize tests; `tests/rag-db/ingest-mode`, `translation-seam-fixture`, `eval-v2-overlay` (33 pass). The full `node --test tests/*.test.mts` passed (163/163) and the first full vitest run had only the characterization and timing failures described above.

## Gates
- tsc (`npx next typegen && npx tsc --noEmit`): 0 errors. check-rag-boundary + node test, check-config, check-workflows: pass.
- eval pytest: 560 pass, 3 pre-existing parse-fixture failures (above).
- Per-item comparison (jq) identical in both modes; both smoke gates passed.

## Known Stubs
None.

## Threat Flags
None.

## Next Phase Readiness
Cells are fillable for 04-30 calibration and 04-39/04-40 comparisons; ingest clause items ready for 04-40.

## Self-Check: PASSED
