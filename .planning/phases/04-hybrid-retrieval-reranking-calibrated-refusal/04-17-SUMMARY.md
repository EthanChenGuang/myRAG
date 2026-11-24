---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 17
subsystem: rag
tags: [pgvector, retrieval-backend, conformance, startup, hybrid-search]

requires:
  - phase: 04-01
    provides: RetrievalBackend types and filter model
  - phase: 04-15
    provides: hybrid_search_chunks SQL
  - phase: 03-26
    provides: EmbeddingProfileMismatchError
provides:
  - createPgvectorBackend and getRetrievalBackend registry
  - backend-agnostic runConformance suite with pgvector factory
  - verifyV2Startup / getV2StartupVerdict wired from instrumentation
affects: [04-19, 04-20, 07-07, 07-08]

actuals:
  tokens: 92000
  tasks: 3
  commits: 4
  plan_head_before: 975ea980a50143f25289c95807d1dfca274d403d
  plan_head_after: 5102a64aaeda0c39de2cea2d09de7b72a14e90ea

tech-stack:
  added: []
  patterns:
    - "RetrievalBackend adapter calls hybrid_search_chunks with scopeKey only"
    - "ConformanceFactory + runConformance for multi-backend Phase 7"

key-files:
  created:
    - src/lib/rag/backend/pgvector.ts
    - src/lib/rag/backend/registry.ts
    - src/lib/rag/v2/startup.ts
    - tests/rag/backend/pgvector-adapter.test.ts
    - tests/rag/backend-conformance/cases.ts
    - tests/rag/backend-conformance/dataset.ts
    - tests/rag/backend-conformance/pgvector-factory.ts
    - tests/rag/backend-conformance/pgvector.test.ts
    - tests/rag/v2/startup.test.ts
  modified:
    - src/instrumentation.ts
    - src/lib/rag/index.ts

key-decisions:
  - "Empty filter arrays are sent as SQL null so = ANY is not applied on empty sets"
  - "v2 startup checks are no-ops under RAG_PIPELINE=legacy with verdict not_checked"

patterns-established:
  - "Backend registry mirrors object-store test override pattern"
  - "Conformance suite imports only backend-agnostic helpers (no eval harness in cases.ts)"

requirements-completed: [RET-01, RET-02, RET-03, RET-04, DATA-08]

coverage:
  - id: D1
    description: "pgvector adapter enforces minted TenantScope and admin-only hybrid RPC"
    requirement: RET-01
    verification:
      - kind: unit
        ref: "tests/rag/backend/pgvector-adapter.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "backend-agnostic hybrid conformance including zh/en/it exact-term lexical legs"
    requirement: RET-03
    verification:
      - kind: integration
        ref: "tests/rag/backend-conformance/pgvector.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "v2 startup surfaces ICU, missing service key and old pgvector for iterative scan"
    requirement: RET-02
    verification:
      - kind: unit
        ref: "tests/rag/v2/startup.test.ts"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 17: pgvector backend, conformance suite and v2 startup Summary

**pgvector implements RetrievalBackend behind scopeKey-guarded hybrid_search_chunks, a shared conformance factory suite passes on PGlite, and v2 startup logs ICU or key gaps once at boot.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 3/3
- **Commits on branch:** 4 (`eb29819`, `aa549a3`, `2360724`, `5102a64`)

## Accomplishments

1. **`createPgvectorBackend`** maps hybrid RPC rows into dense/lexical legs, throws `admin_unavailable` without a service-role client, and maps `embedding_profile_mismatch` to `EmbeddingProfileMismatchError`.
2. **`registry.ts`** exposes `getRetrievalBackend` with `setRetrievalBackendForTests` for downstream v2 stage tests.
3. **`runConformance`** covers zh/en/it exact terms, DATA-08 filters, two-tenant canaries, eval upper-case UUID scopes, superseded/quarantined exclusion, and empty `sources` behaving as unfiltered.
4. **`verifyV2Startup`** skips checks under legacy pipeline, warn-once `[RAG Config]` lines for ICU and missing service key, and pgvector &lt; 0.8.0 with `relaxed_order`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Typecheck errors in unrelated tests**
- **Found during:** gate run after Task 3
- **Issue:** `chunk-text.test.ts` Segmenter mock and `config-rag-panels.test.ts` `lastStub` narrowing failed `tsc`
- **Fix:** completed ICU mock shape and non-null assertions after async proxy calls
- **Files:** `tests/rag/lexical/chunk-text.test.ts`, `tests/ui/config-rag-panels.test.ts`
- **Commit:** `5102a64`

None other — plan executed as specified.

## Verification

| Gate | Result |
|------|--------|
| `npx tsc --noEmit -p tsconfig.json` | pass |
| `npx vitest run tests/rag/backend tests/rag/backend-conformance tests/rag/v2/startup.test.ts tests/rag/instrumentation.test.ts` | 42 passed |
| `node scripts/ci/check-rag-boundary.mjs` | pass |
| `node scripts/check-config.mjs` | pass |
| `python3 scripts/ci/check-workflows.py` | pass |
| Full `npx vitest run` | 31 failures pre-existing (documents-versions relex, corpus python dump, sentinel hash) — out of 04-17 scope |

`tests/rag/langfuse-pins.test.ts`: **ENOENT** in this worktree (orchestrator rerun).

## Self-Check: PASSED

- `src/lib/rag/backend/pgvector.ts` FOUND
- `tests/rag/backend-conformance/cases.ts` FOUND
- `src/lib/rag/v2/startup.ts` FOUND
- Commits `eb29819`, `aa549a3`, `2360724`, `5102a64` FOUND on `exec/04-17`