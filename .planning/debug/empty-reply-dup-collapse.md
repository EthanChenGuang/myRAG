---
status: resolved
branch: fix/empty-reply-dup-collapse
trigger: "Owner walkthrough (eval project): questions answered by a passage copied into several documents return an empty assistant message (4/4, 3 phrasings)"
switches: RAG_PIPELINE=v2, RAG_LEXICAL_SEARCH, RAG_VERSION_SCOPE, RAG_DUP_CLUSTERS, RAG_RESULT_DIVERSITY=collapse, RAG_INGEST_PIPELINE=unified, RAG_CITATIONS=true; model anthropic/claude-sonnet-4.5 via OpenRouter
---

# Empty reply on duplicated passages (collapse + alsoIn + citations)

## Symptom

Retrieval fine (top 0.71, refusal `answer`), `diversify collapsed=2`, `assemble also_in_sources=3`, generation `ok` after about
1.1 s with `ttft_ms` null, `Text response:` empty, no error. The UI showed an avatar with no text and no notice.

## Investigation

1. **Reproduction** (`tests/rag/chat/dup-collapse-empty-reply.test.ts`): route fixture (PGlite + fake edge), four documents
   carrying the same synthetic passage, clustered with `clusterChunks`, the reported switches on, `capabilities.citations`,
   model id `anthropic/claude-sonnet-4.5`, a mock OpenRouter provider. The trace matches the walkthrough
   (`diversify collapsed=3`, `assemble also_in_sources=4`, refusal `answer`).
2. **The collapse / alsoIn / citations path is valid.** The prompt the model receives holds the passage exactly once as
   `[S1] manual-copy-0.md`, aliases run S1..Sn, the question is last, and no `alsoIn` or cluster data reaches the prompt
   (`alsoIn` only feeds `usedDocuments`, the citation record and the sources panel). With a normal reply (`... [S1].`) the
   finish metadata carries one valid `CitationRecord` whose `alsoIn` lists the 3 dropped copies. This test passes on the old
   code too, so the context and citation blocks are not malformed.
3. **Claude Citations is not in play.** `RAG_CLAUDE_CITATIONS` was not on, so the strategy is `chunk-alias`; no Anthropic
   document blocks are built and nothing can be rejected by the Citations API. `anthropic/claude-sonnet-4.5` also matches
   `modelBlocksTools`, so tools are removed and the turn is a single step: no tool call can explain the missing text.
4. **The transforms are pass-through.** `aliasParserTransform` forwards every part (errors in the parser are caught and only
   mark citations failed); with every Phase 5.2 switch off `answerTurn.transforms` returns the citation transform alone. So an
   empty step text means the provider stream itself carried no text delta.
5. **Where it went wrong in our code (root cause).** Neither the chat route nor the embed route checks the outcome of a
   finished generation. A provider stream that ends with zero text deltas and no tool call (OpenRouter maps an upstream
   refusal or content filter to `content-filter` / `unknown`, an empty completion to `stop`) is treated as success:
   `generation` is recorded `ok`, the UI message stream carries `start`, `finish` and nothing else, the finish reason is
   recorded nowhere, no error part is written, and the client persists and renders an empty assistant bubble. That is exactly
   the logged signature (ok, ttft null, empty text, no error). Feeding the route a zero-delta provider stream reproduces it
   (3 tests fail on the old code, see below).
6. **What the logs cannot tell.** Why Sonnet 4.5 returns no text for that passage is provider-side and was not observable,
   because the route dropped the finish reason. A 1.1 s zero-token finish is consistent with an upstream refusal / content
   filter on the passage text, not with a token-budget or reasoning exhaustion. The fix now logs the finish reason
   (`[Chat] Model reply was empty`) and records it in the generation span (`empty_reply:<finishReason>`), so the next
   walkthrough pins it (operator action below). Hypotheses ruled out: duplicate document blocks, empty source blocks, a
   rejected Citations request, a tool call, a swallowed transform error.

## Fix

- `src/lib/chat/empty-reply.ts` `guardEmptyReply`: wraps the answer's UI message stream. A stream with any non-empty text
  delta, any `tool-*` part, an `error` or an `abort` passes through chunk for chunk. A stream that reaches `finish` without
  any of those gets one `{ type: 'error', errorText }` part (the same part `formatErrorSSE` emits, now shared as
  `errorStreamPart` in `src/lib/error-stream.ts`) before its `finish`, and one `[Chat] Model reply was empty; streaming the
  empty-reply notice:` warning with route, model id and finish reason (no text).
- Chat route: both answer streams (OpenRouter and the direct Claude stream after the first-token gate) go through the guard;
  an empty reply adds the rule `empty_reply:<finishReason>` to the `generation` span and sets the retrieval-log outcome like
  a failed generation.
- Embed route: the answer stream goes through the same guard (the embed had the same gap).
- Localized text: `emptyReplyText(turn, legacyLanguage)` in `src/lib/rag/generation/messages.ts` (en, zh, it, es; registry
  answer language when `RAG_REGISTRY_TEXTS` serves, else the UI language; chat uses the route's `fallbackLanguage`, embed the
  Accept-Language), exported from `@/lib/rag`.
- Client: the main page already renders `error` parts as `⚠️ <text>`; when a finished assistant message is still blank (an
  older server, or an empty persisted message) the page substitutes `⚠️ ` + the new `emptyReply` UI string (all 18
  translation files), and blank finished assistant messages already saved in a chat are not drawn
  (`src/lib/chat/blank-message.ts`, used by `src/app/page.tsx` and `src/components/ui/shared-chat-layout.tsx`). The thinking
  and streaming placeholders are never filtered.

## Behaviour changes

- Every answer with text or a tool call: unchanged, byte for byte (the guard forwards the same chunks; the 127 related test
  files, the chat and embed characterization snapshots among them, pass unchanged). With every switch off nothing else
  changes.
- An answer that finishes empty (any switch state): now an error notice in the UI language plus a `[Chat]` warning, instead
  of a blank bubble and silence. This is the requested fallback; it is not behind a switch because the previous behaviour was
  the bug.

## Tests that failed before the fix

`tests/rag/chat/dup-collapse-empty-reply.test.ts` on the old `src/`: 3 failed, 1 passed.

- `an empty provider reply streams the localized empty-reply error before the finish part and logs [Chat]` — failed
- `the empty-reply notice follows the UI language` — failed
- `embed chat: an empty provider reply streams the empty-reply error; a normal reply is unchanged` — failed
- `collapses the copies into one cited block whose citation lists the dropped copies as alsoIn` — passed (proves the
  collapse/alsoIn/citations assembly was valid)

`tests/rag/chat/empty-reply-guard.test.ts` (new): pass-through identity, tool calls, no double error after error/abort,
empty / empty-delta / reasoning-only streams, blank-message helper.

## Question 4: no sources-panel entry for document-only answers when citations are off

Finding: **a gap, not a design decision of 04.2-26.**

- `SourcesButtonContainer` in `src/components/ui/chat-message.tsx` (about line 6085) shows "Show sources" only for web-search
  or non-image tool sources (`shouldShow = hasWebSearchSources || hasRelevantToolSources`, comment "Do NOT show for
  document/RAG sources"). The rule predates Phase 4.2 (it arrived with the trunk merges, not with 04.2-26).
- 04.2-UI-SPEC Addendum A and 04.2-26-PLAN only define what the panel's two document entry kinds render (version tag,
  "Also in N other documents"); neither says how the panel is opened. A.0 lists the files read (`chat-message.tsx` only for
  `extractDocumentSources`), and the panel entry point is never discussed or excluded.
- The plan's own human check (04.2-26 Task 3, how-to-verify) says "Ask a question answered by the pasted passage; open the
  also-in line" after "open Sources", which assumes an entry exists. With `RAG_CITATIONS` off a document-only answer has no
  citation chips, so the listed source cards with their also-in and version lines are unreachable: RET-11/RET-13 render code
  that a user cannot open.

Fix proposal (not implemented here):

- In `SourcesButtonContainer`, also show the button when the message has document sources **and** no citation chips render
  for it (citations off, or zero valid citations), restricted to document sources that carry a 04.2 field (`alsoIn`,
  `version`/`isCurrent`), so the switches-off markup stays byte-identical (UI-SPEC A.6).
- Copy: reuse the existing Sources button strings; no new layout.
- Tests: `tests/ui/` render test with citations off and a document source with `alsoIn` (button present, opens the panel to
  the listed card with the also-in line), and one without the fields (markup equal to today's snapshot).
- Route through `/gsd-ui-phase` addendum (A.12 "panel entry for document-only answers") before implementation, per the
  frontend pipeline.

## Gates run

| Gate | Result |
| --- | --- |
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no Phase 1 type errors |
| `node scripts/ci/check-rag-boundary.mjs` | ok |
| `node scripts/check-config.mjs` | ok (273 variables; no new env variable) |
| `node scripts/ci/check-language-literals.mjs` | ok |
| `node scripts/ci/check-settings-classification.mjs` | ok |
| `npx vitest run` on 127 files (every test importing the chat or embed route, error-stream, generation/messages, translations, shared-chat-layout; `tests/rag/citations/*`; every diversity/assemble test; the 2 new files) | 127 files, 1873 passed, 5 skipped |
| `npm run test-rag -- --out eval/out/empty-reply` | exit 0, gate PASS (7 skipped). The report-only absolute gate prints `false_refusal_rate language:en 0.3143 > 0.25`; identical on trunk code (pre-existing, report-only, the eval route does not use the guard) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/empty-reply-ingest` | exit 0, absolute gate PASS (enforce), gate PASS (8 skipped) |
| `npx eslint --no-ignore` on the new and touched small files | 0 errors (warnings only in test signatures) |
| web-design-guidelines on the changed lines of `src/app/page.tsx`, `src/components/ui/shared-chat-layout.tsx` | no findings (the change implements "handle empty states"; the notice reuses the existing `⚠️ ` error display, no new markup) |

## Design skills

| Skill | Use | Result |
| --- | --- | --- |
| frontend-design | Not applied: no new interface; the client change removes a blank bubble and reuses the existing error text display | n/a |
| Impeccable | Not run: no new visual element | n/a |
| web-design-guidelines | Changed lines of `src/app/page.tsx` and `src/components/ui/shared-chat-layout.tsx` | pass, no findings |

## Operator actions

- Re-run the walkthrough question on the eval project and read the `[Chat] Model reply was empty` line or the generation
  span rule `empty_reply:<finishReason>`; if it reads `content-filter` / `unknown`, the passage trips the provider's
  refusal on `anthropic/claude-sonnet-4.5` (try the same question on another model or straight on Anthropic to confirm).

## Files

- `src/lib/chat/empty-reply.ts` (new), `src/lib/chat/blank-message.ts` (new)
- `src/lib/error-stream.ts`, `src/lib/rag/generation/messages.ts`, `src/lib/rag/index.ts`
- `src/app/api/chat/route.ts`, `src/app/api/embed/chat/route.ts`
- `src/app/page.tsx`, `src/components/ui/shared-chat-layout.tsx`, `src/translations/*.ts` (`emptyReply`)
- `tests/rag/chat/dup-collapse-empty-reply.test.ts`, `tests/rag/chat/empty-reply-guard.test.ts`
