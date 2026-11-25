---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 14
subsystem: embed-route
tags: [embed, tenant-scope, shared-assembly, widget-error, characterization]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: resolveEmbedScope (02-07), runRetrieval and the assembly stage (02-08, 02-09), unavailable message and status mapping (02-12), characterization fixture and route fixture (02-06, 02-13)
provides:
  - embed route that takes its tenant only from RAG_EMBED_TENANT and retrieves through runRetrieval({ profile: 'embed' })
  - 403 JSON for a body naming another workspace, localized unavailable error part for unconfigured, unknown or failed retrieval
  - chat.js widget branch that renders `type: 'error'` stream events with its generic message
  - regenerated embed characterization snapshot with a per-question equality check against the chat-format assembly
affects: [02-16, 02-18, 02-19]

requirements-completed: [PIPE-01, PIPE-03, PIPE-05, PIPE-06]

actuals:
  tokens: 8200
  tasks: 2
  commits: 2
plan_head_before: 0fe936443b3093711a15a2160c1969dad00decfd
plan_head_after: 728c1047717abc97d3b06fff09fc67a8d0168d31

tech-stack:
  added: []
  patterns:
    - "Entry route order: rate limit, raw body, resolveEmbedScope, schema parse, runRetrieval, status mapping, prompt"
    - "Embed errors use the chat wire format (createUIMessageStreamResponse with an error part) plus the CORS headers"

key-files:
  created:
    - tests/rag/embed-route.test.ts
    - tests/rag/embed-widget-error.test.ts
  modified:
    - src/app/api/embed/chat/route.ts
    - src/app/embed/chat.js/route.ts
    - tests/rag/characterize-embed.test.ts
    - tests/fixtures/characterization/embed.json
    - tests/rag/entrypoints-call-pipeline.test.ts

key-decisions:
  - "ragMode 'balanced' is passed to runRetrieval because the embed route selects no mode; it only affects refusalCandidate, which embed does not read. The prompt keeps the default strict wrapper, as before"
  - "isGPTModel uses the chat route's expression applied to the embed model id (gpt-4 / o1 / chatgpt substrings)"
  - "A 503 from resolveEmbedScope (organization lookup unavailable) is treated like the other unavailable cases: localized error part, no search. The plan only named 403 and retrieval_error"
  - "The unavailable message language comes from the first Accept-Language tag (en, zh, it, es supported, anything else falls back to en), because the embed body has no language field"
  - "An empty query still skips retrieval and leaves the context empty, as before"
  - "The widget shows its existing generic message for stream error events and never the server's errorText"

patterns-established:
  - "Embed route tests use the two-tenant route fixture, set RAG_EMBED_TENANT before loadRoute (env is read at module load), and install RAG deps overrides after loadRoute because loadRoute resets modules"

coverage:
  - id: D1
    description: "Embed tenant comes only from RAG_EMBED_TENANT; a body naming another workspace gets 403 JSON with no search, no model call and no RPC"
    requirement: PIPE-03
    verification:
      - kind: integration
        ref: "tests/rag/embed-route.test.ts (organizationId, workspaceId, tenant and personal-id mismatches; configured value accepted)"
        status: pass
  - id: D2
    description: "Configured organization or personal workspace sees only its own phrase in the prompt, never another tenant's"
    requirement: PIPE-03
    verification:
      - kind: integration
        ref: "tests/rag/embed-route.test.ts (two-tenant fixture, o:<O> and u:<A>)"
        status: pass
  - id: D3
    description: "Multi-tenant with RAG_EMBED_TENANT unset, an unknown organization, or a failing retrieval backend streams the localized unavailable error part, runs no search (unset case) and never reaches the model; no reason code or backend text reaches the client"
    requirement: PIPE-06
    verification:
      - kind: integration
        ref: "tests/rag/embed-route.test.ts (unset, language, unknown organization, RPC error)"
        status: pass
  - id: D4
    description: "For all 72 fixture questions the embed system prompt equals createEnhancedRAGPrompt(embed system prompt, chat-profile context)"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "tests/rag/characterize-embed.test.ts (per-question toBe plus regenerated snapshot)"
        status: pass
  - id: D5
    description: "The embed route calls runRetrieval with profile embed and a minted scope in single and multi-tenant mode; a mismatching body never reaches it"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/rag/entrypoints-call-pipeline.test.ts (embed block, 3 tests)"
        status: pass
  - id: D6
    description: "The widget script renders stream error events with the generic message and stops reading"
    requirement: PIPE-06
    verification:
      - kind: unit
        ref: "tests/rag/embed-widget-error.test.ts (script compiles, branch order, generic text, no server text echoed)"
        status: pass
      - kind: manual
        ref: "Live check in a browser: see Human verification"
        status: pending
  - id: D7
    description: "The five type errors in the embed route are gone"
    requirement: PIPE-05
    verification:
      - kind: unit
        ref: "npx tsc --noEmit | grep -c src/app/api/embed/chat/route.ts = 0; tsc-ratchet ok (40 errors)"
        status: pass

duration: 1 session
completed: 2026-11-23
---

# Phase 2 Plan 14: Embed Route on the Pipeline with a Configured Tenant Summary

**Embedded chat now searches only the workspace named by `RAG_EMBED_TENANT`, rejects request bodies that name another workspace with 403 before anything runs, retrieves through `runRetrieval({ profile: 'embed' })` with the shared chat-format assembly, streams a localized error when the knowledge base is unavailable, and the chat.js widget now displays those error events.**

## Performance

- **Tasks:** 2 of 2
- **Verification:**
  - `npx vitest run tests/rag/characterize-embed.test.ts tests/rag/embed-route.test.ts tests/rag/entrypoints-call-pipeline.test.ts`: 20 passed (embed-route: 11, entrypoints: 8, characterization: 1)
  - `npx vitest run tests/rag/embed-widget-error.test.ts`: 3 passed
  - `npx vitest run tests/rag`: 36 files, 488 tests passed
  - `npm run test-rag`: gate PASS
  - `npx next typegen && node scripts/ci/tsc-ratchet.mjs`: ok (40 errors); `tsc` reports 0 errors in `src/app/api/embed/chat/route.ts` (was 5)
  - Acceptance: `resolveEmbedScope` in the route >= 1, `from '@/lib/rag'` >= 1, `type === 'error'` in the widget route = 1

## Accomplishments

- Task 1 (1c7fe20): the route reads the raw JSON body after the rate-limit check and calls `resolveEmbedScope({ rawBody, configuredTenant: env.RAG_EMBED_TENANT, signal })` before `embedChatSchema.parse`. A 403 returns `{ error: 'Forbidden' }` JSON with the CORS header. Every other failure (unconfigured, unknown or invalid tenant, organization lookup unavailable) logs a `[Document Search]` line with the reason and streams the localized unavailable message as an error part. Otherwise it calls `runRetrieval` (embed profile, `maxResults` from `RAG_FINAL_RESULT_COUNT`, `fallbackToLowerThreshold`, `isGPTModel`, `webSearchEnabled: false`, the request signal and a trace collector) and calls `finishTrace`. Status `error`, or `degraded` without documents, streams the same unavailable error part; otherwise the prompt is built as before from the shared context. The inline per-chunk document and metadata lookups and the unused admin client import are gone.
- Task 2 (728c104): the `data:` branch of the widget's stream parser handles `parsed.type === 'error'`: it removes the loading dots, shows the existing generic message ("Sorry, I encountered an error. Please try again.") and stops, as the `3:` branch does. The server's `errorText` is never rendered.

## Intended behaviour changes

Snapshot diff (`tests/fixtures/characterization/embed.json`, 72 questions): **72 of 72 entries changed**. Every entry changes because the context format and the no-result text both differ. Breakdown:

1. **No-result text (23 entries, plus 1 new).** The old text `No relevant information found in the knowledge base for this query.` is now the shared `No relevant context found.` In total 24 questions end without context (23 before, 1 more because of category 3), and the prompt wrapper is applied to that text, as chat does.
2. **Chat format and GPT labels (48 entries with context).** The old layout (`--- Document: <name> (N relevant chunks) ---` group headers, raw chunk text) is replaced by chat's layout. For GPT model ids (the embed default `openai/gpt-4o-mini` is one) each chunk is rendered as `[Source: <document>]` followed by the chunk text, and the chunk order follows the chat assembly. Links from chunk metadata come from the same url-extractor section as chat.
3. **Relevance filter (2 entries lose chunks, 1 of them ends with no context).** Chat's post-filter (similarity above 0.65, document-name match, images above 0.25) now applies; the old embed route kept every retrieved chunk. 70 entries keep the same number of chunks, 2 have fewer.
4. **Image-document skip (1 entry).** An image document (`warehouse-floorplan.png`) that the old route listed as a text group is no longer listed in the context; images stay out of the cited text as in chat.
5. **Tenant scope.** Single-tenant output is the same corpus; multi-tenant embed searched `match_documents_by_workspace(null, null)` before (always empty) and now searches the configured workspace.
6. **Unavailable behavior (new).** Status `error`, or `degraded` with no documents, previously answered "No relevant information found" from the model; it now streams the localized unavailable error part. The widget shows its generic message for it.
7. **Wire format of errors from the retrieval path** uses the chat format (`data: {"type":"error",...}` then `[DONE]`) instead of the legacy `3:` line; the widget handles both.

The characterization test now asserts, for all 72 questions, `system === createEnhancedRAGPrompt(<embed default system prompt>, <context from runRetrieval profile chat with the same options>)` before comparing with the snapshot.

## Type errors fixed (5, all in src/app/api/embed/chat/route.ts)

- Four `string | undefined` arguments at the old chunk lookups (`chunk.document_id` / `chunk.chunk_id` passed to Supabase `eq` and the doc-name cache): removed with the inline lookups, which the shared assembly replaces.
- One `APIMessage[]` not assignable to `ModelMessage[]` at the `streamText` call: the route now builds `ModelMessage[]` directly (system message plus the request messages) and no longer routes through `ExtendedMessage` / `toAPIMessage`. No `any`, no suppressions.

## Deviations from Plan

**1. [Rule 2 - Missing critical] 503 from the scope resolver**
- **Found during:** task 1
- **Issue:** `resolveEmbedScope` can return `status: 503` (organization lookup unavailable). The plan mapped only 403 and `retrieval_error`.
- **Fix:** 503 takes the same path as `retrieval_error`: localized error part, no search, reason logged and not sent to the client.
- **Files:** `src/app/api/embed/chat/route.ts`

**2. [Test infrastructure] streamText fake returns no `toUIMessageStreamResponse`**
- The shared `createStreamTextCapture` fake only returns `toUIMessageStream`, so the embed route's response call would throw inside the route (the old characterization test passed anyway because it only inspected the captured call). The embed tests wrap `streamText` locally to add `toUIMessageStreamResponse`; the shared helper is untouched. The characterization test also dropped its obsolete `@/lib/thinking-rag-enhancer` mock, which the route no longer imports.

**3. [Plan note] Entry-point test placement**
- The embed describe block lives in `tests/rag/entrypoints-call-pipeline.test.ts` with per-test `vi.doMock`, as instructed. `src/lib/rag/index.ts` was not edited.

## Auth gates

None.

## Deferred Issues

- **Widget live behaviour.** The parser is inline in the sendMessage function of the served script and cannot be called standalone, so the test checks that the script compiles (`vm.Script`) and that the error branch, generic text and early return are present and ordered before the text-delta branch. The live rendering check is a human item (below).
- **Embed request language.** The unavailable message follows `Accept-Language` because the embed body carries no language. Widgets on pages whose browser language is not en/zh/it/es get English. A language field in the widget config would be a separate change.

## Human verification (for VERIFICATION.md)

- Load `/embed/chat.js` on a test page with `RAG_EMBED_TENANT` unset in a multi-tenant deployment, send a message, and confirm the bubble shows "Sorry, I encountered an error. Please try again." with the loading dots gone and no server reason text.
- With a valid `RAG_EMBED_TENANT`, confirm a normal answer still streams in the widget.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-02-35 (raw-body workspace check before Zod, 403 on mismatch, scope only from `RAG_EMBED_TENANT`: four mismatch cases plus the matching case in `embed-route.test.ts`), T-02-36 (unset multi-tenant embed fails closed with no edge call: test asserts zero recorded edge calls), T-02-37 (generic widget message, no reason code or backend text in the stream: tests assert `embed_tenant_unknown` and the RPC error text are absent from the body; the widget never reads `errorText`).

## Notes for later plans

- 02-19 can delete the old per-chunk helpers: the embed route no longer imports `enhanced-rag-retrieval`, `thinking-rag-enhancer`, `getSupabaseAdmin` or `formatURLsForContext`. `tests/rag/characterize-voice.test.ts` and `characterize-chat.test.ts` are untouched here.
- Embed trace tenant key is `scopeKey(scope)` with profile `embed`.

## Self-Check: PASSED

- Created files exist: `tests/rag/embed-route.test.ts`, `tests/rag/embed-widget-error.test.ts`.
- Commits 1c7fe20 and 728c104 are ancestors of HEAD; `git rev-list --count` from the plan base 0fe9364 is 2.
- STATE.md, ROADMAP.md, REQUIREMENTS.md and `src/lib/rag/index.ts` are untouched.
