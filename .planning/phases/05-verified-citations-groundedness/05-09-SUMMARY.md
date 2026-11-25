---
phase: 05-verified-citations-groundedness
plan: 09
subsystem: answers
tags: [answer-records, rls, routes, citations, snapshots, pglite]

requires:
  - phase: 05-verified-citations-groundedness
    provides: AnswerRecord and CitationRecord contracts (05-01); rag_answer_records table, select-own RLS and service-role writes (05-06)
  - phase: 03-unified-ingestion-embedding-profiles
    provides: rag_publish_document_version (03-10)
  - phase: 03.1-tiered-parsing-incremental-queue-bulk-backfill
    provides: rag_soft_delete_document (03.1-39)
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: runRechunkBatch (04-32)
provides:
  - src/lib/answers/store.ts (insertAnswerRecord, updateAnswerGroundedness, setAnswerFeedback, appendReviewReason, attachAnswersToChat, readOwnedAnswerRecord, listOwnedAnswerRecordsForChat, answerIdsInMessages, AnswerStoreError, ANSWER_RECORD_COLUMNS)
  - src/lib/answers/read.ts (toAnswerRecord, documentStatuses, citedDocumentIds, answerFeedbackEnabled, ANSWER_PENDING_EXPIRY_MS)
  - src/lib/citations/display.ts (citationDisplayEntries, CitationDisplayEntry)
  - GET /api/rag/answers/{answerId} and GET /api/rag/answers?chatId=
  - tests/helpers/pglite-admin.ts gains insert/upsert, RETURNING after a write, configurable jsonb columns and an asUser session mode
affects: [05-13, 05-15, 05-18, 05-20, 05-21, 05-23]

actuals:
  tasks: 3
  commits: 8
plan_head_before: d949c0d
plan_head_after: see git log exec/05-09

key-files:
  created:
    - src/lib/answers/store.ts
    - src/lib/answers/read.ts
    - src/lib/citations/display.ts
    - src/app/api/rag/answers/route.ts
    - src/app/api/rag/answers/[answerId]/route.ts
    - tests/rag-db/answer-records-store.test.mts
    - tests/rag-db/answer-records-snapshot.test.mts
    - tests/api/rag-answers.test.ts
  modified:
    - tests/helpers/pglite-admin.ts

key-decisions:
  - "Session lookup that throws gives 503; no user gives 401. Auth runs before parameter validation, so a malformed id from an anonymous caller gets 401."
  - "appendReviewReason is a compare-and-set on the stored array (update ... where review_reasons = <read value>, up to 5 attempts), so a concurrent feedback and groundedness writer cannot drop each other's reason. No new SQL function, no migration."
  - "insertAnswerRecord validates its input with the generated Zod (citations, groundedness) and refuses a personal or organization scope minted for another user; organization_id comes only from the TenantScope."
  - "A stored groundedness of {} (the column default) reads as pending; the 120 s rule is created_at + 120000 ms <= now."
  - "documents: ids that are not UUIDs, rows hidden by documents RLS, rows with is_current false or status deleted, and a failed lookup all give unavailable (fail closed, no error to the client)."
  - "GET ?chatId= continues when the attach write fails (logged) and lists what is already linked; a stored record that fails AnswerRecordSchema makes the whole response 500."
  - "Chat ownership is checked through the session client with user_id = session user, then attach uses the admin client with user_id, chat_id IS NULL and organization IS NOT DISTINCT FROM the chat's."

requirements-completed: [GEN-03, GEN-06, EVAL-16]

duration: ~2h
completed: 2026-11-25
---

# Phase 5 Plan 09: Answer-record store, read routes and snapshot survival

**The server now has one data-access module for `rag_answer_records` and two read routes. Only the owner can read a record: reads go through the session client, so RLS decides, and the store adds a `user_id` filter as a second check. A missing record and someone else's record get the same 404. A record still pending after 120 s reads as `not_checked`/`expired`, and the read never writes. A test proves that citation snapshots still show their quote, document name and number after a re-chunk, a version publish, a soft delete and a hard delete.**

## Task commits

| Task | RED | GREEN |
|------|-----|-------|
| 1. Store (D-16, D-15) | `71bf3a4` test: 15 of 16 cases failed on assertions against a stub store | `bfe7dd6` feat |
| 2. Read routes (D-15, D-17, D-03) | `efde1c3` test: 12 of 12 failed on status assertions (stub routes answered 501) | `37cf156` feat, `75780ff` fix (trimmed-literal switch rule) |
| 3. Snapshot survival (D-03) | `89a4577` test: 6 of 6 failed on the rendered-entries assertion (stub returned no entries); setup, re-chunk, publish and deletes already ran | `34305cd` feat |

## Behaviour changes

- New `GET /api/rag/answers/{answerId}` route:
  - 400 `{success:false, error, details}` for a malformed id;
  - 401 with no session, 503 if the session lookup throws;
  - 200 with an `AnswerRecordSchema`-valid body for the caller's own record;
  - 404 `{error:'Answer not found'}`, identical for a missing id and another user's id;
  - never 403.
- New `GET /api/rag/answers?chatId=` route:
  - 400 if `chatId` is missing or malformed;
  - 404 for a chat the caller does not own, with the same body as for a missing chat;
  - otherwise it links the caller's unlinked records whose answerId appears in that chat's assistant messages, then returns `{records}` for the chat, ordered by `created_at`.
- On both routes, `feedbackEnabled` mirrors `RAG_ANSWER_FEEDBACK`, read at call time. Only the trimmed literal `true` turns it on.
- Nothing calls the store's write functions yet. 05-13 inserts records, 05-18 writes groundedness and 05-21 writes feedback.
- No function writes to `chats`.

## Tests that failed before the fix

- `tests/rag-db/answer-records-store.test.mts`: 15 of 16 cases across both modes; the one pass was the scope-mismatch case, which has nothing to check in single-tenant.
- `tests/api/rag-answers.test.ts`: 12 of 12.
- `tests/rag-db/answer-records-snapshot.test.mts`: 6 of 6.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | 0 diagnostics |
| `npx vitest run` | 254 files, 4075 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1121 pass, 0 fail, 4 skipped (the known ingestion-ledger-pg root skip) |
| check-rag-boundary + node test | ok; 38 pass |
| `node scripts/check-config.mjs` | **1 violation on this branch alone:** `RAG_ANSWER_FEEDBACK` is not in the manifest (see Deviations). In a throwaway worktree with `origin/exec/05-02` merged in, the merge is clean and the check passes: `ok: 135 variable(s) match the manifest`. |
| check-workflows.py | OK |
| Python pytest | not required: no Python touched |
| `npm run gen:schemas` | not required: no contract touched |
| `npm run test-rag` | not required: no retrieval, ingest or golden-set change |

## Deviations

1. **`RAG_ANSWER_FEEDBACK` belongs to plan 05-02, which is not in this branch's base.** The plan requires `feedbackEnabled` to mirror the switch, and 05-23 relies on that. 05-02 (wave 1, already on `origin/exec/05-02`) adds the variable to the five config places and the manifest, and adds `readGenerationConfig`. This plan does not repeat those changes: adding the same variable in eight files would conflict with 05-02 at merge. The read in `src/lib/answers/read.ts` uses the same trimmed-literal rule as `readGenerationConfig`. So check-config reports one violation on `exec/05-09` alone, and it clears once 05-02 is merged; the two branches merge with no conflict. Merge 05-02 before 05-09. 05-21 may switch `answerFeedbackEnabled()` to `readGenerationConfig().answerFeedback`.
2. **Re-chunk keeps the document current.** The plan lists re-chunk among the changes after which D is unavailable. `runRechunkBatch` writes chunks under another profile and leaves the documents row current, so the test expects `current` after re-chunk, and the link is kept. After the version publish, the soft delete and the hard delete it expects `unavailable`. The stored row is byte-identical (`row_to_json`) after every step.
3. **Snapshot test runs in multi-tenant only.** It reuses the two-tenant fixture and the setup of the re-chunk suite. The store tests run in both modes.
4. **Test helper extended.** The PGlite query builder in `tests/helpers/pglite-admin.ts` gains `insert` and `upsert` (with `ignoreDuplicates`), `RETURNING` when `.select()` follows a write, configurable jsonb columns, and an `asUser` mode. `asUser` runs each statement as `authenticated` with the JWT sub claim, in its own transaction, so it stands in for the session client. Existing callers keep their behaviour.
5. **No migration.** 0501 and 0502 from 05-06 cover the table, so no migration number was taken.

## Decisions for STATE

- The client poll contract: 404 means "not there or not yours". The record body always validates against `AnswerRecordSchema`, and `documents` holds only the record's own cited ids.
- `appendReviewReason` uses compare-and-set on `review_reasons`, not a SQL function.
- Store reads take the client they are given. Routes pass the SSR session client, and the admin client is used only for the attach write, after the ownership check.

## Operator actions

- None. The routes need a session and are inert until 05-13 writes records.

## Deferred

- The feedback POST (05-21), groundedness writes (05-18), the record insert from the chat route (05-13), and the sources-panel use of `citationDisplayEntries` (05-20).

## Design skills

Not applicable: no UI file touched.

## Self-Check: PASSED
