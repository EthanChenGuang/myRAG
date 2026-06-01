# Codebase Concerns

**Analysis Date:** 2026-06-01

## Tech Debt

**Deprecated Supabase Auth Package:**
- Issue: `@supabase/auth-helpers-nextjs` (deprecated) is still used alongside the current `@supabase/ssr` package.
- Files: `src/lib/chat-store.ts`, `src/app/auth/signup/page.tsx`, `src/app/api/process-document/route.ts`, `src/app/api/invites/[token]/route.ts`
- Impact: Auth helpers are no longer maintained; `createClientComponentClient` and `createRouteHandlerClient` will not receive security patches. Creates a split auth pattern where some routes use the new SSR helpers (`src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`) and others use the deprecated package.
- Fix approach: Replace all `createClientComponentClient` calls with `createBrowserClient` from `@supabase/ssr`, and all `createRouteHandlerClient` calls with the server helper from `src/lib/supabase/server.ts`.

**Zod Import Path Inconsistency:**
- Issue: Some files import from `'zod/v3'` while `package.json` declares `"zod": "^3.25.76"`. The installed version is Zod v3 which provides a `/v3` compat subpath but the canonical import is `'zod'`.
- Files: `src/app/api/chat/route.ts`, `src/app/api/chat/approve/route.ts`, `src/lib/mcp/production-router.ts`, `src/lib/mcp/smart-router.ts`, `src/app/api/embed/chat/route.ts`, `src/app/api/mcp/servers/route.ts`, `src/app/api/mcp/servers/[id]/route.ts`, `src/lib/api-middleware.ts`, `src/app/api/generate-3d/route.ts`
- Impact: If the project upgrades to Zod v4 the `/v3` subpath will remain as a compatibility shim, but mixing import styles now creates confusion. Any future v4 migration would require auditing both paths.
- Fix approach: Standardize on `import { z } from 'zod'` across all files.

**TypeScript Build Errors Suppressed:**
- Issue: `next.config.js` sets `typescript: { ignoreBuildErrors: true }`, meaning TypeScript errors do not fail CI or production builds.
- Files: `next.config.js:45`
- Impact: The type system provides no safety net. Type errors accumulate silently. The 744 `as any` casts (244 `as any` + 499 `: any` / `<any>`) indicate significant type debt that this flag is hiding.
- Fix approach: Remove `ignoreBuildErrors: true`, run `npm run lint` and tsc to surface errors, then address them incrementally.

**node-fetch Used Alongside Native Fetch:**
- Issue: `node-fetch` is explicitly imported in some files while the rest of the codebase uses native `fetch` (available in Node.js 18+).
- Files: `src/lib/document-processor.ts:11`, `src/app/api/process-document/route.ts:3`
- Impact: Redundant dependency; fetch differences between node-fetch v2 and native fetch can cause subtle bugs (e.g., with `FormData`, streaming).
- Fix approach: Remove `node-fetch` import and use native `fetch` throughout.

**Model Configuration Must Be Synchronized Across Five Files:**
- Issue: Adding or updating an AI model requires manually editing five separate locations: `.env.local`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, `scripts/config-ui/index.html`.
- Impact: Any missed file causes missing model icons, broken fallback arrays, or runtime errors. High maintenance cost for a core feature.
- Fix approach: Centralize model definitions in a single source-of-truth JSON/TS file and import it everywhere.

**Polar Webhook Signature Verification Is a No-op:**
- Issue: `verifyPolarWebhookSignature` in `src/lib/polar.ts:54` has a `TODO` and unconditionally returns `true` regardless of signature. The check in `src/app/api/webhooks/route.ts` calls this function and trusts the result.
- Files: `src/lib/polar.ts:47-60`, `src/app/api/webhooks/route.ts:17-28`
- Impact: Any unauthenticated request to `/api/webhooks` with a Polar-like payload is accepted (though subscription handling is currently disabled—see Known Bugs section).
- Fix approach: Implement HMAC-SHA256 verification using the `POLAR_WEBHOOK_SECRET` env var, matching the pattern already working in `src/lib/stripe.ts`.

**Organization Invite Emails Never Sent:**
- Issue: `src/app/api/organizations/[id]/invites/route.ts:250` has a `TODO: Send invitation email` comment. Invites are created in the database but no email is dispatched.
- Files: `src/app/api/organizations/[id]/invites/route.ts:250`
- Impact: Users invited to organizations never receive a notification. The invite flow is silently broken.
- Fix approach: Integrate the existing SMTP configuration (`NEXT_PUBLIC_CUSTOM_SMTP_ENABLED`) to send invitation emails on invite creation.

---

## Known Bugs

**Polar Subscription Webhook Handling Completely Disabled:**
- Symptoms: All Polar webhook events are received but subscription creation/update/deletion logic is commented out. Polar payments do not update subscription state in the database.
- Files: `src/app/api/webhooks/route.ts:33-53`
- Trigger: Any Polar webhook event.
- Workaround: Only Stripe subscriptions (`src/app/api/webhooks/stripe/route.ts`) are functional.

**Streaming Artifact Cleanup Is a Symptom Fix:**
- Symptoms: Three concurrent `setInterval` cleaners in `src/app/page.tsx` (lines 1044, 1074, 1130) run at 100-250ms during streaming to strip raw AI SDK protocol frames (`f:{messageId...}`, `9:{toolCallId...}`) from rendered text. These are data-format leakage artifacts from the AI SDK streaming protocol.
- Files: `src/app/page.tsx:1044-1162`
- Trigger: Every streaming response.
- Workaround: The intervals clear the garbage visually, but the root cause is that raw stream frame data is not being filtered out before entering the React state.

**Admin Session Cookie Stores Raw User ID:**
- Symptoms: The `admin_session` cookie stores a plain Supabase `userId` UUID as its value. Any user who learns another admin's UUID can forge the cookie (cookie is `httpOnly` but has no cryptographic integrity).
- Files: `src/app/api/admin/login/route.ts:67-74`, `src/app/api/admin/settings/route.ts:32-50`
- Trigger: Replay or forge the `admin_session` cookie value.
- Workaround: Each request re-verifies the user ID against the `is_admin` RPC, but the cookie value itself offers no tamper resistance.

---

## Security Considerations

**Config API Routes Have No Auth in Single-Tenant Mode:**
- Risk: `/api/config/upload-logo`, `/api/config/upload-favicon`, `/api/config/rag-prompt`, `/api/config/audio-settings`, `/api/config/models`, and `/api/config/get-env` have no authentication checks of any kind. Any unauthenticated request can write files to `public/` or read/modify `.env.local`.
- Files: `src/app/api/config/upload-logo/route.ts`, `src/app/api/config/upload-favicon/route.ts`, `src/app/api/config/rag-prompt/route.ts`, `src/app/api/config/audio-settings/route.ts`, `src/app/api/config/models/route.ts`, `src/app/api/config/get-env/route.ts`
- Current mitigation: Only the main `/api/config` route checks auth, and only in multi-tenant mode (`isSingleTenant()` short-circuits it in single-tenant).
- Recommendations: Add authentication middleware to all `/api/config/*` write routes regardless of deployment mode. At minimum, require an admin session cookie.

**`dangerouslySetInnerHTML` Used With User-Controlled Content:**
- Risk: `highlightDocumentMentions()` in `src/components/ui/chat-message.tsx:78-95` injects user-supplied document names directly into an HTML template string without escaping (`${cleanedDocName}`). This output is then rendered via `dangerouslySetInnerHTML` at lines 3790 and 4903.
- Files: `src/components/ui/chat-message.tsx:78-95`, `src/components/ui/chat-message.tsx:3790`, `src/components/ui/chat-message.tsx:4903`
- Current mitigation: None. The only transformation is removing backslashes.
- Recommendations: HTML-escape `cleanedDocName` before interpolating it, or build the DOM elements programmatically using React. Similarly audit `src/lib/chat-utils.ts:93,150` where `marked.parse()` output is assigned to `innerHTML` without sanitization.

**Hardcoded ngrok Development URL in Production Config:**
- Risk: `next.config.js:42` includes `allowedDevOrigins: ["cd1fdd0c8c48.ngrok-free.app"]`. This specific ngrok subdomain is exposed to anyone who discovers it.
- Files: `next.config.js:42`
- Current mitigation: `allowedDevOrigins` is a Next.js development-only option.
- Recommendations: Remove the specific ngrok URL. Use environment variable injection for dynamic dev tunnels instead.

**Rate Limiting Only Applies to Embed Chat Endpoint:**
- Risk: The main `/api/chat` route has no rate limiting. An unauthenticated or authenticated user can send unlimited LLM requests, incurring unbounded API costs.
- Files: `src/lib/embed-rate-limit.ts`, `src/app/api/embed/chat/route.ts` (protected), `src/app/api/chat/route.ts` (unprotected)
- Current mitigation: In-memory rate limiting exists only for embed chat. The in-memory store also does not survive process restarts or horizontal scaling.
- Recommendations: Apply rate limiting to `/api/chat`. Replace the in-memory store (`rateLimitStore = new Map()`) with a Redis-backed solution for multi-instance deployments.

**`console.log` Statements Ship Debug Data to Production:**
- Risk: 492 `console.log`/`console.debug` calls exist in `src/app/api/chat/route.ts` alone. These log message content, session IDs, model names, reasoning settings, and image URLs to stdout in production.
- Files: `src/app/api/chat/route.ts`, `src/lib/query-classifier.ts`, `src/lib/whatsapp/flyio-client.ts`, `src/lib/whatsapp/webhook-handler.ts`, `src/app/api/nango/folders/route.ts`, `src/app/api/nango/files/route.ts` (2,915 raw `console.*` calls total in `src/`)
- Current mitigation: `NEXT_PUBLIC_DISABLE_DEBUG_LOGS` suppresses client-side logs via script injection in `src/app/client-layout.tsx:88`. Server-side logs are unaffected by this flag.
- Recommendations: Route all server-side logging through `src/lib/logger.ts`. The logger already gates DEBUG logs to `NODE_ENV === 'development'`. Add an ESLint rule (`no-console`) to prevent regressions.

---

## Performance Bottlenecks

**Three Concurrent Polling Intervals During Streaming:**
- Problem: During every streaming response, `src/app/page.tsx` runs three `setInterval` loops at 100ms, 250ms, and 250ms intervals, all performing regex replacements on the current message content array.
- Files: `src/app/page.tsx:1044-1162`
- Cause: Raw AI SDK wire-format tokens bleed into rendered content; regex cleanup is applied reactively.
- Improvement path: Fix the upstream cause (filter protocol frames before inserting into React state) to eliminate all three intervals entirely.

**`src/app/page.tsx` Is a 4,695-Line God Component:**
- Problem: The main page component contains 41 `useEffect` hooks, 29 `useState` hooks, and all chat orchestration logic (streaming sync, scroll control, title generation, session management, document handling, temporary file cleanup).
- Files: `src/app/page.tsx`
- Cause: Organic growth without extraction to custom hooks or sub-components.
- Improvement path: Extract streaming state management, scroll logic, and session handling into dedicated custom hooks (`src/lib/hooks/`). The React Compiler is enabled but cannot fully optimize components with this many effects.

**`src/lib/title-generator.ts` Is 2,278 Lines:**
- Problem: The title generator has grown into a multi-model orchestration module (imports `title-generator-multimodal`, `title-generator-creative`, handles image analysis, JSON extraction, token counting). It is imported by multiple high-traffic paths: `src/lib/chat-store.ts`, `src/lib/supabase.ts`, `src/components/ui/chat-message.tsx`.
- Files: `src/lib/title-generator.ts`
- Cause: Scope creep; started as a simple string generator and accumulated multimodal and creative variants.
- Improvement path: Split into `title-generator-basic.ts`, `title-generator-multimodal.ts` (already exists), and a thin `title-generator.ts` orchestrator; lazy-import heavy variants.

**MCP Tool Caches Are In-Memory Singletons:**
- Problem: `src/lib/mcp/universal-client.ts` and `src/lib/mcp/discovery.ts` use module-level singleton instances with in-process Maps as tool caches. On serverless (Vercel) deployments each function invocation may start cold with an empty cache, causing repeated MCP discovery latency.
- Files: `src/lib/mcp/universal-client.ts:46-50`, `src/lib/mcp/discovery.ts:51`
- Cause: Singleton pattern designed for long-lived processes, not serverless edge functions.
- Improvement path: Persist MCP tool schema discovery results to Supabase or an external cache (Redis/KV) with a TTL.

---

## Fragile Areas

**`src/app/api/chat/route.ts` (4,255 Lines):**
- Files: `src/app/api/chat/route.ts`
- Why fragile: Handles all chat types (RAG, MCP tools, image generation, WhatsApp, embed, multi-step), with 13 nested `try/catch` blocks, 42 `as any` casts, and 492 `console.log` calls. Any change risks breaking unrelated code paths. No tests exist.
- Safe modification: Make changes in small, isolated blocks. Search for existing `// 🔧 FIX:` or `// 🔍 DEBUG:` comments before editing to understand prior fix context.
- Test coverage: Zero automated tests.

**`src/app/api/chat/approve/route.ts` (4,823 Lines):**
- Files: `src/app/api/chat/approve/route.ts`
- Why fragile: Larger than the main chat route. Handles MCP tool approval flows with deep nesting. Changes to tool execution state storage or approval protocol will require coordinated edits here and in `src/lib/tool-execution-state.ts`.
- Safe modification: Always verify `src/lib/tool-execution-state.ts` state transitions before modifying approval logic.
- Test coverage: Zero automated tests.

**Module-Level Mutable Singletons in API Routes:**
- Files: `src/app/api/admin/login/route.ts:7`, `src/app/api/admin/settings/route.ts:8`, `src/app/api/admin/status/route.ts:7`, `src/app/api/admin/check/route.ts:83`
- Why fragile: Each admin route declares `let adminClient: any = null` at module scope with lazy initialization. In serverless environments this state may or may not persist between invocations. The `any` typing also prevents compile-time safety.
- Safe modification: Replace with a factory function that creates the client fresh per request, or import `getSupabaseAdmin()` from `src/lib/supabase.ts`.
- Test coverage: Zero automated tests.

**`src/lib/chat-store.ts` Module-Level Chat Creation Guard:**
- Files: `src/lib/chat-store.ts:233-234`
- Why fragile: `let isCreatingChat = false` and `let lastCreationTime = 0` are module-level booleans used as a mutex to prevent duplicate chat creation. This pattern is not safe across concurrent requests or hot module reloads.
- Safe modification: Do not remove these guards without replacing them with database-level deduplication (e.g., unique constraint + upsert).
- Test coverage: Zero automated tests.

---

## Scaling Limits

**In-Memory Rate Limiting:**
- Current capacity: One rate limit store per process instance.
- Limit: Rate limits reset on process restart; with multiple server instances each has its own counter, allowing N×limit requests per window.
- Scaling path: Replace `src/lib/embed-rate-limit.ts` Map with Redis/Upstash-backed rate limiting.

**WhatsApp Session State Is Per-Instance:**
- Current capacity: WhatsApp session monitoring (`src/lib/whatsapp/connection-monitor.ts`) uses a module-level singleton `let monitor`.
- Limit: Does not work correctly with multiple server instances. Session health check triggers are per-process.
- Scaling path: Move session health checks to a separate worker process or use Supabase Realtime to coordinate across instances.

---

## Dependencies at Risk

**`multer` Listed But Not Found in Use:**
- Risk: `multer@^1.4.5-lts.2` is in `package.json` dependencies but no `import multer` appears in source. `multer` 1.x is in LTS mode only (no new features) and has a known memory-disclosure vulnerability in older versions. Its presence inflates bundle size.
- Impact: Unnecessary dependency surface area.
- Migration plan: Audit whether `multer` is still needed; if not, remove it.

**`@supabase/auth-helpers-nextjs` (Deprecated):**
- Risk: Package is deprecated and unmaintained since `@supabase/ssr` became the official replacement.
- Impact: Security patches will not be released for auth-helpers.
- Migration plan: See Tech Debt section above.

**`express@^5.1.0` in Dependencies:**
- Risk: Express 5 is used as a dependency (likely for the config server in `scripts/config-server.js`), but Express 5 is a major version bump with breaking changes from v4. If scripts and app code mix v4-pattern middleware assumptions, errors will be silent.
- Impact: Config server (`npm run config`) may have subtle routing or error-handling behavior differences.
- Migration plan: Pin to a specific Express 5 minor if v5 is intentional, or use a lightweight server alternative for the config dashboard.

---

## Missing Critical Features

**No Automated Tests of Any Kind:**
- Problem: The repository has zero test files (no `.test.ts`, `.spec.ts`, or test runner configuration). `package.json` has no `test` script.
- Blocks: Safe refactoring of the 4,255-line chat route, 4,823-line approve route, 5,586-line chat-message component, or any of the RAG/MCP pipeline logic.

**No Input Validation on Main Chat Route:**
- Problem: `src/app/api/chat/route.ts` does not use Zod or any schema validation on the incoming request body. Raw `(data as any)` casts extract fields like `sessionId`, `chatId`, `settings`.
- Files: `src/app/api/chat/route.ts:1218`
- Blocks: Reliable error messages for malformed requests; security hardening.

---

## Test Coverage Gaps

**Core Chat Pipeline:**
- What's not tested: RAG retrieval, MCP tool execution, streaming response assembly, title generation, chat persistence.
- Files: `src/app/api/chat/route.ts`, `src/lib/retrieval-strategies.ts`, `src/lib/adaptive-retrieval.ts`, `src/lib/chat-store.ts`
- Risk: Regressions in any of these files are only caught in production.
- Priority: High

**Admin Authentication Flow:**
- What's not tested: Admin cookie issuance, `is_admin` RPC verification, session expiry.
- Files: `src/app/api/admin/login/route.ts`, `src/app/api/admin/settings/route.ts`, `src/app/api/admin/check/route.ts`
- Risk: Auth bypasses or regressions go undetected.
- Priority: High

**Payment Webhooks:**
- What's not tested: Stripe signature verification, subscription state transitions.
- Files: `src/app/api/webhooks/stripe/route.ts`, `src/lib/stripe.ts`
- Risk: Silent failures in billing logic.
- Priority: High

**MCP Tool Approval Flow:**
- What's not tested: Tool state storage (`src/lib/tool-execution-state.ts`), approval/rejection routing, the 4,823-line approve route.
- Files: `src/app/api/chat/approve/route.ts`, `src/lib/tool-execution-state.ts`
- Risk: Tool approval regressions are user-visible and hard to reproduce.
- Priority: Medium

---

*Concerns audit: 2026-06-01*
