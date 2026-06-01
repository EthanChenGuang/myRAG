# External Integrations

**Analysis Date:** 2026-06-01

## APIs & External Services

**AI Model Providers:**
- OpenRouter - Primary chat AI provider (multi-model gateway)
  - SDK/Client: `@openrouter/ai-sdk-provider` + `openai` raw client
  - Auth: `OPENROUTER_API_KEY`
  - Client: `src/lib/openrouter.ts` (singleton pattern)
  - Used in: `src/app/api/chat/route.ts` via `createOpenRouter()`

- OpenAI - Embeddings, image generation, title generation, fallback chat
  - SDK/Client: `openai` ^4.103.0, `@ai-sdk/openai` ^2.0.53
  - Auth: `OPENAI_API_KEY` (required)
  - Embedding model: `text-embedding-3-small` (1536-dim, configurable via `OPENAI_EMBEDDING_MODEL`)
  - Image model: GPT-Image-1 (when `IMAGE_GENERATION_PROVIDER=openai`)
  - Used in: `src/lib/document-processor.ts`, `src/app/api/generate-image/route.ts`

- Anthropic (via OpenRouter) - Claude models available via `anthropic/claude-*` model IDs

- Google Gemini (via OpenRouter) - Gemini models available via `google/gemini-*` model IDs

- DeepSeek (via OpenRouter) - Available via OpenRouter model IDs

**Document AI:**
- LlamaCloud / LlamaParse - PDF and document parsing
  - SDK/Client: `llamaindex` ^0.8.30, direct HTTP to `https://api.cloud.llamaindex.ai/api`
  - Auth: `LLAMA_CLOUD_API_KEY`
  - Used in: `src/lib/document-processor.ts`, `src/app/api/process-document/route.ts`
  - Configurable parse mode, chunk strategy, OCR settings via env vars (`LLAMACLOUD_*`)

**Web Search:**
- Exa - Semantic web search
  - SDK/Client: `exa-js` ^1.8.26
  - Auth: `EXA_API_KEY`
  - Feature flag: `NEXT_PUBLIC_WEB_SEARCH_ENABLED`
  - Referenced in: `src/lib/env.ts`

- OpenRouter web search - Fallback web search via OpenRouter models
  - Used in: `src/app/api/web-search/route.ts` (delegates to OpenRouter when Exa unavailable)

**Web Scraping:**
- Firecrawl - Website crawling and content extraction
  - SDK/Client: `@mendable/firecrawl-js` ^4.8.2
  - Auth: `FIRECRAWL_API_KEY`
  - Feature flag: `NEXT_PUBLIC_FIRECRAWL_ENABLED`
  - Client: `src/lib/scrapers/firecrawl-client.ts`
  - Config endpoint: `src/app/api/config/firecrawl/route.ts`

**Voice / Audio:**
- ElevenLabs - Text-to-speech
  - Auth: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (default: Sarah voice)
  - Client: `src/lib/elevenlabs-utils.ts`
  - Configurable via `ELEVENLABS_*` env vars
  - Feature flag: `NEXT_PUBLIC_TTS_DISABLED`

- OpenAI TTS/STT - Built-in voice provider (default)
  - Provider selected by `NEXT_PUBLIC_VOICE_PROVIDER` (values: `openai` | `elevenlabs`)
  - Used in: `src/app/api/audio/` routes

**Image Generation:**
- Fal.ai - Primary image and video generation provider
  - SDK/Client: `@fal-ai/client` ^1.4.0, `@fal-ai/serverless-client` ^0.15.0
  - Auth: `FAL_API_KEY`
  - Provider: `IMAGE_GENERATION_PROVIDER=fal`
  - Used in: `src/app/api/generate-image/route.ts`, `src/app/api/generate-video/route.ts`, `src/app/api/generate-3d/route.ts`
  - Default models: `fal-ai/veo3/fast` (video), `fal-ai/trellis` (3D)

- Replicate - Fallback image/video/3D generation
  - SDK/Client: `replicate` ^1.0.1
  - Auth: `REPLICATE_API_TOKEN`
  - Provider flag: `USE_REPLICATE_PROVIDER=true`
  - Used in: `src/app/api/generate-image/route.ts`, `src/app/api/generate-video/route.ts`, `src/app/api/generate-3d/route.ts`
  - Default 3D model: `firtoz/trellis`

**MCP (Model Context Protocol):**
- Zapier MCP - Automation tool execution
  - Auth: Endpoint-based via `MCP_ZAPIER_ENDPOINT`
  - Transport: streamable-http (SSE)
  - Config: `src/lib/mcp/server-config.ts`

- Universal MCP Router - Connects to arbitrary MCP servers
  - Client: `src/lib/mcp/universal-client.ts`, `src/lib/mcp/smart-router.ts`
  - Discovery: `src/lib/mcp/discovery.ts`, `src/lib/mcp/universal-discovery.ts`
  - Approval flow: `src/app/api/mcp/` and `src/app/api/chat/approve/route.ts`
  - YOLO mode (auto-execute without approval): `NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED`

**Document Connectors (Nango):**
- Nango - OAuth-based third-party document connectors
  - SDK/Client: `@nangohq/frontend` ^0.69.14 (OAuth UI), `@nangohq/node` ^0.69.14 (server)
  - Auth: `NANGO_SECRET_KEY`, `NANGO_WEBHOOK_SECRET`
  - Host: `NANGO_HOST` (default: `https://api.nango.dev`)
  - Feature flag: `NEXT_PUBLIC_NANGO_ENABLED`
  - Client: `src/lib/nango/client.ts`, exported via `src/lib/nango/index.ts`
  - API routes: `src/app/api/nango/` (connections, files, folders, notion, session, sync, webhook)
  - Supported providers (defined in `src/lib/nango/types.ts`):
    - `google-drive` - Google Drive documents
    - `notion` - Notion pages
    - `dropbox` - Dropbox files
    - `box` - Box files
    - `confluence` - Confluence pages

**Analytics:**
- Vercel Analytics - Page view and performance tracking
  - SDK: `@vercel/analytics` ^1.5.0
  - Used in: `src/app/client-layout.tsx`

## Data Storage

**Databases:**
- Supabase PostgreSQL - Primary database
  - Connection: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - Client (browser): `src/lib/supabase/client.ts` via `createBrowserClient` from `@supabase/ssr`
  - Client (server SSR): `src/lib/supabase/server.ts`
  - Admin client (bypasses RLS): `src/lib/supabase.ts` `getSupabaseAdmin()`
  - Middleware: `src/lib/supabase/middleware.ts`
  - Schema setup: `supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql`

- pgvector (Supabase extension) - Vector similarity search
  - Vector dimensions: 1536 (OpenAI `text-embedding-3-small`)
  - Index type: HNSW with `m=64, ef_construction=200, vector_cosine_ops`
  - RPC function: `match_document_chunks` (vector similarity search)
  - Tables: `document_chunks` with `embedding vector(1536)` column

**Key Database Tables:**
- `chats` - Chat history with JSONB messages
- `documents` - Uploaded/synced documents with source tracking
- `document_chunks` - Vector-embedded text chunks for RAG
- `folders` - Chat folder organization
- `organizations` - Multi-tenant organizations
- `organization_members` - Team membership
- `subscriptions` - Payment subscriptions (Stripe/Polar)
- `admin_users`, `admin_settings` - Admin access control

**File Storage:**
- Supabase Storage - Generated media (images, videos, 3D models)
  - Used in: `src/app/api/generate-image/route.ts`, `src/app/api/generate-video/route.ts`, `src/app/api/generate-3d/route.ts`
  - Bucket paths accessible via `NEXT_PUBLIC_SUPABASE_URL/storage/v1/object/public/**`

**Caching:**
- In-memory server-side caching for MCP tools: `src/lib/mcp-cache.ts` (`getCachedTools`, `setCachedTools`)
- No distributed cache (Redis, etc.) detected

## Authentication & Identity

**Auth Provider:**
- Supabase Auth
  - Browser client: `src/lib/supabase/client.ts`
  - SSR/server: `src/lib/supabase/server.ts`, `src/lib/supabase/middleware.ts`
  - Auth helpers: `src/lib/supabase-auth.ts` (exports `signInWithEmail`, `signUpWithEmail`, `signInWithSocial`)
  - Provider component: `src/components/providers/auth-provider.tsx`
  - Auth page: `src/app/auth/page.tsx`, signup: `src/app/auth/signup/page.tsx`
  - Row Level Security (RLS) enforced at database level; admin operations use service role key

**Supported Auth Methods:**
- Email/password (`supabase.auth.signInWithPassword`, `supabase.auth.signUp`)
- Google OAuth (`signInWithSocial('google')`)
- GitHub OAuth (`signInWithSocial('github')`, `supabase.auth.signInWithOAuth`)
- Magic link (supported by Supabase, optional)
- Custom SMTP for email (configurable via `NEXT_PUBLIC_CUSTOM_SMTP_ENABLED`)

## Payments

**Stripe:**
- SDK: `stripe` ^17.6.0
- Auth: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- Public keys: `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_STRIPE_PRICE_ID_PRO`, `NEXT_PUBLIC_STRIPE_PRICE_ID_ENTERPRISE`
- Client: `src/lib/stripe.ts` (lazy singleton)
- Checkout: `src/app/api/create-stripe-checkout/route.ts`
- Webhook handler: `src/app/api/webhooks/stripe/route.ts`
- API version: `2025-01-27.acacia`

**Polar:**
- No SDK — direct URL-based checkout links
- Auth: `NEXT_PUBLIC_POLAR_CHECKOUT_PRO`, `NEXT_PUBLIC_POLAR_CHECKOUT_ENTERPRISE`, `POLAR_WEBHOOK_SECRET`
- Client: `src/lib/polar.ts`
- Checkout: `src/app/api/create-checkout/route.ts`
- Webhook handler: `src/app/api/webhooks/route.ts` (subscription handling currently disabled)

## Monitoring & Observability

**Error Tracking:**
- None detected (no Sentry, DataDog, etc.)

**Logs:**
- Custom structured logger: `src/lib/logger.ts` (methods: `startup`, `db`, `warn`, `error`, `debug`)
- Dev logger: `src/lib/dev-logger.ts`
- Performance monitor: `src/lib/performance-monitor.tsx`
- Log spam prevention: debug/startup logs gated; high-frequency effects scoped to active states

## CI/CD & Deployment

**Hosting:**
- Vercel (`vercel.json`): framework `nextjs`, region `iad1`, max function duration 60s
- WhatsApp Baileys backend: Fly.io (`FLYIO_BAILEYS_URL`, `FLYIO_API_KEY`) or Koyeb (`KOYEB_BAILEYS_URL`, `KOYEB_API_KEY`)
  - Provider selected by `WHATSAPP_PROVIDER` env var (default: `koyeb`)

**CI Pipeline:**
- GitHub integration via `vercel.json` (`"github": { "silent": true }`)
- No dedicated CI workflow files detected (`.github/workflows/` not observed)

## Webhooks & Callbacks

**Incoming:**
- Stripe: `src/app/api/webhooks/stripe/route.ts` - Subscription lifecycle events
- Polar: `src/app/api/webhooks/route.ts` - Payment events (subscription handling currently disabled)
- Nango: `src/app/api/nango/webhook/` - Document sync events from Nango connectors (`NANGO_WEBHOOK_SECRET` for verification)
- WhatsApp: `src/app/api/whatsapp/` - Incoming WhatsApp messages and session events (`WHATSAPP_WEBHOOK_SECRET`)

**Outgoing:**
- WhatsApp messages sent to Baileys service (`KOYEB_BAILEYS_URL` or `FLYIO_BAILEYS_URL`)
- MCP tool calls to external MCP servers (Zapier, custom endpoints via `MCP_ZAPIER_ENDPOINT`)
- Generation job status polling (Fal.ai, Replicate callbacks handled inline in route handlers)

## Environment Configuration

**Required env vars:**
- `OPENAI_API_KEY` - Embeddings + OpenAI features
- `SUPABASE_SERVICE_ROLE_KEY` - Server-side DB admin
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase public key

**Important optional env vars:**
- `OPENROUTER_API_KEY` - Primary chat AI (warns if missing)
- `FAL_API_KEY` - Image/video/3D generation
- `REPLICATE_API_TOKEN` - Generation fallback
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` - Payments
- `LLAMA_CLOUD_API_KEY` - Document parsing
- `EXA_API_KEY` - Web search
- `FIRECRAWL_API_KEY` - Web scraping
- `ELEVENLABS_API_KEY` - ElevenLabs TTS
- `NANGO_SECRET_KEY` + `NANGO_WEBHOOK_SECRET` - Document connectors
- `KOYEB_BAILEYS_URL` + `KOYEB_API_KEY` or `FLYIO_BAILEYS_URL` + `FLYIO_API_KEY` - WhatsApp

**Secrets location:**
- `.env.local` (local development, gitignored)
- Vercel dashboard environment variables (production)
- Template/defaults: `scripts/init-env.js`
- Config dashboard: `http://localhost:3333` via `npm run config`

---

*Integration audit: 2026-06-01*
