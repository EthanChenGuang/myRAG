---
phase: 07-external-backends-release-defaults
plan: 36
subsystem: rag-vector-sync
tags: [vector-sync, purge, data-24, reconcile, qdrant, weaviate]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "0740 purge functions (07-35), store interface, fake store and thin drain (07-06), vendor stores (07-07, 07-08), full drain engine (07-09), reconcile and index-state upsert (07-11)"
provides:
  - "VectorStore.listCollections(): every `myrag_chunks_` collection the store holds (vendor names; Weaviate `Myrag_chunks_`)"
  - "VectorStore.deleteDocuments(collection, tenantKey, documentIds) and countDocumentPoints(collection, tenantKey, documentIds), tenant-scoped, zero for a missing collection or tenant"
  - "src/lib/rag/sync/purge.ts: processPurgeGroup, PurgeError, PurgeIncompleteError (code purge_incomplete), readPurgeRecord, readPurgedDocuments, reopenPurge, countPurgedPoints, PURGE_DELETE_CHUNK = 100"
  - "drainSlice dispatches entity `purge` to processPurgeGroup and counts its deletions in `deleted`"
  - "reconcileSlice must-be-absent check per (target, tenant): RECONCILE_PURGE_PAGE = 1000, PURGED_POINTS_PRESENT, option purgePageSize"
affects: [07-37, 07-44, 06.3]

actuals:
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "A purge sweeps every chunk collection the store lists, not only synced profiles, then recounts; done is written only after a zero count"
    - "Reconcile never deletes: it re-opens the purge through rag_vector_sync_purge_reopen so every external delete still goes through the outbox and the drain (D-01)"

key-files:
  created:
    - src/lib/rag/sync/purge.ts
    - tests/rag-db/vector-sync-purge-drain.test.mts
    - tests/rag/sync/purge.test.ts
    - tests/rag/sync/store-purge.test.ts
    - tests/rag/sync/reconcile-purge.test.ts
  modified:
    - src/lib/rag/sync/stores/types.ts
    - src/lib/rag/sync/stores/fake.ts
    - src/lib/rag/sync/stores/qdrant.ts
    - src/lib/rag/sync/stores/weaviate.ts
    - src/lib/rag/sync/drain.ts
    - src/lib/rag/sync/reconcile.ts
    - src/lib/rag/sync/claim.ts
    - src/lib/rag/backend/qdrant/client.ts
    - src/lib/rag/backend/weaviate/types.ts
    - tests/rag/sync/fake-rpc.ts
    - tests/rag/backend/qdrant-fake-client.ts
    - tests/rag/backend/weaviate-fake.ts

key-decisions:
  - "The `collection` argument of the new store methods is the vendor collection name returned by listCollections, not a profile id: Weaviate names are hashed and cannot be mapped back to a profile. Each store refuses a name outside its chunk prefix before any request"
  - "Qdrant: deletes and counts go through the existing scoped builders (scopedDeleteByFilter, scopedCount, both run assertScoped) with a `document_id` `match any` clause; count is exact; a delete is sent only for a chunk whose count is non-zero. `getCollections` was added to the QdrantApi pick"
  - "Weaviate: data calls only on `collections.use(name).withTenant(...)`; the filter is And(tenant_key = key, document_id containsAny ids), so a shard answering for another tenant cannot lose points (two-tenant wrong-shard control); counts use aggregate.overAll({ filters }). `listAll` and the optional overAll filter were added to WeaviateClientLike"
  - "processPurgeGroup: a purge whose ledger row is gone completes with nothing to do (no complete call); a record whose tenant differs from the outbox row fails with purge_tenant_mismatch before any delete; malformed rows fail with purge_record_invalid / invalid_tenant_key / purge_target_mismatch; RPC errors propagate as RetrievalBackendError with their code"
  - "Reconcile runs the must-be-absent check on the first visit of each (target, tenant) in a slice, before that tenant's checksum compares (the plan said after): with the check first no ready state is written in between. Points found: every purge with a point is re-opened, and every synced profile of the tenant on that target is written stale at once (profiles not reached in this slice included); the tenant's compares in the same slice write stale again. A store error writes failed with its code for every synced profile and skips the tenant's compares"
  - "Paging: purged documents are read 1000 per page; when the slice budget runs out mid-check the cursor is kept in process per store and tenant (as the drain keeps ensured collections) and the next slice resumes from it, with more_pending true"
  - "No migration, no new env var, no contract change; VectorSyncSliceReport and ReconcileReport unchanged"

requirements-completed: [RET-05]

coverage:
  - id: D1
    description: "Tracer: two versions of one lineage plus another tenant's points in an active and a retired collection; one drainSlice leaves no point of the lineage, keeps the other tenant, completes with collections_checked 2 and the point total, slice line has no id or key; a leaky store fails the row with purge_incomplete and the status stays pending (both deployment modes)"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag-db/vector-sync-purge-drain.test.mts"
        status: pass
  - id: D2
    description: "Vendor stores: prefix-only listing, chunked tenant-scoped deletes and exact counts, missing collection or tenant is zero, two-tenant negative controls (filter-ignoring Qdrant, wrong-shard Weaviate); processPurgeGroup chunking (250 ids → 3 calls per collection), tenant mismatch, RPC error propagation"
    requirement: RET-05
    verification:
      - kind: unit
        ref: "tests/rag/sync/store-purge.test.ts, tests/rag/sync/purge.test.ts"
        status: pass
  - id: D3
    description: "Reconcile: clean purge changes nothing; a reappeared point (retired or synced collection) re-opens the purge and writes every synced profile stale with purged_points_present, then drain + reconcile return to ready; 2,500 ids paged and resumed on the next slice; store error writes failed"
    requirement: RET-05
    verification:
      - kind: unit
        ref: "tests/rag/sync/reconcile-purge.test.ts"
        status: pass
---

# Phase 7 Plan 36: Purges in the drain, the vendor stores and reconcile

**A DATA-24 purge row now reaches every external backend: the drain deletes every point of the lineage from every chunk collection inside the record's tenant, verifies the count is zero before it marks the target done, and reconcile re-opens the purge whenever a purged point reappears.**

## Tasks and commits

| Task | Commits |
|------|---------|
| 1. Tracer: purge drain end to end | `0ff27b7c` test (RED), `9b738cbd` feat |
| 2. Qdrant and Weaviate purge operations | `74afe5a6` test (RED, includes processPurgeGroup unit cases), `97967518` feat |
| 3. Reconcile keeps purged documents absent | `dd9ff05b` test (RED), `29da05f0` feat |
| Summary | this commit |

## Behaviour changes

- `purge` outbox rows used to fail with `unknown_entity`. Now the drain processes them. Deletions are added to the slice's `deleted` count. The slice line still holds counts only.
- With a purge record present, reconcile can now write a tenant `stale` (or `failed`) even when its checksums match. While the purge is still pending, that tenant is served from pgvector (RET-09).
- When no purge rows exist, nothing changes: the drain paths for other entities are untouched, and reconcile makes one extra `rag_vector_sync_purged_documents` call per (target, tenant), which returns an empty page.

## Tests that failed before the fix

- `tests/rag-db/vector-sync-purge-drain.test.mts`: all 4 cases failed on assertions. Points stayed in place, and `last_error` was `unknown_entity` instead of `purge_incomplete`.
- `tests/rag/sync/store-purge.test.ts`: all 10 cases failed because the store methods did not exist (TypeError, not module-not-found).
- `tests/rag/sync/reconcile-purge.test.ts`: all 5 cases failed on assertions. No reopen happened, and the state stayed `ready`.

## Deviations

1. **`purged_points_present` is not persisted.** The plan wanted reconcile to record the stale state with this code. Reconcile now sends `p_error = 'purged_points_present'` with each stale write. But `rag_set_backend_index_state` (0707) keeps `last_error` only when the state is `failed`, so the code never reaches the stale row. Serving is not affected: stale or building already sends the tenant to pgvector. No migration was added, because the plan lists none. If the code should be stored, a follow-up migration has to let `rag_set_backend_index_state` keep `p_error` for `stale`. Today every other caller passes null for stale, so that change would be safe.
2. **The check runs before the compare, not after.** See key-decisions. Running it first means no `ready` state is written in between.
3. **The stale write can happen twice per profile.** When points are found, every synced profile is written stale at once, and the tenant's own compare in the same slice writes stale again. This is harmless, and the test checks the set of profiles.
4. **The tracer fixture is seeded by direct writes.** Its points are written straight into the fake store with `upsert`, in both collections, instead of syncing the active collection through the drain. That isolates the purge row, because a deleted document's own `document` outbox row would otherwise remove its points from the synced collection before the purge ran. The documents are inserted and deleted while every target is off, and qdrant is enabled before `rag_vector_sync_enqueue_purge`.
5. **Test-support fakes changed.** `getCollections` was added to the Qdrant fake client. `listAll` and a filtered `aggregate.overAll` were added to the Weaviate fake. The 0740 purge functions were added to `tests/rag/sync/fake-rpc.ts`. These were needed because the vendor client types gained these members. Existing tests still pass unchanged.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `npm run typecheck:new`: ok.
- `npx vitest run tests/rag/sync tests/rag/backend tests/rag/backend-conformance`: 18 files passed, 2 skipped (the live Qdrant and Weaviate conformance runs); 248 tests passed, 40 skipped.
- `node --import tsx --test` on `tests/rag-db/vector-sync-purge-drain.test.mts`, `vector-sync-purge.test.mts`, `vector-sync-reconcile.test.mts`, `vector-sync-tracer.test.mts` and `vector-sync-claim.test.mts`: 108 passed, 0 failed (1 not counted as pass is a skip inside the existing files).
- `node --import tsx --test` on `tests/rag-db/definer-search-path-pglite.test.mts`, `hybrid-grants.test.mts`, `search-path-empty.test.mts` and `search-rpc-grants-pglite.test.mts`: 54 passed.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all ok.
- Not run, because this plan does not touch their areas: `npm run gen:schemas` (no contract change), `test-rag` (no retrieval, ingest or generation path), Python suites, workflow check, UI check.

## Decisions for STATE

- RET-05 purge delta, TypeScript half: done. The live-store cases go to the backend-canary tier in plan 07-44.
- The new store methods name collections by their vendor name.
- The Weaviate purge filter always includes the tenant_key clause.
- Reconcile re-opens purges and never deletes points itself.

## Operator pending

- None for this plan. The real Qdrant and Weaviate purge runs are part of 07-44 (canary tier) and need the vendor keys.

## Deferred

- A migration that stores `purged_points_present` in `last_error` for stale rows (Deviation 1). It is optional.
- No `rag_purge_hook_` was added. This plan creates no store; the purge ledger comes from 07-35.
