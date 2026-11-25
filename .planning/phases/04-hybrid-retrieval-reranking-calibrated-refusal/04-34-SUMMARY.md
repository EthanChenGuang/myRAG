---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 34
subsystem: rag-admin
tags: [chunking-profiles, admin-routes, refusal-calibration, config-ui, startup, chk-04, chk-05, rnk-05]
status: complete
requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "S7 admin guard (checkAdmin, requireAdminOrDeny), 04-13 thresholds loader and gate, 04-17 verifyV2Startup, 04-32 runRechunkBatch, 04-33 profile-ops and validateChunkingProfile, 04-35 committed chunking sweep report and decisions index, 04-45 reranker model selection"
provides:
  - "GET/POST /api/rag/admin/chunking-profiles, POST /validate, GET /report"
  - "POST /api/rag/admin/chunking-profiles/{id}/build, /{id}/activate, POST /rollback"
  - "GET /api/rag/admin/refusal-calibration (read-only)"
  - "runChunkingBuildStep, RechunkInputError, RechunkDatabaseError exported from @/lib/rag"
  - "refusalCalibrationStatus / currentRefusalCalibrationStatus (src/lib/rag/refusal/status.ts)"
  - "getChunkingSweepReport / getChunkingDecisions (src/lib/rag/chunking/report.ts)"
  - "V2StartupVerdict.chunkingCoverage and one [RAG Chunking] warning per doc type missing documents"
affects: [04-40, 04-43, config-ui]
tech-stack:
  added: []
  patterns:
    - "Every admin route gates first with checkAdmin (actor needed) or requireAdminOrDeny (read-only); actor is always the guard result's userId"
    - "Bodies are strict zod/v3 objects, so an actor key or any extra key is a 400"
    - "Long builds run in resumable 45 s steps inside the 60 s function limit"
key-files:
  created:
    - src/app/api/rag/admin/chunking-profiles/route.ts
    - src/app/api/rag/admin/chunking-profiles/_responses.ts
    - src/app/api/rag/admin/chunking-profiles/validate/route.ts
    - src/app/api/rag/admin/chunking-profiles/report/route.ts
    - src/app/api/rag/admin/chunking-profiles/[id]/build/route.ts
    - src/app/api/rag/admin/chunking-profiles/[id]/activate/route.ts
    - src/app/api/rag/admin/chunking-profiles/rollback/route.ts
    - src/app/api/rag/admin/refusal-calibration/route.ts
    - src/lib/rag/chunking/report.ts
    - src/lib/rag/refusal/status.ts
    - src/lib/rag/ingest/rechunk/build-step.ts
    - tests/rag/chunking-profile-routes.test.ts
    - tests/rag/refusal/status.test.ts
  modified:
    - src/lib/rag/index.ts
    - src/lib/rag/v2/startup.ts
    - tests/rag/v2/startup.test.ts
decisions:
  - "Admin chunking and refusal routes use only the S7 guard (checkAdmin or requireAdminOrDeny); requireRagAdmin is never called directly, so the Config UI's signed admin_session cookie works"
  - "Build step: one runRechunkBatch call with deadlineMs 45000 through runChunkingBuildStep on the service-role ingest client; answers progress and gap counts by reason only, never a document id or tenant key; aborted request 499 build_aborted; unknown_profile 404; other request refusals 409 build_refused; object_store_unavailable and embedding_profile_unavailable 503"
  - "Activate and rollback map ChunkingActivationRefused to 409 (activation_refused / rollback_refused with the gate's reason), unknown_profile to 404, any other failure to 503 chunking_admin_unavailable with only a reason code logged"
  - "refusal_on_without_calibrated_cell checks the same-language pairing per configured tier model and language; a usable cell is calibrated, live, not stale and has a finite threshold. Cross-language pairs fall to the similarity floor and are not part of the warning (otherwise it would always fire)"
  - "Refusal status adds a fifth warning, thresholds_invalid, when the committed refusal-thresholds.json does not validate"
  - "The v2 startup coverage read is bounded at 3 s, runs in parallel with the pgvector version read, and is recorded in a separate verdict field (chunkingCoverage.state checked / coverage_unchecked / not_checked), never in reasons, so a failed coverage read never marks retrieval degraded"
metrics:
  duration: "about 35 min for this continuation (Tasks 2 GREEN and 3); Task 1 and Task 2 RED by the previous executor"
  completed: 2026-11-25
actuals:
  tokens: 22300
  tasks: 3
  commits: 7
plan_head_before: 2dcccafe4319e21f3cfbfdce4d19083e0db62b10
plan_head_after: 515072e9
---

# Phase 4 Plan 34: Chunking profile and refusal-calibration admin routes Summary

**Admins can list, validate, create, build in 45 s steps, activate and roll back chunking profiles, read the chunking sweep report, and see every refusal threshold cell with point estimates, 95% upper bounds and Config UI warnings. Every route is gated by the shared S7 admin guard. Under RAG_PIPELINE=v2, startup warns once per doc type whose active chunking profile is missing documents.**

## Tasks

| Task | Name | Commits |
|------|------|---------|
| 1 | List, create, validate and report routes | 7bbb1bc2 (RED), 2028a1c9 (GREEN), by the previous executor |
| 2 | Build, activate and rollback routes | 42ddbb1a (RED, previous executor), ae7f1613 (GREEN) |
| 3 | Refusal-calibration status, and the chunking coverage warning at v2 startup | 9625a043 (RED), ff8051f4 (GREEN), 515072e9 (lint fixes in the two test files) |

A container restart stopped the previous executor after 42ddbb1a. This run continued from Task 2 GREEN.

## What was built

- **Build** (`POST /{id}/build`): checkAdmin first. Then the id is checked against the profile slug pattern and the body against a strict `{doc_type?}`. One `runChunkingBuildStep` call runs with deadlineMs 45 000 and the request signal. The response is `{success, run_id, status, docsDone, docsTotal, gaps, gap_reasons, more}`, with gap counts by reason only. A second call continues the open run (runRechunkBatch resumes the open run of the profile).
- **Activate** (`POST /{id}/activate`): checkAdmin first. The actor is `admin.userId`, and an `actor` key in the body is a 400. The response is `{success, activated, previous, doc_type, changed}`. A gate refusal is 409 `{activation_refused, reason}`, `unknown_profile` is 404, and a database failure is 503 with only a code logged.
- **Rollback** (`POST /rollback {doc_type}`): doc_type is required and limited to the six Phase 3 ids. `no_previous` is 409 `rollback_refused`.
- **Refusal calibration** (`GET /api/rag/admin/refusal-calibration`): requireAdminOrDeny first. The response has the pipeline, the refusal switch, the reranker with its score semantics, the model per tier (chat, voice) and language, the tokenizer and rerank-text versions, and the labels `point estimate` and `95% upper bound`. Each cell carries status, source, threshold, staleness, and point estimates, upper bounds and counts for dev and holdout. The warnings are `refusal_on_without_calibrated_cell` (names the languages and the missing tier/model/language entries), `fixture_cells_only`, `stale_cells` (with keys), `relative_reranker` and `thresholds_invalid`. The route has no write method.
- **v2 startup**: one `getChunkingCoverage` read within a 3 s bound. Each active non-legacy profile with missing documents gets one `[RAG Chunking]` warning naming the doc type, the profile id and the count, with the hint `npm run rag:rechunk -- --profile <id>`. The verdict carries `chunkingCoverage: {state, missing}`. An error, a timeout or a missing service-role client records `coverage_unchecked` and never throws. Under legacy nothing runs.

## Behaviour changes

- New admin-only endpoints, listed above. Nothing changes for unauthenticated or non-admin callers: they get 401 or 403.
- Under `RAG_PIPELINE=v2`, boot makes one extra `rag_chunking_coverage` RPC, bounded at 3 s. Under legacy (the default) nothing changes.
- No env variable, migration, SQL function or package was added.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Build step helper exported from `@/lib/rag`**
- **Found during:** Task 2 GREEN
- **Issue:** The RED tests (and the RAG boundary rule) need the build route to import its step from `@/lib/rag`. `runRechunkBatch` needs an `RpcClient` and was not exported there.
- **Fix:** Added `src/lib/rag/ingest/rechunk/build-step.ts` (`runChunkingBuildStep(profileId, {docType, deadlineMs, signal})` on `getIngestDeps().db()`). It is exported from `src/lib/rag/index.ts` together with `RechunkInputError`, `RechunkDatabaseError` and `RechunkReport`. These files are not in the plan's files_modified.
- **Commit:** ae7f1613

**2. [Rule 2 - Correctness] Coverage bound added, kept out of `reasons`**
- **Found during:** Task 3
- **Issue:** The plan refers to "its existing 3 s bound", but `verifyV2Startup` had no bound. Putting coverage failures into `reasons` would also turn the verdict `degraded`, a signal the search stage reads.
- **Fix:** The coverage read has its own 3 s timeout (aborting the read's signal) and runs in parallel with the pgvector read. Its outcome goes into a new `chunkingCoverage` field. `chunkingCoverage` and `chunkingCoverageTimeoutMs` are injectable deps for tests.
- **Commit:** ff8051f4

**3. [Rule 2 - Correctness] Build route error mapping beyond the plan's list**
- An aborted request returns 499 `build_aborted` with no progress report, as the RED test requires. The environment refusals `object_store_unavailable` and `embedding_profile_unavailable` return 503 rather than 409, matching the rechunk CLI's operational/request split.
- **Commit:** ae7f1613

**4. Shared helpers in `src/app/api/rag/admin/chunking-profiles/_responses.ts`** (created in Task 1 by the previous executor; not in files_modified). The refusal-calibration route inlines its own no-store helper so it does not depend on the chunking route folder.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npx vitest run`: 233 files, 3510 passed, 1 skipped.
- Targeted: `tests/rag/chunking-profile-routes.test.ts` (52), `tests/rag/refusal` (status 18, gate, floor), `tests/rag/v2` and `tests/chat-strict.test.ts` (186 together), `tests/routes/async-params.test.ts` (14): all pass.
- `node --import tsx --test tests/*.test.mts`: 166 pass.
- `node --import tsx --test tests/rag-db/*.test.mts`: 864 pass, 6 fail. The failures are not caused by this plan:
  - `ingest-identity-async` (5) and `ingestion-dead-letter` (1) fail the same way on an archive of base 2dcccafe. They import no file this plan touched.
  - `ingestion-ledger-pg` (optional real PostgreSQL) is cancelled on base too.
  - `selective-filter` failed under load and passes alone (7/7).
- `node scripts/ci/check-rag-boundary.mjs`: ok, 1063 files. Its node test: 38 pass.
- `node scripts/check-config.mjs`: ok, 125 variables. `python3 scripts/ci/check-workflows.py`: OK.
- `npm run test-rag -- --out eval/out/04-34`: gate PASS. `npm run test-rag -- --fixture-mode ingest --out eval/out/04-34-ingest`: gate PASS.
- `npm run typecheck:new`: 44 diagnostics, all in `.mts` harness and rag-db test files this plan did not touch (pre-existing).
- ESLint on the changed files: 0 errors. One `no-unused-vars` warning remains on a function-type parameter name in `startup.ts`, the same pattern as the existing `pgvectorVersion` dep.
- Python and contracts were not touched, so the sidecar/eval pytest and `gen:schemas` gates do not apply.
- Acceptance greps: Task 1 3/3/≥1/1, Task 2 checkAdmin 2, 409 1, requireRagAdmin 0; Task 3 `refusal_on_without_calibrated_cell` 2, `requireAdminOrDeny` 2, `getChunkingCoverage` 2. `-t "v2 startup warns about documents missing from the active chunking profile"`: 1 passed.

## Threat Flags

None beyond the plan's threat model. Every route gates first (T-04-72/73). Bodies are strict, so no actor key gets through. Responses and logs carry codes and counts only (T-04-76). Builds are bounded at 45 s per step (T-04-75).

## Known Stubs

None.

## Deferred Items

- Config UI screens that call these routes are not part of this plan.
- Pre-existing rag-db failures (`ingest-identity-async`, `ingestion-dead-letter`) reproduce on base 2dcccafe and belong to their owning plans.

## Self-Check: PASSED
