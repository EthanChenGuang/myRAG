---
phase: 07-external-backends-release-defaults
plan: 08
subsystem: rag-backend
tags: [weaviate, tenant-isolation, vector-sync, conformance, security]
requires:
  - phase: 07-external-backends-release-defaults
    provides: "@weaviate/node 3.15.5 and the vector-store-client boundary rule (07-01); canonicalTenantKey, weaviateTenantName, weaviateCollectionName (07-03); WEAVIATE_* env names (07-04); VectorStore, createExternalBackend, BackendNotReadyError, seedExternalStore (07-06)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "RetrievalBackend contract and the conformance suite (04-17, 04-44)"
provides:
  - "src/lib/rag/backend/weaviate/client.ts: the only @weaviate/node import; getWeaviateReadClient / getWeaviateWriteClient (once per process), resolveWeaviateConnection, weaviateConfigure"
  - "src/lib/rag/backend/weaviate/types.ts: structural client subset; a collection handle has no query/data/aggregate API, only withTenant and tenants"
  - "src/lib/rag/backend/weaviate/collection.ts: weaviateCollectionSpec, ensureWeaviateCollection, describeWeaviateCollection, ensureWeaviateTenant"
  - "src/lib/rag/backend/weaviate/errors.ts: mapWeaviateError (tenant/collection missing -> BackendNotReadyError, permission -> RetrievalBackendError permission_denied)"
  - "src/lib/rag/backend/weaviate/adapter.ts: tenantCollection (single entry point), buildWeaviateFilter, searchWeaviateLegs, createWeaviateReader, createWeaviateBackend"
  - "src/lib/rag/sync/stores/weaviate.ts: createWeaviateStore (VectorStore)"
  - "tests/rag/backend/weaviate-fake.ts: per-tenant-shard fake client that rejects untenanted calls"
  - "tests/rag/backend-conformance/weaviate-factory.ts: weaviateFactory (optionally over injected clients)"
affects: [07-10, 07-11, 07-12, 07-14, 07-16, 07-31, 07-32]
actuals:
  tokens: 60000
  tasks: 3 of 3
  commits: 6
tech-stack:
  added: []
  patterns:
    - "Vendor client typed structurally; only client.ts loads the package, so the adapter and store run against a fake in unit tests"
    - "One tenantCollection(client, scope | canonical key, profileId) entry point for every query, data and aggregate call"
key-files:
  created:
    - src/lib/rag/backend/weaviate/client.ts
    - src/lib/rag/backend/weaviate/types.ts
    - src/lib/rag/backend/weaviate/errors.ts
    - src/lib/rag/backend/weaviate/collection.ts
    - src/lib/rag/backend/weaviate/adapter.ts
    - src/lib/rag/sync/stores/weaviate.ts
    - tests/rag/backend/weaviate-fake.ts
    - tests/rag/backend/weaviate-adapter.test.ts
    - tests/rag/sync/weaviate-store.test.ts
    - tests/rag/backend-conformance/weaviate-factory.ts
    - tests/rag/backend-conformance/weaviate.test.ts
    - tests/rag/backend-conformance/weaviate-fake.test.ts
  modified: []
key-decisions:
  - "createWeaviateBackend takes { readClient, revalidate, readiness, securityLog } and wraps createExternalBackend (07-06): legs come from searchWeaviateLegs, ids are re-validated and hydrated from Supabase. The store's searchLegs uses the same function"
  - "filter_unsupported is RetrievalBackendError('weaviate.search', 'filter_unsupported'), the same shape 07-07 uses for Qdrant. It is raised before any call for invoice, scopes, scopesIncludeUntagged, effectiveOn (not in the D-03 payload), chunkingProfileOverride, a non-current versionScope and identifiersNorm (no capability declared), and for an unknown filter key"
  - "Filter exhaustiveness: FILTER_HANDLING is typed { [K in keyof Required<RetrievalFilters>]: ... }, so a new RetrievalFilters key fails tsc until classified; at runtime an unclassified key is refused"
  - "tenantCollection accepts a minted TenantScope (search) or a canonical key read from Supabase rows (store writes), matching the VectorStore interface at HEAD; both go through weaviateTenantName, which re-checks the key grammar"
  - "describeCollection keeps the HEAD VectorStore shape (CollectionInfo | null); the plan's { exists, dims, lexicalMode } is describeWeaviateCollection in collection.ts. ensureCollection refuses an existing collection with other dims or another lexical mode"
  - "A missing tenant reads as empty and deletes as zero in the store (as the fake store and the drain expect); a search on it is BackendNotReadyError(tenant_missing). The store memoises created tenants and forgets the memo on not-ready, so the drain's ensureTenant-and-retry recreates a tenant removed behind it"
  - "Null payload fields are left out of the object (absent = null with indexNullState); doc_date and date-range bounds are sent as RFC 3339 midnight UTC for date-only values"
  - "tenant_key is stored as a field-tokenised property (it is in the D-03 payload) and deleteTenant deletes by it on the tenant handle; the tenant itself is kept"
  - "Vendor error messages are never kept or logged; errors carry codes only (permission_denied, backend_error, upsert_failed, delete_failed, delete_incomplete)"
  - "No env or config file changed: the WEAVIATE_* names already exist from 07-04"
patterns-established:
  - "Fake vendor client with one shard per tenant, untenanted stubs that throw, a misroute option for the wrong-shard canary, and a slow mode to observe concurrent legs"
requirements-completed: [RET-06, RET-09]
coverage:
  - id: D1
    description: "Collection spec: multi-tenancy on, autoTenantCreation false, self-provided vector, HNSW 64/200 cosine ACORN, quantizer none, indexNullState, stopwords none, bm25 1.2/0.75, whitespace lexical_text, field-tokenised filter properties, doc_date range filters, description {profile_id, dims, lexical_mode}"
    requirement: RET-10
    verification:
      - kind: unit
        ref: "tests/rag/sync/weaviate-store.test.ts#weaviate collection spec"
        status: pass
  - id: D2
    description: "Store reaches data only through withTenant; negative control proves the fake rejects untenanted calls; two-tenant scan/list/count/delete isolation"
    requirement: RET-06
    verification:
      - kind: unit
        ref: "tests/rag/sync/weaviate-store.test.ts#negative control, #two-tenant"
        status: pass
  - id: D3
    description: "Adapter: concurrent legs on the tenant handle, upper-case UUID scope, empty bm25 skipped, filter translation incl. includeUndated, filter_unsupported, abort reason"
    requirement: RET-06
    verification:
      - kind: unit
        ref: "tests/rag/backend/weaviate-adapter.test.ts"
        status: pass
  - id: D4
    description: "Missing tenant -> BackendNotReadyError with no second, untenanted call"
    requirement: RET-09
    verification:
      - kind: unit
        ref: "tests/rag/backend/weaviate-adapter.test.ts#tenant not found"
        status: pass
  - id: D5
    description: "Two-tenant adapter isolation and wrong-shard canary dropped by re-validation (tenant_validation_dropped = B count)"
    requirement: RET-06
    verification:
      - kind: unit
        ref: "tests/rag/backend/weaviate-adapter.test.ts#two-tenant"
        status: pass
  - id: D6
    description: "Phase 4 conformance suite unchanged on Weaviate through the real seed path"
    requirement: RET-01
    verification:
      - kind: integration
        ref: "tests/rag/backend-conformance/weaviate-fake.test.ts (fake client, 20/20)"
        status: pass
      - kind: integration
        ref: "tests/rag/backend-conformance/weaviate.test.ts (real Weaviate)"
        status: deferred
---

# Phase 7 Plan 08: Weaviate adapter, sync store and conformance

Weaviate is now a working RetrievalBackend and VectorStore. Each workspace is its own tenant, reached only through `withTenant`. It is not wired into retrieval yet: plan 07-12 adds the factory, so with the defaults nothing changes at runtime.

## Tasks and commits

| Task | Commits |
|------|---------|
| 1. Clients, collection setup, tenant-only store | `50a06c42` test (RED), `2cb420ce` feat |
| 2. Weaviate RetrievalBackend | `66c23a49` test (RED), `d461bd95` feat |
| 3. Conformance factory and suite | `a790988e` test |
| SUMMARY | this commit |

## What changed

- `client.ts` is the only file that imports `@weaviate/node`. It builds one read client (with `skipInitChecks`) and one write client per process. The read client uses `WEAVIATE_READ_API_KEY`; when that is empty it falls back to `WEAVIATE_API_KEY` and logs one warning. A `*.weaviate.cloud` or `*.weaviate.network` host connects as Weaviate Cloud (https only). Any other host is a custom connection with gRPC on port 50051 of the same host. In production a plain-http URL with a key is refused.
- `collection.ts` creates `weaviateCollectionName(profileId)` with the D-06/D-13/A-4 spec. The description holds `{profile_id, dims, lexical_mode: 'bm25_whitespace'}`. Collection admin and tenant creation are the only tenant-less calls.
- `adapter.ts`: every query, data and aggregate call starts from `tenantCollection`. In `searchWeaviateLegs`, `nearVector` and `bm25` run concurrently with the same native filters. Similarity is `1 - distance`, and the BM25 score becomes `lexicalScore`. An empty token list skips `bm25`.
- `stores/weaviate.ts`: `upsert` creates an unseen tenant once (`tenants.create`), then calls `insertMany` on the tenant handle with `id` = chunk id and the D-03 properties only. `deleteIds`, `deleteDocument` and `deleteTenant` loop `deleteMany` until nothing matches. `scanTenant` pages with the `after` cursor. `count` uses `aggregate.overAll` on the tenant handle.

## Behaviour changes

None with the defaults. No existing module imports the new files, no env name or config changed, and the conformance file for the real service is skipped without `WEAVIATE_URL`.

## Tests that failed before the change

- `tests/rag/sync/weaviate-store.test.ts`: 14 of 18 failed against the stubs in `50a06c42`. Thirteen failed on assertions; the tenant-recreate case failed on a TypeError reading the fake collection, which the stub never created. The 4 client-resolution cases already passed because `client.ts` is in its final form in that commit.
- `tests/rag/backend/weaviate-adapter.test.ts`: 4 of 13 failed against the `createWeaviateBackend` stub in `66c23a49`: distance mapping, filter_unsupported and both two-tenant cases. The leg-helper cases already passed because `searchWeaviateLegs` landed with the store in `2cb420ce`, which needs it.
- Guard mutations, run by hand and then reverted: a fixed tenant name in `tenantCollection` fails the adapter two-tenant test, and a `deleteTenant` that deletes from both tenants fails the store two-tenant test.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors; `npm run typecheck:new`: clean
- `npx vitest run tests/rag/backend/weaviate-adapter.test.ts tests/rag/sync/weaviate-store.test.ts tests/rag/backend-conformance tests/rag/backend/external-backend.test.ts tests/rag/backend/tenant-key.test.ts tests/rag/sync/drain.test.ts`: 7 files passed, 1 skipped (the real-Weaviate conformance file); 105 tests passed, 20 skipped
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all pass
- `npm run test-rag -- --out eval/out/07-08` and `npm run test-rag -- --fixture-mode ingest --out eval/out/07-08-ingest`: both exit 0, gate PASS (7 and 8 skipped)
- Not run: tests/rag-db (no SQL or RPC change), pytest (no Python), gen:schemas (no contract), workflow check (no workflow), frontend-design check (no UI)

## Deviations

1. **Weaviate conformance deferred to backend-canary (07-16).** There is no Docker daemon in this container, so `docker compose -f docker-compose.backends.yml up -d weaviate` could not run. The same unchanged suite does run over the tenant-only fake client (`weaviate-fake.test.ts`, 20 of 20 pass): PGlite, the outbox triggers, `drainSlice`, the real store and the real adapter, with re-validation against the same database. The fake's lexical score is token overlap, not BM25, so real BM25 ranking, the zh exact-term case on real Weaviate and `selective_filter` against `flatSearchCutoff` stay with 07-16.
2. **Extra files:** `types.ts` and `errors.ts` in the adapter folder, `tests/rag/backend/weaviate-fake.ts` and `tests/rag/backend-conformance/weaviate-fake.test.ts`. None of them imports the vendor package.
3. **Interface shape:** the plan's `describeCollection → {exists, dims, lexicalMode}` is `describeWeaviateCollection`; the store keeps the HEAD `VectorStore.describeCollection` shape. See key-decisions.
4. **`filter_unsupported` scope:** besides invoice filters and `chunkingProfileOverride`, scope tags, `effectiveOn`, a non-current `versionScope` and `identifiersNorm` are refused too. The payload cannot honour them, so the request goes to pgvector instead of being silently unfiltered.
5. **Task 3 had no RED commit.** It only adds a factory and wires the unchanged suite.

## Decisions for STATE

- The Weaviate adapter's `filter_unsupported` is `RetrievalBackendError` with code `filter_unsupported`. 07-12 maps it to `fallback_reason: filter_unsupported` without `degraded`.
- `BackendNotReadyError` from the Weaviate adapter (`tenant_missing` / `collection_missing`) is the not-ready path. It is never retried without a tenant.

## Operator pending

- None for this plan. A live Weaviate Cloud check (RBAC read-only key, cloud connection) belongs to the canary and rollout plans (07-14, 07-16, 07-33).

## Deferred

- Real-Weaviate conformance run (07-16 `backend-canary`).
