---
phase: 05-verified-citations-groundedness
plan: 11
subsystem: api
tags: [citations, anthropic, ai-sdk, streaming, rag]

requires:
  - phase: 05-verified-citations-groundedness
    provides: "@ai-sdk/anthropic 3.0.143 pin (05-05); AliasMap, aliasParserTransform, buildCitationRecords and the marker parser (05-08); DEFAULT_ANTHROPIC_BASE_URL (05-02)"
provides:
  - "createClaudeProvider: createAnthropic with an explicit base URL (empty or blank falls back to the default, research P-3)"
  - "buildClaudeCitationRequest: the D-09 request (one citation-enabled text/plain document per block as bytes, in AliasMap order, before the question; maxRetries 0; maxOutputTokens 16384; no sampling, output or format option)"
  - "claudeReasoningEligibility: adaptive-thinking prefixes only; budget-only models return reasoning_unsupported (D-10)"
  - "startClaudeCitationStream: streamText with [claudeMarkerTransform, aliasParserTransform] and a citations() reader returning CitationRecord[] whose quote is cited_text"
  - "claudeMarkerTransform: source parts become [S<k>] markers before the block's text-end; unknown filenames dropped and counted"
  - "tests/helpers/fake-anthropic.ts and five recorded-shape SSE fixtures"
affects: [05-16, 05-22]

actuals:
  tokens: 9500
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Real @ai-sdk/anthropic provider driven by a fetch fake replaying SSE fixtures; wire-level assertions on the captured JSON body"
    - "Claude citations normalised to the alias grammar: injected markers flow through the same aliasParserTransform as the chunk-alias path"

key-files:
  created:
    - src/lib/rag/generation/citations/claude.ts
    - src/lib/rag/generation/citations/claude-transform.ts
    - tests/helpers/fake-anthropic.ts
    - tests/fixtures/anthropic/citations.sse
    - tests/fixtures/anthropic/thinking-citations.sse
    - tests/fixtures/anthropic/websearch-tool.sse
    - tests/fixtures/anthropic/error-before-first-token.sse
    - tests/fixtures/anthropic/refusal-before-first-token.sse
    - tests/rag/citations/claude-request.test.ts
    - tests/rag/citations/claude-stream.test.ts
  modified: []

key-decisions:
  - "Reasoning maps to providerOptions.anthropic.thinking {type: adaptive} only; effort is never sent because the provider puts it in output_config"
  - "Adaptive-thinking prefixes: claude-opus-5, claude-sonnet-5, claude-haiku-5, claude-fable-5, claude-opus-4-6/4-7/4-8, claude-sonnet-4-6; anything else is reasoning_unsupported. buildClaudeCitationRequest silently omits thinking on an ineligible id; 05-16's eligibility function must route reasoning turns away first"
  - "Records come from the markers the alias parser sees (order of first appearance), so a citation that never produced a marker yields no record; the quote is the first cited_text per alias, quoteHash is its sha256; the block text is the fallback only if cited_text is empty"
  - "invalidCitations on this path = parser-invalid markers + document sources whose filename is missing or not in the AliasMap"
  - "Pending markers are flushed at the next text-end (Anthropic sends citations_delta inside the cited block); URL sources (web search) pass through untouched"
  - "citations() returns full quotes; capping for message metadata (capQuotes) stays with the session in 05-16"

patterns-established:
  - "createFakeAnthropicFetch({ sse: '<fixture>.sse' | raw SSE } | { status, body }) records url, headers and parsed body"

requirements-completed: [GEN-01, GEN-04]

coverage:
  - id: D1
    description: "Claude request on the wire: documents as exact text, in alias order, before the question; titles; citations enabled; no output/format/sampling; <baseURL>/messages; x-api-key"
    requirement: GEN-01
    verification:
      - kind: unit
        ref: "tests/rag/citations/claude-request.test.ts"
        status: pass
  - id: D2
    description: "No structured output or format option on the citation call (GEN-04, T-05-31)"
    requirement: GEN-04
    verification:
      - kind: unit
        ref: "tests/rag/citations/claude-request.test.ts#carries no output, format or sampling field and posts to <baseURL>/messages with the key"
        status: pass
  - id: D3
    description: "Streamed citations become [S<k>] markers before the block end; records carry cited_text; thinking, tool call, error, 429 and refusal cases"
    requirement: GEN-01
    verification:
      - kind: integration
        ref: "tests/rag/citations/claude-stream.test.ts"
        status: pass

duration: 45min
completed: 2026-11-25
status: complete
---

# Phase 5 Plan 11: Claude Citations module Summary

**The direct Claude path now exists as a tested module: the real `@ai-sdk/anthropic` provider builds the D-09 request, and streamed Anthropic citations come back as the same `[S<k>]` markers and `CitationRecord` shape as the chunk-alias path, with `cited_text` as the quote.**

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 RED | 470bdc3 | test(05-11): add failing wire tests for the Claude citation request |
| 1 GREEN | 6f0a67b | feat(05-11): direct Claude citation request on @ai-sdk/anthropic (D-09, D-10) |
| 2 RED | 710f90c | test(05-11): add failing recorded-shape stream tests for Claude citation markers |
| 2 GREEN | 505a1ff | feat(05-11): inject [S<k>] markers from streamed Claude citations (D-01, D-09) |

## Behaviour changes

None at runtime. Nothing imports the module yet, and no switch, env variable, route or UI change was made. The route wiring, eligibility and fallback are plan 05-16.

## Tests that failed before the fix

- Task 1 RED, against stubs: 6 of 7 cases failed on assertions. The stub sent the question with no documents, `temperature`, `maxRetries: 2`, the model's default `max_tokens`, and no thinking, and it treated every model as reasoning-eligible. The URL-scheme case failed with a TypeError because there was no document block to read.
- Task 2 RED, against the pass-through transform stub: 5 of 8 cases failed on assertions, all on missing markers or the invalid count. The error, 429 and refusal cases passed from the start. They check provider behaviour that 05-16's first-token detector relies on.

## Findings on the provider (3.0.143)

- `char_location` and `page_location` citations become `source` parts (`sourceType: document`, `filename` = alias). They arrive between the block's text deltas and its `text-end`. A `document_index` outside the documents sent is dropped inside the provider and never reaches the transform.
- `stop_reason: refusal` maps to finish reason `content-filter`.
- An SSE `error` event and an HTTP 429 (with `maxRetries: 0`) each surface as an `error` part before any `text-delta`.
- On known 5.x models the provider drops sampling parameters anyway. This module never sends them.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | no diagnostics |
| `npx vitest run` | 291 files, 4611 passed, 1 skipped |
| `node --import tsx --test tests/*.test.mts` | 172 pass, 0 fail (after filling the tiktoken cache) |
| `node --import tsx --test tests/rag-db/*.test.mts` | 1457 pass, 0 fail, 4 skipped (after filling the tiktoken cache) |
| check-rag-boundary + node test | ok; 38 pass |
| `node scripts/check-config.mjs` | ok, 144 variables |
| check-workflows.py | OK |
| Python suites, gen:schemas, test-rag, frontend summary | not required: no Python, contract, retrieval, ingest, golden-set or UI change |

### Environment note

On the first run, before the tiktoken cache was filled, 3 cases in `tests/*.test.mts` failed (the sidecar module launcher) and 10 in `tests/rag-db/*.test.mts` failed (process-document identity and ingest mode by routing). The cause was the known cl100k download through the proxy. I ran `scripts/ci/fill-tiktoken-cache.py` and reran both suites, and all passed. This plan does not touch that code.

## Deviations

1. `buildClaudeCitationRequest` takes the `provider` as an input, which the plan's argument list did not include, because the model must come from the provider. `startClaudeCitationStream` also takes optional `tools`, so the webSearch fixture can produce a typed `tool-call`.
2. `startClaudeCitationStream` returns `{ result, citations() }`. It builds the records itself from `buildCitationRecords` and overrides `quote` and `quoteHash` with `cited_text`. `record.ts` and `session.ts` are unchanged; the session integration is 05-16.
3. The unknown-filename case is a unit test that drives the transform directly. Through the real provider, unknown document indices never reach the transform.

## Decisions for STATE

- Reasoning on the Claude path means adaptive thinking only, and `effort` is never sent. Budget-only models make reasoning turns ineligible.
- Claude citation records use the first `cited_text` per alias as the quote. A record exists only for an alias whose marker appears in the answer.

## Operator actions

None.

## Deferred

- Route wiring, `selectCitationStrategy`'s Claude branch, the attached-documents sentence, the first-token fallback to OpenRouter plus chunk-alias, and `capQuotes` on this path: all plan 05-16.
- Live verification against the real API (`GET /v1/models`, a real citations stream with thinking and a tool call), per the ROADMAP live items.
