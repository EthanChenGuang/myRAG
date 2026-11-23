---
phase: 01-evaluation-harness-baseline
plan: 15
subsystem: testing
tags: [golden-set, fixtures, trilingual, split-manifest, pii-scan, vitest, pytest]

requires:
  - phase: 01-07
    provides: "zh and en fixture corpus documents including the near-duplicate product pair"
  - phase: 01-08
    provides: "it fixture corpus documents and the image-caption document"
  - phase: 01-13
    provides: "load_golden, write_golden, load_corpus and the Python corpus dump CLI"
  - phase: 01-10
    provides: "pinned eval env and the in-process runEval harness"
provides:
  - "eval/fixtures/golden.jsonl: 72 approved synthetic_fixture items, 24 per language, all seven categories"
  - "eval/fixtures/split-manifest.json: frozen dev/test assignment for all 72 ids"
  - "Integrity tests: coverage, verbatim quotes, PII scan (pytest) and TS/Python loader parity, non-degenerate full run, multi-tenant isolation (Vitest)"
affects: [01-16, 01-18, 01-19, 01-20, baseline recording]

plan_head_before: b87ec5cf8d75708a23bee6819fe0203f69fc0fe4
plan_head_after: 03d27854a2153c658995994060420a97a340217f

actuals:
  tokens: 14800
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Golden items are generated from a scratch script that locates each gold quote in exactly one chunk and fills the span section from that chunk, then written through freeze_splits and write_golden"
    - "PII scanner is unit-tested against positive and negative samples so a passing scan is not vacuous"

key-files:
  created:
    - eval/fixtures/split-manifest.json
    - eval/tests/test_fixture_coverage.py
    - eval/tests/test_fixture_quotes.py
    - eval/tests/test_fixture_pii.py
    - tests/eval-corpus.test.ts
  modified:
    - eval/fixtures/golden.jsonl
    - tests/eval-harness.test.ts

key-decisions:
  - "Per language: 6 general, 3 multi_turn, 3 compound, 3 exact_term, 3 table, 2 scanned, 4 no_answer; no_answer items 001 and 002 are near-miss (corpus vocabulary, absent fact), 003 and 004 are out-of-domain"
  - "Every gold quote matches exactly one chunk of its named document, so the span section is unambiguous; image-caption evidence uses the stored filename warehouse-floorplan.png"
  - "The near-duplicate pair for each language is the first two chunks of product-specs; the distinguishing numbers are computed as the digit tokens present in one chunk and absent from the other"
  - "en-general-001 keeps its question, answer and span; write_golden only added the default empty conversation field"

patterns-established:
  - "Fixture integrity tests resolve all paths through rag_eval.paths.REPO_ROOT and compare against the same normalize_text and chunk_matches_span the metrics use"

requirements-completed: [EVAL-04]

coverage:
  - id: D1
    description: "72-item trilingual golden set, 24 per language, every (language, category) cell at the planned count (all at least 2), approved and synthetic_fixture, no chunk ids"
    requirement: EVAL-04
    verification:
      - kind: unit
        ref: "eval/tests/test_fixture_coverage.py (9 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every gold quote occurs, after normalize_text, in a single chunk of its named document with matching section; each language quotes the number that distinguishes its near-duplicate pair"
    requirement: EVAL-03
    verification:
      - kind: unit
        ref: "eval/tests/test_fixture_quotes.py (6 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Frozen split manifest equals assign_split and every item's split; no relative-date phrases in questions"
    requirement: EVAL-04
    verification:
      - kind: unit
        ref: "eval/tests/test_fixture_coverage.py::test_splits_equal_manifest_and_rule, ::test_no_relative_date_phrase_in_questions_or_conversations"
        status: pass
    human_judgment: false
  - id: D4
    description: "Corpus and golden text carry only reserved 555-01xx phone numbers and example.com/org/net emails, no Chinese mobile or Italian phone patterns"
    requirement: EVAL-04
    verification:
      - kind: unit
        ref: "eval/tests/test_fixture_pii.py (4 tests including scanner positive and negative samples)"
        status: pass
    human_judgment: false
  - id: D5
    description: "TS loader and rag_eval.corpus produce identical documents, chunks, sections and stored contents; a 72-item single-tenant run has 72 traces and zero edge errors; multi-tenant tracer retrieves for the fixture user and not for another user"
    requirement: EVAL-04
    verification:
      - kind: integration
        ref: "tests/eval-corpus.test.ts (6 tests)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 15: Fixture Golden Set Summary

**72 hand-authored trilingual golden items with verbatim gold spans, a frozen split manifest, and integrity tests proving coverage, quote fidelity, PII safety, TS/Python loader parity and a non-degenerate measurement in both deployment modes**

## Performance

- **Duration:** about 25 min
- **Tasks:** 3
- **Files modified:** 7 (5 created, 2 modified)

## Accomplishments
- `eval/fixtures/golden.jsonl` holds 72 approved `synthetic_fixture` items (24 each for zh, en, it), covering general, multi_turn, compound, exact_term, table, scanned and no_answer in every language. Each answerable item has one or more spans quoted from a single chunk; compound items cite two chunks; multi-turn questions depend on history through a pronoun or ellipsis.
- `eval/fixtures/split-manifest.json` freezes all 72 ids under rule `sha256-first8hex-mod100-lt70-dev`.
- Non-degeneracy under today's retrieval (single-tenant, fixture embedder), measured ad hoc: answerable items with a gold-document chunk in kept ranks 1-10 were en 12/20, zh 13/20, it 15/20; no_answer items refused were 2/4 per language (the two out-of-domain items in each language, and none of the near-miss items). Neither all-pass nor all-fail, so the baseline plan (01-20) records something meaningful.
- Multi-tenant: the tracer item retrieves refund-policy.en.md for the fixture user and returns zero candidates for another user id.
- The Italian set includes a question with an accented word the scanned receipt drops (`è` against the receipt's `e`).

## Task Commits

1. **Task 1: English and Chinese golden items** - `fb17b71` (feat)
2. **Task 2: Italian golden items and frozen splits for all 72** - `b20aae1` (feat)
3. **Task 3: Fixture integrity tests** - `03d2785` (test)

`6016236` in the plan's commit range is an unrelated planning-doc commit by another actor (semantic-cache spec); the plan's own code commits are the three above, so the measured `commits: 4` includes it.

## Files Created/Modified
- `eval/fixtures/golden.jsonl` - 72 items sorted by id
- `eval/fixtures/split-manifest.json` - frozen dev/test assignment
- `eval/tests/test_fixture_coverage.py`, `test_fixture_quotes.py`, `test_fixture_pii.py` - 19 pytest tests
- `tests/eval-corpus.test.ts` - 6 Vitest tests
- `tests/eval-harness.test.ts` - scoped to a tracer-only golden copy

## Decisions Made
See `key-decisions` above. Corpus documents, harness, embedder, thresholds and production code were not touched, and no question was tuned after seeing results: the non-degeneracy assertions passed on the first run.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Existing harness tests assumed a one-item golden file**
- **Found during:** Task 3 (`npm test`)
- **Issue:** `tests/eval-harness.test.ts` asserted exactly one trace from `eval/fixtures/golden.jsonl`; with 72 items two tests failed.
- **Fix:** the test now writes a temp golden file holding only the `en-general-001` line and runs against that, keeping the tracer, concurrency and HTTP-parity assertions unchanged.
- **Files modified:** `tests/eval-harness.test.ts`
- **Commit:** `03d2785`

**2. [Plan text] Task 2 verify command used `m.assignments`**
- **Found during:** Task 2
- **Issue:** `load_manifest` returns a plain dict, so `m.assignments[...]` in the plan's automated command raises AttributeError.
- **Fix:** ran the same check with `m[...]`; the committed tests use the dict form. No code change.

**3. [Note] `en-general-001` gained a `conversation: []` field**
- `write_golden` serializes every GoldenItem field; the tracer item's content is otherwise unchanged (checked field by field).

TDD note: Task 3 is test-only over already-committed fixtures, so there is no RED phase; the tests passed on first run, and the scanner and loader tests include negative samples to rule out vacuous passes.

## Issues Encountered
Running `runEval` twice in one Vitest module context returns 401 for the second run (the route module caches the per-run secret). The multi-tenant test resets modules and re-imports before each run.

## Known Stubs
None.

## Threat Flags
None. T-01-19 is mitigated by `eval/tests/test_fixture_pii.py` over all corpus files, golden.jsonl and the manifest.

## Verification
- `uv run --directory eval pytest -q`: 72 passed
- `uv run --directory rag-sidecar pytest -q`: 131 passed
- `npm test`: 23 passed (4 files); `npx vitest run tests/eval-corpus.test.ts`: 6 passed
- `npm run test-rag`: 72 valid RagTrace lines and a valid RunManifest
- `git diff --quiet 325a2c9 -- src/app/api/chat/route.ts src/lib/enhanced-rag-retrieval.ts`: exit 0

## Next Phase Readiness
The golden set and split are frozen; plan 01-20 can record the baseline on them. Changing any item later requires re-recording the baseline (D-11).

## Self-Check: PASSED
