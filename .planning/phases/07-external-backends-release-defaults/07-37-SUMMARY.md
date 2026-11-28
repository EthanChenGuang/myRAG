---
phase: 07-external-backends-release-defaults
plan: 37
subsystem: rag-retrieval-backend
tags: [source-recheck, stale-index, vector-sync, ret-05, ret-14, purge-seam]

requires: ["07-06", "07-12", "07-13", "07-14", "07-34", "07-35", "07-36", "06.3-07", "06.3-15"]
provides:
  - "src/lib/rag/backend/source-recheck.ts: isExternalBackendId(id: unknown): id is ExternalBackendId ('weaviate' | 'qdrant')"
  - "src/lib/rag/backend/source-recheck.ts: sourceRecheckDecision(backendUsed: BackendId, configured: boolean): SourceRecheckDecision { run: boolean; forced: boolean } — weaviate/qdrant → { run: true, forced: true } whatever configured is; pgvector → { run: configured, forced: false }"
  - "BackendLegsMeta.sourceRecheck?: { checked: number; dropped: number } (set by createExternalBackend on every external result) and BackendLegsMeta.sourceRecheckIds?: { checked: readonly string[]; dropped: readonly string[] } (ids, read only by the factory; never traced or logged)"
  - "RetrievalBackendSelection.sourceRecheck?: { checked: number; dropped: number } — set only when every search call of the request was served by the external backend (absent on any pgvector fallback); ResolvedRetrievalBackend.staleChunkIds(): string[]"
  - "src/lib/rag/backend/stale-repair.ts: scheduleStaleRepair({ target, scope, chunkIds }, deps?): void; STALE_REPAIR_INTERVAL_MS = 60_000; STALE_REPAIR_MAX_IDS = 200; resetStaleRepairForTests(); setStaleRepairDepsForTests(deps | null)"
  - "search span attribute stale_index_drop (external backends only); SearchStagesOutput.sourceRecheck / RetrievalResult.sourceRecheck carry the external marker, so the run route's existing stale_index_drop mapping covers both backends"
affects: [06.3-14, 07-44]

actuals:
  tasks: 3
  commits: 4

key-files:
  created:
    - src/lib/rag/backend/source-recheck.ts
    - src/lib/rag/backend/stale-repair.ts
    - tests/rag/backend/source-recheck.test.ts
    - tests/rag/backend/stale-repair.test.ts
    - tests/rag-db/source-recheck-external.test.mts
    - tests/rag-db/purge-seam.test.mts
  modified:
    - src/lib/rag/backend/external.ts
    - src/lib/rag/backend/factory.ts
    - src/lib/rag/backend/types.ts
    - src/lib/rag/types.ts
    - src/lib/rag/v2/stages/search.ts

key-decisions:
  - "One query, two counters (planner resolution): createExternalBackend's single rag_validate_chunks call is the recheck; stale_index_drop counts every id it dropped, tenant_validation_dropped and the [RAG Security] line are unchanged."
  - "The Phase 6.3 recheck site is runSearchStages in src/lib/rag/v2/stages/search.ts (not runV2Pipeline): the only edit there is the gate `sourceRecheckDecision(served.backend, config.sourceRecheck)` plus the skip when the backend result carries sourceRecheck. src/lib/rag/v2/pipeline.ts already passed search.sourceRecheck through, so it is unchanged (listed in files_modified, no edit needed)."
  - "The external marker is used only when the decision is run && forced, so the decision really gates it (the plan's guard mutation 'run false for qdrant' fails the tracer test)."
  - "An external result without a marker (a non-standard backend) is still rechecked by the Phase 6.3 stage, even with RAG_SOURCE_RECHECK off (forced)."
  - "Mixed requests (some calls external, some pgvector fallback) carry no marker and follow the switch; the ids the external calls dropped are still sent to the stale repair."
  - "Stale repair: deduplicated, UUID-shaped, lower-cased ids, first 200; one call per (target, canonical tenant key) per 60 s, in-process map capped at 1000 keys (oldest evicted); scheduled with after(), a no-op outside a request scope (the rate entry is rolled back); after a successful enqueue it calls kickVectorSync(); every error → one '[Vector Sync] stale repair failed' warning with { code, requested } only."
  - "rag_vector_sync_enqueue_stale refuses the whole batch (tenant_mismatch) if a dropped id is another tenant's chunk; the repair then logs one warning and the foreign point is left to the reconcile. No second query splits foreign from stale ids (planner resolution)."
  - "Phase 6.3 purge seam: the purge entry point at HEAD is the SQL function rag_purge_lineage (0727), not a TS module under src/lib/rag/ (06.3-20 has not landed). It calls rag_vector_sync_enqueue_purge after v_ids is resolved and before any delete, with p_tenant_key (its own argument, guarded by rag_ingest_assert_tenant_key and the tenant-scoped lineage lock). The seam check passes; no Phase 6.3 code was edited."
  - "No migration, env variable, switch or Config UI change."

requirements-completed: []
requirements-advanced: [RET-05, RET-14]
---

# 07-37 Summary: forced source recheck on Weaviate and Qdrant, counted and repaired

On Weaviate and Qdrant, the single `rag_validate_chunks` re-validation is now the RET-14 source recheck. It cannot be switched off. Its drops are counted as `stale_index_drop` on the search span and the retrieval result. After the response they are sent to the outbox for the caller's tenant, at most 200 ids per call and one call per target and tenant per minute. The Phase 6.3 `source_recheck` stage does not query again for those candidates. The pgvector default path is unchanged.

## Preconditions

- The depends_on SUMMARYs (07-06, 07-12, 07-13, 07-14, 07-34, 07-35, 07-36, 05-25, 06-45, 05.1-22, 03.1.1-14, 03.2-68, 04.1-12, 04.1.1-14) and the ones the orchestrator named (06.3-07, 06.3-15, 07-28, 07-34) are all on the base `origin/ci/merge-train-40`.
- 05-, 05.1- and 06-VERIFICATION.md: `status: human_needed`.
- Phase 6.3: there is no 06.3-VERIFICATION.md. At HEAD `RAG_SOURCE_RECHECK` is read in src/lib/env.ts and `stale_index_drop` exists under src/lib/rag/. `rag_vector_sync_enqueue_purge` is called from SQL (0727 `rag_purge_lineage`), not from a module under src/lib/rag/, because the TS purge library is 06.3-20 and has not landed. I took the SQL call as the seam the precondition means. Task 3 proves it: see Deviations.

## Signatures for 06.3-14

```ts
// src/lib/rag/backend/source-recheck.ts
export type ExternalBackendId = Extract<BackendId, 'weaviate' | 'qdrant'>;
export function isExternalBackendId(id: unknown): id is ExternalBackendId;
export interface SourceRecheckDecision { run: boolean; forced: boolean }
export function sourceRecheckDecision(backendUsed: BackendId, configured: boolean): SourceRecheckDecision;
//   weaviate | qdrant -> { run: true, forced: true }      (RAG_SOURCE_RECHECK ignored)
//   pgvector          -> { run: configured, forced: false }

// src/lib/rag/backend/types.ts, BackendLegsMeta (written by createExternalBackend on every external result)
sourceRecheck?: { checked: number; dropped: number };
sourceRecheckIds?: { checked: readonly string[]; dropped: readonly string[] }; // ids, factory only, never traced

// src/lib/rag/types.ts, RetrievalBackendSelection (from ResolvedRetrievalBackend.selection())
sourceRecheck?: { checked: number; dropped: number }; // only when every call was served externally
// src/lib/rag/backend/factory.ts, ResolvedRetrievalBackend
staleChunkIds(): string[];
```

The call site in `runSearchStages` (src/lib/rag/v2/stages/search.ts) is already wired:

- `decision = sourceRecheckDecision(served.backend, config.sourceRecheck)`
- `externalRecheck = decision.run && decision.forced ? served.sourceRecheck : undefined`
- The 6.3 stage runs only when `decision.run && !externalRecheck`. The output's `sourceRecheck` is `externalRecheck ?? recheck.marker`.

06.3-14 therefore only needs its tests, plus the voice/legacy sites in src/lib/rag/pipeline.ts if Phase 7's factory ever serves them. Today it does not: those paths are pgvector only.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1+2 code | f773a01d | feat(07-37): forced source recheck on external backends, counted and repaired |
| 2 tests | f9a1b67b | test(07-37): one recheck query on external backends and a bounded stale repair |
| 3 | bbc8129d | test(07-37): the Phase 6.3 lineage purge reaches the vector sync outbox seam |
| summary | (this commit) | docs(07-37): plan summary |

## Behaviour changes

- With RAG_RETRIEVAL_BACKEND or RAG_RETRIEVAL_BACKEND_VOICE set to weaviate or qdrant:
  - The search span carries `stale_index_drop`, and `RetrievalResult.sourceRecheck` is set whatever RAG_SOURCE_RECHECK says.
  - The Phase 6.3 `rag_source_recheck` query no longer runs for those candidates, so there is one query instead of two when the switch is on.
  - Drops schedule one `rag_vector_sync_enqueue_stale` call after the response, then one drain slice.
- pgvector (the default) and pgvector fallbacks behave exactly as before: same span attributes and the same Phase 6.3 stage behind RAG_SOURCE_RECHECK. Strict refusal, webSearch, `source_images`, `{{context}}`, voice and embed are untouched.

## Tests that failed before the change / guard mutations

- `tests/rag-db/source-recheck-external.test.mts` "RAG_SOURCE_RECHECK off": mutating `sourceRecheckDecision` to return run=false for qdrant with the switch off fails 2 of 2 (both modes). Restored: passes.
- `tests/rag/backend/source-recheck.test.ts -t "one query"`: removing the `!externalRecheck` skip at the 6.3 call site fails 2 tests (a second `rag_source_recheck` call). Restored: passes.
- Process note: the code and tests were committed after both were written, not as a separate RED commit. The new modules did not exist before, so a RED commit would only have failed on module-not-found, which the brief rules out. The guard mutations above stand in for it.

## Gates run

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npm run typecheck:new` | pass |
| `node scripts/ci/check-rag-boundary.mjs`, `scripts/check-config.mjs`, `scripts/ci/check-language-literals.mjs`, `scripts/ci/check-settings-classification.mjs` | all exit 0 |
| `npx vitest run tests/rag/backend tests/rag/v2 tests/rag/canary` (every importer of the changed backend/search modules, new tests included) | 69 files passed, 3 skipped; 968 tests passed, 127 skipped |
| `node --import tsx --test tests/rag-db/source-recheck-external.test.mts tests/rag-db/purge-seam.test.mts tests/rag-db/vector-sync-tracer.test.mts tests/rag-db/source-recheck.test.mts tests/rag-db/purge-outbox.test.mts tests/rag-db/vector-sync-stale-enqueue.test.mts` (single- and multi-tenant) | 51 passed, 0 failed, 4 skipped (mode-specific skips: the other-tenant case has no second tenant in single-tenant, plus purge-outbox's 0740-present branch skips) |

Not run locally:
- Full `npx vitest run`: started, then stopped under the orchestrator's 2026-11-28 speed rule (targeted gates only; the merge train runs the full suites).
- `npm run test-rag` (both fixture modes): not run under the same rule. The default pgvector path is unchanged, and the merge train covers it.
- No SQL or migration changed, so no grants or search-path test applied.

## Deviations

1. Phase 6.3 seam location: the purge entry point is the SQL function `rag_purge_lineage` (0727). Its USING clause passes positional arguments. The test maps them to the 0740 signature names (p_tenant_key, p_lineage_id, p_document_ids, p_actor, p_reason_code). Its tenant guard is `rag_ingest_assert_tenant_key`.
2. Recheck site: it is in `runSearchStages` (search.ts), not `runV2Pipeline`, so pipeline.ts needed no edit.
3. Added the `setStaleRepairDepsForTests` test seam, so the PGlite tracer can capture the after() task outside a Next request scope.

## Operator pending

- None for this plan. The live Weaviate/Qdrant backend canary (07-14/07-34 CI job) exercises the forced recheck against real stores.

## Next

- 06.3-14: add its tests on top of the wired gate (see Signatures).
- 07-44: may read `stale_index_drop` from the search span.
