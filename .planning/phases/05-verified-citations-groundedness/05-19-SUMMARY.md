---
phase: 05-verified-citations-groundedness
plan: 19
subsystem: eval
tags: [groundedness, calibration, hhem, vectara, eval]

requires:
  - phase: 05-verified-citations-groundedness
    provides: GroundednessRequest, GroundednessResult, GroundednessThresholds and the default thresholds file (05-01); POST /v1/groundedness and the shared-secret contract (05-12)
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: rag_eval.calibrate package, __main__ dispatch and the refusal dev-fit / one-shot-holdout pattern (04-30)
provides:
  - eval/fixtures/groundedness/pairs.jsonl, 52 invented labelled pairs (en 24, zh-Hans 24, it 4) with dev and test splits
  - rag_eval.calibrate.groundedness, which fits per (scorer, language) cells, runs the holdout check, writes the guarded file and renders the report
  - "`python -m rag_eval.calibrate groundedness` subcommand next to `refusal`"
affects: [05-26]

actuals:
  tokens: 15000
  tasks: 2
  commits: 5
plan_head_before: c5ff069
plan_head_after: 551c3e1

tech-stack:
  added: []
  patterns:
    - "Calibration that only writes from a real run: a stub scorer (live=False) or fixture pairs (path under eval/fixtures, or the same sha256 as the fixture) refuse --write before anything is scored"
    - "Holdout gate: the fitted threshold must beat chance and be at least as good as the 0.5 default on the same test rows"

key-files:
  created:
    - eval/fixtures/groundedness/pairs.jsonl
    - eval/src/rag_eval/calibrate/groundedness.py
    - eval/tests/test_calibrate_groundedness.py
  modified:
    - eval/src/rag_eval/calibrate/__main__.py

key-decisions:
  - "The fit maximises balanced accuracy over midpoints between observed scores. Ties go to the candidate nearest 0.5, then to the lowest."
  - "Minimums: 8 per class on dev and 4 per class on test, matching the fixture minimums in the plan. Below them the cell keeps the default (insufficient_data or holdout_insufficient_data)."
  - "Holdout passes when holdout balanced accuracy > 0.5 and >= the default threshold's balanced accuracy on the same rows. The chance rule is needed because a fully inverted test split scores 0 at both thresholds and would otherwise pass."
  - "A cell that fails the holdout is written as the plain 0.5 default (source default, no fitted_at), even if it was calibrated before. The run's metrics go only to the result file under --out."
  - "Only en and zh-Hans produce cells. Any other language, Italian included, is counted under not_checked even if a scorer returned a score, and a note is added."
  - "The sidecar scorer reads RAG_SIDECAR_SECRET and RAG_SIDECAR_URL (the existing app and sidecar names), sends x-sidecar-secret and sends allow_vectara=true only with --allow-vectara. A non-200 response stops the run."
  - "--out inside the repo must be under eval/out. The default is eval/out/calibrate-groundedness."

requirements-completed: [GEN-05, GEN-06]

coverage:
  - id: D1
    description: "Labelled en/zh-Hans/it pairs fixture with dev/test splits and no PII"
    requirement: GEN-06
    verification:
      - kind: unit
        ref: "eval/tests/test_calibrate_groundedness.py#test_every_pair_line_has_the_labelled_shape, test_pair_counts_meet_the_calibration_minimums, test_pair_text_has_no_pii"
        status: pass
  - id: D2
    description: "calibrate groundedness fits on dev, checks once on test and calibrates only on a passing holdout"
    requirement: GEN-05
    verification:
      - kind: unit
        ref: "eval/tests/test_calibrate_groundedness.py#test_clean_stub_calibrates_the_en_cell, test_poisoned_holdout_keeps_the_default, test_holdout_worse_than_the_default_threshold_keeps_the_default"
        status: pass
  - id: D3
    description: "Fixture and stub runs never write thresholds; Italian is not_checked; sidecar mode uses the secret and keeps Vectara off by default"
    requirement: GEN-05
    verification:
      - kind: unit
        ref: "eval/tests/test_calibrate_groundedness.py#test_stub_or_fixture_runs_never_write_thresholds, test_cli_refuses_to_write_the_committed_file_from_fixture_or_stub, test_italian_items_are_not_checked_and_never_produce_a_cell, test_sidecar_scorer_posts_requests_with_the_secret_and_no_vectara"
        status: pass
---

# Phase 5 Plan 19: Groundedness calibration tool

This plan adds the groundedness calibration tool and the labelled pairs it runs on. The 0.5 vendor default can now be replaced per (scorer, language) cell, but only by a threshold that was fitted on dev and then passed a holdout check on test. It also adds 52 invented labelled pairs: en and zh-Hans with 16 dev and 8 test pairs each, half faithful and half unfaithful, plus 4 Italian items that must come out not_checked.

## Tasks and commits

| Task | Commits |
| --- | --- |
| 1. Labelled pairs fixture (D-24) | `99abce0` test (RED), `83844c5` feat |
| 2. calibrate groundedness subcommand (D-13) | `b27f600` test (RED, skeleton without calibration or guards), `551c3e1` feat |

## Behaviour

- `python -m rag_eval.calibrate groundedness [--pairs P] [--out D] [--scorer stub|sidecar] [--sidecar-url U] [--allow-vectara] [--write [PATH]]`. The defaults are the fixture pairs, the stub scorer and `eval/out/calibrate-groundedness`.
- The result JSON and the Markdown report go to `--out`. The report lists every cell's status, threshold, source, dev and holdout balanced accuracy, the default threshold's accuracy on the holdout, and the not_checked counts by language and reason.
- `--write` exits with code 2 before scoring when the scorer is the stub, or when the pairs are the fixture (by path or by sha256). It merges into the target file and leaves cells it did not touch, such as the Vectara cells after a local-only run, unchanged.
- The `refusal` subcommand is unchanged.
- No app, sidecar, contract or env change. There are no new switches or `.env.local` variables.

## Tests that failed before the fix

- Task 1: all three fixture tests failed on assertions because the file was missing.
- Task 2: against the skeleton, 9 of 24 tests failed on assertions. They covered the calibrated cell, the write guards for stub and fixture runs, the eval/out guard, the secret guard, sidecar-mode calibration and the valid written file. When run against the skeleton, the write-guard tests did overwrite `eval/config/groundedness-thresholds.json`, which is the mutation the plan guards against. It was restored with `git checkout` before the RED commit.

## Gate results

| Gate | Result |
| --- | --- |
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | pass, 0 errors |
| `npm run typecheck:new` | pass, 0 diagnostics |
| `npx vitest run` | pass: 248 files, 3907 tests, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | pass: 166/166 |
| `node --import tsx --test tests/rag-db/*.test.mts` | 980 pass, 12 fail, 4 skipped. All 12 failures are the known v2-two-tenant-matrix image-URL assertions, fixed on trunk in b79ed7b2. This plan touches no TS or SQL. |
| `check-rag-boundary` and its node test | pass |
| `node scripts/check-config.mjs` | pass |
| `check-workflows.py` | pass |
| rag-sidecar pytest | pass: 1121 passed, 10 skipped |
| eval pytest | 656 passed, 4 failed. All 4 are known: `test_ingest_golden` PRE_CLAUSE_SHA256 (fixed on trunk in b79ed7b2) and 3 `test_parse_fixtures` tests that regenerate eval/fixtures/parse in place. The fixtures were restored with `git checkout -- eval/fixtures/parse/`. |
| Targeted: test_calibrate_groundedness, test_calibrate_refusal, test_calibrate_holdout, test_fixture_pii | pass: 105 |
| `git diff --exit-code HEAD -- eval/config/groundedness-thresholds.json` after the runs | exit 0 |
| `gen:schemas` and `test-rag` | not run: no contract, retrieval, ingest or golden-set change |

## Deviations

- The PII check for the new fixture is in `test_calibrate_groundedness.py`, which reuses the scanners from `test_fixture_pii.py`. The file list in `test_fixture_pii.py` has exact count assertions and is outside this plan's files.
- No migration, so no number was taken.

## Operator actions and deferred work

- Plan 05-26 does the live calibration with HHEM-2.1-Open and Vectara: run `--scorer sidecar` on a real labelled pairs file, not the fixture, with `RAG_SIDECAR_SECRET` set, and add `--allow-vectara` for the Vectara cells. Then pass `--write`.
- The zh-Hans cell can only be calibrated through Vectara, because the local HHEM-2.1-Open model is English-only.
