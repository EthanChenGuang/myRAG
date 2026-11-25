---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 05
subsystem: testing
tags: [test-fakes, supabase-fake, fake-edge, pglite, multi-tenant, tenant-isolation]

requires:
  - phase: 01-eval-foundation
    provides: fake PostgREST edge, PGlite fixture database, fixture embedder
provides:
  - createSupabaseFake filters on eq, in, is and ilike, truncates on limit, and records every builder call and rpc
  - store.calls, store.rpcCalls and store.reset() for fixed-query-count assertions
  - fake edge answers in-lists, voice fallback or/ilike and not.is.null, documents tenant filters and organization reads
  - createTwoTenantDatabase and TWO_TENANT_IDS two-tenant multi-tenant fixture
affects: [02-06, 02-07, 02-08, 02-09, 02-10]

actuals:
  tokens: 8000
  tasks: 2
  commits: 4
plan_head_before: 53a3f891f32b9cfb776ed4b59d2b1723d1f92246
plan_head_after: fc7db6c26b400acdd3d7c42127a39444983a7d7e

tech-stack:
  added: []
  patterns:
    - "Per-table filter capability map in fake-edge so a new operator is a one-line, per-column opt-in"
    - "Two-tenant fixture layers extra seed rows on createFixtureDatabase instead of changing the default corpus"

key-files:
  created:
    - tests/helpers-fakes.test.ts
    - eval/harness/two-tenant.mts
    - tests/two-tenant-fixture.test.mts
  modified:
    - tests/helpers/chat-route-fakes.ts
    - eval/harness/fake-edge.mts
    - tests/fixture-edge.test.mts

key-decisions:
  - "Recorded rpc calls land in both store.calls and store.rpcCalls so a total query count and an rpc-only view are both available"
  - "or and not stay recorded pass-through filters in the vitest fake; the fake edge implements the real or/ilike and not.is.null semantics through SQL"
  - "Fake edge operators are opt-in per table and column (TABLE_FILTERS); tenant filters exist on documents only and or/image_url only on document_chunks"
  - "Organization O has A as member and owner; B is neither"

patterns-established:
  - "Edge filter values are always bound parameters; only fixed column expressions are interpolated into SQL"

requirements-completed: [PIPE-02, PIPE-05]

coverage:
  - id: D1
    description: "Vitest Supabase fake filters rows for eq, in, is and ilike, applies limit, and records every builder call and rpc"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/helpers-fakes.test.ts (12 tests)"
        status: pass
      - kind: unit
        ref: "tests/chat-strict.test.ts, chat-websearch, chat-source-images, chat-messages-roundtrip (unchanged, 22 tests across 5 files)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fake edge supports in-lists, voice fallback or/ilike, not.is.null, documents tenant filters and organization reads; other operators still 400 and count as edge errors"
    requirement: PIPE-02
    verification:
      - kind: unit
        ref: "tests/fixture-edge.test.mts (7 new tests incl. 10 rejected-operator cases)"
        status: pass
      - kind: other
        ref: "npm run test-rag -- --out eval/out/fakes -> gate PASS, edge_errors 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "Two-tenant PGlite fixture with the real match_documents_by_workspace RPC returns only the caller's workspace chunks"
    requirement: PIPE-02
    verification:
      - kind: unit
        ref: "tests/two-tenant-fixture.test.mts (8 tests: (null,A), (O,A), (null,B), (null,null), default corpus untouched)"
        status: pass
    human_judgment: false
---

# Phase 2 Plan 05: Test Fakes and Two-Tenant Fixture Summary

**The vitest Supabase fake now filters and records calls, the fake PostgREST edge answers the in-list, voice-fallback and tenant queries, and a two-tenant PGlite fixture runs the real workspace RPC, so tenant and query-count tests in this phase cannot pass by ignoring filters.**

## Performance

- **Duration:** about 5 min
- **Started:** 2026-11-23T14:10:00Z
- **Completed:** 2026-11-23T14:16:00Z
- **Tasks:** 2 (both TDD, RED then GREEN commits)
- **Files:** 6 (3 created, 3 modified)

## Accomplishments

- `createSupabaseFake` filters rows for `eq`, `in`, `is` and `ilike` (case-insensitive, `%` and `_` wildcards, `metadata->>key` column paths), truncates on `limit`, and returns `{ data: null, error: null }` from `maybeSingle` when nothing matches. `store.calls`, `store.rpcCalls` and `store.reset()` expose what a code path issued.
- The fake edge accepts `id`/`document_id` `in.(uuid,...)`, `or=(content|metadata->>name|metadata->>image_context).ilike.<pattern>`, `metadata->>image_url=not.is.null`, `organization_id` eq/is.null and `user_id` eq on documents, and eq reads on `organization_members` and `organizations`. Everything else keeps returning 400 and counts as an edge error.
- `eval/harness/two-tenant.mts` builds a multi-tenant fixture with users A and B, organization O (A member and owner), one personal document each for A and B and one organization document for O. The real `match_documents_by_workspace` returns only A's chunk for (null, A), only O's for (O, A), only B's for (null, B) and nothing for (null, null). The default corpus hash is unchanged.

## Task Commits

1. **Task 1 RED:** `2d9bf52` test(02-05): failing tests for filtering Supabase fake and call recorder
2. **Task 1 GREEN:** `3ec38ff` feat(02-05): Supabase fake filters on eq/in/is/ilike and records calls
3. **Task 2 RED:** `55defc2` test(02-05): failing tests for fake edge operators and two-tenant fixture
4. **Task 2 GREEN:** `fc7db6c` feat(02-05): extend fake edge operators and add two-tenant PGlite fixture

## Decisions Made

See `key-decisions` in the frontmatter. The one with downstream weight: the fake edge never opts in an operator globally, only per table and column, so a later plan that needs for example chunk-level `organization_id` filters must add it deliberately.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Notes for Later Plans

- `match_documents_by_workspace` does not check membership: (O, B) returns O's chunks although B is not a member. Membership must be enforced in application code (the fake edge now serves `organization_members` reads for that check), and later tenant tests should assert the membership gate rather than rely on the RPC.
- `maybeSingle` on the vitest fake used to return a PGRST116 error on no rows; it now returns `{ data: null, error: null }` as specified. The existing chat characterization tests were unaffected.
- The `select` parameter on the fake edge still rejects `embedding` and embedded relations, so the voice keyword fallback that selects `embedding` is not served by the edge yet.

## Known Stubs

None.

## Threat Flags

None. The new test-only surface (edge operators, fixture) adds no production endpoints; T-02-09 and T-02-10 are mitigated as planned.

## Verification

- `npx vitest run`: 15 files, 142 tests passed
- `node --import tsx --test tests/*.test.mts`: 54 passed, 0 failed
- `node --import tsx --test tests/two-tenant-fixture.test.mts`: 8 passed
- `npm run test-rag -- --out eval/out/fakes`: gate PASS, `edge_errors == 0`, corpus_sha256 `dd161cea...` unchanged from before the plan, metrics identical

## Self-Check: PASSED

- Files exist: tests/helpers-fakes.test.ts, eval/harness/two-tenant.mts, tests/two-tenant-fixture.test.mts
- Commits reachable from HEAD: 2d9bf52, 3ec38ff, 55defc2, fc7db6c
- Acceptance criteria re-run: `grep -c calls` in the fake is 10 (>= 2); `grep -c createTwoTenantDatabase` is 1 (>= 1); vitest helper file reports 12 passed; two-tenant file reports 8 passed; `jq -e '.edge_errors == 0'` exits 0
