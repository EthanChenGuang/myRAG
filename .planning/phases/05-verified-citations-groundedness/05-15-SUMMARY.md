---
phase: 05-verified-citations-groundedness
plan: 15
subsystem: chat-client
tags: [answer-records, answerId, citations, groundedness, polling, message-metadata, zustand]

requires:
  - phase: 05-verified-citations-groundedness
    provides: AnswerRecord and CitationRecord contracts (05-01); GET /api/rag/answers/{answerId} and ?chatId= (05-09); answerId in the start and finish metadata and the post-stream record (05-13)
provides:
  - "src/lib/chat/answer-metadata.ts: pickAnswerMetadata, extractStreamAnswerMetadata, mergeAnswerRecord, AnswerMessageMetadata, StreamAnswerMetadata"
  - "src/lib/stores/answer-records-store.ts: useAnswerRecordsStore (records by answerId, latest updatedAt wins)"
  - "src/lib/chat/use-answer-records.ts: POLL_SCHEDULE_MS, pollAnswerRecord, loadChatAnswerRecords, reconcileAnswerRecords, createAnswerRecordsController, canSaveMessages, isPersistedChatId, useAnswerRecords"
  - "src/types/chat.ts: toDBMessages and toExtendedMessage keep the validated answer metadata"
  - "src/app/page.tsx: capabilities and chatId on /api/chat, answer metadata on the final message, useAnswerRecords mounted once"
affects: [05-20, 05-21, 05-23, 05-25]

actuals:
  tasks: 3
  commits: 7

key-files:
  created:
    - src/lib/chat/answer-metadata.ts
    - src/lib/chat/use-answer-records.ts
    - src/lib/stores/answer-records-store.ts
    - tests/lib/answer-metadata.test.ts
    - tests/lib/use-answer-records.test.ts
  modified:
    - src/types/chat.ts
    - src/app/page.tsx
    - tests/chat-messages-roundtrip.test.ts

requirements-completed: [GEN-03, GEN-06, EVAL-16]

duration: ~1.5h
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 15: answer metadata on the client, polling and persistence

**The web chat now asks for citations and sends its chat id. The `answerId`, citations, strategy and invalid count from the stream land on the assistant message and are saved by the existing client save. After the stream the client polls the answer record with backoff for about 30 s, and on chat load it fetches all of the chat's records in one call. Each record's groundedness and feedback are merged into the message metadata and saved. Nothing stays open, the server never writes `chats.messages`, and ghost chats never poll, load or save records.**

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1. Message conversions (D-15, P-5) | `77c1165` test: 2 of 3 new cases failed on assertions against a stub `pickAnswerMetadata`; the "old messages unchanged" guard passed | `ee166bb` feat |
| 2. Helpers, store, poll, hook (D-15) | `8d9d402` test: 16 of 21 cases failed on assertions against stubs; the passing 5 are guards (identity, ghost, disabled, dispose) | `094eca2` feat, `5563f48` fix (no save while a stream placeholder is in the list) |
| 3. Page wiring (D-05, D-15) | - | `870986c` feat |

## What it does

### Conversions (`src/types/chat.ts`, `answer-metadata.ts`)

- `pickAnswerMetadata(metadata)` keeps only:
  - `answerId` when it is a UUID;
  - `citations`, entry by entry against `CitationRecordSchema` (valid entries kept, defaults filled);
  - `citationStrategy` (`claude-citations` or `chunk-alias`) and `invalidCitations` (integer >= 0);
  - `groundedness` against the `AnswerRecord` groundedness schema;
  - `feedback` against the non-null `AnswerRecord` feedback schema.
- `toDBMessages` and `toExtendedMessage` write `{ragTraceId?, ...pickAnswerMetadata}`, `ragTraceId` first. Without any of these keys there is no `metadata` key, as before. Unknown keys are still not persisted. `fromUIMessage` and `buildMetadata` already pass the whole metadata through.
- `DBMessage.metadata` is now `{ ragTraceId?: string } & AnswerMessageMetadata`.

### Stream, merge and store

- `extractStreamAnswerMetadata(metadata, previous)` merges the validated `ragTraceId`, `answerId`, `citations`, `citationStrategy` and `invalidCitations` of a start or finish part over the earlier parts. Groundedness and feedback never come from the stream.
- `mergeAnswerRecord(messages, record)` sets `groundedness` and `feedback` on the message whose `metadata.answerId` matches; a record with `feedback: null` removes stored feedback. It returns the same array instance when nothing changes.
- `useAnswerRecordsStore` keys records by `answerId`. An upsert replaces the stored record when its `updatedAt` is later, or equal with different content (the 120 s `expired` rule changes groundedness at read time without touching `updatedAt`). An upsert that changes nothing keeps the state object.

### Polling and loading (`use-answer-records.ts`)

- `pollAnswerRecord(answerId, {fetch, sleep, signal, onRecord})`:
  - waits 1000, 2000, 4000 and 8000 ms, then 8000 ms each time, and stops after the wait that takes the total past 30,000 ms (six requests at most, about 31 s);
  - 404 means not written yet; 200 with a valid `AnswerRecord` calls `onRecord` and stops once `groundedness.status` is not `pending`;
  - any other status, a body that fails the contract or names another id, and a network error stop at once and never throw;
  - an abort stops the loop; a non-UUID id makes no request.
- `loadChatAnswerRecords(chatId)` calls `GET /api/rag/answers?chatId=` once and returns the records that pass the contract. Ghost ids, null and non-UUID ids make no request; any error gives `[]`.
- `createAnswerRecordsController` holds the hook's logic so it can be tested without React:
  - loads each saved chat once;
  - polls an assistant message once per `answerId` when the message is not the `streaming` placeholder and its groundedness is missing or pending, and the id was not settled by the chat load;
  - waits for the current chat's load before it starts polls;
  - does nothing for a `ghost-` chat id or when disabled; `dispose()` aborts every poll.
- `useAnswerRecords({chatId, messages, setMessages, save})`:
  - creates one controller per mount and disposes it on unmount;
  - merges store records into the messages (`reconcileAnswerRecords`) for records linked to this chat or to no chat yet, so a record of another chat is never merged during a switch;
  - saves the merged list through the given `save` only for a saved chat id and only when no `streaming` or `thinking` placeholder is in the list. With no chat id yet it merges without saving; the reload after the new chat is created merges again from the store and saves;
  - logs nothing.

### Page (`src/app/page.tsx`)

- The manual `/api/chat` fetch and the (unused) `DefaultChatTransport` body add `capabilities: {citations: true}` and `chatId`. `chatId` is read at call time: the ghost id in incognito mode (falling back to a `ghost-` id when the store has none), otherwise the current chat id or null.
- The SSE parser captures the answer metadata on `start`, `message-metadata` and `finish` into the streaming message; the final assistant message carries it, so the existing debounced save persists it.
- `useAnswerRecords` is mounted once. Ghost mode, and the 50 ms chat-switch window, pass no `save`, which turns the hook off.
- Nothing else in the page changed. WhatsApp, voice and the embed widget are untouched.

## Behaviour changes

- Every web chat request now carries `capabilities.citations: true` and `chatId`. With all four Phase 5 switches off (the default) the server behaves exactly as before: no citation session, no `answerId`, no record (05-08 and 05-13 guards).
- On the manual stream path the final assistant message now keeps `ragTraceId` (it was dropped before) and, when the server sends them, the answer fields. Messages saved before this phase load and save unchanged.
- With a switch on, a finished answer triggers at most six `GET /api/rag/answers/{id}` calls over about 31 s, and opening a saved chat makes one `GET /api/rag/answers?chatId=` call. Incognito chats make none.

## Tests that failed before the fix

- `tests/chat-messages-roundtrip.test.ts`: "keeps answerId, citations, strategy, invalid count, groundedness and feedback through save, reload and the UI shape" and "drops malformed values field by field" failed: the metadata was cut to `{ragTraceId}`.
- `tests/lib/answer-metadata.test.ts`: 5 of 8 failed (extract, merge, store upsert).
- `tests/lib/use-answer-records.test.ts`: 11 of 13 failed (schedule, 30 s limit, 401/500 and network stops, contract stop, abort, non-UUID, chat load, reconcile, controller load-then-poll, controller with no chat id).

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | 0 diagnostics |
| `npx vitest run` | 263 files, 4175 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1446 pass, 4 fail, 4 skipped (all pre-existing, below) |
| check-rag-boundary and its node test | ok (1167 files); 38 pass |
| `node scripts/check-config.mjs` | ok, 135 variables |
| check-workflows.py | OK |
| `node scripts/ci/check-frontend-design-summary.mjs` (phase dir) | PASS |
| Python suites, `gen:schemas`, `test-rag` | not required: no Python, contract, retrieval, ingest or golden-set change |

### Pre-existing failures

- `tests/rag-db/ingest-mode-routing.test.mts`: 4 subtests fail because the sidecar cannot download `cl100k_base.tiktoken` from `openaipublic.blob.core.windows.net` (`SSLError ... CERTIFICATE_VERIFY_FAILED`). This is the known cold-cache failure (also in 05-13); this plan does not touch that code.
- The 4 skips are the known `ingestion-ledger-pg` root skip.

## Deviations

1. **The hook's logic lives in `createAnswerRecordsController`.** The repo has no React testing library and installing one is not allowed, so the hook is a thin wrapper and the controller, `reconcileAnswerRecords` and `canSaveMessages` are tested directly.
2. **`useAnswerRecords` takes `setMessages` as an updater and `save` as `(chatId, messages)`.** It never calls `save` with a null chat id, because the page's `debouncedSave(null, …)` would create a second chat.
3. **Extra exports:** `reconcileAnswerRecords`, `createAnswerRecordsController`, `canSaveMessages`, `isPersistedChatId`, `POLL_REPEAT_MS`, `POLL_LIMIT_MS`, `PollOutcome`.
4. **`message-metadata` parts are captured too,** next to `start` and `finish`, so metadata sent mid-stream is not lost.
5. **The `DefaultChatTransport` also gets the body.** The page never sends through it today; the plan asks for every `/api/chat` request.
6. **Fix commit `5563f48`:** a record arriving while the next answer streams would have saved the `streaming` placeholder into `chats.messages`; the hook now merges without saving then, and the stream's own final save carries the merged metadata.
7. No migration, env variable, contract, package or server change.

## Decisions for STATE

- Poll schedule: 1, 2, 4, 8 s, then every 8 s; stop after the wait that passes 30 s. 404 is "not yet"; any other non-200 stops.
- The answer-records store is the client's source of truth; messages are reconciled from it, and only records linked to the current chat or to no chat are merged.
- The client never saves with a null chat id and never saves a list holding a `streaming` or `thinking` placeholder.
- Malformed answer metadata is dropped field by field on every save and load.

## Operator actions

None. Polling starts only when the server sends an `answerId`, which needs one of the Phase 5 switches.

## Deferred

- Rendering citation chips (05-20), the groundedness badge and the feedback control (05-23); they read the merged metadata and `useAnswerRecordsStore` (select with `useShallow`).
- The human check in the plan (network tab with `RAG_CITATIONS=true`) needs a running app with Supabase and model keys; not run here.

## Design skills

No visual change: the page edit adds request fields, metadata capture and a hook with no rendered output; no markup, class or style changed.

| Skill | Outcome |
|-------|---------|
| frontend-design | n/a: no new interface or visual change |
| Impeccable | n/a: nothing rendered changed |
| web-design-guidelines | pass: reviewed the changed lines of `src/app/page.tsx`; no markup, accessibility, focus, motion or copy surface touched, so none apply |

`npx eslint --quiet src/app/page.tsx src/types/chat.ts`: 119 errors before the plan, 118 after (all pre-existing in `page.tsx`).

## Self-Check: PASSED
