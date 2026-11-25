---
phase: 05-verified-citations-groundedness
plan: 13
subsystem: api
tags: [answer-records, answerId, chat-route, after, citations, groundedness]

requires:
  - phase: 05-verified-citations-groundedness
    provides: citation session and route wiring (05-08); answer-record store and read routes (05-09); readGenerationConfig and the four switches (05-02)
provides:
  - "src/lib/rag/generation/answer-finish.ts: shouldPersistAnswer, mintAnswerId, scheduleAnswerFinish, AnswerFinishInput, AnswerFinishDeps (with the onPending hook for 05-18), AnswerPendingContext"
  - "CitationSession.fullRecords(): the validated records with full quotes"
  - "Chat route: answerId in the start and finish message metadata, one post-stream record per answer"
affects: [05-15, 05-18, 05-20, 05-21, 05-23]

actuals:
  tasks: 2
  commits: 4

key-files:
  created:
    - src/lib/rag/generation/answer-finish.ts
    - tests/rag/generation/answer-finish.test.ts
    - tests/rag/citations/chat-answer-record-route.test.ts
  modified:
    - src/app/api/chat/route.ts
    - src/lib/rag/index.ts
    - src/lib/rag/generation/citations/session.ts

requirements-completed: [GEN-03, GEN-06, GEN-07, EVAL-16]

duration: ~1h
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 13: answerId and the post-stream answer record

**A web-chat answer from a signed-in user, outside ghost chats, with at least one Phase 5 switch on, now gets an `answerId`. The id is sent in the `start` and `finish` message metadata next to `ragTraceId`, and one `after()` task writes its `rag_answer_records` row once the stream has closed. The answer is never delayed. Every other request streams exactly the bytes it streamed before.**

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1. answer-finish module (D-05, D-15, D-16) | `5772ec0` test: 16 of 17 cases failed on assertions against a stub module | `63e156a` feat |
| 2. Route wiring (D-06, D-15) | `c79e915` test: 5 of 11 cases failed on assertions (no `answerId`, nothing scheduled); the 6 byte-identity guards passed | `f01c8be` feat |

## What it does

### `answer-finish.ts`

- `shouldPersistAnswer` is true only when all of these hold:
  - `capabilities.citations` is true;
  - there is a session user id;
  - the chat id does not start with `ghost-`, or there is no chat id;
  - at least one of `RAG_CITATIONS`, `RAG_CLAUDE_CITATIONS`, `RAG_GROUNDEDNESS` or `RAG_ANSWER_FEEDBACK` is on.
- `mintAnswerId` returns `crypto.randomUUID()`.
- `scheduleAnswerFinish(input, deps)`:
  - runs once per `answerId`; a second call is ignored, tracked in a bounded in-process set;
  - runs inside `scheduleAfterResponse`;
  - never throws into the caller.
- The scheduled task does this:
  1. Looks up `chats` on the admin client by `id` and `user_id`.
  2. Sets `chat_id` only when the row belongs to the session user and its `organization_id` matches the scope: the organization for an `org` scope, null for `single` and `personal`. Anything else stores null, and 05-09 attaches the record later. A chat id that is not a UUID gets no lookup.
  3. Inserts the row through `insertAnswerRecord` with:
     - the full citations (not the capped metadata copy);
     - the strategy, the invalid count, the rag mode, the model id and the trace id;
     - `answer_language` from `detectLanguage(answerText)`.
- The initial groundedness is decided in this order:
  1. `aborted` gives `not_checked`/`aborted`;
  2. the switch off gives `not_checked`/`disabled`;
  3. a turn that is not eligible gives `not_checked`/`not_eligible`;
  4. an MCP tool result gives `not_checked`/`tool_output` (D-14);
  5. otherwise `{status:'pending'}`.
- `onPending` is the hook for 05-18. It runs only after a pending row was actually inserted.
- Logging:
  - a failed lookup logs one `[Answer Record]` warn line with the `answerId` and the error code;
  - a failed insert or scheduling step logs one `[Answer Record]` error line with the `answerId` and the error code;
  - no answer, query or chunk text is ever logged.
- `queryText` and the premise inputs stay in memory for 05-18 and 05-21 and are never stored.

### Route (`src/app/api/chat/route.ts`)

- After the citation session is built, the route reads the session user, but only when the scope exists and the body carries `capabilities.citations: true`. When `shouldPersistAnswer` holds, it mints the `answerId`.
- Metadata:
  - `start` gets `{ragTraceId, answerId}` (`ragTraceId` first, as before);
  - `finish` gets `answerId` right after `ragTraceId`;
  - on the `source_images` path (no `start`), only the finish metadata carries it.
- `createUIMessageStream` `onFinish` calls `finishAnswerRecord` once, behind a flag that is cleared before the call, the same pattern as `finishRagTrace`. The values it passes:
  - **answer text:** the text parts of `responseMessage`, which is exactly what was streamed;
  - **aborted:** `isAborted || req.signal.aborted`;
  - **eligible:** no generation error, `ragMode` strict or balanced, and non-image knowledge-base blocks sent with retrieval `ok` or `degraded`. Refusal and knowledge-base-unavailable responses return before this stream, so they never reach it;
  - **tool output used:** any step tool result whose name is not `webSearch` or `useDocument` (`ANSWER_EVIDENCE_TOOLS`);
  - **premise:** the non-image context blocks in order, plus the webSearch result texts.
- The new names are exported from `@/lib/rag`, so the boundary check passes.

## Behaviour changes

- No change unless `capabilities.citations` is true, there is a session user, the chat is not a ghost chat, and at least one of the four switches is on.
- When all of those hold:
  - the stream carries `answerId`;
  - one row is written after the response, linked to the chat only if the user owns it.
- Ghost chats still get citations in the metadata (05-08) but no `answerId` and no record.

## Tests that failed before the fix

- `tests/rag/generation/answer-finish.test.ts`: 16 of 17 cases failed on assertions against the stub. The one that passed was the "throwing scheduler" case, which the stub met by doing nothing.
- `tests/rag/citations/chat-answer-record-route.test.ts`: 5 of 11 cases failed:
  - start and finish carry the same id, and the scheduled input has the streamed text and the full records;
  - a new id per request;
  - the `source_images` finish metadata;
  - the eligibility for balanced and flexible;
  - the client abort.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | 0 diagnostics |
| `npx vitest run` | 261 files, 4150 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1446 pass, 4 fail, 4 skipped (all pre-existing, below) |
| check-rag-boundary and its node test | ok (1162 files); 38 pass |
| `node scripts/check-config.mjs` | ok, 135 variables |
| check-workflows.py | OK |
| `npm run test-rag -- --out eval/out/05-13` | gate PASS (7 skipped) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/05-13-ingest` | gate PASS (7 skipped) |
| Python suites, `gen:schemas` | not required: no Python or contract change |

### Pre-existing failures

- `tests/rag-db/ingest-mode-routing.test.mts`: 4 subtests fail. The sidecar's download of `cl100k_base.tiktoken` from `openaipublic.blob.core.windows.net` fails with `SSLError ... CERTIFICATE_VERIFY_FAILED`. This is the known cold-cache failure; this plan does not touch that code.
- The 4 skips are the known `ingestion-ledger-pg` root skip.

## Deviations

1. **`session.ts` gains `fullRecords()`.** That file is not in the plan's file list. The session kept only the capped copy, and the plan requires the full citations in the record. The method returns the validated records before `capQuotes`, and `[]` whenever the metadata gets `[]` (on a parser or record failure). The change was committed with the Task 2 RED test.
2. **The answer text comes from `responseMessage`, not `result.text`.** `result.text` holds only the last step's text and may never settle when the client cancels. The text parts of the UI response message are exactly what was streamed, and they are available in `onFinish` on both a normal finish and a cancel.
3. **Aborts are detected with `req.signal.aborted` as well.** The route passes no `abortSignal` to `streamText`, so a client disconnect cancels the UI stream without an `abort` chunk, and `isAborted` stays false.
4. **`traceId` falls back to the `answerId` when no trace exists.** That happens only when RAG is disabled, where `ragTraceId` is absent. The contract requires a non-empty `traceId`.
5. **A fifth groundedness reason, `tool_output`,** applies when an MCP tool result was used (D-14). The plan listed only disabled, aborted and not_eligible.
6. **A generation error marks the turn ineligible.** The record is still written, because the client already holds the `answerId`.
7. No migration, env variable, contract, package or UI change.

## Decisions for STATE

- `answerId` is minted only for persisted answers. Its presence in the metadata means the server will try to write a record.
- The answer text for the record and for groundedness is the streamed UI text, with raw markers. 05-18 strips the markers for the hypothesis.
- The chat link at insert time needs ownership plus an organization match against the resolved `TenantScope`. Otherwise `chat_id` is null and 05-09 attaches the record.
- `onPending` in `AnswerFinishDeps` is where 05-18 continues with scoring. It runs only after a pending row was inserted.

## Operator actions

None. All four switches stay off by default, and the web client does not send `capabilities.citations` yet (05-15).

## Deferred

- Groundedness scoring through `onPending` (05-18), feedback (05-21), and the client poll and persistence of `answerId` (05-15).

## Design skills

Not applicable: no UI file touched.

## Self-Check: PASSED
