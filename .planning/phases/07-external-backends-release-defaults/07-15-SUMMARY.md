---
phase: 07-external-backends-release-defaults
plan: 15
subsystem: rag-admin
tags: [index-compat, vector-sync, admin-routes, readiness, config-ui-backend]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "outbox, targets, index-state table and rag_vector_sync_set_target (07-02, 0701/0703), describeCollection on the Qdrant and Weaviate stores (07-07, 07-08), index-state transitions (07-11), RagConfig.backend and readiness (07-12), readVectorSyncStatus, defaultStoreFactories and 0708 (07-13)"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "requireAdminOrDeny / checkAdmin admin route pattern (04-34, 03-40)"
provides:
  - "GET /api/rag/admin/index-compat: { success, warnings, backends, envLoadedAt }, admin only, fail closed"
  - "GET and PUT /api/rag/admin/vector-sync/targets: per-target enabled flag; PUT { target, enabled } with the admin id as actor, returns tenantsEnqueued"
  - "src/lib/rag/backend/index-compat.ts: computeIndexCompat, readIndexCompat, envLoadedAt, INDEX_COMPAT_STORE_TIMEOUT_MS"
  - "src/lib/rag/sync/targets.ts: listVectorSyncTargets, setVectorSyncTarget"
  - "src/lib/rag/sync/admin-rpc.ts: resolveVectorSyncAdminRpc"
  - "0709 rag_backend_index_state_counts() (service role only, counts per target/profile/state)"
affects: [07-20]

actuals:
  tasks: 2
  commits: 7

tech-stack:
  added: []
  patterns:
    - "Admin status routes return codes, numbers and profile ids only; vendor messages, URLs and tenant keys never leave the library"
    - "Each external store probe (build, health, describe) is bounded by a 5 s timeout and maps to backend_unreachable { stage, reason }"

key-files:
  created:
    - src/lib/rag/backend/index-compat.ts
    - src/lib/rag/sync/admin-rpc.ts
    - src/app/api/rag/admin/index-compat/route.ts
    - src/app/api/rag/admin/vector-sync/targets/route.ts
    - supabase/migrations/0709_backend_index_state_counts.sql
    - tests/rag/admin/index-compat.test.ts
    - tests/rag/admin/vector-sync-targets.test.ts
    - tests/rag/admin/route-harness.ts
    - tests/rag-db/backend-index-state-counts.test.mts
  modified:
    - src/lib/rag/sync/targets.ts
    - src/lib/rag/index.ts

key-decisions:
  - "Migration 0709 rag_backend_index_state_counts() added (not in the plan): the per-profile tenant counts must be aggregated in SQL, because a PostgREST table read would return tenant rows (and stop at the row limit). Number checked free on every origin branch, committed and pushed first. SECURITY INVOKER, search_path '', service role only, no tenant key in the result"
  - "Warning shape { code, backend, detail }. Codes: backend_not_ready (detail profileId, building, stale, failed, ready), dimension_mismatch (profileId, profileDims, collectionDims), legacy_pipeline, sync_not_enabled, dead_letters (dead), backend_unreachable (stage client|health|describe, reason error|timeout|unhealthy)"
  - "Selected backend = RAG_RETRIEVAL_BACKEND or RAG_RETRIEVAL_BACKEND_VOICE when external. Not-ready and dimension checks only for selected backends; dead_letters for any target, also while pgvector is selected. backend_not_ready only while sync is enabled (sync_not_enabled covers the disabled case). A missing collection is not a dimension mismatch"
  - "Stores are only built for selected external backends, so the defaults build no vendor client and make no network call"
  - "A database read error (status or counts RPC, active profile registry) answers 503 index_compat_unavailable with a code-only [RAG Admin] log; a store failure answers 200 with backend_unreachable"
  - "envLoadedAt = process start time (Date.now() - process.uptime()), rounded to the second: Next.js reads .env.local at process start. No change to src/lib/env.ts"
  - "The targets route uses checkAdmin (it needs the admin id for the audit actor) followed by adminDenied, the same guard requireAdminOrDeny wraps; the PUT body is z.object({ target: z.enum(['weaviate','qdrant']), enabled: z.boolean() }).strict() via validateRequest (400 with details)"
  - "GET targets reads through 0708 rag_vector_sync_status (the fake edge and PostgREST serve it); a target without a row is disabled"
---

# 07-15 Summary: index-compat warning and sync-target admin routes

**Admins get a server-computed warning whenever the selected retrieval backend and the active embedding profile do not match, and can switch Weaviate and Qdrant sync on and off from the app with their id recorded as actor. Both answer with counts and codes only.**

## Baseline (count gates at plan start, HEAD fc29de8 per plan; branch base 07-13 merged)

| Gate | Before | After |
|------|--------|-------|
| `grep -c requireAdminOrDeny .../index-compat/route.ts` | error (no file) | 2 |
| `grep -cE "dimension_mismatch\|sync_not_enabled\|legacy_pipeline\|dead_letters\|backend_not_ready" index-compat.ts` | error (no file) | 10 |
| `grep -c zod/v3 .../vector-sync/targets/route.ts` | error (no file) | 1 |
| `npx vitest run tests/rag/admin/vector-sync-targets.test.ts -t "non-admin"` | error (no file) | 1 passed, 0 failed |

## Task commits

0. `0a4642d0` claim migration 0709 (pushed at once)
1. Task 1: RED `b424a2ca` (stub computeIndexCompat and route; 15 of 15 behaviour tests failed on assertions), GREEN `f0744e2b`
2. Task 2: RED `d6d9fd89` (stub helpers and route; 8 of 9 failed on assertions, the `runtime` export test passed), GREEN `c1d311b1`
3. `test(07-15)` 0709 DB test (grants, search_path, grouped counts, idempotence)
4. This SUMMARY

## Behaviour changes

- New admin-only routes; nothing else changes. With the defaults (pgvector, no targets) the index-compat route reports no warnings, builds no vendor client and calls two service-role read RPCs. Chat, embed, voice, strict refusal, webSearch with Exa, `source_images` and `{{context}}` are untouched (no retrieval, generation or prompt code changed).
- `PUT /api/rag/admin/vector-sync/targets` with `enabled: true` on a disabled target enqueues every tenant (0703 semantics, same as `npm run rag:vector-sync -- targets enable`).

## Tests that failed before the change

- `tests/rag/admin/index-compat.test.ts`: all 15 behaviour tests against the stubs (warnings, backends, guard, 503, leak checks).
- `tests/rag/admin/vector-sync-targets.test.ts`: 8 of 9 against the stubs (helpers, guard, GET/PUT, 400, 500, 503).

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npx vitest run tests/rag/admin tests/rag/sync` (the new tests plus every test importing `sync/targets`): 14 files, 193 passed.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all ok.
- `node --import tsx --test tests/rag-db/backend-index-state-counts.test.mts tests/rag-db/vector-sync-cli.test.mts tests/rag-db/definer-search-path-pglite.test.mts tests/rag-db/hybrid-grants.test.mts tests/rag-db/search-path-empty.test.mts tests/rag-db/search-rpc-grants-pglite.test.mts`: 71 passed, 0 failed.
- eslint on the touched files: 0 errors (warnings are parameter names in type signatures, as in the existing route tests).
- Not run (area untouched): test-rag fixture runs, gen:schemas, workflow check, Python suites, frontend-design check (no UI in this plan; the panel is 07-20).

## Deviations

1. **Migration 0709** (not in files_modified): needed for SQL-side per-profile tenant counts; see key-decisions.
2. **`src/lib/rag/sync/admin-rpc.ts`** (not in files_modified): the service-role client resolver for the targets route lives in its own file so `sync/targets.ts`, which the CLI and the post-publish kick import, does not pull in the deps module.
3. **`readIndexCompat`** in index-compat.ts: the route's entry point that reads the config, admin client and active profile from the RAG deps, so the route does not reach into `@/lib/rag/deps`.
4. **`tests/rag/admin/route-harness.ts`** and **`tests/rag-db/backend-index-state-counts.test.mts`**: shared route fakes (real admin guard over a fake client) and the 0709 DB test.
5. **Extra warning code `backend_unreachable`** as the plan's behaviour block asks; it is in addition to the five D-16 conditions.

## Purge hooks (Phase 6.3 note)

None needed: 0709 adds a read function only, no new store.

## Requirement IDs and decisions for STATE

- ADM-01 (index-compat warning, backend half), RET-09 (readiness visible to operators). The Config UI half is 07-20.
- Decision: migration 0709 `rag_backend_index_state_counts` is taken (Phase 7 block; 0740-0744 remain planned for 07-36 onward).
- Decision: index-compat route contract `{ success, warnings[{code, backend, detail}], backends[{target, enabled, pending, leased, dead, oldestPendingSeconds, selected, profiles[{profileId, building, ready, stale, failed}]}], envLoadedAt }`; targets route `GET { success, targets[{target, enabled}] }`, `PUT { success, target, enabled, tenantsEnqueued }`. 07-20 consumes these.

## Operator pending

- Apply migration 0709 on each environment's Supabase project (after 0701-0708). Not applied anywhere from this session; production was not touched.
- Live check against real Qdrant or Weaviate (collection dims, health) is an operator action; only fakes were used here.

## Deferred

- Config UI panel rendering the warnings, the target switch and the `.env.local`-changed caveat (07-20; `config-server.js` forwarding through `withAuthHeaders`).

## Self-Check: PASSED
