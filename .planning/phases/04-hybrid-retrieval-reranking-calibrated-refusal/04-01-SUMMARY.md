---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 01
subsystem: rag
tags: [tenant-scope, types, pgvector, rerank, refusal]

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: mintScope, TenantScope brand, scopeKey
  - phase: 03-unified-ingestion-embedding-profiles
    provides: resolver-side patterns (scope.ts untouched until this plan)

provides:
  - D-33 lower-case ids at mintScope
  - RetrievalBackend / Reranker / RefusalRecord v2 type contracts
  - Additive RetrievalResult and pipeline input extensions

affects:
  - 04-02 through 04-45 (adapters, fusion, rerank, refusal gate)

actuals:
  tokens: 12000
  tasks: 2
  commits: 2
  plan_head_before: f6fdb22
  plan_head_after: a6bae26

tech-stack:
  added: []
  patterns:
    - "Interface-first v2 contracts in backend/, rerank/, refusal/"
    - "Canonical tenant UUID casing at mintScope only"

key-files:
  created:
    - src/lib/rag/backend/types.ts
    - src/lib/rag/rerank/types.ts
    - src/lib/rag/refusal/types.ts
    - tests/rag/v2-contract-types.test.ts
  modified:
    - src/lib/rag/tenant/scope.ts
    - src/lib/rag/types.ts
    - tests/rag/tenant-brand.test.ts

key-decisions:
  - "Tenant UUIDs lower-cased once in mintScope after validation (D-33)"
  - "v2 contracts are type-only; implementation deferred to wave 2"

patterns-established:
  - "BackendSearchRequest carries TenantScope only; filters.currentOnly is literal true"
  - "All RetrievalResult extensions optional for legacy compatibility"

requirements-completed: [RET-01, RET-04]

coverage:
  - id: D1
    description: "mintScope normalises UUID casing to lower-case before freeze"
    requirement: RET-04
    verification:
      - kind: unit
        ref: tests/rag/tenant-brand.test.ts#mintScope upper-case UUID normalisation
        status: pass
      - kind: unit
        ref: node --import tsx --test tests/rag-legacy-differential.test.mts tests/rag-two-tenant.test.mts
        status: pass
    human_judgment: false
  - id: D2
    description: "v2 backend, rerank, and refusal contracts compile and anchor tests pass"
    requirement: RET-01
    verification:
      - kind: unit
        ref: tests/rag/v2-contract-types.test.ts
        status: pass
      - kind: unit
        ref: npm run typecheck:new
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 01: mintScope casing + v2 contract types Summary

**Tenant ids are canonicalised at mint time and the hybrid-retrieval v2 surface is frozen as TypeScript contracts before any adapter code lands.**

## Performance

- **Duration:** ~12 min
- **Tasks:** 2/2
- **Commits:** 2 (`f6f18d6`, `a6bae26`)
- **tenant-brand tests:** 10 passed at baseline (525dae5) → 13 passed after (+3 upper-case cases)

## Accomplishments

### Task 1 — D-33 mintScope lower-casing

- `mintScope` applies `toLowerCase()` to `userId` and `organizationId` after UUID validation, before `Object.freeze`.
- Three new tests under `mintScope upper-case UUID normalisation (D-33)`.
- Legacy differential and two-tenant node tests exit 0.

### Task 2 — v2 contracts

- Added `src/lib/rag/backend/types.ts` (`RetrievalBackend`, `BackendSearchRequest`, `RankedHit`, `RETRIEVAL_BACKEND_IDS`, invoice filter shape).
- Added `src/lib/rag/rerank/types.ts` (`Reranker`, `RERANK_TEXT_VERSION = 1`).
- Added `src/lib/rag/refusal/types.ts` (`RefusalRecord`, decision/basis unions).
- Extended `src/lib/rag/types.ts` additively (`KeptBy`, `QueryVariant`, `RetrievalOverrides`, optional `refusal`, etc.).
- `tests/rag/v2-contract-types.test.ts` holds representative literals for compile-time regression.

## Verification

| Check | Result |
|-------|--------|
| `npx vitest run tests/rag/tenant-brand.test.ts tests/rag/tenant-predicate.test.ts tests/rag/resolve-chat-scope.test.ts` | 41 passed |
| `npx vitest run tests/rag/v2-contract-types.test.ts tests/rag/status.test.ts tests/rag/pipeline-assembly.test.ts` | 24 passed |
| `npm run typecheck:new` | exit 0 (10 pre-existing phase-1 lines only) |
| `node --import tsx --test tests/rag-legacy-differential.test.mts tests/rag-two-tenant.test.mts` | 11 passed |
| Acceptance: `toLowerCase` in scope.ts | 2 |
| Acceptance: `upper` in tenant-brand.test.ts | 13 (case-insensitive grep) |

## Deviations from Plan

None — plan executed as written.

## Self-Check

- FOUND: `src/lib/rag/backend/types.ts`
- FOUND: `src/lib/rag/rerank/types.ts`
- FOUND: `src/lib/rag/refusal/types.ts`
- FOUND: `tests/rag/v2-contract-types.test.ts`
- FOUND: commit `f6f18d6`
- FOUND: commit `a6bae26`

## Self-Check: PASSED

## Notes

- Full `npx vitest run tests/rag`: 7 failures in `langfuse-pins.test.ts` (missing OpenTelemetry pin packages in this environment); unrelated to this plan.