---
phase: 05-verified-citations-groundedness
plan: 16
subsystem: api
tags: [citations, anthropic, claude, fallback, chat-route, streaming]

requires:
  - phase: 05-verified-citations-groundedness
    provides: "anthropicIdFor and the 5.5 model map (05-10); claude.ts, claude-transform.ts, fake-anthropic and the SSE fixtures (05-11); answerId wiring and the last route.ts edit (05-13); session, strategy and the alias path (05-08)"
provides:
  - "claudeTurnEligibility and preRetrievalCitations; selectCitationStrategy now picks claude-citations, chunk-alias or none in one place"
  - "CLAUDE_WEB_SEARCH_ELIGIBLE = false (opened only by the 05-26 live spike)"
  - "firstTokenGate, errorStatusOf, fallbackReasonFor, CLAUDE_FIRST_TOKEN_TIMEOUT_MS (8000)"
  - "CitationSession: facts input, claudeSystemPrompt, startClaude, fallback, fallbackReason"
  - "Chat route: direct Claude Citations stream through the gate, one OpenRouter chunk-alias retry, citation_strategy_fallback:<reason> on the generation stage"
affects: [05-22, 05-25, 05-26]

actuals:
  tasks: 3
  commits: 9

tech-stack:
  added: []
  patterns:
    - "OpenRouter streamText built lazily (startOpenRouterStream) so a direct turn never opens it unless it falls back"
    - "Route test against a node:http fake Anthropic server set as ANTHROPIC_BASE_URL, with the real @ai-sdk/anthropic provider"

key-files:
  created:
    - src/lib/rag/generation/citations/fallback.ts
    - tests/rag/citations/strategy.test.ts
    - tests/rag/citations/fallback.test.ts
    - tests/rag/citations/chat-claude-route.test.ts
  modified:
    - src/lib/rag/generation/citations/strategy.ts
    - src/lib/rag/generation/citations/session.ts
    - src/lib/rag/generation/citations/claude.ts
    - src/lib/rag/index.ts
    - src/app/api/chat/route.ts
    - tests/rag/citations/session.test.ts

requirements-completed: [GEN-01, GEN-04, GEN-07]

duration: ~2h
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 16: Claude Citations as a live strategy

**With `RAG_CLAUDE_CITATIONS=true`, an `ANTHROPIC_API_KEY` and a mapped Claude model, an eligible web-chat turn now answers through the direct Anthropic Citations call. The answer streams with `[S<k>]` markers and `claude-citations` records. If that call fails before its first text (HTTP 400, 401, 404, 429, 5xx, a stream error, a refusal or 8 s of silence), the turn retries once on OpenRouter with chunk aliases, and the generation trace stage records `citation_strategy_fallback:<reason>`. With the switch off nothing changes.**

## Commits

| Task | RED | GREEN |
|------|-----|-------|
| 1. Eligibility and strategy selection (D-01, D-10) | `d64c18a`: 14 of 26 cases failed on assertions against stubs | `d9ede6b` |
| 1b. Image parts make the turn ineligible (deviation 1) | — | `e4d20ea` (test case added with it) |
| 2. First-token gate (D-10) | `fc55fb3`: 14 of 19 cases failed on assertions against a pass-through stub | `f104399` |
| 3. Session and route wiring (D-06, D-09, D-10) | `dd299c0`: 9 of 16 route cases failed on assertions (no request reached the fake Anthropic server) | `7fe48a6` |
| 3b. Session unit tests for the Claude turn | — | `2bb8350` |

## What it does

### Eligibility (`strategy.ts`)

`claudeTurnEligibility` returns `{eligible: true, anthropicId}` only when every condition holds. Otherwise it returns the first failing reason, checked in this order:

1. `switch_off`: `RAG_CLAUDE_CITATIONS` is not `true`.
2. `no_api_key`: `ANTHROPIC_API_KEY` is empty.
3. `no_anthropic_id`: the model has no `anthropicId` (`anthropicIdFor`).
4. `no_capability`: the body has no `capabilities.citations: true` (web chat only).
5. `no_knowledge_context`: no aliased block, or bypass mode.
6. `mcp`: MCP tools are attached to this request, or the latest assistant turn carries a tool call (it may await approval).
7. `multi_step`: the query is multi-step.
8. `web_search`: webSearch is on. `CLAUDE_WEB_SEARCH_ELIGIBLE` is a committed `false` until the 05-26 live spike.
9. `attachments`: the question carries image parts (deviation 1).
10. `reasoning_unsupported`: reasoning is requested and the model is not an adaptive-thinking model.

`selectCitationStrategy` stays the only decision point. An eligible turn gets `claude-citations`, whatever `RAG_CITATIONS` says. An ineligible turn gets `chunk-alias` when `RAG_CITATIONS` is on, and `null` otherwise. Without turn facts it never picks `claude-citations`.

`preRetrievalCitations` decides whether the labeler runs. It is true when `RAG_CITATIONS` is on, or when the Claude conditions known before retrieval hold. The route passes the full facts, so a turn that cannot use either strategy keeps today's unlabelled context.

### First-token gate (`fallback.ts`)

`firstTokenGate(uiStream, {timeoutMs, errorStatus, abort})` buffers UI parts until the first `text-delta`. It then replays the buffer and pipes the rest unchanged; a later error is forwarded. It returns a fallback instead when it sees:
- an `error` part: the reason comes from the status the caller captured in `onError`;
- a `finish` whose reason is `content-filter` (Anthropic `refusal`): reason `refusal`;
- no first token within the timeout: reason `timeout`. The first reasoning delta also stops the timer, so a long adaptive-thinking phase does not count as silence.

On a fallback it aborts the direct call and cancels the reader. Status mapping: 400, 401, 404 and 429 have their own reasons, 500 to 599 give `status_5xx`, anything else gives `error`.

### Session (`session.ts`)

- `facts` input; the labeler follows `preRetrievalCitations`.
- `claudeSystemPrompt(base)`: `createEnhancedRAGPrompt(base, <attached-documents sentence + image-caption block texts + links section>, ragMode)`. The block text never enters the system text.
- `startClaude({...})`: builds the provider with the configured base URL and calls `startClaudeCitationStream` (history without markers, documents in AliasMap order, `maxRetries 0`).
- `fallback(reason)`: switches once to `chunk-alias` with a fresh parser and clears any result the direct stream had produced.
- `decorateSystemPrompt` also decorates on a Claude turn, because that OpenRouter prompt is only ever used as the fallback.
- `finishMetadata` and `fullRecords` read the direct stream's records; metadata quotes are capped as on the alias path.

### Route (`src/app/api/chat/route.ts`)

- The facts are computed before the session is created: `useMcpForRequest` or a tool call in the last assistant message, `isHandlingMultiStep`, `webSearchEnabled`, a reasoning request (global switch plus enabled, effort or token setting), and `hasAttachedImage`.
- On a Claude turn the direct call's system text is the Claude prompt plus the formatting and call-to-action instructions. The tool, Gmail and media instructions are left out, because the direct call has no tools.
- The OpenRouter `streamText` is now created by `startOpenRouterStream()`. On every other turn it is called at the same point as before. On a Claude turn it is called only after a fallback, with the alias transforms.
- The direct stream starts with `AbortSignal.any([req.signal, gate controller])`, and its errors are captured for the status. Inside `createUIMessageStream`:
  - `source_images` and `metadata` are written first, as before;
  - the direct UI stream goes through the gate;
  - on `ok` it is merged;
  - on a fallback the session switches, one warn line `[Citations] ...` records the reason, and the OpenRouter stream is merged instead.
- `start` metadata is sent once in both cases, because the gate discards the direct stream's buffered `start`.
- After streaming starts, an error on the direct path reaches the client in-band as a fixed message: "The answer was interrupted by an error. Please try again." Provider text never reaches the client.
- The `generation` stage gets `rules: ['citation_strategy_fallback:<reason>']` only when a fallback happened.
- The direct path also sets the trace review content.

## Behaviour changes

- None with `RAG_CLAUDE_CITATIONS` off (the default). The route test checks that `false` and unset give the same OpenRouter prompt and the same SSE body. The characterization, strict, webSearch, source_images and tool-parts route suites pass unchanged.
- With the switch on and the conditions met (web chat with `capabilities.citations`, a key, a mapped 5.5 model, knowledge-base blocks, no MCP or tool call pending, not multi-step, not webSearch, no image in the question, reasoning only on adaptive models), the answer comes from Anthropic directly.
- With the switch on, `RAG_CITATIONS` off and the Claude conditions met before retrieval, the context blocks are labelled. That labelled context is used only by the fallback.

## Tests that failed before the fix

- `tests/rag/citations/strategy.test.ts`: 14 of 26 cases failed. The stub always said `switch_off`, `preRetrievalCitations` returned false, and `selectCitationStrategy` never chose `claude-citations`.
- `tests/rag/citations/fallback.test.ts`: 14 of 19 cases failed. The stub passed every stream through, so no error, refusal or timeout fell back, and no status was mapped.
- `tests/rag/citations/chat-claude-route.test.ts`: 9 of 16 cases failed. The fake Anthropic server received no request. The fallback cases saw no chunk-alias records and no trace rule, and the post-start error case saw no direct stream. The 7 ineligible-turn and byte-identity cases passed from the start; they guard today's behaviour.
- During GREEN, the refusal case caught a real bug: the gate had already asked the session for the direct stream's (empty) finish metadata, so the fallback answer lost its chunk-alias records. `fallback()` now clears that cached result.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no diagnostics |
| `npx vitest run` | 294 files, 4680 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 172 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1457 pass, 0 fail, 4 skipped (the known ingestion-ledger-pg root skip; tiktoken cache filled first with `scripts/ci/fill-tiktoken-cache.py`) |
| check-rag-boundary + its node test | ok (1231 files); 38 pass |
| `node scripts/check-config.mjs` | ok, 144 variables |
| check-workflows.py | OK |
| `npm run test-rag -- --out eval/out/05-16` | gate PASS (7 skipped) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/05-16-ingest` | gate PASS (7 skipped) |
| Plan verification set (`tests/rag/citations`, chat-strict, chat-websearch, chat-source-images, chat-tool-parts, characterize-chat) | 17 files, 161 passed (before the session unit tests were added) |
| Python suites, gen:schemas, frontend summary | not required: no Python, contract or UI change |

## Deviations

1. **A tenth condition, `attachments`.** `buildClaudeCitationRequest` sends the question as text only, so a question with an image would lose the image on the direct path. Such turns stay on OpenRouter.
2. **"Awaiting approval" is read from the request.** The global approval state is not keyed by chat, so the route treats a tool call in the latest assistant message as possibly pending. It also treats MCP tools attached to the request (`useMcpForRequest`) as planned. Both are conservative and only send more turns to OpenRouter.
3. **The timer stops at the first reasoning delta as well as the first text delta.** The decision still waits for the first text delta. This keeps adaptive thinking from being cut off at 8 s.
4. **The direct path's in-band error after start uses a fixed message.** Today's OpenRouter path is unchanged. On the direct path, provider error text never reaches the client (T-05-49).
5. **The MCP case in the route test uses a pending tool call in history.** Enabling MCP tools in the fixture needs a verified admin and an MCP endpoint. The `mcp` reason from `useMcpForRequest` is covered by the eligibility unit tests.
6. **`startClaudeCitationStream` gained an optional `onError`,** so the route can read the HTTP status for the reason (`claude.ts`, not in the plan's file list).
7. **The image case in the route test** appends an image block and a source image to the real retrieval result with `vi.doMock`. The fixture corpus has no question that retrieves both an image and text blocks.
8. No migration, env variable, contract, package or UI change.

## Decisions for STATE

- `selectCitationStrategy` is the single decision point. A Claude turn's OpenRouter prompt is built as the chunk-alias fallback prompt (labelled context plus the alias instruction), even when `RAG_CITATIONS` is off.
- Fallback reasons: `status_400`, `status_401`, `status_404`, `status_429`, `status_5xx`, `error`, `refusal`, `timeout`. The trace rule is `citation_strategy_fallback:<reason>` on the `generation` stage.
- webSearch turns, image turns, multi-step turns and turns with MCP tools or a pending tool call stay off the direct path.
- The direct call's system text is the RAG prompt with the D-09 replacement, plus the formatting and call-to-action instructions, and no tool instructions.

## Operator actions

- None needed to keep today's behaviour; `RAG_CLAUDE_CITATIONS` stays off.
- Before turning it on: the 05-26 live checks against the real API (`GET /v1/models` for the 5.5 ids, a real citations stream, the 8 s first-token budget under real latency).

## Deferred

- Opening webSearch turns on the direct path (05-26 spike, then flip `CLAUDE_WEB_SEARCH_ELIGIBLE` with a recorded test).
- Images in the direct request (an image part next to the documents).
- Citations in the embed widget (CONTEXT deferred list).

## Design skills

Not applicable: no UI file touched.

## Self-Check: PASSED
