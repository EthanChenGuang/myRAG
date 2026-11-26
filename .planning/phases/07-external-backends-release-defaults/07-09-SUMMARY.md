---
phase: 07-external-backends-release-defaults
plan: 09
subsystem: rag-vector-sync
tags: [vector-sync, drain, outbox, logging, langfuse]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "0703 claim/complete/fail/checkpoint/expand RPCs (07-02), VectorSyncSliceReport (07-05), tracer drain, VectorStore and fake store, 0705 reads (07-06)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "Langfuse exporter, config and deterministic sampling (02-22)"
provides:
  - "src/lib/rag/sync/claim.ts: claimBatch, completeRows, failRow, checkpointRow, expandRow, readSyncProfiles, readDocumentRows, readChunkRow (throw RetrievalBackendError on any RPC error)"
  - "src/lib/rag/sync/servable.ts: pure planDocumentSync / planChunkSync and toPoint (D-03 payload)"
  - "src/lib/rag/sync/drain.ts: drainSlice (coalescing, paging, cursor resume, expansion, retries, multi-store) and drainUntilEmpty"
  - "src/lib/rag/sync/log.ts: logVectorSync / buildVectorSyncLogPayload (fixed field list)"
  - "src/lib/rag/sync/trace.ts: traceVectorSync / buildVectorSyncTrace (one vector_sync trace per slice, fire and forget)"
  - "CollectedTrace.name (optional root observation name, default rag-request)"
affects: [07-11, 07-13, 07-14, 07-16, 07-36, 07-38, 07-44]

actuals:
  tasks: 3
  commits: 7

tech-stack:
  added: []
  patterns:
    - "Paged document re-sync: page k covers chunk ids in (after, through]; consecutive pages partition the id space, so each store id is judged by exactly one page and a resumed document deletes stale ids correctly"
    - "Deferral without an attempt: a claimed group not started when the budget runs out is checkpointed at its own cursor (or the nil-UUID restart cursor) so checkpoint gives the attempt back"

key-files:
  created:
    - src/lib/rag/sync/claim.ts
    - src/lib/rag/sync/servable.ts
    - src/lib/rag/sync/log.ts
    - src/lib/rag/sync/trace.ts
    - tests/rag/sync/servable.test.ts
    - tests/rag/sync/drain.test.ts
    - tests/rag/sync/log.test.ts
    - tests/rag/sync/fake-rpc.ts
  modified:
    - src/lib/rag/sync/drain.ts
    - src/lib/rag/trace/langfuse.ts

key-decisions:
  - "Defaults: budgetMs 45000, batch 100, lease 120 s, page 100 (D-04). The loop never takes an abort signal; the budget is checked before each claim, before each group and after each document page"
  - "Coalescing key (target, entity, entity_id, tenant_key, profile_id). A group resumes from a cursor only when every row carries the same one; any fresh row restarts the entity from the beginning (idempotent)"
  - "Document cursor format `<profile_id>@<last chunk id>`; profiles are processed in sorted id order; an unparsable cursor or one naming a profile no longer synced restarts the document"
  - "Restart cursor is the nil UUID 00000000-0000-0000-0000-000000000000: every id sorts after it and rag_vector_sync_expand accepts it, so unstarted tenant, profile, document and chunk groups can all be handed back with checkpoint"
  - "Tenant removal: a tenant row whose first expand page (from a fresh cursor) finds no current documents calls deleteTenant for every synced profile. A tenant whose documents exist but are all non-servable is emptied document by document"
  - "Missing tenant (BackendNotReadyError tenant_missing): upsert creates it once and retries; list and delete treat it as empty. collection_missing fails the group and forgets the process-level ensureCollection cache for that store so the next attempt re-ensures"
  - "ensureCollection is cached per (store object, profile) in a module-level WeakMap; the synced profile list is read once per slice"
  - "Multiple stores: drainSlice takes `store` and/or `stores`; rows of a target without a store fail with target_unavailable (unchanged from the tracer)"
  - "Error codes: RetrievalBackendError -> `<rpc>:<code>` lower-cased, BackendNotReadyError -> `backend_not_ready:<reason>`, anything else -> store_error; never the error message"
  - "Log line keys are exactly mode, claimed, upserted, deleted, failed, dead, lagSeconds, elapsedMs (the tracer's `target` key is gone, per the plan's fixed list). The report is validated with VectorSyncSliceReportSchema.strip() and copied field by field"
  - "Trace: root named vector_sync, one `slice` stage with numeric attributes; the exporter's tenant fields carry the fixed label vector_sync, never a tenant key; sampled with the existing isSampled(trace) on a random id; never awaited; failures swallowed. `trace: false` turns it off"
  - "more_pending is true when the budget stopped the slice and false when a claim came back empty (rows in retry backoff are not claimable now)"

requirements-completed: [RET-05]

coverage:
  - id: D1
    description: "Pure planner: servable upserts, stale deletes, foreign tenant never upserted, page-range deletes, exact D-03 keys; claim wrappers pass arguments and throw on RPC errors"
    requirement: RET-05
    verification:
      - kind: unit
        ref: "tests/rag/sync/servable.test.ts"
        status: pass
  - id: D2
    description: "Coalescing, 250-row paging, cursor resume without an attempt, quarantine/release, tenant move, tenant and chunking-profile expansion, deleteTenant, chunk rows, dead at 8, tenant creation retry, budget stop, deferral"
    requirement: RET-05
    verification:
      - kind: unit
        ref: "tests/rag/sync/drain.test.ts"
        status: pass
  - id: D3
    description: "Fixed-field [Vector Sync] line, extra keys dropped, marker leak test over a full drain, vector_sync trace only when enabled, never blocks"
    requirement: RET-05
    verification:
      - kind: unit
        ref: "tests/rag/sync/log.test.ts"
        status: pass

duration: 1.5h
completed: 2026-11-26
status: complete
---

# Phase 7 Plan 09: Full vector sync drain engine Summary

**The tracer's thin drain is now the full sync engine. It coalesces claimed rows by entity, re-syncs whole documents page by page with a resumable cursor, and expands tenant and profile rows. Rows that fail back off and go dead after the eighth attempt. Each slice writes one counts-only `[Vector Sync]` line and, when Langfuse is on, one `vector_sync` trace.**

## Task Commits
1. Task 1: RED `fd34830a`, GREEN `59f8f3ed`. claim.ts and servable.ts.
2. Task 2: RED `de1bc38a`, GREEN `87f85722`. drain.ts rewrite, plus the scripted fake RPC `tests/rag/sync/fake-rpc.ts`.
3. Task 3: RED `ef969778`, GREEN `8d68b38f`. log.ts and trace.ts, drain wiring, and the optional `CollectedTrace.name`.

The RED commits shipped stub modules with the final exports (no-op or wrong-shape bodies), so every RED run failed on assertions, not on module-not-found. Counts: Task 1, 21 failed; Task 2, 7 failed and 6 passed; Task 3, 4 failed and 2 passed.

## Tests that failed before the change
- Task 2 against the 07-06 tracer drain. Failing cases: coalescing (3 document reads instead of 1), 250-row paging (the tracer page was 500), cursor resume, tenant expansion pages, deleteTenant, the budget stop with `more_pending`, and deferral.
- Six cases already passed on the tracer: quarantine/release, tenant move, chunk rows, dead at 8, tenant retry, and chunking expansion. The tracer already deleted stale ids and called ensureTenant before every upsert.
- Task 3 against the stubs: the fixed fields, the extra-key drop, the enabled trace, and never-blocks.

## Mutation guards (run by hand, then reverted)
- Removing the delete of the document's other store ids: `-t quarantine` fails.
- Turning coalescing off: `-t coalesces` fails.
- Making logVectorSync print the raw report: `-t marker` fails.
- Passing an extra `rows` key into logVectorSync from drain: the test still passes. That is correct, because the stripping in log.ts is itself the defence.

## Acceptance
- `grep -c "export function planDocumentSync" servable.ts`: 1
- `grep -c rag_vector_sync_checkpoint claim.ts`: 1
- `grep -c "\[Vector Sync\]" log.ts`: 1
- `-t "foreign tenant"`: 2 passed. `-t cursor`: 1 passed. `-t quarantine`: 1 passed. `-t marker`: 1 passed.

## Deviations from Plan
1. **Deferral of unstarted groups (design choice).** When the budget runs out partway through a claimed batch, the groups not yet started are checkpointed at their own cursor, or at the nil-UUID restart cursor. This gives the claim's attempt back, so the slice never overruns its budget by more than the one group in flight. Without it they would wait out the 120 s lease and lose an attempt.
2. **Log field list.** The plan's fixed list has no `target`, so the `target` key the tracer logged was removed.
3. **`CollectedTrace.name`** is a new optional field on the shared Langfuse exporter, needed so the root observation is called `vector_sync`. With no name the root is still `rag-request`, and every Langfuse test passes.
4. **Expansion pages use `pageSize` (100).** The tracer used `batch` for the expand limit.
5. Phase 3.2 purge-hook note: not applicable, because this plan adds no store tables. No migrations, env variables or packages were added.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `npm run typecheck:new`: clean.
- `npx vitest run tests/rag/sync tests/rag/backend tests/rag/backend-conformance`: 8 files, 122 passed.
- vitest on the test files that import trace/langfuse (answer-finish-groundedness, feedback, ingest-trace, sync/log): 4 files, 59 passed.
- `node --import tsx --test tests/rag-langfuse-export.test.mts tests/rag-langfuse-review.test.mts`: 19 passed.
- `node --import tsx --test` on tests/rag-db vector-sync*, *grants*, *search-path* and validate-chunks (9 files): 205 passed, 0 failed, 2 skipped. This includes the 07-06 tracer, which uses drainSlice over PGlite.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all exit 0.
- eslint on the changed files: 0 errors. The warnings are unused parameter names in the fakes.
- `npm run test-rag -- --out eval/out/07-09`: gate PASS (7 skipped). `--fixture-mode ingest --out eval/out/07-09-ingest`: gate PASS (7 skipped).
- Not run, because their areas were not touched: the workflows check, Python pytest, gen:schemas (no contract change) and the UI gate.

## Operator actions
None. Both targets stay disabled, and nothing in production calls the drain yet (07-13 adds the route, the kick and the CLI).

## Next Phase Readiness
- 07-13: call `drainSlice({ stores, rpc: admin, budgetMs })` and `drainUntilEmpty`. Pass `sink` and `trace` only for tests. Export them from `@/lib/rag`.
- 07-11 and 07-16: reconcile repairs enqueue `chunk` rows. These are handled by `planChunkSync`.
- 07-36 and 07-44: add a `purge` entity branch in `processGroup`.
- 07-38: extend `toPoint` and the D-03 key test for `access_groups`.
