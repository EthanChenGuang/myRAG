---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 45
subsystem: api
tags: [rerank, vitest, cohere, voyage, bm25]

requires:
  - phase: 04-01
    provides: Reranker contract and RERANK_TEXT_VERSION
  - phase: 04-02
    provides: V2Config reranker tiers and voyageModelByLang
  - phase: 04-09
    provides: Cohere and Voyage HTTP adapters
  - phase: 04-10
    provides: local_bm25 reranker
provides:
  - rerankText with codepoint prefixLength and legacy chunk prefix strip
  - resolveReranker with tier and language model mapping and eval-only overrides
  - setRerankerFactoryForTests / resetRerankerFactoryForTests hooks
affects: [04-23, 04-28, 04-34]

actuals:
  tokens: 12000
  tasks: 2
  commits: 3
plan_head_before: a176cdbd609ced93e3baeac7d8366cb82c4b98b2
plan_head_after: f218a3b

tech-stack:
  added: []
  patterns:
    - Shared legacy-prefix strip for rerank text (distinct from lexical chunk title promotion)
    - Hosted reranker keys read from RagEnvInput at factory time, never stored on RagConfig

key-files:
  created:
    - src/lib/rag/rerank/text.ts
    - src/lib/rag/rerank/select.ts
    - tests/rag/rerank/text.test.ts
    - tests/rag/rerank/select.test.ts
  modified: []

key-decisions:
  - Missing API key warnings name COHERE_API_KEY or VOYAGE_API_KEY only and log once per process
  - Eval retrieval_overrides reranker and rerankModel apply only when profile is eval

patterns-established:
  - "Pattern: rerankText prefixLength = Array.from(section-path prefix).length for span mapping"

requirements-completed: [RNK-01, LAT-02, XLG-03]

coverage:
  - id: D1
    description: Versioned rerank text builder strips legacy chunk prefix and counts codepoint prefix length
    requirement: RNK-01
    verification:
      - kind: unit
        ref: tests/rag/rerank/text.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Reranker selection maps provider, entry-point tier, and Voyage per-language models
    requirement: LAT-02
    verification:
      - kind: unit
        ref: tests/rag/rerank/select.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: Eval-only rerank overrides and missing-key handling without key leakage
    requirement: XLG-03
    verification:
      - kind: unit
        ref: tests/rag/rerank/select.test.ts#resolveReranker keys and eval overrides
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 45: Rerank text and selection helpers Summary

**Pure `rerankText` and `resolveReranker` modules so plan 04-23 can score versioned chunk text and pick Cohere, Voyage, or local BM25 by entry-point tier without logging API keys.**

## Accomplishments

- `rerankText` joins `sectionPath` with ` > `, strips the `Document: … Chunk n of m. Content:` prefix, and returns `prefixLength` in codepoints via `Array.from`.
- `resolveReranker` maps tiers (chat/embed/eval vs voice), Voyage `voyageModelByLang` overrides, `local_bm25`, and `none`; builds adapters through injectable factory using `env` keys and `fetch`.
- Eight unit tests cover tier/model matrix, missing keys, eval-only overrides, and test factory hooks.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Circular `typeof fetch` in resolveReranker signature**
- **Found during:** Task 2 verification (`tsc --noEmit`)
- **Issue:** Parameter named `fetch` with type `typeof fetch` caused TS2502 self-reference
- **Fix:** Introduced `FetchFn = typeof globalThis.fetch` and renamed parameter to `fetchImpl`
- **Files modified:** `src/lib/rag/rerank/select.ts`
- **Commit:** f218a3b

## Verification

| Gate | Result |
|------|--------|
| `npx vitest run tests/rag/rerank/text.test.ts tests/rag/rerank/select.test.ts` | 13 passed |
| `npm run typecheck:new` | pass (pre-existing diagnostics elsewhere) |
| `npx tsc --noEmit -p tsconfig.json` | no errors in new modules after fix |
| `node scripts/ci/check-rag-boundary.mjs` | ok |
| `node scripts/check-config.mjs` | ok |

## Self-Check: PASSED

- FOUND: `src/lib/rag/rerank/text.ts`
- FOUND: `src/lib/rag/rerank/select.ts`
- FOUND: `tests/rag/rerank/text.test.ts`
- FOUND: `tests/rag/rerank/select.test.ts`
- FOUND commit: a5b7a12
- FOUND commit: edf15cd
- FOUND commit: f218a3b