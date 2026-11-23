---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 29
subsystem: api
tags: [typescript, ai-sdk-v6, chat-route, stream-chunks, type-errors]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: chat route on the unified `@/lib/rag` pipeline (02-14), chat-route test harness and characterization snapshots (02-01, 02-12), ragTraceId message metadata (02-23)
provides:
  - src/app/api/chat/route.ts with zero tsc errors
  - writeCustomChunk, the single typed writer for the legacy source_images and usedDocuments stream chunks
  - buildDocumentSources, the documentSources builder fed by matched_chunk
  - tests/chat-tool-parts.test.ts (10 tests) for the AI SDK v6 field-name fixes
affects: [02-30, 02-31]

requirements-completed: [PIPE-01]

actuals:
  tokens: 4500
  tasks: 2
  commits: 3
plan_head_before: b851be8724c60dcf6f97b4bb599e838805544c72
plan_head_after: 8563e8d5b1fa5a6740d38f2e53544669efbc3ccb

tech-stack:
  added: []
  patterns:
    - "Step-finish callbacks are typed with local StepToolCall / StepToolResult interfaces that match the v6 runtime step shape (input, output), not the prompt-level ToolCallPart / ToolResultPart"
    - "One `declare global` block types the mcpImageContext cache on globalThis"
    - "Tool arguments are logged as key names and byte size only"

key-files:
  created:
    - src/lib/ui-stream-chunks.ts
    - tests/chat-tool-parts.test.ts
  modified:
    - src/app/api/chat/route.ts
    - tests/chat-source-images.test.ts

key-decisions:
  - "The custom chunk helper casts once with `as unknown as UIMessageChunk`; the usedDocuments chunk keeps `type: 'metadata'` on the wire (that is the legacy type the frontend reads)"
  - "Reasoning from provider metadata is captured into globalThis.lastReasoningDetails as before; it is not delivered to the message, because the SDK ignores the metadata returned from the createUIMessageStream onFinish"
  - "Tool-call arguments, which were always undefined before, are logged as keys and size so user content cannot reach the logs once the field name is fixed"

patterns-established:
  - "Compare a v4-named read against node_modules/ai type definitions before renaming; the route's own ToolCallPart/ToolResultPart annotations described model messages, not step results"

coverage:
  - id: D1
    description: "Chat route has zero tsc errors (route.ts and the whole repo report 0 under the ratchet)"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "npx tsc --noEmit -p tsconfig.json: 0 errors in src/app/api/chat/route.ts; node scripts/ci/tsc-ratchet.mjs: ok, 0 error(s)"
        status: pass
  - id: D2
    description: "Streamed tool-call input reaches the approval state and the gmail draft-to-send intent analysis; tool arguments are not logged"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/chat-tool-parts.test.ts (stores the streamed tool-call input; redirects a draft call; keeps tool-call arguments out of the logs)"
        status: pass
  - id: D3
    description: "Tool-result output is cleared for approval-gated tools and kept for webSearch; the synthetic query_documents result carries documents and images in output"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/chat-tool-parts.test.ts, tests/chat-source-images.test.ts"
        status: pass
  - id: D4
    description: "Reasoning text and token count are read from providerMetadata.openrouter; nothing is captured when the provider returns none"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/chat-tool-parts.test.ts (two reasoning tests)"
        status: pass
  - id: D5
    description: "source_images and usedDocuments chunks are byte-identical on the wire and ordered before the first text delta; 144 characterization snapshots unchanged"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/chat-tool-parts.test.ts (wire test, asserted from the SSE text), tests/rag/characterize-chat.test.ts"
        status: pass
  - id: D6
    description: "documentSources text is the first 200 characters of matched_chunk plus an ellipsis, never the literal undefined"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/chat-tool-parts.test.ts (documentSources text, 2 tests)"
        status: pass
  - id: D7
    description: "Retrieval parity unchanged after the chat-route edits"
    requirement: PIPE-01
    verification:
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/chat-types; gate.json passed == true, paired.all_zero == true"
        status: pass

duration: 40min
completed: 2026-11-23
---

# Phase 2 Plan 29: Chat route type cleanup Summary

The chat route now type-checks with zero errors: mechanical errors are narrowed with unchanged fallbacks, AI SDK v4 field names are replaced by their v6 equivalents (each with a test), and the two legacy custom stream chunks go through one typed writer with an unchanged wire format.

## What was built

- **Task 1 (refactor, 9ac51f6).** `error instanceof Error` narrowing for the base64-conversion catch (TS18046), one `declare global` block typing `mcpImageContext` (TS7017), a guard for document parts that skips parts without a document id (TS2345, TS18048), `queryClassification.steps ?? []` in the multi-step prompt (TS18048) and a text-only query string for the MCP router call when the user content is an array of parts (TS2345).
- **Task 2 (TDD).**
  - RED df43501: `tests/chat-tool-parts.test.ts` plus a stub `src/lib/ui-stream-chunks.ts` carrying the legacy behaviour. 7 of 10 tests failed on assertions (approval params `undefined`, draft not redirected, output not cleared, `output` missing on the synthetic result, no reasoning captured, `'undefined...'` text). `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK` for the target test "stores the streamed tool-call input as the approval-state params". Semantic assessment: the target executed and failed on the planned assertion because the route read the removed field `args` and stored `undefined`; the other 6 failures are the same class. The remaining 3 tests (log guard, no-reasoning case, wire format) are regression guards that pass before and after by design.
  - GREEN 8563e8d: 10/10 pass. `src/lib/ui-stream-chunks.ts` exports `writeCustomChunk` (one cast, one comment) and `buildDocumentSources`; the route uses both. `onStepFinish` is typed with local `StepToolCall` / `StepToolResult` interfaces.
  - REFACTOR: none needed.

## Intended behaviour changes

| Change | Where | Test |
|---|---|---|
| `ToolCallPart.args` -> `input`: approval-state `toolCall.params` now holds the streamed arguments (it was `undefined`) | route `onStepFinish` approval tracking | `stores the streamed tool-call input as the approval-state params` |
| `input.instructions` feeds the gmail draft-to-send intent analysis (it always saw an empty string); a clear send intent now renames the stored call to `gmail_send_email` before approval | route `onStepFinish` redirection | `redirects a draft call to send when the call input shows clear send intent` |
| `ToolResultPart.result` -> `output`: results of approval-gated tools are cleared through `output`; the existing-result check reads `output`; the synthetic `query_documents` result carries `documents` and `images` in `output` | route `onStepFinish` | `clears the tool-result output of approval-gated tools and keeps allowed tools`, `reports the document sources in the synthetic query_documents result output`, `tests/chat-source-images.test.ts` |
| `experimental_providerMetadata` -> `providerMetadata`: reasoning content and token count from `openrouter` metadata are captured into `globalThis.lastReasoningDetails` (never before) | route `onFinish` | `captures reasoning text from provider metadata when the provider returns it`, `does not capture reasoning when provider metadata carries none` |
| documentSources `chunk_text` reads `matched_chunk` (the field did not exist, giving `'undefined...'`); an absent chunk now yields no `chunk_text` | `buildDocumentSources` | `documentSources text` (2 tests) |

Threat T-02-75 (mitigate): with the field names fixed, tool arguments and the gmail instruction text would have started flowing into logs. The route now logs only key names and byte size for arguments, logs the instruction length instead of the text, and no longer prints the whole approval-state entry (which holds the params). Covered by `keeps tool-call arguments out of the logs`. Threat T-02-76 (mitigate): the wire format is asserted byte for byte from the SSE text by `writes the source_images and usedDocuments chunks to the wire unchanged`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `tests/chat-source-images.test.ts` pinned the v4 `result` field**
- **Found during:** Task 2 GREEN
- **Issue:** The test read `documentSources.result.images` from the synthetic `query_documents` tool result; renaming the field to the v6 `output` broke that one assertion. The file was not in `files_modified`.
- **Fix:** the assertion reads `.output.images`.
- **Commit:** 8563e8d

**2. [Rule 3 - Blocking] Local step types instead of `ToolCallPart` / `ToolResultPart`**
- **Found during:** Task 2
- **Issue:** `ToolCallPart` / `ToolResultPart` are model-message parts (`output` is a `{type, value}` envelope). The route actually receives step results (`output` is the raw value), and pushes synthetic parts (`metadata`, `source_images`) into the array, which only compiled through `as any`.
- **Fix:** `StepToolCall` / `StepToolResult` interfaces in the route describe the step shape; the two `as any` casts on pushes are gone, no new `any`.
- **Commit:** 8563e8d

**3. [Rule 1 - Bug] MCP router query text did not use `normalize`**
- **Found during:** Task 1
- **Issue:** The plan suggested the existing `normalize` helper for the `string | ContentPart[]` argument, but it lowercases, which would change the query string the MCP router sees for ordinary string messages.
- **Fix:** string content is passed through unchanged; array content falls back to its text part (previously the array object itself was passed, a latent runtime bug).
- **Commit:** 9ac51f6

**4. [Rule 1 - Bug] Document parts without an id are skipped**
- **Found during:** Task 1
- **Issue:** the `documentParts` type requires `id: string`, but the code could push `undefined` (and threw on a part without `document`).
- **Fix:** parts without `document.id` are not added to `documentParts`; valid parts are unchanged.
- **Commit:** 9ac51f6

**5. [Process] Starting counts differed from the plan**
The plan's HEAD counts (16 and 35 errors) were taken at an older commit; at the base commit the route had 25 errors. After Task 1 the plan's mechanical categories were 0 and `declare global` count is 1; after Task 2 the route has 0 errors and `writeCustomChunk` appears 3 times (import and two calls).

### Environment notes

- The commit trailer uses the session attribution model name rather than the model name written in the plan.
- The RED evidence classifier rejects the tap reporter's multi-line assertion messages, so the target test uses single-line string assertions and the record was produced from `--reporter=tap-flat` with `-t` on the target test.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: dormant-code-activation | src/app/api/chat/route.ts | The gmail draft-to-send redirection now sees the real instruction text, so a high-confidence send intent renames the stored approval-state call to `gmail_send_email` while the already-emitted stream chunk still shows the draft tool. The call stays unapproved until the user approves it; the plan states this as the intended behaviour. Worth a product check that the approval UI shows the tool that will actually run. |
| threat_flag: process-global | src/app/api/chat/route.ts | `globalThis.lastReasoningDetails` is now actually written. It is process-wide, not per request, and is read only by the createUIMessageStream `onFinish`, whose returned metadata the SDK ignores, so nothing reaches a response. Do not start reading it for responses without making it per-request. |

## Known Stubs

None. Known limitation, not a stub: reasoning is captured but not delivered to the message metadata (see key decisions), and `metadata.documentSources` returned from the createUIMessageStream `onFinish` is likewise ignored by the SDK, so `buildDocumentSources` is tested directly and not from the stream.

## Verification

- `npx vitest run tests/chat-tool-parts.test.ts tests/chat-source-images.test.ts tests/chat-websearch.test.ts tests/chat-strict.test.ts tests/chat-messages-roundtrip.test.ts tests/rag/characterize-chat.test.ts tests/rag/chat-status.test.ts`: 7 files, 39 tests pass (10 in the new file).
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors in the chat route; `node scripts/ci/tsc-ratchet.mjs`: ok, 0 errors.
- `npm run test-rag -- --out eval/out/chat-types`: gate PASS, `passed == true`, `paired.all_zero == true`.

## Self-Check: PASSED

- FOUND: src/lib/ui-stream-chunks.ts
- FOUND: tests/chat-tool-parts.test.ts
- FOUND commits: 9ac51f6, df43501, 8563e8d (ancestors of HEAD)
