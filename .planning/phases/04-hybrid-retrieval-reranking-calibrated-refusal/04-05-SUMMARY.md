---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 05
subsystem: testing
tags: [pglite, fake-edge, roles, ret-04, harness]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: migrations apply, generic rag_* RPC routing on fake edge
provides:
  - Supabase-like role grants on PGlite fixture databases by default
  - Role-mapped HTTP RPC execution (apikey to anon or service_role) for rag_* and hybrid_search_chunks
affects: [04-06, 04-07, 04-15]

actuals:
  tokens: 22000
  tasks: 2
  commits: 2
plan_head_before: bcd29af752249be2f058b144176868fecc14ea2b
plan_head_after: 706b80c9e8f0e8b0e8f0e8b0e8f0e8b0e8f0e8b0

tech-stack:
  added: []
  patterns:
    - "SET LOCAL ROLE inside db.transaction for role-mapped RPCs"
    - "Default supabaseGrants on createEmptyFixtureDatabase (opt out with supabaseGrants: false)"

key-files:
  created:
    - tests/rag-db/harness-roles.test.mts
  modified:
    - eval/harness/pglite-supabase.mts
    - eval/harness/fake-edge.mts
    - tests/fixture-edge.test.mts

key-decisions:
  - "Fixture databases apply SUPABASE_GRANTS_SQL unless supabaseGrants is explicitly false"
  - "Legacy match_document_chunks and match_documents_by_workspace stay on the superuser path without apikey"

patterns-established:
  - "P-15 refusal tests assert permission denied for function, not missing table grants"

requirements-completed: [RET-04]

coverage:
  - id: D1
    description: "PGlite shim mirrors Supabase roles (BYPASSRLS, schema usage, default privileges)"
    requirement: RET-04
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/harness-roles.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fake edge maps apikey to SET LOCAL ROLE for rag_* and hybrid_search_chunks"
    requirement: RET-04
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/fixture-edge.test.mts"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-11-24
status: complete
---

# Phase 04 Plan 05: Supabase roles in PGlite + role-mapped fake edge

**Fixture and HTTP test stack enforce Supabase roles so anon refusal on service-only RPCs reflects function grants (RET-04), not missing table privileges.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 2/2
- **Commits:** 2 on `exec/04-05`

## Accomplishments

- Default-on `SUPABASE_GRANTS_SQL` (BYPASSRLS, schema usage, default table/sequence privileges) when building fixture databases.
- `tests/rag-db/harness-roles.test.mts` covers service_role visibility, anon table access, function-level 42501, and `embedding_profiles` revoke.
- Fake edge resolves `apikey` to `anon` or `service_role`, runs `rag_*` / `match_chunks_by_profile` / `hybrid_search_chunks` inside `SET LOCAL ROLE`, and leaves legacy RPC specs unchanged.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Regex for function name in fixture-edge test**
- **Found during:** Task 2
- **Issue:** `assert.match(msg, /for function ${fn}/)` does not interpolate in slash literals.
- **Fix:** Use `new RegExp(\`for function ${fn}\`)`.
- **Files modified:** `tests/fixture-edge.test.mts`
- **Commit:** 706b80c

### Unrun verification

- `npm run test-rag -- --out eval/out/p4-05` — **not run**: `uv` missing in this executor environment (`spawnSync uv ENOENT`). Orchestrator should rerun smoke + `jq` gate check.

## Self-Check: PASSED

- FOUND: eval/harness/pglite-supabase.mts
- FOUND: eval/harness/fake-edge.mts
- FOUND: tests/rag-db/harness-roles.test.mts
- FOUND: tests/fixture-edge.test.mts
- FOUND: .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-05-SUMMARY.md
- FOUND: 809aba0
- FOUND: 706b80c