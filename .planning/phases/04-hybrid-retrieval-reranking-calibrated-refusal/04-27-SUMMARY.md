---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 27
subsystem: rag
tags: [parent-child, expand-parents, context-assembly, token-budget, tenant-isolation, v2-pipeline]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: document_parents and rag_fetch_parents (04-07), RankedHit.parentId (04-17), budgeted assemble and compress stages (04-22), dedupe by parent when RAG_PARENT_CHILD is on (04-11, 04-19)
provides:
  - expandParents: one tenant-scoped rag_fetch_parents call, parents attached to their children
  - selectWithParents: budget selection where a parent replaces its children only while it fits whole
  - expand_parents stage in the v2 context group, before assemble, behind RAG_PARENT_CHILD
affects: [04-31, 04-40]

actuals:
  tokens: 12000
  tasks: 2
  commits: 5
  plan_head_before: e3b4d1228789ecba09082806885728d871597773
  plan_head_after: "da2b58e8e32e549786f376b3f4b70dfaf666393a"

tech-stack:
  added: []
  patterns:
    - "Fetch with the scope key, then re-check tenant_key, requested id, is_current and document id on every returned row"
    - "Parent-or-child decided by re-running the plain budget selection and handing back the first parent that is dropped or truncated"

key-files:
  created:
    - src/lib/rag/parents/expand.ts
    - tests/rag/parents/expand.test.ts
    - tests/rag-db/parents-fetch.test.mts
  modified:
    - src/lib/rag/v2/stages/context.ts
    - tests/rag/v2/context-stages.test.ts

key-decisions:
  - "No new SQL: rag_fetch_parents (0404, SECURITY INVOKER, service_role only) already existed, so no new SECURITY DEFINER function and no allow-list change"
  - "The parent-or-child budget decision runs once, in the expand_parents stage, because the stage must report parents_used; assemble consumes that selection and falls back to the unchanged child selection when no parent was used or the stage was skipped"
  - "A parent is never truncated: a first-rank parent over the budget hands its children back, so the child path keeps its own rank-1 truncation rule"
  - "When a parent does not fit, all of its surviving children come back in their own ranks, not only the best one"
  - "Parent blocks are marked through CompressibleChunk.mergedParent so compression leaves them unchanged"
  - "Image documents never take a parent (eligible check), because the budget helper admits them without cost"

requirements-completed: [CHK-03]

coverage:
  - id: D1
    description: "expandParents: one rag_fetch_parents call with scopeKey, one entry per parent at its best child's rank, null parent stays child, admin null or RPC error rejects, abort rejects with the reason, 200-id cap"
    requirement: CHK-03
    verification:
      - kind: unit
        ref: "tests/rag/parents/expand.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Budget rule: parents count against the D-15 budget, a parent that does not fit leaves its children, parents never truncated"
    requirement: CHK-03
    verification:
      - kind: unit
        ref: "tests/rag/parents/expand.test.ts#selectWithParents"
        status: pass
    human_judgment: false
  - id: D3
    description: "expand_parents stage: switch off is disabled with no call and an identical context; on renders each parent once under its document header; failure skips; refusal makes no call; parent blocks not compressed"
    requirement: CHK-03
    verification:
      - kind: unit
        ref: "tests/rag/v2/context-stages.test.ts#runContextStages expand_parents (D-20)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Two-tenant PGlite: a forged foreign parent id never returns content, own parent returned, anon refused, no RPC after a refusal"
    requirement: CHK-03
    verification:
      - kind: unit
        ref: "tests/rag-db/parents-fetch.test.mts"
        status: pass
    human_judgment: false

duration: 0min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 27: Parent expansion behind RAG_PARENT_CHILD Summary

**With RAG_PARENT_CHILD on, child hits are replaced by their parent sections after refusal and before assembly: one tenant-scoped `rag_fetch_parents` call, one entry per parent at its best child's rank, inside the token budget, and the child kept whenever the parent does not fit.**

## Accomplishments

- `expandParents` collects the distinct parent ids of the survivors in rank order (at most 200), calls `rag_fetch_parents` once through the admin client with `scopeKey(scope)`, and attaches only rows that match the scope's tenant key, were asked for, are current, and sit in the same document as the child. A missing admin client or an RPC error throws `RetrievalBackendError('rag_fetch_parents', code)`; the abort reason is thrown after the await.
- `selectWithParents` runs the existing `selectWithinBudget` over one entry per parent (parent text in place of the child) and hands back the first parent that gets dropped or would be truncated, repeating until none is left. This is the same greedy rank-order decision a sequential pass would make, and it reuses the D-15 cost model instead of copying it.
- The `expand_parents` stage sits before `assemble` in `runContextStages`. It records `parents_fetched` and `parents_used`; a failure records `skipped` (run status degraded) and the children are used. With the switch off the stage is recorded `disabled` and the selection path is the unchanged child path; the test compares the rendered context against a run with no parent ids and it is byte-identical. A refusal leaves no survivors, so the stage records `candidates_in 0` and makes no call.
- Parent blocks go through `CompressibleChunk.mergedParent`, so `RAG_CONTEXT_COMPRESSION` leaves them whole (control test shows an ordinary chunk of the same text is compressed).
- Tenant isolation: the PGlite two-tenant test (fake edge, service key) seeds one parent per tenant and forges tenant B's parent id into tenant A's survivor list, both on a child of A's document and on a child of B's document. A gets its own parent once and no B text; B gets the mirror result. The function is also called directly to show the SQL filter, and an anon client is refused.

## Task Commits

| Task | Commit | Subject |
| ---- | ------ | ------- |
| 1 RED | cf1cbfa | test(04-27): failing tests for expandParents and the parent-or-child budget rule |
| 1 GREEN | 0f4026d | feat(04-27): expandParents with tenant-scoped single fetch and parent-or-child budget rule (D-20) |
| 2 RED | 3c57899 | test(04-27): failing tests for the expand_parents stage and the two-tenant parent fetch |
| 2 GREEN | fcba4dc | feat(04-27): expand_parents stage before assemble behind RAG_PARENT_CHILD (D-20, D-24) |
| lint | da2b58e | refactor(04-27): rename parent-selection callbacks so the hooks lint rule does not read them as hooks |

Both RED commits failed on assertions (Task 1 against a stub with the final signatures, Task 2 against the unchanged stage).

## Deviations from Plan

**1. [Interpretation] Budget decision lives in the expand stage's value, consumed by assemble**
- The plan says the budget decision stays in the assemble stage, and also that `expand_parents` records `parents_used`. Both cannot hold literally, because the stage record is written when the stage ends. The selection is computed in the expand stage (only when at least one parent came back) and assemble uses it; with no parent used, assemble runs the old selection unchanged. No behaviour differs from the plan's intent.

**2. [Rule 3 - Blocking] Extra test file edits**
- `tests/rag/v2/context-stages.test.ts` is not in `files_modified` but is the file the plan's verify command runs; the stage tests went there, with an optional `parentId` on its fixture spec.

**3. [Rule 1 - Lint] Callback names**
- `useParent` tripped `react-hooks/rules-of-hooks` (error); renamed. Commit da2b58e.

## Deferred Issues

- `tests/rag/documents-versions.test.ts` (27 tests) fails with `RelexInputError: rpc_failed:rag_relex_candidates`. Identical on base e3b4d12 (checked in a throwaway detached worktree, removed afterwards). Not caused by this plan; a `fix-relex-rpc` branch exists.
- `tests/rag/lexical-tokenize.test.ts` "finishes under one second" failed once in the full `tests/rag` run (3.1 s under load) and passes alone (18/18).
- `tests/rag-db/v2-tracer.test.mts` was already failing at base per the 04-22 summary; not run here.
- Ingestion of parents and children is plan 04-31 and the on/off eval comparison is plan 04-40; with no parent rows in the database the switch has no visible effect yet.
- `parents_used` counts parent entries that made the budget; the trace does not yet say which children were absorbed into a parent (not required by the plan).

## Known Stubs

None.

## Threat Flags

None. T-04-50 mitigated in two layers: the SQL function filters `tenant_key` from `scopeKey`, and `expandParents` re-checks tenant key, requested id, currency and document on every row (forged-id two-tenant test). T-04-51 mitigated: optional stage, skipped on failure or timeout, children used.

## Self-Check

- `src/lib/rag/parents/expand.ts` FOUND; `tests/rag/parents/expand.test.ts` FOUND; `tests/rag-db/parents-fetch.test.mts` FOUND
- Commits cf1cbfa, 0f4026d, 3c57899, fcba4dc, da2b58e FOUND on exec/04-27
- Acceptance greps: `rag_fetch_parents` in expand.ts 1 (>= 1); `expand_parents` in context.ts 2 (>= 1)
- `npx vitest run tests/rag/parents tests/rag/v2` 86 pass; `node --import tsx --test tests/rag-db/parents-fetch.test.mts` 6 pass; `check-rag-boundary` ok; `tsc --noEmit` 0 errors

## Self-Check: PASSED
