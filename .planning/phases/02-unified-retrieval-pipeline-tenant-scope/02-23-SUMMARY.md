---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 23
subsystem: observability
tags: [langfuse, review-queue, pii-masking, message-metadata, trace-linkage]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: Langfuse span replay, maskPII, isSampled per-purpose prefix, fake Langfuse endpoint (02-22); trace collector and chat/embed pipeline wiring (02-08, 02-12, 02-14)
provides:
  - ragTraceId in the assistant message metadata (stream, extended, DB shapes)
  - review-candidate export: independent LANGFUSE_REVIEW_SAMPLE_RATE sample, masked query/answer/context/model on the root observation, review_candidate tag on every span
  - collector setReviewContent / reviewContent, read when the export runs
  - chat and embed routes record the final answer before the export
affects: [02-27, 02-28]

requirements-completed: [OBS-01, EVAL-15]

actuals:
  tokens: 9000
  tasks: 2
  commits: 4
plan_head_before: 048caf069385e314f15ca5538c7280abd3f97efb
plan_head_after: c32820c4c8b45d638a980f67699b4dde32b60534

tech-stack:
  added: []
  patterns:
    - "finishTrace builds the CollectedTrace inside the scheduled export task, so content recorded after finishTrace returns is still exported"
    - "Trace linkage rides on toUIMessageStream messageMetadata for the start and finish parts"
    - "Only ragTraceId is persisted from message metadata into the DB message shape; reasoning, web search and multi-step metadata are not"

key-files:
  created:
    - tests/rag-langfuse-review.test.mts
  modified:
    - src/lib/rag/trace/collector.ts
    - src/lib/rag/trace/config.ts
    - src/lib/rag/trace/finish.ts
    - src/lib/rag/trace/langfuse.ts
    - src/app/api/chat/route.ts
    - src/app/api/embed/chat/route.ts
    - src/types/chat.ts
    - tests/chat-messages-roundtrip.test.ts
    - tests/rag/embed-route.test.ts
    - tests/helpers/chat-route-fakes.ts
    - tests/rag-langfuse-export.test.mts
    - .github/workflows/pr-smoke.yml

key-decisions:
  - "A review candidate replaces the LANGFUSE_CAPTURE_CONTENT chunk capture on the root: input is the masked query, output the masked answer, metadata carries the masked context (capped at 40k characters after masking) and the generator model id"
  - "Review candidacy needs the same usable Langfuse config as a sampled trace; with Langfuse disabled or keys missing a candidate only gets the single [RAG Trace] line"
  - "Embed finishes its trace in the streamText onFinish, with onAbort and onError as safety nets, instead of right after retrieval"

patterns-established:
  - "Sampling prefix 'review' for the review sample, independent of the 'trace' sample"

coverage:
  - id: D1
    description: "Review-candidate request that is not trace-sampled is exported with masked query, answer, context and model, review_candidate and tenant tag and user id on every span"
    requirement: EVAL-15
    verification:
      - kind: integration
        ref: "tests/rag-langfuse-review.test.mts (fake Langfuse endpoint)"
        status: pass
  - id: D2
    description: "Content set after finishTrace scheduled the export is included; with review rate 0 and capture off no content or review tag is exported even if the collector holds content"
    requirement: EVAL-15
    verification:
      - kind: integration
        ref: "tests/rag-langfuse-review.test.mts"
        status: pass
  - id: D3
    description: "Neither sampled: no request and one [RAG Trace] line; candidate with Langfuse disabled sends nothing; LANGFUSE_REVIEW_SAMPLE_RATE defaults to 0 and is clamped"
    requirement: EVAL-15
    verification:
      - kind: integration
        ref: "tests/rag-langfuse-review.test.mts (7 tests in total)"
        status: pass
  - id: D4
    description: "Chat assistant message metadata carries ragTraceId (32 hex, equal to the collector trace id) and it survives fromUIMessage, toDBMessages (after a JSON round trip), toExtendedMessage and toMessage"
    requirement: OBS-01
    verification:
      - kind: unit
        ref: "tests/chat-messages-roundtrip.test.ts"
        status: pass
  - id: D5
    description: "Chat and embed record query, final answer, context and model on the trace before finishTrace runs; embed finishes the trace only after the model stream ends"
    requirement: EVAL-15
    verification:
      - kind: unit
        ref: "tests/chat-messages-roundtrip.test.ts, tests/rag/embed-route.test.ts"
        status: pass
  - id: D6
    description: "Live Langfuse project shows review-candidate observations filterable by the review_candidate tag"
    requirement: EVAL-15
    verification:
      - kind: manual
        ref: "needs a live Langfuse project and keys; not run in this environment"
        status: not-run

duration: 25min
completed: 2026-11-23
---

# Phase 2 Plan 23: Trace linkage and review-candidate export Summary

Chat assistant messages carry the request's trace id, and a separately sampled share of chat and embed requests exports PII-masked query, answer and context to Langfuse tagged `review_candidate`.

## What was built

- **Task 1 (TDD).** `LangfuseConfig.reviewSampleRate` (default 0, clamped) and `collector.setReviewContent` / `reviewContent` (merging, partial updates allowed). `finishTrace` exports when the request is trace-sampled or a review candidate (`isSampled(traceId, reviewSampleRate, 'review')`) and now builds the trace inside the scheduled task. `exportTrace` writes the masked query as root input, the masked answer as root output, and the masked context and model id in root metadata; the `review_candidate` tag is appended to the trace tags that are copied to every span. Non-candidates keep the 02-22 behaviour (chunk capture only with `LANGFUSE_CAPTURE_CONTENT=true`).
  - RED: `test(02-23)` commit 63551c5 with stubs; 3 of 7 tests failed on assertions (`0 !== 1` completed trace requests). `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK`. Semantic assessment: the target test executed, reached the export wait and failed because the exporter ignored the review sample, not because of a load or syntax fault.
  - GREEN: d01e0c6, 15/15 across the review and export node:test files.
- **Task 2.** The chat route passes `messageMetadata` to `toUIMessageStream` (`ragTraceId` on the start and finish parts) when a trace exists, records the query right after retrieval, and in the `streamText` `onFinish` records answer, context and model before the UI stream finish calls `finishTrace`; the strict no-context stub answer is recorded too. The DB message shape gained `metadata: { ragTraceId }` (only that key) restored by `toExtendedMessage`. The embed route records query/context/model after retrieval, the answer in `onFinish`, and finishes the trace there (with `onAbort`, `onError` and the early-return paths as safety nets).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `.github/workflows/pr-smoke.yml` lists the two Langfuse node:test files**
- **Found during:** Task 1
- **Issue:** orchestrator instruction: add `tests/rag-langfuse-export.test.mts` and the new review test to the node:test list because the workflow lists `.mts` tests.
- **Fix:** appended both paths to the existing `tsx tests` step; `check-workflows.py` still passes.
- **Commit:** d01e0c6

**2. [Rule 2 - Missing critical] `src/types/chat.ts` carries `ragTraceId` through the DB shape**
- **Found during:** Task 2
- **Issue:** `toDBMessages` / `toExtendedMessage` dropped message metadata, so the trace id would not survive persistence (must-have: survives UI/API/DB conversions). The file was not in `files_modified`.
- **Fix:** optional `DBMessage.metadata` limited to `ragTraceId`; no other metadata is persisted, so stored chat JSON only grows by one key on traced assistant messages.
- **Commit:** 483b5a9

**3. [Rule 3 - Blocking] The plan's `messageMetadata` callback with `metadata` keys does not exist in the route**
- **Found during:** Task 2
- **Issue:** the route builds `metadata` (multi-step, reasoning, web search, document sources) in the `createUIMessageStream` `onFinish`, whose return value the SDK ignores, so those keys never reach the client today.
- **Fix:** added a real `messageMetadata` option on the merged `toUIMessageStream` carrying only `ragTraceId`. The existing dead block was left untouched to keep behaviour unchanged.
- **Commit:** 483b5a9

**4. [Rule 3 - Blocking] Test fakes touched**
- `tests/helpers/chat-route-fakes.ts`: the fake `toUIMessageStream` now honours `messageMetadata` like the SDK. `tests/rag-langfuse-export.test.mts`: `configFor` gets `reviewSampleRate: 0` for the new required config field. `tests/rag/embed-route.test.ts`: new test; the finish spy mocks `@/lib/rag/trace/finish` (mocking the `@/lib/rag` barrel duplicates the deps module and breaks `setRagDepsForTests`).

## Deferred Issues

- The `metadata` object built in the chat `createUIMessageStream` `onFinish` (multi-step, reasoning, web search, document sources) is never delivered to the client with AI SDK 6; pre-existing and out of scope.

## Known Stubs

None.

## Threat Flags

None. `ragTraceId` is an opaque random id (T-02-65, accepted); review content is masked before export and again in the processor mask, the review sample defaults to 0 (T-02-64).

## Verification

- `node --import tsx --test tests/rag-langfuse-review.test.mts tests/rag-langfuse-export.test.mts`: 15/15
- `npx vitest run` (full): 64 files, 721 tests passed, chat snapshots unchanged
- `npm run typecheck:new`: clean; `node scripts/ci/tsc-ratchet.mjs`: ok
- Acceptance greps: `review_candidate` in `langfuse.ts` (2 lines), `ragTraceId` in the chat route and `setReviewContent` in the embed route are present.

## Self-Check: PASSED

- Files present: tests/rag-langfuse-review.test.mts, src/lib/rag/trace/finish.ts, src/app/api/chat/route.ts, src/app/api/embed/chat/route.ts
- Commits present: 63551c5, d01e0c6, 483b5a9, plus the tag-placement commit that follows
