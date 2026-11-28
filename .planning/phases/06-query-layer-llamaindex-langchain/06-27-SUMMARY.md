---
phase: 06-query-layer-llamaindex-langchain
plan: 27
subsystem: rag-query
tags: [query-layer, chat-route, embed-route, history-window, small-talk, time-zone, classifier]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-13 RunRetrievalInput.history / classification / timeZone and QueryPlan; 06-19 small-talk short-circuit (ok / small_talk) and router"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-21 last Phase 4 edit of both routes; 04-33 last index.ts edit"
  - phase: 05-verified-citations-groundedness
    provides: "05-16 last Phase 5 edit of the chat route; 05-21 last index.ts edit"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-15 last Phase 5.1 edit of the chat route"
provides:
  - "buildHistoryWindow(messages, { turns: 6, chars: 1000 }) (src/lib/rag/query/history.ts), exported from @/lib/rag"
  - "isQueryLayerEnabled() (src/lib/rag/v2/switch.ts) and isSmallTalkResult(result) (src/lib/rag/v2/result.ts), exported from @/lib/rag"
  - "Chat route passes its one classifyQuery result, the history window and the body timeZone into both runRetrieval calls; small talk skips the strict refusal and gets the bypass-style prompt"
  - "Embed route: optional timeZone (≤ 64 chars, structured 400 otherwise) and one classifyQuery call, both only while the layer is on; same small-talk prompt rule"
affects: [06-28, 06-32, 06-33, 06-36, 06-44]

actuals:
  tokens: 60000
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "Route tests that vary rag env per test re-register the @/lib/rag spy with vi.doMock after vi.resetModules: a vi.mock factory result survives resetModules and would pin the first test's deps instance"

key-files:
  created:
    - src/lib/rag/query/history.ts
    - tests/rag/query/history.test.ts
    - tests/rag/chat-query-layer.test.ts
    - tests/rag/embed-query-layer.test.ts
  modified:
    - src/lib/rag/index.ts
    - src/lib/rag/v2/switch.ts
    - src/lib/rag/v2/result.ts
    - src/app/api/chat/route.ts
    - src/app/api/embed/chat/route.ts

key-decisions:
  - "History = the last 6 user/assistant turns before the last user message (anything after it is dropped too), oldest first, each cut to 1,000 code points (Array.from, so never a lone surrogate). Text comes from string content, serialized __content_parts__, content part arrays or UI `parts`; only `text` parts count (tool, source_images, thinking and media parts are dropped). Assistant turns lose everything from a sources heading (Sources/References/Citations/来源/參考資料/Fonti/Riferimenti, with or without markdown heading or bold, ending in a colon or the line), citation markers ([S3], [S3, S5], [S1][S2], 【S2】) and markdown images. Turns empty after stripping are skipped"
  - "Chat passes history, classification and timeZone on every request (pipeline ignores them with the layer off); timeZone is taken from the top-level body field only when it is a string of ≤ 64 characters, otherwise dropped (no 400 in chat, invalid zones resolve to UTC in dates.ts)"
  - "Small talk is detected with isSmallTalkResult: status ok, reason small_talk and queryPlan.gate.skip_retrieval true. The chat route then keeps the context empty (no 'No relevant context found.' fallback), skips the strict block, attaches no citation result and builds the prompt with createEnhancedRAGPrompt(prompt, '', 'bypass')"
  - "Embed reads, validates and passes the layer inputs only when isQueryLayerEnabled() (RAG_QUERY_LAYER=true under v2): with the layer off the body, the classifier and the runRetrieval input are exactly as before, including an oversized timeZone, which is ignored as today. With the layer on, a non-string or > 64-character timeZone returns the retrievalFilters-style 400 { success: false, error: 'Invalid request data', details: [{ path: 'timeZone', message }] }"
  - "Layer-on gating uses loadRagConfig(...).queryLayer.enabled rather than the raw env string, so RAG_QUERY_LAYER=true under legacy (where the layer stays off) does not call the classifier in embed"

requirements-completed: [QRY-01, QRY-05, LAT-03]

coverage:
  - id: D1
    description: "History window: last 6 of 10 turns, custom limits, 1,000-character surrogate-safe cut, citation/sources/source_images/markdown image stripping, serialized and UI parts, system/tool/data dropped, empty input, trailing messages after the current one"
    requirement: QRY-01
    verification:
      - kind: unit
        ref: "tests/rag/query/history.test.ts (9 pass)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Chat: one classifyQuery call whose result object reaches runRetrieval with the history window and timeZone; invalid zone passed through (UTC in dates.ts); oversized/non-string zone dropped; layer-on small talk streams a model answer with no knowledge-base context; layer-off small talk keeps the strict refusal; layer-off input equals today's apart from the new fields"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "tests/rag/chat-query-layer.test.ts (6 pass)"
        status: pass
      - kind: unit
        ref: "characterize-chat, characterize-chat-overview, chat-strict, chat-websearch, chat-source-images (unchanged, pass)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Embed: layer on classifies once and passes the three inputs; small talk answered without context; timeZone > 64 chars or non-string → structured 400, 64 accepted; layer off: no classifier call and today's runRetrieval input"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "tests/rag/embed-query-layer.test.ts (4 pass)"
        status: pass
      - kind: unit
        ref: "characterize-embed, embed-route, embed-scope, embed-widget-error (unchanged, pass)"
        status: pass
    human_judgment: false

duration: 90min
completed: 2026-11-25
status: complete
---

# Phase 6 Plan 27: Chat and embed query-layer inputs Summary

**Chat and embed now give the query layer what it needs: the request's one classification, a bounded history window with the markup stripped, and the client time zone. With the layer on, small talk gets a normal conversational answer: no strict refusal and no knowledge-base context. With the layer off, both routes behave exactly as before.**

## Commits

| Task | Commits |
|------|---------|
| 1 History window | `d30b6eb` test (RED), `654db37` feat |
| 2 Chat route inputs and small talk | `97ea635` test (RED), `95d5d45` feat |
| 3 Embed route inputs | `6796d1d` test (RED), `790c2ff` feat |

## Behaviour changes

All of them only apply with `RAG_QUERY_LAYER=true` under `RAG_PIPELINE=v2`:
- Condense now gets the real conversation from chat and embed. Before this plan the routes sent no history, so condense never ran in production.
- R2 relative dates use the client's `timeZone` from the request body when one is sent. No client sends it yet, so UTC remains the effective zone.
- R12 small talk ("你好", "thanks" and similar) in strict mode is answered by the model with the bypass-style prompt. Before this plan the pipeline returned `ok`/`small_talk` with no context, and the chat route still fell through to the "No relevant context found." prompt.
- Embed: a `timeZone` longer than 64 characters, or one that is not a string, returns a structured 400.

With the layer off nothing changes. Embed does not call the classifier and ignores `timeZone`. In chat, `runRetrieval` gets three extra optional fields that the pipeline ignores.

## RED evidence
- history.test.ts: 8 of 9 failed on assertions against a stub that returned `[]`.
- chat-query-layer.test.ts: 3 of 6 failed on assertions: classification undefined, timeZone undefined, and the small-talk system prompt contained "Context from knowledge base".
- embed-query-layer.test.ts: 3 of 4 failed on assertions: the classifier was not called, the prompt ended in "Context:", and a long zone returned 200 instead of 400.

## Gate results

All passed on the final tree:
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 391 files, 6518 passed, 4 skipped
- `node --import tsx --test tests/*.test.mts`: 172 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 1964 pass, 0 fail
- `check-rag-boundary.mjs` and its node self-tests: pass
- `node scripts/check-config.mjs`: pass
- `check-workflows.py`: pass
- `npm run test-rag -- --out eval/out/06-27`: gate PASS (7 skipped)
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-27-ingest`: gate PASS (7 skipped)
- No Python, contracts or UI were touched, so the sidecar/eval pytest, `gen:schemas` and frontend-design gates do not apply.

## Deviations
1. **Two helpers outside the plan's file list.** `isQueryLayerEnabled` went into `src/lib/rag/v2/switch.ts` (next to `isV2Pipeline`) and `isSmallTalkResult` into `src/lib/rag/v2/result.ts` (next to `buildSmallTalkResult`). The routes need both, and keeping them in `src/lib/rag` keeps them under the boundary rule.
2. **Embed `timeZone` validation runs only while the layer is on**, instead of in the shared body schema. A schema field would turn an oversized or non-string `timeZone` into a ZodError with the layer off, which changes today's behaviour. The 400 uses the existing retrievalFilters error shape, not the widget's legacy 200 error text.
3. **The small-talk test checks for search RPCs, not for zero RPCs.** `verifyV2Startup` in the test setup calls `rag_chunking_coverage` through the same fake.
4. **Test harness:** the `@/lib/rag` spy is registered with `vi.doMock` inside `loadRoute`, because a `vi.mock` factory result survives `vi.resetModules`. The first version of the test ran later cases on the first case's deps and failed with "unminted scope".

## Threats
- T-06-58: the history is capped at 6 turns of 1,000 characters each, with assistant markup stripped. Condense (06-13) renders it as an escaped data block.
- T-06-59: the history caps apply. Embed rejects a zone over 64 characters; chat drops it. An unknown zone resolves to UTC.
- T-06-60: small talk skips retrieval and the route attaches no citation result, so the prompt holds no document text.

## Operator actions
None. No client sends `timeZone` yet; a widget or app change that sends `Intl.DateTimeFormat().resolvedOptions().timeZone` is left to a later plan.

## Deferred
- Cache-hit streaming in these routes is plan 06-36; the answer-language instruction is plan 06-33.
- Pre-existing lint errors in files this plan touched were left alone: the unused `e` and `request` in the embed route, and the unused `params` in `v2/result.ts`.
