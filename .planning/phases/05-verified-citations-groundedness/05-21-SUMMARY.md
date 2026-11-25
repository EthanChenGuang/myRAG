---
phase: 05-verified-citations-groundedness
plan: 21
subsystem: generation
tags: [feedback, review-queue, langfuse, scores, groundedness, admin-route, pii-masking]

requires:
  - phase: 05-verified-citations-groundedness
    provides: ReviewQueueItem.reasons (05-07); setAnswerFeedback, appendReviewReason, attachAnswersToChat, readOwnedAnswerRecord (05-09); answer-finish groundedness step, postLangfuseScores and scoreId (05-18)
  - phase: 03-unified-ingestion-embedding-profiles
    provides: S7 admin guard (checkAdmin, adminDenied, requireAdminOrDeny); rag_admin_tenant_keys
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: maskPII, exportTrace with review content, scheduleAfterResponse
provides:
  - "src/lib/rag/generation/feedback.ts: submitAnswerFeedback (exported from @/lib/rag)"
  - "POST /api/rag/answers/{answerId}/feedback"
  - "src/lib/rag/trace/review-export.ts: exportReviewCandidate"
  - "src/lib/rag/trace/review-candidates.ts: listReviewCandidates (exported from @/lib/rag)"
  - "GET /api/rag/admin/review-candidates?from=&to="
  - "src/lib/answers/exchange.ts: exchangeForAnswer, messageText, recordTenantKey, citedQuotesOf"
  - "answer-finish: groundedness_flagged reason and review export for possibly_unreliable"
  - "python -m rag_eval.review_queue pull --source langfuse|db|both, --base-url, --token-env; ReviewQueueItem.reasons filled"
  - "tests/helpers/answer-db-fake.ts (in-memory session/admin Supabase client for answer-record tests)"
affects: [05-23, 05-26]

actuals:
  tokens: 25900
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "Database first, Langfuse after the response: the vote is written before any network call; score and review copy are time-boxed in scheduleAfterResponse with one [RAG Feedback] fallback line"
    - "Review copies as a separate masked observation on the same traceId (research P-12), tagged review:<reason>, independent of both sample rates"
    - "Admin reads scoped to rag_admin_tenant_keys(p_actor): the tenant set is resolved in SQL, then filtered again in TypeScript"

key-files:
  created:
    - src/lib/rag/generation/feedback.ts
    - src/app/api/rag/answers/[answerId]/feedback/route.ts
    - src/lib/rag/trace/review-export.ts
    - src/lib/rag/trace/review-candidates.ts
    - src/app/api/rag/admin/review-candidates/route.ts
    - src/lib/answers/exchange.ts
    - tests/rag/generation/feedback.test.ts
    - tests/api/rag-answers-feedback.test.ts
    - tests/api/review-candidates.test.ts
    - tests/helpers/answer-db-fake.ts
  modified:
    - src/lib/rag/generation/answer-finish.ts
    - src/lib/rag/index.ts
    - tests/rag-langfuse-review.test.mts
    - eval/src/rag_eval/review_queue.py
    - eval/tests/test_review_queue.py

key-decisions:
  - "Route order: switch off 404 (before session or body), then session 401/503, then content type 415, then malformed JSON 400, then schema 400, then 404 for a malformed id, a missing record or another user's record (identical body), 503 when the store fails"
  - "Malformed JSON is rejected before validateRequest, because validateRequest echoes the parser message, which can quote the comment"
  - "A helpful vote stores reasons [] and comment null even if the body sent some; a not_helpful comment is trimmed, empty becomes null; the raw comment is stored on the caller's own row, only the Langfuse copy is masked"
  - "user_feedback is a NUMERIC score (1 helpful, 0 not helpful) with id scoreId(traceId,'user_feedback'), so a changed vote overwrites; comment = 'reasons: a, b' plus the masked free text"
  - "Every not_helpful vote sends a review copy (a re-vote re-exports the same trace); feedback_negative is appended once (appendReviewReason is idempotent)"
  - "The review text for a negative vote is read after the response with the admin client from chats where id = record.chat_id and user_id = caller; no chat or another user's chat gives empty query and answer"
  - "[RAG Feedback] is logged once when the score was not accepted (off, no traceId, failed or timed out) or the review export failed; it carries answerId, vote, reason count and status codes only"
  - "Review export skips a traceId that is not 32-hex (the OTel id exportTrace needs) and never throws; statuses exported, skipped, failed"
  - "The admin route lists only records of tenants rag_admin_tenant_keys returns: s:default lists all (single-tenant), otherwise personal records of the admin plus records of organizations the admin owns or administers; at most 500, newest updated_at first"
  - "Admin items: observation_id = answerId, captured_at = updated_at, tags review_candidate plus review:<reason>, language zh-* to zh, en, it, else null; records without trace_id are skipped"
  - "Python: items from every source are merged by trace_id (earliest capture kept, reasons and tags unioned, empty text filled from the other item); a Langfuse item with no review:<reason> tag gets reasons [sampled]; db items are validated and masked again"

requirements-completed: [EVAL-16]

coverage:
  - id: D1
    description: "Users vote helpful / not helpful on their own answers; the vote is stored first, latest wins, 404 for anything not theirs"
    requirement: EVAL-16
    verification:
      - kind: unit
        ref: "tests/rag/generation/feedback.test.ts (submitAnswerFeedback)"
        status: pass
      - kind: integration
        ref: "tests/api/rag-answers-feedback.test.ts"
        status: pass
  - id: D2
    description: "Vote sent to Langfuse as user_feedback with a masked comment; [RAG Feedback] fallback; never lost on Langfuse failure"
    requirement: EVAL-16
    verification:
      - kind: unit
        ref: "tests/rag/generation/feedback.test.ts (posts user_feedback ..., hangs past the time box, Langfuse off)"
        status: pass
  - id: D3
    description: "feedback_negative and groundedness_flagged reach review_reasons and a masked review:<reason> copy on the trace, independent of sampling"
    requirement: EVAL-16
    verification:
      - kind: unit
        ref: "tests/rag/generation/feedback.test.ts (exportReviewCandidate, groundedness_flagged after scoring)"
        status: pass
      - kind: integration
        ref: "tests/rag-langfuse-review.test.mts (review export for feedback_negative and groundedness_flagged)"
        status: pass
  - id: D4
    description: "Admin review-candidates route and review_queue pull --source db|both with dedupe and reasons"
    requirement: EVAL-16
    verification:
      - kind: integration
        ref: "tests/api/review-candidates.test.ts"
        status: pass
      - kind: unit
        ref: "eval/tests/test_review_queue.py"
        status: pass

duration: ~2h
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 21: Answer feedback and the review queue

**Users can now rate any persisted RAG answer. The vote lands in `rag_answer_records.feedback` before anything else happens; after the response it goes to Langfuse as the `user_feedback` score with a masked comment, and a `[RAG Feedback]` line is the fallback. A not-helpful vote and a `possibly_unreliable` groundedness label each add their reason to `review_reasons` and send a masked copy of the query, the answer and the cited snapshots to the trace, tagged `review_candidate` and `review:<reason>`, whatever the sample rates. Admins read flagged records through `GET /api/rag/admin/review-candidates`, and `python -m rag_eval.review_queue pull --source db|both` turns them into queue items next to the Langfuse ones.**

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1. Feedback service and route (D-17, D-18, D-19) | `c3a4c8c` test: 18 of 20 failed on assertions against a stub service and a 501 route | `c6f3730` feat |
| 2. Review export and groundedness_flagged (D-19) | `5c468c8` test: 4 of 16 vitest cases and 2 node cases failed on assertions against a stub export | `e5f00ef` feat |
| 3. Admin review-candidates route and review_queue --source db (D-19) | `18733bc` test: 6 of 6 route cases and 8 of 9 new Python cases failed on assertions (stub route answered 501; CLI accepted the flags and ignored them) | `ec87fcc` feat |

## Behaviour changes

- **`POST /api/rag/answers/{answerId}/feedback`** (new):
  - `RAG_ANSWER_FEEDBACK` not the trimmed literal `true`: 404, before the session or the body is read.
  - No session 401; session lookup throws 503.
  - Content type other than `application/json` (parameters allowed): 415.
  - Malformed JSON: 400 `{success:false, error, details}` that never quotes the body.
  - Body failing `AnswerFeedbackRequestSchema` (strict: a `query` or `answer` field is rejected): 400 with details.
  - Malformed id, missing record, another user's record: the same 404 `{error:'Answer not found'}`. Never 403.
  - Store failure: 503 and nothing scheduled.
  - Success: 200 `{feedback}`, `Cache-Control: no-store`.
- **`submitAnswerFeedback`**, in order:
  1. reads the caller's record through the session client (RLS plus the user_id guard);
  2. if the body's `chatId` is a chat the caller owns that lists this answerId, links the unlinked record (a foreign or unlisted chat is ignored);
  3. writes the vote through `setAnswerFeedback`;
  4. for not_helpful, appends `feedback_negative` (once);
  5. schedules, after the response, the score and (for not_helpful) the review export, each time-boxed (3 s by default).
- **`exportReviewCandidate`** sends one masked trace on the record's traceId with tags `rag-pipeline`, `profile:chat`, `tenant:<key>`, `review:<reason>`, plus `review_candidate` from `exportTrace`. Langfuse off or a non-OTel traceId sends nothing.
- **answer-finish**: when the groundedness label is `possibly_unreliable`, the step appends `groundedness_flagged` and exports the review copy from the in-memory query, answer and citation quotes. `verified` and `not_checked` do neither. Failures log `[Answer Record]` / `[RAG Trace]` with codes only. The existing span and scores report is unchanged.
- **`GET /api/rag/admin/review-candidates?from=&to=`** (new): S7 guard first (401/403/503, nothing read before it), then 400 for a missing, malformed or reversed window, then `rag_admin_tenant_keys(p_actor)`; 503 when that or a read fails. Returns `{items: ReviewQueueItem[]}`, every text masked, query and answer from the record's own user's chat row only.
- **`review_queue pull`**: `--source langfuse` (default) behaves as before, except that items now carry `reasons` and two observations on the same trace become one item. `--source db` needs `--base-url` and the token in the variable named by `--token-env` (default `RAG_ADMIN_BEARER`); a missing token exits 2 naming the variable; an HTTP failure exits 4 with the status and never the token. `--source both` merges the two.
- With every switch at its default, nothing changes: the feedback route answers 404, and no record is ever `possibly_unreliable` because groundedness is off.

## Tests that failed before the fix

- `tests/rag/generation/feedback.test.ts`: 9 of 11 service cases (Task 1), then 4 export / groundedness_flagged cases (Task 2).
- `tests/api/rag-answers-feedback.test.ts`: 9 of 9.
- `tests/rag-langfuse-review.test.mts`: the 2 new review-export cases.
- `tests/api/review-candidates.test.ts`: 6 of 6.
- `eval/tests/test_review_queue.py`: 8 of the 9 new cases (the default-source case already passed).

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | 0 diagnostics |
| `npx vitest run` | 272 files, 4334 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 170 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1446 pass, 4 fail, 4 skipped. The 4 failures are all in `ingest-mode-routing.test.mts`: the sidecar worker could not download tiktoken `cl100k_base` (SSL to openaipublic.blob.core.windows.net). This is the known pre-existing failure. Rerun alone: 13 pass, 0 fail. The 4 skips are the known `ingestion-ledger-pg` root skip. |
| `node scripts/ci/check-rag-boundary.mjs` + node test | ok, 1185 files; node test passes |
| `node scripts/check-config.mjs` | ok, 135 variables match the manifest |
| `check-workflows.py` | OK |
| rag-sidecar pytest | 1387 passed, 11 skipped |
| eval pytest | 735 passed |
| `npm run gen:schemas` | not required: no contract touched |
| `npm run test-rag` (both modes) | not required: no retrieval, ingest or golden-set change |

`eval/fixtures/parse/` was restored with `git checkout -- eval/fixtures/parse/` after the Python run; nothing there is committed.

## Deviations

1. **The admin route uses `checkAdmin` + `adminDenied`, not `requireAdminOrDeny`.** It needs the verified admin id to resolve tenants in SQL, and `requireAdminOrDeny` returns only a response. These are the two halves of `requireAdminOrDeny` (same guard, same 401/403/503 bodies), the pattern the chunking-profile routes already use. The acceptance grep for `requireAdminOrDeny` matches only the doc comment that says so.
2. **The admin route is tenant-scoped.** The plan does not mention it, but rule one is "no cross-tenant leak". The route calls `rag_admin_tenant_keys` (an existing service-role function) and filters in both the query and TypeScript. In multi-tenant mode, an admin sees their personal records and those of organizations they own or administer, as for the quarantine list. No new SQL function and no migration.
3. **The item building lives in `src/lib/rag/trace/review-candidates.ts`** (`listReviewCandidates`, exported from `@/lib/rag`), not in the route. `maskPII` is below `@/lib/rag`, and the boundary check forbids deep imports from routes.
4. **New file `src/lib/answers/exchange.ts`.** It holds the chat-row reader shared by the feedback service and the admin route. The new test helper `tests/helpers/answer-db-fake.ts` is also not in the plan's list.
5. **The feedback service loads `@/lib/answers/store` lazily**, because the store imports `@/lib/rag`, which now re-exports the service. answer-finish does the same.
6. **A malformed answerId answers 404 on POST**, the same body as not found, per "404 for every not-found or not-owned case". The GET route from 05-09 answers 400 for a malformed id.
7. **Python dedupe by trace_id applies to the Langfuse source too.** A sampled trace that also gets a review copy is now one item with `reasons: [sampled, <reason>]`, not two.
8. **`RAG_ADMIN_BEARER` is a CLI environment variable for the eval tool, not an app setting.** It is not added to `.env.local`, the five config places or the env manifest. check-config passes.
9. **Migration number:** none taken.

## Decisions for STATE

- EVAL-16 is complete on the server side. The UI control is plan 05-23.
- Feedback flow: database first, then Langfuse after the response (`user_feedback`, deterministic id, masked comment), with `[RAG Feedback]` as the fallback.
- Review reasons reach the record and, when Langfuse is on, a masked `review:<reason>` copy on the same trace, whatever the sampling.
- The admin review route is limited to the tenants `rag_admin_tenant_keys` returns.
- `review_queue pull --source db|both` with dedupe by trace id; `ReviewQueueItem.reasons` is filled for every source.

## Operator actions

- To pull from the database: set `RAG_ADMIN_BEARER` to an admin user's Supabase access token, then run `python -m rag_eval.review_queue pull --from <iso> --to <iso> --source db --base-url <app origin>`. Use `--source both` to merge with Langfuse.
- Turning on `RAG_ANSWER_FEEDBACK=true` exposes the route. The UI arrives with 05-23.

## Deferred

- Plan 05-26 checks live whether Langfuse merges tags across the separate review observation and the original trace (research A2).
- There is no pagination beyond the 500-item cap on the admin route. Narrow the window for larger volumes.
