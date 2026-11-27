---
phase: 07-external-backends-release-defaults
plan: 07
subsystem: rag-backend
tags: [qdrant, vector-sync, tenant-isolation, bm25, conformance]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "@qdrant/js-client-rest 1.20.0 and the boundary list (07-01); qdrantScopedBatch / scoped builders / assertScoped and canonicalTenantKey (07-03); QDRANT_* env names (07-04); VectorStore, createExternalBackend, rag_validate_chunks and seedExternalStore (07-06)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "RetrievalBackend contract and the conformance suite (04-17, cases.ts unchanged); shared lexical tokenizer (04-03)"
provides:
  - "src/lib/rag/backend/qdrant/client.ts: buildQdrantClients, getQdrantReadClient, getQdrantWriteClient (the only module importing the vendor client)"
  - "src/lib/rag/backend/qdrant/collection.ts: ensureQdrantCollection, describeQdrantCollection, qdrantCollectionSpec, QDRANT_PAYLOAD_INDEXES"
  - "src/lib/rag/backend/qdrant/adapter.ts: createQdrantBackend, createQdrantReader, searchQdrantLegs, qdrantFilterConditions, QDRANT_FILTER_SUPPORT"
  - "src/lib/rag/sync/stores/qdrant.ts: createQdrantStore (VectorStore) and qdrantPayload"
  - "src/lib/rag/tenant/store-scope.ts: storeScopeForTenantKey (scope for a canonical key read from Supabase rows)"
  - "tests/rag/backend-conformance/qdrant-factory.ts: qdrantFactory"
affects: [07-10, 07-11, 07-12, 07-14, 07-16, 07-31]

actuals:
  tokens: 19596
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Every Qdrant data request (query batch, scroll, count, delete) is built by a scoped builder; upserts are checked point by point against the call's tenant"
    - "Request fields the D-03 payload cannot honour throw RetrievalBackendError code filter_unsupported before any request, so the factory can route the request to pgvector"
    - "A recording, filter-evaluating fake Qdrant client (tests/rag/backend/qdrant-fake-client.ts) with an 'ignore filters' mode for the re-validation proof"

key-files:
  created:
    - src/lib/rag/backend/qdrant/client.ts
    - src/lib/rag/backend/qdrant/errors.ts
    - src/lib/rag/backend/qdrant/collection.ts
    - src/lib/rag/backend/qdrant/adapter.ts
    - src/lib/rag/sync/stores/qdrant.ts
    - src/lib/rag/tenant/store-scope.ts
    - tests/rag/backend/qdrant-fake-client.ts
    - tests/rag/backend/qdrant-adapter.test.ts
    - tests/rag/sync/qdrant-store.test.ts
    - tests/rag/backend-conformance/qdrant-factory.ts
    - tests/rag/backend-conformance/qdrant.test.ts
  modified:
    - src/lib/rag/sync/stores/types.ts

key-decisions:
  - "A-2 confirmed on a real server: the lexical leg is the whitespace text index with BM25 over lexical_text, IDF corpus scoped to the tenant; the zh exact-term case passes on qdrant 1.20.2, so no sparse fallback and lexical_mode stays text_bm25"
  - "createQdrantBackend wraps createExternalBackend (07-06) rather than re-implementing re-validation: deps are { readClient, adminClient, readiness, securityLog }; the per-request collection comes from embeddingProfileId, so no profile dep"
  - "Filters with no D-03 payload field throw filter_unsupported: invoice, scopes, scopesIncludeUntagged, effectiveOn (the last three were added to RetrievalFilters after the plan was written), plus chunkingProfileOverride, a non-current versionScope and identifiersNorm. Unset values (empty arrays, empty objects) do not refuse. A satisfies table over Required<RetrievalFilters> fails compilation when a new key appears without a mapping"
  - "includeUndated maps to should[range, is_empty(doc_date)]; the store writes every payload key with explicit null (Pitfall 7), and is_empty also matches null"
  - "deleteTenant deletes by id pages (scoped scroll then scopedDeleteIds), because scopedDeleteByFilter refuses a tenant-only filter by design; deleteIds and deleteDocument count inside the tenant first and return that count"
  - "Store write calls take canonical keys from Supabase rows; storeScopeForTenantKey in src/lib/rag/tenant/ mints the scope (mintScope stays inside tenant/ per the boundary rule) and refuses non-canonical keys instead of repairing them"
  - "Qdrant keeps no tenant registry: CollectionInfo.tenants became number | null (null for Qdrant); ensureTenant only checks the collection exists. describeCollection also returns lexicalMode"
  - "Client timeouts are backstops (read 2 s, write 30 s) with checkCompatibility false; the 800 ms budget and fallback belong to the factory (07-12). No new env variable"
  - "Vendor errors are reduced to a status code (http_<n> or unreachable); 404 maps to BackendNotReadyError collection_missing. No payload or response body is logged or rethrown"
  - "An existing collection missing some payload index (interrupted setup) gets the missing indexes in the same order; a dims mismatch throws"

patterns-established:
  - "Vendor modules split: client.ts holds the vendor import and env read; adapter, collection and store import its type only plus errors.ts, so they load without app env (worker and canary inject clients)"

requirements-completed: [RET-06, RET-05, RET-01, RET-02, RET-03, RET-10]

coverage:
  - id: D1
    description: "Collection created index-first (tenant_key is_tenant first, filter fields, doc_date datetime, lexical_text BM25), strict mode, no quantization, hnsw m 64 / ef_construct 200, metadata with lexical_mode; second ensure sends nothing"
    requirement: RET-10
    verification:
      - kind: unit
        ref: "tests/rag/sync/qdrant-store.test.ts#qdrant collection setup"
        status: pass
  - id: D2
    description: "Every store request passes assertScoped; two-tenant scans, lists, counts and deletes stay inside the tenant; D-03 payload exactly, nulls explicit"
    requirement: RET-06
    verification:
      - kind: unit
        ref: "tests/rag/sync/qdrant-store.test.ts#every request / two-tenant"
        status: pass
  - id: D3
    description: "Adapter: one scoped query batch (dense with ACORN, BM25 text with tenant IDF), every filter mapped, unsupported filters refused, two-tenant isolation on both legs, foreign ids from a filter-ignoring store all dropped by re-validation"
    requirement: RET-06
    verification:
      - kind: unit
        ref: "tests/rag/backend/qdrant-adapter.test.ts"
        status: pass
  - id: D4
    description: "Unchanged Phase 4 conformance suite on a real Qdrant 1.20.2 seeded through outbox and drain: 20/20, zh exact term on legs.lexical included"
    requirement: RET-02
    verification:
      - kind: integration
        ref: "QDRANT_URL=http://127.0.0.1:6333 npx vitest run tests/rag/backend-conformance/qdrant.test.ts"
        status: pass

duration: 1h
completed: 2026-11-27
status: complete
---

# Phase 7 Plan 07: Qdrant adapter, sync store and conformance Summary

**Qdrant is now a working RetrievalBackend and VectorStore: one shared collection per embedding profile, created index-first, with every query, scroll, count and delete scoped to the tenant, and the Phase 4 conformance suite passes on a real Qdrant unchanged.**

## Accomplishments
- Read and write clients built once per process; plain http with a key is refused in production; a missing read key falls back to the write key with one `[RAG Config]` warning.
- `ensureCollection` creates `myrag_chunks_<profileId>` and all nine payload indexes before any point is written.
- The store writes the D-03 payload with every key present and builds every data call with the 07-03 scoped builders.
- The adapter sends one query batch per request (a dense leg and a BM25 text leg over the shared-tokenizer `lexical_text`, tenant-scoped IDF). It skips the text search for an empty token list and hands every id to `createExternalBackend` for re-validation.
- The conformance factory seeds a real Qdrant only through the outbox and drain, then serves it over the read key.

## Task Commits
1. Task 1: `c6313867` feat. Clients, collection setup, store, `storeScopeForTenantKey`, the recording fake client and the store tests. `adapter.ts` is in this commit because the store's `searchLegs` delegates to it.
2. Task 2: `24fbcb50` test. Adapter tests (request shape, filter mapping, unsupported filters, scores, health, readiness, abort, two-tenant).
3. Task 3: `63f933e8` test. `qdrantFactory` and `qdrant.test.ts`.
4. Lint: `5c598dce` test. Lint fixes in the two test files.

## TDD note (deviation)
There are no separate RED commits. The tests were written against interfaces that need the modules, so a RED commit could only have failed on module-not-found, which the brief rules out. The guard mutations below show the tests discriminate:
- Store `deleteDocument` sending a raw `{ filter }` instead of `scopedDeleteByFilter`: `-t "every request"` fails.
- `scopedDeleteByFilter` returning the filter without the tenant clause: `-t "two-tenant"` fails.
- Adapter sending the batch without `qdrantScopedBatch`: the assertScoped test and the filter-evaluating two-tenant test both fail. The filter-ignoring two-tenant test still passes, as it should, because re-validation drops the foreign ids.

All mutations were reverted before the commits.

## Deviations
- **Plan signature `createQdrantBackend({ readClient, revalidate, profile, readiness })`**: implemented as `{ readClient, adminClient, readiness?, securityLog? }` on top of 07-06's `createExternalBackend`, which owns re-validation. The collection is derived per request from `embeddingProfileId`.
- **Filter keys added after planning** (`scopes`, `scopesIncludeUntagged`, `effectiveOn`): the D-03 payload has no field for them, so they throw `filter_unsupported` like invoice filters. `versionScope` other than `current` and `identifiersNorm` do the same, as a second guard. The registry's capability check already keeps those two fields away from a backend that does not declare them.
- **`CollectionInfo.tenants` is now `number | null`** (07-06 type, additive): Qdrant has no tenant registry. `describeCollection` also returns `lexicalMode` (the plan's `{ exists, dims, lexicalMode }`; null for a missing collection stands for `exists: false`).
- **New files beyond `files_modified`**: `errors.ts` keeps the adapter and store importable without loading `@/lib/env`, which validates on import. `src/lib/rag/tenant/store-scope.ts` exists because `mintScope` may only be used inside `src/lib/rag/tenant/`. `tests/rag/backend/qdrant-fake-client.ts` is the shared recording fake.
- **Docker**: a daemon was started in this container (`dockerd`), and the compose `qdrant` service (v1.20.2 by digest) ran locally. The conformance run is therefore not deferred.

## Decisions for STATE
- A-2 settled on a real server: Qdrant lexical leg = text index BM25 with tenant IDF; `lexical_mode: text_bm25`; no sparse fallback.
- `filter_unsupported` covers every filter or request field the D-03 payload cannot carry; 07-12 routes those requests to pgvector.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `npm run typecheck:new`: no errors.
- `npx vitest run tests/rag/backend tests/rag/sync tests/rag/backend-conformance` with `QDRANT_URL=http://127.0.0.1:6333`: 13 files, 197 tests passed. This covers every test importing a changed module: external-backend, drain, reconcile, qdrant-scoped, pgvector conformance and the new files.
- Without `QDRANT_URL`: `tests/rag/backend-conformance/qdrant.test.ts` is skipped (20 skipped), and the default run stays green.
- Real Qdrant conformance: 20/20 passed.
- `node --import tsx --test tests/rag-db/vector-sync-tracer.test.mts`: 3/3 (store types changed).
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all ok.
- `npm run test-rag -- --out eval/out/07-07`: gate PASS (7 skipped). `npm run test-rag -- --fixture-mode ingest --out eval/out/07-07-ingest`: gate PASS (8 skipped).
- ESLint on the new files: 0 errors. Remaining warnings: the base `no-unused-vars` rule on type-signature parameter names, and two in the fake client's interface.
- Not run (area untouched): the tests/rag-db SQL suite beyond the tracer (no migration, no new RPC), check-workflows, pytest, gen:schemas, the frontend design check.

## Operator pending
- None for this plan. The live Qdrant tier (hosted URL, read-only key) is an operator action under 07-16 / 07-33.

## Deferred
- Wiring into the backend factory with timeout, race and readiness: 07-12. Activation gate (migration 0706): 07-10. Reconcile against Qdrant: 07-11.
