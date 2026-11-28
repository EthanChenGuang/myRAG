---
phase: 06-query-layer-llamaindex-langchain
plan: 08
subsystem: database
tags: [postgres, pglite, hybrid-search, date-filter, service-role]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: hybrid_search_chunks (0407), grant pattern and fake-edge tests (04-15), rag_assert_tenant_key (04-07)
  - phase: 06-query-layer-llamaindex-langchain
    provides: 06-04 orders the PGlite migration plans (0601)
provides:
  - public.hybrid_search_chunks(..., p_include_undated boolean DEFAULT false), the only overload, service_role only
  - PGlite suite for undated rows on both legs, Phase 4 equality, overload count, grants and two-tenant isolation
affects: [06-24]

actuals:
  tokens: 9000
  tasks: 2
  commits: 4
plan_head_before: 0a6b7a02386c54b340c9763e27901c3f26578a14

tech-stack:
  added: []
  patterns:
    - "Widen a published function: DROP FUNCTION IF EXISTS on the exact old signature, CREATE the new one, REVOKE/GRANT on the new signature, NOTIFY pgrst, in one transaction"

key-files:
  created:
    - supabase/migrations/0602_hybrid_include_undated.sql
    - tests/rag-db/hybrid-include-undated.test.mts
  modified:
    - tests/rag-db/hybrid-grants.test.mts

key-decisions:
  - "search_path is '' (executor rule) instead of 0407's pg_catalog, public: every table is public-qualified, the temp table is pg_temp-qualified, pgvector is OPERATOR(public.<=>), public.vector / public.halfvec / public.vector_dims. Same pgvector-in-public assumption 0407 already made"
  - "The date predicate is chosen in plpgsql: flag false, NULL or omitted uses the 0407 predicate text verbatim; true adds OR c.doc_date IS NULL to each bound. Without a range the flag is a no-op"
  - "Phase 4 equality is proven by dropping 0602, re-applying 0407 in the same database, and comparing rows for the same calls"
  - "The 0407 CREATE INDEX statements are not repeated (they already exist)"

requirements-completed: [LAT-03]

coverage:
  - id: D1
    description: "Date range with p_include_undated true keeps in-range and undated chunks on dense and lexical legs, never out-of-range; open-ended ranges; flag false/NULL/omitted drops undated; no range means no change; tenant key guard unchanged"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/hybrid-include-undated.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Without the flag, rows equal the 0407 function exactly; exactly one hybrid_search_chunks after 0602 (also after re-applying 0407 then 0602)"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/hybrid-include-undated.test.mts tests/rag-db/hybrid-search.test.mts tests/rag-db/hybrid-filters.test.mts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Grants on the new signature: anon/authenticated 42501 (SET ROLE and fake edge with the flag), service_role rows, no PUBLIC ACL; tenant A never gets tenant B's undated chunk"
    requirement: LAT-03
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/hybrid-grants.test.mts tests/rag-db/hybrid-tenant.test.mts tests/rag-db/hybrid-include-undated.test.mts"
        status: pass
    human_judgment: false

duration: 40min
completed: 2026-11-25
status: complete
---

# Phase 6 Plan 08: hybrid_search_chunks p_include_undated Summary

**Migration 0602 replaces `hybrid_search_chunks` with a version that takes a trailing `p_include_undated boolean DEFAULT false`. With true and a date range, chunks without a `doc_date` pass the date filter on both legs. The default keeps Phase 4 results exactly. The old signature is dropped in the same transaction, so only one function exists.**

## Accomplishments

- `0602_hybrid_include_undated.sql`: `DROP FUNCTION IF EXISTS` on the exact 0407 argument list, then CREATE with the 0407 body. Only two things change: the date predicate and the schema qualification for `search_path = ''`. SECURITY INVOKER, `rag_assert_tenant_key` first, every tenant, current, status and filter predicate unchanged. `REVOKE ALL ... FROM PUBLIC, anon, authenticated` and `GRANT EXECUTE ... TO service_role` on the new signature, then `NOTIFY pgrst`.
- `hybrid-include-undated.test.mts` (12 tests): flag on and off on both legs, open-ended ranges, NULL flag, no-range no-op, tenant guard (22023), two-tenant undated isolation, overload count and argument order, and row equality against the re-applied 0407 function.
- `hybrid-grants.test.mts`: fake edge with the flag (anon 403/42501, service 200), single overload, `has_function_privilege` matrix and no PUBLIC ACL entry, SET ROLE anon/authenticated refused on the new signature. A mutation run without the REVOKE fails 4 of these cases.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 (RED) | 4f7222e | test(06-08): add failing tests for hybrid_search_chunks p_include_undated |
| 1 (GREEN) | 7109b80 | feat(06-08): add p_include_undated to hybrid_search_chunks in migration 0602 |
| 2 | 9d95763 | test(06-08): cover grants on the 0602 hybrid_search_chunks signature |

## Tests that failed before the change

All 12 cases in `hybrid-include-undated.test.mts` failed on the base. Calls with the flag failed because the function had no such parameter, and the overload test failed its signature assertion.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 222 files, 3370 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 163/163
- `node --import tsx --test tests/rag-db/*.test.mts`: 844 passed, 0 failed test cases. The only failing suite is `ingestion-ledger-pg.test.mts` (run as root); this failure was already known on the base.
- Boundary check and its tests, `check-config`, `check-workflows`: pass
- `npm run test-rag -- --out eval/out/06-08` and `--fixture-mode ingest --out eval/out/06-08-ingest`: gate PASS (7 skipped)
- No Python or contract files touched.

## Deviations

- `search_path = ''` with fully qualified names and `OPERATOR(public.<=>)`, where 0407 used `pg_catalog, public` (executor security rule).
- Migration number 0602 was free and is used as planned.

## Operator actions

- Apply `supabase/migrations/0602_hybrid_include_undated.sql` after 0601 on both deployment modes. This is a one-way change: it replaces a published function signature. Existing callers that omit the new parameter keep working.

## Deferred

- The app does not pass `p_include_undated` yet; plan 06-24 adds that.
