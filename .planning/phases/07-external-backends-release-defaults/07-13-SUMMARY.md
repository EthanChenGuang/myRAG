---
phase: 07-external-backends-release-defaults
plan: 13
subsystem: rag-vector-sync
tags: [vector-sync, drain-route, kick, cli, pg_cron, scheduler]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "outbox, targets and set_target / requeue_dead (07-02, 0703), secret and lag env (07-04), VectorSyncSliceReport (07-05), drainSlice / drainUntilEmpty (07-09), activation gate (07-10), reconcileSlice (07-11), Qdrant and Weaviate stores (07-07, 07-08)"
provides:
  - "POST and GET /api/internal/vector-sync/drain: Bearer RAG_VECTOR_SYNC_SECRET, fail closed, one 45 s drain or reconcile slice"
  - "src/lib/rag/sync/auth.ts checkVectorSyncAccess; slice.ts runVectorSyncSlice; targets.ts readVectorSyncStatus, readEnabledTargets, buildVectorSyncStores; kick.ts kickVectorSync"
  - "kickVectorSync at writer publish, soft delete and profile activation"
  - "npm run rag:vector-sync (drain, backfill, targets enable|disable, requeue-dead, status) and npm run rag:reconcile"
  - "0708 rag_vector_sync_status (service role only)"
  - "supabase/optional/vector-sync-schedule.sql (pg_cron + pg_net + Vault, operator-run)"
affects: [07-14, 07-15, 07-16, 07-20]

actuals:
  tasks: 3
  commits: 8

tech-stack:
  added: []
  patterns:
    - "One slice runner (runVectorSyncSlice) shared by the route, the kick and the CLI; stores are built per enabled target, and vendor clients load lazily so importing @/lib/rag does not pull them in"
    - "The kick is in-process (no URL, no secret): after() only, no-op outside a request scope, targets read cached 30 s, one scheduled kick per process at a time"

key-files:
  created:
    - src/app/api/internal/vector-sync/drain/route.ts
    - src/lib/rag/sync/auth.ts
    - src/lib/rag/sync/slice.ts
    - src/lib/rag/sync/targets.ts
    - src/lib/rag/sync/kick.ts
    - src/lib/rag/sync/cli.ts
    - supabase/migrations/0708_vector_sync_status.sql
    - supabase/optional/vector-sync-schedule.sql
    - tests/rag/sync/drain-route.test.ts
    - tests/rag/sync/kick.test.ts
    - tests/rag/sync/kick-call-sites.test.ts
    - tests/rag/sync/targets.test.ts
    - tests/rag-db/vector-sync-cli.test.mts
  modified:
    - src/lib/rag/index.ts
    - src/lib/rag/ingest/writer.ts
    - src/lib/rag/ingest/soft-delete.ts
    - src/lib/rag/embeddings/profile-ops.ts
    - package.json

key-decisions:
  - "Migration 0708 rag_vector_sync_status() added (next free 07xx on every origin branch, claimed and pushed first): status and the kick's targets read need a read and fake-edge/PostgREST table reads of the outbox are not available. Counts only, no tenant keys; SECURITY INVOKER, search_path '', service role only"
  - "Route auth: RAG_VECTOR_SYNC_SECRET only (CRON_SECRET is not read; operators set it to the same value). Empty or missing body means drain. A slice error answers 500 {error: vector_sync_failed} and logs the error class only"
  - "Kick cache semantics: the first kick after a stale cache schedules one after() callback that reads the targets; while the cached list is empty and fresh (30 s) a kick schedules nothing"
  - "backfill --target <t> requires the target enabled (exit 1 otherwise), drains with a store for every enabled target (so another target's rows are never failed for want of a store), then runs one full reconcile of <t>; exit 0 only when every compared tenant is ready"
  - "CLI exit codes: 0 done, 1 failed or not ready, 2 usage, 3 no service-role client. Reconcile output prints counts per (target, state), never the ReconcileReport tenant keys"
  - "Scheduler recipe runs live statements (not commented) but its DO block refuses to run while either placeholder is unreplaced or the secret is under 32 characters; re-running updates the Vault secrets and replaces the jobs"
---

# 07-13 Summary: drain route, kick, CLI and scheduler recipe

## Baseline (count gates at plan start, HEAD 1024aa0f)

| Gate | Before | After |
|------|--------|-------|
| `grep -c internalApiKeyMatches src/lib/rag/sync/auth.ts` | error (no file) | 2 |
| `grep -cE "export (async )?function GET" .../drain/route.ts` | error (no file) | 1 |
| `grep -c '"crons"' vercel.json` (guard) | 0 | 0 |
| `-t "503"` on the route test | error (no file) | 3 passed, 0 failed |
| `grep -c kickVectorSync` writer / soft-delete / profile-ops | 0 / 0 / 0 | 2 / 2 / 2 |
| `grep -c "rag:vector-sync" package.json` | 0 | 1 |
| `grep -c "timeout_milliseconds := 58000"` recipe | error (no file) | 2 |
| `grep -cE "vault\.create_secret"` recipe | error (no file) | 2 |

No gate passed before the edits, so each one still discriminates.

## Task commits

- Migration claim: `2ae1d1bb` 0708 (committed and pushed first so the number is visibly taken; its tests are in Task 3)
- Task 1: RED `3f8ce6ac` (stubs with the final exports; 19 of 21 failed on assertions), GREEN `109f8c7d`
- Task 2: RED `64f167a1` (10 failed on assertions; the failed-publish case passed, as intended), GREEN `d21c06bd`
- Task 3: RED `9ea6acf0` (stub CLI; 10 failed on assertions), GREEN `a975a6d6`

## Behaviour changes

- New internal route `/api/internal/vector-sync/drain`, POST and GET. 503 when the secret is unset or under 32 characters, 401 for a missing, non-Bearer or wrong token, 400 (structured `{success, error, details}`) for an unknown mode, an extra key or bad JSON. It runs one slice and returns `VectorSyncSliceReport`. The request's abort signal is never passed on. `runtime nodejs`, `dynamic force-dynamic`, `maxDuration 60`. vercel.json is unchanged.
- After a publish, a soft delete (deleted or already deleted) and a successful profile activation, one in-process drain slice of 10 s runs after the response. With both targets disabled (the default) this costs at most one cached status read per 30 s per process and no drain. Outside a request scope (CLI, worker) it does nothing. A failed publish, refused soft delete or refused activation does not kick.
- New npm scripts `rag:vector-sync` and `rag:reconcile`.
- No env variable added (RAG_VECTOR_SYNC_SECRET came with 07-04). Strict refusal, webSearch with Exa, `source_images`, `{{context}}`, voice and embed chat are untouched.

## Tests that failed before the change

- `tests/rag/sync/drain-route.test.ts`: 503 matrix, 401 matrix, modes, 400 cases, abort, 500 without secret, segment config (19 cases against the stub route).
- `tests/rag/sync/kick.test.ts`: cache, schedule, single in-flight, outside scope, error code warning, error class only, never delays (9 cases against the no-op stub).
- `tests/rag/sync/kick-call-sites.test.ts`: publish, soft delete and activation kick once (3 cases; the failed-publish case passes on old code, as it should).
- `tests/rag-db/vector-sync-cli.test.mts`: 10 cases against the stub CLI (parsing, exit 2/3, 0708 grants, status, enable, backfill to ready, reconcile drift, requeue-dead, disable). The scheduler-recipe file checks were added with GREEN.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors. `npm run typecheck:new`: clean.
- `npx vitest run` (full suite, because the public `@/lib/rag` index changed): 673 files passed, 2 skipped; 12198 tests passed, 56 skipped.
- `npx vitest run tests/rag/sync tests/rag/ingest tests/rag/embeddings` plus every test file importing writer, soft-delete or profile-ops: 115 files, 2103 passed.
- `node --import tsx --test tests/rag-db/vector-sync-cli.test.mts`: 14 passed.
- `node --import tsx --test` on the 25 tests/rag-db files matching grants, search-path, vector-sync, schema, activation-gate, soft-delete, definer: 625 passed, 2 failed, 1 skipped. The 2 failures are pre-existing (see below).
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all exit 0.
- `npm run test-rag -- --out eval/out/07-13`: gate PASS (7 skipped). `--fixture-mode ingest --out eval/out/07-13-ingest`: gate PASS (8 skipped).
- eslint on the changed files: 0 errors (warnings are parameter names in type signatures, the existing pattern).
- Smoke: `npm run rag:vector-sync -- status` without the key exits 3; `-- purge` exits 2 with usage.
- Not run (area not touched): workflows check, Python pytest, `gen:schemas` (no contract change), UI design gate (no UI).

## Pre-existing failure

`tests/rag-db/ingestion-schema.test.mts` "applying 0351 twice (then 0314, 0425, ... 08xx) leaves the catalog unchanged" fails in both modes with a `rag_activate_embedding_profile(text,text)` definition diff. It fails identically on the base commit 1024aa0f (run in a separate worktree: 59 passed, 2 failed). Cause: 0706 (07-10) redefines that function and the test's re-apply list does not include 0706. Not affected by this plan. The fix is adding 0706 to that list, which belongs to 07-10's owner or the merge train.

## Deviations

1. **Migration 0708** (not in the plan): see key decisions. 0708 was free on every origin branch, and the 07 plans use 0701-0707 and 0740-0744.
2. **`slice.ts` and `targets.ts`** (not in files_modified): the shared slice runner and the per-target store builder that the route, kick and CLI all use, as the plan's "same modules the route uses" requires.
3. **`tests/rag/sync/kick-call-sites.test.ts` and `tests/rag/sync/targets.test.ts`**: extra test files for the three call sites and the store builder.
4. **Route import**: the route imports `runVectorSyncSlice` (which wraps drainSlice and reconcileSlice) from `@/lib/rag`. drainSlice, drainUntilEmpty, reconcileSlice and the store builders are exported from the index too, as the plan asked.
5. eval/harness/fake-edge.mts was not changed: its generic `rag_*` RPC path serves 0708.

## Purge hooks (Phase 6.3 note)

Not applicable: no new store table. 0708 is a read-only function.

## Requirement IDs and decisions for STATE

- RET-05: changes reach the stores through the route (scheduler), the post-response kick and the CLI. The request path never waits on sync.
- Scheduler default: pg_cron + pg_net (`supabase/optional/vector-sync-schedule.sql`), minutely drain, reconcile daily at 03:17 UTC, weekly job_run_details cleanup.

## Operator pending

- To schedule sync: enable pg_cron, pg_net and Vault on the project, then run the recipe with the app URL and the deployed `RAG_VECTOR_SYNC_SECRET`. The alternative is Vercel Cron on Pro, with `CRON_SECRET` set to the same value and the crons entry added in the Vercel project, never in the committed vercel.json.
- Live Qdrant or Weaviate runs of `targets enable`, `backfill` and `rag:reconcile` against real backends (not run here).

## Deferred

- None in this plan's scope. Config UI status for sync lag and targets belongs to 07-20.

## Self-Check: PASSED
