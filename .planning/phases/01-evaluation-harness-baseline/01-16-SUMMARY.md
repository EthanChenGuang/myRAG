---
phase: 01-evaluation-harness-baseline
plan: 16
subsystem: testing
tags: [python, pydantic, report, cli, markdown, eval, deterministic]

requires:
  - phase: 01-evaluation-harness-baseline
    provides: "01-13 score_items/aggregate, load_golden, load_traces, load_manifest; 01-05 EvalReport/RunManifest contracts; 01-06 resolve_cli_path"
provides:
  - "rag_eval.report: build_report, write_report (report.json with sorted keys and unrounded floats, report.md with 3-decimal tables)"
  - "python -m rag_eval.runner score --traces --golden --manifest --out CLI (exit 0 or 2)"
affects: [01-18, 01-19, 01-20, 01-22, baseline recording, smoke tier]

plan_head_before: 482ba1a0e9b784ca1906363bef0578e62e82a5ba
plan_head_after: bd6c5e8958a12e1e1b12db6d2556dfeee4af9e8a

actuals:
  tokens: 6200
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Reports are rendered from the validated EvalReport only; JSON keeps full float precision, rounding happens only in the Markdown renderer"
    - "CLI cross-checks golden ids against trace ids before scoring and reports every mismatch, naming the item, with exit 2"

key-files:
  created:
    - eval/tests/test_report_runner.py
  modified:
    - eval/src/rag_eval/report.py
    - eval/src/rag_eval/runner.py

key-decisions:
  - "The categories-are-report-only (D-20) statement is a fixed line in report.md, not a note in EvalReport.notes, so it appears on every report; notes carry only the Filter 1 Chinese empty-term quirk, and only when the golden set has zh items"
  - "embedder_version is the manifest's string version parsed as int, or None when it is not an integer or no embedder is recorded"
  - "Unreadable or invalid input files also exit 2 with the error on stderr, in addition to item/trace mismatches"
  - "A trace with item_id null is a mismatch (exit 2), because score_items would otherwise skip it silently"

patterns-established:
  - "Atomic report writes: temp file plus os.replace for report.json and report.md"

requirements-completed: [EVAL-07]

coverage:
  - id: D1
    description: "build_report validates as EvalReport with k_values [5, 10], copies manifest fields and slices overall, per-language, per-category and per language/category"
    requirement: EVAL-07
    verification:
      - kind: unit
        ref: "eval/tests/test_report_runner.py::test_build_report_validates_and_copies_manifest_fields, ::test_build_report_without_embedder_leaves_embedder_fields_empty"
        status: pass
    human_judgment: false
  - id: D2
    description: "report.json has sorted keys, unrounded floats and is byte-identical across two writes; report.md rounds to 3 decimals, shows n/a for null and n beside every rate"
    requirement: EVAL-07
    verification:
      - kind: unit
        ref: "eval/tests/test_report_runner.py::test_write_report_json_is_sorted_unrounded_and_valid, ::test_write_report_markdown_has_tables_rounding_and_na, ::test_write_report_is_byte_identical_across_two_writes"
        status: pass
      - kind: other
        ref: "ad hoc: two score runs over eval/out/smoke traces (72 items) produced byte-identical report.json and report.md"
        status: pass
    human_judgment: false
  - id: D3
    description: "report.md states categories are report-only and only overall and per-language slices gate; the Filter 1 Chinese empty-term quirk note appears only when zh items exist"
    requirement: EVAL-07
    verification:
      - kind: unit
        ref: "eval/tests/test_report_runner.py::test_write_report_markdown_has_tables_rounding_and_na, ::test_notes_carry_the_chinese_empty_term_quirk_only_with_zh_items"
        status: pass
    human_judgment: false
  - id: D4
    description: "score CLI writes both files and prints the overall line (exit 0); a golden item with no trace, a duplicated trace, an unknown item, a null item_id or unreadable input exits 2 naming the problem; --help lists score"
    requirement: EVAL-07
    verification:
      - kind: unit
        ref: "eval/tests/test_report_runner.py (6 CLI tests)"
        status: pass
      - kind: other
        ref: "uv run --directory eval python -m rag_eval.runner --help lists score"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 16: Eval Report Builder and Score CLI Summary

**`rag_eval.runner score` turns JSONL traces, the golden set and a run manifest into a validated, byte-stable `report.json` (unrounded, sorted keys) and a 3-decimal `report.md`, with no LLM and exit 2 on any item/trace mismatch**

## Performance

- **Duration:** about 10 min
- **Tasks:** 2 (RED commit covers both, then one GREEN commit each)
- **Files modified:** 3 (1 created, 2 modified from skeletons)

## Accomplishments
- `build_report(manifest, results, golden)` returns an `EvalReport` (k_values `[5, 10]`) with overall, by_language, by_category and by_language_category slices from `aggregate`, items, and the Filter 1 Chinese empty-term note when the golden set has zh items.
- `write_report(report, out_dir)` writes `report.json` (`model_dump(mode="json")`, sorted keys, 2-space indent, trailing newline) and `report.md` (overall, per-language, per-category and per language/category tables; `0.333 (n=3)` style cells, `n/a (n=0)` for null), both via temp file plus rename.
- `python -m rag_eval.runner score` resolves paths with `resolve_cli_path`, cross-checks golden ids against traces, scores, writes the report and prints one `overall:` line.
- Ran against the committed smoke output (`eval/out/smoke`, 72 items): `recall@5=0.608 recall@10=0.608 mrr=0.633 correct_refusal=0.500 false_refusal=0.300`; two runs were byte-identical. These are ad hoc numbers, not the recorded baseline (plan 01-20).
- Suites: `uv run --directory eval pytest -q` 85 passed (13 new), `rag-sidecar` pytest 131 passed, `npm test` 23 passed, `npm run test-rag` valid.

## Task Commits

1. **Tasks 1 and 2 RED: failing tests with shape-only skeletons** - `f17957a` (test)
2. **Task 1 GREEN: report builder and JSON/Markdown writer** - `aab32b2` (feat)
3. **Task 2 GREEN: score CLI with cross-checks** - `bd6c5e8` (feat)

## TDD Evidence

- **RED:** `f17957a`, 13 failures, all `NotImplementedError` from the skeletons (behavior failures, not import errors).
- **GREEN:** `aab32b2` and `bd6c5e8`; 85 passed in the eval suite. No refactor commit.

## Deviations from Plan

### Additions beyond the plan text (Rule 2)
- The CLI also exits 2 for a trace with a null `item_id` and for unreadable or invalid input files, and it lists every mismatch rather than only the first, so a partial trace file cannot silently score a subset.
- The test file has 13 tests (plan asked for at least 7).

**Total deviations:** 0 bugs, 2 hardening additions. **Impact:** none on scope.

## Issues Encountered
- `ruff format --check` would reformat the new files, as it would the pre-existing 01-13 files (the project has no ruff-format config); only `ruff check` findings were fixed (import order, implicit string concatenation).

## Known Stubs
None.

## Threat Flags
None. T-01-17 accepted as planned: inputs are read-only, outputs are written only under `--out`, mismatched item sets exit 2.

## User Setup Required
None.

## Next Phase Readiness
- Plans 01-18, 01-19 and 01-20 can call `python -m rag_eval.runner score` and read `report.json` as an `EvalReport`; the per-language and overall slices the gate needs are present with their n.

## Self-Check: PASSED

`eval/src/rag_eval/report.py`, `eval/src/rag_eval/runner.py` and `eval/tests/test_report_runner.py` exist; commits `f17957a`, `aab32b2` and `bd6c5e8` are ancestors of HEAD; `uv run --directory eval pytest -q` reports 85 passed.

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
