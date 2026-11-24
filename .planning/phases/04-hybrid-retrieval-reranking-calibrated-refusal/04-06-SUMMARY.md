---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 06
subsystem: database
tags: [postgres, tsvector, lexical, pglite, migrations]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: lexical_text column, rag_write_chunks metadata, migrations harness
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: PGlite role shim (plan 04-05)
provides:
  - Lexical GIN index with verbatim tsvector builder (0401)
  - Service-role rag_relex_candidates / rag_relex_batch (0402)
affects: [04-16, 04-07, hybrid_search]

actuals:
  tokens: 52000
  tasks: 2
  commits: 2
plan_head_before: f4eaa7425c3216d38ab8d666a562c28e3910aaed
plan_head_after: 5e7d9dc

tech-stack:
  added: []
  patterns:
    - "Plain nullable lexical_tsv maintained by BEFORE INSERT OR UPDATE trigger (no table rewrite)"
    - "rag_lexical_tsvector builds positional lexemes without to_tsvector"
    - "Backfill paging via lexical_version IS DISTINCT FROM target version"

key-files:
  created:
    - supabase/migrations/0401_lexical_index.sql
    - supabase/migrations/0402_relex_batch.sql
    - tests/rag-db/lexical-index.test.mts
  modified: []

key-decisions:
  - "Revoked rag_lexical_tsvector/tsquery from anon and authenticated so schema-migrations grant sweep stays clean"
  - "Trigger syncs lexical_version from metadata only when lexical_text changes or metadata carries a positive integer"

patterns-established:
  - "Lexical builders are IMMUTABLE SQL functions with search_path pinned to pg_catalog"

requirements-completed: [RET-03, RET-02]

coverage:
  - id: D1
    description: "0401 lexical index migration with verbatim builders and trigger-maintained tsvector"
    requirement: RET-03
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/lexical-index.test.mts"
        status: pass
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/schema-migrations.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "0402 service-role relex batch RPCs for rag:relex"
    requirement: RET-02
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/lexical-index.test.mts (0402 describe)"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 06: Lexical index and relex batch RPCs

**Verbatim application-token tsvector index plus service-role batch functions for the lexical backfill, without rewriting document_chunks or its HNSW index.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 2
- **Commits:** 2

## Accomplishments

1. **0401** — `lexical_tsv` / `lexical_version` columns, `rag_lexical_tsvector` / `rag_lexical_tsquery`, trigger `trg_document_chunks_lexical_tsv`, GIN + btree indexes; no `to_tsvector('simple', …)`.
2. **0402** — `rag_relex_candidates` and `rag_relex_batch` with REVOKE from PUBLIC/anon/authenticated and GRANT to `service_role` only.
3. **PGlite tests** — `tests/rag-db/lexical-index.test.mts` (both deployment modes for 0401; multi-tenant for 0402).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Revoke builder functions from client roles**
- **Found during:** Task 1 verification (`schema-migrations` grant sweep)
- **Issue:** Default privileges left `rag_lexical_tsvector` / `rag_lexical_tsquery` executable by anon/authenticated.
- **Fix:** Added REVOKE/GRANT lines in 0401 alongside the trigger function.
- **Files modified:** `supabase/migrations/0401_lexical_index.sql`
- **Commit:** 0e37ba6

None otherwise — plan executed as written.

## Tests

| Command | Result |
|---------|--------|
| `node --import tsx --test tests/rag-db/lexical-index.test.mts` | pass (18) |
| `node --import tsx --test tests/rag-db/schema-migrations.test.mts tests/rag-db/lexical-index.test.mts` | pass (46) |
| `node scripts/ci/check-rag-boundary.mjs` | pass |
| `node scripts/check-config.mjs` | pass |
| `python3 scripts/ci/check-workflows.py` | pass |
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | fail (pre-existing `tests/ui/config-rag-panels.test.ts` errors; untouched by this plan) |

`npm run test-rag -- --out eval/out/p4-06` not run here (orchestrator / eval sandbox).

## Self-Check: PASSED

- FOUND: `supabase/migrations/0401_lexical_index.sql`
- FOUND: `supabase/migrations/0402_relex_batch.sql`
- FOUND: `tests/rag-db/lexical-index.test.mts`
- FOUND: commit 0e37ba6
- FOUND: commit 5e7d9dc