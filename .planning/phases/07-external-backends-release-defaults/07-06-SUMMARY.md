---
phase: 07-external-backends-release-defaults
plan: 06
subsystem: rag-backend
tags: [vector-sync, re-validation, tenant-isolation, supabase, tracer]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "outbox, triggers and claim RPCs (07-02), canonicalTenantKey (07-03), VectorSyncSliceReport contract (07-05)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "hybrid_search_chunks predicate and hit columns (04-15, final body 0802), RetrievalBackend types and conformance dataset (04-17), PGlite roles (04-05), fake edge (04-10)"
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "embedding_profiles.storage and chunk_embeddings (03-09)"
provides:
  - "rag_servable_chunks view (security_invoker, service role only): the one definition of a servable chunk (0704)"
  - "rag_validate_chunks(p_tenant_key, p_ids uuid[], p_profile_id): isolation layer 2, no switch (0704)"
  - "rag_vector_sync_document_rows, rag_vector_sync_chunk_row, rag_vector_sync_profiles, rag_backend_readiness (0705)"
  - "VectorStore / VectorPoint / StoreLegs interface and the in-memory fake store"
  - "drainSlice({ store, rpc, budgetMs, batch }): thin drain over one store"
  - "revalidateChunks and createExternalBackend / BackendNotReadyError"
  - "seedExternalStore: conformance dataset through outbox and drain, for 07-07 and 07-08"
affects: [07-07, 07-08, 07-09, 07-11, 07-12, 07-14, 07-31]

actuals:
  tokens: 21220
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "External hits are ids and scores only; content, metadata and document fields come from one rag_validate_chunks call"
    - "Sync reads and re-validation select from one servable view, so pgvector and external stores share one definition"

key-files:
  created:
    - supabase/migrations/0704_rag_validate_chunks.sql
    - supabase/migrations/0705_vector_sync_reads.sql
    - src/lib/rag/sync/stores/types.ts
    - src/lib/rag/sync/stores/fake.ts
    - src/lib/rag/sync/drain.ts
    - src/lib/rag/backend/revalidate.ts
    - src/lib/rag/backend/external.ts
    - tests/rag-db/vector-sync-tracer.test.mts
    - tests/rag-db/validate-chunks.test.mts
    - tests/rag/backend/external-backend.test.ts
    - tests/rag/backend-conformance/external-seed.ts
  modified:
    - eval/harness/fake-edge.mts
    - src/lib/rag/backend/types.ts

key-decisions:
  - "The view mirrors the 0802 hybrid_search_chunks chunk predicate exactly (tenant, is_current, ready|variant, fixed doc-type list, active chunking profile with both legacy fallbacks, active pointer only, no eval override) and adds the document checks D-02 requires: document is_current, status ready, same tenant_key as the chunk"
  - "rag_validate_chunks branches on embedding_profiles.storage (A-12): legacy_column needs document_chunks.embedding, halfvec needs a chunk_embeddings row of that profile and tenant; an unknown profile raises 22023; more than 500 ids raises 22023; NULL or empty ids return nothing"
  - "All 0704/0705 functions are SECURITY INVOKER with SET search_path = '' (executor brief; plan said 'pinned'), revoked from PUBLIC, anon and authenticated, granted to service_role; the view is REVOKE ALL / GRANT SELECT to service_role"
  - "rag_backend_readiness always returns one row: the index state (null state when there is none) plus outbox_lag_seconds = age of the oldest pending or leased row for that target and tenant"
  - "Store payload is built field by field (D-03). lexical_text is the shared-tokenizer output and can equal plain chunk text; per A-11 it counts as content in the vendor inventory. The tracer asserts no field other than lexical_text carries chunk text and no field carries the document name"
  - "External backend: one RPC per request with p_tenant_key = canonicalTenantKey(scope); ranks renumbered 1..n per leg in store order; dropped = unique requested ids minus returned; a non-zero count writes one [RAG Security] error line {event, backend, requested, dropped}; the count rides on BackendLegs.meta.tenantValidationDropped (new optional field)"
  - "isReady on the external backend defaults to false (fail closed to pgvector) until 07-12 wires readiness"
  - "Thin drain: document rows read every synced profile (or the row's profile), upsert servable rows and delete every other point of that document; chunk rows upsert or delete one id; tenant/profile rows call expand and checkpoint or complete; a row for another target is failed with target_unavailable; error codes match the 0703 pattern"
  - "Fake edge: VECTOR_SYNC_RPC_ARGUMENTS lists every 0703-0705 function with its exact argument names; the generic RPC path rejects any other argument for them"

patterns-established:
  - "seedExternalStore enables the target before any row exists, loads the dataset through the database, then drains; it never writes to a store"

requirements-completed: [RET-05, RET-07]

coverage:
  - id: D1
    description: "Tracer: Phase 3 writer -> outbox -> one drain slice -> fake store with the D-03 payload -> external backend returns it to its tenant only, hydrated from Supabase -> delete propagates"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag-db/vector-sync-tracer.test.mts"
        status: pass
  - id: D2
    description: "rag_validate_chunks returns exactly the caller's servable, vector-holding ids; foreign, wrong-mode, malformed, non-current, quarantined, deleted, failed, inactive-variant and vector-less ids dropped; client roles 42501; no switch; parity with hybrid_search_chunks"
    requirement: RET-07
    verification:
      - kind: integration
        ref: "tests/rag-db/validate-chunks.test.mts"
        status: pass
  - id: D3
    description: "External backend re-validates every store id, hydrates from Supabase, counts and alerts drops with counts only, never turns an RPC failure into an empty result"
    requirement: RET-07
    verification:
      - kind: unit
        ref: "tests/rag/backend/external-backend.test.ts"
        status: pass
  - id: D4
    description: "Conformance seed through outbox and drain leaves one point per servable chunk per tenant, none for superseded or quarantined chunks"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag/backend/external-backend.test.ts#seedExternalStore"
        status: pass

duration: 2h
completed: 2026-11-26
status: complete
---

# Phase 7 Plan 06: Vector sync tracer and re-validation (isolation layer 2) Summary

**One chunk now goes from a Supabase write through the outbox and a drain slice into an external store, and comes back only to its own tenant, re-validated and hydrated from Supabase. A delete removes it on the next drain. `rag_validate_chunks` is the switchless second isolation layer.**

## Accomplishments
- 0704: `rag_servable_chunks` (security_invoker) and `rag_validate_chunks` (three parameters, SECURITY INVOKER, `search_path = ''`, service role only).
- 0705: `rag_vector_sync_document_rows`, `rag_vector_sync_chunk_row`, `rag_vector_sync_profiles`, `rag_backend_readiness`.
- `src/lib/rag/sync/`: `VectorStore` interface (ensureCollection, describeCollection, ensureTenant, upsert, deleteIds, deleteDocument, deleteTenant, listDocumentIds, scanTenant, count, searchLegs, health), a fake store with per-(collection, tenant) partitions, and `drainSlice`.
- `src/lib/rag/backend/`: `revalidate.ts` and `external.ts` (`createExternalBackend`, `BackendNotReadyError`).
- Fake edge registers every 0703-0705 RPC with its argument names.
- `tests/rag/backend-conformance/external-seed.ts` for the two vendor factories.

## Task Commits
1. Task 1 (tracer): `e1f154e6` feat. Migrations, store, drain, revalidate, external backend, fake-edge registration and the tracer test, in one commit. The tracer test needs all of these modules, so a RED commit could only fail on module-not-found.
2. Task 2: `d0c2d408` test. Every case passed against the Task 1 function, so 0704 did not change and there is no separate RED commit. The mutation runs below show the cases discriminate.
3. Task 3: `500a1db2` test. Same situation: the core from Task 1 already passed every case. The guard mutation below shows the cases discriminate.
4. Gate fix: `2ff18be6` fix. Fake store list filters (boundary rule), plus one tracer lint error.

## Baseline re-measure (plan start, HEAD c036b891)
Every count gate still discriminated before any edit:
- The grep gates on 0704, drain.ts, stores/types.ts and revalidate.ts errored because the files were absent.
- `grep -c rag_validate_chunks eval/harness/fake-edge.mts` was 0.
- Every name-pattern gate errored because its test file was absent.

After this plan:
- `security_invoker` in 0704: 1
- fake-edge `rag_validate_chunks`: 1
- `export async function drainSlice`: 1
- content/documentName/filename fields in stores/types.ts: 0
- `current_setting` in 0704: 0
- `[RAG Security]` in revalidate.ts: 1
- `--test-name-pattern=foreign`: 4 pass, 0 fail
- `--test-name-pattern=parity`: 4 pass, 0 fail
- vitest `-t dropped`: 2 pass, 0 fail

## Mutation guards (run by hand, then reverted)
- Tenant predicates removed from `rag_validate_chunks`: the `foreign` pattern fails 2 tests (the multi-tenant cases).
- `d.status = 'ready'` removed from the view: the `quarantined|parity` patterns fail 4 tests.
- External backend keeps store hits without the RPC filter: the `dropped` test fails.

## Tests that failed before the fix
- `node scripts/ci/check-rag-boundary.mjs` reported `src/lib/rag/sync/stores/fake.ts:50 [doc-type-branching]` (`p.doc_type === null` in the filter). It passes after `2ff18be6`, which moved all list filters into one generic `inList` helper.

## Deviations from Plan
1. **[Rule 1, test correctness] Tracer content check.** `lexical_text` is the shared-tokenizer output and can equal plain ASCII chunk text, and D-03 stores it on purpose (A-11: it counts as content in the inventory). So the tracer asserts that no field other than `lexical_text` holds chunk text and that no field holds the document name. It also asserts that the payload key set is exactly the D-03 fields.
2. **[Rule 2, safety] Parity split into two tests.** The view also requires the document to be current, ready and in the same tenant. `hybrid_search_chunks` (0802) checks the chunk row only. The writers (soft delete, quarantine) always update both rows, so the views agree on every state the app produces.
   - The first test pins the one difference: a fixture chunk left `ready` under a quarantined document is refused by the view and served by hybrid. Validate is never looser than hybrid.
   - The second test sets that chunk to quarantined, as the writers would, and asserts exact per-tenant parity.
   - Note for the pgvector path: hybrid does not check the document row itself. That is safe only while every writer keeps chunk status in step with the document.
3. **`SET search_path = ''`** in place of the plan's unspecified "pinned search_path", following the executor brief.
4. **`BackendLegsMeta.tenantValidationDropped`** (optional) was added to the shared `types.ts` so the dropped count reaches the span. Because of this change the full vitest suite was run.
5. Migration numbers 0704 and 0705 were free and are used as planned.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: no errors
- `npx vitest run` (full, because shared backend types changed): 452 files, 7513 passed, 4 skipped
- `node --import tsx --test tests/rag-db/*.test.mts`: 2140 tests, 2134 pass, 0 fail, 6 skipped
- `node --import tsx --test` on the tests/*.test.mts files that import the fake edge (fixture-edge, fixture-edge-storage, rag-assemble-differential, rag-assemble-query-count): 61 pass, 0 fail
- `node scripts/ci/check-rag-boundary.mjs`: ok. `scripts/tests/check-rag-boundary.node-test.mjs`: 52 pass
- `node scripts/check-config.mjs`: ok (192 variables)
- eslint on the changed files: 0 errors (warnings are interface parameter names only)
- `npm run test-rag -- --out eval/out/07-06`: gate PASS (7 skipped). `--fixture-mode ingest --out eval/out/07-06-ingest`: gate PASS (7 skipped)
- Not run, because their areas were not touched: workflows check, Python pytest, gen:schemas (no contract change), UI gate.

## Operator actions
None. Both targets stay disabled, and nothing calls the external backend in production yet (07-12 wires the factory).

## Next Phase Readiness
- 07-07 and 07-08: implement `VectorStore` for each vendor. Throw `BackendNotReadyError` for a missing collection or tenant. Seed the conformance suite with `seedExternalStore`.
- 07-09: grow `drainSlice` (coalescing by entity, multi-store, kick and route). The current handling of rows for another target (`fail target_unavailable`) is a placeholder.
- 07-12: map `BackendNotReadyError` to `backend_not_ready`, use `rag_backend_readiness` for `isReady`, and copy `meta.tenantValidationDropped` into `RagTrace.retrieval_backend`.
- 07-31: fold 0704 and 0705 into both setup files.
