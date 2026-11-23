---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 12
subsystem: chat-route
tags: [chat, runRetrieval, resolveTenantScope, status-mapping, owner-membership-repair, prompt-rehome, sentinel]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: runRetrieval, stage statuses and trace collector (02-08), assembleContext and the `referenced` option (02-09), resolveTenantScope (02-10), eval route on the pipeline and entry-point spy test (02-11)
provides:
  - src/app/api/chat/route.ts retrieves through runRetrieval({ profile: 'chat' }) with a server-verified scope
  - createEnhancedRAGPrompt re-homed to src/lib/rag/generation/prompt.ts (static rag-mode import)
  - knowledgeBaseUnavailableMessage (en, zh, it, es; English fallback)
  - repairOwnerMembership (owner row backfill before the membership check)
  - installChatPipeline test helper (routes the vector RPC and assembly lookups through the chat fakes)
affects: [02-13, 02-14, 02-16, 02-18]

requirements-completed: [PIPE-01, PIPE-02, PIPE-05, PIPE-06]

actuals:
  tokens: 52000
  tasks: 3
  commits: 4
plan_head_before: 63dbafbbb91cf43d3439141d594d7f3ef7ddad14
plan_head_after: 5098c42e179f8f75434a27c7945fe5e89778e5e9

tech-stack:
  added: []
  patterns:
    - "Route-level tests that need a per-test module graph use vi.doMock after vi.resetModules(); a top-level vi.mock factory is cached across resetModules and keeps the first graph's env snapshot and rag deps instance"
    - "The route memoizes the session lookup once and hands it to both repairOwnerMembership and resolveTenantScope as getUser"

key-files:
  created:
    - src/lib/rag/generation/prompt.ts
    - src/lib/rag/generation/messages.ts
    - src/lib/rag/tenant/repair-owner.ts
    - tests/rag/prompt.test.ts
    - tests/rag/chat-status.test.ts
    - tests/rag/repair-owner.test.ts
  modified:
    - src/app/api/chat/route.ts
    - src/lib/rag/index.ts
    - tests/helpers/chat-route-fakes.ts
    - tests/chat-strict.test.ts
    - tests/chat-websearch.test.ts
    - tests/chat-source-images.test.ts
    - tests/rag/entrypoints-call-pipeline.test.ts
    - tests/legacy-post-filter-sentinel.test.ts

key-decisions:
  - "The owner-without-member-row case from 02-10 is handled in the route, not in resolveTenantScope: repairOwnerMembership calls the existing verifyUserOrganizationAccess (which upserts the owner row only when organizations.owner_id equals the session user), then resolveTenantScope decides as before. A non-owner non-member is still 403 and no row is written (tested)"
  - "retrievalFailed (error, or degraded without used documents) is ignored when RAG is effectively disabled (ragMode bypass), because bypass never uses the context"
  - "The refusal condition accepts status empty or no pipeline result (the no-query-text overview path stays on its legacy behaviour until 02-13)"
  - "The route's own CHANGE 4 document filter is skipped when the pipeline produced the result (assemble already applied the same filter); it still runs for the no-query-text path"
  - "precomputedSourceImages comes from RetrievalResult.sourceImages when the pipeline ran"
  - "generation is recorded as a stage in the trace from the stream onFinish, and finishTrace runs once per request (early refusal, error stream, stream finish, or an error path)"

patterns-established:
  - "Status mapping in the chat route: empty gives the strict refusal; error, or degraded with no documents, gives one { type: 'error', errorText } UI-stream part in the request language; degraded with documents answers normally"

coverage:
  - id: D1
    description: "Chat scope is resolved before the RAG branches; non-member and malformed organization get 403 JSON, membership error 503, no stream and no retrieval"
    requirement: PIPE-02
    verification:
      - kind: unit
        ref: "tests/rag/chat-status.test.ts (chat route tenant scope, 8 tests); tests/rag/entrypoints-call-pipeline.test.ts (chat describe, 2 tests)"
        status: pass
  - id: D2
    description: "An organization owner without a membership row gets 200 with the org scope and the row is backfilled; a non-owner non-member stays 403 with no write"
    requirement: PIPE-02
    verification:
      - kind: unit
        ref: "tests/rag/chat-status.test.ts (owner and non-owner cases); tests/rag/repair-owner.test.ts (10 tests)"
        status: pass
  - id: D3
    description: "Status mapping: empty refuses; error and degraded-without-documents stream the localized error part and log under [Document Search]; degraded with documents answers"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/rag/chat-status.test.ts (status mapping, 6 tests)"
        status: pass
  - id: D4
    description: "Chat output is byte-identical: the 144 characterization snapshots and the strict, websearch and source_images tests keep their behavioural assertions"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/rag/characterize-chat.test.ts (2 tests, 144 cases); tests/chat-strict.test.ts; tests/chat-websearch.test.ts; tests/chat-source-images.test.ts"
        status: pass
  - id: D5
    description: "Prompt builder re-homed with identical output; unavailable messages are distinct per language"
    requirement: PIPE-06
    verification:
      - kind: unit
        ref: "tests/rag/prompt.test.ts (23 tests); node --import tsx --test tests/prompt-context.test.mts (4 tests)"
        status: pass
  - id: D6
    description: "The sentinel guards src/lib/rag/context/assemble.ts and parity still holds with chat on the pipeline"
    requirement: PIPE-05
    verification:
      - kind: integration
        ref: "tests/legacy-post-filter-sentinel.test.ts (19 tests); tests/rag-assemble-differential.test.mts (3 tests); npm run test-rag -- --out eval/out/parity-chat then jq: passed true, paired.all_zero true"
        status: pass

duration: 1 session
completed: 2026-11-23
---

# Phase 2 Plan 12: Chat Route on the Pipeline Summary

**Text chat now resolves a server-verified tenant scope before any branch, retrieves and assembles through `runRetrieval({ profile: 'chat' })`, refuses only on a verified empty result, reports retrieval outages as a localized error part, and reads the workspace prompt from the verified organization, with the 144 chat snapshots unchanged.**

## Performance

- **Tasks:** 3 of 3 (task 1 as a RED commit then a GREEN commit)
- **Verification:**
  - `npx vitest run` passes (48 files, 538 tests)
  - `node --import tsx --test tests/rag-assemble-differential.test.mts` passes (3 tests); `tests/prompt-context.test.mts` passes (4 tests)
  - `npm run test-rag -- --out eval/out/parity-chat`: gate PASS, `passed == true`, `paired.all_zero == true`
  - `npx next typegen && node scripts/ci/tsc-ratchet.mjs` reports ok (58 errors, 59 files improved)
  - Acceptance greps: `createEnhancedRAGPrompt` in prompt.ts, `from '@/lib/rag'`, `resolveTenantScope` and `knowledgeBaseUnavailableMessage` in the chat route; `tests/rag/prompt.test.ts` 23 passed, `tests/rag/chat-status.test.ts` 14 passed

## Accomplishments

- Task 1 (RED 1287386, GREEN bb019ab): the builder is copied verbatim with a static `@/lib/rag-mode` import (the `{{context}}` handling is untouched). 18 equality cases (3 base prompts x 3 modes x 2 contexts) plus bypass, unknown mode, default mode and the message cases. RED failed on assertions against stub exports.
- Task 2 (f35db62): scope resolution sits right after the Supabase client check, before the WhatsApp overrides and the disableRAG branch. The inline semantic-search block (organization lookup from the body, SSR user, `enhancedRetrieveChunks`, the N+1 document and chunk lookups, Filter 1, context assembly) is replaced by one `runRetrieval` call that receives the document-reference state as `referenced`. The document-reference code and the no-query-text overview stay for 02-13. `RetrievalOptions.referenced` and its pass-through to `assembleContext` already existed from 02-09, so `types.ts` and `pipeline.ts` needed no change.
- Task 3 (5098c42): the sentinel keeps its literal checks against `assemble.ts` (and the isGPTModel, maxResults and refusal literals against the route), pins the route's `normalize()` helper, the assemble query-term helpers and the `filterCandidates`/`buildContext` bodies, and its failure message names the differential test and the chat snapshots.

## Intended behaviour changes

- A retrieval error, or a runtime-degraded result with no used documents, now streams a localized "knowledge base temporarily unavailable" error part (and logs under `[Document Search]`) instead of the strict refusal.
- A non-member or malformed `organizationId` in multi-tenant mode now gets HTTP 403 JSON (503 when the membership query fails) before any stream, instead of retrieving that organization's results.
- The workspace system-prompt override is read for the verified organization, not the body value.
- An organization owner with no `organization_members` row is no longer refused: the row is backfilled first (fixes the 02-10 note).
- In multi-tenant mode with no session (anonymous WhatsApp calls), retrieval returns `empty/no_tenant` and the strict refusal applies as before.

## Deviations from Plan

**1. [Rule 2 - Missing critical functionality] Owner membership backfill**
- **Found during:** task 2 (instruction from the dispatcher, from 02-10 notes)
- **Fix:** new `src/lib/rag/tenant/repair-owner.ts` (`repairOwnerMembership`, exported from the barrel, append-only) wrapping the existing `verifyUserOrganizationAccess`; called in the route before `resolveTenantScope`. Tests: owner without a row gets 200 and the row appears; non-owner non-member gets 403 and no row; existing member needs no write; unit tests for the guard conditions.
- **Commit:** f35db62

**2. [Test adaptation] retrieval call count in chat-strict**
- `expect(h.retrieval).toHaveBeenCalledTimes(1)` counted calls to the old `enhancedRetrieveChunks` stub; the pipeline's vector RPC is also called by the legacy low-threshold fallback when the first search is empty, so the stub is called twice. The assertion now checks the stub was called and that the first call is `match_document_chunks`. All behavioural assertions are unchanged.
- **Commit:** f35db62

**3. [Plan file list] `src/lib/rag/types.ts` and `pipeline.ts` unchanged**
- `referenced` was already in `RetrievalOptions` and passed to the assembly by 02-09.

**4. [Test infrastructure] `tests/helpers/chat-route-fakes.ts`**
- Added `abortSignal` passthrough and `upsert` to the Supabase fake (the pipeline and the owner repair call them) and `installChatPipeline`. The `retrievalWith`/`emptyRetrieval` shapes are unchanged, so the three chat tests kept their seeds.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-02-28 (scope resolved before any branch, 403 before streaming, streamText never called: tested), T-02-29 (workspace settings read with the verified organization only: tested), T-02-30 (refusal only on empty; error and degraded-empty stream an error part: tested). The new repair path writes a membership row only when the database says `owner_id` equals the session user.

## Notes for later plans

- 02-13 still owns the inline document-reference block, the `@mention` lookups and the no-query-text overview (it still calls `match_document_chunks` through the admin client without a tenant predicate). The dead `enhancedRetrieveChunks` and `enhanceQueryWithReasoning/intelligentSearch` imports remain in the route for that plan.
- Chat tests that need a per-test module graph must use `vi.doMock` after `vi.resetModules()`; a top-level `vi.mock('@/lib/rag', factory)` keeps the first graph.

## Self-Check: PASSED

- All files under key-files.created exist (prompt.ts, messages.ts, repair-owner.ts, prompt.test.ts, chat-status.test.ts, repair-owner.test.ts).
- Commits 1287386, bb019ab, f35db62 and 5098c42 are ancestors of HEAD; `git rev-list --count` from the plan base is 4.
