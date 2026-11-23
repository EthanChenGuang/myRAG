---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 10
subsystem: tenant-scope
tags: [tenant-scope, membership, embed-tenant, voice-token, hmac, fail-closed, two-tenant]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: branded TenantScope and mintScope (02-07), RAG_EMBED_TENANT / RAG_VOICE_TOKEN_SECRET / RAG_VOICE_TOKEN_TTL_SECONDS env entries (02-03), two-tenant fixture and fake edge (02-05), stage runner and trace (02-08)
provides:
  - isOrganizationMember (organization_members lookup, throws on query error)
  - resolveTenantScope for chat, media and LiveKit (D-08)
  - resolveEmbedScope and parseTenantKey (D-09)
  - mintVoiceToken / verifyVoiceToken / defaultVoiceTtlSeconds (D-10 token format)
  - resolveVoiceScope from the x-rag-scope-token header (D-10)
  - two-tenant integration test through the real SQL
affects: [02-11, 02-12, 02-13, 02-14, 02-15, 02-16, 02-17, 02-18, 02-20]

requirements-completed: [PIPE-02, PIPE-03, PIPE-04]

actuals:
  tokens: 15800
  tasks: 3
  commits: 6
plan_head_before: 7834482d853634736e056896ea48054c0b1875e1
plan_head_after: 9d9bdd86b26c0c766cb2d693b28887f61ccd1a22

tech-stack:
  added: []
  patterns:
    - "Resolvers take every dependency as an optional input (deploymentMode, getUser, admin, secret, now) and default to the real one, so unit tests assert Supabase calls without a client"
    - "Result shape follows the eval auth pattern: { ok: true, scope } or { ok: false, status, reason }; the embed resolver adds status 'retrieval_error' for the route to surface as stream status error"
    - "Ids are lowercased once at the resolver boundary so the scope key, the SQL arguments, the token claims and the logs agree"
    - "Logs are `[RAG Tenant]` with a reason (and hasToken for voice) only"

key-files:
  created:
    - src/lib/rag/tenant/membership.ts
    - src/lib/rag/tenant/resolve-chat.ts
    - src/lib/rag/tenant/embed.ts
    - src/lib/rag/tenant/voice-token.ts
    - src/lib/rag/tenant/voice.ts
    - tests/rag/resolve-chat-scope.test.ts
    - tests/rag/embed-scope.test.ts
    - tests/rag/voice-token.test.ts
    - tests/rag-two-tenant.test.mts
  modified:
    - src/lib/rag/index.ts

key-decisions:
  - "Ids are normalised to lowercase (after a UUID shape check) in all three resolvers; tests cover an uppercase organization id in chat, an uppercase configured embed tenant and uppercase claims in a signed voice token"
  - "Chat: a no-session caller gets { ok: true, scope: null, reason: 'no_tenant' } before the body is looked at, so a malformed or foreign organizationId cannot be probed anonymously; no log line is written for it (anonymous WhatsApp calls would spam)"
  - "Chat personal means organizationId undefined, null, '' or 'null'; every other non-UUID value (including the string 'undefined') is 403 invalid_organization"
  - "Embed: s:default is refused in multi-tenant mode (embed_tenant_invalid) because a single scope would call the global match_document_chunks; o:/u: in single-tenant mode is also embed_tenant_invalid"
  - "Embed: body workspace keys are checked in both deployment modes and before the organization existence query; any named organizationId, workspaceId or tenant that differs from the configuration (including non-string values) is 403 workspace_mismatch; null, '', 'null' and absent count as not named"
  - "Embed: an existence-query error or missing admin client is 503 embed_tenant_unavailable (not embed_tenant_unknown), so a database outage is not reported as a missing organization"
  - "Voice: an organization token must carry a uid, because the membership re-check needs a verified user; a token with uid null for an organization is 401 bad_scope"
  - "Voice: the token kind must match the deployment mode (s:default only in single-tenant; o:/u: only in multi-tenant), otherwise 401 mode_mismatch"
  - "Voice token: a missing/short secret on verify is 503 secret_not_configured (no token details are inspected); everything else wrong with a token is 401 with reasons malformed, bad_signature, bad_version, bad_audience, expired, issued_in_future; tokens over 4096 characters are rejected before hashing"
  - "Membership and organization lookups call .abortSignal(signal) before .maybeSingle(): the postgrest types do not expose abortSignal after maybeSingle, and the order is equivalent at runtime"

patterns-established:
  - "Fake Supabase for membership: records table, select columns, eq filters and the signal, then answers from an in-memory list; asserts the number of calls"

coverage:
  - id: D1
    description: "Chat scope: single-tenant gives s:default; multi-tenant takes the user from the session only; body organization needs a membership row; non-member and malformed ids get 403; no session gives no_tenant; query error gives 503"
    requirement: PIPE-02
    verification:
      - kind: unit
        ref: "tests/rag/resolve-chat-scope.test.ts (20 tests)"
        status: pass
  - id: D2
    description: "On the two-tenant fixture each resolved scope retrieves only its tenant's chunk through the real SQL, user B cannot obtain organization O, and a null scope issues no RPC"
    requirement: PIPE-02
    verification:
      - kind: integration
        ref: "node --import tsx --test tests/rag-two-tenant.test.mts (6 tests)"
        status: pass
  - id: D3
    description: "Embed scope comes only from RAG_EMBED_TENANT; multi-tenant unset fails closed; a differing raw body workspace gets 403; a configured organization that does not exist fails closed"
    requirement: PIPE-03
    verification:
      - kind: unit
        ref: "tests/rag/embed-scope.test.ts (46 tests)"
        status: pass
  - id: D4
    description: "Voice tokens are HMAC-SHA256 compact JSON with the D-10 claims; secrets under 32 characters refused; forged, wrong-audience, wrong-version, expired and future-dated tokens rejected; scope only from a valid token with a live membership"
    requirement: PIPE-04
    verification:
      - kind: unit
        ref: "tests/rag/voice-token.test.ts (49 tests)"
        status: pass
---

# Phase 2 Plan 10: Tenant Resolvers (Chat, Embed, Voice) Summary

**Every way of obtaining a `TenantScope` outside eval is now a server-verified resolver: session plus membership for chat, `RAG_EMBED_TENANT` for embed, and an HMAC-signed token with a membership re-check for voice, with the two-tenant fixture proving isolation through the real SQL.**

## Performance

- **Tasks:** 3 of 3, each as a RED commit (failing on assertions against a stub export) then a GREEN commit
- **Files:** 9 created, 1 modified (`src/lib/rag/index.ts`, exports appended only)
- **Verification:**
  - `npx vitest run` passes (41 files, 427 tests; `tests/rag` 13 files, 204 tests)
  - `node --import tsx --test tests/rag-two-tenant.test.mts` passes (6 tests)
  - `node --import tsx --test tests/rag-legacy-differential.test.mts` still passes (5 tests); characterization snapshots unchanged
  - `npm run typecheck:new` reports no Phase 1 errors
  - Acceptance greps: `organization_members` in membership.ts (1), `embed_tenant_unconfigured` in embed.ts (4), `timingSafeEqual` in voice-token.ts (1), `x-rag-scope-token` in voice.ts (1)

## Accomplishments

- Task 1 (RED 8e83e7d, GREEN 5d49777): `isOrganizationMember` and `resolveTenantScope`. A verified session user plus a found `organization_members` row is the only route to an org scope. The two-tenant test resolves scopes with a fake `getUser` and the real admin client against the fake edge, then calls `runRetrieval`: A personal sees only chunk A, A in O only chunk O (also with an uppercase id), B personal only chunk B, B requesting O gets 403 after exactly one edge call, and a null scope returns `empty/no_tenant` with no RPC.
- Task 2 (RED 63a7284, GREEN 51b3213): `parseTenantKey` and `resolveEmbedScope`. The raw body is inspected before any database call.
- Task 3 (RED 7721d75, GREEN 9d9bdd8): `mintVoiceToken`, `verifyVoiceToken` (SHA-256 digests of the provided and recomputed signature compared with `timingSafeEqual`) and `resolveVoiceScope`. Test secrets come from `crypto.randomBytes`.

## Task Commits

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 RED | Chat scope and two-tenant tests against a stub resolver | 8e83e7d |
| 1 GREEN | Chat scope with verified organization membership | 5d49777 |
| 2 RED | Embed scope tests against a stub resolver | 63a7284 |
| 2 GREEN | Embed scope from server configuration | 51b3213 |
| 3 RED | Voice token and voice scope tests against stubs | 7721d75 |
| 3 GREEN | Voice RAG token and voice scope resolution | 9d9bdd8 |

## Contracts for the route plans (02-12..02-18)

- `resolveTenantScope({ requestedOrganizationId, signal })` returns `{ ok: true, scope }` (scope may be `null` with `reason: 'no_tenant'`; pass it straight to `runRetrieval`) or `{ ok: false, status: 403 | 503, reason }` which the route must return as JSON before streaming. Reasons: `not_a_member`, `invalid_organization`, `membership_unavailable`, `auth_unavailable`, `invalid_user`.
- `resolveEmbedScope({ rawBody, configuredTenant: env.RAG_EMBED_TENANT, signal })` must be given the parsed-but-unvalidated request JSON (before `embedChatSchema`). `status: 403` is an HTTP 403; `status: 'retrieval_error'` is surfaced as stream status error; `status: 503` is HTTP 503.
- `mintVoiceToken({ scope, secret: env.RAG_VOICE_TOKEN_SECRET })` (TTL defaults to `RAG_VOICE_TOKEN_TTL_SECONDS` through `defaultVoiceTtlSeconds`). `{ ok: false, reason: 'secret_not_configured' }` means the LiveKit route must not issue a RAG token (multi-tenant callers then get 401 on every voice-rag call, as D-10 specifies).
- `resolveVoiceScope({ headers: req.headers, signal })` reads `x-rag-scope-token`; 401 missing/bad/expired/forged, 403 revoked membership, 503 secret or membership unavailable.
- The Supabase default for `admin` is `getRagDeps().adminClient()` (tests inject their own); `deploymentMode` defaults to `getDeploymentMode()`.

## Intended behaviour changes

- None reachable yet: no route calls these resolvers until plans 02-12..02-18.

## Deviations from Plan

**1. [Rule 3 - Blocking] `.abortSignal()` before `.maybeSingle()`**
- **Issue:** the plan writes `.maybeSingle().abortSignal(signal)`, but the postgrest types return a builder without `abortSignal` after `maybeSingle()`, so `npm run typecheck:new` failed on membership.ts and embed.ts. The call worked at runtime (the two-tenant test passed against the real client).
- **Fix:** swapped the order in both places and in the three test fakes. The acceptance grep (`organization_members`) is unaffected.
- **Commit:** 9d9bdd8

**2. [Rule 2 - Hardening] Embed `s:default` refused in multi-tenant mode**
- The plan does not cover this case. A single scope in multi-tenant mode would run the global `match_document_chunks`, so it is `embed_tenant_invalid`. Tested.
- **Commit:** 51b3213

**3. [Rule 2 - Hardening] Embed 503 for lookup failure; voice organization token needs a uid; token kind must match deployment mode**
- Listed under key-decisions; all three fail closed and are tested.
- **Commits:** 51b3213, 9d9bdd8

**4. [Id handling] Lowercasing**
- Ids were not lowercased before this plan (`mintScope` accepts either case and keeps it). The resolvers lowercase after the UUID check so `o:<id>` keys and token claims are canonical. `mintScope` itself is unchanged, so eval and any caller that mints directly keep their current behaviour.

## Notes for later plans

- An organization owner who has no `organization_members` row is refused with 403. `verifyUserOrganizationAccess` repairs such rows lazily; this resolver follows the plan and does not. If owners without a row exist in production, the chat route plan (02-12) should call that repair first or the owner row should be backfilled.
- The `[RAG Tenant]` log line for a 403/503 carries only the reason. The route plans should not add ids to their own logs either.
- The LiveKit route (plan with D-10) must derive the identity server-side and never grant `canUpdateOwnMetadata` (see 02-RESEARCH).

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-02-21 (membership check, 403, fail closed), T-02-22 (embed scope from configuration, raw body check, unconfigured fails closed), T-02-23 (HMAC, 32-character secret, constant-time compare, aud/v/exp/iat, membership re-check), T-02-24 (digest comparison) and T-02-25 (reason-only logs, asserted in tests) are mitigated and tested.

## Self-Check: PASSED

- All 9 files under key-files.created exist.
- Commits 8e83e7d, 5d49777, 63a7284, 51b3213, 7721d75 and 9d9bdd8 are ancestors of HEAD.
