---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 26
subsystem: testing
tags: [eval, golden-set, fixtures, baseline, paired-comparison]

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: parity proven on the unchanged 72-item golden set (plans 02-11, 02-21), provenance slices and gate population (02-25)
provides:
  - 18 approved synthetic fixture items in the colloquial, ambiguous and typo categories, two per category per language
  - frozen split assignments for the new ids only
  - fixture baseline re-recorded on the 90-item golden set
affects: [phase 03 evaluation comparisons, success criterion 7 category split]

actuals:
  tokens: 20000
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "New golden ids are appended through the frozen sha256 split rule; the manifest only gains keys"

key-files:
  created: []
  modified:
    - eval/fixtures/golden.jsonl
    - eval/fixtures/split-manifest.json
    - eval/tests/test_fixture_coverage.py
    - eval/baselines/fixture-baseline.json

key-decisions:
  - "Ambiguous items are short underspecified questions that still have a single defensible answer (express cut-off, pallet limit, trial period length, approval threshold, warranty extension window, request acknowledgement time); the plan's example 'refund window?' was not used because annual and monthly plans give it two answers"
  - "The split rule puts both Italian typo items in the test split, so it/typo does not appear in the dev-only by_language_category slice; the frozen rule is not bent to fill it"

requirements-completed: [EVAL-14]

duration: 25min
completed: 2026-11-23
status: complete
plan_head_before: 150729f878030b3cb59c6007a689a2845e2b2aea
plan_head_after: 5831389ddf3b624f9b31af12bf0b15a5ee0aab83
commits: 2

coverage:
  - id: D1
    description: "Eighteen approved synthetic golden items (colloquial, ambiguous, typo; zh, en, it) with verbatim gold quotes, no relative dates, no PII, frozen splits"
    requirement: "EVAL-14"
    verification:
      - kind: other
        ref: "npm run eval:baseline and npm run test-rag load the 90 items through GoldenItem validation (contracts.validate reports 90 valid lines)"
        status: pass
      - kind: other
        ref: "independent script mirroring the quote-match, split-rule and PII regex checks: 18 spans match only their named document and section, splits equal the sha256 rule, zero PII violations"
        status: pass
      - kind: unit
        ref: "eval/tests/test_fixture_coverage.py, test_fixture_quotes.py, test_fixture_pii.py, test_golden_io.py, test_split.py (pytest not run here, see Issues Encountered)"
        status: unknown
    human_judgment: false
  - id: D2
    description: "Baseline re-recorded on 90 items; the 72 pre-existing items are unchanged; smoke tier passes; new categories appear in the report slices"
    requirement: "EVAL-14"
    verification:
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/golden-v2 (exit 0, gate PASS) and jq checks on gate.json and report.json"
        status: pass
      - kind: other
        ref: "independent paired check: 252 metric cells over the 72 old items, 0 non-zero; baseline values of old items identical before and after the re-record"
        status: pass
      - kind: other
        ref: "uv run --directory eval python -m rag_eval.paired CLI (not run here, see Issues Encountered)"
        status: unknown
    human_judgment: false
---

# Phase 02 Plan 26: Colloquial, Ambiguous and Typo Fixture Items Summary

**The fixture golden set grows from 72 to 90 items with colloquial, ambiguous and typo questions in zh, en and it, and the baseline is re-recorded with the 72 old items provably unchanged.**

## Performance

- **Duration:** about 25 min
- **Completed:** 2026-11-23
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added 18 items, ids `<lang>-colloquial-00N`, `<lang>-ambiguous-00N`, `<lang>-typo-00N`, all `synthetic_fixture`, `approved`, answerable, one verbatim gold quote each from a single corpus document and section. Typo coverage includes dropped letters in English, a missing accent in Italian ("perche", "e valida"), wrong characters and pinyin in Chinese.
- Splits come from the frozen rule: 14 dev, 4 test (en 6 dev; zh 4 dev, 2 test; it 4 dev, 2 test). The manifest only gained keys; no earlier assignment changed. Totals: 70 dev, 20 test.
- `test_fixture_coverage.py` now expects 90 items, 30 per language, and colloquial 2, ambiguous 2, typo 2 per language; every other assertion is unchanged.
- Baseline re-recorded with `npm run eval:baseline` (3 runs, zero variance). It holds rows for all 90 items.
- Smoke tier against the new baseline: `gate: PASS`.
- Paired evidence on the 72 old items (independent script using the same per-item metric formulas as `rag_eval.paired`): 252 metric cells compared, 0 non-zero; the recorded baseline values of every old item are identical before and after the re-record.

New slice values in the re-recorded baseline (dev split, from the harness output):

| Category | recall@5 | MRR | false_refusal |
|----------|----------|-----|---------------|
| ambiguous | 0.500 | 0.500 | 0.333 |
| colloquial | 0.000 | 0.000 | 0.800 |
| typo | 0.333 | 0.333 | 0.667 |

Overall dev: recall@5 0.508, MRR 0.525, false_refusal 0.377 (n=61 answerable). Report keys present: `by_category` has typo, colloquial, ambiguous; `by_language_category` has en/ambiguous, en/colloquial, en/typo, it/ambiguous, it/colloquial, zh/ambiguous, zh/colloquial, zh/typo (it/typo items are both test split); `by_provenance_category` has synthetic_fixture/{ambiguous,colloquial,typo}. The low colloquial and typo numbers are the point of the new categories: they give the query-rewrite work later in the phase something to improve against.

## Task Commits

1. Task 1: fixture items, splits, coverage test - `dc18321`
2. Task 2: baseline re-record - `5831389`

## Deviations from Plan

None - plan executed exactly as written. Two tooling notes, not plan deviations:

- Items were appended by a scratch script that mirrors `freeze_splits` (sha256 first 8 hex mod 100 under 70 is dev) and writes the manifest with the same JSON layout, because the pytest and `rag_eval` commands could not be launched (see below). Existing lines of `golden.jsonl` were preserved byte for byte and the file stays sorted by id.
- The scratch script also checked each new quote against the corpus chunks with the repository's normalization (NFKC, casefold, whitespace and punctuation stripped) and required every match to sit in the named document and section only.

## Issues Encountered

The sandbox refused any command containing the bare word `eval` (it treats it as a shell eval), so these commands were not run here and need to be run by the orchestrator from the worktree or after merge:

```
uv run --directory eval pytest -q tests/test_fixture_coverage.py tests/test_fixture_quotes.py tests/test_fixture_pii.py tests/test_golden_io.py tests/test_split.py
uv run --directory rag-sidecar python -m rag_sidecar.contracts.validate --model GoldenItem --jsonl ../eval/fixtures/golden.jsonl
uv run --directory eval python -m rag_eval.paired --report ../eval/out/golden-v2/report.json --baseline ../eval/out/baseline-before-golden-v2.json --noise ../eval/config/noise.json --out ../eval/out/golden-v2/paired-vs-before.json
jq -e '.all_zero == true' eval/out/golden-v2/paired-vs-before.json
```

The last two need `eval/out/golden-v2/report.json` and `eval/out/baseline-before-golden-v2.json`, which sit in the gitignored `eval/out/` of the agent worktree; if the worktree is gone, regenerate them with `git show 150729f:eval/baselines/fixture-baseline.json > eval/out/baseline-before-golden-v2.json` and `npm run test-rag -- --out eval/out/golden-v2`. `npm run eval:baseline`, `npm run test-rag` (which runs `contracts.validate` on the golden file and reports 90 valid lines) and the node/jq acceptance checks did run and pass. The `paired-vs-before.json` artifact from the CLI was therefore not produced; the equivalent check ran as an independent script (see Accomplishments).

## Known Stubs

None.

## Threat Flags

None. Fixture content is synthetic; the only email in new items is a corpus address on `example.com`, and a local scan with the `test_fixture_pii.py` regexes found no violations.

## Next Phase Readiness

Ready for the next plan. Later plans that compare against `eval/baselines/fixture-baseline.json` now see 90 items and the three new categories.

## Self-Check: PASSED

- `eval/fixtures/golden.jsonl` has 90 lines, 6 each of typo, colloquial, ambiguous.
- Commits `dc18321` and `5831389` are ancestors of HEAD.
- Baseline items count 90; gate.json `passed` is true; `by_category` has the three new keys.
