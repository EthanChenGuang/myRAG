---
phase: 06-query-layer-llamaindex-langchain
plan: 21
subsystem: rag-cache
tags: [semantic-cache, pgvector, redisvl, sidecar, fail-open, tenant-isolation]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: 06-12 rag_cache_* functions (0603), 06-17 cache types/keys/bypass, 06-11 generated Cache* schemas, 06-10 deps.ts
  - phase: 03-unified-ingestion-embedding-profiles
    provides: 03-13 publish stage
  - phase: 03.1-tiered-parsing-incremental-queue-bulk-backfill
    provides: 03.1-39 softDeleteLineage
  - phase: 05.1-prompt-injection-defense
    provides: 05.1-21 last Phase 5.1 edit of deps.ts
provides:
  - createPgvectorSemanticCache (src/lib/rag/cache/pgvector.ts)
  - createRedisvlSemanticCache (src/lib/rag/cache/redisvl-http.ts)
  - getSemanticCache, withFailOpen, SEMANTIC_CACHE_TIMEOUT_MS (src/lib/rag/cache/index.ts)
  - RagDeps.semanticCache seam
  - redisvlInvalidationTarget (src/lib/rag/cache/emit.ts) and emission from publish and soft delete
affects: [06-30, 06-32, 06-36, 06-40, 06-42, 06-46]

actuals:
  tokens: 90000
  tasks: 3
  commits: 7
plan_head_before: 582e0b5

tech-stack:
  added: []
  patterns:
    - "Fail-open wrapper: request signal + 150 ms deadline via AbortSignal.any; settles with the fallback on error, deadline or abort; late backend rejections observed"
    - "Backends throw typed SemanticCacheBackendError (reason/code only, safe to log); the wrapper logs one [Semantic Cache] line per event with a 12-hex sha256 of the tenant key"

key-files:
  created:
    - src/lib/rag/cache/pgvector.ts
    - src/lib/rag/cache/redisvl-http.ts
    - src/lib/rag/cache/index.ts
    - src/lib/rag/cache/wire.ts
    - src/lib/rag/cache/emit.ts
    - tests/rag/cache/pgvector.test.ts
    - tests/rag/cache/redisvl-http.test.ts
    - tests/rag/cache/index.test.ts
    - tests/rag/cache/invalidation-emit.test.ts
    - tests/rag/cache/fixtures.ts
    - tests/rag/cache/fake-rpc.ts
    - tests/rag-db/semantic-cache-adapter.test.mts
  modified:
    - src/lib/rag/cache/types.ts
    - src/lib/rag/deps.ts
    - src/lib/rag/ingest/stages/publish.ts
    - src/lib/rag/ingest/soft-delete.ts

key-decisions:
  - "CacheQuery gains optional maxDistance (caller-supplied threshold; 06-32 passes the configured or calibrated value, else config.maxDistance) and signal; invalidateTenant takes optional { signal }"
  - "getSemanticCache(config, io) takes its IO (admin client, fetch, sidecar URL/secret) explicitly so cache/index.ts does not import deps.ts; RagDeps.semanticCache builds it from RAG_SEMANTIC_CACHE (off, or not v2: null)"
  - "redisvl without RAG_SIDECAR_URL or RAG_SIDECAR_SECRET gives null with one warning"
  - "Invalidation is not on the request path, so the wrapper gives it a 2000 ms deadline; check and store use 150 ms"
  - "RedisVL: a schema-invalid or non-2xx response rejects (wrapper: logged miss); a hit is re-validated with rag_cache_sources_current, and a hit without an admin client is not served; a hit beyond the requested distance is a miss"
  - "Stored query text: maskPII, trimmed, capped at 8000 chars (the sidecar contract max) for both backends"
  - "Publish emits [documentId, supersededDocumentId]; soft delete emits a whole-tenant invalidation because the lineage id is not a document id (06-30's sidecar drops every tenant entry anyway). Both emit for every successful RPC outcome (published/already_current/quarantined; deleted/already_deleted)"

requirements-completed: [CACHE-01]

coverage:
  - id: D1
    description: "pgvector backend: RPC args from scopeKey(scope), key hash, profile, halfvec literal, threshold; CachedAnswerSchema miss; masked text; refusal TTL; two tenants and two profiles through the adapter on PGlite"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "npx vitest run tests/rag/cache/pgvector.test.ts && node --import tsx --test tests/rag-db/semantic-cache-adapter.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "RedisVL HTTP backend, fail-open wrapper (150 ms, abort, error, logging without query text), selector and RagDeps seam; two-tenant request bodies; refusals never stored or served"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "npx vitest run tests/rag/cache/redisvl-http.test.ts tests/rag/cache/index.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "RedisVL invalidation emission from publish and soft delete; none with pgvector, off or a failed RPC; never awaited, never fails ingest"
    requirement: CACHE-01
    verification:
      - kind: unit
        ref: "npx vitest run tests/rag/cache/invalidation-emit.test.ts tests/rag/ingest"
        status: pass
    human_judgment: false

duration: 75min
completed: 2026-11-25
status: complete
---

# Phase 6 Plan 21: Semantic cache backends Summary

**Both semantic-cache backends now sit behind one fail-open contract. pgvector calls the 0603 functions; RedisVL calls the sidecar with the shared secret and re-checks every hit against the database. The tenant always comes from `scopeKey(TenantScope)`. A cache error, a 150 ms timeout or an abort is a miss or a dropped write, never a request failure. With RedisVL, a successful publish or soft delete schedules a best-effort invalidation.**

## Accomplishments

- **pgvector** (`createPgvectorSemanticCache`): `rag_cache_check` / `rag_cache_store` / `rag_cache_invalidate` with `p_tenant_key = scopeKey(scope)`, `computeCacheKeyHash(q)`, the profile id, a `[..]` halfvec literal (finite values only) and the caller's threshold. A row whose answer fails `CachedAnswerSchema` is a miss. Store masks the query, sends `source_versions` and the refusal TTL (600 s) or the normal TTL (3600 s).
- **RedisVL** (`createRedisvlSemanticCache`): POSTs to `/v1/cache/check`, `/store`, `/invalidate` with `x-sidecar-secret`. Requests and responses are validated with the generated schemas. Refusals are never stored (no fetch) and never served. A hit is checked with `rag_cache_sources_current`; a stale hit is a miss plus one fire-and-forget invalidate.
- **Wrapper and selector** (`withFailOpen`, `getSemanticCache`): 150 ms deadline combined with the request signal; one `[Semantic Cache]` warning per failure with backend, operation, reason and a hashed tenant key. No query text, answer or error message is logged.
- **Deps seam**: `RagDeps.semanticCache()` returns null when `RAG_SEMANTIC_CACHE=off` (or the pipeline is not v2); `setRagDepsForTests` replaces it.
- **Emission**: `publish.ts` and `soft-delete.ts` call `invalidateTenant` through `scheduleAfterResponse` only when the backend is `redisvl`.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 (RED) | 10e77ca | test(06-21): add failing pgvector semantic cache adapter tests |
| 1 (GREEN) | 7c6cf35 | feat(06-21): pgvector semantic cache backend |
| 2 (RED) | 113aa72 | test(06-21): add failing RedisVL adapter, fail-open wrapper and deps seam tests |
| 2 (GREEN) | d7a40ec | feat(06-21): RedisVL HTTP backend, fail-open selector and deps seam |
| 3 (RED) | 107db55 | test(06-21): add failing RedisVL invalidation emission tests |
| 3 (GREEN) | de397b1 | feat(06-21): emit RedisVL cache invalidation from publish and soft delete |

## Tests that failed before the change

- Task 1: 13 of 14 unit cases and all 7 PGlite adapter cases (stub returned null/0; assertions such as "expected a hit").
- Task 2: 23 of 33 cases (stub backend, `getSemanticCache` returning null, wrapper without a deadline, deps seam returning null).
- Task 3: 6 of 13 cases (no emission from publish or soft delete); the "no call" cases passed already, as expected.

## Baseline for Task 3 (precondition, re-measured)

- `grep -c invalidateTenant src/lib/rag/ingest/stages/publish.ts` = 0 and `... soft-delete.ts` = 0 before any edit (both files exist). After: 1 and 1.
- `npx vitest run tests/rag/ingest`: 66 files, 1137 passed, 1 skipped, after the change.

## Acceptance gates

- `scopeKey` in pgvector.ts: 4; `x-sidecar-secret` in redisvl-http.ts: 2; `[Semantic Cache]` in index.ts: 2; `semanticCache` in deps.ts: 3; `invalidateTenant` in publish.ts and soft-delete.ts: 1 each.
- `tests/rag-db/semantic-cache-adapter.test.mts`: 7 passed, 0 failed.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors; `npm run typecheck:new`: clean
- `npx vitest run`: 348 files, 5757 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 172 passed, 0 failed
- `node --import tsx --test tests/rag-db/*.test.mts`: 1800 passed, 0 failed, 4 skipped
- `check-rag-boundary` and its node tests, `check-config`, `check-workflows`: pass
- `npm run test-rag -- --out eval/out/06-21`: gate PASS (7 skipped)
- `npm run test-rag -- --fixture-mode ingest --out eval/out/06-21-ingest`: gate PASS (7 skipped)
- No Python, contract, env or UI files touched.

## Deviations

- `src/lib/rag/cache/types.ts` (not in `files_modified`): `CacheQuery.maxDistance?` and `signal?`, `CacheCallOptions` for `invalidateTenant`. Needed for the caller-supplied threshold and the 150 ms / abort contract.
- Two helper modules not in the plan: `cache/wire.ts` (typed error, halfvec literal, masking, threshold check) and `cache/emit.ts` (`redisvlInvalidationTarget`, kept out of `index.ts` to avoid an `index.ts` ↔ `deps.ts` import cycle). Extra test files: `tests/rag/cache/index.test.ts`, `fixtures.ts`, `fake-rpc.ts`.
- Soft delete invalidates the whole tenant instead of `[documentId]`: `rag_soft_delete_document` returns only the lineage id.

## Decisions for STATE

- CACHE-01 app side: both backends behind `getSemanticCache` with fail-open (150 ms check/store, 2000 ms invalidate). `RagDeps.semanticCache()` is the seam 06-32 and 06-36 use. `CacheQuery.maxDistance` carries the calibrated threshold.
- RedisVL never stores or serves refusals (plan-check W1); pgvector keeps them with trigger invalidation.

## Operator actions

- Live check (not run): with `RAG_SEMANTIC_CACHE=redisvl`, a running sidecar with the `cache` extra and `REDIS_URL` (plan 06-30), store, check and invalidate one entry, then publish a document and confirm the tenant's entries are gone.

## Deferred

- The pipeline stage using the cache: 06-32; route streaming and store: 06-36; sidecar endpoints: 06-30.
- Invalidation emission for app paths that change documents without `publish` or `softDeleteLineage` (legacy writers, hard deletes): the per-hit `rag_cache_sources_current` check and the TTL cover these for answers with sources; refusals are not cached in RedisVL.
