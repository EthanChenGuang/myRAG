---
phase: 03-unified-ingestion-embedding-profiles
plan: 24
subsystem: ingestion
tags: [ingest, ai-to-rag, tenant-scope, write-path, dedup, session-auth]

requires:
  - phase: 03-unified-ingestion-embedding-profiles
    provides: "ingest() with thirteen stages, writer and dedup (03-13, 03-13b), object store (03-17), doc-type resolution (03-22), loadIngestConfig (03-03)"
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: "resolveTenantScope, repairOwnerMembership, the ai-to-rag session and body-user fix (02-19)"
provides:
  - "ai-to-rag unified branch: after the route's shared checks, ingest({ scope: tenant.scope, source: 'ai_to_rag', sourceKey: chat:<chatId>/message:<messageId>, text, filename <title>.md, mimeType text/markdown })"
  - "options.documentMetadata on ingest(): a sanitised set of plain facts written to the document row right after the version begins; pipeline-owned keys cannot be set"
  - "loadIngestConfig exported from @/lib/rag, so routes read RAG_INGEST_PIPELINE without a boundary-violating deep import"
  - "Chat message UI sends organizationId (multi-tenant, not personal mode) when saving an answer"
affects: [03-23, 03-31, 03-33, 03-47]

tech-stack:
  added: []
  patterns:
    - "A write path keeps its session, body-user, scope and write-access checks first and ahead of the pipeline switch; the unified branch only runs after they pass and never resolves the scope again"
    - "Caller facts reach the document row through options.documentMetadata (allow-listed key shape, scalar values only), not through new ingest input fields"

key-files:
  created:
    - src/lib/rag/ingest/document-metadata.ts
    - tests/rag/ingest/write-path-ai-to-rag.test.ts
    - tests/rag/ingest/write-path-ai-to-rag-two-tenant.test.ts
    - tests/rag/ingest/document-metadata.test.ts
  modified:
    - src/app/api/ai-to-rag/route.ts
    - src/components/ui/chat-message.tsx
    - src/lib/rag/index.ts
    - src/lib/rag/ingest/stages/dedup.ts

key-decisions:
  - "Caller metadata is written in file_hash_dedup right after begin (not in enrich) so it exists as soon as the row does and every later system write wins; pipeline keys (quarantine, duplicate_of, content_hash_version, doc_type_detection, external_url) are also filtered"
  - "The route reads the switch as loadIngestConfig({ RAG_INGEST_PIPELINE: env.RAG_INGEST_PIPELINE }); loadIngestConfig is exported from the @/lib/rag index because the boundary check forbids deep imports outside src/lib/rag"
  - "Unified response keeps success, documentId, filename, title, chunksStored and totalChunks and adds status and version; a duplicate returns the existing document id with version null; processing is 202; failed is 500 with a generic error and no reason or content"
  - "messageId is required (400 with the validateRequest shape); chatId is optional and an empty or absent chatId yields the key chat:none/message:<id>, so a client without a session id can still save"
  - "The title becomes the filename after path separators and control characters are replaced and the length is capped at 120"
  - "The UI reads the workspace with useOrganizationStore.getState() at click time, as the chat request does, instead of subscribing every message to the store"

patterns-established:
  - "Two-tenant route test through startRouteFixture with the real ingest(), the real writer SQL and createFakeObjectStore() installed after loadRoute"

requirements-completed: [DATA-01, DATA-02]

actuals:
  tokens: 31000
  tasks: 2
  commits: 3

plan_head_before: 65c5b7fec2be3a12c7e444f38c1bc4f50f947053
plan_head_after: c722fda985d529fe39aecee9e550027c754c7933

coverage:
  - id: D1
    description: "RAG_INGEST_PIPELINE legacy, unset or invalid keeps the route's own inserts and response shape and never calls ingest; tests/rag/ai-to-rag-route.test.ts passes unchanged"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-ai-to-rag.test.ts#ai-to-rag write path: legacy"
        status: pass
      - kind: unit
        ref: "tests/rag/ai-to-rag-route.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Under unified, the checks HEAD runs run first: no session 401, body userId other than the session user 403, non-member organization 403, all before ingest; the scope is resolved once and is u:<session user>, o:<org> or s:default with no user"
    requirement: DATA-01
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-ai-to-rag.test.ts#ai-to-rag write path: unified"
        status: pass
      - kind: integration
        ref: "tests/rag/ingest/write-path-ai-to-rag-two-tenant.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "ingest receives source ai_to_rag, the chat and message source key, text, <title>.md, text/markdown and chat metadata; the document row carries messageId, chatId and generatedAt; the route writes no row itself"
    requirement: DATA-02
    verification:
      - kind: unit
        ref: "tests/rag/ingest/write-path-ai-to-rag.test.ts#passes the session-derived personal scope"
        status: pass
      - kind: integration
        ref: "tests/rag/ingest/write-path-ai-to-rag-two-tenant.test.ts#a signed-in user saves an answer"
        status: pass
    human_judgment: false
  - id: D4
    description: "Saving the same answer twice is skipped as a duplicate against the real writer SQL in both modes, while another tenant saving the same text and message id gets its own document"
    requirement: DATA-01
    verification:
      - kind: integration
        ref: "tests/rag/ingest/write-path-ai-to-rag-two-tenant.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "options.documentMetadata keeps only short scalar values under safe key names and drops pipeline-owned keys"
    requirement: DATA-02
    verification:
      - kind: unit
        ref: "tests/rag/ingest/document-metadata.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "The chat message UI sends the current workspace so team chats save into the team knowledge base, and the toast reports a duplicate or a held answer"
    requirement: DATA-01
    verification: []
    human_judgment: true
    rationale: "No component test exists for chat-message.tsx; the request body is built from the same store rule as the chat request, checked by grep and tsc only"

duration: not measured (session interrupted by a usage limit and resumed)
completed: 2026-11-24
status: complete
---

# Phase 3 Plan 24: ai-to-rag behind ingest() Summary

**Saving an AI answer to the knowledge base now goes through ingest() under RAG_INGEST_PIPELINE=unified, in the session-verified scope the route already resolves, while the legacy branch and the Phase 2 session, body-user and tenant checks stay exactly as they were**

## Accomplishments
- The unified branch sits after every shared check (session, body userId, JSON body and content, repairOwnerMembership, resolveTenantScope, single-tenant write access) and calls ingest() once with `tenant.scope`; refused requests never reach it.
- A second identical save returns `skipped_duplicate` with the existing document id; the same text from another tenant creates its own document. Proven against the real writer SQL in multi-tenant (personal, organization, non-member, spoofed body user, anonymous) and single-tenant (`s:default`, no user id).
- ingest() accepts `options.documentMetadata`, persisted right after the version begins; the route uses it for source, messageId, chatId and generatedAt.
- The chat message UI sends `organizationId` under the same rule as the chat request.

## Task Commits
1. **Task 1: unified branch after the shared checks (TDD)**
   - RED: `e3aebb7` (test)
   - GREEN: `94e40fe` (feat)
2. **Task 2: chat message UI sends the workspace** - `c722fda` (feat)

**Plan metadata:** committed after this file (docs: complete plan)

## Files Created/Modified
- `src/app/api/ai-to-rag/route.ts` - unified branch, schema, filename helper; legacy code untouched
- `src/lib/rag/ingest/document-metadata.ts` - `callerDocumentMetadata`
- `src/lib/rag/ingest/stages/dedup.ts` - writes caller metadata after begin
- `src/lib/rag/index.ts` - exports `loadIngestConfig`
- `src/components/ui/chat-message.tsx` - organizationId in the request, toast wording
- `tests/rag/ingest/write-path-ai-to-rag.test.ts` (23 tests), `write-path-ai-to-rag-two-tenant.test.ts` (8), `document-metadata.test.ts` (4)

## Decisions Made
See `key-decisions`.

## Deviations from Plan

**1. [Rule 3 - Blocking] ingest() had no way to store caller metadata**
- **Found during:** Task 1
- **Issue:** the plan wants chatId, messageId and generatedAt in the document metadata, but no stage persisted anything from `IngestInput.options`.
- **Fix:** new `src/lib/rag/ingest/document-metadata.ts` plus four lines in `stages/dedup.ts`; additive, a no-op when the option is absent. Files outside the plan's list.
- **Verification:** `tests/rag/ingest/document-metadata.test.ts`, the real-ingest and two-tenant route tests.
- **Committed in:** `94e40fe`

**2. [Rule 3 - Blocking] loadIngestConfig exported from the @/lib/rag index**
- **Found during:** Task 1 (`check-rag-boundary` reported a deep import of `@/lib/rag/ingest/config`)
- **Fix:** one appended line in `src/lib/rag/index.ts`. 03-23, 03-31 and 03-33 need the same export; if they add the identical line the merge is trivial, otherwise keep one copy.
- **Committed in:** `94e40fe`

**3. [Rule 2 - Missing Critical] Extra tests and a response branch for non-ready results**
- Added `write-path-ai-to-rag-two-tenant.test.ts` (real SQL, two tenants, both modes) and `document-metadata.test.ts`; the route maps processing to 202 and failed to 500, which the plan left open.

**4. [Plan interpretation] Task 2 reads the store with getState()**
- The plan says to use store selectors. A per-message subscription would re-render every message when the workspace changes, and the chat request already uses `getState()` for the same rule. The toast also reports a duplicate or quarantined result (small addition).

**5. [Plan interpretation] Task 2 verify command**
- `npm run lint -- src/components/ui/chat-message.tsx` lints the whole repository (about 8,650 pre-existing errors). I ran `npx eslint` on the file instead: 303 problems before and after my change, none from it.

**Total deviations:** 5 (2 blocking, 1 missing-critical, 2 interpretation)
**Impact on plan:** no scope creep beyond what the must-have truths need.

## TDD Gate Compliance
Task 1 has a `test(03-24)` commit (`e3aebb7`) then a `feat(03-24)` commit (`94e40fe`). RED at that commit: 14 of 23 route tests and 2 of 4 metadata tests failed on assertions (`expected "vi.fn()" to be called 1 times, but got 0 times`; response body missing `status` and `version`; `expected undefined to be defined` for the metadata write); the other tests passed as guards (legacy shape, 401/403 before ingest). `gsd_run check tdd-red-evidence` was not run: earlier plans found it returns INVALID_RED for vitest TAP output and `workflow.tdd_mode` is off. Assessment is manual. The two-tenant test was written after the implementation (verification, not part of RED).

## Issues Encountered
- `tests/rag/injection-scan.test.ts` ("scans hostile 1 MB inputs in under one second") failed once in the full run while other executors were loading the machine; it passes alone (45 of 45).
- `src/app/api/ai-to-rag/route.ts` has two lint errors in legacy code (`no-useless-catch`, unused `document`); pre-existing, left alone as the plan requires the legacy branch untouched.

## Gate Results (worktree /home/user/wt/03-24, branch exec/03-24)

| Gate | Result |
|------|--------|
| `npx next typegen && npx tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` | 136 files, 1858 tests; 1857 passed, 1 timing test failed under load and passed alone |
| `node --import tsx --test tests/*.test.mts` | 145 passed, 0 failed |
| `node scripts/ci/check-rag-boundary.mjs` | ok, 720 files |
| `python3 scripts/ci/check-workflows.py` | OK |
| `node scripts/check-config.mjs` | ok, 93 variables |
| rag-sidecar pytest | not run, untouched |
| `tests/rag/langfuse-pins.test.ts` | 15 passed, no ENOENT |

Acceptance: `grep -c "source: 'ai_to_rag'" route.ts` 1 (EXPECT >=1); `write-path-ai-to-rag.test.ts` 23 passed (EXPECT >=8); `grep -c organizationId chat-message.tsx` 3 (EXPECT >=1); `tests/rag/ai-to-rag-route.test.ts` 11 passed, file unchanged.

## Threat Surface
T-03-68/69: the unified and legacy branches share the session-derived owner and the 403 on a mismatching body userId; tests show ingest is never called in a refused case. T-03-70: membership is checked in resolveTenantScope before either branch writes; a non-member gets 403 against the real database with no row written. New: `options.documentMetadata` is a caller-controlled input to the document row; it is limited to scalar values, safe key names, 20 keys, 500 characters, and cannot set pipeline-owned keys.

## Known Stubs
None.

## User Setup Required
None. No new environment variable, migration or package.

## Next Phase Readiness
- 03-23, 03-31 and 03-33 can use `options.documentMetadata` and the `loadIngestConfig` export.
- The legacy branch stays listed in `LEGACY_WRITERS` for Phase 7.

## Self-Check: PASSED
All created files exist; commits `e3aebb7`, `94e40fe`, `c722fda` are ancestors of HEAD; the ledger count is 3.

---
*Phase: 03-unified-ingestion-embedding-profiles*
*Completed: 2026-11-24*
