---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 07
subsystem: database
tags: [postgres, pglite, parents, chunking-profiles, tenant-guard]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: 04-05 PGlite role shim, 04-06 lexical columns (0401/0402)
provides:
  - rag_assert_tenant_key per deployment mode (0403)
  - document_parents, child columns, variant invariant, rag_fetch_parents (0404/0405)
  - chunking_profiles registry with legacy active seeds (0406)
affects: [04-15, 04-33, 04-42]

actuals:
  tokens: 95000
  tasks: 3
  commits: 4
  plan_head_before: db3776c50d12eb6a56c67e6752837d99442b8a74
  plan_head_after: 1671347

tech-stack:
  added: []
  patterns:
    - "Central rag_assert_tenant_key with mode-specific deployment errors"
    - "Side-by-side chunks forced to status variant when chunking_profile_id is not legacy"

key-files:
  created:
    - supabase/migrations/0403_tenant_key_guard.multi-tenant.sql
    - supabase/migrations/0403_tenant_key_guard.single-tenant.sql
    - supabase/migrations/0404_document_parents.sql
    - supabase/migrations/0405_document_parents_rls.multi-tenant.sql
    - supabase/migrations/0405_document_parents_rls.single-tenant.sql
    - supabase/migrations/0406_chunking_profiles.sql
    - tests/rag-db/parents-schema.test.mts
  modified: []

key-decisions:
  - "Non-legacy chunking_profile_id never retains status ready; legacy RPC filters unchanged"
  - "Legacy chunking profile id legacy on every existing chunk via DEFAULT without heap rewrite"

requirements-completed: [CHK-03, CHK-04, RET-04]

coverage:
  - id: D1
    description: Mode-specific tenant key guard callable only by service_role
    requirement: RET-04
    verification:
      - kind: unit
        ref: "tests/rag-db/parents-schema.test.mts#rag_assert_tenant_key"
        status: pass
    human_judgment: false
  - id: D2
    description: Parent table, variant invariant, RLS and rag_fetch_parents
    requirement: CHK-03
    verification:
      - kind: unit
        ref: "tests/rag-db/parents-schema.test.mts"
        status: pass
      - kind: unit
        ref: "tests/rag-db/schema-migrations.test.mts"
        status: pass
    human_judgment: false
  - id: D3
    description: Chunking profile registry with one active legacy row per doc type
    requirement: CHK-04
    verification:
      - kind: unit
        ref: "tests/rag-db/parents-schema.test.mts#chunking_profiles"
        status: pass
    human_judgment: false

duration: 0min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 07: Parent-child schema and chunking registry Summary

**Inert PostgreSQL schema for parents, profile-aware children, and per-doc-type chunking profiles with a shared tenant-key guard.**

## Performance

- **Duration:** n/a (executor session)
- **Tasks:** 3/3
- **Files:** 7 created

## Accomplishments

1. **0403** — `rag_assert_tenant_key` in each mode with lower-case-only UUID regex; multi-tenant rejects `s:default`, single-tenant rejects `u:`/`o:` keys.
2. **0404–0405** — `document_parents`, `parent_id` / `chunking_profile_id` on chunks, `variant` status for non-legacy profiles, `rag_fetch_parents`, RLS mirroring `document_chunks`.
3. **0406** — `chunking_profiles` with six active `legacy` seeds and `rag_list_chunking_profiles`.

## Tests

| Command | Result |
|---------|--------|
| `node --import tsx --test tests/rag-db/parents-schema.test.mts` | 17/17 pass |
| `node --import tsx --test tests/rag-db/schema-migrations.test.mts` | pass (incl. trigger EXECUTE revoke) |
| `node scripts/ci/check-rag-boundary.mjs` | ok |
| `node scripts/check-config.mjs` | ok |
| `python3 scripts/ci/check-workflows.py` | ok |
| `npm run test-rag -- --out eval/out/p4-07` | **skipped** — `uv` not on PATH in this worktree; orchestrator should rerun |
| `npx tsc --noEmit` | pre-existing errors in `tests/ui/config-rag-panels.test.ts` (unchanged by this plan) |

## Deviations from Plan

None — plan executed as written. Eval smoke gate deferred per environment (`uv` ENOENT).

## Self-Check

- [x] Migration files 0403–0406 present
- [x] parents-schema.test.mts present
- [x] Commits 88ac870, c11badb, 5e22b68 on `exec/04-07`