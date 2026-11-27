---
phase: 07-external-backends-release-defaults
plan: 14
subsystem: rag-retrieval-backend
tags: [canary, cross-tenant, qdrant, weaviate, pgvector, revalidation, release-gate, pglite]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "createExternalBackend and rag_validate_chunks (07-06), Qdrant and Weaviate adapters and stores (07-07, 07-08), drain (07-09), activation gate (07-10), reconcile (07-11), resolveRetrievalBackend and readiness (07-12)"
  - phase: 04-hybrid-retrieval
    provides: "two-tenant v2 harness (04-41), pgvector backend and hybrid_search_chunks"
  - phase: 03-ingestion
    provides: "ingest() write path, re-embed runner (03-36), quarantine and release (03-37)"
  - phase: 03.1-ingestion-queue
    provides: "softDeleteLineage (03.1-39)"
provides:
  - "tests/rag/canary/factory.ts: canaryBackends, canaryGuardProblems, CI_CANARY_BACKENDS, createCanaryEnv, canaryVector, foreignMarkers, leaked"
  - "tests/rag/canary/seed.ts: ingestCanaryDocument, seedCanaryIdentities, seedCanaryTenants, canaryText, markerFor"
  - "tests/rag/canary/{guard,tenancy,lifecycle,foreign-point}.test.ts"
affects: [07-16, 07-28, 07-34]

actuals:
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "One canary environment per (backend, deployment mode): PGlite behind the fake edge, the target enabled before any row, documents only through ingest(), the outbox and drainUntilEmpty, reconcileSlice until every index-state row is ready"
    - "Retrieval through resolveRetrievalBackend('chat', { pipeline: 'v2', backend: { default: <backend under test> } }) with the PGlite client as the readiness RPC; the external adapter is the production one, built by the factory from the environment"
    - "Every isolation assertion is paired with a positive control (the owner's marker on both legs, served by the backend under test), so an empty or fallen-back answer cannot pass"

key-files:
  created:
    - tests/rag/canary/factory.ts
    - tests/rag/canary/seed.ts
    - tests/rag/canary/guard.test.ts
    - tests/rag/canary/tenancy.test.ts
    - tests/rag/canary/lifecycle.test.ts
    - tests/rag/canary/foreign-point.test.ts
  modified: []

key-decisions:
  - "Live-service isolation between parallel test files: every environment uses random user and organization UUIDs and a random letter nonce; close() deletes only its own tenant partitions (both profiles) and never drops a collection. The single-tenant s:default partition is shared by definition, so the single-tenant cases live only in tenancy.test.ts"
  - "Markers are <nonce><label>z with labels that hold no z, so no marker is a substring of another (the first scheme, <label>mark<nonce>, made omark… a substring of avtwomark… and produced a false leak report)"
  - "The readiness cache (30 s TTL) is reset after each drain and reconcile in the factory, so a test sees the state the reconcile just wrote"
  - "Quarantine is reached through the real ingest path (RAG_INJECTION_SCAN=quarantine in the ingest env, an injection sentence in the document) and released with releaseQuarantined by an admin_users member who owns the tenant"
  - "Re-embed uses runReembed with a fake voyage provider (fixture embedder at 1024 dims); the eval evidence row is written on the database clock after the vectors, so the Phase 3 freshness rule passes and only the external gate can refuse"

requirements-completed: [RET-08, RET-07, RET-06, RET-09]

duration: ~70min
completed: 2026-11-27
---

# Phase 7 Plan 14: Cross-tenant canary suite Summary

**The cross-tenant canary suite runs on pgvector, Weaviate and Qdrant through the ingest write path, the drain and the production backend selection, including a point planted with the write key that only re-validation stops; it passed against live Qdrant 1.20.2 and Weaviate 1.40.7 from docker-compose.backends.yml.**

## Baseline (count gates at plan start, HEAD e0c82cd6)

- `grep -c "CI_BACKEND_CANARY" tests/rag/canary/guard.test.ts`: error (file absent), exit 2
- `test -f tests/rag/canary/seed.ts && grep -cE …`: error (file absent)
- `npx vitest run tests/rag/canary/lifecycle.test.ts -t "cascade"`: error (file absent)
- `grep -c "negative control" tests/rag/canary/foreign-point.test.ts`: error (file absent), exit 2

No gate passed before the first edit, so all of them discriminate.

## Task Commits

1. Task 1, RED: `ecb09135` test(07-14): add failing canary guard and backend-list tests (8 of 11 guard cases fail on assertions against the stubs)
2. Task 1, GREEN: `0f39b696` test(07-14): canary factory, ingest-path seeding and the service guard
3. Task 2: `5d429791` test(07-14): tenancy and lifecycle canaries on every backend
4. Task 3: `cdfdc768` test(07-14): planted foreign point canary, isolation layer 4
5. This SUMMARY

## What the suite covers

- Guard (plain `test`, never skipped): with `CI_BACKEND_CANARY=1` it fails unless `RAG_CANARY_BACKENDS` is exactly pgvector,weaviate,qdrant, `QDRANT_URL` and `WEAVIATE_URL` are set, and `/readyz` and `/v1/.well-known/ready` answer 200. Outside CI it checks only the listed external legs. `canaryBackends()` is pgvector when unset and throws on an unknown name.
- Tenancy, multi-tenant (A personal, B personal, O organization written by member M, M personal without data): every scope sees only its own canary on the dense and lexical legs, for the shared sentence, the sentence plus each foreign marker, and each foreign marker alone. Null organization: A's document has `organization_id` null and only A sees it. A tenant without data is served by pgvector with `backend_not_ready` and `degraded` on the external backends. Removed member: resolveTenantScope mints O for M before removal and refuses with `not_a_member` after; M's personal scope never returns O's marker. Weaviate: an untenanted REST objects query and a GraphQL Get on the multi-tenant collection are both rejected by the server.
- Tenancy, single-tenant: `s:default` sees its documents on both legs through the backend under test; the store holds exactly its chunks; on Weaviate the tenant is `s_default` (read back from the server's tenant list).
- Lifecycle, multi-tenant: soft delete through softDeleteLineage and a hard delete whose chunks go with the document (cascade); after the drain neither document is on any leg of any scope and the store holds no point of either. Version replace: the superseded version's marker never returns (store holds no point of it), the new version's returns to its owner only. Quarantine: the version is never synced and no scope sees it; after release it is synced and returns to its owner only. Re-embed and activation: runReembed fills the second profile; on an external backend activation is refused with `external_not_ready:<backend>` before the drain and again after the drain but before reconcile; after reconcile every writing tenant is `ready`, activation succeeds, the second collection serves and isolation holds for every tenant.
- Foreign point, each external backend: three points upserted with the write key into A's partition (B's chunk id with B's vector, a random UUID with the query vector, A's quarantined chunk id). The raw scoped store query returns all three (control). The RetrievalBackend result through resolveRetrievalBackend holds none of them on either leg, is served by the backend under test, reports `tenant_validation_dropped >= 3` in the selection and the leg meta, and logs exactly one `[RAG Security]` line with no UUID, marker, tenant key or sentence. Negative control: the same search through createExternalBackend with an identity re-validation returns all three. pgvector: revalidateChunks drops the same ids passed directly (requested 4, dropped 3, only A's chunk kept), and an external backend over a reader that names them drops them with one content-free security line.

## Mutation guard (run by hand, then reverted)

- Skipping `rag_validate_chunks` in `createExternalBackend` (every store id kept): the foreign-point result case fails on Weaviate and Qdrant, and the pgvector reader case fails (3 failed, 5 passed). `src/` was restored and `git status src/` is clean.

## Acceptance

- `grep -c "CI_BACKEND_CANARY" tests/rag/canary/guard.test.ts`: 3
- `grep -cE "store\.(upsert|deleteIds|deleteDocument)\(" tests/rag/canary/seed.ts`: 0
- `npx vitest run tests/rag/canary/lifecycle.test.ts -t "cascade"`: 1 passed, 0 failed (pgvector)
- tenancy + lifecycle: pgvector alone 9 passed; with `RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant` and the compose services 29 passed, 0 failed (more than 3 × 9)
- `grep -c "negative control" tests/rag/canary/foreign-point.test.ts`: 2
- `RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant npx vitest run tests/rag/canary/foreign-point.test.ts`: 8 passed, 0 failed (6 external cases)
- Task 1 verify: `npx vitest run tests/rag/canary/guard.test.ts` passes; `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector npx vitest run tests/rag/canary/guard.test.ts` exits 1

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/rag/canary` (default, pgvector leg): 4 files, 22 passed, 30 skipped
- `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant QDRANT_URL=http://127.0.0.1:6333 WEAVIATE_URL=http://127.0.0.1:8080 npx vitest run tests/rag/canary` against `docker compose -f docker-compose.backends.yml up -d`: 4 files, 48 passed, 4 skipped (Weaviate-only cases on the other legs), run three times, all green; afterwards the Qdrant collection held 0 points
- Before writing the suite, the existing conformance suites against the same services: `tests/rag/backend-conformance/qdrant.test.ts` 20 passed, `weaviate.test.ts` 20 passed (Weaviate needs the compose keys in `WEAVIATE_API_KEY` and `WEAVIATE_READ_API_KEY`)
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all exit 0
- `npx eslint tests/rag/canary`: 0 errors, 12 warnings (parameter names in type signatures, the existing pattern)
- Not run, because this plan changes no production module, SQL, workflow, Python, contract, retrieval, ingest or UI file: the full `npx vitest run`, `tests/rag-db`, `tests/*.test.mts`, check-workflows, pytest, `gen:schemas`, `npm run test-rag`, the frontend design check. No production module changed, so no other test file imports a changed module.

## Deviations from Plan

- Negative control: `createExternalBackend` has no re-validation parameter, and the plan asks to leave the production factory unchanged. The identity re-validation is therefore passed as the admin client: a test-only RpcClient whose `rag_validate_chunks` answers every requested id. It is handed to `createExternalBackend` directly and never reaches the factory. No production code changed.
- External adapter wiring: the factory does not inject the adapter with `setExternalBackendForTests`; resolveRetrievalBackend builds the production adapter itself (`getQdrantReadClient` / `getWeaviateReadClient` from the environment, re-validation through `getRagDeps().adminClient()`, set to the PGlite client). This keeps the production construction path under test. The compose placeholder keys are filled in only when the variables are unset, and restored on close.
- Single-tenant cases run only in tenancy.test.ts: lifecycle and foreign-point cases are multi-tenant only, because `s:default` is one partition on a live service and two parallel files would see each other's points (reconcile would then report drift and the run would fall back). The lifecycle mechanics do not depend on the deployment mode; the single-tenant mode is covered for visibility and the Weaviate tenant name.
- Quarantine: the plan's "after quarantine" case is reached by a version quarantined at ingest (the Phase 3 path), not by quarantining an already published version; release then publishes it. The foreign-point plant uses that version's chunk as "A's quarantined chunk".
- Do not run the canary files in the same vitest invocation as `tests/rag/backend-conformance/{qdrant,weaviate}.test.ts` against shared services: the conformance factories drop the legacy collection, which would remove the canary's points mid-run. The 07-16 job should give the canary its own step.

## Decisions for STATE

- The canary env API (`createCanaryEnv(backend, mode)` returning `search`, `rawStoreSearch`, `store`, `drain`, `reconcile`, `settle`, `sql`, `close`) is the base for 07-28 (cache case) and 07-34 (voice and embed entry points).
- Every canary assertion on an external backend also asserts that the backend under test served the request; a fallback to pgvector fails the case instead of passing it.

## Operator actions

- None. All runs used local placeholder services; no live vendor or production project was touched.

## Deferred

- The backend-canary CI job with the service containers and digest pins is plan 07-16.
- Semantic-cache canary (07-28) and voice/embed entry-point canaries (07-34) reuse this factory.

## Threat Flags

None: test-only change, no new endpoint, auth path, schema or trust boundary.
