---
quick_id: 261127-hbq
slug: hash-bench
date: 2026-11-27
branch: exec/quick-62-hash-bench
base: origin/ci/merge-train-39
source: .planning/phases/06.2-query-layer-additions/06.2-VERIFICATION.md (verify/06.2), gaps G5 and G7
---

# Quick 261127-hbq: query-addition switches in the config hash (G5), stable scope-score benchmark (G7)

## Task 1 (G5, TDD)
- RED: `tests/rag/v2/config-hash-query.test.ts` and `tests/rag/cache/query-additions-key.test.ts`: at the defaults the hash and the
  cache key are unchanged; each of completeness, historyFallback, langidSidecar and scopeGate at its non-default value changes them;
  a full v2 chat turn looks up a different cache key after each env flip.
- GREEN: `queryAdditionsHashBlock` in `src/lib/rag/query/hash-part.ts` (only non-default effective values, the subq-filters /
  SWITCH_GATED_PROMPT_IDS pattern), joined to the query-layer hash part as `additions`; `pipeline.ts` passes
  `config.queryAdditions.effective`.

## Task 2 (G7)
- `tests/rag/scope/score.test.ts` benchmark: serial suite, warm-up, best p99 of three rounds of 300 (train 26 validator pattern).
  The 5 ms bound is unchanged and the test is not skipped.

## Gates
tsc, typecheck:new, tests/rag/v2/config-hash*, tests/rag/cache, tests/rag/scope, `npm run test-rag -- --fixture-mode ingest`.
