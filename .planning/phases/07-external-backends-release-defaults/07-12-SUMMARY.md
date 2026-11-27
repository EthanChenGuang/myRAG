---
phase: 07-external-backends-release-defaults
plan: 12
subsystem: rag-retrieval-backend
tags: [backend-factory, readiness, fallback, latency-race, trace, config-hash]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "RagConfig.backend (07-04), RagTrace.retrieval_backend contract (07-05), createExternalBackend, BackendNotReadyError and rag_backend_readiness (07-06), Qdrant and Weaviate adapters (07-07, 07-08)"
  - phase: 04-hybrid-retrieval
    provides: "registry and backendForRequest (04-17), v2 search stage (04-19, 04-29), trace counts (04-08), computeRetrievalConfigHash (04-44)"
provides:
  - "src/lib/rag/backend/readiness.ts: isBackendReady, READINESS_TTL_MS, resetReadinessCacheForTests"
  - "src/lib/rag/backend/factory.ts: resolveRetrievalBackend, selectedBackendId, EXTERNAL_SEARCH_TIMEOUT_MS, warnBackendIgnoredOnLegacy, setExternalBackendForTests, resetBackendFactoryForTests"
  - "src/lib/rag/backend/index-params.ts: backendIndexParams, WEAVIATE_INDEX (SDK-free index settings for the hash)"
  - "types.ts: BackendDegradedReason, BackendFallbackReason, RetrievalBackendSelection, RetrievalOverrides.backend"
  - "search span attributes backend, fallback_reason, tenant_validation_dropped; the same three fields on the [RAG Trace] search stage and RagTrace.retrieval_backend"
affects: [07-13, 07-14, 07-15, 07-16, 07-25, 07-34]

actuals:
  tasks: 3
  commits: 8

tech-stack:
  added: []
  patterns:
    - "One resolved backend per request: the pgvector choice is the registry object itself (no wrapper, no readiness read); an external choice is a per-request wrapper that falls back to that same object"
    - "Span fields travel as StageRecord.attributes; the log, the eval trace and the result reason read them from the search record, so nothing new is threaded through RetrievalResult"

key-files:
  created:
    - src/lib/rag/backend/readiness.ts
    - src/lib/rag/backend/factory.ts
    - src/lib/rag/backend/index-params.ts
    - tests/rag/backend/readiness.test.ts
    - tests/rag/backend/fallback.test.ts
    - tests/rag/v2/search-backend.test.ts
  modified:
    - src/lib/rag/backend/registry.ts
    - src/lib/rag/backend/weaviate/collection.ts
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/v2/config-hash.ts
    - src/lib/rag/v2/result.ts
    - src/lib/rag/pipeline.ts
    - src/lib/rag/types.ts
    - src/lib/rag/trace/log.ts
    - src/lib/rag-eval/trace.ts
    - src/app/api/internal/rag/run/route.ts

key-decisions:
  - "Readiness: ready only when state = ready and max(outbox_lag_seconds, lag_seconds) <= RAG_VECTOR_SYNC_MAX_LAG_SECONDS. The row is cached 30 s per (target, profile, canonicalTenantKey); the max lag is applied at read time, so a config change takes effect on cached rows. A failed read is cached as 'no row' for the TTL (a broken database is not asked on every request); a missing admin client is not cached. Warnings at most once per minute, `[RAG Backend]`, no tenant key"
  - "Selection (D-24): v2 only; voice reads config.backend.voice; eval takes retrieval_overrides.backend, then the default; chat and embed read the default. Under legacy selectedBackendId is always pgvector"
  - "Decision tree per external call: readiness (once per embedding profile per request) -> not ready: pgvector, backend_not_ready. Ready: external call; a BackendNotReadyError is backend_not_ready, RetrievalBackendError filter_unsupported is filter_unsupported (not degraded), anything else and the 800 ms timeout are backend_error. A backend that cannot be built (no URL) is backend_error. A request abort is never a fallback: it rejects"
  - "Race (A-8): past the profile's search budget (latency-budgets.json: chat and embed 400 ms, voice 300 ms; eval none) pgvector starts beside the external call. First valid answer wins and the loser is aborted; pgvector winning is backend_slow (degraded), the external winning is not degraded. If one side fails the other is awaited; if both fail, the pgvector error is thrown (the stage fails as today). Eval has neither timeout nor race"
  - "Selection record: fallbackReason is the first degrading reason of the request (a degrading reason replaces filter_unsupported); backend is the external id only when every call was served externally, else pgvector; tenantValidationDropped sums legs.meta over the external answers"
  - "Translation legs keep running on pgvector (the wrapper exposes pgvector's searchTranslations): translations live only in Postgres. Capability routing (backendForRequest) now takes the resolved backend; external backends declare no capabilities, so version-scope and identifier requests go to pgvector with backend_field_unsupported as before"
  - "Config hash: for pgvector the inputs are byte-identical (backend_id is the registry id, no new key); the default hash is pinned in the test to the value computed on the commit before this plan (cd5802e6...). For an external choice backend_id is the choice and backend_index = { collection, hnsw_m, hnsw_ef, lexical_mode, quantization: none }. The hash uses the configured choice, not the backend that served, so the semantic-cache key and the result hash agree before search runs"
  - "Result reason: degradedReason returns backend_not_ready, backend_error or backend_slow when a degraded search record carries it (after skipped stages, before the detector and generic reasons)"
  - "The search detail gains the fallback reason code only when a fallback happened, so default details (and eval retrieval_strategy) are unchanged"

requirements-completed: [RET-09, RET-07, RET-01]

coverage:
  - id: D1
    description: "Readiness: ready/lagging/building/stale/failed/missing row; reconcile lag; 30 s TTL per target, profile, tenant; max lag applied to cached rows; RPC error, rejection and null client are not ready without throwing; warning at most once a minute; upper- and lower-case scope share one entry"
    requirement: RET-09
    verification:
      - kind: unit
        ref: "tests/rag/backend/readiness.test.ts"
        status: pass
  - id: D2
    description: "Factory: defaults return the pgvector object with no readiness read for chat, embed, voice and eval; chat qdrant and voice pgvector; eval override only for eval; not ready; error; 800 ms timeout; eval without timeout or race; race both ways with the loser aborted; filter_unsupported not degraded; BackendNotReadyError; dropped counts summed; request abort; unbuildable backend; legacy warns once across two requests and never reaches the external backend"
    requirement: RET-09
    verification:
      - kind: unit
        ref: "tests/rag/backend/fallback.test.ts"
        status: pass
  - id: D3
    description: "Search stage: default span fields and unchanged status and detail; every variant through the selected backend with summed dropped counts; not-ready fallback degrades the stage and the result reason; [RAG Trace] fields without query or chunk text; RagTrace.retrieval_backend validates with the generated schema; pinned pgvector default hash; pgvector vs qdrant vs weaviate and lexical_mode change the hash; the buffered defaulted-v2 attempt keeps span attributes"
    requirement: RET-07
    verification:
      - kind: unit
        ref: "tests/rag/v2/search-backend.test.ts"
        status: pass

duration: 2h
completed: 2026-11-27
status: complete
---

# Phase 7 Plan 12: Backend factory, readiness and pgvector fallback Summary

**The retrieval backend is now chosen per entry point under `RAG_PIPELINE=v2`. An external backend runs only when its index state is ready. When it is not ready, fails, times out (800 ms) or is slower than pgvector past the search budget, pgvector answers in the same request and the result is reported `degraded`. The search span, the `[RAG Trace]` line and the eval trace record which backend served and why. With the defaults nothing changes: the pgvector backend object, no readiness read, and the same config hash.**

## Task Commits
1. Task 1 (readiness): RED `86ef73c3` (stub module; 12 of 12 failed on assertions), GREEN `2663ea55`.
2. Task 2 (factory): RED `e024b77b` (stub factory plus the new types; 14 of 15 failed on assertions, the defaults case passed against the stub by design), GREEN `afd9c407` (factory, legacy warning in `pipeline.ts`, eval route mapping of `retrieval_overrides.backend`).
3. Task 3 (search stage, trace, hash): RED `e8592d97` (test plus the pure `index-params.ts` helper; 6 of 7 failed on assertions against the pre-task code, which is also where the pinned default hash was taken from), RED `84462a1c` (buffered-collector regression test), GREEN `960ab005`.

## Behaviour changes
- Defaults (`RAG_RETRIEVAL_BACKEND=pgvector`, `RAG_RETRIEVAL_BACKEND_VOICE=pgvector`): the search stage calls the same registry object as before, no readiness RPC, unchanged status, detail and hash. New, additive: the v2 search span carries `attributes { backend: 'pgvector', tenant_validation_dropped: 0 }`, the `[RAG Trace]` search stage carries `backend`, `fallback_reason: null`, `tenant_validation_dropped`, and v2 eval traces carry `retrieval_backend`.
- `RAG_PIPELINE=legacy` with a non-pgvector backend: one `[RAG Config]` warning per process, nothing else from Phase 7 runs.
- Fix: the buffered collector of a defaulted v2 attempt dropped every stage's `attributes` on commit (Langfuse span metadata was lost on that path). It now copies them.

## Tests that failed before the change
- `tests/rag/backend/readiness.test.ts`: all 12 against the stub.
- `tests/rag/backend/fallback.test.ts`: 14 of 15 against the stub (every case except defaults).
- `tests/rag/v2/search-backend.test.ts`: 6 of 7 against the pre-task-3 code; the buffered-collector case fails on the old `pipeline.ts` with `expected undefined to deeply equal { backend: 'pgvector', … }`.

## Mutation guards (run by hand, then reverted)
- Calling `isBackendReady` on the pgvector path (the plan's guard): `fallback.test.ts -t defaults` fails (`expected [ Array(4) ] to deeply equal []`).

## Acceptance
- `grep -c "30_000\|30000" readiness.ts`: 1. `grep -cE "EXTERNAL_SEARCH_TIMEOUT_MS[ ]*=[ ]*800" factory.ts`: 1. `grep -c backend_not_ready types.ts`: 1. `grep -c resolveRetrievalBackend search.ts`: 2. `grep -c tenant_validation_dropped log.ts`: 3.
- `fallback.test.ts -t defaults`: 1 passed, 0 failed. `search-backend.test.ts -t "default hash"`: 1 passed, 0 failed.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `npm run typecheck:new`: no Phase 1 type errors.
- Full `npx vitest run` (core types, `pipeline.ts` changed): 667 files passed, 12169 tests passed, 79 skipped; 4 files failed only on 60 s hook or test timeouts under load (`citations/chat-claude-route`, `citations/claude-notice`, `documents-versions`, `ingest/enqueue-nango`). Rerun alone: 4 files, 58 passed, 0 failed.
- Targeted before that: `npx vitest run tests/rag/v2 tests/rag/trace-log.test.ts tests/rag/backend`: 52 files, 791 passed.
- `check-rag-boundary`, `check-config`, `check-language-literals`, `check-settings-classification`: all ok.
- `node --import tsx --test` on `tests/rag-db/vector-sync-schema`, `vector-sync-reconcile`, `hybrid-grants`, `search-path-empty`, `search-rpc-grants-pglite`, `definer-search-path-pglite` (the readiness RPC's callers, plus the grants and search-path tests): 141 tests, 140 passed, 0 failed, 1 skipped.
- `npm run test-rag -- --out eval/out/07-12`: gate PASS, `passed: true`, `paired.all_zero: true`. `npm run test-rag -- --fixture-mode ingest --out eval/out/07-12-ingest`: gate PASS.
- `eslint` on the changed files: 0 new errors (the 6 errors are on lines from earlier plans: `_hash`/`_prov` in config-hash.ts, `params` in result.ts, `_versionScope` in search.ts).
- Not run: Python suites, workflows, `gen:schemas` (no contract change; `RagTrace.retrieval_backend` from 07-05 is used as is), UI checks (no UI).

## Deviations from Plan
1. **Files beyond the plan's list:** `src/lib/rag/v2/result.ts` (the hash call site lives there, not in `config-hash.ts`), `src/app/api/internal/rag/run/route.ts` (maps `retrieval_overrides.backend` to `RetrievalOverrides.backend`, and adds `retrieval_backend` to the eval trace, which is built in the route, not in `rag-eval/trace.ts`; that module provides `retrievalBackendTrace`), `src/lib/rag/backend/index-params.ts` (new) and `src/lib/rag/backend/weaviate/collection.ts` (reads its HNSW m, ef and lexical mode from `WEAVIATE_INDEX`, so the hash and the collection share one source without pulling the Weaviate SDK into the hash module).
2. **`trace/collector.ts` unchanged:** `StageEntry.attributes` already existed, so the span fields need no collector change. The fix went into the buffered collector in `pipeline.ts`.
3. **No `RetrievalResult.retrievalBackend` field.** The eval trace, the log and the result reason read the search record's attributes, so the result shape stays as it was.
4. **Voice timeout:** D-11 names 800 ms for chat and embed and none for eval; voice (only when an operator opts in) also gets 800 ms, and its race budget is the voice search budget (300 ms).
5. **The eval route mapping has no route-level test.** `toRetrievalOverrides` is not exported; the factory test covers the override's effect.

## Decisions for STATE
- Fallback reasons and their degraded status: backend_not_ready, backend_error and backend_slow are degraded; filter_unsupported is not. They are also the result `reason` when the search stage is the cause.
- The config hash carries the configured backend choice, not the backend that served.
- Translation legs stay on pgvector whatever backend is chosen.

## Operator actions
- None. No live vendor call was made; the Qdrant and Weaviate runs are the 07-16 canary job.

## Deferred
- The Config UI warning for an external backend under legacy (D-11 third clause) belongs to the Config UI plans (07-31, 07-33).
- The plan's PGlite ordering note (07-10, 07-11 first) did not apply: this plan adds no migration and runs no new PGlite test.
