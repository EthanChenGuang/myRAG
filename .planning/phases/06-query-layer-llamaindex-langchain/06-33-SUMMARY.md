---
phase: 06-query-layer-llamaindex-langchain
plan: 33
subsystem: rag-generation
tags: [answer-language, cross-language, prompt, chat-route, embed-route, eval]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-19 queryPlan.language on the retrieval result; 06-27 last route edits"
  - phase: 05-verified-citations-groundedness
    provides: "05-08 decorateSystemPrompt (citation instruction after the prompt); 05-22 last edit of src/lib/rag-eval/answer.ts"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-15 last Phase 5.1 edit of the chat route"
provides:
  - "src/lib/rag/generation/answer-language.ts: answerLanguageInstruction, contextLanguages, appendAnswerLanguage, answerLanguageOptions (exported from @/lib/rag)"
  - "createEnhancedRAGPrompt(basePrompt, context, mode, options?) appends one localized line (zh/en/it) after the wrapper output when the asker's language differs from a context document's language"
  - "Chat, embed and the eval run route pass answerLanguageOptions(result), which is undefined unless the result has a query plan"
affects: [06-36, 06-44]

actuals:
  tokens: 70000
  tasks: 2
  commits: 6

key-files:
  created:
    - src/lib/rag/generation/answer-language.ts
    - tests/rag/prompt-answer-language.test.ts
    - tests/rag/answer-language-routes.test.ts
  modified:
    - src/lib/rag/generation/prompt.ts
    - src/lib/rag/index.ts
    - src/app/api/chat/route.ts
    - src/app/api/embed/chat/route.ts
    - src/lib/rag-eval/answer.ts
    - src/app/api/internal/rag/run/route.ts
    - tests/eval-route-query-layer.test.ts
    - tests/eval-answer-sentinel.test.ts

key-decisions:
  - "The options object is the fourth argument (after mode), not the third: mode already holds the third position, and moving it would break every existing caller"
  - "The line is added when any context language (normalized to its primary subtag, so zh-Hans = zh) differs from the asker's language. It is not added when the asker's language is unknown or has no line (only zh, en and it have one), or when no kept chunk has language evidence"
  - "Context languages per kept chunk: the chunk's own language, else the language of the same chunk_id among result.candidates (the document language from DATA-02; KeptChunk has no language field), else detectLanguage on the content"
  - "Order: wrapper output, then the answer-language line, then the Phase 5 citation instruction from decorateSystemPrompt. On a claude-citations turn the line is also appended to claudeSystemPrompt's output (chat and eval), so both strategies ask for the same language"
  - "Small talk and empty-context turns pass no options"
  - "Separator: a blank line, matching decorateSystemPrompt"

requirements-completed: [XLG-01]

coverage:
  - id: D1
    description: "Instruction lines for en/it/zh on a mismatch; byte-identical output in strict, balanced, flexible and bypass with matching languages, no options, empty context languages or no asker language; {{context}} substitution unchanged before the line; region subtags; contextLanguages prefers the field, then the candidate, then the detector"
    requirement: XLG-01
    verification:
      - kind: unit
        ref: "tests/rag/prompt-answer-language.test.ts (16 pass)"
        status: pass
      - kind: unit
        ref: "tests/prompt-context.test.mts, tests/rag/prompt.test.ts (unchanged, pass)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Chat and embed add the line only with a query plan whose language differs from the documents' language; matching languages and no plan leave the system prompt byte-identical; the eval run route passes the options to generateEvalAnswer only when the trace has a plan; the line sits before the chunk-alias citation instruction"
    requirement: XLG-01
    verification:
      - kind: unit
        ref: "tests/rag/answer-language-routes.test.ts (3 pass), tests/eval-route-query-layer.test.ts (new case pass)"
        status: pass
      - kind: unit
        ref: "characterize-chat, characterize-embed, chat-strict, eval-harness, citations/session (unchanged, pass)"
        status: pass
    human_judgment: false

duration: 120min
completed: 2026-11-26
status: complete
---

# Phase 6 Plan 33: Answer-language instruction Summary

**When the knowledge-base documents in the context are in a different language from the question, the generation prompt now gets one localized line: answer in the asker's language, and keep quoted text in the source language. RAG_SYSTEM_PROMPT and `{{context}}` are not touched.**

## Tasks and commits

| Task | Commits |
|------|---------|
| 1: Instruction and the optional prompt argument | `21d9b45` test (RED), `462d6a8` feat |
| 2: Pass the languages from chat, embed and eval | `19f86c5` test (RED), `3afbeba` feat, `d4ca87c` test (sentinel follow-up) |

## Behaviour changes (only with the query layer on)

- When a query plan exists and a kept chunk is in another language, the system prompt ends with the line for the plan's language, followed by the citation instruction when a citation strategy is active.
- With the layer off there is no query plan, so the routes pass nothing and every prompt is byte-identical to before. Strict "information not available", webSearch with Exa, `source_images`, voice and the `{{context}}` placeholder are unchanged.

## RED evidence

- `21d9b45`: 3 of 11 failed on assertions (the mismatch cases): the prompt did not take options yet.
- `19f86c5`: the chat and embed route cases and the eval generator case failed on assertions (no line in the system text).
- The new case in `tests/eval-route-query-layer.test.ts` failed on the pre-change `run/route.ts` and passed after it. I checked this by stashing the route change.

## Deviations

1. **Options in the fourth position:** the plan said the third position. Mode is already the third argument, so the options went fourth.
2. **Extra files:** `src/app/api/internal/rag/run/route.ts` (the only caller of `generateEvalAnswer`; without it the eval would never pass the options), `src/lib/rag/index.ts` (exports) and `tests/eval-route-query-layer.test.ts`.
3. **Claude Citations path:** the plan did not mention it, but I also appended the line to `claudeSystemPrompt` output in chat and eval. `session.ts` itself is unchanged.
4. **Sentinel:** `tests/eval-answer-sentinel.test.ts` checks that the chat route and the eval generator call `createEnhancedRAGPrompt` with the same source text. Both calls now read `createEnhancedRAGPrompt(ragSystemPrompt, context, ragMode, answerLanguage)`, and the sentinel was updated to that text, so the two call sites stay tied.
5. **Contract:** `contextLanguages(kept, candidates?)` takes the candidates as a second argument, because `KeptChunk` has no language field.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 420 files, 7034 passed, 4 skipped (the first run failed only on the sentinel, which `d4ca87c` fixes; I reran the full suite after the fix)
- `node --import tsx --test tests/*.test.mts`: pass
- `node --import tsx --test tests/rag-db/*.test.mts`: pass
- `check-rag-boundary` and its node test: pass
- `node scripts/check-config.mjs`: pass
- `check-workflows.py`: pass
- `npm run test-rag -- --out eval/out/06-33` and `--fixture-mode ingest --out eval/out/06-33-ingest`: pass
- No Python, contract, env or UI changes, so the sidecar/eval pytest, `gen:schemas` and frontend design gates do not apply.

## Operator actions

None. Live cross-language answer quality, meaning whether models actually follow the line, needs an eval run with real models. That is part of the phase-completion comparison (D-42).

## Self-Check: PASSED
