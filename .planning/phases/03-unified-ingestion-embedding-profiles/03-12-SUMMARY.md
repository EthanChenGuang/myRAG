---
phase: 03-unified-ingestion-embedding-profiles
plan: 12
subsystem: infra
tags: [python, fastapi, process-pool, multipart, async-jobs, sidecar]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: ParseJobRequest, ParseJobState, ParseResult contracts (03-02); python-multipart pin and locked sidecar environment (03-05)
provides:
  - Async parse job API on the sidecar v1 router (submit, poll, delete, artifact fetch) behind the shared secret
  - JobRunner with a spawn process pool, bounded queue, TTL sweep and per-job artifact store
  - Converter protocol, StubConverter and default_converter() with a lazy Docling seam for plan 03-15
  - Parse limits in sidecar settings read from RAG_SIDECAR_* variables
  - /ready condition docling_artifacts_missing (pitfall P-6)
affects: [03-15, 03-27, sidecar deploy]

actuals:
  tokens: 14900
  tasks: 2
  commits: 4
plan_head_before: 1baf5c0b366d00753cf493e6c361021343cbd7a7
plan_head_after: c8ea79b1d8680f5cf18e3fd94e9a22c2e465ab5f

tech-stack:
  added: []
  patterns: [spawn ProcessPoolExecutor with a picklable converter built once per worker, filesystem running-marker for queued/running state, streaming multipart reader that enforces the size limit while reading, lazy adapter proxy so the parent process never imports Docling]

key-files:
  created:
    - rag-sidecar/src/rag_sidecar/parse/__init__.py
    - rag-sidecar/src/rag_sidecar/parse/jobs.py
    - rag-sidecar/src/rag_sidecar/parse/converter.py
    - rag-sidecar/src/rag_sidecar/parse/upload.py
    - rag-sidecar/tests/test_parse_jobs.py
  modified:
    - rag-sidecar/src/rag_sidecar/main.py
    - rag-sidecar/src/rag_sidecar/settings.py
    - rag-sidecar/tests/test_auth.py

key-decisions:
  - "error_class is the snake_case form of the exception class name (RuntimeError -> runtime_error) because the ParseJobState contract only allows ^[a-z][a-z0-9_]{0,63}$; a converter can set a specific class with ConversionError(error_class)"
  - "The upload is parsed with python-multipart's streaming parser instead of Starlette's form parsing, because Starlette spools the whole file to disk before a handler can enforce the limit"
  - "default_converter() returns a lazy proxy; Docling is imported inside the pool worker on first convert, so the 512 MB parent process never loads it"
  - "Default page cap is 300 pages (the plan named the setting but gave no default)"
  - "Contracts schema version is 2; /ready only checks the Docling models directory when the app resolved the default Docling converter, not when a converter was injected"

patterns-established:
  - "Capacity is parse_workers plus parse_queue counting reserved uploads, unfinished jobs and deleted-but-still-running jobs"
  - "Expired jobs keep a bounded tombstone (4096 ids) so a late poll reads expired instead of 404; DELETE leaves no tombstone"

requirements-completed: [DATA-05]

coverage:
  - id: D1
    description: "JobRunner runs conversions in a bounded spawn process pool with queued/running/succeeded/failed states, 429-style QueueFull, TTL expiry, delete and strict artifact rules"
    requirement: "DATA-05"
    verification:
      - kind: unit
        ref: "rag-sidecar/tests/test_parse_jobs.py#test_runner_* (20 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "POST/GET/DELETE /v1/parse/jobs and the artifact route are authenticated, fail closed, stream the upload with a size limit and return structured errors (422, 413, 429, 503 docling_unavailable)"
    requirement: "DATA-05"
    verification:
      - kind: integration
        ref: "rag-sidecar/tests/test_parse_jobs.py#test_post_* test_get_* test_routes_* test_upload_reader_*"
        status: pass
    human_judgment: false
  - id: D3
    description: "/health answers during a running job; /ready reports docling_artifacts_missing only when the default Docling converter is in use"
    requirement: "DATA-05"
    verification:
      - kind: integration
        ref: "rag-sidecar/tests/test_parse_jobs.py#test_health_answers_while_a_slow_job_runs, test_ready_*"
        status: pass
    human_judgment: false
  - id: D4
    description: "The real Docling converter plugged into the seam, with real models, behind these routes"
    requirement: "DATA-05"
    verification: []
    human_judgment: true
    rationale: "Plan 03-15 creates the adapter and the models are baked only in the docling image; here the seam was exercised with a stub converter and a fake adapter module."

duration: 38min
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 12: Sidecar async parse job API Summary

**Authenticated /v1/parse/jobs submit, poll, delete and artifact routes backed by a spawn process pool with a bounded queue, TTL store and a lazy Docling converter seam**

## Performance

- **Duration:** 38 min
- **Started:** 2026-11-24T00:52:00Z
- **Completed:** 2026-11-24T01:31:00Z
- **Tasks:** 2 (each as RED then GREEN)
- **Files modified:** 8 (5 created, 3 modified)

## Accomplishments
- JobRunner (`parse/jobs.py`): conversions run in `ProcessPoolExecutor(mp_context=spawn)` with the converter built once per worker, so `/health` and polling never wait on a conversion. Queued vs running is read from a marker file the worker writes, which avoids the pool's prefetch making a second job look "running".
- Limits: capacity is workers plus queue (a fourth submit with 1 worker and queue 2 raises QueueFull and the route answers 429 with Retry-After 30); jobs live in random-UUID directories (mode 0700) under a lazily created temp root; the TTL sweep runs on every call and a poll after the TTL reads `expired`; DELETE removes files at once; input files are deleted as soon as the worker finishes.
- Classified failures only: `page_cap` (settings cap, or the smaller request cap, also passed to the converter), `worker_crashed` (pool is rebuilt for the next submit), `artifact_missing`, `result_unreadable`, converter-supplied classes, otherwise the snake_case class name. No exception message reaches a state body.
- Artifact route: name must match `[a-z0-9_.-]{1,64}`, not start with a dot, be listed in the job's `result.artifacts`, exist as a regular non-symlink file; anything else is 404. Paths are built from the job UUID only.
- Upload route reads the multipart body as a stream (`parse/upload.py`): rejects declared sizes far above the limit before reading, reserves a queue slot before reading, stops consuming and returns 413 as soon as the file part passes the limit, and never names a file after the uploaded filename.
- With no Docling available every parse route answers 503 `docling_unavailable`; `/ready` answers 503 `docling_artifacts_missing` when the default Docling converter is in use and `RAG_SIDECAR_DOCLING_ARTIFACTS` is unset or not a directory.
- Settings: `RAG_SIDECAR_PARSE_WORKERS` (1), `_PARSE_QUEUE` (8), `_PARSE_TTL_SECONDS` (3600), `_MAX_UPLOAD_MB` (20), `_PAGE_CAP` (300), `_DOCLING_ARTIFACTS` (unset). An unparsable or out-of-range value falls back to the default.

## TDD Gate Compliance

Task-level `tdd="true"` (plan type is `auto`, so the plan-level gate sequence does not apply). RED evidence, from `pytest` runs before each GREEN:

- Task 1 RED `f02dca5`: 21 failed, 9 passed against a skeleton JobRunner (always queued, never raises QueueFull) and a settings loader that ignored the environment. Failures were assertion failures or `condition not met in time` waits; no import errors.
- Task 2 RED `270467c`: 29 failed against missing routes (404 bodies), a stub upload reader and schema version 1. These are assertion failures on status codes and bodies; a few surface as `KeyError` or `ValidationError` while reading the framework's 404 body, still caused by the missing feature, not by a missing module or symbol.
- GREEN `5df1a78` and `c8ea79b`: 30 and 88 tests pass (67 in test_parse_jobs.py), repeated three times without flakes. I did not run `gsd_run check tdd-red-evidence` (not a `type: tdd` plan).

## Task Commits

1. **Task 1 RED: runner, settings and converter tests** - `f02dca5` (test)
2. **Task 1 GREEN: job runner, limits settings, lazy converter seam** - `5df1a78` (feat)
3. **Task 2 RED: route and upload reader tests** - `270467c` (test)
4. **Task 2 GREEN: authenticated parse job routes and streaming upload** - `c8ea79b` (feat)

**Plan metadata:** the docs(03-12) commit that adds this SUMMARY.

## Files Created/Modified
- `rag-sidecar/src/rag_sidecar/parse/jobs.py` - JobRunner, JobSlot, QueueFull, worker entry point
- `rag-sidecar/src/rag_sidecar/parse/converter.py` - Converter protocol, ConversionError, PageCapExceeded, error_class_of, StubConverter, default_converter with lazy Docling proxy
- `rag-sidecar/src/rag_sidecar/parse/upload.py` - streaming multipart reader with limits
- `rag-sidecar/src/rag_sidecar/main.py` - four routes, `/ready` Docling condition, lifespan close, schema version 2, `create_app(settings, converter)`
- `rag-sidecar/src/rag_sidecar/settings.py` - parse limit fields and bounded environment loading
- `rag-sidecar/tests/test_parse_jobs.py` - 67 tests (runner, settings, converter seam, routes, upload reader)
- `rag-sidecar/tests/test_auth.py` - `/v1/info` expectation moves to schema version 2

## Decisions Made
See `key-decisions`. For plan 03-15: `docling_adapter.DoclingConverter` must have a no-argument constructor, be cheap to construct, and build `DocumentConverter` lazily inside `convert` (the proxy imports the adapter and builds one instance per worker process). Artifacts must be written into `out_dir` and listed by name in `ParseResult.artifacts`; raise `ConversionError("<class>")` for classified failures.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Streaming multipart reader instead of UploadFile**
- **Found during:** Task 2
- **Issue:** The plan said to use FastAPI `UploadFile` and enforce the size limit while reading. Starlette parses and spools the entire multipart body to disk before the handler runs, so the limit (threat T-03-35) would only be checked after the disk was already filled.
- **Fix:** Added `parse/upload.py`, which feeds `request.stream()` into python-multipart's `MultipartParser` (already locked by 03-05) and writes the file part straight to the job directory, aborting past the limit. Routes also reject a Content-Length far above the limit and check the queue before reading.
- **Files modified:** rag-sidecar/src/rag_sidecar/parse/upload.py (new, not in the plan's file list), rag-sidecar/src/rag_sidecar/main.py
- **Verification:** `test_upload_reader_stops_consuming_once_the_limit_is_passed`, `test_post_upload_over_the_limit_is_413_and_leaves_no_files`, `test_post_upload_at_exactly_the_limit_is_accepted`
- **Committed in:** `c8ea79b`

**2. [Rule 1 - Contract fit] error_class is snake_case, not the raw class name**
- **Found during:** Task 1
- **Issue:** The plan says error_class equals the exception class name, but the ParseJobState contract (03-02) only accepts `^[a-z][a-z0-9_]{0,63}$`, so `RuntimeError` would make the state body invalid.
- **Fix:** `error_class_of` converts to snake_case (`runtime_error`, `os_error`); a `ConversionError` can name its own class.
- **Files modified:** rag-sidecar/src/rag_sidecar/parse/converter.py
- **Verification:** `test_runner_failed_job_reports_snake_case_error_class_and_no_message_text`
- **Committed in:** `5df1a78`

**3. [Rule 2 - Missing critical functionality] Crashed worker and deleted-running-job handling**
- **Found during:** Task 1
- **Issue:** A worker killed by the OS (for example out of memory) breaks a ProcessPoolExecutor for good, and a DELETE of a running job would free queue capacity while its worker is still busy.
- **Fix:** A broken pool maps to `failed` with `worker_crashed` and is rebuilt on the next submit; deleted-but-running futures keep counting toward capacity until they finish.
- **Files modified:** rag-sidecar/src/rag_sidecar/parse/jobs.py
- **Verification:** `test_runner_crashed_worker_fails_the_job_and_the_pool_recovers`
- **Committed in:** `5df1a78`

---

**Total deviations:** 3 auto-fixed (2 missing critical, 1 contract fit)
**Impact on plan:** All three tighten the planned mitigations; no scope creep beyond one extra module.

## Issues Encountered
- The `StubConverter` test helper first failed to raise `PageCapExceeded` (no-argument constructor); fixed in the stub, not in production code.
- Other plan details left to my judgement: page cap default 300; Retry-After fixed at 30 s; the tombstone for expired ids holds at most 4096 ids.

## Known Limitations
- No per-job wall-clock kill: a hung conversion holds its worker until the converter's own timeout (Docling `document_timeout` in 03-15). `ProcessPoolExecutor` cannot kill one task.
- Finished jobs stay on disk until the TTL or a DELETE; the app (03-27) is expected to DELETE after it has stored the result and artifacts. The sweep runs on parse-route calls, not on a timer.
- Sidecar env vars (`RAG_SIDECAR_PARSE_*`, `_MAX_UPLOAD_MB`, `_PAGE_CAP`) are read by the Python service only, not by the Next.js app, so the five-place `.env.local` sync of AGENTS.md does not apply; `check-config` still passes (93 variables). `RAG_SIDECAR_DOCLING_ARTIFACTS` is already set by the 03-05 Dockerfile.

## Threat Flags
None beyond the plan's threat model; T-03-34 to T-03-37 are mitigated and tested (auth 401/503 on every route, size and queue limits, artifact name rules, UUID ids with no list route and error classes only).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- 03-15 can add `parse/docling_adapter.py` with `DoclingConverter`; `default_converter()` picks it up when the `docling` package and the adapter are both importable.
- 03-27 (app client) can rely on: 202 `{job_id}`; 429 + Retry-After and 503 `docling_unavailable` meaning "use the next parser"; `expired` status meaning resubmit once; 404 `job_not_found`.
- Gate results in the worktree: `tsc --noEmit` 0 errors; `vitest run` 1534 passed; `node --test tests/*.test.mts` 136 passed; `check-rag-boundary` ok; `check-workflows` OK; `check-config` ok; sidecar `pytest` 420 passed. I ran `uv sync --locked --extra chunking` only (no lock changes, no new packages).

## Self-Check: PASSED

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
