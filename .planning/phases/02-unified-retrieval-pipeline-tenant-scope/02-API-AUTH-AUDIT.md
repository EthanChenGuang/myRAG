# Phase 2 — API route authentication and tenant-scope audit

Date: 2026-11-23. Scope: all 89 `route.ts` files under `src/app/api/`. Method: read-only code review; nothing was executed. Paths are relative to `src/app/api/` unless prefixed. ST = single-tenant, MT = multi-tenant.

## Summary

| Severity | Routes |
|---|---|
| critical | 8 (C2 already fixed) |
| high | 15 |
| medium | 9 |
| low | 16 |
| ok | 24 |
| skipped (no tenant data) | 17 |

Context that applies to every route:

- There is no API-wide gate: `src/proxy.ts` only refreshes the Supabase session, so each route must authenticate itself.
- ST row-level security gives anonymous users read access and signed-in users full access to `documents` and `document_chunks`. A service-role write without a session check is therefore a write open to the whole internet.
- `resolveTenantScope` returns `s:default` in ST without consulting the session. In ST it is not an authentication check.

Severity rubric:

- **critical:** read, write or delete of another tenant's data with no account (or with any account), or the leak of a credential that bypasses tenant isolation.
- **high:** the same class but needing one more condition, or unauthenticated actions on another user's connected account or on operator secrets.
- **medium:** unauthenticated change of operator-wide config or files, server-side calls to arbitrary hosts, or session tokens written to logs.
- **low:** limited by row-level security or by another check.

## Critical

| ID | Route | Exploit | Fix | Proving test |
|---|---|---|---|---|
| C1 | `config` GET/POST | `curl /api/config` (ST), or any signed-in user (MT), returns all of `.env.local`, including `SUPABASE_SERVICE_ROLE_KEY`. GET continues even when the auth check throws. POST rewrites any variable. | Verified admin in both modes; fail closed; never return secret-like names; POST takes only an allowlist of names. | `tests/api/config-route.test.ts` |
| C2 | `documents/[id]` DELETE/PATCH | Unauthenticated delete or edit of any document. | **FIXED** (session plus `resolveTenantScope`, 404 for a document that isn't yours). | `tests/rag/documents-route.test.ts` |
| C3 | `images` GET/DELETE | ST: `DELETE ?id=<any doc>` with no session. MT: the ownership branch is empty (lines 158-164). GET trusts `organization_id` without a membership check. | Session plus scope predicate on the lookup and the delete; image documents only; 404 when not owned; MT GET checks membership. | `tests/rag/images-route.test.ts` |
| C4 | `mcp/execute` | No auth, and `approved:true` in the body runs any MCP tool. No client calls this route. | Delete the route. | `tests/mcp/execute-route.test.ts` |
| C5 | `nango/connections` | `Authorization: Bearer <anything>` acts as the first `auth.users` row. POST attaches any `connectionId` without an owner check. DELETE revokes the victim's connection. | Remove every Bearer branch; POST requires Nango `end_user.id === user.id`; add `UNIQUE(connection_id)`. | `tests/nango/connections-route.test.ts` |
| C6-C8 | `nango/files`, `nango/folders`, `nango/notion/pages` | With no session, the route uses the first connected user's Drive, Dropbox or Notion. | No session gives 401; always filter `user_id = user.id`; delete the "admin view" fallback. | `tests/nango/browse-routes.test.ts` |

## High

| ID | Route | Exploit | Fix |
|---|---|---|---|
| H1, H2 | `admin/login`, `admin/settings` (plus medium `admin/check`, `admin/status`) | `userId` comes from the body; the `admin_session` cookie is the bare admin UUID, unsigned, so it can be forged. | Identity from `getUser()` only; check `is_admin(user.id)` on every request, or use an HMAC-signed cookie with an expiry; stop logging the Cookie header (`admin/status:29`). |
| H3 | `chat/approve` | No auth: anyone with a `toolCallId` can approve another user's pending tool call. | Require a session; record the owner's user id on the approval state; refuse non-owners with 404. |
| H4 | `tool-execution-state` | No auth, service role. `GET ?chat_id=0000…` returns stored tool params and results; PUT updates any field. | Session plus a chat-ownership check; allowlist the fields PUT may change. |
| H5 | `config/connectors` | An unauthenticated GET leaks other users' `connection_id` and folder names; PUT accepts any Authorization header. | Admin guard; return aggregate stats only. |
| H6 | `mcp/servers`, `mcp/servers/[id]`, `mcp/health` | With no auth and CORS `*`, these return `MCP_ZAPIER_ENDPOINT` (the URL carries the secret) and stored credentials, and allow adds and edits. | Admin guard on every method; return the host plus a `hasCredentials` flag only; remove CORS `*`. |
| H7 | `nango/session` | The `Bearer <anything>` branch mints a connect token for the first user. | Remove the Bearer branch. |
| H8 | `process-document`, `scrapers/crawl`, `scrapers/scrape` (ST) | Unauthenticated permanent writes into the shared KB. | Require a verified session for permanent ST writes. |
| H9 | `whatsapp/test`, `whatsapp/test-numbers` | No auth: sends messages from any WhatsApp session id. | Delete in production, or require an admin plus `session.userId === user.id`. |
| H10 | `whatsapp/webhook` | Verification is skipped when `WHATSAPP_WEBHOOK_SECRET` is unset, and it is unset by default. The comparison is `===` (`src/lib/whatsapp/koyeb-client.ts:386`, `flyio-client.ts:498`). | 503 in production when the secret is unset; `timingSafeEqual` over sha256 of both values. |

## Medium

- `config/models` and `config/rag-prompt`: unauthenticated writes to `.env.local`.
- `config/upload-favicon` and `config/upload-logo`: unauthenticated writes into `public/`.
- `mcp/servers/[id]/test`: unauthenticated call to a stored host with its credentials.
- `upload`: unauthenticated service-role writes to the public `chat-images` bucket, with a caller-chosen path.
- `whatsapp/monitor`: unauthenticated stop or reconnect of any session.
- `admin/check`: acts as an oracle for whether a UUID is an admin.
- `admin/status`: logs the Cookie header.

## Low

- `organizations/*` and `invites/[token]` use `getSession()`, which doesn't verify the claims; row-level security backs them up. Move to `getUser()`.
- On `members/[userId]`, an admin can grant `owner`.
- `nango/sync` updates `last_sync_at` keyed only by `connection_id`.
- The `generate-*` routes, `mcp/tools` and `config/reload` allow unauthenticated spend.
- The ST reads in `documents` and `scrapers/status` match the anonymous-read row-level-security design.
- The Polar webhook signature check is a stub; the handler is disabled. This becomes critical if the handler is re-enabled.
- The voice internal `x-api-key` uses `!==`, but the HMAC token check after it is constant-time.

## Webhooks

| Endpoint | Verification | Constant-time | Fails closed | Verdict |
|---|---|---|---|---|
| Stripe | `constructEvent` | yes | yes | ok |
| Polar | stub | n/a | no | low (disabled) |
| Nango | HMAC + `timingSafeEqual` | yes | yes | ok |
| WhatsApp | HMAC only if the secret is set | **no** (`===`) | **no** | high (H10) |
| Eval internal | sha256 + `timingSafeEqual` | yes | yes | ok |

## Plan coverage

- **Phase 2:** the pending plans 02-25..28 and 02-36 touch no API route.
- **Phase 3:**
  - 03-30 must build on the C2 fix and close C3. It currently says "keep today's authorization".
  - 03-33 depends on the C5 fix plus `UNIQUE(connection_id)`.
  - 03-23 and 03-31 leave H8 open in ST.
  - 03-07 adds `requireRagAdmin` but doesn't apply it to the routes above.
- **Not covered by any plan:** `config/*`, `mcp/*`, `chat/approve`, `tool-execution-state`, `nango/*` browse and session, `admin/*`, `whatsapp/test*`, `whatsapp/webhook`, `whatsapp/monitor`. These are scheduled as security gap fixes (see STATE.md).
