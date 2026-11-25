---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 15
subsystem: database
tags: [postgres, pgvector, hybrid-search, pglite, service-role]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: rag_assert_tenant_key, lexical index, chunking_profiles, PGlite roles
provides:
  - hybrid_search_chunks RPC with dense and lexical legs, filters before ranking
  - Service-role-only grants and four PGlite test suites
affects: [04-17, 04-19, 06-08, 07-06]

actuals:
  tokens: 98000
  tasks: 3
  commits: 4
plan_head_before: 4eccd716915552bee87555492c88c741c01f1163
plan_head_after: c5fd74dbad3a6f45a6bc2530d5dd82c840406ad9

tech-stack:
  added: []
  patterns:
    - "Effective chunking profile temp table with legacy-row fallback per document"
    - "Invoice filters joined on documents before leg ranking"
    - "hnsw.ef_search clamp per dense call"

key-files:
  created:
    - supabase/migrations/0407_hybrid_search_chunks.sql
    - tests/rag-db/hybrid-search.test.mts
    - tests/rag-db/hybrid-grants.test.mts
    - tests/rag-db/hybrid-tenant.test.mts
    - tests/rag-db/hybrid-filters.test.mts
  modified: []

key-decisions:
  - "strpos(lower()) for supplier substring match to avoid LIKE wildcard semantics"
  - "Empty p_sources requires cardinality > 0 when array is non-null (P-12)"

requirements-completed: [RET-02, RET-03, RET-04, RET-10, DATA-08]

coverage:
  - id: D1
    description: "hybrid_search_chunks returns both legs with profile routing and dense_mode"
    requirement: RET-02
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/hybrid-search.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Tenant isolation and legacy fallback stay inside tenant scope"
    requirement: RET-04
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/hybrid-tenant.test.mts"
        status: pass
    human_judgment: false
  - id: D3
    description: "DATA-08 and DATA-09 filters narrow both legs before ranking"
    requirement: DATA-08
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/hybrid-filters.test.mts"
        status: pass
    human_judgment: false

duration: 120min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 15: hybrid_search_chunks Summary

**Service-role `hybrid_search_chunks` fuses filtered dense and lexical legs in one call with chunking-profile fallback, invoice filters, and PGlite proof of grants and tenant isolation.**

## Accomplishments

- Added `0407_hybrid_search_chunks.sql` with `rag_assert_tenant_key`, profile-aware chunk predicate, halfvec routing, `iterative_scan_unsupported` guard, indexes, and PostgREST notify.
- Proved anon and authenticated refusal in PGlite and through the fake edge; service_role returns rows.
- Two-tenant and filter suites cover workspace subset checks, legacy fallback, DATA-08 date and language filters, and DATA-09 invoice predicates.

## Tests

| Suite | Result |
|-------|--------|
| `hybrid-search.test.mts` | 13 passed |
| `hybrid-grants.test.mts` | 4 passed |
| `hybrid-tenant.test.mts` | 11 passed |
| `hybrid-filters.test.mts` | 7 passed |
| Named `legacy fallback` TAP grep | pass |

`npm run test-rag -- --out eval/out/p4-15` skipped: `uv` not available in this environment (orchestrator rerun per p3-common).

## Deviations from Plan

None for migration shape. `test-rag` parity gate not executed here due to missing `uv`.

## Self-Check: PENDING