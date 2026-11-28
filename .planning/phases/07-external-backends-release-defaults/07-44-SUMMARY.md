---
phase: 07-external-backends-release-defaults
plan: 44
subsystem: rag-backend-canary
tags: [canary, purge, source-recheck, stale-repair, qdrant, weaviate, release-gate]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "canary factory, seed and guard (07-14, 07-28), backend-canary job (07-16), purge in drain, stores and reconcile (07-36), forced recheck and stale repair (07-37)"
provides:
  - "tests/rag/canary/purge.test.ts: purge cases on pgvector, Weaviate and Qdrant (both profile collections, disabled target, reappearing point)"
  - "tests/rag/canary/source-recheck.test.ts: forced source-of-truth recheck and stale repair on Weaviate and Qdrant, RAG_SOURCE_RECHECK off and on"
affects: [07-16]

actuals:
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "A disabled target writes no document outbox rows on delete, so a purge enqueued then is the only remover: the canary proves the purge itself clears every collection"
    - "Per-request RPC counting on an external backend: reset the backend factory around the request so the backend is built with the request's recording client"

key-files:
  created:
    - tests/rag/canary/purge.test.ts
    - tests/rag/canary/source-recheck.test.ts
  modified: []

key-decisions:
  - "Purge cases call rag_vector_sync_enqueue_purge directly after deleting the lineage's document rows (planner resolution); the second collection comes from runReembed onto voyage-4-large-1024 with the fake provider, as lifecycle.test.ts does"
  - "rag_vector_sync_purge_status lists every target; the canary asserts done for the backend under test and not_applicable for the other one (each canary environment enables one external target)"
  - "The disabled-target case runs last and asserts that the purge row is the only pending outbox row, so it fails if a purge skips any collection"
  - "source-recheck sets RAG_SOURCE_RECHECK by layering ragEnv before env.ask() and resets the backend factory around each request; factory.ts is only imported"
  - "The stale repair's scheduler, kick and RPC client are injected through setStaleRepairDepsForTests; the repair task runs right after the response"

requirements-completed: [RET-08]
requirements-advanced: [RET-05, RET-14]

coverage:
  - id: D1
    description: "Purge on real Weaviate and Qdrant: both versions of a lineage leave both profile collections, status done, tenant b's points and results unchanged; a disabled target is purged too; a point written back is found by reconcile (purge re-opened, tenant stale), one drain plus one reconcile return to ready; pgvector leg returns nothing of the lineage after the row delete"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag/canary/purge.test.ts"
        status: pass
  - id: D2
    description: "Forced recheck on real Weaviate and Qdrant: a deleted, undrained document never reaches a result on either leg, stale_index_drop >= 1 with RAG_SOURCE_RECHECK off and on, one rag_validate_chunks call, no rag_source_recheck call; the repair enqueues chunk rows for that backend and tenant only, one drain clears the points, the next request reports 0; tenant b unchanged"
    requirement: RET-05
    verification:
      - kind: integration
        ref: "tests/rag/canary/source-recheck.test.ts"
        status: pass
---

# Phase 7 Plan 44: purge and forced-recheck canary on real Weaviate and Qdrant

**The backend-canary release gate now covers DATA-24 purges and the forced source-of-truth recheck on real Qdrant and Weaviate. Both files sit under tests/rag/canary, so the existing job picks them up without a workflow change.**

## Preconditions

- On base `origin/exec/06.3-14` @ `d0d6a445`, every depends_on plan has its SUMMARY: 07-14, 07-16, 07-28, 07-36, 07-37, 05-25, 06-45 and 05.1-22.
- The 05-, 05.1- and 06-VERIFICATION.md files all have `status: human_needed`.
- My first attempt ran on the wrong commit (`fa644e5e`, the ops branch), because the fetch named two branches and FETCH_HEAD pointed at the first. I reported it as blocked. The orchestrator corrected the base, and nothing had been committed on the wrong one.

## Tasks and commits

| Task | Commit |
|------|--------|
| 1. Purge canary on every backend | `e542e2ae` test |
| 2. Forced recheck canary on Weaviate and Qdrant | `6103fbbb` test |
| Summary | this commit |

The tests are the deliverable. The behaviour already exists (07-36, 07-37), so both files passed on first run against the real stores, and there is no RED commit. Instead, each file was checked with the plan's guard mutation, applied temporarily and then reverted:

- **Purge, only one collection swept:** `processPurgeGroup` changed to sweep only the first collection (`.slice(0, 1)`). 4 of 7 cases failed: the enabled and disabled purge cases on both stores.
- **Recheck, no `rag_validate_chunks`:** the external backend changed to skip `rag_validate_chunks`. All 4 cases failed.

## Behaviour changes

None. Only test files were added.

## Tests that failed before the fix

None. No product code changed. The mutation runs above show that the new cases fail when the behaviour they guard is broken.

## Deviations

1. **Recheck RPC counting.** `buildExternal` caches the external backend together with the admin client it was first built with. Because of that, `env.ask()`'s `rpcCalls` never sees `rag_validate_chunks` on an external backend. The test calls `resetBackendFactoryForTests()` before and after each counted request, so the backend is rebuilt inside the request with the recording client. The change is test-side only. Factory and product code are unchanged.
2. **Disabled-target status.** `rag_vector_sync_purge_status` returns one row per target. The plan's "done for both targets" became: done for the backend under test and `not_applicable` for the other, because each canary environment enables only its own external target. A combined case with both stores enabled in one environment is not supported by the factory.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all exit 0.
- **Real stores:** a Docker daemon was available, and the pinned compose images ran from `docker-compose.backends.yml`. The command was `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant QDRANT_URL=http://127.0.0.1:6333 WEAVIATE_URL=http://127.0.0.1:8080` plus the four compose placeholder keys, then `npx vitest run tests/rag/canary tests/rag/backend-conformance`. Result: 16 files passed, 229 tests passed, 9 skipped, 0 failed.
  - `purge.test.ts`: 7 passed, 6 of them external.
  - `source-recheck.test.ts`: 4 passed, all external.
- **Default run:** `npx vitest run tests/rag/canary` (pgvector only): 9 files passed, 2 skipped, 47 tests passed.
- **Not run:** no SQL, workflows, Python, contracts or UI were touched, so their gates were skipped. The full vitest suite was not run, because no shared code changed.

## Deferred

- When the conformance suite runs locally without the four `*_API_KEY` variables set, `tests/rag/backend-conformance/weaviate.test.ts` fails with 401, because only the canary factory falls back to the compose placeholders. CI exports the keys, so the job is not affected. A shared fallback to the placeholders is optional.

## Operator actions

None. The real-store runs above used local placeholder keys and synthetic content.
