---
phase: 06-query-layer-llamaindex-langchain
plan: 12
subsystem: database
tags: [postgres, pglite, pgvector, halfvec, semantic-cache, triggers, service-role]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: 06-08 orders the PGlite migration plans (0602)
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: rag_assert_tenant_key (04-07), 0410 upgrade re-lock and definer inventory test (04-32)
  - phase: 03-unified-ingestion-embedding-profiles
    provides: documents.tenant_key, is_current, status ('ready'), version; rag_publish_document_version
provides:
  - public.rag_semantic_cache (RLS on, no policies, service_role SELECT/INSERT/DELETE only)
  - public.rag_cache_check / rag_cache_store / rag_cache_invalidate / rag_cache_sources_current / rag_cache_resolve_sources, service_role only
  - three FOR EACH STATEMENT invalidation triggers on public.documents
affects: [06-21, 06-30, 06-32, 06-36, 06-40, 06-42, 06-45, 06-46]

actuals:
  tokens: 60000
  tasks: 3
  commits: 7
plan_head_before: 7050d8f

tech-stack:
  added: []
  patterns:
    - "Mixed-dimension halfvec column: prefilter by tenant, key, profile, expiry and vector_dims in a MATERIALIZED CTE before any <=> (P-5)"
    - "Statement triggers with transition tables (single event each) for same-transaction cache invalidation; SECURITY DEFINER, search_path ''"

key-files:
  created:
    - supabase/migrations/0603_semantic_cache.sql
    - tests/rag-db/semantic-cache.test.mts
    - tests/rag-db/semantic-cache-invalidation.test.mts
  modified:
    - supabase/migrations/0410_security_definer_rpc_grants.sql

key-decisions:
  - "search_path is '' (executor rule) instead of the plan's pg_catalog, public: public.halfvec, OPERATOR(public.<=>), public.vector_dims, pg_catalog.* qualified"
  - "key_hash must be 64 lower-case hex (as the 06-09 contract); profile id non-blank, <= 200 chars; answer a JSON object; p_max_distance within 0..2; all raise 22023"
  - "store normalizes source_versions to a sorted, de-duplicated [{document_id, version}] so invalidate-by-id can compare uuid text"
  - "A stale store raises 'cache_sources_not_current' (P0001), so the app can log and drop it (D-36)"
  - "A miss returns entry_id NULL; only the distance is reported"
  - "The UPDATE trigger also fires on tenant_key changes (a document moved into an organization flushes both tenants)"
  - "Trigger functions are granted to service_role and added to the 0410 upgrade re-lock, following the 04-32 precedent; otherwise the definer inventory test fails"

requirements-completed: [CACHE-01]

coverage:
  - id: D1
    description: "Table, RLS without policies, no anon/authenticated privileges; check hit/miss with distance; mixed dimensions; expiry; TTL bounds; stale sources refused on store; bounded cleanup; two-tenant isolation; guard and grants per function"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/semantic-cache.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Hit re-validation (not current, soft-deleted, new version, quarantined, other tenant) turns into a miss and deletes the row; invalidate all or by ids; sources_current; resolve_sources (rename, soft delete, replaced, two tenants)"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/semantic-cache.test.mts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Same-transaction invalidation on insert (service_role and authenticated owner), publish (and rollback), soft delete, is_current/status/version updates, org move, hard delete; progress updates keep rows; ingest-writer suite unchanged"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "node --import tsx --test tests/rag-db/semantic-cache-invalidation.test.mts tests/rag-db/ingest-writer.test.mts tests/rag-db/search-rpc-grants-pglite.test.mts"
        status: pass
    human_judgment: false

duration: 70min
completed: 2026-11-25
status: complete
---

# Phase 6 Plan 12: pgvector semantic cache (0603) Summary

**Migration 0603 adds the `rag_semantic_cache` table, five service-role-only functions and three statement triggers on `documents`. Lookups are tenant-, profile- and expiry-scoped before any distance is computed. Every hit is re-validated against its source versions. Any document insert, version change or delete clears that tenant's cache in the same transaction.**

## Accomplishments

- **Table.** `rag_semantic_cache` has an untyped `halfvec` embedding, a btree index on `(tenant_key, key_hash, embedding_profile_id, expires_at)` and a CHECK that `source_versions` is an array. RLS is on with no policies. Everything is revoked from PUBLIC, anon and authenticated; service_role gets SELECT, INSERT and DELETE.
- **`rag_cache_check`.**
  - Prefilters in a MATERIALIZED CTE by tenant, key hash, profile, `expires_at > now()` and matching `vector_dims`.
  - Takes the nearest row and always reports its distance.
  - A row within `p_max_distance` is a hit only if `rag_cache_sources_current` holds. Otherwise the row is deleted and the call returns a miss.
- **`rag_cache_store`.**
  - Validates the key hash, profile, embedding, answer, `is_refusal` and the TTL (1..86400 s, else 22023).
  - Raises `cache_sources_not_current` unless every source is a current, ready version of the tenant's documents.
  - Normalizes `source_versions` and deletes at most 100 expired rows of the same tenant.
- **`rag_cache_invalidate(p_tenant_key, p_document_ids DEFAULT NULL)`** deletes all of the tenant's rows, or only rows that reference one of the ids, and returns the count.
- **`rag_cache_sources_current`** re-validates a RedisVL hit. It validates the shape of the list (22023) and is vacuously true for an empty list.
- **`rag_cache_resolve_sources`** returns `(document_id, name = filename, version)` for the tenant's current, ready documents only.
- **Shared rules for all five functions.** `rag_assert_tenant_key` runs first, they are SECURITY INVOKER with `search_path = ''`, and only service_role may execute them.
- **Triggers.** There are three AFTER ... FOR EACH STATEMENT triggers with transition tables:
  - INSERT
  - UPDATE, which fires only for rows whose `is_current`, `status`, `version` or `tenant_key` changed, using `IS DISTINCT FROM`
  - DELETE
  
  Their functions are SECURITY DEFINER with `search_path = ''`. They are revoked from PUBLIC, anon and authenticated, and they only delete cache rows for tenant keys taken from the transition tables.
- **Tests.**
  - `semantic-cache.test.mts`: 167 tests across both modes plus a two-tenant suite.
  - `semantic-cache-invalidation.test.mts`: 20 tests.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 (RED) | dc19352 | test(06-12): add failing tests for semantic cache table, check and store |
| 1 (GREEN) | 54ff46f | feat(06-12): add rag_semantic_cache with check and store in migration 0603 |
| 2 (RED) | 9238458 | test(06-12): add failing tests for cache source re-validation, invalidate and source resolution |
| 2 (GREEN) | fdc85f7 | feat(06-12): re-validate cache sources and add invalidate, sources_current and resolve_sources |
| 3 (RED) | e3ea68e | test(06-12): add failing tests for same-transaction cache invalidation triggers |
| 3 (GREEN) | 6bdad44 | feat(06-12): invalidate the semantic cache in the same transaction as document changes |

## Tests that failed before the change

- **Task 1:** every check and store case, the TTL and validation cases, and the guard, grant and table-privilege cases failed. The functions and the table did not exist.
- **Task 2:**
  - The four re-validation cases failed because the hit was served.
  - The invalidate, sources_current and resolve_sources cases failed, including their guard and grant cases.
- **Task 3:** 18 of 20 cases failed, because no rows were deleted and no triggers or functions existed.
  - After the GREEN commit, `search-rpc-grants-pglite.test.mts` failed in both modes. It replays 0409/0410 after the later migrations on an all-open database, and it flagged the three trigger functions as executable by PUBLIC, anon and authenticated. Adding them to the 0410 re-lock fixed it.

## Baseline for Task 3 (precondition)

- `tests/rag-db/ingest-writer.test.mts` before 0603: 65 passed, 3 skipped, 0 failed. After 0603: the same counts.
- `tests/rag-db/soft-delete.test.mts` does not exist on this base. Plan 03.1-39 (`rag_soft_delete_document`, migration 0357) has not been executed. See Deviations.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 222 files, 3370 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 163 passed, 0 failed
- `node --import tsx --test tests/rag-db/*.test.mts`: 1031 passed, 0 failed test cases, 3 skipped. The only failing suite is `ingestion-ledger-pg.test.mts` ("ingestion ledger claim on real PostgreSQL (optional)"), which fails when run as root. This is known and pre-existing.
- `check-rag-boundary` and its node tests, `check-config`, `check-workflows`: pass
- `npm run test-rag -- --out eval/out/06-12`: gate PASS (7 skipped)
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-12-ingest`: gate PASS (7 skipped)
- No Python, contract or env files touched.

## Deviations

- **`search_path = ''`.** The plan says `pg_catalog, public`. The executor security rule requires an empty path, so every name is schema-qualified: `OPERATOR(public.<=>)`, `public.halfvec` and `public.vector_dims`. This assumes pgvector is in `public`, the same assumption 0407 and 0602 make.
- **0410 edited.** `0410_security_definer_rpc_grants.sql` gains guarded REVOKE/GRANT entries for the three trigger functions. This follows the 04-32 precedent (e769d8a) for definers added after 0410. The trigger functions are also granted to service_role, as the definer inventory requires.
- **No soft-delete function on this base.** `rag_soft_delete_document` (03.1-39) and `soft-delete.test.mts` do not exist yet. The soft-delete cases issue the update that function is specified to make (`is_current = false, status = 'deleted'`), and the UPDATE trigger covers it. When 03.1-39 lands, its suite should pass unchanged because the cache table is empty there.
- **Extra trigger condition.** The UPDATE trigger also fires on `tenant_key` changes (a document moved between workspaces). The plan listed only is_current, status and version.
- **Extra prefilter.** The check prefilter also requires matching `vector_dims`, so a caller that sends a wrong-dimension vector gets a miss instead of a dimension error. This is consistent with fail-open (D-36).
- **Migration number.** 0603 was free and is used as planned.

## Decisions for STATE

- CACHE-01 database side is done. `rag_cache_*` are service-role-only, tenant-guarded and `search_path ''`. Invalidation runs through statement triggers on `documents`, which are always installed and delete nothing while the cache is empty.
- Phase 3's finished-document status literal is `'ready'`, as in 06-04.

## Operator actions

- Apply `supabase/migrations/0603_semantic_cache.sql` after 0602 on both deployment modes. This is one-way: a new table, functions, triggers and grants.
- Re-run `0410_security_definer_rpc_grants.sql` once on upgraded projects. It is idempotent and guarded, and it now also locks the three trigger functions.

## Deferred

- Folding 0603 into both setup files: plan 06-45.
- Live permission-denied checks for every new function and the table: plan 06-46 (plan-check W-B).
- **Known gap: refusal race.** A store that commits after a concurrent document change committed can leave a refusal entry, which has no sources, for at most its TTL. The trigger cannot see the uncommitted store row, and re-validation has nothing to check. Entries with sources are caught by re-validation on hit. The refusal TTL is 10 minutes (spec rule 5).
- **Known gap: chunk-only rewrites.** A legacy rewrite that changes only `document_chunks` (without touching `documents`' is_current, status, version or tenant_key) does not invalidate the cache. This is outside this plan's trigger scope; the RET-05 outbox could cover it.
