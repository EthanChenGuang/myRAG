---
phase: 01-evaluation-harness-baseline
plan: 17
subsystem: testing
tags: [vitest, characterization-tests, chat-route, strict-rag, exa, source-images, sentinel]

requires:
  - phase: 01-04
    provides: "applyLegacyPostFilter / legacyQueryTerms replica of the chat route's post-retrieval logic"
  - phase: 01-09
    provides: "Vitest setup (npm test), placeholder env, vi.resetModules convention for route tests"
provides:
  - "Characterization tests that drive the real, unedited src/app/api/chat/route.ts through POST with mocked vendors"
  - "tests/helpers/chat-route-fakes.ts: createSupabaseFake, createSsrClientFake, createStreamTextCapture, createExaFake, createChatRouteHarness, readSse, chatRequest"
  - "Unit tests for the legacy post-filter replica including the Chinese empty-term and Italian accent-stripping quirks"
  - "A source sentinel that fails when any literal the replica copies changes in the chat route"
affects: [01-18, phase 2 retrieval changes, phase 2 post-filter extraction]

plan_head_before: 71f6b8af59e583de98239ec9913fe6d31c9555bf
plan_head_after: fe6ebc4f137a46f829f5f7e8b453dd0cdf574340

actuals:
  tokens: 8400
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Route tests build one harness per file with await vi.hoisted(() => import helper), reference it from hoisted vi.mock factories, and call vi.resetModules() plus a dynamic import of the route in each test"
    - "The ai module is mocked partially: real createUIMessageStream and createUIMessageStreamResponse, replaced streamText whose fake result emits UI message chunks, so the SSE body is produced by the real response code"
    - "The tsx-only test for createEnhancedRAGPrompt uses node:test with dynamic imports after placeholder env is set, because the lazy require('./rag-mode') cannot resolve a .ts file under Vitest"
    - "A sentinel reads the route as text and asserts replicated literals, with a failure message naming the replica file"

key-files:
  created:
    - tests/helpers/chat-route-fakes.ts
    - tests/chat-strict.test.ts
    - tests/chat-websearch.test.ts
    - tests/chat-source-images.test.ts
    - tests/chat-messages-roundtrip.test.ts
    - tests/prompt-context.test.mts
    - tests/legacy-post-filter.test.ts
    - tests/legacy-post-filter-sentinel.test.ts
  modified: []

key-decisions:
  - "The persisted source_images part is asserted by type and source_images payload, not by whole-object equality: today's route also sets result: null on it (the approval-clearing loop touches every part whose toolName is not query_documents or webSearch). That field is incidental and left unlocked."
  - "The route's own mocked OpenRouter provider echoes the requested model id, so the no ':online' suffix assertion checks the id actually passed to streamText rather than a constant"
  - "prompt-context.test.mts is not collected by npm test (vitest.config.ts includes tests/**/*.test.ts only); it runs with node --import tsx --test, as the plan specifies"
  - "The sentinel additionally asserts the term-filter literals occur at least twice, because the route has two copies (chunk filter and Filter 2 terms) and the replica mirrors both"

patterns-established:
  - "Characterization tests never edit production code; seams are module mocks only"

requirements-completed: [EVAL-12]

coverage:
  - id: D1
    description: "Strict mode with webSearch off and empty retrieval returns text containing Information Not Available and never calls streamText (also the Spanish variant)"
    requirement: EVAL-12
    verification:
      - kind: integration
        ref: "tests/chat-strict.test.ts (2 tests, real route)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Strict + webSearch true + EXA_API_KEY + empty retrieval does not refuse, calls streamText once with a webSearch tool whose execute calls searchAndContents(query, { livecrawl: 'always', numResults: 3 }) and returns title/url/content(1000 chars)/publishedDate; model id has no :online suffix"
    requirement: EVAL-12
    verification:
      - kind: integration
        ref: "tests/chat-websearch.test.ts (2 tests, real route)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A retrieved image chunk at similarity 0.3 streams source_images with its URL before the first text delta, onStepFinish persists the source_images part, the image document stays out of the model context, and toDBMessages/fromDBMessages keep the part unchanged"
    requirement: EVAL-12
    verification:
      - kind: integration
        ref: "tests/chat-source-images.test.ts (3 tests) and tests/chat-messages-roundtrip.test.ts (3 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "createEnhancedRAGPrompt output contains the context and no {{context}} placeholder for strict, balanced and flexible; ensureContextPlaceholder and injectContext keep and fill the placeholder"
    requirement: EVAL-12
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/prompt-context.test.mts (4 pass, 0 fail)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Legacy post-filter quirks locked: empty term for Chinese keeps every candidate with a document row, Perché becomes perch, Filter 1 needs > 0.65 (0.65 dropped, 0.651 kept), image chunks need > 0.25, Filter 2 keeps >= 0.6, refusal only when nothing survived Filter 1 in strict mode without web search"
    requirement: EVAL-12
    verification:
      - kind: unit
        ref: "tests/legacy-post-filter.test.ts (21 tests)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The sentinel fails when a replicated literal in the chat route changes"
    requirement: EVAL-12
    verification:
      - kind: unit
        ref: "tests/legacy-post-filter-sentinel.test.ts (13 tests); mutation check: changing 0.65 to 0.66 in a scratch edit of route.ts made the sentinel fail with the 'must be updated in the same change' message, then the route was restored (git diff clean)"
        status: pass
    human_judgment: false
  - id: D7
    description: "The characterization files pass with --sequence.shuffle (3 runs) and with --no-file-parallelism, in addition to the default parallel pool"
    requirement: EVAL-12
    verification:
      - kind: integration
        ref: "npx vitest run <5 chat/legacy files> --sequence.shuffle x3 (31 passed each); npx vitest run <3 chat files> --no-file-parallelism (7 passed); npm test (10 files, 67 passed)"
        status: pass
    human_judgment: false

duration: 5min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 17: Characterization Tests for Preserved Chat Behaviors Summary

**The real chat route is now driven end to end in Vitest with every vendor mocked, locking strict "Information Not Available", webSearch + strict through Exa, source_images streaming and persistence and {{context}} substitution, and the legacy post-filter replica is unit-tested and tied to the route source by a sentinel**

## Performance

- **Duration:** about 5 min of wall time (measured from a start marker at launch)
- **Completed:** 2026-11-23
- **Tasks:** 3
- **Files modified:** 8 created, none modified (no production file touched)

## Accomplishments
- 4 route-level tests plus 3 source_images tests run against the unedited `src/app/api/chat/route.ts`; SSE bodies come from the real `createUIMessageStreamResponse`.
- 21 replica unit tests and 13 sentinel tests; a scratch mutation of the Filter 1 threshold in the route made the sentinel fail, then the route was restored byte-identical.
- Order and parallelism independence verified: three shuffled runs and one `--no-file-parallelism` run all green. `npm test` is 10 files / 67 tests, `npm run test-rag` exits 0, pytest passes in `rag-sidecar` (131) and `eval` (85).

## Task Commits

1. **Task 1: Strict refusal and webSearch + strict Exa tests with shared fakes** - `0cbed93` (test)
2. **Task 2: source_images, message round trip, {{context}} under tsx** - `898ef31` (test)
3. **Task 3: Legacy post-filter unit tests and route source sentinel** - `fe6ebc4` (test)

**Plan metadata:** committed separately (docs: complete plan)

`commits: 4` in the frontmatter is the measured `rev-list` count from the ledger base; it includes one unrelated planning-docs commit (`86829e0`) that another actor made on this branch during execution. The plan's own commits are the three above.

## Decisions Made
See `key-decisions` above.

## Deviations from Plan

### Process

**1. [Process] TDD order for Task 3 (`tdd="true"`)**
- The replica (`legacy-post-filter.ts`) already existed from plan 01-04 and these are characterization tests of existing behavior, so there is no failing-test commit: the tests passed on first run. The sentinel's ability to fail was proven with the scratch mutation recorded under D6 instead.

Otherwise the plan was executed as written: no `src/` file was edited, `git diff 325a2c9` on the four protected production files prints nothing, and the quirks (Chinese empty term, accent stripping, kept-by inheritance) are locked, not fixed.

## Issues Encountered
- `result: null` appears on the persisted `source_images` part (the route's approval-clearing loop sets it for every part not named `query_documents` or `webSearch`). The test asserts type and payload only; see key-decisions.
- Vite prints a duplicate-key warning for `src/lib/mcp/universal-client.ts` (`inputSchema` twice in one object literal) when the route is imported. It is pre-existing production code, out of scope, and does not affect results.
- `tests/helpers/chat-route-fakes.ts` produces four ESLint warnings (`any` in the streamText capture and unused parameter names in the thenable); no errors.

## Known Stubs
None. The fakes are test doubles confined to `tests/`.

## Threat Flags
None beyond the plan's register. T-01-10: tests use only the placeholder keys from `tests/setup-env.ts` (the `sk-or-` value is the required-format fake). T-01-11: Supabase admin and SSR clients, `streamText`, the OpenRouter provider, Exa, retrieval, document-processor and the prompt enhancer are all mocked, so no request leaves the process.

## User Setup Required
None.

## Next Phase Readiness
- Phase 2 can change retrieval or generation and run `npm test`: any change to strict refusal, Exa web search, source_images or the `{{context}}` placeholder fails a named test, and any change to the Filter 1/Filter 2/refusal literals fails the sentinel with an instruction to update the replica in the same change.
- `tests/prompt-context.test.mts` is not part of `npm test`; a later plan that adds a CI step for node:test files (like `tests/eval-answer.test.mts`) should include it.
- EVAL-12 is marked complete: this was the only plan declaring it.

## Self-Check: PASSED

All 8 created files exist, commits `0cbed93`, `898ef31` and `fe6ebc4` are ancestors of HEAD, `git diff --name-only 325a2c9` on `src/app/api/chat/route.ts`, `src/lib/thinking-rag-enhancer.ts`, `src/types/chat.ts` and `src/lib/system-prompt-manager.ts` prints nothing, and `npm test`, `npm run test-rag` and both pytest projects pass.

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
