# External Integrations

**Analysis Date:** 2026-03-08

## APIs & External Services

**AI Model Providers:**
- OpenRouter - Primary AI model router (multi-model chat)
  - SDK/Client: `@openrouter/ai-sdk-provider` + `openai` (base URL override)
  - Auth: `OPENROUTER_API_KEY`
  - Client: `src/lib/openrouter.ts` (singleton via `getOpenRouterClient()`)
  - Chat route: `src/app/api/chat/route.ts`

- OpenAI - Embeddings, image generation (GPT-Image-1), direct chat
  - SDK/Client: `openai`, `@ai-sdk/openai`
  - Auth: `OPENAI_API_KEY`
  - Embedding model: configurable via `OPENAI_EMBEDDING_MODEL` (default: `text-embedding-3-small`)
  - Used in: `src/lib/document-processor.ts`, `src/app/api/generate-image/route.ts`

- Anthropic - Available via OpenRouter (Claude models)
- Google Gemini - Available via OpenRouter
- DeepSeek - Available via OpenRouter
- Meta Llama - Available via OpenRouter

**Image Generation:**
- OpenAI (GPT-Image-1) - Image generation with quality/background/format controls
  - Auth: `OPENAI_API_KEY`
  - Config: `IMAGE_GENERATION_PROVIDER`, `OPENAI_IMAGE_QUALITY`, `OPENAI_IMAGE_BACKGROUND`
  - Route: `src/app/api/generate-image/route.ts`

- Fal.ai - Image and video generation (default provider)
  - SDK/Client: `@fal-ai/client`
  - Auth: `FAL_API_KEY`
  - Routes: `src/app/api/generate-image/route.ts`, `src/app/api/generate-video/route.ts`, `src/app/api/generate-3d/route.ts`
  - Video model: configurable via `FAL_VIDEO_MODEL` (default: `fal-ai/veo3/fast`)
  - 3D model: configurable via `FAL_3D_MODEL` (default: `fal-ai/trellis`)

- Replicate - Alternative image/video/3D generation
  - SDK/Client: `replicate`
  - Auth: `REPLICATE_API_TOKEN`
  - Toggle: `USE_REPLICATE_PROVIDER`
  - Routes: same as Fal.ai (provider selection at runtime)

**Video Generation:**
- Fal.ai / Replicate - Video from text/image prompts
  - Route: `src/app/api/generate-video/route.ts`

**3D Generation:**
- Fal.ai / Replicate - 3D model generation
  - Route: `src/app/api/generate-3d/route.ts`
  - Default model: `fal-ai/trellis` (Fal) or `firtoz/trellis` (Replicate)

**Voice / Audio:**
- OpenAI - TTS and STT (default provider)
  - Config: `NEXT_PUBLIC_VOICE_PROVIDER`
  - Route: `src/app/api/audio/route.ts`

- ElevenLabs - Alternative TTS/STT provider
  - Auth: `ELEVENLABS_API_KEY`
  - Config: `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, voice settings
  - Client: `src/lib/elevenlabs-utils.ts`

**Web Search:**
- Exa - Web search API
  - SDK/Client: `exa-js`
  - Auth: `EXA_API_KEY`
  - Toggle: `NEXT_PUBLIC_WEB_SEARCH_ENABLED`
  - Route: `src/app/api/web-search/route.ts`

**Document Processing:**
- LlamaCloud (LlamaParse) - Document parsing (PDF, DOCX, etc.)
  - Auth: `LLAMA_CLOUD_API_KEY`
  - API Base: `https://api.cloud.llamaindex.ai/api`
  - Config: `LLAMACLOUD_PARSING_MODE`, `LLAMACLOUD_CHUNK_STRATEGY`, `LLAMACLOUD_CHUNK_SIZE`, `LLAMACLOUD_CHUNK_OVERLAP`, multimodal parsing settings
  - Client: `src/lib/document-processor.ts`

**Web Scraping:**
- Firecrawl - URL scraping and content extraction
  - SDK/Client: `@mendable/firecrawl-js`
  - Auth: `FIRECRAWL_API_KEY`
  - Toggle: `NEXT_PUBLIC_FIRECRAWL_ENABLED`
  - Client: `src/lib/scrapers/firecrawl-client.ts`
  - Adapter: `src/lib/scrapers/scraper-adapter.ts`

**Document Connectors:**
- Nango - Third-party document source connectors (Google Drive, Notion, etc.)
  - SDK/Client: `@nangohq/node` (server), `@nangohq/frontend` (client)
  - Auth: `NANGO_SECRET_KEY`, `NANGO_WEBHOOK_SECRET`
  - Toggle: `NEXT_PUBLIC_NANGO_ENABLED`
  - Host: configurable via `NANGO_HOST` (default: `https://api.nango.dev`)
  - Client: `src/lib/nango/client.ts`
  - Sync manager: `src/lib/nango/sync-manager.ts`
  - API routes: `src/app/api/nango/` (connections, files, folders, notion, session, sync, webhook)

**MCP (Model Context Protocol):**
- Zapier MCP - External tool execution
  - Config: `MCP_ZAPIER_ENDPOINT`
  - Client: `src/lib/mcp/universal-client.ts`
  - Router: `src/lib/mcp/production-router.ts`, `src/lib/mcp/smart-router.ts`
  - Discovery: `src/lib/mcp/discovery.ts`, `src/lib/mcp/universal-discovery.ts`
  - Approval flow: `src/app/api/chat/approve/route.ts`
  - Toggle: `NEXT_PUBLIC_MCP_SYSTEM_ENABLED`, `NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED`

## Data Storage

**Databases:**
- Supabase (PostgreSQL + pgvector)
  - Connection: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - Client (browser): `src/lib/supabase/client.ts` - `createBrowserClient()` from `@supabase/ssr`
  - Client (server): `src/lib/supabase/server.ts` - `createServerClient()` with cookie handling
  - Admin client: `src/lib/supabase.ts` - service role key, bypasses RLS
  - Middleware: `src/lib/supabase/middleware.ts` - session refresh
  - Schema files: `supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql`
  - Tables: `chats`, `documents`, `document_chunks` (with embeddings), `folders`
  - Vector search: 1536-dim embeddings, HNSW indexes (`m=64`, `ef_construction=200`)
  - RPC: `match_document_chunks` for similarity search
  - RLS: Row Level Security enforced; admin client bypasses for server operations

**File Storage:**
- Supabase Storage - Generated images, uploaded documents, logos
  - Used via admin client in API routes
  - Remote pattern configured in `next.config.js` for Next.js Image optimization

**Caching:**
- In-memory MCP tool cache (`src/lib/mcp-cache.ts`)
- No external cache service (Redis, etc.)

## Authentication & Identity

**Auth Provider:**
- Supabase Auth
  - Methods: GitHub OAuth, email/password, magic links
  - Implementation:
    - Browser client: `src/lib/supabase/client.ts`
    - Server client: `src/lib/supabase/server.ts` (cookie-based sessions)
    - Middleware: `src/lib/supabase/middleware.ts` (session refresh on every request)
    - Auth routes: `src/app/api/auth/`
    - Legacy helper: `@supabase/auth-helpers-nextjs`
  - Multi-tenant support: organization handler in `src/lib/auth/organization-handler.ts`
  - Deployment modes: `single-tenant` (default) or `multi-tenant` via `NEXT_PUBLIC_CHATRAG_DEPLOYMENT_MODE`

## Monitoring & Observability

**Analytics:**
- Vercel Analytics (`@vercel/analytics` ^1.5.0)

**Error Tracking:**
- None (console.error only)

**Logs:**
- Custom logger: `src/lib/logger.ts`
- Dev logger: `src/lib/dev-logger.ts`
- Performance monitor: `src/lib/performance-monitor.tsx`
- Levels: startup, debug, db, warn, error

## CI/CD & Deployment

**Hosting:**
- Vercel (primary, inferred from `@vercel/analytics` and Next.js)
- WhatsApp service: Fly.io or Koyeb (Baileys deployment)

**CI Pipeline:**
- Not detected (no CI config files found)

**Deployment Configuration:**
- `scripts/configure-deployment.js` - Deployment mode setup
- `scripts/init-env.js` - Environment variable initialization

## Environment Configuration

**Required env vars:**
- `OPENAI_API_KEY` - OpenAI API access (embeddings, image gen)
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase admin operations
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase anonymous key

**Important optional env vars:**
- `OPENROUTER_API_KEY` - Multi-model chat via OpenRouter
- `FAL_API_KEY` - Fal.ai image/video/3D generation
- `REPLICATE_API_TOKEN` - Replicate models
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` - Payments
- `EXA_API_KEY` - Web search
- `LLAMA_CLOUD_API_KEY` - Document parsing
- `FIRECRAWL_API_KEY` - Web scraping
- `NANGO_SECRET_KEY` - Document connectors
- `ELEVENLABS_API_KEY` - Voice synthesis
- `KOYEB_BAILEYS_URL` / `FLYIO_BAILEYS_URL` - WhatsApp service

**Feature flags (env-based):**
- `NEXT_PUBLIC_IMAGE_GENERATION_ENABLED` - Image generation UI
- `NEXT_PUBLIC_VIDEO_GENERATION_ENABLED` - Video generation UI
- `NEXT_PUBLIC_3D_GENERATION_ENABLED` - 3D generation UI
- `NEXT_PUBLIC_WEB_SEARCH_ENABLED` - Web search
- `NEXT_PUBLIC_WHATSAPP_ENABLED` - WhatsApp integration
- `NEXT_PUBLIC_MCP_SYSTEM_ENABLED` - MCP tools
- `NEXT_PUBLIC_NANGO_ENABLED` - Nango connectors
- `NEXT_PUBLIC_FIRECRAWL_ENABLED` - Web scraping
- `NEXT_PUBLIC_REASONING_ENABLED` - AI reasoning/thinking mode
- `NEXT_PUBLIC_EMBED_ENABLED` - Embeddable chat widget

**Secrets location:**
- `.env.local` (local development, git-ignored)
- Environment variables on hosting platform (production)

## Payments

**Stripe:**
- SDK/Client: `stripe` ^17.6.0
- Auth: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- API version: `2025-01-27.acacia`
- Client: `src/lib/stripe.ts` (lazy-initialized singleton)
- Webhook: `src/app/api/webhooks/stripe/route.ts`
- Checkout: `src/app/api/create-stripe-checkout/`
- Features: subscription management, checkout sessions

**Polar:**
- No SDK (direct API calls)
- Auth: `POLAR_WEBHOOK_SECRET`
- Client: `src/lib/polar.ts`
- Webhook: `src/app/api/webhooks/route.ts` (currently disabled/subscription handling commented out)
- Environments: production (`polar.sh`) and sandbox (`sandbox.polar.sh`)

## WhatsApp Integration

**Provider:**
- Baileys (unofficial WhatsApp Web API) deployed on Fly.io or Koyeb
- Provider selection: `WHATSAPP_PROVIDER` (`koyeb` | `flyio`)
- Client implementations:
  - `src/lib/whatsapp/koyeb-client.ts`
  - `src/lib/whatsapp/flyio-client.ts`
  - `src/lib/whatsapp/client-factory.ts` (provider selection)
- Session management: `src/lib/whatsapp/session-manager.ts`
- Connection monitoring: `src/lib/whatsapp/connection-monitor.ts`
- Webhook handler: `src/lib/whatsapp/webhook-handler.ts`
- API routes: `src/app/api/whatsapp/`
- Toggle: `NEXT_PUBLIC_WHATSAPP_ENABLED`

## Webhooks & Callbacks

**Incoming:**
- `src/app/api/webhooks/route.ts` - Polar payment webhooks (currently disabled)
- `src/app/api/webhooks/stripe/route.ts` - Stripe payment webhooks
- `src/app/api/nango/webhook/` - Nango sync completion webhooks
- `src/app/api/whatsapp/` - WhatsApp message webhooks

**Outgoing:**
- WhatsApp webhook URL (`WHATSAPP_WEBHOOK_URL`) - Configurable callback for WhatsApp events

## Embed Widget

**Embeddable Chat:**
- Toggle: `NEXT_PUBLIC_EMBED_ENABLED`
- Config: title, primary color, position, auto-open, greeting, allowed domains
- Rate limiting: `EMBED_RATE_LIMIT` (default: 100)
- Auth requirement: `EMBED_REQUIRE_AUTH` (default: false)
- API route: `src/app/api/embed/chat/`

---

*Integration audit: 2026-03-08*
