---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 31
subsystem: whatsapp
tags: [typescript, whatsapp, tsc-ratchet, vitest, webhook-signature, i18n]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: plan 02-01 tsc ratchet gate and vitest setup
provides:
  - App-side WhatsApp code (clients, routes, two UI components) with zero tsc errors
  - Koyeb sendMedia implementation
  - Webhook route that rejects bad signatures with 401 for both providers
  - Six status-modal translation keys in en, zh, es
affects: [02-unified-retrieval-pipeline-tenant-scope tsc ratchet baseline]

actuals:
  tokens: 7600
  tasks: 2
  commits: 4
plan_head_before: e308307fe9a17df0009fbdc60faacadf928e2603
plan_head_after: f292eb0662e54227da0a1cb3336b450565228f8f

tech-stack:
  added: []
  patterns:
    - "toBlobPart helper in base-client.ts copies Buffer/ArrayBuffer into a Uint8Array<ArrayBuffer> for Blob parts"
    - "Route tests mock env, logger, Supabase clients and the provider factory; the webhook test uses the real Koyeb client with a placeholder secret"

key-files:
  created:
    - tests/whatsapp/clients.test.ts
    - tests/whatsapp/routes.test.ts
  modified:
    - src/lib/whatsapp/base-client.ts
    - src/lib/whatsapp/koyeb-client.ts
    - src/lib/whatsapp/flyio-client.ts
    - src/lib/whatsapp/webhook-handler.ts
    - src/app/api/whatsapp/connect/route.ts
    - src/app/api/whatsapp/conversations/route.ts
    - src/app/api/whatsapp/webhook/route.ts
    - src/components/ui/whatsapp-connection-button.tsx
    - src/translations/en.ts
    - src/translations/zh.ts
    - src/translations/es.ts

key-decisions:
  - "Webhook route calls the base-class validateWebhookSignature(signature, body) rather than adding verifyWebhookSignature to the base client; both providers implement the former, only Fly.io had the latter"
  - "Base sendTextMessage return type widened to { messageId; status } to match both providers, so test-numbers reads the real status field without a route change"
  - "Conversations DELETE uses the awaited SSR client (RLS delete policy plus explicit user_id filter) rather than the admin client"

patterns-established:
  - "Abstract provider methods return the widest shape every provider actually returns"

requirements-completed: [PIPE-01]

coverage:
  - id: D1
    description: "src/lib/whatsapp, src/app/api/whatsapp and the two WhatsApp UI components have zero tsc errors"
    requirement: PIPE-01
    verification:
      - kind: other
        ref: "npx tsc --noEmit -p tsconfig.json --pretty false | grep -cE '^src/(lib/whatsapp|app/api/whatsapp|components/ui/whatsapp-)' == 0; node scripts/ci/tsc-ratchet.mjs ok (208 errors, 9 files improved)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Koyeb provider can send media; webhook handler reconciles a connected session"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/whatsapp/clients.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "connect, conversations, test-numbers and webhook routes behave as intended (auth, ownership, signature rejection)"
    requirement: PIPE-01
    verification:
      - kind: unit
        ref: "tests/whatsapp/routes.test.ts"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-11-23
---

# Phase 02 Plan 31: WhatsApp app-side type errors and revealed bugs Summary

App-side WhatsApp code now type-checks with zero errors (23 before), and six live bugs the errors exposed are fixed and covered by 17 passing vitest tests.

## Accomplishments

- Task 1 (clients, webhook handler): typed auth headers as `Record<string, string>`, converted Buffer/ArrayBuffer to Blob-safe `Uint8Array` via `toBlobPart`, narrowed `options.body` before `.includes`, narrowed a catch variable, and implemented `KoyebWhatsAppClient.sendMedia` mirroring the Fly.io implementation against the Koyeb endpoint.
- Task 2 (routes, UI, translations): fixed the connect, conversations and webhook routes, replaced the nonexistent `toast.info`, and added the six status-modal keys in en (fallback for every language), zh and es.
- Ratchet: `npx next typegen && node scripts/ci/tsc-ratchet.mjs` reports ok, 208 errors, 9 files improved. The baseline file was not edited.
- TDD: both tasks have a RED commit (failing on assertions or the missing method) followed by a GREEN commit.

## Intended behaviour changes

| Area | Before | After |
| --- | --- | --- |
| Webhook route (`POST /api/whatsapp/webhook`) | Called `verifyWebhookSignature`, which exists only on the Fly.io client. On Koyeb, or for any signature that reached the call, it threw a TypeError that the outer catch turned into HTTP 200 `{ success: false }`. A bad signature was never rejected with 401 and the event was never processed. | Calls `validateWebhookSignature(signature, rawBody)` on the base client. A bad or missing signature returns 401 and the handler is not invoked; a correct HMAC returns 200 and the event is processed. (T-02-79) |
| Connect route, existing-session branch | `user` was out of scope in the catch block, so a `SESSION_EXISTS` error raised ReferenceError and the caller got an unhandled failure instead of the 409 with the existing session. | The authenticated user id is captured before the try-body can throw; the branch looks up the existing session for that user and returns 409 with it. |
| Conversations GET and DELETE | `createClient()` was not awaited, so `.auth` was read off a Promise; every call threw and returned 500, and DELETE additionally referenced an undefined `supabase`. | The SSR client is awaited. Unauthenticated requests return 401 without touching the database (T-02-80). GET lists the user's conversations; DELETE removes a conversation through the SSR client with `id` and `user_id` filters. |
| Koyeb provider `sendMedia` | Abstract method not implemented; `sendMedia` was undefined on the Koyeb provider. | Implemented with the same payload shape as Fly.io (image, video, audio, document by MIME type). |
| Webhook handler status reconciliation | Compared `status.connected`, a field the status type does not have, so the branch that marks a session connected when the provider reports it connected never ran. | Uses `status.isConnected`; a DB session marked disconnected is updated to connected when the provider says so. |
| Connection button | `toast.info` does not exist in react-hot-toast; the existing-session notice would throw. | Plain `toast(...)` call. |
| Status modal | Six translation keys were missing from the key type, so users saw the raw key (the `|| 'fallback'` text was unreachable for a truthy key echo). | Keys exist in en, zh, es; other languages fall back to English through `t()`. |
| Base `sendTextMessage` type | Declared `{ messageId }`; both providers return `{ messageId, status }`. | Declared `{ messageId; status }`; test-numbers keeps returning `status` with no route edit. |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Webhook route failed open instead of rejecting a bad signature**
- **Found during:** Task 2 (RED test returned 200 for a bad signature)
- **Issue:** The type error was a live security bug, as described above.
- **Fix:** Switched the route to `validateWebhookSignature`, implemented by both providers.
- **Files modified:** src/app/api/whatsapp/webhook/route.ts
- **Commit:** f292eb0

**2. [Rule 1 - Bug] Plan described the webhook handler bug as a never-run "disconnected" branch**
- **Found during:** Task 1
- **Issue:** The unreachable code was actually the reconnect reconciliation (provider reports connected while DB says otherwise). The comparison was also redundant after the outer `status !== 'connected'` guard, which tsc flagged once the field was corrected.
- **Fix:** Use `status.isConnected` and drop the redundant inner comparison. Tests cover both the connected and disconnected provider responses.
- **Files modified:** src/lib/whatsapp/webhook-handler.ts
- **Commit:** d92042b

**3. [Rule 3 - Blocking] test-numbers route needed no edit**
- **Issue:** The plan lists it for editing, but its error came from the base `sendTextMessage` return type being narrower than what providers return.
- **Fix:** Widened the base type (src/lib/whatsapp/base-client.ts); route untouched, behaviour covered by a test.
- **Commit:** f292eb0

**Total deviations:** 3, all within the plan's intent. Auto-mode and the baileys-whatsapp/ service were not touched.

## Known Stubs

None.

## Threat Flags

None. T-02-79 (webhook spoofing) and T-02-80 (conversations auth) are mitigated and tested; the signature compare remains the existing non-constant-time string equality in both providers (unchanged, out of scope).

## Verification

- `npx vitest run tests/whatsapp`: 17 passed, 0 failed (6 in clients.test.ts, 11 in routes.test.ts)
- `npx tsc --noEmit -p tsconfig.json --pretty false | grep -cE '^src/(lib/whatsapp|app/api/whatsapp|components/ui/whatsapp-)'`: 0
- `npx next typegen && node scripts/ci/tsc-ratchet.mjs`: ok

`commits: 4` counts the task commits (two RED, two GREEN) measured before this SUMMARY commit.

## Self-Check: PASSED

- tests/whatsapp/clients.test.ts, tests/whatsapp/routes.test.ts: found
- Commits 411859e, d92042b, 28fbab5, f292eb0: ancestors of HEAD
