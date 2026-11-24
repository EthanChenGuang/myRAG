# 03-48 follow-up 2: full SECURITY DEFINER EXECUTE inventory (23 on live)

**Plan id:** `03-48-sec-rpc-2`  
**Queue:** overflow — spawn in the **next free executor slot** (one agent; disjoint from `03-48-setup-idempotent`).  
**Live DB:** Guang/box only for promotion; executor uses PGlite + setup SQL + migrations only.

## Context

- Live Task 1 (`03-48-SUMMARY.md`): **23** `public` functions with `SECURITY DEFINER` still had **EXECUTE** for `anon` (not only the four tenant search RPCs).
- Trunk **`03-48-sec-rpc` (merged):** `0409_search_rpc_revoke.sql` closes the **four** legacy search RPCs; PGlite regression in `tests/rag-db/search-rpc-grants-pglite.test.mts` passes.
- **Remaining gap:** `tests/rag/search-rpc-grants.test.ts` — test *"every SECURITY DEFINER function taking a tenant id argument and returning chunks or documents is in the locked list"* **fails** because folded `multi-tenant-setup.sql` still defines additional SECURITY DEFINER writers (e.g. `rag_begin_document_version`, `get_nango_stats`) whose EXECUTE must be **service_role-only**, but the locked list still names only `TENANT_ID_RPCS` (four search functions). **This failure is the acceptance gate for this plan — not pre-existing noise.**

## Objective

1. **Inventory (source of truth):** Enumerate every `public` **SECURITY DEFINER** function in the folded setup path (`multi-tenant-setup.sql` + migrations through trunk) that must **not** grant `EXECUTE` to `PUBLIC`, `anon`, or `authenticated` (service-role-only RPCs per Phase 3 patterns; align with live catalog of 23).
2. **Setup + migration:** For each function, ensure idempotent `REVOKE … FROM PUBLIC, anon, authenticated` and `GRANT EXECUTE … TO service_role` in:
   - `supabase/multi-tenant-setup.sql` (and `single-tenant-setup.sql` where the function exists)
   - New migration **`0410_security_definer_rpc_grants.sql`** (or next free number) for upgrade paths — **do not** renumber `0409`.
3. **Vitest inventory (TDD):** Extend `tests/rag/search-rpc-grants.test.ts`:
   - Replace or grow the locked list so the inventory test **passes** on trunk after setup fold.
   - Keep the four-search-RPC tests; add coverage that **no** service-only DEFINER RPC grants `anon`/`authenticated` in setup files.
4. **PGlite:** Extend `tests/rag-db/search-rpc-grants-pglite.test.mts` (or sibling) to assert `has_function_privilege('anon', …, 'EXECUTE') = false` for the **full** locked inventory after applying through `0410`.
5. **Docs:** Short `03-48-SEC-RPC-2-SUMMARY.md`; update `03-48-SUMMARY.md` Task 1 row — phase 1 = four RPCs (`0409`); phase 2 = full inventory (`0410`).

**Depends on:** `03-48-sec-rpc` merged on trunk (`0409`).  
**Must not:** Re-open anon EXECUTE on the four search RPCs; must not touch live Supabase.

**files_modified (expected):**

- `supabase/multi-tenant-setup.sql`
- `supabase/single-tenant-setup.sql` (if needed)
- `supabase/migrations/0410_security_definer_rpc_grants.sql`
- `tests/rag/search-rpc-grants.test.ts`
- `tests/rag-db/search-rpc-grants-pglite.test.mts` (extend)
- `supabase/patches/2026-11-search-rpc-revoke-multi-tenant.sql` (optional cross-check only — prefer migration as canonical)
- `.planning/phases/03-unified-ingestion-embedding-profiles/03-48-SEC-RPC-2-SUMMARY.md`

**autonomous:** true

## Verification (must pass before return)

```bash
npx vitest run tests/rag/search-rpc-grants.test.ts   # 11/11 including inventory
node --import tsx --test tests/rag-db/search-rpc-grants-pglite.test.mts
node scripts/ci/check-rag-boundary.mjs
```

## Requirement / decision links

- **D-08**, live finding (23 functions), **03-20**, **03-37**
- Complements **0409**; does not replace box-agent live `NOTIFY pgrst` promotion