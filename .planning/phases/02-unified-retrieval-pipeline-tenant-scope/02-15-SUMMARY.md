---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 15
subsystem: voice-token
tags: [livekit, voice, tenant-scope, hmac, identity, canUpdateOwnMetadata, voice-busy]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: resolveTenantScope and mintVoiceToken (02-10)
provides:
  - "GET /api/livekit/token with session-verified scope, server-derived identity, fixed room myrag-voice and a signed voice RAG token in participant metadata"
  - "409 voice_busy when another user participant is in the room"
  - "Three voice frontends that send only organizationId"
affects: [02-16, 02-17, 02-18]

requirements-completed: [PIPE-04]

actuals:
  tokens: 14000
  tasks: 2
  commits: 3
plan_head_before: 5f1b090a5898aada34088458e5b3bfd961928efd
plan_head_after: dc22b0d532eb4f50a5464f9f2abb818a5c2212b6

tech-stack:
  added: []
  patterns:
    - "Route tests mock the SSR client, the deployment mode and RoomServiceClient (keeping the real AccessToken) and decode the issued JWT payload to assert sub, grant and metadata"

key-files:
  created:
    - tests/rag/livekit-token-route.test.ts
  modified:
    - src/app/api/livekit/token/route.ts
    - src/components/voice/voice-mode-container.tsx
    - src/components/voice/VoiceWidget.tsx
    - src/components/voice/voice-mode-overlay.tsx

key-decisions:
  - "The session user is read once in the route and handed to resolveTenantScope as getUser, so the identity uid and the scope user come from the same lookup; in single-tenant mode a session (if any) still names the identity while the scope stays s:default"
  - "Order in the route: LiveKit key/secret check (500), scope resolution (403/503), busy check (409), then mint; a non-member never reaches the room listing"
  - "Busy check treats any identity starting with user- as another user, including user-anon-; a missing LIVEKIT_URL or a listing failure logs one [LiveKit Token] warning and proceeds"
  - "Catch block returns a generic message instead of error.message"

patterns-established:
  - "Frontends compute the workspace as chat does (isMultiTenant, personal mode or no organization means none) and send only organizationId"

coverage:
  - id: D1
    description: "Identity from the session, caller username and room ignored, room fixed, signed token in metadata for personal, organization and single-tenant scopes, no token without a session in multi-tenant, short secret yields no metadata plus one [RAG Tenant] warning, no self metadata updates, 403 for a non-member, 409 voice_busy, 500 without LiveKit keys"
    requirement: PIPE-04
    verification:
      - kind: unit
        ref: "tests/rag/livekit-token-route.test.ts (12 tests)"
        status: pass
  - id: D2
    description: "Frontends no longer send username or room and pass organizationId only for a selected organization"
    requirement: PIPE-04
    verification:
      - kind: static
        ref: "grep username= in the three components prints 0; tsc reports no error under src/components/voice; npm run typecheck:new clean"
        status: pass

---

# Phase 2 Plan 15: LiveKit Token With Verified Scope Summary

**The LiveKit token route now issues tokens only for a server-derived identity and a verified workspace, carries the signed voice RAG token in participant metadata, forbids metadata self-updates, and refuses a second concurrent user.**

## Performance

- **Tasks:** 2 of 2 (Task 1 as RED then GREEN, Task 2 single commit)
- **Verification:**
  - `npx vitest run tests/rag/livekit-token-route.test.ts` 12 passed (plan required at least 9)
  - `npx vitest run` 42 files, 439 tests passed
  - `node --import tsx --test tests/rag-legacy-differential.test.mts` 5 passed; characterization snapshots unchanged (part of the full vitest run)
  - `npm run typecheck:new` reports no Phase 1 errors; tsc reports nothing under `src/components/voice/` or the livekit route
  - Acceptance greps: `mintVoiceToken` in the route 2, `canUpdateOwnMetadata: false` 1, `voice_busy` 1, `username=` in the three components 0, `organizationId` in voice-mode-container 1 or more

## Task Commits

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 RED | Route tests failing on assertions against the old route | e9ec246 |
| 1 GREEN | Token route with verified scope, server identity and voice token | e1e6d88 |
| 2 | Voice frontends send only organizationId | dc22b0d |

## Intended behaviour changes

- The token route requires a verified workspace: a non-member organizationId gets 403 and no token.
- The caller-supplied username and room are ignored; the server assigns `user-<uid>-<random>` (or `user-anon-<random>`) and the room is always myrag-voice.
- The participant can no longer replace its own metadata (`canUpdateOwnMetadata: false`).
- A second concurrent user is refused with 409 `voice_busy`; the frontends show "Voice is busy, try again in a moment".
- The response gains an `identity` field; the error body on failure is generic.

## Deviations from Plan

**1. [Rule 3 - Blocking] toast mechanism**
- **Issue:** the plan names sonner for the busy message, but no component in `src/` uses sonner and the only mounted toaster is the shadcn one (`@/components/ui/toaster`), so a sonner toast would never render.
- **Fix:** VoiceWidget and VoiceModeContainer use `toast` from `@/components/ui/use-toast` (destructive variant); VoiceModeOverlay uses its existing visible `error` state. Each ends the session as its error path already did (container calls `onEnd`, widget resets `shouldConnect`, overlay shows its error card).
- **Commit:** dc22b0d

**2. [Rule 2 - Hardening] Generic 500 body**
- The old catch returned `error.message`; the new one logs the message with a `[LiveKit Token]` prefix and returns a fixed string.

## Notes for the orchestrator and later plans

- **Owners without a membership row:** resolveTenantScope returns 403 for an organization owner who has no `organization_members` row (see 02-10 notes). I did not change the resolver. If such owners exist in production, a voice session with that organization selected will get 403 from this route (the frontends then simply have no token; the overlay and widget log the error). Backfill the owner rows or call the repair path in the chat route plan.
- A user reconnecting after an unclean disconnect can see 409 until LiveKit drops the stale participant; the frontends show the busy message.
- The `[RAG Tenant]` warning for a missing or short `RAG_VOICE_TOKEN_SECRET` is logged once per token request.
- Deploy order stays: voice agent (02-17) first, then the app.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-02-38 (server identity), T-02-39 (membership 403 before any token), T-02-40 (grant asserts canUpdateOwnMetadata false), T-02-41 (metadata carries only the signed claims; 409 busy) and T-02-42 (token still issued without a usable secret, one warning) are mitigated and covered by tests.

## Self-Check: PASSED

- tests/rag/livekit-token-route.test.ts and the four modified files exist.
- Commits e9ec246, e1e6d88 and dc22b0d are ancestors of HEAD.
