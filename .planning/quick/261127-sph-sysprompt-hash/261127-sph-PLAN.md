---
quick_id: 261127-sph
slug: sysprompt-hash
date: 2026-11-27
branch: exec/quick-62-sysprompt-hash
base: origin/exec/quick-62-hash-bench (105bff9e)
source: .planning/phases/06.2-query-layer-additions/06.2-VERIFICATION.md (verify/06.2), gap G2
---

# Quick 261127-sph: the decomposed-answer block in systemPromptHash (G2)

## Task 1 (G2, TDD)
- RED: `tests/rag/cache/decomposed-answer-key.test.ts`: a full v2 chat turn with a decomposed plan looks up a different
  systemPromptHash only when the entry point marks `cacheContext.decomposedAnswer`, RAG_DECOMPOSED_ANSWER is effective and the plan
  has two or more sub-questions; otherwise the caller's hash is looked up unchanged.
- GREEN: `decomposedAnswerTemplate` (block texts for a plan), `systemPromptHashWithBlocks` (switch-gated blocks folded in only while
  present, the G5 `queryAdditionsHashBlock` / SWITCH_GATED_PROMPT_IDS pattern), wired at the semantic_cache key in `run-layer.ts`.
- Tripwire for 06.2-23: an entry point that passes the block must mark its cacheContext.

## Gates
tsc, typecheck:new, tests/rag/v2/config-hash*, tests/rag/cache, tests/rag/query/parity-off, check-rag-boundary,
`npm run test-rag -- --fixture-mode ingest`.
