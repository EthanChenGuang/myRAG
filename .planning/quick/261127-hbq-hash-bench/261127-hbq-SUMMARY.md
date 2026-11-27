---
quick_id: 261127-hbq
slug: hash-bench
status: complete
date: 2026-11-27
branch: exec/quick-62-hash-bench
base: origin/ci/merge-train-39
gaps: [06.2-G5, 06.2-G7]
key-files:
  created:
    - tests/rag/cache/query-additions-key.test.ts
    - .planning/quick/261127-hbq-hash-bench/261127-hbq-PLAN.md
  modified:
    - src/lib/rag/query/hash-part.ts
    - src/lib/rag/v2/config-hash.ts
    - src/lib/rag/v2/pipeline.ts
    - tests/rag/v2/config-hash-query.test.ts
    - tests/rag/scope/stage.test.ts
    - tests/rag/scope/score.test.ts
---

# Quick 261127-hbq: query-addition switches in the config hash (G5), stable scope-score benchmark (G7)

## G5: completeness, historyFallback, langidSidecar and scopeGate in the hash and cache key
- `queryAdditionsHashBlock` (`src/lib/rag/query/hash-part.ts`) keeps only the switches whose effective value differs from its
  default (`QUERY_ADDITION_HASH_DEFAULTS`: completeness true, historyFallback true, langidSidecar false, scopeGate false). The
  block joins the query-layer hash part as `additions` only when it is not empty, the same switch-gated way as
  `SWITCH_GATED_PROMPT_IDS` / shared.subq-filters (train 38).
- `queryLayerHashFor` in `src/lib/rag/v2/pipeline.ts` passes `config.queryAdditions.effective`. The query-layer part is computed only
  while the layer is on, so with the layer off nothing changes. With the layer on at the defaults the hash, and with it the cache key
  (`retrievalConfigHash` is a key part), is byte-identical to before.
- Behaviour change: with the layer on, setting RAG_QUERY_DECOMPOSE_COMPLETENESS=false, RAG_QUERY_HISTORY_FALLBACK=false,
  RAG_LANGID_SIDECAR=true or RAG_SCOPE_GATE=true now gives a new retrieval-config hash and cache key, so earlier cache entries are
  no longer served after a flip.
- RED (commit 8268a232) failed on assertions (10 tests: hash, key and full-pipeline cache lookup stayed equal after each flip).
- `tests/rag/scope/stage.test.ts` "switch off ... equals a gate that labels in_scope" compared whole results; the hash now differs by
  design, so the comparison leaves `retrievalConfigHash` out and asserts it differs.

## G7: scope/score p99 < 5 ms benchmark
- Serial suite (`{ concurrent: false }`; vitest 5.1.1 has no `describe.sequential`), 30 warm-up calls, then the best p99 of three
  rounds of 300 calls (train 26 validator pattern, 4220f0cd). Bound unchanged at 5 ms; the test is not skipped.
- Passed alone and inside the full parallel `npx vitest run`.

## Commits
- 8268a232 test: RED hash and cache-key tests (G5)
- 49cdba7d fix: non-default query-addition switches enter the hash (G5), stage test follows
- 59ee8750 test: benchmark serial, warm-up, best of three (G7)
- follow-up test commit: typed `{ concurrent: false }` suite option
- this SUMMARY

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: no errors
- `npx vitest run tests/rag/v2/config-hash* tests/rag/cache tests/rag/scope` plus every test file importing the changed modules
  (38 files, 629 tests): pass
- full `npx vitest run` (config-hash.ts is shared): 853 files passed, 3 skipped; 16136 tests passed, 90 skipped
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`,
  `node scripts/ci/check-settings-classification.mjs`: pass
- `npm run test-rag -- --fixture-mode ingest --out eval/out/quick-62-ingest`: absolute gate PASS, gate PASS (8 skipped)

## Deviations
- `tests/rag/scope/stage.test.ts` changed (see G5): the result equality it checked now intentionally excludes the hash.
- No new env variable, migration or package.

## Operator / deferred
- None. The layer-on baseline re-record (06.2-22) is unaffected at the defaults.
