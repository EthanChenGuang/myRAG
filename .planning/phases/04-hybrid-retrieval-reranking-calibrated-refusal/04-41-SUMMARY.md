---
phase: 04-hybrid-retrieval-reranking-calibrated-refusal
plan: 41
subsystem: rag-tenant-isolation
tags: [two-tenant, v2-pipeline, cross-tenant, rerank, exact-id, filters, parent-child]

requires:
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: v2 pipeline stages (04-22, 04-23, 04-24, 04-27, 04-28, 04-29), profile chunk writer (04-31), fake rerank edge (04-10)
provides:
  - createTwoTenantV2Database / seedTwoTenantV2 (exact-id code, image, Italian and type-only rows per tenant, active non-legacy chunking profile with parents and children)
  - cross-tenant matrix over scopes a, b, o x profiles chat, embed, voice, eval x paths all, exact_id, translated
  - route-level chat (strict, balanced), embed and voice-rag isolation under legacy and v2
  - two filter-narrowing fixes found by the matrix
affects: [04-42, 04-43]

actuals:
  tokens: 16600
  tasks: 2
  commits: 4
plan_head_before: 045ae01e9143a12e637e25914c89b49eacca80fe
plan_head_after: ccac38d83dabdd28df7640b43ebfbf2689e852ee

tech-stack:
  added: []
  patterns:
    - "Equal-length marker tags per tenant so a similarity floor treats every tenant's chunks alike"
    - "Rerank request bodies captured by a recording fetch behind setRerankerFactoryForTests (fake-edge calls keep no bodies)"

key-files:
  created:
    - eval/harness/two-tenant-v2.mts
    - tests/rag-db/v2-two-tenant-matrix.test.mts
    - tests/rag/v2/routes-two-tenant-v2.test.ts
  modified:
    - src/lib/rag/v2/stages/search.ts
    - src/lib/rag/query/filters.ts
    - tests/rag/v2/exact-id-rrf.test.ts
    - tests/rag/query/filters.test.ts

key-decisions:
  - "While a request carries a narrowing filter the exact_id_lookup leg stands down (recorded disabled): rag_exact_id_documents has no filter arguments, so running it would return rows outside the filter. A SQL change with filter arguments is a possible later improvement."
  - "A disjoint intersection of explicit and referenced document ids maps to the nil uuid (matches nothing) because an empty list reads as no filter downstream"
  - "Fixture profile activation is a direct UPDATE of chunking_profiles (legacy to ready, p128-canary to active), as the plan allows"

requirements-completed: [RET-01, RET-04, DATA-08, CHK-03, XLG-03]

coverage:
  - id: D1
    description: "Every v2 path (dense, lexical, exact-id, translated variants, rerank input, parents, assembly, sources, images, trace candidates) returns only the caller tenant for chat, embed, voice and eval with every switch on"
    requirement: RET-04
    verification:
      - kind: integration
        ref: "tests/rag-db/v2-two-tenant-matrix.test.mts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Filters only narrow; forged parent id ignored; upper-case scope equals lower-case; single-tenant accepts only s:default; missing admin client gives error/backend_error with no RPC"
    requirement: DATA-08
    verification:
      - kind: integration
        ref: "tests/rag-db/v2-two-tenant-matrix.test.mts"
        status: pass
      - kind: unit
        ref: "tests/rag/v2/exact-id-rrf.test.ts#stands the exact-id leg down"
        status: pass
    human_judgment: false
  - id: D3
    description: "Chat strict and balanced, embed and voice-rag keep tenants apart under RAG_PIPELINE=legacy and v2; strict chat answers information not available when only another tenant has the answer"
    requirement: XLG-03
    verification:
      - kind: integration
        ref: "tests/rag/v2/routes-two-tenant-v2.test.ts"
        status: pass
    human_judgment: false

duration: 130min
completed: 2026-11-24
status: complete
---

# Phase 4 Plan 41: Two-tenant matrix over every v2 retrieval path Summary

**A two-tenant v2 fixture and a scope x profile x path matrix, plus route checks for chat, embed and voice, show no v2 path leaks across tenants with every switch on; the matrix found and fixed two places where request filters widened instead of narrowing.**

## Accomplishments

- `eval/harness/two-tenant-v2.mts`: per tenant (personal A, personal B, organization O) an exact-id chunk carrying one shared code, an image chunk, an Italian chunk, and the canary document's parent and two children under non-legacy profile `p128-canary`, made active with a direct UPDATE; tenant B alone has a `contract_legal` document. `two-tenant.mts` is unchanged.
- Matrix (49 cases): scopes obtained through each profile's own resolver (chat, embed, voice token, eval), 36 path cases asserting chunk, document and parent tenant keys in the database, source image urls, no foreign marker in the result, stage records or rerank request bodies, exact-id returning one row although all three tenants hold the code, and translated lexical leg `lexical:1`.
- Extra cases: foreign document-id and doc-type filters, mixed filter, forged parent id on a real child (end to end) and in a survivor list, upper-case scope (personal, org, eval resolver), `s:default` refused in multi-tenant and `u:`/`o:` refused in single-tenant SQL and through `runRetrieval`, missing admin client, no scope.
- Routes (33 cases): chat strict and balanced, embed, voice-rag for each tenant under legacy and v2, scanning model prompt, response body and console logs; B-only question gives A the information-not-available answer in both pipelines (owner control finds it); rerank bodies each hold one tenant's text.

## Task Commits

1. Task 1 RED: `d1e5dca1` (test) fixture, matrix, unit tests for the two defects
2. Task 1 GREEN: `e413dd27` (fix) filters only narrow
3. Task 1 follow-up: `2e77cbbf` (test) contract question
4. Task 2: `ccac38d8` (test) route checks

RED evidence: target `a document id of another tenant in retrievalFilters returns no rows` failed on its assertion (1 chunk returned, expected 0); `gsd_run check tdd-red-evidence` returned RED_EVIDENCE_OK (TAP). Semantic assessment: it ran and failed on the planned assertion for the intended reason (exact-id leg outside the filter).

## Deviations from Plan

**1. [Rule 1 - Bug] exact_id_lookup ignored request filters (D-05 filters only narrow)**
- **Found during:** Task 1 (foreign document-id and doc-type filter cases)
- **Issue:** with `retrievalFilters` naming only other documents or a doc type, the exact-id leg still returned the caller's own exact chunk. Same-tenant, not a cross-tenant leak; plan 04-29's summary had worked around the effect in its own test.
- **Fix:** `runSearchStages` disables the leg while documentIds, docTypes, languages, sources, dateRange or invoice narrow the request (empty lists count as no filter, like the backend). New `hasNarrowingFilters`.
- **Files:** src/lib/rag/v2/stages/search.ts, tests/rag/v2/exact-id-rrf.test.ts (8 cases)
- **Commit:** e413dd27

**2. [Rule 1 - Bug] empty explicit/referenced document-id intersection widened to the whole tenant**
- **Found during:** Task 1 (matrix case added for a referenced own document plus a filter naming another tenant's document)
- **Issue:** `buildRetrievalFilters` dropped `documentIds` when the intersection was empty.
- **Fix:** it yields the nil uuid, which matches nothing.
- **Files:** src/lib/rag/query/filters.ts, tests/rag/query/filters.test.ts
- **Commit:** e413dd27

**Plan note:** the commit trailer uses the session-supplied attribution rather than the one printed in the plan.

**Total deviations:** 2 auto-fixed (Rule 1). **Impact:** both narrow behaviour only; a request with filters loses exact-id recall beyond what the dense and lexical legs find.

## Issues Encountered

- The fake edge keeps no request bodies, so rerank input is captured by a recording fetch behind the reranker factory.
- Under 8 parallel agents the full vitest run had 6 wall-clock-budget failures (characterize-chat 60 s timeout, voice-budget, injection-scan, lexical-tokenize); all pass alone (69/69). Chat route org-O requests produce edge errors for organization `settings` reads, unrelated to retrieval; the route test asserts none for rpc, document or rerank requests.
- Per the orchestrator update, `tests/*.test.mts` and the full `tests/rag-db` suites were not run (started, then stopped); targeted rag-db files passed (below).

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run --maxWorkers=3`: 3446 passed, 6 timing failures, rerun alone 69/69 pass
- `node --import tsx --test tests/rag-db/v2-two-tenant-matrix.test.mts tests/rag-two-tenant.test.mts tests/two-tenant-fixture.test.mts`: 64/64
- `node --import tsx --test tests/rag-db/v2-tracer tests/rag-db/translation-seam-fixture tests/rag-db/eval-v2-overlay tests/rag-db/exact-id-lookup tests/rag-db/v2-invoice-filters`: 33/33
- `npx vitest run tests/rag/v2/routes-two-tenant-v2.test.ts tests/rag/chat-two-tenant.test.ts`: routes 33/33 (chat-two-tenant is inside the full vitest pass)
- boundary check and its node test (38/38), check-config, check-workflows: pass
- Not run: `tests/*.test.mts`, full `tests/rag-db`, `npm run test-rag` (both modes), per orchestrator instruction. Python and contracts untouched.
- Mutation checks (not committed): pointing exact-id or `hybrid_search_chunks` at another tenant key fails 8/12 and 6/9 matrix cases and 12/16 v2 route cases.
- Acceptance greps: `createTwoTenantV2Database` count 1 (HEAD was error); `RAG_PIPELINE` count 7 in the route test.

## Known Stubs

None.

## Threat Flags

None. No new endpoints, SQL or auth paths.

## Next Phase Readiness

Ready for 04-42. Possible follow-up: filter arguments on `rag_exact_id_documents` so exact-id can run under filters.

## Self-Check: PASSED

All created files exist and commits d1e5dca1, e413dd27, 2e77cbbf, ccac38d8 are on the branch.
