---
phase: 05-verified-citations-groundedness
plan: 08
subsystem: api
tags: [citations, rag, streaming, chat-route, ai-sdk, tracer]

requires:
  - phase: 05-verified-citations-groundedness
    provides: CitationRecord contract (05-01), readGenerationConfig and RAG_CITATIONS (05-02), marker grammar and parser (05-03), ContextBlock and the citationLabeler hook (05-04)
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: last route.ts edit (04-21) and last index.ts edit (04-33)
provides:
  - "createCitationSession: the facade the chat route uses (labeler, attach, decorateSystemPrompt, stripHistory, transforms, finishMetadata, answerText)"
  - "selectCitationStrategy: the only decision point (chunk-alias in this plan; the Claude branch comes in 05-16)"
  - "createCitationLabeler, buildAliasMap, buildCitationRecords, capQuotes, aliasParserTransform"
  - "citationInstruction and attachedDocumentsSentence in zh, en and it, with an English fallback"
  - "Chat route wiring behind RAG_CITATIONS=true plus capabilities.citations"
affects: [05-13, 05-16, 05-18, 05-20, 05-21, 05-22]

actuals:
  tokens: 11300
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "A pass-through experimental_transform feeds the parser; messageMetadata on finish reads the finalized result"
    - "Session decides twice: capability before retrieval (labeler), strategy after retrieval (attach with the blocks actually sent)"

key-files:
  created:
    - src/lib/rag/generation/citations/blocks.ts
    - src/lib/rag/generation/citations/record.ts
    - src/lib/rag/generation/citations/strategy.ts
    - src/lib/rag/generation/citations/transforms.ts
    - src/lib/rag/generation/citations/session.ts
    - src/lib/rag/generation/citations/instructions.ts
    - tests/rag/citations/chat-citations-route.test.ts
    - tests/rag/citations/session.test.ts
    - tests/rag/citations/alias-transform.test.ts
  modified:
    - src/app/api/chat/route.ts
    - src/lib/rag/index.ts
    - tests/chat-strict.test.ts

key-decisions:
  - "attach() gets null when retrieval failed (the degraded path replaces the context with 'No relevant context found.') or RAG is disabled, so no alias can validate against blocks that were never sent"
  - "Labeler header is '[S<k>] <block title>'; block text is neutralizeCitationMarkers(text), and the quote is that neutralized text exactly as sent (P-8)"
  - "quoteHash is the sha256 of the full quote; capQuotes (1,000 chars, never splitting a surrogate pair) caps only the metadata copy, so the hash still identifies the full snapshot that 05-13 stores"
  - "Finish metadata with the strategy active is {citations, citationStrategy:'chunk-alias', invalidCitations}; on a parser, record or stream error it is citations: [] and invalidCitations: 0, plus one '[Citations]' warn line with counts only"
  - "capabilities is parsed with z.object({citations: z.boolean().optional()}).passthrough().safeParse; any invalid value counts as absent"
  - "The instruction tells models to use adjacent markers ([S1][S3]), following the 16-character marker cap from 05-03"
  - "Citation language is data.settings.language (userLanguage); unknown languages fall back to English"

patterns-established:
  - "Real-stream route test: route fixture plus MockLanguageModelV3 behind the mocked OpenRouter provider, real streamText (no capture fake)"

requirements-completed: [GEN-02, GEN-04, GEN-07]

coverage:
  - id: D1
    description: "Web-chat request with citations on ends with a validated CitationRecord list in the finish metadata; invented aliases dropped and counted"
    requirement: GEN-02
    verification:
      - kind: integration
        ref: "tests/rag/citations/chat-citations-route.test.ts#labels the blocks, validates the streamed markers and sends CitationRecord[] in the finish metadata"
        status: pass
  - id: D2
    description: "Structured output is the schema-validated CitationRecord list; no responseFormat or JSON mode on the streamed answer"
    requirement: GEN-04
    verification:
      - kind: unit
        ref: "tests/rag/citations/alias-transform.test.ts"
        status: pass
  - id: D3
    description: "Switch off, no capability (WhatsApp), bypass, and the strict refusal all stay byte-identical; characterization suites unchanged"
    requirement: GEN-07
    verification:
      - kind: integration
        ref: "tests/chat-strict.test.ts; tests/rag/citations/chat-citations-route.test.ts; tests/rag/characterize-chat.test.ts"
        status: pass
  - id: D4
    description: "Localized instruction after the {{context}} substitution; markers stripped from earlier assistant turns"
    requirement: GEN-02
    verification:
      - kind: unit
        ref: "tests/rag/citations/session.test.ts"
        status: pass

duration: 70min
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 08: Chunk-alias citations tracer Summary

**A web-chat answer with `RAG_CITATIONS=true` and `capabilities.citations` now travels the whole alias path: labelled `[S<k>]` blocks, a localized citation instruction, the real `streamText` with a pass-through parser transform, and a server-validated `CitationRecord[]` in the finish message metadata.**

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | cbe1e66 | test(05-08): add failing tracer test for chunk-alias citations through the chat route |
| 1 | 9a15341 | feat(05-08): chunk-alias citations end to end for web-chat requests |
| 2 RED | 964b1ce | test(05-08): add failing tests for localized instructions, history stripping and byte-identity guards |
| 2 GREEN | 4c05542 | feat(05-08): localized citation instructions and history marker stripping |
| 3 | d299ec1 | test(05-08): prove the alias parser transform on the real streamText |
| 3 | 1005419 | test(05-08): type the mock stream parts in the alias transform test |

## Route wiring (`src/app/api/chat/route.ts`)

- `ChatCapabilitiesSchema` is a module-level constant. The request type gains `capabilities?: unknown`.
- `createCitationSession` runs right after the model is chosen. Both `runRetrieval` calls get `citationLabeler` only when the session has one.
- `citationSession.attach(...)` runs after the knowledge-base-unavailable and strict-refusal returns, so refusals never see citation code.
- `decorateSystemPrompt` wraps only the `createEnhancedRAGPrompt` call.
- `stripHistory` wraps `convertedMessages`.
- `experimental_transform` is set only when the strategy is active.
- `finishMetadata()` is spread into the finish metadata.
- Everything is imported from `@/lib/rag`; the boundary check passes.

## Behaviour changes

- No change unless `RAG_CITATIONS=true` **and** the body carries `capabilities: { citations: true }` **and** `ragMode` is not `bypass` **and** at least one non-image block was sent.
- When active:
  - Context blocks get `[S<k>] <title>` headers, and their text has marker-like strings neutralized.
  - The localized instruction is appended after the substituted context.
  - Earlier assistant turns lose their `[S…]` markers before they reach the model.
  - The streamed text keeps its raw markers.
  - The finish metadata gains `citations`, `citationStrategy` and `invalidCitations`.
- Ghost chats get citations in the metadata. Persistence rules are 05-13.

## Tests that failed before the fix

- Task 1 RED: the tracer case failed (no `[S1] ` label in the system prompt).
- Task 2 RED, against stubs: four cases failed on assertions:
  - the three different localized instructions;
  - the attached-documents sentences;
  - session `stripHistory`;
  - route history stripping.
- Task 3: all five cases passed on first run. The plan said to adjust `transforms.ts` only if a case failed, so there was no RED commit.
- The byte-identity guards (switch on with no capability, strict refusal in en and es, invalid capability value) are guards and passed from the start.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no diagnostics |
| `npx vitest run` | 257 files, 4092 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 166 pass, 0 fail |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1061 pass, 4 skipped, 4 fail (pre-existing, below) |
| check-rag-boundary + node test | ok; 38 pass |
| `node scripts/check-config.mjs` | ok, 135 variables |
| check-workflows.py | OK |
| `npm run test-rag -- --out eval/out/05-08` | gate PASS, `paired.all_zero` true |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/05-08-ingest` | gate PASS, `paired.all_zero` true |
| Python suites, gen:schemas | not required (no Python or contract change) |

### Pre-existing failure

`tests/rag-db/ingest-mode-routing.test.mts`: 4 subtests fail (`--routing tiered`, `--force-tier structured|fast|premium`). The sidecar's download of `cl100k_base.tiktoken` from `openaipublic.blob.core.windows.net` fails with `SSLError ... CERTIFICATE_VERIFY_FAILED`. This plan does not touch that code, and 05-02 recorded the same 4 failures on its base commit.

## Deviations

1. **instructions.ts created in Task 1 (English only), finished in Task 2.** The tracer test asserts the instruction after the context, so a minimal version was needed before Task 2 added zh and it.
2. **Extra exports from `@/lib/rag`:** `readGenerationConfig`, `GenerationConfig`, `selectCitationStrategy`, the strategy types and `HistoryMessage`. The route needs the config reader, and the boundary rule forbids deep imports.
3. **Extra route cases:** ghost chat, invalid capability and history stripping are in `chat-citations-route.test.ts`, because they need the real stream. The WhatsApp byte-identity case normalizes only random ids (`id`, `messageId`, `toolCallId`, `ragTraceId`).
4. No migration, env variable, contract, package or UI change.

## Decisions for STATE

- Citations are decided in two steps: the capability before retrieval (labeler), then the strategy in `attach` with the blocks actually sent. A failed or degraded retrieval attaches `null`.
- `quoteHash` covers the full quote; only the metadata copy is capped at 1,000 characters.
- Citation failures never produce an error part. They log one `[Citations]` line with counts only and give `citations: []`.

## Operator actions

None. `RAG_CITATIONS` stays off by default, and the web client does not send `capabilities.citations` yet. The client side comes in 05-15 and 05-20.

## Deferred

- The Claude Citations branch of `selectCitationStrategy` and use of `attachedDocumentsSentence` (05-16).
- Persistence, `answerId` and records (05-13); client chips and hiding unvalidated markers (05-20); the eval route session (05-22).
