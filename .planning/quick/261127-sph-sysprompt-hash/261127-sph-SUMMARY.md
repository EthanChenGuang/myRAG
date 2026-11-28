---
quick_id: 261127-sph
slug: sysprompt-hash
status: complete
date: 2026-11-28
branch: exec/quick-62-sysprompt-hash
base: origin/exec/quick-62-hash-bench (105bff9e)
gaps: [06.2-G2]
key-files:
  created:
    - tests/rag/cache/decomposed-answer-key.test.ts
    - .planning/quick/261127-sph-sysprompt-hash/261127-sph-PLAN.md
  modified:
    - src/lib/rag/types.ts
    - src/lib/rag/cache/keys.ts
    - src/lib/rag/generation/decomposed-answer.ts
    - src/lib/rag/query/run-layer.ts
---

# Quick 261127-sph: the decomposed-answer block in systemPromptHash (06.2 G2)

## What changed
- The semantic cache is checked before retrieval, so the entry point cannot know whether a question decomposes. The fold therefore
  happens at the semantic_cache key in `src/lib/rag/query/run-layer.ts`, after decompose has run:
  `promptHashForKey` folds the GEN-13 block template into the caller's `systemPromptHash` only when all three hold:
  `cacheContext.decomposedAnswer === true` (the entry point passes the block to the prompt), RAG_DECOMPOSED_ANSWER is effective
  (`config.queryAdditions.effective.decomposedAnswer`, so layer off or v2 off is off) and the plan has two or more sub-questions
  with a language pack that holds the block texts.
- `decomposedAnswerTemplate(count, language)` (`generation/decomposed-answer.ts`): the fixed texts `buildDecomposedAnswerBlock`
  uses, or null exactly where the block is null. A language-pack text change therefore also gives a new key.
- `systemPromptHashWithBlocks(hash, blocks)` (`cache/keys.ts`): switch-gated blocks enter only while present (the G5
  `queryAdditionsHashBlock` / SWITCH_GATED_PROMPT_IDS pattern); with none it returns the caller's hash byte for byte.
- `RetrievalCacheContext.decomposedAnswer?: boolean` (`src/lib/rag/types.ts`), optional and internal. Not a schema contract: nothing
  under `contracts/`, no generated Zod, no wire change. No SQL, migration or env variable.
- Behaviour today: none. No entry point passes the block yet (06.2-23 wires it), so every hash and cache key, with the switches off
  or at the defaults, is unchanged. Once 06.2-23 sets the flag, only decomposed questions whose prompt carries the block get a new key.
- Tripwire for 06.2-23: the test fails when chat, embed or the eval route (with `rag-eval/answer.ts`) passes the block
  (`buildDecomposedAnswerBlock` or `decomposedAnswer:`) without `decomposedAnswer` in its `cacheContext`.

## Commits
- a58611b3 test: RED (plus the optional type field so tsc stays clean). Failed on an assertion: the looked-up hash equalled the
  caller hash for a decomposed question with the block.
- 5f8e4ca3 fix: template, fold, cache-stage wiring, key-level and tripwire tests. The RED fixture question now has two question
  marks so the gate really decomposes (asserted through the fake's decompose call count); re-checked failing on the old code.
- docs: PLAN, this SUMMARY.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: no errors
- `npx vitest run tests/rag/v2/config-hash* tests/rag/cache tests/rag/query/parity-off.test.ts` plus every test file importing the
  changed modules: 42 files, 540 tests pass
- full `npx vitest run` (core type touched): 854 files passed, 3 skipped; 16147 tests passed, 90 skipped
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`,
  `node scripts/ci/check-settings-classification.mjs`: pass
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-62-sysprompt-ingest`: absolute gate PASS, gate PASS (8 skipped)

## Deviations
- The RED test fixture changed in the fix commit (see Commits). No other deviation.

## For 06.2-23 / operator
- 06.2-23 sets `decomposedAnswer: true` in each entry point's `cacheContext` exactly when it passes the block (RAG_DECOMPOSED_ANSWER
  effective). The tripwire enforces it. No operator action.
