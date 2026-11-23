---
phase: 01-evaluation-harness-baseline
plan: 13
subsystem: testing
tags: [python, pydantic, metrics, recall, mrr, golden-set, corpus, jsonl]

requires:
  - phase: 01-evaluation-harness-baseline
    provides: "01-05 RagTrace, RunManifest, ItemResult, SliceMetrics contracts; 01-06 chunk_matches_span, resolve_cli_path; 01-02 eval/harness/corpus.mts"
provides:
  - "rag_eval.golden_io: load_golden, write_golden, golden_sha256"
  - "rag_eval.traces: load_traces, load_manifest"
  - "rag_eval.corpus: load_corpus, CorpusDocument, CorpusChunk and the `python -m rag_eval.corpus dump <dir>` CLI"
  - "rag_eval.metrics: score_items and aggregate (Recall@5, Recall@10, MRR, correct-refusal and false-refusal rates per item and per slice)"
affects: [01-15, 01-16, 01-18, 01-19, 01-20]

plan_head_before: d4500329cafa39372af3972bae356592f24fd671
plan_head_after: 144bcd297af6911c067fc1ae049ef317722657a7

actuals:
  tokens: 8400
  tasks: 2
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Line-numbered loaders: every JSONL line is validated with its Pydantic contract and failures name the line"
    - "Python corpus reader uses an explicit JavaScript whitespace set so trim and heading parsing match the TS loader exactly"
    - "Metrics stay at full float precision; None (never 0 or NaN) when a slice has n=0"

key-files:
  created:
    - eval/src/rag_eval/golden_io.py
    - eval/src/rag_eval/traces.py
    - eval/src/rag_eval/corpus.py
    - eval/src/rag_eval/metrics.py
    - eval/tests/test_golden_io.py
    - eval/tests/test_corpus.py
    - eval/tests/test_metrics.py
  modified: []

key-decisions:
  - "aggregate returns a dict keyed overall, by_language, by_category, by_language_category (the EvalReport field names) so plan 01-16 can splat it into EvalReport"
  - "aggregate accepts only k_values (5, 10) because SliceMetrics and ItemResult carry exactly recall_at_5/10 and spans_hit_at_5/10; anything else raises ValueError"
  - "A refused trace scores zero hits and first_hit_rank None even if kept chunks exist, so a refused answerable item has recall 0 and MRR 0"
  - "score_items raises ValueError for a golden item with no trace and for duplicate trace item_ids instead of skipping, so a missing trace cannot silently shrink n"
  - "first_hit_rank is the first matching kept position even beyond 10 (MRR uses it); only the at-5 and at-10 counts are capped"
  - "load_corpus returns list[CorpusDocument] and does not compute corpus_sha256 or chunk ids; the TS loader owns those"

patterns-established:
  - "Golden writes are sorted by id, sort_keys, ensure_ascii=False, temp file plus os.replace"

requirements-completed: []

coverage:
  - id: D1
    description: "Duplicate golden ids and invalid lines are rejected naming the line; write_golden is sorted by id with sorted keys and byte-stable across two writes"
    requirement: EVAL-03
    verification:
      - kind: unit
        ref: "eval/tests/test_golden_io.py (duplicate id, invalid line, malformed JSON, blank-line counting, byte-stable write, non-ASCII, sha256)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Traces and run manifest validate with RagTrace and RunManifest (extra fields rejected, failing line named)"
    requirement: EVAL-07
    verification:
      - kind: unit
        ref: "eval/tests/test_golden_io.py::test_load_traces_validates_each_line_and_names_the_failing_line, ::test_load_manifest_validates_with_run_manifest"
        status: pass
    human_judgment: false
  - id: D3
    description: "load_corpus splits fixture files like eval/harness/corpus.mts (meta header, exact chunk marker line, trim, section heading, stored format); dump CLI prints the JSON structure"
    requirement: EVAL-07
    verification:
      - kind: unit
        ref: "eval/tests/test_corpus.py (7 cases)"
        status: pass
      - kind: other
        ref: "ad hoc diff of the TS loader output and `python -m rag_eval.corpus dump eval/fixtures/corpus` over the 13 committed fixture documents: identical"
        status: pass
    human_judgment: false
  - id: D4
    description: "Recall@k is rank-inclusive at k and exclusive at k+1, scored over fewer-than-k chunks, each span counted once, independent of gold_evidence order"
    requirement: EVAL-07
    verification:
      - kind: unit
        ref: "eval/tests/test_metrics.py (rank 5/6/10/11 boundary, 2-span recall 0.5/1.0 MRR 0.2, span-order swap, repeated matches)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Correct-refusal and false-refusal rates are separate; n=0 slices report None; values are never rounded; zh, it and full-width digits match"
    requirement: EVAL-07
    verification:
      - kind: unit
        ref: "eval/tests/test_metrics.py (refusal matrix, None slices, 1/3 exactness, multilingual hits); grep -c 'round(' eval/src/rag_eval/metrics.py is 0"
        status: pass
    human_judgment: false

duration: 14min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 13: Deterministic Scoring Core Summary

**Golden/trace/manifest loaders with line-numbered errors, a Python fixture-corpus reader byte-identical to the TS loader, and unrounded Recall@5/10, MRR and separate refusal rates per item and per slice**

## Performance

- **Duration:** 14 min
- **Tasks:** 2 (each RED then GREEN)
- **Files modified:** 7 (all created)

## Accomplishments
- `load_golden` rejects duplicate ids and invalid lines with the line number; `write_golden` sorts by id with sorted keys and is byte-stable; `golden_sha256` hashes file bytes.
- `load_corpus` reproduces `eval/harness/corpus.mts` using JavaScript's whitespace set for trim and heading rules. Its dump over `eval/fixtures/corpus` matched the TS loader exactly on all 13 documents (checked ad hoc; the committed parity test is plan 01-15).
- `score_items` ranks by 1-based position in the trace's `kept` list; `aggregate` builds overall, by_language, by_category and by_language_category slices (`<language>/<category>` keys).
- Suites: `uv run --directory eval pytest -q` 53 passed (34 new: 10 golden_io, 7 corpus, 17 metrics; 19 pre-existing), `rag-sidecar` pytest 131 passed, `npm test` 10 passed, `npm run test-rag` valid.

## Task Commits

1. **Task 1 RED: loader and corpus tests with shape-only skeletons** - `b0df336` (test)
2. **Task 1 GREEN: golden, trace and corpus loaders** - `e72a119` (feat)
3. **Task 2 RED: metrics tests with a shape-only skeleton** - `ff69757` (test)
4. **Task 2 GREEN: retrieval and refusal metrics** - `144bcd2` (feat)

## TDD Evidence

- **RED:** both RED commits fail with `NotImplementedError` from skeleton functions (17 failures for Task 1, 17 for Task 2), so they fail on behavior, not on imports. One RED test expectation was wrong (first_hit_rank for a gold chunk at rank 11 is 11, not None); fixed in the GREEN commit after the implementation showed it.
- **GREEN:** full eval suite 53 passed. No refactor commit was needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] RED test asserted the wrong first_hit_rank beyond k=10**
- **Found during:** Task 2 GREEN
- **Issue:** The test expected `first_hit_rank is None` for a gold chunk at rank 11. The plan defines first_hit_rank as the first kept rank matching any span, so 11 is correct (MRR = 1/11) while the at-10 counts are 0.
- **Fix:** Test now asserts 11.
- **Files modified:** eval/tests/test_metrics.py
- **Commit:** `144bcd2`

### Additions beyond the plan text (Rule 2)
- `score_items` raises on a missing or duplicate trace per golden item, and `aggregate` rejects unsupported `k_values`, so mismatched inputs cannot silently change n or produce keys the report contract cannot hold.

**Total deviations:** 1 bug fix, 1 hardening addition. **Impact:** none on scope.

## Issues Encountered
- `commits: 6` in the frontmatter is the measured `rev-list` count since the plan start; it includes `400a23e` and `a6b4930` (docs commits by another actor on the same branch while this plan ran). This plan's own commits are the four above.
- `ruff check` reports one import-order finding in the pre-existing `eval/tests/test_split.py` (plan 01-06); out of scope, not changed.

## Known Stubs
None.

## Threat Flags
None. T-01-18 is mitigated: every trace, golden and manifest line is validated with the extra-forbidding contracts, and duplicate ids and invalid lines are rejected with their line number instead of being scored.

## User Setup Required
None.

## Open Verification
- EVAL-07 stays Pending in REQUIREMENTS.md: its runner-level delivery (score CLI and report) lands in plan 01-16, and the golden set in 01-15. EVAL-03 was already Complete.

## Next Phase Readiness
- Plan 01-15 can write the fixture golden set with `write_golden` and assert TS/Python corpus parity via `python -m rag_eval.corpus dump`. Plan 01-16 builds `EvalReport` from `score_items` + `aggregate` (`EvalReport(**aggregate(results), ...)`).

## Self-Check: PASSED

All seven created files exist, commits `b0df336`, `e72a119`, `ff69757` and `144bcd2` are ancestors of HEAD, `uv run --directory eval pytest -q` reports 53 passed, and `grep -c 'round(' eval/src/rag_eval/metrics.py` is 0.

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
