---
phase: 07-external-backends-release-defaults
plan: 11
subsystem: rag-vector-sync
tags: [vector-sync, reconcile, drift, index-state, outbox-pruning]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "outbox, index-state table and set_target (07-02), ReconcileReport contract (07-05), rag_servable_chunks, VectorStore and fake store, fake-edge registry (07-06), drainSlice / drainUntilEmpty, logVectorSync, traceVectorSync, scripted fake RPC (07-09)"
provides:
  - "0707: rag_vector_sync_reconcile_summary, rag_vector_sync_bucket_rows, rag_vector_sync_tenants, rag_vector_sync_enqueue_repair, rag_set_backend_index_state, rag_vector_sync_prune (service role only)"
  - "src/lib/rag/sync/reconcile.ts: reconcileSlice, bucketOf, idHash64, contentHash64, RECONCILE_PRUNE_DAYS"
  - "StoreScanPoint.lexicalVersion (optional) on the VectorStore scan page; the fake store fills it"
affects: [07-12, 07-13, 07-15, 07-16]

actuals:
  tasks: 2
  commits: 6

tech-stack:
  added: []
  patterns:
    - "64 buckets keyed by the first md5 byte of the chunk id; per bucket a row count, an XOR of 64-bit id hashes and an XOR of 64-bit content digests. Checksums cross PostgREST as decimal text, so no 64-bit value goes through a JSON number"
    - "Reconcile never writes a store: every repair is an outbox row the drain executes"

key-files:
  created:
    - supabase/migrations/0707_vector_sync_reconcile.sql
    - src/lib/rag/sync/reconcile.ts
    - tests/rag-db/vector-sync-reconcile.test.mts
    - tests/rag/sync/reconcile.test.ts
  modified:
    - eval/harness/fake-edge.mts
    - src/lib/rag/sync/stores/types.ts
    - src/lib/rag/sync/stores/fake.ts
    - tests/rag/sync/fake-rpc.ts

key-decisions:
  - "Hash definition (SQL and TS): m = md5(lowercase chunk id); bucket = first byte of m mod 64; id hash = first 16 hex digits of m as a signed bigint; content hash = the same over md5(id || ':' || coalesce(content_hash,'') || ':' || coalesce(lexical_version,'')). Golden values: ...0001 -> bucket 5, 5016017787118691403; ...0002 -> 25, -7398545041996669218; 7f3c2a10-... -> 60, 4332796155272647876"
  - "The compared set is the drain's set: rag_servable_chunks rows of the tenant that hold a vector in the profile (legacy_column: document_chunks.embedding; halfvec: a chunk_embeddings row of that profile and tenant)"
  - "Repairs: missing and stale ids enqueue their document (one row per document); extra UUID ids enqueue a chunk row (the drain reads no servable row and deletes the point); servable 0 with store points also enqueues a tenant row. Every repair row carries the profile id, so the drain re-syncs only that profile. A non-UUID store id is counted as extra and left to re-validation"
  - "State: ready only when all 64 buckets match on count and both XORs; otherwise stale; any store or RPC error is failed with a code (anything that is not a code becomes store_error in SQL). The SQL keeps a building row building on a mismatch, so a newly enabled tenant becomes ready only on its first match. last_reconciled_at is set on every compare, failed ones included, so a failing tenant cannot starve the others. lag_seconds is the live outbox lag, computed in SQL"
  - "Slice: prune(7) once per run, then (target, profile, tenant) candidates from rag_vector_sync_tenants over the given stores and synced profiles, least recently reconciled first (never reconciled first). The budget (default 45 s) is checked before each compare and a started compare always finishes; more_pending is true when candidates remain"
  - "Log line: the plan 07-09 fixed field list with mode reconcile, claimed = compares run, failed = failed compares, the other counts 0. The trace is the 07-09 vector_sync trace (trace: false turns it off)"
  - "Prune removes status done with enqueued_at older than p_days (the outbox has no completion timestamp); dead, pending and leased rows are never removed"

requirements-completed: [RET-05, RET-09]

coverage:
  - id: D1
    description: "0707 SQL: 64-bucket summary equals the servable vector-holding set of the tenant only; a bucket recomputed from its listed ids gives the same XORs; golden ids and hashes; content_hash and lexical_version changes move content_xor only; halfvec profile; tenants listing and order; repair enqueue, dedupe and refusals; index-state transitions; prune keeps dead/pending/leased; 42501 for anon and authenticated; SECURITY INVOKER, empty search_path, no PUBLIC grant; idempotent re-apply; fake-edge round trip"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag-db/vector-sync-reconcile.test.mts"
        status: pass
  - id: D2
    description: "Drift injection on the fake store (deleted point, stale content_hash, extra foreign point) detected as missing 1 / stale 1 / extra 1, repaired by one drainUntilEmpty, then ready; lexical_version-only drift; in-sync ready; building until first match; empty tenant gets a tenant repair; store error -> failed with a code; budget stop and least-recent resume; prune(7) once per run"
    requirement: RET-09
    verification:
      - kind: unit
        ref: "tests/rag/sync/reconcile.test.ts"
        status: pass

duration: 1.5h
completed: 2026-11-26
status: complete
---

# Phase 7 Plan 11: Vector sync reconcile Summary

**Reconcile compares each (target, profile, tenant) between Supabase's servable rows and the external store: the count plus 64 bucketed id checksums and 64 bucketed content digests. Only mismatched buckets are narrowed to ids. Missing, stale and extra entries are repaired through the outbox, and the result is written to `rag_backend_index_state`. Each run also prunes done outbox rows older than 7 days.**

## Task Commits
1. Task 1 (0707 RPCs): RED `e43a4f24` (27 failed, 0 passed: every 0707 function was missing), GREEN `cc671f84` (migration, fake-edge registration, plus the golden-value and fake-edge cases).
2. Task 2 (reconcileSlice): RED `6dbcaccb` (a stub module with the final exports plus the 0707 handlers in the scripted fake RPC; 11 of 11 failed on assertions), GREEN `c420ff0c` (reconcile.ts, `StoreScanPoint.lexicalVersion`, the fake store's scan), then `f6b85caa` (test files only: `BigInt(0)` instead of `0n` for the ES2018 target, and the edge test's client typed as `RpcClient`).

## Behaviour changes
- No runtime path calls reconcile yet. The route (`mode=reconcile`) and `npm run rag:reconcile` belong to later plans (07-13 owns the CLI). Nothing changes while every target is disabled: `rag_vector_sync_tenants` returns no rows and the repair enqueue writes nothing.
- `StoreScanPage.points` now has an optional `lexicalVersion`, and the fake store fills it. This is additive.

## Tests that failed before the change
- `tests/rag-db/vector-sync-reconcile.test.mts`: all 27 cases (both modes) failed before 0707 existed.
- `tests/rag/sync/reconcile.test.ts`: all 11 cases failed against the stub (golden hashes, in-sync ready, drift, lexical-version drift, building, empty tenant, store error, budget, prune, log line). The upper-case id case was added with GREEN.

## Mutation guards (run by hand, then reverted)
- Comparing total counts only (the plan's GUARD MUTATION): both `-t drift` cases fail.
- Dropping the store's lexical_version from the content digest: 5 cases fail (in-sync, drift, lexical drift, building, empty tenant).

## Acceptance
- `grep -c md5 0707`: 5. `grep -c rag_vector_sync_reconcile_summary fake-edge.mts`: 1. `grep -c "export async function reconcileSlice"`: 1.
- `--test-name-pattern=prune`: 3 passed, 0 failed. `-t drift`: 2 passed, 0 failed.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `npm run typecheck:new`: no Phase 1 type errors.
- `npx vitest run tests/rag/sync tests/rag/backend/external-backend.test.ts` (every vitest file that imports a changed module; the cache tests matched `fake-rpc` only through their own file of that name): 5 files, 59 passed.
- `node --import tsx --test tests/rag-db/*grants* tests/rag-db/*search-path* tests/rag-db/vector-sync-*.test.mts tests/rag-db/validate-chunks.test.mts`: 234 passed, 0 failed. `schema-equality`, `vector-sync-tracer` and `vector-sync-reconcile` were rerun on the final tree: 67 passed.
- `check-rag-boundary`, `check-config`, `check-language-literals`, `check-settings-classification`: all ok.
- `eslint` on the changed files: 0 errors (warnings only for unused parameter names in type signatures, the existing pattern).
- Not run: `test-rag` (no change to retrieval, ingest, generation or golden sets), Python, workflows, `gen:schemas` (no contract change; the existing ReconcileReport is used as is), and the full vitest suite (no change to core types, env or test setup).

## Deviations from Plan
1. **Repair function name.** `rag_vector_sync_enqueue` already exists (0702, the array writer the triggers call), so the plan's five-argument function is `rag_vector_sync_enqueue_repair(p_target, p_entity, p_entity_id, p_tenant_key, p_profile_id)`. An overload under the same name would make PostgREST and fake-edge resolution depend on argument names. It accepts the entities chunk, document and tenant (a profile row is not a repair). A disabled target gets no row, and a fresh identical pending row is deduplicated.
2. **`rag_vector_sync_tenants(p_target, p_profile_id)`.** The plan named only the profile. Ordering by last reconcile needs the target, and the function returns nothing for a disabled target, which is how reconcile skips disabled backends.
3. **`rag_set_backend_index_state` signature:** `(p_target, p_profile_id, p_tenant_key, p_state, p_supabase_count, p_backend_count, p_error)`. It accepts ready, stale or failed (building is written only by set_target) and returns the stored state.
4. **Bucket rows also return document_id**, so a missing or stale id can be repaired by its document.
5. **Summary checksums are text** (decimal signed 64-bit), not bigint, because PostgREST JSON numbers lose precision above 2^53.
6. **`StoreScanPoint.lexicalVersion` added (optional)** so the store side of the content digest covers lexical_version, as D-05 and the plan's digest require. Plans 07-07 (Qdrant) and 07-08 (Weaviate) must return it from `scanTenant`. A store that omits it reads as null, so each of its points digests as stale and the tenant never turns ready. That is fail-closed: retrieval stays on pgvector.
7. **Migration number 0707** as planned. 0706 belongs to 07-10, which is not on this branch.

## Decisions for STATE
- Reconcile hash definition and golden values (see key-decisions); the canary (07-16) and any vendor store must use the lowercase chunk UUID as the point id.
- Reconcile is the only writer of `ready`. A mismatch never demotes a building tenant to stale.
- Outbox retention: done rows older than 7 days, by enqueued_at.

## Operator actions
- None for this plan. Real Qdrant and Weaviate drift runs are in the 07-16 canary job.

## Deferred
- The route `mode=reconcile`, `npm run rag:reconcile` (07-13) and the schedules (daily and after bulk operations).
- The `lexicalVersion` in the vendor `scanTenant` implementations (07-07, 07-08).
- A compare of a very large tenant scans the store twice, once for the aggregates and once for mismatched buckets, and is not split across slices. The budget is checked between compares.
