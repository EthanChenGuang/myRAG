---
phase: 05-verified-citations-groundedness
plan: 06
subsystem: database
tags: [supabase, rls, migrations, answer-records, tenant-key, pglite]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: supabase/migrations layout, name ordering in eval/harness/migrations.mts, generated tenant_key expression (03-01)
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: PGlite role shim with anon, authenticated, service_role and auth.uid() (04-05); latest setup fold (04-42)
provides:
  - public.rag_answer_records in both modes (id = answerId, no default; chat_id nullable, cascades from chats; no reference to documents or chunks)
  - tenant_key generated column (s:default single-tenant; o:<org> / u:<user> multi-tenant)
  - select-own RLS for authenticated, no client write grant or policy, service_role writes only
affects: [05-09, 05-25, 05-26]

actuals:
  tokens: 60000
  tasks: 2
  commits: 5
plan_head_before: b4ec4a8
plan_head_after: d0cad33

tech-stack:
  added: []
  patterns:
    - "A table whose FK target exists in only one mode takes that FK in the mode file (organization_id → organizations in 0502 multi-tenant), added through a pg_constraint guard so the file stays idempotent"
    - "Client-facing tables in this harness must REVOKE explicitly: the Supabase default privileges grant ALL on new public tables to anon and authenticated"

key-files:
  created:
    - supabase/migrations/0501_rag_answer_records.sql
    - supabase/migrations/0502_rag_answer_records_tenant.single-tenant.sql
    - supabase/migrations/0502_rag_answer_records_tenant.multi-tenant.sql
    - tests/rag-db/answer-records-schema.test.mts
    - tests/rag-db/answer-records-rls.test.mts
  modified: []

key-decisions:
  - "organization_id has no FK in the common 0501, because single-tenant has no organizations table; the multi-tenant 0502 adds rag_answer_records_organization_id_fkey (ON DELETE CASCADE)"
  - "Check constraints are named explicitly (rag_answer_records_*_check) so the catalog stays the same across re-application and folding"
  - "The single-tenant tenant_key is the constant expression 's:default'::text; organization_id is not constrained to NULL there (chats already keep it NULL in single-tenant)"
  - "Shared-chat policies are not extended to the table, as planned"

requirements-completed: [GEN-03, GEN-06, EVAL-16]

duration: ~1h
completed: 2026-11-25
---

# Phase 5 Plan 06: Answer-record table Summary

**This plan adds `public.rag_answer_records` in both deployment modes. Its `tenant_key` is a generated column, so it cannot drift from the row. Only the owner can read a record (select-own RLS), and only service_role can write one. The table has no foreign key to documents or chunks, so the citation snapshot survives when a document is deleted or re-versioned.**

## Accomplishments
- 0501 (common) creates the table with the D-16 columns, named checks for `citation_strategy`, `rag_mode`, `review_reasons` and `invalid_citations`, indexes on `(chat_id)` and `(user_id, created_at)`, RLS, grants and the `rag_answer_records_select_own` policy, and ends with `NOTIFY pgrst`.
- 0502 per mode adds `tenant_key ... GENERATED ALWAYS AS (...) STORED` and an index on `(tenant_key, created_at)`. The multi-tenant file also adds the organization foreign key.
- Tests run in both modes on PGlite. They cover defaults, the missing id default, the generated key (and that writing it fails), the four 23514 checks, the cascade from chats, a document delete leaving records unchanged, and re-applying 0501 and 0502 with an unchanged catalog. They also cover select-own isolation between two members of the same organization, no rows for an authenticated session without a user id, 42501 for every authenticated write and for every anon statement, privilege and policy catalog checks, service_role writes, and an error with no row through the fake edge with the anon key.

## Task Commits
1. **Task 1: Table, generated tenant key, constraints and indexes**
   - `a31c819` test(05-06): add failing schema tests (RED: relation does not exist)
   - `67ebbca` feat(05-06): add rag_answer_records table with generated tenant_key (GREEN)
2. **Task 2: RLS, grants and isolation tests**
   - `085a18f` test(05-06): add failing RLS and grant tests. RED on assertions: with table-only 0501, 14 of 18 cases failed because the default privileges let anon and authenticated read and write.
   - `d0cad33` feat(05-06): select-own RLS and service-role-only writes (GREEN)

## Deviations from Plan
- Migration numbers 0501 and 0502 were free; no renumbering.
- `organization_id` gets its foreign key in the multi-tenant 0502, not in 0501. The plan put `references organizations` in the common file, but that would fail in single-tenant, which has no organizations table.
- The fake edge does not serve `rag_answer_records` at all, so the anon read through it gets an error for an unknown table. That rejection comes before any role check. The SQL-level anon 42501 tests are what prove the grant.

## Fold status
- `tests/rag-db/schema-equality.test.mts` passes unchanged. Its `FOLDED_MIGRATION` pattern treats 05xx as unfolded, and the "unfolded" and "twice" cases apply 0501 and 0502 cleanly. Folding into both setup files is plan 05-25.

## Gates
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: 0 diagnostics
- `npx vitest run`: 253 files, 4063 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 166 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 1099 pass, 0 fail, 4 skipped (the known ingestion-ledger-pg root skip)
- `check-rag-boundary` and its node test, `check-config`, `check-workflows`: pass
- `npm run test-rag` (prechunked and ingest fixture modes): gate PASS
- No Python or contract files were touched, so pytest and `gen:schemas` were not required.

## Environment notes (not code issues)
- The first rag-db run failed `ingest-identity-async`, `ingest-mode-routing` and `fixture-edge-storage` because the rag-sidecar venv had not been synced yet. After `uv sync`, `ingest-mode-routing` still failed while the sidecar downloaded `cl100k_base.tiktoken` through the TLS proxy. Pre-warming the tiktoken cache once with `REQUESTS_CA_BUNDLE=/root/.ccr/ca-bundle.crt` fixed it. None of these tests touches this plan's SQL.

## Operator actions
- None now. Applying the migrations to a live project is plan 05-26 (D-26 step 3). The table, policies and grants are one-way per D-16.

## Next
- 05-09 writes records through the service-role client and attaches a first-answer record to its chat once the owner's chat row lists the answerId.
- 05-25 folds 0501 and 0502 into both setup files.
