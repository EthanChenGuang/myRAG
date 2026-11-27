---
phase: 07-external-backends-release-defaults
plan: 16
subsystem: rag-retrieval-backend
tags: [canary, reconcile, drift, qdrant, weaviate, pgvector, ci, release-gate, docker]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "compose digests (07-01), Qdrant and Weaviate stores (07-07, 07-08), reconcileSlice (07-11), the canary factory and guard (07-14)"
  - phase: 03.1-tiered-parsing-incremental-queue-bulk-backfill
    provides: "last Phase 3.1 edits of pr-smoke.yml and check-workflows.py (03.1-04, 03.1-50)"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "last Phase 6 edits of pr-smoke.yml and check-workflows.py (06-43)"
provides:
  - "tests/rag/canary/reconcile-drift.test.ts: real-store drift injection and repair on Qdrant and Weaviate"
  - "pr-smoke backend-canary job: canary and conformance suites on pgvector, Weaviate and Qdrant"
  - "check-workflows.py check_backend_canary and compose_digests, with one failing fixture per rule"
  - "src/lib/rag/sync/claim.ts scalarValue and scalarCount: scalar RPC answers read in both PostgREST and keyed-row shapes"
affects: [07-28, 07-32, 07-34, 07-44]

actuals:
  tasks: 2
  commits: 8  # six plan commits plus two SUMMARY count fixes

tech-stack:
  added: []
  patterns:
    - "Scalar RPC answers in the sync module go through scalarValue/scalarCount (bare PostgREST value or one row keyed by the function name), like search.ts, mine.ts and cache/wire.ts"
    - "CI images are pulled by digest from Docker Hub, then mirror.gcr.io at the same digest, three attempts with backoff; the resolved digest-pinned ref is what docker run uses"

key-files:
  created:
    - tests/rag/canary/reconcile-drift.test.ts
    - tests/rag/sync/claim-scalars.test.ts
  modified:
    - src/lib/rag/sync/claim.ts
    - src/lib/rag/sync/reconcile.ts
    - tests/rag/sync/fake-rpc.ts
    - tests/rag/sync/reconcile.test.ts
    - .github/workflows/pr-smoke.yml
    - scripts/ci/check-workflows.py
    - scripts/tests/test_check_workflows.py

key-decisions:
  - "Bug fix outside the plan's file list: reconcile and the outbox helpers read scalar RPC answers only as bare values; under the PGlite fake edge (one keyed row) every reconcile that found drift threw on a NaN repairs_enqueued and recorded failed, so drift was never repaired. Fixed in product code with the codebase's both-shapes pattern; the fake edge is unchanged"
  - "timeout-minutes 20 instead of the plan's 30: check-workflows enforces at most 25 minutes for the job (same TS_TIMEOUT_MAX as the TypeScript jobs); the suites take about 30 s locally"
  - "docker run instead of service containers: the per-run keys are generated in a step, which service containers cannot read; the Qdrant wait loop runs on the runner (no curl or wget in its image)"
  - "Pull fallback to mirror.gcr.io at the same sha256 digest: content-addressed, so the image cannot differ; Docker Hub answered 429 from this session (Pitfall 11) and no Docker Hub token may be used because pr-smoke references no secrets"
  - "The job has no if condition, so it runs on every pull request and push to main (a superset of D-12's paths); check-workflows reports an if, continue-on-error or a matrix"

patterns-established:
  - "A workflow job pinned to compose digests is checked by repository, both ways: every image reference in the job carries a digest, and the digest set equals the compose file's"

requirements-completed: [RET-08, RET-05, RET-01, RET-03]

duration: ~1h
completed: 2026-11-27
---

# Phase 7 Plan 16: Backend canary CI job and real-store drift repair

**Reconcile now repairs drift written straight into real Qdrant and Weaviate, and a `backend-canary` pr-smoke job runs the canary and conformance suites on all three backends with digest-pinned images and per-run keys.**

## Accomplishments
- `tests/rag/canary/reconcile-drift.test.ts` (D-05): for each external backend it seeds tenant A with two documents, then deletes one point, overwrites another point's `content_hash` and upserts a foreign point, all with the write handle. Reconcile reports missing 1, stale 1, extra 1 and state `stale` for A, with the other tenants still `ready`. One drain and a second reconcile report `ready` everywhere, the store's id set equals the servable set, and the overwritten point has its original hash again. It is skipped for pgvector and when the backend is not listed.
- Bug found by that test and fixed: see Deviations.
- The `backend-canary` job (D-12, A-9) is described under Decisions. It needs no secrets, pins actions by sha with version comments, and uses node 22.
- `check_backend_canary` in check-workflows.py reports:
  - a missing job;
  - an `if` condition, `continue-on-error` or a matrix;
  - a timeout over 25 minutes;
  - any qdrant or weaviate reference without `@sha256`, or with digests that differ from `docker-compose.backends.yml`;
  - `docker pull` without a three-attempt retry loop and a sleep;
  - a missing `npm ci --ignore-scripts`, `openssl rand`, `/readyz` or `/v1/.well-known/ready`;
  - a vitest step that does not run both suites, or has `RAG_CANARY_BACKENDS` other than `pgvector,weaviate,qdrant` or `CI_BACKEND_CANARY` other than `1`.
  
  `backend-canary` is in `PR_JOBS`. The existing no-`secrets.` rule also covers a Docker Hub login, and a test now checks that.

## Task Commits
1. RED: sync scalar RPCs: `e319480c` (test)
2. Fix: scalar answers in both shapes: `b6231893` (fix)
3. Task 1: real-store drift test: `b0d197b1` (test)
4. Task 2 RED: check-workflows rules (no-op stub, so the tests fail on assertions): `c5e1ba10` (test)
5. Task 2 GREEN: the job and the rules: `efd94cca` (ci)
6. SUMMARY: this commit (docs)

## Deviations from Plan
- **[Rule 1, bug] Reconcile could not repair drift under the PGlite edge.**
  - Cause: `enqueueRepair`, `setState` and prune in reconcile.ts, and `completeRows`, `failRow` and `checkpointRow` in claim.ts, destructured scalar RPC answers as bare values. The fake edge answers `[{ fn: value }]`.
  - Effect: `repairs_enqueued` became NaN, `ReconcileReportSchema.parse` threw, and the tenant was set `failed` with `store_error`. Seen on real Qdrant and Weaviate: the first drift-test run reported `state: failed, missing 0` on both.
  - Fix: `scalarValue` and `scalarCount` in claim.ts, used at all six call sites.
  - Tests that failed before the fix:
    - `tests/rag/sync/claim-scalars.test.ts`, keyed shape: NaN count, null state, false checkpoint.
    - the new keyed-shape case in `tests/rag/sync/reconcile.test.ts`: NaN `pruned`.
    - `reconcile-drift.test.ts` on both backends: `state: failed`.
  - Production impact: real PostgREST sends bare scalars, so live reconcile already worked. The fix makes the canary harness exercise the same path production uses.
- Files outside the plan's list: src/lib/rag/sync/claim.ts, src/lib/rag/sync/reconcile.ts, tests/rag/sync/fake-rpc.ts (adds `keyedScalarClient`), tests/rag/sync/reconcile.test.ts and tests/rag/sync/claim-scalars.test.ts.
- The timeout is 20 minutes, not 30, to stay under the 25-minute limit the checker enforces.
- The mirror fallback is an addition to the plan.

## Verification and gates run
- Real backends (Docker daemon started in this session; images pulled through mirror.gcr.io by the compose digests because Docker Hub answered 429): `RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant npx vitest run tests/rag/canary/reconcile-drift.test.ts`: 4 passed, 0 failed (2 per vendor).
- The job's shell steps were run locally as written: keys, pull (429, then mirror fallback), start and wait. Then `CI_BACKEND_CANARY=1 RAG_CANARY_BACKENDS=pgvector,weaviate,qdrant npx vitest run tests/rag/canary tests/rag/backend-conformance` gave 9 files and 132 passed in about 26 s. The 4 skips are the Weaviate-only untenanted-query case on the other backends.
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npx vitest run tests/rag/sync tests/rag/canary tests/rag/backend-conformance` (default env, pgvector only): 154 passed, 74 skipped, 0 failed. The full vitest suite was not run, because no core types, env.ts or test setup changed.
- `node --import tsx --test tests/rag-db/vector-sync*.test.mts tests/rag-db/*grants*.test.mts tests/rag-db/*search-path*.test.mts`: 212 passed, 0 failed.
- `uv run --all-extras --frozen --directory eval python ../scripts/ci/check-workflows.py`: OK.
- `uv run --directory eval python -m unittest discover -s ../scripts/tests -p 'test_check_workflows.py'`: 113 tests OK.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs` and `node scripts/ci/check-settings-classification.mjs`: all exit 0.
- Not applicable: migrations (none added), `gen:schemas` (no contract change), test-rag (no retrieval, ingest or golden change), UI.

## Operator pending
- Make `backend-canary` a required check in branch protection (plan 07-32).
- Optional: a read-only Docker Hub token is not used, because pr-smoke references no secrets. The mirror fallback covers 429s. Plan 07-32 records the decision.

## Decisions for STATE
- Sync-module scalar RPC reads accept both answer shapes (`scalarValue` and `scalarCount` in `src/lib/rag/sync/claim.ts`).
- backend-canary: timeout 20 minutes; `docker run` with per-run keys; Docker Hub, then mirror.gcr.io at the same digest.

## Next Phase Readiness
- 07-28, 07-34 and 07-44 add cases under tests/rag/canary. The job runs the whole folder, so they need no workflow edit.
- No new environment variables, migrations or switches. Behaviour with every switch off is unchanged.
