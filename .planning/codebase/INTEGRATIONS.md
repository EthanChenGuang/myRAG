# External Integrations

**Analysis Date:** 2026-03-08

## APIs & External Services

**AI/LLM Providers:**
- OpenRouter - Primary multi-model gateway (Anthropic, OpenAI, Google, Meta, etc.)
  - SDK/Client: `@openrouter/ai-sdk-provider` via `createOpenRouter()` in `src/app/api/chat/route.ts`; also raw `openai` SDK with custom baseURL in `src/lib/openrouter.ts`
  - Auth: `OPENROUTER_API_KEY`
  - Base URL: `https://openrouter.ai/api/v1`

- OpenAI - Embeddings, TTS/STT, image generation (GPT-Image-1)
  - SDK/Client: `openai` ^4.103.0, `@ai-sdk/openai`
  - Auth: `OPENAI_API_KEY`
  - Embedding model: configurable via `OPENAI_EMBEDDING_MODEL` (default: `text-embedding-3-small`)
  - Used in: `src/lib/document-processor.ts`, `src/app/api/audio/route.ts`, `src/app/api/generate-image/route.ts`

- Fal.ai - Image generation (Flux), video generation (Veo3), 3D generation (Trellis)
  - SDK/Client: `@fal-ai/client`
  - Auth: `FAL_API_KEY`
  - Models: `fal-ai/veo3/fast` (video), `fal-ai/trellis` (3D), configurable via env vars
  - Used in: `src/app/api/generate-image/route.ts`, `src/app/api/generate-video/route.ts`, `src/app/api/generate-3d/route.ts`

- Replicate - Fallback provider for image/video/3D generation
  - SDK/Client: `replicate` ^1.0.1, `@ai-sdk/replicate`
  - Auth: `REPLICATE_API_TOKEN`
  - Used in: `src/app/api/generate-image/route.ts`, `src/app/api/generate-video/route.ts`, `src/app/api/generate-3d/route.ts`

- ElevenLabs - Text-to-speech, speech-to-text
  - SDK/Client: Direct REST API via `src/lib/elevenlabs-utils.ts`
  - Auth: `ELEVENLABS_API_KEY`
  - Configurable voice, model, stability, speed settings

**Document Processing:**
- LlamaCloud (LlamaParse) - Document parsing (PDF, DOCX, etc.)
  - SDK/Client: Direct REST API calls to `https://api.cloud.llamaindex.ai/api` in `src/lib/document-processor.ts`
  - Auth: `LLAMA_CLOUD_API_KEY`
  - Advanced config: parsing mode, chunk strategy, OCR, table extraction

- Firecrawl - Web scraping and URL content extraction
  - SDK/Client: `@mendable/firecrawl-js` via `src/lib/scrapers/firecrawl-client.ts`
  - Auth: `FIRECRAWL_API_KEY`
  - Feature flag: `NEXT_PUBLIC_FIRECRAWL_ENABLED`

- Exa - Web search
  - SDK/Client: `exa-js` ^1.8.26
  - Auth: `EXA_API_KEY`
  - Feature flag: `NEXT_PUBLIC_WEB_SEARCH_ENABLED`

**Tool Integration:**
- Model Context Protocol (MCP) - External tool execution
  - SDK/Client: `@modelcontextprotocol/sdk` ^1.15.0 via `src/lib/mcp/universal-client.ts`
  - Router: `src/lib/mcp/smart-router.ts`, `src/lib/mcp/production-router.ts`
  - Discovery: `src/lib/mcp/discovery.ts`, `src/lib/mcp/universal-discovery.ts`
  - Transports: `src/lib/mcp/transports/`
  - Approval flow: `src/app/api/chat/approve/route.ts`
  - Zapier endpoint: `MCP_ZAPIER_ENDPOINT`
  - YOLO mode: `NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED` (auto-approve tool calls)

**Document Connectors:**
- Nango - Third-party document source integration (Google Drive, Dropbox, etc.)
  - SDK/Client: `@nangohq/node` (server), `@nangohq/frontend` (client) via `src/lib/nango/`
  - Auth: `NANGO_SECRET_KEY`, `NANGO_WEBHOOK_SECRET`
  - Host: `NANGO_HOST` (default: `https://api.nango.dev`)
  - Feature flag: `NEXT_PUBLIC_NANGO_ENABLED`
  - Sync manager: `src/lib/nango/sync-manager.ts`
  - File fetcher: `src/lib/nango/file-fetcher.ts`
  - Document adapter: `src/lib/nango/document-adapter.ts`

## Data Storage

**Database:**
- Supabase (PostgreSQL + pgvector)
  - Connection: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - Client (browser): `src/lib/supabase/client.ts` using `@supabase/ssr` `createBrowserClient`
  - Client (server): `src/lib/supabase/server.ts` using `@supabase/ssr` `createServerClient` with cookie handling
  - Admin client: `src/lib/supabase.ts` (service role key, bypasses RLS)
  - Middleware session refresh: `src/lib/supabase/middleware.ts`
  - Schema files: `supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql`
  - Tables: `chats`, `documents`, `document_chunks` (with vector embeddings)
  - Vector search: 1536-dim embeddings, HNSW indexes (`m=64`, `ef_construction=200`)
  - RPC function: `match_document_chunks` for similarity search
  - Row Level Security enforced across all tables

**File Storage:**
- Supabase Storage - Generated images, videos, 3D assets, uploaded documents
  - Remote patterns configured in `next.config.js` for image optimization
  - Admin client used for storage operations in generation routes

**Caching:**
- MCP tool cache: In-memory via `src/lib/mcp-cache.ts`
- No external cache service (Redis, etc.)

## Authentication & Identity

**Auth Provider:**
- Supabase Auth
  - Implementation: `@supabase/ssr` with cookie-based sessions
  - Methods: Email/password, GitHub OAuth, magic links
  - Auth helpers: `src/lib/supabase-auth.ts` (client-side sign-in functions)
  - Server middleware: `src/lib/supabase/middleware.ts` (session refresh)
  - Multi-tenant: Organization handler at `src/lib/auth/organization-handler.ts`
  - Deployment modes: Single-tenant (default) or multi-tenant with organizations

## Monitoring & Observability

**Analytics:**
- Vercel Analytics (`@vercel/analytics` ^1.5.0)

**Error Tracking:**
- None (console.error logging only)

**Logs:**
- Custom logger: `src/lib/logger.ts` with levels (debug, warn, error, db, startup)
- Dev logger: `src/lib/dev-logger.ts`
- Performance monitor: `src/lib/performance-monitor.tsx`

## CI/CD & Deployment

**Hosting:**
- Vercel (primary, inferred from Next.js + `@vercel/analytics` + server actions config)
- WhatsApp Baileys: Fly.io or Koyeb (`WHATSAPP_PROVIDER` selects deployment)

**CI Pipeline:**
- Not detected (no `.github/workflows`, no CI config files found)

**Database Setup:**
- `scripts/setup-database.sh` - Applies SQL schema via Supabase PostgreSQL connection
- `npm run db:setup` - Wrapper command

## Payments & Billing

**Stripe:**
- SDK/Client: `stripe` ^17.6.0, API version `2025-01-27.acacia` in `src/lib/stripe.ts`
- Auth: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- Public: `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_STRIPE_PRICE_ID_PRO`, `NEXT_PUBLIC_STRIPE_PRICE_ID_ENTERPRISE`
- Features: Checkout sessions (subscription mode), webhook verification, subscription/customer retrieval
- Webhook route: `src/app/api/webhooks/stripe/`
- Checkout route: `src/app/api/create-stripe-checkout/`

**Polar (Alternative):**
- Client: Direct REST API in `src/lib/polar.ts`
- Base URL: `https://polar.sh` (production), `https://sandbox.polar.sh` (development)
- Auth: `NEXT_PUBLIC_POLAR_PRICE_ID_PRO`, `NEXT_PUBLIC_POLAR_CHECKOUT_PRO`, etc.
- Checkout route: `src/app/api/create-checkout/`
- Webhook verification: TODO (HMAC not yet implemented)

## Environment Configuration

**Required env vars:**
- `OPENAI_API_KEY` - Embeddings, TTS/STT, image generation
- `SUPABASE_SERVICE_ROLE_KEY` - Admin database operations
- `NEXT_PUBLIC_SUPABASE_URL` - Database connection
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Client-side database access

**Optional but recommended:**
- `OPENROUTER_API_KEY` - Multi-model chat (primary AI provider)
- `FAL_API_KEY` - Image/video/3D generation
- `REPLICATE_API_TOKEN` - Fallback generation provider
- `STRIPE_SECRET_KEY` - Payments
- `EXA_API_KEY` - Web search
- `LLAMA_CLOUD_API_KEY` - Document parsing
- `ELEVENLABS_API_KEY` - Voice TTS/STT
- `FIRECRAWL_API_KEY` - Web scraping
- `NANGO_SECRET_KEY` - Document connectors

**Secrets location:**
- `.env.local` (auto-generated by `scripts/init-env.js`)
- Never committed to git

## Webhooks & Callbacks

**Incoming:**
- `src/app/api/webhooks/route.ts` - General webhook handler
- `src/app/api/webhooks/stripe/` - Stripe payment events
- `src/app/api/whatsapp/webhook/` - WhatsApp message events
- `src/app/api/nango/` - Nango sync completion events (via `NANGO_WEBHOOK_SECRET`)

**Outgoing:**
- WhatsApp message delivery via Baileys (Fly.io/Koyeb)
- `WHATSAPP_WEBHOOK_URL` - Configured outbound webhook

## WhatsApp Integration

**Architecture:**
- Provider factory pattern: `src/lib/whatsapp/client-factory.ts`
- Base client: `src/lib/whatsapp/base-client.ts`
- Fly.io client: `src/lib/whatsapp/flyio-client.ts`
- Koyeb client: `src/lib/whatsapp/koyeb-client.ts`
- Session manager: `src/lib/whatsapp/session-manager.ts`
- Connection monitor: `src/lib/whatsapp/connection-monitor.ts`
- Message converter: `src/lib/whatsapp/message-converter.ts`
- Webhook handler: `src/lib/whatsapp/webhook-handler.ts`
- Auth: `KOYEB_API_KEY` / `FLYIO_API_KEY`, `WHATSAPP_WEBHOOK_SECRET`
- Feature flag: `NEXT_PUBLIC_WHATSAPP_ENABLED`
- API routes: `src/app/api/whatsapp/` (connect, disconnect, qr, status, webhook, conversations, monitor, test)

---

*Integration audit: 2026-03-08*
