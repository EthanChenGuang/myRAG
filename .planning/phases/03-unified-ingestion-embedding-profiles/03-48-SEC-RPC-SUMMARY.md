---
phase: 03-unified-ingestion-embedding-profiles
plan: 03-48-sec-rpc
status: complete
---

# 03-48 follow-up: SECURITY DEFINER RPC grant closure — Summary

**One-liner:** Migration `0409_search_rpc_revoke.sql` revokes anon/authenticated EXECUTE on four tenant-trusting search RPCs; PGlite test simulates the live 0306 grant hole.

## Tasks

| Task | Commit | Files |
|------|--------|-------|
| PGlite grant regression (TDD RED→GREEN) | `3f8de65`, `14ec6d9` | `tests/rag-db/search-rpc-grants-pglite.test.mts` |
| Migration REVOKE/GRANT | `14ec6d9` | `supabase/migrations/0409_search_rpc_revoke.sql` |

## Behaviour

- After promote, migration order runs `0409` after hybrid search (0407+). Live DBs that still grant `anon` EXECUTE on `match_documents_by_workspace` et al. get the same semantics as `patches/2026-11-search-rpc-revoke-multi-tenant.sql`.
- App already calls these RPCs via service-role (`supabase-rpc.ts`); no application change.

## Tests

| Command | Result |
|---------|--------|
| `node --import tsx --test tests/rag-db/search-rpc-grants-pglite.test.mts` | 2/2 pass (failed before `0409` migration existed) |
| `node --import tsx --test tests/rag-search-rpc-grants.test.mts` | 2/2 pass |

## Deviations

- Used **`0409_search_rpc_revoke.sql`** (not `0356` — taken by backfill; not `0357` — reserved for soft delete in 03.1-39; not `0408` — reserved for profile chunk writer in 04-31).

## Operator

- Apply `0409` on live multi-tenant DB when promoting past Task 1 baseline (after app version that searches on service-role is deployed).
- **Follow-up:** plan **`03-48-sec-rpc-2`** — full live inventory (23 SECURITY DEFINER); failing gate is `tests/rag/search-rpc-grants.test.ts` inventory test (not noise).

## Self-Check: PASSED

- `0409_search_rpc_revoke.sql` exists
- Commits `3f8de65`, `14ec6d9` on `exec/03-48-sec-rpc`