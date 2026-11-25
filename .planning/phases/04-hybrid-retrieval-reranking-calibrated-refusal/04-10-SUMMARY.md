---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 10
subsystem: testing
tags: [rerank, bm25, fixture-edge, vitest]

requires:
  - phase: 04-01
    provides: rerank types and completeScores
  - phase: 04-03
    provides: lexical tokenizer v2
  - phase: 04-05
    provides: fake edge embedding and PostgREST handlers
provides:
  - local_bm25 relative reranker on shared tokenizer
  - deterministic fakeRerankScores for eval and vitest
  - fake Cohere/Voyage rerank HTTP routes on the fixture edge
affects: [04-23, 04-28, 04-45, 04-21]

actuals:
  tokens: 18500
  tasks: 3
  commits: 3
plan_head_before: bb57b203b714320ab918e8c920d5917761615eb2
plan_head_after: 605f0b6ea8f8c2e8e8b3e9c0e9f7c8e8b3e9

tech-stack:
  added: []
  patterns:
    - Pool-normalized BM25 with scoreSemantics relative
    - Text-only fake reranker with per-script language offsets
    - Fixture edge serves only fake-* rerank model ids

key-files:
  created:
    - src/lib/rag/rerank/local-bm25.ts
    - eval/harness/fake-reranker.mts
    - tests/rag/rerank/local-bm25.test.ts
    - tests/rag/rerank/fake-reranker.test.ts
  modified:
    - eval/harness/fake-edge.mts
    - tests/rag/helpers/pipeline-fakes.ts
    - tests/fixture-edge.test.mts

key-decisions:
  - Rejection rerank tests use an isolated edge so shared error buffers stay clean for runRetrieval
  - fakeReranker maps fake-quality-v1 to cohere id and fake-fast-v1 to voyage id for adapter parity

patterns-established:
  - "Pattern: fake rerank scores = 0.6×cosine(fixture embed) + 0.4×IDF coverage + language offset"

requirements-completed: [RNK-01, XLG-03]

coverage:
  - id: D1
    description: local_bm25 scores Chinese queries via tokenizer v2 with relative semantics
    requirement: RNK-01
    verification:
      - kind: unit
        ref: tests/rag/rerank/local-bm25.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: deterministic fake reranker shared by vitest and eval harness
    requirement: RNK-01
    verification:
      - kind: unit
        ref: tests/rag/rerank/fake-reranker.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: fixture edge exposes vendor-shaped rerank endpoints for fake models only
    requirement: XLG-03
    verification:
      - kind: integration
        ref: tests/fixture-edge.test.mts
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 10: Local BM25 and fake reranker Summary

**Shared-tokenizer local_bm25 plus a text-only fake reranker wired through Cohere- and Voyage-shaped fixture edge routes.**

## Accomplishments

- `createLocalBm25Reranker` normalizes BM25 scores in-pool, supports `queryByDoc`, and keeps `local-hybrid.ts` unchanged.
- `fakeRerankScores` is pure text + options; `fakeReranker()` in pipeline-fakes adds delay/fail/partial/abort injection.
- Fake edge serves `/v2/rerank` and `/v1/rerank` for `fake-*` models only; `fixtureProcessEnv` sets rerank base URLs and placeholder keys.

## Deviations from Plan

None — plan executed as written.

## Verification

- `npx vitest run tests/rag/rerank tests/rag/local-hybrid.test.ts` — **pass** (50 tests)
- `node --import tsx --test tests/fixture-edge.test.mts` — **pass** (44 tests)
- `node scripts/ci/check-rag-boundary.mjs` — **pass**
- `node scripts/check-config.mjs` — **pass**
- `npx tsc --noEmit` — pre-existing errors in `tests/ui/config-rag-panels.test.ts` and `tests/rag/lexical/chunk-text.test.ts` (unchanged by this plan)

## Commits

| Task | Commit | Message |
| ---- | ------ | ------- |
| 1 | 30ce6f2 | feat(04-10): local BM25 reranker on shared tokenizer v2 |
| 2 | cff432b | feat(04-10): deterministic fake reranker for harness and vitest |
| 3 | 605f0b6 | feat(04-10): fake Cohere and Voyage rerank routes on fixture edge |

## Self-Check

- FOUND: src/lib/rag/rerank/local-bm25.ts
- FOUND: eval/harness/fake-reranker.mts
- FOUND: tests/rag/rerank/local-bm25.test.ts
- FOUND: tests/rag/rerank/fake-reranker.test.ts
- FOUND: 30ce6f2, cff432b, 605f0b6 on HEAD ancestry

## Self-Check: PASSED