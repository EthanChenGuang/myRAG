---
phase: 01-evaluation-harness-baseline
plan: 06
subsystem: testing
tags: [uv, python, span-matching, golden-set, split, deepeval, ragas]

requires:
  - phase: 01-evaluation-harness-baseline
    provides: "01-03 GoldSpan, GoldenItem and GoldenSplitManifest contracts"
provides:
  - "eval/ uv project (rag-eval) with locked judge and draft extras kept out of rag-sidecar"
  - "rag_eval.paths: REPO_ROOT and resolve_cli_path for every rag_eval CLI"
  - "rag_eval.matching: normalize_text and chunk_matches_span (D-13)"
  - "rag_eval.split: SPLIT_RULE, assign_split, load_manifest, write_manifest, freeze_splits (D-14)"
affects: [01-13, 01-15, 01-19]

plan_head_before: 622121babcd1b9750ae7a8c2273383692cd7d514
plan_head_after: 2f5a1692a6d2cab08df0953aa1f4acb6d583d016

actuals:
  tokens: 2450
  tasks: 2
  commits: 4

tech-stack:
  added: ["deepeval 4.3.4 (judge extra)", "ragas 0.4.4 (judge and draft extras)", "anthropic 2.12.0 (draft extra)", "httpx 0.28.1 (draft extra)"]
  patterns:
    - "Eval project consumes sidecar contracts through an editable path dependency, never a copy"
    - "Manifest writes are sorted-key JSON through a temp file and os.replace"
    - "Shape-only skeleton for TDD RED so tests fail on assertions, not imports"

key-files:
  created:
    - eval/pyproject.toml
    - eval/uv.lock
    - eval/.gitignore
    - eval/src/rag_eval/__init__.py
    - eval/src/rag_eval/paths.py
    - eval/src/rag_eval/matching.py
    - eval/src/rag_eval/split.py
    - eval/tests/test_matching.py
    - eval/tests/test_split.py
  modified: []

key-decisions:
  - "freeze_splits overrides the split field of a NEW id with the rule-assigned split; it raises only when an id already in the manifest disagrees with the item's split"
  - "freeze_splits writes the manifest only when new ids were added, and a duplicate id in the input raises before anything is written"
  - "Added write_manifest as a public helper (beyond the plan's export list) so tests and later tools share one atomic writer"

patterns-established:
  - "All rag_eval CLIs pass path arguments through resolve_cli_path (REPO_ROOT derived from __file__)"

requirements-completed: [EVAL-03, EVAL-07]

coverage:
  - id: D1
    description: "Eval environment locks with judge and draft extras; the sidecar lockfile contains no deepeval"
    requirement: EVAL-07
    verification:
      - kind: other
        ref: "uv sync --directory eval --locked --all-extras (exit 0); grep -c 'name = \"deepeval\"' rag-sidecar/uv.lock == 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "Span matching normalizes width, case, whitespace and punctuation for zh, en and it and is document-scoped"
    requirement: EVAL-03
    verification:
      - kind: unit
        ref: "eval/tests/test_matching.py (10 passed)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Frozen dev/test split never reassigns an existing id; manifest is sorted, atomic and rule-pinned"
    requirement: EVAL-03
    verification:
      - kind: unit
        ref: "eval/tests/test_split.py (9 passed)"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 06: Eval Project, Span Matching and Frozen Split Summary

**Locked `rag-eval` uv project (judge and draft extras isolated from the sidecar) with one shared NFKC/casefold/punctuation-stripping span matcher and a sha256-based 70/30 dev/test split that never moves an existing id.**

## Performance

- **Duration:** ~12 min
- **Tasks:** 2 (both TDD)
- **Files created:** 9

## Accomplishments

- `eval/pyproject.toml` declares `rag-eval` (Python >=3.12,<3.13, pydantic >=2.14.4, `rag-sidecar` editable path source). `judge` extra pins deepeval 4.3.4 and ragas 0.4.4; `draft` extra pins anthropic 2.12.0, ragas 0.4.4 and httpx 0.28.1. `uv.lock` resolves 137 packages; `rag-sidecar/uv.lock` contains no deepeval (D-07).
- Package legitimacy (T-01-SC, D-24): each release was confirmed present on PyPI (HTTP 200 on `/pypi/<name>/<version>/json`) before locking:
  - deepeval 4.3.4: https://github.com/confident-ai/deepeval (docs https://deepeval.com)
  - ragas 0.4.4: https://github.com/vibrantlabsai/ragas (docs https://docs.ragas.io)
  - anthropic 2.12.0: https://github.com/anthropics/anthropic-sdk-python
  - httpx 0.28.1: https://github.com/encode/httpx
- `matching.normalize_text` / `chunk_matches_span`: full-width `１２` matches `12`, `Perché` matches `PERCHÉ`, Chinese full-width comma matches ASCII comma, other document names never match, a quote normalizing to empty raises ValueError.
- `split.assign_split` follows `int(sha256(id)[:8],16) % 100 < 70`; `freeze_splits` keeps existing manifest entries, adds new ids, raises on disagreement, rejects duplicate ids, and the manifest (validated by `GoldenSplitManifest`, which rejects any other rule name) is written with sorted keys via temp file plus `os.replace`, byte-identical across writes.
- `paths.resolve_cli_path` works from any cwd (verified running pytest via `uv run --directory` from `/tmp`).

## Task Commits

1. **Task 1 RED:** `4e36fa2` test(01-06): eval uv project, extras, failing span-matching tests
2. **Task 1 GREEN:** `fefb304` feat(01-06): span normalization and chunk-span matching
3. **Task 2 RED:** `272a60a` test(01-06): failing frozen-split tests with skeleton
4. **Task 2 GREEN:** `2f5a169` feat(01-06): frozen 70/30 split with atomic sorted manifest

## Files Created/Modified

See `key-files` above. `eval/.gitignore` (not in the plan's file list) ignores `.venv/`, `__pycache__/`, `.pytest_cache/`.

## Decisions Made

See `key-decisions` above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Wrote eval/pyproject.toml by hand instead of `uv init --package`**
- **Found during:** Task 1
- **Issue:** `eval/` already holds the TypeScript harness (`harness/`, `fixtures/`, `out/`); `uv init` would add scaffolding (README, `.python-version`, sample module) that the plan does not want.
- **Fix:** Wrote the same pyproject fields the plan specifies (uv_build backend matching rag-sidecar, `src/rag_eval` layout) and ran `uv lock`/`uv sync` normally.
- **Files modified:** eval/pyproject.toml
- **Commit:** 4e36fa2

**2. [Rule 2 - Missing critical] Added eval/.gitignore**
- **Issue:** `eval/.venv` was otherwise untracked noise (root `.gitignore` already covers `.venv/`, but the sidecar has its own file by convention).
- **Commit:** 4e36fa2

Otherwise: plan executed as written.

## Issues Encountered

None. No auth gates. Package install used only the exact pins named in the plan.

## Known Stubs

None. (The matching/split skeletons in the RED commits were replaced in the GREEN commits.)

## Threat Flags

None. T-01-38 mitigated (freeze never reassigns, raises on disagreement, manifest validated and written atomically, all tested). T-01-SC mitigated (PyPI release check, exact pins, committed lock, `--locked` sync verified, extras absent from sidecar lock).

## User Setup Required

None.

## Next Phase Readiness

Plans 01-13 (metrics), 01-15 (fixture golden set) and 01-19 (drafting) can import `rag_eval.matching`, `rag_eval.split` and `rag_eval.paths`. Install with `uv sync --directory eval --locked --all-extras`.

## Self-Check: PASSED

- Files exist: eval/pyproject.toml, eval/uv.lock, eval/src/rag_eval/{__init__,paths,matching,split}.py, eval/tests/test_{matching,split}.py
- Commits 4e36fa2, fefb304, 272a60a, 2f5a169 are ancestors of HEAD
- `uv run --directory eval pytest -q`: 19 passed
