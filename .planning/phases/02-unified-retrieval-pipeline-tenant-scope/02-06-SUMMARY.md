---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 06
subsystem: testing
tags: [characterization, snapshots, golden-master, oracle, embed, voice-rag, chat, pglite]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: two-tenant fixture, extended fake edge operators, vitest Supabase fake (plan 02-05)
  - phase: 01-eval-foundation
    provides: PGlite fixture database, fake PostgREST edge, 72-question golden set
provides:
  - startRouteFixture helper that runs a real route in-process against the PGlite fake edge
  - committed snapshots of today's embed system prompts (72), voice-rag wire output (78) and chat system prompts or refusals (144)
  - frozen verbatim oracle of the chat route post-filter and context assembly loop, with a test pinning it to the route text at commit 172c2ad
affects: [02-07, 02-08, 02-09, 02-10, 02-16]

requirements-completed: [PIPE-05]

actuals:
  tokens: 538000
  tasks: 2
  commits: 2
plan_head_before: e308307fe9a17df0009fbdc60faacadf928e2603
plan_head_after: f5e19def2d9fb558faf74fc0b4d5896c4e6743b0

tech-stack:
  added: []
  patterns:
    - "Characterization snapshot rule: compare to the committed JSON, rewrite only with UPDATE_CHARACTERIZATION=1"
    - "Route under test runs for real; only the model call, Exa and the SSR session client are faked"
    - "Verbatim region pinned by marker extraction from a fixed git ref, not by hash"

key-files:
  created:
    - tests/helpers/route-fixture.ts
    - tests/rag/characterize-embed.test.ts
    - tests/rag/characterize-voice.test.ts
    - tests/rag/characterize-chat.test.ts
    - tests/rag/legacy-chat-assembly-oracle.test.ts
    - tests/fixtures/legacy-chat-assembly.ts
    - tests/fixtures/characterization/embed.json
    - tests/fixtures/characterization/voice.json
    - tests/fixtures/characterization/chat.json
  modified: []

key-decisions:
  - "createEnhancedRAGPrompt is replaced in the tests by a copy of its logic that takes RAG_MODE_CONFIGS as an argument, because the real function loads rag-mode with a CommonJS require that vitest cannot resolve"
  - "Fixture env pins the RAG_* values from eval/config/rag-eval-env.json and clears every other RAG_* variable, so snapshots do not depend on a developer's .env.local"
  - "The chat characterization takes its GPT and non-GPT model ids from the configured NEXT_PUBLIC_OPENROUTER_MODELS list; snapshots record model_kind, never the id"
  - "The oracle returns relevantChunks derived after the region (chunks whose document is in the final usedDocuments) because the region's own relevantChunks constant is block scoped"

patterns-established:
  - "tests/helpers/route-fixture.ts: startRouteFixture, expectCharacterization, systemTextOf, createFaithfulEnhancedPrompt"

coverage:
  - id: D1
    description: "Embed route system prompt snapshot for all 72 fixture questions"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/rag/characterize-embed.test.ts"
        status: pass
  - id: D2
    description: "Voice-rag {results, source_images} snapshot for 72 questions plus 6 intent queries, debug_info excluded"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/rag/characterize-voice.test.ts (2 tests)"
        status: pass
  - id: D3
    description: "Chat route strict-mode system prompt or refusal snapshot, 72 questions x two model kinds"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/rag/characterize-chat.test.ts (2 tests)"
        status: pass
  - id: D4
    description: "Frozen chat assembly oracle is verbatim the route region and executes against the fixture edge"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/rag/legacy-chat-assembly-oracle.test.ts (3 tests); tests/legacy-post-filter-sentinel.test.ts (unchanged, 15 tests)"
        status: pass
---

# Phase 2 Plan 06: Characterization Snapshots and Frozen Chat Oracle Summary

**Today's embed, voice-rag and chat outputs are frozen as committed snapshots on the PGlite fixture corpus, and the chat route's post-filter and assembly loop is preserved verbatim as a test oracle.**

## Performance

- **Tasks:** 2 of 2
- **Files:** 9 created, no production code changed
- **Verification:** `npx vitest run tests/rag tests/legacy-post-filter-sentinel.test.ts` passes (5 files, 23 tests); `npm run typecheck:new` reports no Phase 1 errors

## Accomplishments

- Task 1 (commit 4bb047a): route fixture helper and three characterization tests with snapshots. embed.json has 72 entries `{id, system}`; voice.json has 78 entries `{query, results, source_images}` with no debug_info; chat.json has 144 entries (72 questions for a non-GPT and a GPT model kind), 96 of them system prompts and 48 strict refusals `{id, model_kind, refused, text}`. Snapshots are deterministic across repeated runs. `git diff` of `src/` for the plan is empty.
- Task 2 (commit f5e19de): `tests/fixtures/legacy-chat-assembly.ts` wraps the region from `// CHANGE 2: Add keyword-based document filtering` through the `startsWith('no relevant context found');` line, copied byte for byte (original indentation kept) by a generator script. The oracle test reads the route at commit 172c2ad with `git show` and asserts the region occurs in the oracle exactly once. It also runs the oracle for two fixture questions and checks that the assembled context is non-refusing, has used documents, and appears inside the committed chat snapshot system prompt for the non-GPT kind, tying the oracle output to the route output.

## Task Commits

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | Embed, voice and chat characterization snapshots | 4bb047a |
| 2 | Frozen oracle of the chat assembly loop | f5e19de |

## Intended-difference ledger for later plans (T-02-11)

Snapshots are rewritten only with `UPDATE_CHARACTERIZATION=1`. A switch plan that changes any snapshot must list each changed entry in its SUMMARY as an intended difference. Notable facts about today's behavior that the snapshots pin:

- Embed route: 23 of 72 questions get the "No relevant information found" context; it does not refuse.
- Chat route: 24 of 72 questions per model kind get the strict refusal; the GPT and non-GPT system prompts differ for every non-refused question (GPT source labels).
- Voice route: 15 of 78 queries return empty results; the fixture corpus has no image chunks, so no entry carries source_images.

## Deviations from Plan

**1. [Rule 3 - Blocking] createEnhancedRAGPrompt cannot run unmocked under vitest**
- **Found during:** Task 1
- **Issue:** `src/lib/thinking-rag-enhancer.ts` loads `./rag-mode` with `require`, which vitest cannot resolve, so the embed route fell into its error path.
- **Fix:** All three tests mock the module with the real exports plus a copy of `createEnhancedRAGPrompt` that reads the real `RAG_MODE_CONFIGS` (`createFaithfulEnhancedPrompt` in the helper). Production code untouched.
- **Commit:** 4bb047a

**2. [Rule 3 - Blocking] Verbatim region is not a balanced block and has block-scoped locals**
- **Found during:** Task 2
- **Issue:** The region starts inside `if (queryText) {` and ends after the block that closes the RAG branch, and `relevantChunks` is block scoped, so it cannot be returned from outside.
- **Fix:** The wrapper opens the two enclosing blocks before the region and closes the function after it; `relevantChunks` in the return value is derived after the region from the final used documents. The file carries `// @ts-nocheck` (with a reason line) because the copied code relies on untyped Supabase results; its exported types stay checked for importers.
- **Commit:** f5e19de

**3. Keyword fallback step 2 of the voice route is not exercised by the fixture edge**
- The route selects an `embedding` column that the fake edge rejects (400), so that fallback step contributes nothing in the snapshots. Steps 0 (explicit image fetch) and 1 (phrase match) run through the fake edge. The fake edge was not extended because that is outside this plan's files; plan 02-16 or a later plan can add the column if step 2 must be pinned.

**4. Test expectations**
- The oracle test needs the baseline commit 172c2ad to be present in the clone (`git show`); a shallow clone without it fails by design.

## Known Stubs

None.

## Threat Flags

None. Snapshots contain only fixture corpus text; the internal API key in the voice test is a placeholder string.

## Self-Check: PASSED

- All nine files listed under key-files.created exist.
- Commits 4bb047a and f5e19de are ancestors of HEAD.
