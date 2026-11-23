---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 07
subsystem: retrieval
tags: [tracer, tenant-scope, brand-type, legacy-rehome, supabase-rpc, differential-test]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: two-tenant fixture and extended fake edge (02-05), characterization snapshots (02-06), Phase 1 eval allow-list (02-01 and Phase 1)
provides:
  - src/lib/rag/ skeleton with the public runRetrieval entry, injected deps and typed result
  - branded TenantScope (unique symbol plus WeakSet), tenantPredicate, workspaceRpcArgs, scopeKey
  - scope-driven vectorSearch backend with RetrievalBackendError and abort handling
  - legacy enhancedRetrieveChunks re-homed as legacyAnalyze / legacySearch / legacyRank (copy, old module untouched)
  - evalScope wrapping checkEvalScope
affects: [02-08, 02-09, 02-10, 02-16, 02-19, 02-20]

requirements-completed: [PIPE-01, PIPE-02, PIPE-08, PIPE-09]

actuals:
  tokens: 12300
  tasks: 2
  commits: 3
plan_head_before: 2495420ec06906ac16b2a66b8f23401794c9390b
plan_head_after: 473419aa872ac05518ee1d9f8f5e5fba993230e6

tech-stack:
  added: []
  patterns:
    - "Tenant brand: module-private unique symbol type plus a WeakSet of minted scopes; spread copies and JSON round-trips fail the runtime check"
    - "The RPC name and tenant arguments are derived only from the scope inside backend/supabase-rpc.ts"
    - "Dependencies injected through getRagDeps with setRagDepsForTests / resetRagDepsForTests; clients are lazy"
    - "Abort is detected from the signal (throwIfAborted after the await), never from error text"

key-files:
  created:
    - src/lib/rag/index.ts
    - src/lib/rag/types.ts
    - src/lib/rag/deps.ts
    - src/lib/rag/pipeline.ts
    - src/lib/rag/tenant/scope.ts
    - src/lib/rag/tenant/eval.ts
    - src/lib/rag/backend/supabase-rpc.ts
    - src/lib/rag/embeddings/openai.ts
    - src/lib/rag/query/temporal-query-detector.ts
    - src/lib/rag/legacy/enhanced-retrieval.ts
    - tests/rag-legacy-differential.test.mts
    - tests/rag/tenant-brand.test.ts
    - tests/rag/tenant-brand.test-d.ts
    - tests/rag/tenant-predicate.test.ts
  modified: []

key-decisions:
  - "Legacy options enableTemporalBoost, enableFinancialBoost and requireTemporalMatch are not carried over: the legacy function destructured them but never used them. Only maxResults (default from env.RAG_FINAL_RESULT_COUNT) and fallbackToLowerThreshold (default true) remain; every current caller passes true"
  - "A personal scope needs a UUID user and no organization; an org scope needs a UUID organization and accepts an optional UUID user, because the legacy code sends p_user_id alongside p_org_id and the SQL ignores it"
  - "scopeKey(scope) returns s:default, u:<id> or o:<id> so evalScope results can be asserted against the allow-list vocabulary"
  - "rowMatchesPredicate is exported next to tenantPredicate so the predicate can be checked against the real SQL function and reused later as a post-filter"
  - "Abort and backend failures return status error with reason aborted / backend_error / <stage>_failed; an unminted scope throws before any stage"

patterns-established:
  - "Tests mint scopes through tenant/scope.ts mintScope (allowed in tests; the boundary rule in 02-20 forbids it elsewhere)"

coverage:
  - id: D1
    description: "runRetrieval returns candidates and query context deep-equal to enhancedRetrieveChunks for all 72 fixture questions"
    requirement: PIPE-01
    verification:
      - kind: integration
        ref: "tests/rag-legacy-differential.test.mts (5 tests)"
        status: pass
  - id: D2
    description: "A hand-built or copied scope is a type error and rejected at runtime before any stage"
    requirement: PIPE-08
    verification:
      - kind: unit
        ref: "tests/rag/tenant-brand.test.ts (5 brand tests); tests/rag/tenant-brand.test-d.ts via npm run typecheck:new"
        status: pass
  - id: D3
    description: "RPC name and tenant arguments derived only from the scope; predicate equals match_documents_by_workspace"
    requirement: PIPE-08
    verification:
      - kind: unit
        ref: "tests/rag/tenant-predicate.test.ts (8 tests including a comparison with the SQL function on the two-tenant fixture)"
        status: pass
  - id: D4
    description: "RPC error raises RetrievalBackendError and surfaces as status error; abort is detected from the signal"
    requirement: PIPE-09
    verification:
      - kind: integration
        ref: "tests/rag-legacy-differential.test.mts (RPC error and aborted cases)"
        status: pass
  - id: D5
    description: "evalScope wraps checkEvalScope and is the only eval path to a scope"
    requirement: PIPE-02
    verification:
      - kind: unit
        ref: "tests/rag/tenant-brand.test.ts (5 evalScope tests)"
        status: pass
---

# Phase 2 Plan 07: TenantScope Tracer and Re-homed Legacy Search Summary

**One retrieval now runs end to end through `src/lib/rag/` with a branded tenant scope and returns exactly the candidates `enhancedRetrieveChunks` returns today for all 72 fixture questions.**

## Performance

- **Tasks:** 2 of 2 (Task 2 as RED then GREEN)
- **Files:** 14 created, no existing file modified; the old retrieval modules are untouched and still in use
- **Verification:**
  - `node --import tsx --test tests/rag-legacy-differential.test.mts` passes (5 tests)
  - `npx vitest run tests/rag` passes (6 files, 26 tests)
  - `npm run typecheck:new` reports no Phase 1 errors
  - `npx next typegen && node scripts/ci/tsc-ratchet.mjs` reports ok (122 errors, no regression)

## Accomplishments

- Task 1 (commit 338a90c): branded scope, scope-driven `vectorSearch` (single maps to `match_document_chunks`; personal and org map to `match_documents_by_workspace` with `workspaceRpcArgs`), lazy OpenAI embedder with the same client construction and model default as `document-processor`, verbatim temporal detector copy, the legacy algorithm split into three stage functions, a minimal sequential pipeline, and the differential tracer. The tracer compares candidates and query context for the whole golden set, asserts at least 36 questions return candidates (so equality is not vacuous) and that the fake edge recorded zero errors.
- Task 2 RED (commit f323b31): brand, predicate and evalScope tests against a stub that always refuses; the five evalScope cases failed on assertions, not on a missing module.
- Task 2 GREEN (commit 473419a): `evalScope` calls `checkEvalScope` unchanged and mints a single, org or personal scope; refusals pass through verbatim.
- The predicate test builds the two-tenant database, runs `match_documents_by_workspace` for four scopes and checks the returned chunk ids equal the chunks selected by `rowMatchesPredicate`.

## Task Commits

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | Tracer: runRetrieval through the re-homed legacy search | 338a90c |
| 2 RED | Brand, predicate and evalScope tests against a stub | f323b31 |
| 2 GREEN | evalScope wraps checkEvalScope | 473419a |

## Intended behaviour changes

- RPC errors in the re-homed search raise `RetrievalBackendError` (status `error`, reason `backend_error` from `runRetrieval`) instead of returning no chunks. Not yet reachable from any route; the old `enhancedRetrieveChunks` still swallows RPC errors until the entry points switch (plans after 02-19).
- A scope-less call returns `empty` with reason `no_tenant` and runs no stage.

## Deviations from Plan

**1. [Rule 2 - Scope] Unused legacy options dropped**
- `enableTemporalBoost`, `enableFinancialBoost` and `requireTemporalMatch` were destructured by the legacy function but never read, so they are not part of `RetrievalOptions`. The environment variables `RAG_TEMPORAL_BOOST`, `RAG_FINANCIAL_BOOST`, `RAG_TEMPORAL_MATCHING` and `RAG_FALLBACK_LOWER_THRESHOLD` are therefore not read by the re-homed code (they are not in `src/lib/env.ts`, and adding them would require the four-place config sync for no behavioural effect). `RAG_FALLBACK_LOWER_THRESHOLD=false` previously disabled the few-results fallback only for callers that did not pass the option; all three current callers pass `true`, so behaviour is unchanged.
- **Commit:** 338a90c

**2. Verbatim temporal detector still reads thresholds from `process.env`**
- The plan asks for a verbatim copy; `RAG_EXACT_THRESHOLD`, `RAG_HIGH_THRESHOLD`, `RAG_MEDIUM_THRESHOLD` and `RAG_LOW_THRESHOLD` are read directly there, as in the original. Moving them behind `env` is left to the plan that deletes the old module (02-19).

**3. `Candidate.metadata` keeps the legacy `any` type**
- It mirrors `EnhancedSearchResult` so the deep-equality contract and the copied temporal validator signature stay unchanged.

## Known Stubs

None. The `context`, `usedDocuments`, `sourceImages` and `links` fields of `RetrievalResult` are intentionally empty until plan 02-09 (assembly), as the plan states; `pipeline.ts` is replaced by the stage runner in plan 02-08.

## Threat Flags

None beyond the plan's register. T-02-13 (brand plus runtime check plus type test), T-02-14 (arguments derived from the scope, predicate compared with the SQL) and T-02-15 (typed backend error, never an empty result) are mitigated as planned. The boundary rule forbidding `mintScope` outside `tenant/` and tests arrives in plan 02-20.

## Self-Check: PASSED

- All 14 files listed under key-files.created exist.
- Commits 338a90c, f323b31 and 473419a are ancestors of HEAD.
