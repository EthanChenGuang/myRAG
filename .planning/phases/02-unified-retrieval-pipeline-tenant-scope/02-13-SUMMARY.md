---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 13
subsystem: chat-route
tags: [chat, refs-stage, general-overview, tenant-predicate, two-tenant, retired-imports]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: runRetrieval and stage runner (02-08), assembleContext and the referenced state (02-09), verified chat scope and status mapping (02-10, 02-12), vectorSearch(scope, ...) backend adapter
provides:
  - src/lib/rag/refs/resolve.ts (resolveDocumentRefs, tenant predicate on every documents query)
  - refs as an optional pipeline stage before analyze (RAG_DISABLED_STAGES can switch it off, skipped on failure gives degraded)
  - src/lib/rag/context/overview.ts and options.generalOverview (overview fallback through the scoped pipeline)
  - chat route with no retired retrieval imports; every knowledge-base read goes through `@/lib/rag`
  - tests/rag/chat-two-tenant.test.ts and the twoTenant option of the route fixture
affects: [02-14, 02-16, 02-18, 02-19]

requirements-completed: [PIPE-01, PIPE-02, PIPE-05]

actuals:
  tokens: 23000
  tasks: 3
  commits: 5
plan_head_before: c7c3232628f676d2411ea1e739c886d481a5d035
plan_head_after: 17a8fc11a0824899c0c75797a9b27fe98bd96ede

tech-stack:
  added: []
  patterns:
    - "Document-scoped reads use one helper (scoped) that applies tenantPredicate(scope) to the builder, so a documents query cannot be written without it"
    - "A reference is resolved in two steps: a scoped documents lookup first, chunk reads only for ids that survived it"
    - "The fake edge stays strict by default; filename lookups are an opt-in option used only by the two-tenant route fixture"

key-files:
  created:
    - src/lib/rag/refs/resolve.ts
    - src/lib/rag/context/overview.ts
    - tests/rag/refs.test.ts
    - tests/rag/overview.test.ts
    - tests/rag/characterize-chat-overview.test.ts
    - tests/fixtures/characterization/chat-overview.json
    - tests/rag/chat-two-tenant.test.ts
  modified:
    - src/lib/rag/pipeline.ts
    - src/lib/rag/config.ts
    - src/lib/rag/types.ts
    - src/lib/rag/index.ts
    - src/app/api/chat/route.ts
    - tests/rag/config.test.ts
    - tests/rag/pipeline-assembly.test.ts
    - tests/helpers/route-fixture.ts
    - eval/harness/fake-edge.mts

key-decisions:
  - "refs runs only when documentRefs carries at least one mention or document part, so ordinary requests keep the same stage list and trace as before"
  - "Out-of-scope and nonexistent document ids are indistinguishable without a cross-tenant read, so both count as ignored; one `[RAG Tenant]` warning with { ignoredReferences } is logged per request"
  - "A mention that matches nothing inside the scope only logs; it is not counted as ignored"
  - "The overview path keeps the legacy quirks on purpose (referenced documents listed first, referenced context dropped, route-side similarity filter on the used documents) so the snapshot stays byte-identical"
  - "RetrievalOptions.referenced (the temporary 02-12 path) is removed; ReferencedState now only comes out of the refs stage"
  - "fake-edge gets an opt-in documentFilenameFilter option instead of a default filter, because tests/fixture-edge.test.mts asserts that filename ilike is rejected"

patterns-established:
  - "Route tests that need a per-test module graph still use vi.doMock after vi.resetModules() (carried from 02-12); this plan's route tests use loadRoute from the fixture, which resets modules itself"

coverage:
  - id: D1
    description: "@mention names and document parts resolve only inside the scope; every documents query carries the predicate; chunks are read only for verified ids"
    requirement: PIPE-02
    verification:
      - kind: unit
        ref: "tests/rag/refs.test.ts (14 tests: personal, org and single predicates, foreign part, output format, fallbacks, abort signal, stage in runRetrieval)"
        status: pass
  - id: D2
    description: "Overview fallback runs through runRetrieval with the caller's scope; single-tenant context and used documents are byte-identical to the pre-switch snapshot"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/rag/characterize-chat-overview.test.ts (snapshot taken before the route change, unchanged after); tests/rag/overview.test.ts (9 tests)"
        status: pass
  - id: D3
    description: "The chat route imports none of the retired retrieval modules, the old prompt enhancer, the old embedding helper or the old similar-chunks search"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "node check over route.ts imports; grep for generalOverview (1) and for thinking-rag-enhancer / retrieval-strategies outside comments (0, 0)"
        status: pass
  - id: D3b
    description: "Chat characterization snapshots are unchanged (144 cases) and the strict, websearch, source-images and status tests pass"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/rag/characterize-chat.test.ts; tests/chat-strict.test.ts; tests/chat-websearch.test.ts; tests/chat-source-images.test.ts; tests/rag/chat-status.test.ts"
        status: pass
  - id: D4
    description: "Two-tenant route test: B cannot use organization O, A sees only A (or only O), B's filename and document id leak nothing, no session reads nothing, overview shows only the caller's documents"
    requirement: PIPE-02
    verification:
      - kind: integration
        ref: "tests/rag/chat-two-tenant.test.ts (10 tests); mutation check: removing the predicate in resolve.ts fails 6 tests (3 refs, (d), (e), (e2))"
        status: pass

duration: 1 session
completed: 2026-11-23
---

# Phase 2 Plan 13: Document References and Overview Fallback on the Scoped Pipeline Summary

**@mention and document-part lookups now run as the pipeline's `refs` stage with the tenant predicate on every documents query, the no-query-text overview runs through `runRetrieval({ options: { generalOverview: true } })` with the verified scope, and the chat route no longer imports any retired retrieval module; proven with a route-level two-tenant test.**

## Performance

- **Tasks:** 3 of 3 (task 1 as RED then GREEN; the overview characterization was committed before the route change)
- **Verification:**
  - `npx vitest run` passes (62 files, 700 tests)
  - `node --import tsx --test tests/fixture-edge.test.mts tests/rag-two-tenant.test.mts tests/rag-assemble-differential.test.mts` passes (37 tests)
  - `npm run test-rag`: gate PASS
  - `npx next typegen && node scripts/ci/tsc-ratchet.mjs` reports ok (45 errors, down from 58; the route file lost its retired imports)
  - Acceptance: `grep -c tenantPredicate src/lib/rag/refs/resolve.ts` = 2 (>= 1); `refs.test.ts` 14 passed; `generalOverview` in route = 1; `thinking-rag-enhancer` and `retrieval-strategies` outside comments = 0 and 0; `chat-two-tenant.test.ts` 10 passed; `twoTenant` in route-fixture.ts >= 1

## Accomplishments

- Task 1 (RED 010f352, GREEN 590621f): `resolveDocumentRefs({ scope, mentions, documentParts, admin, signal })` keeps the lookup order (ilike then exact filename, limit 1), the 30-chunk limit, the content/text and select-all fallbacks, the `=== DOCUMENT: "..." ===` section and the used document entry (`explicitly_referenced`, 200-char preview, `external_url`). Every documents query is built through `scoped()`; chunk queries run only for ids whose scoped metadata lookup returned a row. The debug listing of all documents is gone. `refs` joined OPTIONAL_STAGES and every profile's defaults at 5000 ms; the pipeline runs it before analyze and feeds its output to the assembly as the referenced state; `options.referenced` is removed.
- Task 2 (characterization 08d712b, switch b0b7c01): the overview snapshot was taken on the legacy path with a seeded overview document (two chunks that exercise the chunk-number ordering, one chunk at similarity 0.546 that stays in the context but is dropped from the used documents by the route's 0.6 filter) and is unchanged after the switch. `assembleOverviewContext` reproduces the format; the overview pipeline embeds the fixed query, calls `vectorSearch(scope, embedding, 5, 0.5, { client: admin })` (single scope keeps the same RPC; personal and org scopes use the workspace RPC), and looks the documents up in one batched `in()` query. The route's no-query-text branch is now one `runRetrieval` call and the five retired imports are gone.
- Task 3 (17a8fc1): `startRouteFixture` takes `twoTenant: true` (multi-tenant database with two users, a personal document each and an organization document). Ten cases cover the plan's (a) to (g) plus an organization document id in and out of scope, and the overview with no session.

## Intended behaviour changes

- An `@mention` or document-part reference outside the caller's scope is ignored and logged under `[RAG Tenant]`; none of its content is read. A nonexistent document id is now ignored the same way instead of producing a "referenced but no content" line.
- In multi-tenant mode the overview fallback searches only the caller's workspace instead of every user's personal documents; with no session it reads nothing and the strict refusal applies.
- The cross-tenant debug listing of documents (printed when a mention matched nothing) was removed.
- A retrieval error during the overview now streams the localized "knowledge base unavailable" error part (the 02-12 status mapping) instead of failing the request.

## Deviations from Plan

**1. [Rule 3 - Blocking] fake-edge opt-in filename filter**
- **Found during:** task 3
- **Issue:** the route fixture's fake edge rejects `filename` filters, so case (d) (mention of B's filename) could only pass trivially, with no positive control. `tests/fixture-edge.test.mts` asserts that the default edge rejects `filename=ilike`.
- **Fix:** `startFakeEdge({ db, documentFilenameFilter })`, default off; only the twoTenant fixture turns it on. The edge stays strict for every other test.
- **Files:** `eval/harness/fake-edge.mts`, `tests/helpers/route-fixture.ts`
- **Commit:** 17a8fc1

**2. [Test infrastructure] seed hook on the route fixture**
- `RouteFixtureOptions.seed` inserts extra rows before the edge starts; the overview characterization and the two-tenant overview case need documents that match the fixed overview query (the corpus has none above 0.5). Commit 08d712b.

**3. [Plan file list] extra test files and a moved test**
- Added `tests/rag/overview.test.ts` (unit tests for the overview context and stage, not in the plan's list). The 02-12 pipeline test "the referenced state is passed through" used the removed option; its coverage moved to `tests/rag/refs.test.ts` ("keeps the referenced context first ..."). `tests/rag/config.test.ts` gained `refs` in its stage tables.

**4. [Interim step, resolved in task 2] direct resolveDocumentRefs call**
- Between the two route commits the no-query-text branch called `resolveDocumentRefs` directly so reference-only messages kept their used documents. Task 2 removed it.

## Deferred Issues

- **Document parts are dead for text-plus-document arrays (pre-existing, not changed here).** `route.ts` collapses an array user message to its text when no `image_url` part is present ("Converting array content to string ... (no images)") before the RAG block runs, so `documentParts` only reaches retrieval when an image part is also present (and then only on the MCP path, otherwise the route forwards to image generation). Fixing it changes what users see, so it needs its own decision. The route test works around it with an `image_url` part that has no url. Not logged in `.planning/WINDOWS.md`.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-02-32 (predicate on every documents query, chunk reads for verified ids only, debug listing removed: unit tests plus route cases (d), (e), (e2), mutation-checked), T-02-33 (foreign ids ignored and logged, never read: refs and route tests), T-02-34 (overview through `vectorSearch(scope, ...)`: overview tests and route case (g), (g2)). The fake-edge option is test-only.

## Notes for later plans

- 02-19 can delete the retired modules: the chat route no longer imports `enhanced-rag-retrieval`, `retrieval-strategies`, `optimized-search`, `thinking-rag-enhancer`, `document-processor` (embedding helper) or `searchSimilarChunks`. `tests/rag/characterize-chat.test.ts` still mocks `@/lib/thinking-rag-enhancer` (an obsolete mock the route no longer needs); remove it with the module.
- The overview stage list in a trace is `embed, search, assemble` (plus `refs` when references are given); there is no `analyze`/`legacy_rank` for it.
- `src/lib/rag/index.ts` edits were append-only (refs and overview exports).

## Self-Check: PASSED

- All files under key-files.created exist.
- Commits 010f352, 590621f, 08d712b, b0b7c01 and 17a8fc1 are ancestors of HEAD; `git rev-list --count` from the plan base c7c3232 is 5.
- STATE.md, ROADMAP.md and REQUIREMENTS.md are untouched.
