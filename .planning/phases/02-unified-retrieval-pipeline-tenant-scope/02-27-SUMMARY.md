---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 27
subsystem: evaluation
tags: [langfuse, review-queue, pydantic, pii-masking, golden-set, httpx]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: review-candidate export with masked query, answer, context and model on the root observation (02-23); private-path writer and golden contracts with production provenance (02-25, 02-26)
provides:
  - ReviewQueueItem Pydantic contract with JSON Schema, sample and generated Zod
  - LangfuseApi, a minimal public API client (observations with cursor paging, scores array with 202 and 207 handling) that plan 02-28 reuses
  - python -m rag_eval.review_queue pull and promote
  - eval/tests/fake_langfuse.py, the Python twin of tests/helpers/fake-langfuse.mts
affects: [02-28]

requirements-completed: [EVAL-15]

actuals:
  tokens: 12000
  tasks: 2
  commits: 4
plan_head_before: 5b95b68645a9da1f83f5d81b1e1d7b8ac2dce193
plan_head_after: e13a3f8bc642e383ec9b01c511e7c9487f750b68

tech-stack:
  added: []
  patterns:
    - "A new eval extra (online) reuses the already locked httpx pin; no new package"
    - "Python twin of the TypeScript PII mask (same patterns, same order, re.ASCII for JS parity)"
    - "CLI skip path imports the HTTP client lazily, so a run without keys never needs it"

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/contracts/review.py
    - rag-sidecar/schemas/ReviewQueueItem.schema.json
    - rag-sidecar/tests/test_review_contract.py
    - eval/src/rag_eval/langfuse_api.py
    - eval/src/rag_eval/review_queue.py
    - eval/tests/fake_langfuse.py
    - eval/tests/test_review_queue.py
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/src/rag_sidecar/export_schemas.py
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json
    - eval/pyproject.toml
    - eval/uv.lock

key-decisions:
  - "A promoted draft is a no_answer placeholder (answerable false, no gold evidence, review_status draft, provenance production), because GoldenItem forbids an answerable item without gold evidence; the reviewer must set category, answerable, expected_answer and gold_evidence before approving, and the CLI prints that reminder"
  - "Promoted ids are prod-<language>-<first 10 hex of sha256(trace id)>; promote is idempotent per id and skips a question that already exists in the output file"
  - "Only observations that carry content (input or output) become queue items; stage spans carry the review_candidate tag but no content, so they are counted as pulled and not written"
  - "Input, output and metadata values are read both as plain strings and as JSON-encoded strings (the OTLP attribute form)"
  - "Language is not part of the export, so promote uses the stored language when present, then --language, then a small CJK and Italian-marker detector (default en)"
  - "Exit codes: 0 ok or keys-missing skip, 2 bad input, 4 Langfuse API failure, 6 private-path refusal; path checks run before any network call"

patterns-established:
  - "Tests that need the private golden root build a throwaway git repo in tmp_path and monkeypatch writer.REPO_ROOT, PRIVATE_DIR and DEFAULT_MANIFEST"

coverage:
  - id: D1
    description: "ReviewQueueItem contract (strict, frozen, optional language) registered for schema export, sample and Zod generation"
    requirement: EVAL-15
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_review_contract.py (15 tests) and the full sidecar suite (178 passed)"
        status: pass
      - kind: integration
        ref: "npm run gen:schemas; npx vitest run tests/schema-parity.test.ts tests/contracts.test.ts (52 passed)"
        status: pass
  - id: D2
    description: "LangfuseApi observations (cursor paging across an empty page, documented query, Basic auth, no parseIoAsJson) and post_scores (array body, 202 and 207 without retry)"
    requirement: EVAL-15
    verification:
      - kind: unit
        ref: "eval/tests/test_review_queue.py -k api (written, byte-compiled, not run: sandbox refused the eval pytest command)"
        status: unknown
    human_judgment: true
    rationale: "The eval pytest suite could not be run in this sandbox; rerun uv run --directory eval pytest -q tests/test_review_queue.py"
  - id: D3
    description: "review_queue pull (private JSONL queue, re-masking, missing keys skip, private-path refusal) and promote (draft GoldenItem with provenance production)"
    requirement: EVAL-15
    verification:
      - kind: unit
        ref: "eval/tests/test_review_queue.py (26 tests, written and byte-compiled, not run)"
        status: unknown
    human_judgment: true
    rationale: "Same as D2; the implementation was reviewed by hand against each test but never executed"
  - id: D4
    description: "Pull and promote against a live Langfuse project with real keys"
    requirement: EVAL-15
    verification:
      - kind: manual_procedural
        ref: "needs a live Langfuse project and keys; not run in this environment"
        status: unknown
    human_judgment: true
    rationale: "External service behaviour (field names in the v2 observations response) is only verified against the fake"

duration: 10min
completed: 2026-11-23
---

# Phase 2 Plan 27: Review queue pull and promote Summary

Masked, tenant-tagged production traces can be pulled from Langfuse into a private JSONL review queue and promoted to draft golden items with provenance production, using a new minimal Langfuse API client that plan 02-28 shares.

## What was built

- **Task 1 (TDD).** `ReviewQueueItem` (trace_id, observation_id, captured_at, tenant_key, optional language, masked query, answer and context, model, tags; strict and frozen) in `contracts/review.py`, registered in `contracts/__init__.py`, `export_schemas.py` CONTRACTS and `samples.py`; `npm run gen:schemas` produced the schema, the sample and the Zod block. `eval/src/rag_eval/langfuse_api.py` holds `LangfuseApi` (`observations()` with `fromStartTime`, `toStartTime`, `fields=core,basic,io,metadata,trace_context`, `limit=1000` and the JSON tag filter, following `meta.cursor` until it is absent including across empty pages, and `post_scores()` that posts an array and reports 202 and 207 as `ScoresResult(status, accepted, rejected, errors)` with no retry). It never sends the `parseIoAsJson` parameter, raises `LangfuseApiError` with the HTTP status only, and never puts the keys into a message. `eval/pyproject.toml` gets an `online` extra (httpx 0.28.1, already pinned). `eval/tests/fake_langfuse.py` is a `127.0.0.1:0` thread server with the same endpoints, paging and 202/207 behaviour as the TypeScript fake, plus explicit page lists (for the empty middle page), a request log and a configurable observations status.
  - RED: `test(02-27)` c78e16d. Sidecar contract tests ran against a permissive stub model: 13 of 15 failed on assertions (for example `DID NOT RAISE` for an unknown key, a missing schema file), 2 passed. `gsd_run check tdd-red-evidence` on the JUnit report returned `RED_EVIDENCE_OK`. Semantic assessment: the target test executed and failed because the stub accepts extra keys, not because of an import or fixture fault. The eval-side API tests in the same commit ran against a stub client (empty iterator, zero result); that RED was **not executed** (see Deviations).
  - GREEN: 3e0b2f3. Sidecar suite 178 passed, schema parity and contract vitest files 52 passed.
- **Task 2 (TDD).** `eval/src/rag_eval/review_queue.py`: `pull`, `promote`, `main`, plus `mask_text` (Python twin of `src/lib/rag/trace/mask.ts`: e-mail, IBAN, CN resident ID, codice fiscale, Luhn-checked card, international and CN mobile phone, same order) and `detect_language`. `pull --from --to [--out-dir | --out]` validates the window and checks the output path through `assert_private_path` before any network call, skips with `::notice::langfuse keys not configured, skipping review queue` (exit 0) when either key is missing, reads `LANGFUSE_BASE_URL` (default `https://cloud.langfuse.com`), turns each content-bearing observation into a `ReviewQueueItem` (tenant from `userId`, masked again before writing), and writes `eval/golden/private/review-queue/<from>_<to>.jsonl` atomically, only after every page was read. `promote <trace id | observation id> [--queue] [--out] [--language]` finds the item in the queue, builds a `GoldenItem` (provenance production, review_status draft, split from the frozen manifest) and writes it with `write_golden` under `eval/golden/private/` (default `promoted.jsonl`).
  - RED: `test(02-27)` e879dba, 26 tests in `eval/tests/test_review_queue.py` against a stub CLI returning exit code 1. **Not executed.**
  - GREEN: e13a3f8. **Not executed**; `python3 -m py_compile` passes on all four eval files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The sandbox refused every command that names the eval directory, so the eval pytest suite was never run**
- **Found during:** Task 1, first eval command
- **Issue:** `uv run --directory eval pytest ...` was refused ("runs a string through eval ... can't be verified to stay inside the worktree"). I did not look for a way around the refusal (no wrapper script, no other interpreter path into the eval package), as instructed.
- **Fix:** wrote the eval code and tests carefully against the existing helpers, reviewed each test against the implementation by hand, and ran what the sandbox allows: `git` with eval paths, `python3 -m py_compile` on the four eval files, the full sidecar suite, `npm run gen:schemas` and the two contract vitest files.
- **Commands I could not run (exact):**
  1. `uv sync --directory eval --locked --all-extras`
  2. `uv run --directory eval pytest -q tests/test_review_queue.py -k "api or contract"`
  3. `uv run --directory eval pytest -q tests/test_review_queue.py` (acceptance: at least 8 passed, 0 failed; the file has 26 tests)
  4. `uv lock --directory eval` and `uv lock --check --directory eval` (see deviation 2)
  5. The RED runs of the eval tests against the stubs (so only the sidecar RED has machine-checked evidence)
  6. The plan's `test -z "$(git status --porcelain eval/golden/private)"`: its plain part, `git status --porcelain eval/golden/private`, ran and printed only a warning that `eval/golden/` does not exist in this worktree (nothing private was created); the `$(...)` form was refused as too complex
- **Files modified:** none beyond the plan
- **Commit:** n/a

**2. [Rule 3 - Blocking] `eval/uv.lock` was edited by hand**
- **Found during:** Task 1
- **Issue:** `uv lock --directory eval` could not be run (deviation 1).
- **Fix:** added the `online` extra to the `rag-eval` package block the way uv writes it: an `online = [{ name = "httpx" }]` optional-dependencies entry, a `requires-dist` row for `httpx` with marker `extra == 'online'` and specifier `==0.28.1`, and `provides-extras = ["judge", "draft", "online"]`. No package entry changed (httpx 0.28.1 is already locked, and `rag-sidecar` depends on it unconditionally). Unverified: run `uv lock --check --directory eval` (or `uv lock`) first thing; if uv rewrites anything, commit its output.
- **Files modified:** eval/uv.lock
- **Commit:** 3e0b2f3

**3. [Rule 2 - Missing critical] Added `rag-sidecar/tests/test_review_contract.py`**
- **Found during:** Task 1
- **Issue:** the plan puts the contract tests in `eval/tests/test_review_queue.py`, which I could not run, so the contract would have had no executed RED/GREEN evidence.
- **Fix:** the same contract assertions (strict keys, non-empty ids, language set, frozen, registry, sample, committed schema equals the model) also live in the sidecar test suite, which runs. Not in the plan's `files_modified`.
- **Files modified:** rag-sidecar/tests/test_review_contract.py
- **Commit:** c78e16d

**4. [Rule 3 - Blocking] Python fake endpoint instead of driving `tests/helpers/fake-langfuse.mts`**
- **Found during:** Task 1
- **Issue:** the dispatch note says every test must talk to the fake Langfuse at `tests/helpers/fake-langfuse.mts`, but the plan (`eval/tests/fake_langfuse.py` in `files_modified`) and 02-VALIDATION ("Python twin `eval/tests/fake_langfuse.py` — plan 02-27") call for a Python twin, and a pytest suite cannot import a TypeScript module.
- **Fix:** built the twin with the same paths, cursor semantics and 202/207 answers; every test talks only to it on `127.0.0.1`, never to the network. Tests also strip proxy variables and set `NO_PROXY` so loopback is never routed through an agent proxy.
- **Files modified:** eval/tests/fake_langfuse.py
- **Commit:** c78e16d

**Total deviations:** 4 (3 Rule 3, 1 Rule 2). **Impact:** the eval-side behaviour is implemented to the plan but unverified by execution; the contract, schema, sample and Zod parts are fully verified.

## TDD Gate Compliance

RED (`test(02-27)` c78e16d, e879dba) precedes GREEN (`feat(02-27)` 3e0b2f3, e13a3f8) for both tasks. Only the contract RED has machine-checked `RED_EVIDENCE_OK`; the eval RED runs could not be executed. No REFACTOR commit.

## Known Stubs

None in shipped code. The promoted draft is an intentional no_answer placeholder (key-decisions), not a stub that blocks the goal.

## Threat Flags

None beyond the plan's register. T-02-70: every output path (queue file, promoted file, split manifest, an explicit `--queue`) goes through `assert_private_path`, content is re-masked before writing, and nothing under `eval/golden/private/` is staged. T-02-71: keys are read from the environment only and never printed (error messages carry the HTTP status or exception class name only). T-02-SC: the lock change reuses the locked httpx pin (hand edit, see deviation 2).

## Notes for the orchestrator

- Requirement EVAL-15 is addressed by this plan (the export side was 02-23). Treat it as fully complete only after the eval pytest suite has been run.
- Plan 02-28 can import `LangfuseApi`, `LangfuseApiError` and `ScoresResult` from `rag_eval.langfuse_api` and `FakeLangfuse` from `eval/tests/fake_langfuse.py` (use `scores_status=207` and `reject_indexes` for the partial-failure path, `fake.score_requests()` to assert no second POST).
- The field names read from the v2 observations rows (`id`, `traceId`, `startTime`, `userId`, `tags`, `input`, `output`, `metadata`) follow the 02-23 notes and the Langfuse OpenAPI description; they are verified only against the fake.

## Self-Check: PASSED

- Files present: rag-sidecar/src/rag_sidecar/contracts/review.py, rag-sidecar/schemas/ReviewQueueItem.schema.json, rag-sidecar/tests/test_review_contract.py, eval/src/rag_eval/langfuse_api.py, eval/src/rag_eval/review_queue.py, eval/tests/fake_langfuse.py, eval/tests/test_review_queue.py
- Commits present: c78e16d, 3e0b2f3, e879dba, e13a3f8
- Acceptance greps: `class ReviewQueueItem` 1, `parseIoAsJson` in langfuse_api.py 0, `online` in eval/pyproject.toml 1, `assert_private_path` in review_queue.py present
- Not self-checked by execution: the eval pytest criteria (see deviation 1)
