---
phase: 07-external-backends-release-defaults
plan: 35
subsystem: rag-vector-sync
tags: [vector-sync, outbox, purge, data-24, stale-repair]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "outbox, targets, index state (0701), rag_vector_sync_enqueue and triggers (0702), claim/complete/fail/requeue_dead (0703), fake-edge registry (07-06, 07-11), wave-4 migrations through 0707 (07-10, 07-11)"
provides:
  - "0740: outbox entity `purge`; tables vector_sync_purges and vector_sync_purge_targets (service role only)"
  - "rag_vector_sync_enqueue_purge(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[], p_actor text, p_reason_code text) RETURNS uuid: the Phase 6.3 (DATA-24) seam"
  - "rag_vector_sync_purge_row(p_purge_id uuid) -> (purge_id, tenant_key, lineage_id, document_ids)"
  - "rag_vector_sync_purge_complete(p_purge_id uuid, p_target text, p_collections integer, p_points bigint) RETURNS boolean"
  - "rag_vector_sync_purge_status(p_tenant_key text, p_lineage_id uuid) -> (target, state, collections_checked, points_deleted, completed_at, purge_id)"
  - "rag_vector_sync_purged_documents(p_target text, p_tenant_key text, p_after uuid, p_limit integer) -> (document_id, purge_id, lineage_id)"
  - "rag_vector_sync_purge_reopen(p_purge_id uuid, p_target text) RETURNS boolean"
  - "rag_vector_sync_enqueue_stale(p_target text, p_tenant_key text, p_chunk_ids uuid[]) RETURNS integer"
affects: [07-36, 07-37, 07-44, 06.3]

actuals:
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "A purge is one ledger row per (tenant, lineage) holding the document ids; a `purge` outbox row carries the purge id as entity_id and is claimed by the unchanged 0703 functions"
    - "Applicable target = enabled OR has rag_backend_index_state rows for the tenant; purge and re-open insert their outbox rows themselves (rag_vector_sync_enqueue skips disabled targets); stale repair goes through rag_vector_sync_enqueue"

key-files:
  created:
    - supabase/migrations/0740_vector_sync_purge.sql
    - tests/rag-db/vector-sync-purge.test.mts
    - tests/rag-db/vector-sync-stale-enqueue.test.mts
  modified:
    - eval/harness/fake-edge.mts

key-decisions:
  - "Migration number 0740 was free on every origin branch; reserved with a placeholder commit pushed first"
  - "Guards: rag_assert_tenant_key first in every function taking a tenant key; purge_row, purge_complete and purge_reopen assert the ledger row's key. lineage_mismatch (22023) when a named id still exists under another tenant or lineage, or the lineage exists under another tenant; ids with no row are accepted"
  - "Bounds (22023, nothing written): NULL lineage, NULL/empty/over-1000 ids or NULL elements, a merged union over 1000, actor not matching ^[A-Za-z0-9_.:-]{1,200}$, reason code not matching ^[a-z0-9_.:-]{1,200}$. Table CHECKs repeat the patterns, so no free text can be stored"
  - "A second enqueue for the same tenant and lineage merges the ids (sorted, distinct), resets every applicable target row to pending (counts and completed_at cleared) and adds one outbox row per target unless an untried pending one exists"
  - "Status per target: not_applicable without a target row; dead when the latest purge outbox row of that purge and target is dead; pending while the target row is pending or the latest outbox row is pending or leased; else done. A completion of an older run that races a re-open therefore still reads pending until the new row finishes"
  - "Stale repair additionally refuses (tenant_mismatch, 22023) a chunk id that exists under another tenant, so a repair row can never name another tenant's chunk; it never touches rag_backend_index_state"
  - "Every function SECURITY INVOKER, search_path '', revoked from PUBLIC/anon/authenticated, granted to service_role; both tables RLS on, no policies, client grants revoked. No SECURITY DEFINER allow-list entry"
  - "fake-edge: the catalog-driven generic rag_* path was still in place; the 0740 names were added to VECTOR_SYNC_RPC_ARGUMENTS (exact argument names) and a test proves an unregistered rag_ function still resolves"
  - "No new env var; 0740 not folded into the setup files (07-31 folds 0701-0707 only)"
  - "No rag_purge_hook_ added: vector_sync_purges is itself the purge ledger (ids only); Phase 6.3 decides whether its coverage test registers it in rag_purge_store_inventory()"

requirements-completed: [RET-05]

coverage:
  - id: D1
    description: "Purge enqueue, ledger merge, applicable targets (enabled, disabled with index state, other tenant's index state ignored), returns NULL with nothing written, claim/row/complete/status, dead status and requeue, entity CHECK, idempotent re-apply"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag-db/vector-sync-purge.test.mts"
        status: pass
  - id: D2
    description: "Tenant guard, lineage_mismatch in both modes and across tenants, bounds, 42501 for anon/authenticated on functions and tables, INVOKER/search_path/no PUBLIC, fake-edge named-argument round trip and generic rag_ resolution"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag-db/vector-sync-purge.test.mts"
        status: pass
  - id: D3
    description: "Must-be-absent paging, re-open, stale-repair enqueue (one target, untried dedupe, 200 cap, disabled target 0, tenant_mismatch, index state untouched)"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag-db/vector-sync-stale-enqueue.test.mts, tests/rag-db/vector-sync-purge.test.mts"
        status: pass
---

# Phase 7 Plan 35: Vector sync purges and stale-id repair Summary

The outbox now carries lineage-wide DATA-24 purges to every backend that holds points, with a per-target status for the purge verification query, plus a bounded stale-id repair; a default install writes nothing.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| - | 168cd1a3 | Reserve migration 0740 (placeholder, pushed at once) |
| 1-3 RED | d25bd57a | Failing PGlite tests for purges and stale repair |
| 1-3 GREEN | 79b20ae4 | Migration 0740 (all functions, guards, grants) |
| 2 | 290e89f1 | Fake-edge registry entries for the 0740 RPCs |
| - | (this commit) | SUMMARY |

The three tasks share one migration file, so the RED tests for all three were committed together and the migration in one GREEN commit.

## Behaviour changes

None while no backend is enabled and none holds index state: every new function is a no-op or a read, and no trigger was changed. The new `purge` outbox entity is only written by the new functions. The existing drain (src/lib/rag/sync/drain.ts) does not handle `purge` rows yet; plan 07-36 adds that. Until then a purge row on an enabled target would be claimed and fail with `unknown_entity` into the 0703 retry path. No caller exists yet, so this cannot happen.

## Tests that failed before the change

All 53 tests in the two new files failed on the base (functions and tables missing). Mutation check: moving the ledger insert ahead of the applicable-target test makes both "returns NULL" tests fail.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all ok
- `node --import tsx --test` on tests/rag-db/vector-sync-purge, vector-sync-stale-enqueue, vector-sync-schema, vector-sync-triggers, vector-sync-claim, vector-sync-reconcile, vector-sync-tracer, search-rpc-grants-pglite, search-path-empty, definer-search-path-pglite, hybrid-grants: 261 pass, 0 fail
- schema-equality "applying the migrations twice|setup is unchanged by re-applying migrations": 4/4 pass when run alone. A first run alongside other PGlite suites failed "single-tenant setup" under load and passed on the rerun alone
- `tests/fixture-edge.test.mts` (node test): 0 fail
- `npx vitest run` on the vitest files importing eval/harness/fake-edge.mts (tests/rag/backend/external-backend.test.ts, tests/rag/voice-rag-route.test.ts, tests/rag/voice-timing-route.test.ts): 67/67 pass
- `npm run test-rag -- --out eval/out/p7-35` (plan verification): gate PASS (7 skipped); `jq -e '.passed == true and .paired.all_zero == true' eval/out/p7-35/gate.json` is true

## Deviations

- [Rule 2, security] `rag_vector_sync_enqueue_purge` also refuses a lineage id that exists under another tenant, and `rag_vector_sync_enqueue_stale` refuses chunk ids that exist under another tenant (`tenant_mismatch`). The plan asked for neither; both close cross-tenant naming.
- `rag_vector_sync_purge_status` also returns `completed_at` and `purge_id` columns after the four the plan names.
- The fake-edge probe function in the test returns a table, because the fake edge answers scalar functions as row arrays.

## Operator pending

None. Live Weaviate/Qdrant purge runs belong to plan 07-44.

## Next

Plan 07-36 (drain, store and reconcile handling of `purge` rows) and 07-37 (stale-repair caller, the Phase 6.3 call check).
