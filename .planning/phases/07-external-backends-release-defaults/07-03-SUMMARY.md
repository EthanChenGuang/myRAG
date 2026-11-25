---
phase: 07-external-backends-release-defaults
plan: 03
subsystem: rag-backend
tags: [qdrant, weaviate, tenant-isolation, security]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "TenantScope brand with mint-time lower-casing (04-01); src/lib/rag/backend layout (04-17)"
provides:
  - "canonicalTenantKey: the one lower-case tenant key for Postgres, Qdrant and Weaviate"
  - "weaviateTenantName, weaviateCollectionName, qdrantCollectionName"
  - "Qdrant scoped-request wrapper (qdrantScopedRequest, qdrantScopedBatch, scopedCount, scopedScroll, scopedDeleteByFilter, scopedDeleteIds) with assertScoped and the Scoped<T> brand"
affects: [07-06, 07-07, 07-08, 07-09, 07-10, 07-14]

actuals:
  tokens: 10074
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Every Qdrant request leaves through a builder that injects the tenant clause and runs assertScoped on its own output"
    - "Structural Qdrant types, no vendor import"

key-files:
  created:
    - src/lib/rag/backend/tenant-key.ts
    - src/lib/rag/backend/qdrant/scoped-request.ts
    - tests/rag/backend/tenant-key.test.ts
    - tests/rag/backend/qdrant-scoped.test.ts
  modified: []

key-decisions:
  - "assertScoped takes the TenantScope, not a key string, so canonicalTenantKey stays the only source of the clause value"
  - "Builders return Scoped<T> (type-only brand); plan 07-07's client wrapper should accept only Scoped<...> inputs"
  - "Extra hardening beyond A-3: with_lookup is forbidden too; point-id queries (bare id, recommend, discover, context, nearest by id) are rejected; caller-built tenant_key conditions are rejected anywhere in the input; unknown keys in nodes, params, idf, filters and batches are rejected (allowlists)"
  - "scopedDeleteByFilter refuses a filter with no condition of its own so a mistake cannot wipe a whole tenant; a deliberate tenant purge needs its own builder later"
  - "scopedDeleteIds deletes with filter { must: [tenant, { has_id }] } (never the points selector), so a foreign id matches nothing; ids must be UUIDs or non-negative integers"
  - "Lexical detection: query is a Document ({ text }) or { nearest: Document }; such nodes always get params.idf.corpus = tenant filter"
  - "weaviateCollectionName = Myrag_chunks_<profileId with [^A-Za-z0-9_] -> _>_<sha256(profileId)[0:8]>; profile ids up to 128 chars"
  - "Prefetch output is always an array, even when the input was a single prefetch object"

patterns-established:
  - "SCOPED_BUILDERS record plus a typed Record<keyof typeof SCOPED_BUILDERS, ...> sample map in the test, so a new builder without a test fails type-check and the every-builder test"

requirements-completed: [RET-06, RET-07]

coverage:
  - id: D1
    description: "canonicalTenantKey lower-cases and asserts a minted scope; upper-case UUID input yields the same key"
    requirement: RET-07
    verification:
      - kind: unit
        ref: "tests/rag/backend/tenant-key.test.ts#upper-case UUID"
        status: pass
  - id: D2
    description: "Weaviate tenant/collection names and Qdrant collection name helpers"
    requirement: RET-07
    verification:
      - kind: unit
        ref: "tests/rag/backend/tenant-key.test.ts"
        status: pass
  - id: D3
    description: "Qdrant wrapper scopes top filter, every prefetch, every idf corpus; forbidden selectors rejected; negative controls per location"
    requirement: RET-06
    verification:
      - kind: unit
        ref: "tests/rag/backend/qdrant-scoped.test.ts#negative control"
        status: pass
  - id: D4
    description: "Scoped count, scroll, delete-by-filter and delete-by-ids builders all pass assertScoped"
    requirement: RET-06
    verification:
      - kind: unit
        ref: "tests/rag/backend/qdrant-scoped.test.ts#every exported builder produces output that passes assertScoped"
        status: pass
---

# Phase 7 Plan 03: Canonical tenant key and Qdrant scoped-request wrapper Summary

One lower-case tenant key helper for every store, and a Qdrant request wrapper that puts the tenant clause into every filter location and asserts it before any request can leave.

## Accomplishments
- `src/lib/rag/backend/tenant-key.ts`: `canonicalTenantKey`, `isCanonicalTenantKey`, `weaviateTenantName`, `weaviateCollectionName`, `qdrantCollectionName`.
- `src/lib/rag/backend/qdrant/scoped-request.ts`: structural Qdrant types, the `Scoped<T>` brand, `qdrantScopedRequest`, `qdrantScopedBatch`, `scopedCount`, `scopedScroll`, `scopedDeleteByFilter`, `scopedDeleteIds`, `assertScoped`, `SCOPED_BUILDERS`.
- 44 new unit tests (14 + 30), including 8 negative controls for `assertScoped`.

## Task Commits
1. Task 1 (tenant key and names): RED `c64cd77`, GREEN `4dfb4d5`, lint follow-up `b451b72`
2. Task 2 (Qdrant wrapper): RED `ba92cc0`, GREEN `5015084`

## Mutation guards (run by hand, then reverted)
- canonicalTenantKey without `.toLowerCase()`: the "upper-case UUID" test fails (1 failed).
- assertScoped skipping prefetch recursion: 3 negative controls fail.
- assertScoped skipping idf.corpus: 1 negative control fails.
- scopeNode skipping nested prefetch: 5 tests fail (the builder's own assertScoped throws).

## Deviations from Plan
1. **[Rule 2 - test strength] Guard test for the lower-casing.** `mintScope` already lower-cases since 04-01, so the plan's guard mutation (dropping `.toLowerCase()`) survived every test built on minted scopes. Added a test that mocks `scopeKey` to return an upper-case UUID (a mint path that does not lower-case) and checks `canonicalTenantKey` still returns the lower-case key. The mutation now fails it.
2. **[Rule 2 - security] Hardening beyond A-3** (see key-decisions): `with_lookup` forbidden, point-id query forms rejected, caller-built `tenant_key` clauses rejected, key allowlists, empty-filter delete refused, depth caps (prefetch 8, walk 64).
3. **Extra negative controls (f)-(h)**: a batch with one unscoped search, a points-selector delete, and a forbidden key in an otherwise scoped request.

No migrations, env variables, contracts or packages were added.

## Gates
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run`: 224 files, 3414 passed, 1 skipped
- `node --import tsx --test tests/*.test.mts`: 163 pass, 0 fail
- `node --import tsx --test tests/rag-db/*.test.mts`: 794 pass, 0 fail, 2 cancelled. The cancelled pair is `tests/rag-db/ingestion-ledger-pg.test.mts` (`pg_ctl: cannot be run as root`), which is environmental and fails the same way on trunk `21f611b`.
- check-rag-boundary and its node test: pass
- `node scripts/check-config.mjs`: pass
- `check-workflows.py`: pass
- `npm run typecheck:new`: 45 diagnostics, all in existing files and none in this plan's files (same count before this plan's Task 2 changes)
- Python, contracts, retrieval wiring, ingest and golden sets were not touched, so the sidecar/eval pytest, gen:schemas and test-rag gates do not apply.

## Next Phase Readiness
- 07-07 (Qdrant adapter) should send only `Scoped<...>` values to the client, using `qdrantCollectionName` and the builders here; 07-06 and 07-08 take keys from `canonicalTenantKey`.
