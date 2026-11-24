# 03-48 follow-up: SECURITY DEFINER RPC grant closure (pre-existing)

**Queue:** spawn when an executor slot frees (one agent; do not duplicate). **Live DB:** Guang/box only — executor works on PGlite + migration file only.

**Objective:** Close anon/authenticated EXECUTE on SECURITY DEFINER search RPCs that trust `p_org_id` / `p_user_id` without `auth.uid()` checks (live finding on `ppvywaxrycaxrtrrditl`, 2026-11-24).

**Depends on:** App call audit complete — `match_documents_by_workspace` / `match_document_chunks_by_org` are invoked via **service-role admin client** in `src/lib/rag/backend/supabase-rpc.ts`; anon must not retain EXECUTE after **0306** `CREATE OR REPLACE`.

**TDD:**

1. Add PGlite test (extend `tests/rag-db/` or `tests/rag/search-rpc-grants.test.ts` + fixture DB) that **fails** when `anon` can `EXECUTE` the affected functions (enumerate 23 on live catalog; minimum the four in `supabase/patches/2026-11-search-rpc-revoke-multi-tenant.sql`).
2. New migration `0356_*` or next free number: `REVOKE … FROM PUBLIC, anon, authenticated`; `GRANT … TO service_role` only; idempotent; align with patch semantics.
3. Link **D-08** follow-ups (03-20, 03-37); update `03-48-SUMMARY.md` Task 1 findings row when merged.

**files_modified (expected):** `supabase/migrations/0356_search_rpc_revoke.sql` (name TBD), `tests/rag-db/search-rpc-grants-pglite.test.mts` (or similar).

**autonomous:** true