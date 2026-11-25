---
phase: 05-verified-citations-groundedness
plan: 18
subsystem: generation
tags: [groundedness, hhem, sidecar, langfuse, scores, after, answer-records]

requires:
  - phase: 05-verified-citations-groundedness
    provides: answer-finish with the pending insert and the onPending hook (05-13); groundedness decisions and the sidecar client (05-14); updateAnswerGroundedness (05-09); the AnswerRecord groundedness contract (05-01)
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: readLangfuseConfig, isSampled, exportTrace, scheduleAfterResponse
provides:
  - "src/lib/rag/trace/scores.ts: postLangfuseScores, scoreId (the TypeScript Langfuse scores client)"
  - "src/lib/rag/generation/groundedness.ts: scoreAnswerGroundedness, AnswerGroundedness, ScoreAnswerGroundednessInput, ScoreAnswerGroundednessDeps"
  - "src/lib/rag/generation/answer-finish.ts: createGroundednessStep and GroundednessStepDeps; the default onPending now scores the answer"
  - "@/lib/rag exports scoreAnswerGroundedness and groundednessEligibility (for 05-22)"
  - "CollectedTrace stages accept scalar span attributes (TraceStage)"
affects: [05-21, 05-22, 05-23, 05-26]

actuals:
  tokens: 14750
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "Langfuse scores from TypeScript: one time-boxed batch POST, deterministic ids sha256(traceId|name), 202 accepted / 207 partial, never throws"
    - "Post-response continuation: score, store, log, report; every step time-boxed and wrapped"

key-files:
  created:
    - src/lib/rag/trace/scores.ts
    - tests/rag/trace-scores.test.ts
    - tests/rag/generation/answer-finish-groundedness.test.ts
    - tests/rag/generation/answer-finish-groundedness-route.test.ts
  modified:
    - src/lib/rag/generation/groundedness.ts
    - src/lib/rag/generation/answer-finish.ts
    - src/lib/rag/trace/langfuse.ts
    - src/lib/rag/index.ts

key-decisions:
  - "Only en and zh-Hans are sent to the sidecar; every other answer language is not_checked unsupported_language without a request"
  - "Langfuse is reported to when the trace was trace- or review-sampled, or the label is possibly_unreliable"
  - "The groundedness span goes through exportTrace as a CollectedTrace with one groundedness stage; scorer, label and language ride as stage attributes"

requirements-completed: [GEN-05, GEN-06]

duration: ~1.5h
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 18: Groundedness after the response

**After the pending answer record is inserted, the same `after()` task now scores the answer through the sidecar, labels the score, updates the row, writes one `[Groundedness]` log line and, when allowed, sends a `groundedness` span and two scores to Langfuse. The answer stream is finished before any of this starts, and nothing here can block, change or fail an answer.**

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1. Langfuse scores client (D-15, D-18) | `39e3181` test: 7 of 8 cases failed on assertions against a stub | `0f2743b` feat |
| 2. Scoring orchestrator (D-13, D-14, D-21) | `8983c07` test: 11 of 11 failed on assertions against a typed stub | `05b112a` feat |
| 3. After-response execution, storage, log, span and scores (D-15) | `eeeae9e` test: 11 unit cases and the route case failed on assertions against a no-op step | `6fe79a4` feat |

## What it does

### `postLangfuseScores(scores, {config, timeoutMs, fetch})` and `scoreId`

- `scoreId(traceId, name)` is the sha256 hex of `traceId|name`, so the same score name posted again on a trace overwrites the earlier one.
- One POST to `<base>/api/public/scores`:
  - Basic auth with `public:secret`;
  - a JSON array body of `{id, traceId, name, value, dataType, comment?, metadata?}`.
- Results:
  - 202 (or 200) gives `accepted`; 207 gives `partial`;
  - any other status, a transport failure or the time box (default 3 s) gives `failed`;
  - Langfuse disabled, a missing key or an empty list gives `skipped` and sends nothing.
- It never throws and logs nothing, so no key can reach a log line.

### `scoreAnswerGroundedness(input, {request, countTokens, cells, now})`

The checks run in this order. Every skipped case returns `not_checked` with scorer `none` and sends no request:

1. Not eligible: the eligibility reason (`not_eligible` or `tool_output`).
2. An empty hypothesis after the markers are stripped: `empty_answer`.
3. The answer language is not `en` or `zh-Hans`: `unsupported_language`. This covers zh-Hant, ambiguous `zh`, Italian and unknown.
4. The premise builder returns `too_long` or `empty_premise`: that reason.

Otherwise it sends one request:

- `request_id` is the answerId, plus the premise texts, the stripped hypothesis and the language;
- `allow_vectara` comes from `allowVectaraFor`, which applies the multi-tenant acknowledgement;
- the timeout is `RAG_GROUNDEDNESS_TIMEOUT_MS`.

The result is labelled with `labelGroundedness` and returned in the `AnswerRecord.groundedness` contract shape with `checkedAt`. `truncated` is true if the premise builder truncated, even when the sidecar reports false. A throwing request function gives `not_checked` with reason `error`.

### The groundedness step (`createGroundednessStep`, the default `onPending`)

1. Scores the answer with the premise blocks, the cited aliases from the full citation records and the webSearch texts.
2. Updates the row through `updateAnswerGroundedness`, with a 5 s time box. A failure logs one `[Answer Record]` warn line with the error code.
3. Writes exactly one line: `[Groundedness] {answerId, status, scorer, label, language, truncated, latencyMs}`. It contains no answer, chunk, premise or query text.
4. Reports to Langfuse only when it is usable and either:
   - the trace was sampled (trace or review sample), or
   - the label is `possibly_unreliable`, whatever the sampling.

   The report has two parts:
   - **Span:** a `CollectedTrace` on the same traceId, exported through `exportTrace`, holding one `groundedness` stage. The stage status is `ok`, `timeout`, `error` or `skipped`. Its attributes are the groundedness status, scorer, label, language, truncated and reason. There are no review or content fields. The span is skipped when the traceId is not a 32-hex OTel id.
   - **Scores:** a numeric `groundedness` score when a score exists, and always a categorical `groundedness_label` score, both with deterministic ids.

   Both parts are time-boxed (3 s by default). A failure writes one `[RAG Trace]` warn line, so the `[Groundedness]` line stays the only one for that answer.

The whole step is wrapped and never throws.

## Behaviour changes

- With `RAG_GROUNDEDNESS=true` and a pending record (a web-chat answer with the citations capability, a signed-in user, not a ghost chat, strict or balanced mode with knowledge-base context, no MCP tool result), the row moves from `pending` to `scored` or `not_checked` after the response.
- With the sidecar URL or secret unset, the row becomes `not_checked` / `scorer_unavailable`.
- With the switch off, or for any request that 05-13 does not persist, nothing changes: there is no pending row, so this code never runs.

## Tests that failed before the fix

- `tests/rag/trace-scores.test.ts`: 7 of 8 failed against the stub (deterministic id, POST shape, overwrite, 207, hang time box, HTTP error and transport failure, key never sent). The "skipped" case passed, because the stub skipped everything.
- `tests/rag/generation/answer-finish-groundedness.test.ts` (orchestrator): all 11 failed against the stub, which always returned pending.
- `tests/rag/generation/answer-finish-groundedness.test.ts` (step): all 11 failed against a no-op step. The cases were insert, score and update; sidecar timeout; one log line without text; update failure; scoring failure; sampled span and scores; unsampled and verified; possibly_unreliable unsampled; label-only score; Langfuse failure; Langfuse hang. The "insert not created" case passed, since nothing ran either way.
- `tests/rag/generation/answer-finish-groundedness-route.test.ts`: failed at `sidecarRequests` 0 vs 1. That run shows the SSE body (with `[DONE]`) completed with no sidecar request and no row; after the scheduled tasks run, the sidecar got one request and the row reads `not_checked` / `timeout`.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | 0 diagnostics |
| `npx vitest run` | 269 files, 4303 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1446 pass, 4 fail, 4 skipped (all pre-existing, below) |
| check-rag-boundary and its node test | ok (1175 files); 38 pass |
| `node scripts/check-config.mjs` | ok, 135 variables |
| check-workflows.py | OK |
| Python suites, `gen:schemas`, `test-rag` | not required: no Python, contract, retrieval, ingest or golden-set change |

### Pre-existing failures

- `tests/rag-db/ingest-mode-routing.test.mts`: 4 subtests fail. The sidecar worker cannot download `cl100k_base.tiktoken` from `openaipublic.blob.core.windows.net` (`SSLError ... CERTIFICATE_VERIFY_FAILED`). This is the known cold-cache failure, and this plan does not touch that code.
- The 4 skips are the known `ingestion-ledger-pg` root skip.

## Deviations

1. **Extra test file** `tests/rag/generation/answer-finish-groundedness-route.test.ts`. The route-level "stream finishes before the sidecar" case needs file-level module mocks (OpenRouter, the after() scheduler, the store, the sidecar URL). Those would have changed the unit cases in the planned file, so the route case got its own file.
2. **`src/lib/rag/trace/langfuse.ts` changed** (not in the plan's file list). `CollectedTrace.stages` now accepts `TraceStage`, a `StageRecord` with optional scalar `attributes`, which are spread into the span metadata before the core stage fields. Without this, the span could not carry scorer and label. No existing stage sets attributes, so other exports are unchanged.
3. **Languages other than en and zh-Hans send no request.** The plan named only zh-Hant. D-11 routes only en and zh-Hans to a scorer, so sending Italian, ambiguous Chinese or unknown answers would move answer text to the sidecar just to get `unsupported_language` back. `SCORABLE_LANGUAGES` holds the two scorable languages.
4. **`buildPremise` accepts `Pick<AliasedBlock, 'alias' | 'text'>` blocks.** This widens the type without changing behaviour. The answer-finish premise carries only alias and text.
5. **Review-sampled traces also get the span and scores.** Langfuse already holds those traces (finishTrace exports on either sample).
6. **The scores client treats HTTP 200 as accepted**, as well as 202.
7. **The step-test span assertions JSON-decode the metadata values.** Langfuse serialises observation metadata values as JSON strings. The decoding was added to the test in the GREEN commit; the assertions are the same as in the RED commit.
8. No migration, env variable, contract, package or UI change.

## Decisions for STATE

- Groundedness scoring runs in the `onPending` hook after the pending insert, in the same `after()` task.
- Only en and zh-Hans are sent to the sidecar.
- Langfuse reporting needs a trace or review sample, or a `possibly_unreliable` label. The span is the `groundedness` stage on the request's traceId. The scores are `groundedness` (NUMERIC, only with a score) and `groundedness_label` (CATEGORICAL), with ids sha256(`traceId|name`).
- The log contract is one `[Groundedness]` line per result, with the fields answerId, status, scorer, label, language, truncated and latencyMs. Langfuse failures log under `[RAG Trace]`.
- `postLangfuseScores` is the TypeScript scores client, and 05-21 reuses it for feedback scores.

## Operator actions

None. `RAG_GROUNDEDNESS` stays off by default. Scoring needs `RAG_SIDECAR_URL` and `RAG_SIDECAR_SECRET`, plus a sidecar with a scorer (05-10/05-11 for HHEM).

## Deferred

- The `groundedness_flagged` review reason and the review export on a `possibly_unreliable` label: 05-21, which extends this step.
- The eval endpoint's use of `scoreAnswerGroundedness`: 05-22.
- Live checks (research A7): that Langfuse accepts `CATEGORICAL` for `groundedness_label`, and how it shows a second root observation on an already exported trace: 05-26.

## Design skills

Not applicable: no UI file touched.

## Self-Check: PASSED
