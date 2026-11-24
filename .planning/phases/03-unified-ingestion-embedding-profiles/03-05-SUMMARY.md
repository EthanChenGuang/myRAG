---
phase: 03-unified-ingestion-embedding-profiles
plan: 05
subsystem: infra
tags: [python, uv, docling, rapidocr, tiktoken, docker, supply-chain]

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: rag-sidecar image-boundary tests, eval uv project
provides:
  - Human-verified, exactly pinned ingest packages in rag-sidecar and eval, both uv locks regenerated
  - Optional extras chunking and docling in rag-sidecar, fixtures in eval
  - Dockerfile with a slim default runtime stage and a docling target with models baked at build time
  - Per-stage image-boundary tests including docling stage rules
affects: [03-06, 03-12, 03-13, nightly docling job, sidecar deploy]

actuals:
  tokens: 14000
  tasks: 3
  commits: 4
plan_head_before: 83b71f6
plan_head_after: a1173d2

tech-stack:
  added: [python-multipart 0.0.34, python-stdnum 2.2, docling 2.150.1 (extra), docling-core 2.107.1 (extra), tiktoken 0.14.0, huggingface_hub 1.33.0, pypdfium2 5.15.2 (extra), reportlab 5.1.0 (eval extra)]
  patterns: [multi-stage Dockerfile with named stages and a slim last stage as default target, models baked into /opt at build time, uv exclude-newer cooldown with per-package exemptions]

key-files:
  created: []
  modified:
    - rag-sidecar/pyproject.toml
    - rag-sidecar/uv.lock
    - rag-sidecar/Dockerfile
    - rag-sidecar/tests/test_image_boundary.py
    - eval/pyproject.toml
    - eval/uv.lock

key-decisions:
  - "huggingface_hub is pinned to 1.33.0 instead of 2.4.0 because docling-ibm-models requires huggingface_hub<2"
  - "transformers is constrained to 5.23.0 and uv exclude-newer is 2026-11-17 with per-package exemptions for pre-existing pins, so new transitive packages are at least a week old"
  - "Docker stages: docling first, runtime last; runtime stays the default target so the PR image build is unchanged"

patterns-established:
  - "Image boundary tests evaluate every named Dockerfile stage (user, healthcheck, CMD), not the file as a whole"
  - "Baked model directories live under /opt (HF_HOME, TIKTOKEN_CACHE_DIR, RAG_SIDECAR_DOCLING_ARTIFACTS), are world-readable and created before USER drops privileges"

requirements-completed: [DATA-05, DATA-09]

coverage:
  - id: D1
    description: "Ingest packages pinned exactly and both uv locks regenerated and syncable"
    requirement: "DATA-05"
    verification:
      - kind: integration
        ref: "uv sync --locked (rag-sidecar, chunking extra; eval --all-extras) and HybridChunker/stdnum/multipart/tiktoken/reportlab imports, run by the orchestrator in commit ddf1d06"
        status: pass
    human_judgment: false
  - id: D2
    description: "Dockerfile has a slim default last stage and a docling target that installs the extra locked and bakes models into fixed directories"
    requirement: "DATA-05"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_image_boundary.py"
        status: pass
    human_judgment: false
  - id: D3
    description: "The docling target builds and the baked models are complete (no Docker daemon was available)"
    requirement: "DATA-05"
    verification: []
    human_judgment: true
    rationale: "Image build and model download need a Docker daemon and network; only static checks ran here. The nightly docling job or the first production build proves it."

duration: 12min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 05: Ingest packages and docling image target Summary

**Human-verified Docling/RapidOCR/tiktoken/stdnum/multipart/reportlab pins with regenerated uv locks, plus a two-stage sidecar Dockerfile whose `docling` target bakes models into /opt while the default `runtime` stage stays slim**

## Performance

- **Duration:** 12 min (Task 3 and SUMMARY; Tasks 1 and 2 were done earlier by the orchestrator)
- **Completed:** 2026-11-24
- **Tasks:** 3 of 3
- **Files modified:** 6

## Accomplishments
- Packages pinned and locked (Task 2, commit ddf1d06): rag-sidecar base deps gain python-multipart and python-stdnum; extras `chunking` and `docling` use the CPU torch index; eval gains the `fixtures` extra with reportlab.
- Dockerfile restructured into `docling` (first) and `runtime` (last, default target). The docling stage runs `uv sync --locked --no-dev --extra docling`, runs `docling-tools models download -o $RAG_SIDECAR_DOCLING_ARTIFACTS`, warms `cl100k_base` into `TIKTOKEN_CACHE_DIR`, and sets `HF_HOME` to a baked directory; all before `USER 10001`. The runtime stage is byte-for-byte the previous image content.
- `test_image_boundary.py` now checks user, healthcheck and CMD per stage and adds four tests for the stage split and the baked directories.

## Task Commits

1. **Task 1: Verify the flagged Python packages** - resolved by user, 2026-11-24, at the orchestrator; see commit `ddf1d06`
2. **Task 2: Pin the packages and regenerate both locks** - `ddf1d06` (build), done by the orchestrator
3. **Task 3: Dockerfile with a slim default stage and a docling target** (TDD)
   - RED: `21faa4c` (test) - 7 tests failed on assertions against the single-stage Dockerfile
   - GREEN: `a1173d2` (build)

**Plan metadata:** the commit that adds this SUMMARY (docs: complete plan)

## Files Created/Modified
- `rag-sidecar/Dockerfile` - two named stages, docling target with baked models
- `rag-sidecar/tests/test_image_boundary.py` - per-stage helpers and docling-stage tests
- `rag-sidecar/pyproject.toml`, `rag-sidecar/uv.lock`, `eval/pyproject.toml`, `eval/uv.lock` - from Task 2

## Decisions Made
- The model download uses the default `docling-tools models download` set (layout, table, RapidOCR per the research OCR decision) rather than naming models, because the CLI could not be run here to confirm model names.
- The existing single-CMD / last-USER tests became per-stage because both stages carry their own user, healthcheck and CMD, as the plan specifies.

## Deviations from Plan

### Task 2 deviations (made by the orchestrator, recorded here)

**1. [Rule 3 - Blocking] huggingface_hub 1.33.0 instead of 2.4.0**
- docling-ibm-models requires huggingface_hub<2, so the planned 2.4.0 cannot resolve with the docling extra. Pinned 1.33.0.

**2. [Rule 3 - Blocking] transformers constrained to 5.23.0**
- Added to `constraint-dependencies` with rapidocr, onnxruntime and docling-slim so the lock is reproducible.

**3. [Rule 2 - Missing critical] `exclude-newer = 2026-11-17` with per-package exemptions**
- New transitive packages must be at least a week old; fastapi, pydantic, pydantic-core, annotated-doc and certifi (existing pins) are exempted.

**4. [Plan edit] docling 2.150.1 and docling-core 2.107.1 replace 2.152.0 and 2.108.0**
- The day-old releases were replaced by the older pins the user approved (commit 83b71f6).

Verification of Task 2 passed: locked syncs, HybridChunker/stdnum/multipart/tiktoken/reportlab imports, sidecar pytest 349.

### Task 3

**5. [Rule 1 - Bug in own test] Output-directory assertion too literal**
- The first GREEN run failed because the Dockerfile passes the directory as `"$RAG_SIDECAR_DOCLING_ARTIFACTS"`. The test now accepts the literal path or the variable form. Fixed before the GREEN commit.

---

**Total deviations:** 5 (4 from Task 2 by the orchestrator, 1 test fix)
**Impact on plan:** None on scope; version pins differ from the research table.

## Issues Encountered
- No Docker daemon: the image was not built, so `docling-tools models download` and the tiktoken warm-up are untested end to end. The default `docker build` of the slim stage is unchanged in content.
- `docling-tools` and the docling extra are not installed in the worktree (by design), so the CLI flags `-o` and the default model set were taken from the research notes, not run.

## Gate Results
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 119 files, 1534 tests passed
- `node --import tsx --test tests/*.test.mts`: 136 passed
- `node scripts/ci/check-rag-boundary.mjs`, `python3 scripts/ci/check-workflows.py`, `node scripts/check-config.mjs`: ok
- `cd rag-sidecar && uv run --frozen pytest -q`: 353 passed
- Acceptance greps: `AS docling` = 1, `TIKTOKEN_CACHE_DIR` = 2 in the Dockerfile; python-stdnum, docling[rapidocr] and reportlab pins = 1 each

## Known Stubs
None.

## Threat Flags
None. The docling target adds a build-time model download (T-03-13, mitigated: fixed directories, no runtime download path).

## User Setup Required
None. Operator action: build `docker build --target docling rag-sidecar` once in CI or at deploy to confirm the model download; the nightly docling job should use this target.

## Next Phase Readiness
- 03-12 can read `RAG_SIDECAR_DOCLING_ARTIFACTS` for its `/ready` check; the docling image sets it to `/opt/docling-models`.
- Open: confirm the first real `--target docling` build succeeds and the baked model set covers layout, table and RapidOCR.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*

## Self-Check: PASSED
