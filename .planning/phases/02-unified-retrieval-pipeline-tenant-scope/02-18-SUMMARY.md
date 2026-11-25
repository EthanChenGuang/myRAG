---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 18
subsystem: media-retrieval
tags: [media, generate-image, generate-video, tenant-scope, runRetrieval, rag_status]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: runStage, StageRecord, trace ownership (02-08); assembly stages and profile split (02-09); resolveTenantScope (02-10)
provides:
  - "formatImageContext and formatVideoContext re-homed from the two routes into src/lib/rag/context/media.ts"
  - "media profile in the pipeline: embed, search (count 10, threshold 0.3, admin client through vectorSearch), assemble (formatter chosen by options.mediaKind)"
  - "generate-image and generate-video reading the knowledge base only through resolveTenantScope plus runRetrieval({ profile: 'media' })"
affects: [02-19, 02-20, 02-21]

requirements-completed: [PIPE-01, PIPE-02, PIPE-06]

actuals:
  tokens: 12000
  tasks: 2
  commits: 3
plan_head_before: cf070c3
plan_head_after: 9bcfc738682da3d67567f36e6893f5db974c964a

tech-stack:
  added: []
  patterns:
    - "A profile with its own stage list is a separate function in pipeline.ts reached from one early branch in runPipeline (media here), so profiles added by parallel plans do not touch each other's code"
    - "Route tests mock the SSR session, the deployment mode, the provider SDKs and the Supabase client, inject a fake admin client (membership plus RPC filtered by owner) through setRagDepsForTests, and assert the prompt the provider mock received"

key-files:
  created:
    - src/lib/rag/context/media.ts
    - tests/rag/media-context.test.ts
    - tests/rag/media-routes.test.ts
    - tests/rag/entrypoints-call-pipeline.test.ts
  modified:
    - src/lib/rag/pipeline.ts
    - src/lib/rag/types.ts
    - src/app/api/generate-image/route.ts
    - src/app/api/generate-video/route.ts
    - tests/rag/stage-runner.test.ts

key-decisions:
  - "The media pipeline runs embed, search, assemble only (no analyze, legacy_rank or post_filter), so single-tenant RPC arguments and the context text stay what the routes produced before"
  - "Both routes resolve the scope right after request validation and before source-image uploads or any provider call, so a non-member organizationId gets 403 with nothing started; retrieval itself runs at the old context site"
  - "The routes do not pass a trace collector: runRetrieval then owns the trace and writes the single [RAG Trace] line itself. Creating a collector in a route needs the tenant key, and scopeKey lives in the tenant module that routes may not import"
  - "rag_status is the RetrievalResult status ('ok', 'empty', 'degraded', 'error') and is present only when retrieval was attempted; an anonymous multi-tenant caller reports 'empty' (reason no_tenant, no RPC)"
  - "organizationId is read from the JSON body, and from the multipart form for the image route; a non-string value is refused by the resolver (403 invalid_organization)"

patterns-established:
  - "Media callers treat empty context as no context; error and degraded results are logged under [Document Search] with { status, reason } and generation continues"

coverage:
  - id: D1
    description: "Image and video context formatting equals the old inline code for seeded row sets (single document, several documents with empty and whitespace content, 4000-character truncation, integer-like document ids), plus the media profile RPC shapes: single scope issues match_document_chunks with count 10 and threshold 0.3 on the admin client, personal issues the workspace RPC with (null, uid), org passes the organization, no scope runs nothing, embed failure is an error result"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/rag/media-context.test.ts (19 tests)"
        status: pass
  - id: D2
    description: "Both routes: single-tenant provider prompt contains exactly today's context; two-tenant isolation (A sees only A, B only B, org member sees only the organization, no single-tenant RPC in multi-tenant); anonymous multi-tenant gets no context and no RPC; non-member organizationId gets 403 before the provider and the RPC; retrieval error is logged and generation continues; no retrieval without useContext"
    requirement: PIPE-06
    verification:
      - kind: unit
        ref: "tests/rag/media-routes.test.ts (13 tests)"
        status: pass
  - id: D3
    description: "Both media routes call runRetrieval with profile media, the right mediaKind and a minted scope, and not at all without useContext"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/rag/entrypoints-call-pipeline.test.ts (3 tests)"
        status: pass
  - id: D4
    description: "Type errors in generate-image fixed; no new type errors"
    requirement: PIPE-01
    verification:
      - kind: other
        ref: "npx next typegen && node scripts/ci/tsc-ratchet.mjs (ok, 54 errors, 60 files improved); tsc reports 0 diagnostics for generate-image, generate-video and src/lib/rag"
        status: pass

duration: "1 session"
completed: 2026-11-23
---

# Phase 2 Plan 18: Media routes on the pipeline Summary

Image and video generation now take their knowledge-base context only through `runRetrieval({ profile: 'media' })` with a verified tenant scope, closing the admin-client `match_document_chunks` leak in both routes.

## Commits

| Step | Description | Commit |
|------|-------------|--------|
| Task 1 RED | Media context and media profile tests against stub formatters | 5488769 |
| Task 1 GREEN | Formatters, media profile in the pipeline | 877303c |
| Task 2 | Both routes on the pipeline, route and entry-point tests | 9bcfc73 |

## What was built

- `src/lib/rag/context/media.ts`: `formatImageContext` (group by document, top 3 by similarity, trim, `\n---\n` joins, 4000-character cut) and `formatVideoContext` (contents joined by a space), copied verbatim from the routes. The image final-prompt template stays in the image route.
- `runMediaPipeline` in `src/lib/rag/pipeline.ts`, reached by one branch in `runPipeline`: embed (core), search (core, `vectorSearch(scope, embedding, 10, 0.3, { client: admin })`), assemble (optional). Status derives from the candidate count; failures map to the same reasons as the other profiles. `options.mediaKind` added to `RetrievalOptions`.
- Image route: scope resolved after validation, retrieval at the old context site, inline embedding, RPC and grouping deleted, `rag_status` added to the response, the type fixes (see below).
- Video route: `getDocumentContext` deleted, same scope handling, `rag_status` added to the success body.
- `tests/rag/stage-runner.test.ts`: `media` removed from the "overrides ignored for other profiles" loop (media has no `legacy_rank` stage); the same property is asserted for media in `media-context.test.ts`.

## Intended behaviour changes

- Multi-tenant media context is narrowed to the caller's workspace (personal or verified organization); it used to search every user's personal documents through the admin client.
- Anonymous multi-tenant callers get no context; generation still runs.
- `rag_status` is added to the image and video JSON responses when retrieval was attempted.
- A non-member `organizationId` gets 403 (503 if membership cannot be checked) before any upload or generation.
- generate-image type fixes: `generatedUrls` is typed `(string | null)[]` (it is filtered afterwards), and the two untyped callback parameters disappeared with the deleted inline loops (four errors in total, now zero).

Single-tenant output is unchanged: same RPC, arguments, grouping, ordering and truncation, asserted against copies of the old inline code.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Existing override test treated media as a legacy-path profile**
- **Found during:** Task 1 GREEN (full tests/rag run)
- **Issue:** `tests/rag/stage-runner.test.ts` ran `media` through the chat path and expected a `legacy_rank` record; the media profile has its own stage list and uses the admin client.
- **Fix:** removed `media` from that loop; added an equivalent media assertion (overrides ignored, assemble still runs) to `media-context.test.ts`.
- **Files modified:** tests/rag/stage-runner.test.ts, tests/rag/media-context.test.ts
- **Commit:** 877303c

**2. [Plan interpretation] No route-owned trace collector**
- The plan text passes `trace` and says "call finishTrace". Routes cannot build a collector without the tenant key (`scopeKey`, internal to the tenant module), so the routes let `runRetrieval` own the trace; it writes exactly one `[RAG Trace]` line via `finishTrace` (02-08 contract: the owner of the collector finishes it).

**3. [Plan interpretation] `src/lib/rag/index.ts` not changed**
- Nothing outside the pipeline needs the formatters (routes use `result.context`); tests import `context/media` directly. This also avoids touching the file plan 02-16 edits.

## Known Stubs

None.

## Threat Flags

None beyond the register. T-02-51 (admin RPC replaced by runRetrieval with a verified scope; two-tenant route tests) and T-02-52 (membership check, 403 before generation; tests for both routes) are mitigated and tested.

## Notes for later plans

- Neither frontend caller (`src/components/ui/chat-input.tsx` image and video fetches) sends `organizationId` to these routes yet, so in multi-tenant mode a user working inside an organization gets personal-workspace context. A follow-up should pass the selected organization, as the voice frontends do after 02-15. Not done here because the plan's file list excludes the component.
- The chat route's internal call to generate-image does not set `useContext`, so it is unaffected.
- Parallel plans: `pipeline.ts` gained one import line, one early branch in `runPipeline` and one function placed before `runRetrieval`; `tests/rag/entrypoints-call-pipeline.test.ts` is created here with its own describe block and also by 02-11 (expect an add/add merge; keep both describe blocks and merge the `vi.mock('@/lib/rag')` wrapper, which is pass-through).

## Verification

- `npx vitest run`: 47 files, 515 tests pass.
- Legacy differential, assemble differential and two-tenant `.mts` suites: 14 pass.
- `npx next typegen && node scripts/ci/tsc-ratchet.mjs`: ok (54 errors, 60 files improved); `npm run typecheck:new`: clean.
- Acceptance greps: both routes import `@/lib/rag` (1 each); video route has 0 `.rpc(` lines outside comments; image route has 0.

## Self-Check: PASSED

- Files exist: src/lib/rag/context/media.ts, tests/rag/media-context.test.ts, tests/rag/media-routes.test.ts, tests/rag/entrypoints-call-pipeline.test.ts.
- Commits 5488769, 877303c and 9bcfc73 are ancestors of HEAD.
