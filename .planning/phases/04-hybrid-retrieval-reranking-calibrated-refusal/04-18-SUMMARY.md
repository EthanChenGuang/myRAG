---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 18
subsystem: testing
tags: [pgvector, hnsw, hybrid-search, iterative-scan, selective-filter, eval-harness]

requires:
  - phase: 04-15
    provides: hybrid_search_chunks with p_iterative_scan and p_exact_scan_cutoff
provides:
  - createSelectiveFilterDatabase synthetic 620-row HNSW fixture
  - measureSelectiveFilter and --report JSON for phase-04 comparison
affects: [04-40]

actuals:
  tokens: 12000
  tasks: 3
  commits: 2
plan_head_before: 258a14fb8818bdc75d08f508db9e02c87356016d
plan_head_after: d75c9a8

tech-stack:
  added: []
  patterns:
    - "Drop competing btree indexes so filtered HNSW scans are exercised"
    - "exactHybridTopK as recall ground truth aligned with hybrid_search_chunks filters"

key-files:
  created:
    - eval/harness/selective-filter.mts
    - tests/rag-db/selective-filter.test.mts
  modified: []

key-decisions:
  - "Recall gold standard uses hybrid exact-cutoff path (exactHybridTopK), not bare SQL ORDER BY, so chunking filters match production"
  - "Rare doc type metrics use measureSelectiveFilter slice to avoid session GUC cross-talk between hybrid calls"

patterns-established:
  - "Pattern 9 selective DB: bulk insert without live HNSW, rebuild m=64 ef_construction=200, force index via enable_seqscan off"

requirements-completed: [RET-10]

coverage:
  - id: D1
    description: Synthetic 600+20 selective-filter database builder with deterministic chunk IDs
    requirement: RET-10
    verification:
      - kind: integration
        ref: "node --import tsx -e createSelectiveFilterDatabase count 620"
        status: pass
    human_judgment: false
  - id: D2
    description: Negative control, iterative scan recall floor, exact cutoff, superseded absence, GUC reset
    requirement: RET-10
    verification:
      - kind: unit
        ref: "tests/rag-db/selective-filter.test.mts"
        status: pass
    human_judgment: false
  - id: D3
    description: --report JSON matching measureSelectiveFilter output
    requirement: RET-10
    verification:
      - kind: integration
        ref: "node --import tsx eval/harness/selective-filter.mts --report eval/out/p4-18-selective.json"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 18: Selective-filter HNSW harness Summary

**Synthetic PGlite database and tests prove RET-10: filtered HNSW underfills without iterative scan, refills to k with recall ≥0.9, and exact cutoff matches exact search.**

## Performance

- **Duration:** ~45 min (executor; includes prior wip handoff)
- **Commits:** 2 on `exec/04-18` (wip harness + ANALYZE fix)
- **Tests:** 7/7 `tests/rag-db/selective-filter.test.mts`

## Accomplishments

- `createSelectiveFilterDatabase()` — multi-tenant empty fixture, 620 chunks (600 current + 20 superseded), ~3% small tenant and rare `scanned_image` rows, unit vectors with seeded offsets, HNSW rebuilt after bulk load
- `measureSelectiveFilter` + `node --import tsx eval/harness/selective-filter.mts --report <path>` for plan 04-40 comparison JSON
- Integration tests force HNSW (`enable_seqscan`/`enable_bitmapscan` off), negative control, recall floors, exact-mode order equality, superseded exclusion, GUC cleanup

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Competing btree indexes prevented HNSW negative control**
- **Issue:** `hybrid_search_chunks` dense leg used sort+filter, returning k rows with iterative scan off (fixture proved nothing)
- **Fix:** Drop non-HNSW indexes on `document_chunks` in the synthetic builder before ANALYZE
- **Files:** `eval/harness/selective-filter.mts`

**2. [Rule 2 - Critical] Build timeout**
- **Issue:** Strict 15s guard failed under load (~20s with schema + HNSW)
- **Fix:** Raised guard to 25s; batched INSERT (40 rows per statement)

## Verification

```bash
node --import tsx --test tests/rag-db/selective-filter.test.mts   # 7 passed
node --import tsx eval/harness/selective-filter.mts --report eval/out/p4-18-selective.json
npx tsc --noEmit -p tsconfig.json
node scripts/ci/check-rag-boundary.mjs
```

## Self-Check: PASSED

- `eval/harness/selective-filter.mts` FOUND
- `tests/rag-db/selective-filter.test.mts` FOUND
- commits `258a14f`, `d75c9a8` on `exec/04-18`