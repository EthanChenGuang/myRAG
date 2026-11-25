---
phase: 06-query-layer-llamaindex-langchain
plan: 04
subsystem: database
tags: [postgres, pglite, service-role, tenant-key, language-shares]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: rag_assert_tenant_key (04-07), role-enforcing PGlite harness and fake edge (04-05), hybrid_search_chunks grant pattern (04-15)
  - phase: 03-unified-ingestion-embedding-profiles
    provides: documents.tenant_key, is_current, status ('ready'), language
provides:
  - public.rag_tenant_language_shares(p_tenant_key text) -> (language, share, docs), service_role only
  - PGlite suite covering shares, exclusions, key guard, grants, fake edge, two-tenant isolation and re-apply
affects: [06-16, 06-23, 06-42, 06-45, 06-46]

actuals:
  tokens: 3900
  tasks: 2
  commits: 3
plan_head_before: 21f611b66cf9dc61cd3f1cf423a4524c9b90954a
plan_head_after: 0baf836b08b565a715e8623a2eff2f76573b76f4

tech-stack:
  added: []
  patterns:
    - "Tenant-keyed read function: SECURITY INVOKER, SET search_path = '', rag_assert_tenant_key first, REVOKE FROM PUBLIC, anon, authenticated, GRANT to service_role"

key-files:
  created:
    - supabase/migrations/0601_tenant_language_shares.sql
    - tests/rag-db/language-shares.test.mts
  modified: []

key-decisions:
  - "search_path is '' with schema-qualified names (executor rule), not the plan's pg_catalog, public; the test asserts it"
  - "Finished-document literal is 'ready' (0301 documents_status_check); A-10 resolved by the exclusion test"
  - "Rows ordered by docs DESC, language so callers can take the top two languages directly"

requirements-completed: [XLG-01]

coverage:
  - id: D1
    description: "Per-tenant language shares over current ready documents with a language; empty for a tenant without documents"
    requirement: XLG-01
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/language-shares.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Key guard (22023), anon/authenticated 42501 via SET ROLE and fake edge, no PUBLIC grant, two-tenant isolation, migrations re-apply"
    requirement: XLG-01
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/language-shares.test.mts tests/rag-db/schema-migrations.test.mts tests/rag-db/hybrid-grants.test.mts"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-11-25
status: complete
---

# Phase 6 Plan 04: rag_tenant_language_shares Summary

**Migration 0601 adds `rag_tenant_language_shares(p_tenant_key)`, a service-role-only function that returns the language shares of a tenant's knowledge base. It reads only current, ready documents with a known language and validates the tenant key before reading any row.**

## Accomplishments

- `0601_tenant_language_shares.sql`: plpgsql, VOLATILE, SECURITY INVOKER, `SET search_path = ''`, `PERFORM public.rag_assert_tenant_key(p_tenant_key)` first, share = count / window sum, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE ... TO service_role`, `NOTIFY pgrst`.
- 30 PGlite tests across both deployment modes:
  - 6 zh + 2 en gives 0.75 / 0.25 with docs 6 / 2; a non-current version, processing, quarantined and failed documents, and NULL language are excluded.
  - NULL, `x:1`, an upper-case uuid key and the other mode's key raise 22023.
  - anon and authenticated get 42501, both via SET ROLE and through the fake edge's anon key; the service key returns rows; the ACL has no PUBLIC, anon or authenticated EXECUTE.
  - Two tenants: A (zh), B (it, en) and org O (de) each see only their own languages. A well-formed but unknown key returns nothing.
  - Applying every migration a second time keeps the shares and the grants.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1+2 RED | b151ca2 | test(06-04): add failing tests for rag_tenant_language_shares |
| 1 GREEN | 0baf836 | feat(06-04): add rag_tenant_language_shares migration 0601 |

RED failed 30/30 on assertions (42883 function does not exist, caught by the assertion predicates); GREEN passes 30/30.

## Gates

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit` | 0 errors |
| `npx vitest run` | pass |
| `node --import tsx --test tests/*.test.mts` | pass |
| `node --import tsx --test tests/rag-db/*.test.mts` | 824 pass, 0 fail, 2 cancelled, 3 skipped; exit 1 only from `ingestion-ledger-pg.test.mts` (see below) |
| rag boundary check + its node test | pass |
| `node scripts/check-config.mjs` | pass |
| `check-workflows.py` | pass |
| `npm run test-rag -- --out eval/out/06-04` | gate PASS (7 skipped) |
| `npm run test-rag -- --fixture-mode ingest --out eval/out/06-04-ingest` | gate PASS (7 skipped) |

Python and contracts were not touched, so the sidecar/eval pytest suites and `gen:schemas` were not run.

**Pre-existing / environmental:** `tests/rag-db/ingestion-ledger-pg.test.mts` (optional real-PostgreSQL suite) fails in its `before` hook. `pg_ctl initdb` exits with "pg_ctl: cannot be run as root" before any repository SQL runs. The container runs as root, and the failure is independent of this change.

## Deviations from Plan

- `SET search_path = ''` with schema-qualified names (`public.documents`, `public.rag_assert_tenant_key`, `pg_catalog.count/sum`) instead of the plan's `pg_catalog, public`. The executor brief requires the empty path. A test pins it.
- Task 2's two-tenant and re-apply cases were written in the same RED commit as Task 1's, so Task 2 has no separate commit and needed no change to 0601.
- Migration number 0601 was free; no renumbering.

## Operator actions

- Apply `supabase/migrations/0601_tenant_language_shares.sql` on existing projects (after 0412). Plan 06-45 folds it into the setup files, and plan 06-46 checks the live grants.

## Deferred

- The in-process 10-minute cache and the translation trigger belong to plans 06-16 and 06-23.

## Self-Check: PASSED
