---
last_mapped_commit: 41a47818ac26f9ea788ccb18230fb3351065c2a2
last_mapped_at: 2026-11-22
---
<!-- refreshed: 2026-11-22 -->
# Codebase Concerns

**Analysis Date:** 2026-11-22

## Tech Debt

**Build-time type checking disabled:**
- Issue: TypeScript errors do not fail the build. `ignoreBuildErrors: true` lets `npm run build` succeed with type errors.
- Files: `next.config.js`
- Impact: Type regressions reach production silently. The ~830 explicit `any` uses in `src/` (e.g. `src/app/api/chat/approve/route.ts`, `src/app/api/chat/route.ts`) further weaken the type system.
- Fix approach: Set `ignoreBuildErrors: false`, run `npx tsc --noEmit` in CI, then burn down errors file by file. Tighten `@typescript-eslint/no-explicit-any` from `warn` to `error` for `src/app/api/**` first (`eslint.config.mjs`).

**Oversized mega-components and route files:**
- Issue: Several files concentrate unrelated responsibilities.
- Files: `src/components/ui/chat-message.tsx` (~5,800 lines), `src/components/ui/chat-input.tsx` (~5,055), `src/app/page.tsx` (~4,994), `src/app/api/chat/approve/route.ts` (~4,823), `src/app/api/chat/route.ts` (~4,544), `src/components/ui/sidebar.tsx` (~2,738), `src/lib/title-generator.ts` (~2,278), `src/components/ui/mcp-tool-box.tsx` (~2,262)
- Impact: High merge-conflict rate, slow review, and risky edits. Regex-based content parsing (e.g. `highlightDocumentMentions` and email extraction in `src/app/page.tsx`) is duplicated across components.
- Fix approach: Extract parsing helpers into `src/lib/` modules and split chat routes into per-concern handlers (classification, RAG retrieval, tool approval, streaming). Move the regex parsers into one shared, unit-tested module.

**Duplicated Supabase admin client construction:**
- Issue: Each admin route builds its own lazily initialized service-role client with `let adminClient: any = null`.
- Files: `src/app/api/admin/login/route.ts`, `src/app/api/admin/settings/route.ts`, `src/app/api/admin/status/route.ts`, `src/app/api/admin/check/route.ts`, `src/app/api/config/connectors/route.ts`, `src/app/api/generate-image/route.ts`, `src/app/api/generate-video/route.ts`, `src/app/api/generate-3d/route.ts`, `src/app/api/process-document/route.ts`
- Impact: Inconsistent auth and error handling. Several copies bypass RLS on every call, so the risk is multiplied.
- Fix approach: Consolidate into one `src/lib/supabase` server helper with explicit, named usage for service-role access only where needed.

**Console-based logging at scale:**
- Issue: About 2,270 `console.log` calls under `src/`, many logging user identifiers, emails, and admin decisions (e.g. `src/app/api/admin/login/route.ts` logs email and userId on every attempt).
- Files: `src/app/api/admin/login/route.ts`, `src/app/api/admin/settings/route.ts`, `src/lib/logger.ts`
- Impact: Log spam in production, PII in logs, and noisy diagnostics. `src/lib/logger.ts` suppresses only DEBUG outside development, so most calls still ship.
- Fix approach: Route all server logging through `src/lib/logger.ts` and strip per-request `console.log` from hot paths (chat, RAG retrieval).

**Empty catch blocks:**
- Issue: Roughly a dozen `catch {` blocks in `src/` swallow errors.
- Files: `src/lib/scrapers/scraper-adapter.ts`, `src/lib/scrapers/url-utils.ts`, `src/lib/whatsapp/flyio-client.ts`, `src/app/api/nango/folders/route.ts`, `src/app/api/generate-video/route.ts`, `src/app/page.tsx`, `src/components/ui/chat-input.tsx`
- Impact: Failures become silent, making RAG and integration bugs hard to diagnose.
- Fix approach: Log at minimum at `logger.warn` level, and return a structured error where the caller needs to react.

**Unfinished feature stubs:**
- Issue: Explicit TODOs mark incomplete behavior.
- Files: `src/app/api/organizations/[id]/invites/route.ts` (line ~250, invitation email is never sent), `src/app/api/images/route.ts` (line ~159, granular org permissions missing), `src/components/ui/chat-input.tsx` (line ~767, MCP tool detection not implemented), `src/lib/polar.ts` (line ~54, see Security).
- Impact: Invites are created without notification, so invitees depend on out-of-band delivery. Permission checks for images are coarser than intended.
- Fix approach: Track each as an issue; for invites, wire `RESEND_API_KEY` delivery (`scripts/init-env.js` already defines it).

## Known Bugs

**Admin session derived from a client-supplied user ID:**
- Symptoms: The admin login cookie `admin_session` is set to the raw `userId` from the request body. Settings and status routes verify only that the cookie value is an admin ID, not that the caller controls it.
- Files: `src/app/api/admin/login/route.ts`, `src/app/api/admin/settings/route.ts`, `src/app/api/admin/status/route.ts`
- Trigger: Any client that knows an admin's UUID can POST `{ email, userId }` to `/api/admin/login` and receive a valid admin cookie. See Security Considerations.
- Workaround: None in code. Treat as a vulnerability.

**Module-level rate limiter resets per instance:**
- Symptoms: Embed rate limits are not enforced across serverless instances or restarts.
- Files: `src/lib/embed-rate-limit.ts` (in-memory `Map`, comment says "use Redis or similar"), `src/lib/mcp/production-router.ts` (`toolCache` Map), `src/lib/mcp-cache.ts`
- Trigger: Traffic spread over multiple Vercel function instances, which `vercel.json` (`regions: iad1`) does not prevent.
- Workaround: Use a Supabase-backed or Redis-backed counter.

**Incomplete AI-service timeouts in the chat route:**
- Symptoms: Long model or tool calls can hang the request until the platform limit (`vercel.json` sets `maxDuration: 60` for `src/app/api/**/*.ts`).
- Files: `src/app/api/chat/route.ts` (no `AbortSignal.timeout` or `timeout:` usage found), `src/app/api/chat/approve/route.ts`
- Trigger: Slow upstream model provider or stalled MCP server.
- Workaround: None; add per-call `AbortSignal.timeout(...)` around provider and MCP fetches.

## Security Considerations

**OAuth client secret readable through public RLS policy:**
- Risk: `connector_config` has an `oauth_client_secret` column, and its read policy `connector_config_read` is `USING (true)`. Any client holding the public anon key can read the secret column straight from Supabase.
- Files: `supabase/single-tenant-setup.sql` and `supabase/multi-tenant-setup.sql` (`connector_config` definition and `connector_config_read` policy), `src/app/api/config/connectors/route.ts`
- Current mitigation: The unauthenticated `GET /api/config/connectors` route runs `select('*')` but maps each row to non-secret fields before responding (lines ~150-170), so the API itself does not return the secret. Nothing mitigates direct table reads.
- Recommendations: Rotate any OAuth client secret stored in this table. Replace the `USING (true)` read policy with an admin-only policy, or move secrets to a separate table with no public read policy. Narrow the route's `select('*')` to the columns it uses.

**Config Tool endpoints write `.env.local` without authentication:**
- Risk: Anonymous callers can modify secrets and runtime configuration on the server's filesystem.
- Files: `src/app/api/mcp/servers/route.ts` (POST writes `.env.local` via `fs.writeFileSync`, around line 137), `src/app/api/config/upload-logo/route.ts` (POST writes uploaded files with `writeFile`), `src/app/api/config/reload/route.ts` (POST, comment: "Skip admin authorization"), `src/app/api/config/get-env/route.ts` (reads `.env.local` in development)
- Current mitigation: `get-env` restricts names to `NEXT_PUBLIC_*` and `RAG_SYSTEM_PROMPT`. Nothing else is enforced on the write routes.
- Recommendations: Gate all `/api/config/*` and `/api/mcp/servers` writes behind the admin session check used in `src/app/api/admin/settings/route.ts`, or disable them in production (`NODE_ENV === 'production'`). Validate the upload MIME type and size in `upload-logo`.

**Connector PUT accepts any Authorization header in production:**
- Risk: `PUT /api/config/connectors` only checks that the `authorization` header is present when `NODE_ENV === 'production'`. Any non-empty value passes, so the connector config can be altered by unauthenticated callers.
- Files: `src/app/api/config/connectors/route.ts` (PUT, comment: "In production, this should validate the token properly")
- Current mitigation: Header presence check only.
- Recommendations: Verify the token with `supabase.auth.getUser()` and an admin role check.

**Polar webhook signature verification is a no-op:**
- Risk: Forged Polar webhooks can grant subscriptions or entitlements in production.
- Files: `src/lib/polar.ts` (`verifyPolarWebhookSignature` returns `true` in development and, after parsing the header, always in production; line ~54 TODO), consumed by `src/app/api/webhooks/route.ts`
- Current mitigation: Only checks that the signature header splits into two parts.
- Recommendations: Implement HMAC-SHA256 verification against `POLAR_WEBHOOK_SECRET` with timing-safe comparison and a timestamp tolerance, following the Nango implementation in `src/lib/nango/client.ts` (`verifyWebhookSignature`).

**Unauthenticated API routes that spend paid provider credits:**
- Risk: Anonymous callers can trigger paid generation and scraping jobs using server-side API keys (`OPENAI_API_KEY`, `REPLICATE_API_TOKEN`, `FAL_API_KEY`, `FIRECRAWL_API_KEY`, `EXA_API_KEY`).
- Files: `src/app/api/generate-image/route.ts`, `src/app/api/generate-video/route.ts`, `src/app/api/generate-3d/route.ts`, `src/app/api/web-search/route.ts`, `src/app/api/extract-name/route.ts`, `src/app/api/title/route.ts`, `src/app/api/mcp/execute/route.ts` (executes arbitrary MCP tools with no auth check), `src/app/api/mcp/servers/[id]/test/route.ts`, `src/app/api/whatsapp/test/route.ts`, `src/app/api/audio/route.ts`
- Current mitigation: Unknown for most; `middleware` (`src/proxy.ts`) only refreshes Supabase sessions and does not enforce auth.
- Recommendations: Require an authenticated Supabase user (or a server-side shared key) on every route that calls a paid provider or executes tools. Add per-user rate limits.

**Internal Voice API key comparison and exposure:**
- Risk: `src/app/api/internal/voice-rag/route.ts` and `src/app/api/internal/voice-chat/route.ts` authenticate with a shared secret (`MYRAG_INTERNAL_API_KEY`). The voice-agent key sits in `voice-agent/.env.example` with an example value in a key-like format.
- Files: `src/app/api/internal/voice-rag/route.ts`, `src/app/api/internal/voice-chat/route.ts`, `voice-agent/.env.example`
- Current mitigation: Equality check against `env.MYRAG_INTERNAL_API_KEY`, which is good, but not constant-time, and `voice-chat` shows no check in the same pattern.
- Recommendations: Use `crypto.timingSafeEqual`. Confirm `voice-chat` is protected. Replace the example value with an obvious placeholder such as `replace-me`.

**Permissive RLS on connector configuration:**
- Risk: Non-admin users can read all connector configuration rows, including OAuth client IDs and secrets (see first entry above).
- Files: `supabase/multi-tenant-setup.sql` (`connector_config_read`, `connector_feature_settings_read`)
- Current mitigation: Writes are limited to `auth.jwt()->>'role' = 'admin'`. Note that this checks a JWT claim named `role`, which Supabase user tokens do not set by default for app admins; verify how admin status is minted.
- Recommendations: Split secrets into a separate table with no read policy for non-service roles. Keep only display fields in the public-read table.

**Admin check reads the JWT claim not app metadata:**
- Risk: Admin authorization in the SQL policies depends on `auth.jwt()->>'role'`, while the API routes use an `is_admin` RPC against `admin_users`. The two can disagree, and a mismatch could either lock out admins or grant access where it should not.
- Files: `supabase/multi-tenant-setup.sql`, `src/app/api/admin/login/route.ts` (calls RPC `is_admin`)
- Current mitigation: None documented.
- Recommendations: Use one source of truth (`admin_users` via `is_admin()`) in both RLS and routes.

**Client-side HTML rendering of message content:**
- Risk: Chat text is injected with `dangerouslySetInnerHTML` after regex substitution, without an HTML sanitizer. Model output containing HTML or attributes could execute script in the user's session.
- Files: `src/components/ui/chat-message.tsx` (lines ~3931 and ~5050, `highlightDocumentMentions` output), `src/components/ui/code-block.tsx` (line ~60), `src/app/page.tsx` (line ~4536), `src/app/client-layout.tsx` (lines ~84, ~244, ~387), `src/app/embed/window/page.tsx`
- Current mitigation: The `highlightDocumentMentions` function builds spans from captured names without escaping. No DOMPurify or equivalent is applied to these paths (`src/app/globals.css` and `src/components/ui/sidebar.tsx` match only on generic `sanitize` names).
- Recommendations: HTML-escape captured text before inserting spans, or render mentions as React elements instead of HTML strings. Sanitize any model-derived HTML with DOMPurify.

**Artifact preview executes model-generated HTML:**
- Risk: The artifact sidebar extracts `<script>` and `<style>` from generated HTML (`src/components/ui/artifact-sidebar/utils/file-extractors.ts`) for preview. If the preview renders in the app origin, model output runs with the user's session.
- Files: `src/components/ui/artifact-sidebar/utils/file-extractors.ts`, `src/components/ui/artifact-sidebar/utils/preview-generators.ts`, `src/app/embed/chat.js/route.ts`
- Current mitigation: Unknown from static review; confirm whether previews use a sandboxed iframe with `sandbox` and no `allow-same-origin`.
- Recommendations: Render previews only in a sandboxed iframe on a separate origin, without `allow-same-origin`.

**Embed origin headers are wide open:**
- Risk: `/embed/*` is framable from any origin, and the embed chat endpoint is reachable cross-origin.
- Files: `vercel.json` (`Content-Security-Policy: frame-ancestors *` and `X-Frame-Options: ALLOWALL` for `/embed/(.*)`), `src/app/api/embed/chat/route.ts`, `src/app/api/config/openrouter-model-info/route.ts`, `src/app/api/config/models/route.ts`, `src/app/api/config/rag-prompt/route.ts` (all send `Access-Control-Allow-Origin: *`)
- Current mitigation: Embed rate limiting, in memory only (see Known Bugs).
- Recommendations: Restrict `frame-ancestors` to an allow-list of customer domains. Remove wildcard CORS from `/api/config/*` (the config routes are admin tooling).

**Config dashboard binds all interfaces:**
- Risk: `scripts/config-server.js` calls `server.listen(PORT)` with no host, which listens on every network interface on port 3333. The dashboard can write `.env.local` and manage admin users.
- Files: `scripts/config-server.js` (`PORT = 3333`, `server.listen`, around line 3591)
- Current mitigation: None.
- Recommendations: Bind to `127.0.0.1` explicitly, e.g. `server.listen(PORT, '127.0.0.1')`.

**Stripe and Nango webhook fallbacks:**
- Risk: `src/lib/stripe.ts` and `src/app/api/webhooks/stripe/route.ts` depend on `STRIPE_WEBHOOK_SECRET`. If unset, behavior depends on the fallback path, which was not fully traced.
- Files: `src/app/api/webhooks/stripe/route.ts`, `src/lib/stripe.ts`
- Current mitigation: Signature check via Stripe SDK when the secret is set.
- Recommendations: Fail closed (return 500) when the webhook secret is missing.

**Secret-named env vars in the example template:**
- Risk: `scripts/init-env.js` contains default placeholder definitions for many secrets (`SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`, `NANGO_SECRET_KEY`, `GITHUB_CLIENT_SECRET`, etc.). Values are generated into `.env.local`, which is gitignored, so this is low risk as long as the template keeps empty defaults.
- Files: `scripts/init-env.js`, `.gitignore` (`.env*.local`, `.env`)
- Current mitigation: Gitignore covers `.env*.local` and `.env`.
- Recommendations: Confirm `scripts/init-env.js` ships empty values for all secret keys. Add a pre-commit secret scanner.

## Performance Bottlenecks

**Large synchronous file operations in config routes:**
- Problem: `.env.local` is read and rewritten synchronously on each MCP server change.
- Files: `src/app/api/mcp/servers/route.ts` (`fs.writeFileSync`, `fs.readFileSync`)
- Cause: Synchronous I/O in a request handler blocks the event loop.
- Improvement path: Use `fs/promises` and serialize writes with a mutex to prevent concurrent overwrites.

**Regex-heavy rendering on every chat message:**
- Problem: `chat-message.tsx` runs several regex passes (`highlightDocumentMentions`, link scanning with `linkRegex.exec` in a loop, approval pattern detection) on each render.
- Files: `src/components/ui/chat-message.tsx` (lines ~109-120, ~191, ~2763, ~4144)
- Cause: No memoization of parsed output; the component is very large so re-renders are expensive.
- Improvement path: Memoize parsed segments with `useMemo` keyed on content, and scope streaming updates to the last message (AGENTS.md guardrail: scope effects to streaming and prefer `useShallow`).

**Unbounded in-memory caches:**
- Problem: Caches grow without size caps.
- Files: `src/lib/mcp/production-router.ts` (`toolCache`), `src/lib/mcp-cache.ts`, `src/lib/openrouter.ts`, `src/lib/chat-store.ts`
- Cause: Module-level `Map` objects with TTL but no max-size eviction.
- Improvement path: Add an LRU limit (e.g. `lru-cache`) and cap entry counts.

**Full-table reads in the connectors endpoint:**
- Problem: `GET /api/config/connectors` loads every `nango_connections` row (provider, user_id, status) for the whole platform and returns them.
- Files: `src/app/api/config/connectors/route.ts` (lines ~82-92)
- Cause: No pagination or aggregation in the database.
- Improvement path: Aggregate counts with SQL `GROUP BY` through an RPC instead of transferring rows.

## Fragile Areas

**Chat streaming and tool-approval pipeline:**
- Files: `src/app/api/chat/route.ts`, `src/app/api/chat/approve/route.ts`, `src/lib/mcp/production-router.ts`, `src/lib/mcp/query-classifier.ts`
- Why fragile: Approval state, tool IDs, and streamed tokens are coordinated across two routes and a server-side cache. Pattern-based detection (`src/lib/mcp/query-patterns`) and string-matched tool-call IDs (e.g. the `call_XXXX` pattern comment in `src/app/api/chat/route.ts` line ~4413) are brittle against provider format changes.
- Safe modification: Change approval payloads only with matching edits to both routes and the MCP cache. Keep tool IDs and schemas consistent (AGENTS.md section 10).
- Test coverage: No test files are tracked in the repository (see Test Coverage Gaps).

**Duplicated model registry across five locations:**
- Files: `.env.local`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, `scripts/config-ui/index.html` (three fallback arrays)
- Why fragile: AGENTS.md section 7 requires synchronized edits in five places. Drift is likely and silent.
- Safe modification: Make one module the source of truth and generate the others, or add a check script that diffs the arrays.
- Test coverage: None.

**RAG prompt placeholder contract:**
- Files: `src/lib/rag/*` (prompt building), `scripts/rag/decode-rag-prompt.js`, `src/app/api/config/rag-prompt/route.ts`
- Why fragile: `RAG_SYSTEM_PROMPT` must keep the `{{context}}` placeholder (AGENTS.md section 6). Nothing validates this at save time except `src/app/api/config/system-prompts/validate/route.ts`, which is itself unauthenticated.
- Safe modification: Run `node scripts/rag/check-rag-flow.js` after any prompt change.
- Test coverage: Diagnostics only, not automated.

**Multi-tenant versus single-tenant SQL:**
- Files: `supabase/multi-tenant-setup.sql` (2,000+ lines, 23 tables, 23 RLS enablements), `supabase/single-tenant-setup.sql` (19 RLS enablements, 17 tables), `src/app/api/config/route.ts` (`isSingleTenant()` branches auth)
- Why fragile: Two schemas and code paths that branch on `isSingleTenant()`. Auth checks in `src/app/api/config/route.ts` catch and continue on error ("to avoid breaking local dev"), so the multi-tenant path can fail open.
- Safe modification: Make the auth catch block fail closed in multi-tenant mode before adding new branches.
- Test coverage: None.

**Voice agent audio pipeline:**
- Files: `voice-agent/src/agent.ts` (LiveKit, VAD, audio mutex), `voice-agent/src/voice_agent.ts` (~960 lines), `src/components/voice/voice-mode-overlay.tsx`, `src/lib/audio-utils.ts` (~1,164 lines)
- Why fragile: AGENTS.md section 14 documents recent fixes to timing and resampling. Timestamp fallbacks (estimated timings when Resemble fails) and the 48kHz resampling path have no automated tests.
- Safe modification: Preserve the three-dot state until word timings are ready. Test resampling with fixed fixtures before changing it.
- Test coverage: None tracked.

**Baileys WhatsApp fork:**
- Files: `baileys-whatsapp/` (vendored Baileys, including generated `baileys-whatsapp/WAProto/index.js` ~165,000 lines and `baileys-whatsapp/src/WAM/constants.ts` ~15,000 lines), `src/lib/whatsapp/session-manager.ts`, `src/lib/whatsapp/webhook-handler.ts`
- Why fragile: Vendored protocol code diverges from upstream and is regenerated from protos. Session persistence depends on Supabase writes.
- Safe modification: Do not hand-edit `WAProto/`; regenerate from `baileys-whatsapp/proto-extract`.
- Test coverage: `scripts/whatsapp/tests/` exists but is not wired into `package.json` scripts.

## Scaling Limits

**In-memory embed rate limiting:**
- Current capacity: Per-process `Map`, cleared every 5 minutes.
- Limit: Enforcement is per Vercel instance. Total throughput scales with instance count.
- Scaling path: Move the counter to Supabase or Redis.

**Serverless timeout on chat and generation routes:**
- Current capacity: `vercel.json` sets `maxDuration: 60` seconds for all `src/app/api/**/*.ts`.
- Limit: Long RAG plus multi-model streaming, and video/3D generation polling, can exceed 60 seconds. Generation routes (`src/app/api/generate-video/route.ts`, `src/app/api/generate-3d/route.ts`) poll external services.
- Scaling path: Use background jobs or Supabase-backed status polling with short requests.

**Vector search index parameters:**
- Current capacity: 1536-dimension embeddings with HNSW `m=64`, `ef_construction=200` (AGENTS.md section 6).
- Limit: Index build time and memory grow with `document_chunks` size; these parameters are not tuned against a measured corpus size.
- Scaling path: Benchmark recall and latency at target corpus size before raising parameters.

## Dependencies at Risk

**Next.js and React pins:**
- Risk: `next` 16.0.10 and `react` 19.2.1 are pinned in `package.json` alongside the React Compiler (`reactCompiler: true` in `next.config.js`). Compiler and Turbopack behavior changes often between minor releases.
- Impact: Build or runtime regressions on upgrade.
- Migration plan: Upgrade in a dedicated branch with the build-error suppression removed (see Tech Debt) so type regressions surface.

**Vercel AI SDK 6.0.3:**
- Risk: Pre-stable major version with frequent API changes; central to streaming chat.
- Impact: Streaming chat and tool-call handling in `src/app/api/chat/route.ts`.
- Migration plan: Pin exactly, and add a streaming smoke test before each upgrade.

**Baileys and WhatsApp protocol:**
- Risk: Unofficial WhatsApp client protocol that breaks when WhatsApp changes its protocol.
- Impact: WhatsApp sessions stop working; `src/lib/whatsapp/provider factory` depends on Fly.io or Koyeb deployment of the service.
- Migration plan: Track upstream Baileys releases; keep provider health checks (`src/app/api/whatsapp/status/route.ts`) alerting.

## Missing Critical Features

**Automated test suite:**
- Problem: No `*.test.*` or `*.spec.*` files are tracked in the repository, and `package.json` has no `test` script (only `test-rag` which runs `scripts/test-rag-system.js`).
- Blocks: Safe refactoring of the mega-components and chat routes; regression detection for RAG and voice timing.

**Authorization middleware:**
- Problem: `src/proxy.ts` only refreshes Supabase session cookies. There is no central route-level authorization for `/api/*`.
- Blocks: Consistent enforcement of the auth rules in AGENTS.md section 12 (multi-tenant RLS). Each route must remember its own check, and many do not.

**CI quality gate:**
- Problem: No CI config for lint, type-check, or the domain scripts (`scripts/rag/*`) is tracked. The `vercel.json` `ignoreCommand: "exit 1"` disables automatic preview builds.
- Blocks: Enforcing AGENTS.md section 15 before hand-off.

## Test Coverage Gaps

**Authentication and authorization on API routes:**
- What's not tested: Auth checks for the admin, config, MCP, and generation routes.
- Files: `src/app/api/admin/*`, `src/app/api/config/*`, `src/app/api/mcp/*`, `src/app/api/generate-*/route.ts`
- Risk: The admin-session and unauthenticated-write issues above could regress unnoticed.
- Priority: High

**Webhook signature verification:**
- What's not tested: Valid and invalid signatures for Polar, Stripe, Nango, and WhatsApp webhooks.
- Files: `src/app/api/webhooks/route.ts`, `src/lib/polar.ts`, `src/app/api/webhooks/stripe/route.ts`, `src/app/api/nango/webhook/route.ts`, `src/app/api/whatsapp/webhook/route.ts`
- Risk: Forged webhooks accepted (Polar currently accepts all).
- Priority: High

**RAG retrieval and strict-mode behavior:**
- What's not tested: Strict RAG "information not available" response and web-search fallback (AGENTS.md section 14).
- Files: `src/app/api/chat/route.ts`, `src/lib/enhanced-rag-retrieval.ts`, `src/lib/adaptive-retrieval.ts`
- Risk: Silent answer-from-general-knowledge regressions.
- Priority: High

**Voice audio resampling and timing:**
- What's not tested: Resampling of incoming audio for VAD/STT, and estimated-timing fallback.
- Files: `voice-agent/src/agent.ts`, `voice-agent/src/voice_agent.ts`, `src/lib/audio-utils.ts`
- Risk: Audio distortion or overlay stuck in three-dot state.
- Priority: Medium

**Message parsing and rendering:**
- What's not tested: Mention highlighting, link extraction, and HTML escaping in `chat-message.tsx`.
- Files: `src/components/ui/chat-message.tsx`, `src/app/page.tsx`
- Risk: XSS regressions (see Security Considerations).
- Priority: High

---

*Concerns audit: 2026-11-22*
