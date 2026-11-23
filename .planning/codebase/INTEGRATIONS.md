---
last_mapped_commit: 41a47818ac26f9ea788ccb18230fb3351065c2a2
last_mapped_at: 2026-11-22
---
# External Integrations

**Analysis Date:** 2026-11-22

## APIs & External Services

**LLM and model routing:**
- OpenAI - Chat models (e.g. `gpt-4o`, `gpt-4o-mini`), embeddings (`text-embedding-3-small` default, `text-embedding-3-large`, `text-embedding-ada-002` referenced), image generation (`gpt-image-1`), vision captioning of uploaded images, Whisper (`whisper-1`) transcription, TTS (`tts-1`)
  - SDK/Client: `openai` (`src/lib/**`, `src/app/api/**`, `voice-agent/src/agent.ts`)
  - Auth: `OPENAI_API_KEY`
- OpenRouter - Multi-model gateway (Anthropic Claude, DeepSeek, Gemini and others, e.g. `anthropic/claude-*`, `deepseek/deepseek-*`)
  - SDK/Client: `@openrouter/ai-sdk-provider` (`src/lib/openrouter.ts`), `openai` client with OpenRouter base URL
  - Auth: `OPENROUTER_API_KEY`
  - Model metadata lookup: `src/app/api/config/openrouter-model-info/route.ts`
- Groq - OpenAI-compatible endpoint `https://api.groq.com/openai/v1` for chat (voice agent option and model list)
  - Auth: `GROQ_API_KEY`, model list `GROQ_MODELS`
- Google Gemini - Referenced as a model family (via OpenRouter and model config); no direct Google AI SDK dependency
- Anthropic - Referenced as a model family (via OpenRouter); no direct Anthropic SDK dependency

**Media generation:**
- Replicate - Image, image-to-image, video, and 3D generation
  - SDK/Client: `replicate` and `@ai-sdk/replicate`
  - Auth: `REPLICATE_API_TOKEN`; model IDs `REPLICATE_IMAGE_MODEL`, `REPLICATE_IMAGE_TO_IMAGE_MODEL`, `REPLICATE_VIDEO_MODEL`, `REPLICATE_3D_MODEL`; provider switch `USE_REPLICATE_PROVIDER`
  - Output hosted at `replicate.delivery` (allowed in `next.config.js` image remote patterns)
- fal.ai - Flux and other image models
  - SDK/Client: `@fal-ai/client`, `@fal-ai/serverless-client`, `@ai-sdk/fal`
  - Auth: `FAL_API_KEY`; switch `USE_FAL_PROVIDER`
- OpenAI image generation - see OpenAI above; options `OPENAI_IMAGE_QUALITY`, `OPENAI_IMAGE_FORMAT`, `OPENAI_IMAGE_BACKGROUND`, `OPENAI_IMAGE_MODERATION`; switch `USE_OPENAI_IMAGE`, `IMAGE_GENERATION_PROVIDER`
- Generation routes: `src/app/api/generate-image/route.ts`, `src/app/api/generate-video/route.ts`, `src/app/api/generate-3d/route.ts`
- Video and 3D providers also named in project docs: Luma, Runway, Meshy. No SDK or endpoint for these appears in the code, so treat them as not integrated.

**Document parsing:**
- LlamaCloud (LlamaParse) - Document parsing and chunking
  - Client: direct HTTP to `https://api.cloud.llamaindex.ai/api/v...` (`parsing/upload`, `parsing/job/...`) from the document pipeline (`src/lib/document-processor.ts`)
  - Auth: `LLAMA_CLOUD_API_KEY`; base `LLAMA_CLOUD_API_BASE`; chunking `LLAMACLOUD_CHUNK_STRATEGY`, `LLAMACLOUD_CHUNK_SIZE`, `LLAMACLOUD_CHUNK_OVERLAP`

**Web search and scraping:**
- Exa - Web search used by strict RAG when `webSearch` is enabled (`src/app/api/chat/route.ts`, `src/app/api/web-search/route.ts`)
  - SDK/Client: `exa-js`
  - Auth: `EXA_API_KEY`
- Firecrawl - Scrape and crawl of URLs
  - SDK/Client: `@mendable/firecrawl-js`; wrappers in `src/lib/scrapers/firecrawl-client.ts` and `src/lib/scrapers/scraper-adapter.ts`
  - Auth: `FIRECRAWL_API_KEY`; toggle `FIRECRAWL_ENABLED`; options `FIRECRAWL_ONLY_MAIN_CONTENT`, `FIRECRAWL_WAIT_FOR_JS`, `FIRECRAWL_OUTPUT_FORMAT`
  - Routes: `src/app/api/scrapers/scrape/route.ts`, `src/app/api/scrapers/crawl/route.ts`, `src/app/api/scrapers/status/route.ts`
- Brave Search - Optional MCP endpoint `MCP_BRAVE_SEARCH_ENDPOINT`

**Voice:**
- LiveKit Cloud - Real-time audio rooms and participant tokens
  - SDK/Client: `livekit-client`, `@livekit/components-react` (frontend), `livekit-server-sdk` (token minting in `src/app/api/livekit/token/route.ts`), `@livekit/agents`, `@livekit/rtc-node` (voice agent)
  - Auth: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- AssemblyAI - Streaming speech-to-text (48 kHz, multilingual)
  - SDK/Client: `assemblyai` (`voice-agent/src/providers/assemblyai.ts`)
  - Auth: `ASSEMBLYAI_API_KEY`; language `ASSEMBLYAI_LANGUAGE` (default `en` in `voice-agent/fly.toml`)
- Resemble.ai - Text-to-speech with word-level timestamps, streamed over WebSocket
  - Client: HTTP and WebSocket against `p.cluster.resemble.ai` / `f.cluster.resemble.ai` (`RESEMBLE_STREAM_URL`)
  - Auth: `RESEMBLE_API_KEY`, `RESEMBLE_PROJECT_ID`, `RESEMBLE_VOICE_ID`
  - Fallback: estimated word timings when timestamp requests fail (per `AGENTS.md`)
- ElevenLabs - Alternate TTS provider
  - Client: HTTP against `api.elevenlabs.io`
  - Settings: `ELEVENLABS_VOICE_STABILITY`, `ELEVENLABS_VOICE_SPEED`, `ELEVENLABS_SIMILARITY_BOOST`; provider switch `TTS_PROVIDER`
- Silero VAD - Local voice activity detection (`@livekit/agents-plugin-silero`), no external API

**Connectors (OAuth and sync):**
- Nango - Unified OAuth and data sync for Google Drive, Notion, and Dropbox
  - SDK/Client: `@nangohq/node` (server, `src/lib/nango/client.ts`), `@nangohq/frontend` (`src/lib/hooks/use-nango.ts`)
  - Auth: `NANGO_SECRET_KEY`; host `NANGO_HOST`; toggle `NANGO_ENABLED` and `NEXT_PUBLIC_NANGO_ENABLED`
  - Sync: `src/lib/nango/sync-manager.ts`, `src/lib/nango/file-fetcher.ts`, `src/lib/nango/document-adapter.ts`; interval `NANGO_SYNC_INTERVAL_HOURS`; limits `NANGO_MAX_FILES_PER_SYNC`, `NANGO_SUPPORTED_FILE_TYPES`
  - Dropbox file content is fetched from `content.dropboxapi.com`
  - Setup docs: `README_NANGO_INTEGRATION.md`
- Google Drive - Accessed through Nango; MIME types in `GOOGLE_DRIVE_SUPPORTED_MIMETYPES`

**Payments:**
- Stripe - Subscriptions and checkout
  - SDK/Client: `stripe` (`src/lib/stripe.ts`)
  - Auth: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`; plan prices `STRIPE_PRICE_ID_PRO`, `STRIPE_PRICE_ID_ENTERPRISE` (also `NEXT_PUBLIC_STRIPE_PRICE_ID_*`)
  - Routes: `src/app/api/create-stripe-checkout/route.ts`, `src/app/api/webhooks/stripe/route.ts`; page `src/app/pricing-stripe/page.tsx`
- Polar - Alternate subscriptions and one-off sales
  - Auth: `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_ORGANIZATION_ID`, `POLAR_ORGANIZATION_SLUG`, `POLAR_PRICE_ID_PRO`, `POLAR_PRICE_ID_ENTERPRISE`, `POLAR_CHECKOUT_PRO`, `POLAR_CHECKOUT_ENTERPRISE`; API base `POLAR_API_BASE` (sandbox or production)
  - Routes: `src/app/api/create-checkout/route.ts`, `src/app/api/webhooks/route.ts`; page `src/app/pricing/page.tsx`

**Email:**
- Resend - Transactional email
  - Auth: `RESEND_API_KEY`
  - Client: HTTP API (no SDK in `package.json`)

**Messaging:**
- WhatsApp via Baileys - WhatsApp Web session management, QR pairing, message send and receive
  - Service: `baileys-whatsapp/` (Express server, `server.ts`), Fly.io (`baileys-whatsapp/fly.toml`) or Koyeb
  - Client code: `src/lib/whatsapp/client-factory.ts`, `src/lib/whatsapp/koyeb-client.ts`, `src/lib/whatsapp/session-manager.ts`, `src/lib/whatsapp/connection-monitor.ts`, `src/lib/whatsapp/webhook-handler.ts`, `src/lib/whatsapp/message-converter.ts`
  - Provider selection: `WHATSAPP_PROVIDER`; service URLs `BAILEYS_URL`, `KOYEB_BAILEYS_URL`; `KOYEB_API_KEY`
  - Shared secret: `WHATSAPP_WEBHOOK_SECRET`; callback URL `WHATSAPP_WEBHOOK_URL`
  - Limits and defaults: `WHATSAPP_MAX_SESSIONS_PER_USER`, `WHATSAPP_MESSAGE_QUEUE_SIZE`, `WHATSAPP_DEFAULT_MODEL`, `WHATSAPP_MAX_TOKENS`, `WHATSAPP_ENABLE_WEB_SEARCH`, `WHATSAPP_ENABLE_MCP`
  - Routes: `src/app/api/whatsapp/*` (`webhook`, `connect`, `qr`, `status`, `disconnect`, `conversations`, `monitor`, `provider-info`, `test`, `test-numbers`)
  - Setup docs: `README_WHATSAPP_INTEGRATION.md`
  - Note: Baileys uses an unofficial WhatsApp Web protocol. Account bans and protocol breakage are operational risks.

**Model Context Protocol (MCP):**
- Zapier MCP server - Tool execution via `MCP_ZAPIER_ENDPOINT`
- Custom MCP servers - `MCP_CUSTOM_SERVERS` (JSON list), plus `MCP_YOURSERVER_ENDPOINT` pattern
- Client: `@modelcontextprotocol/sdk`, `@ai-sdk/mcp`; router and approval flow in `src/lib/mcp/` and `src/app/api/chat/approve/route.ts`
- Toggles: `MCP_SYSTEM_ENABLED`, `NEXT_PUBLIC_MCP_SYSTEM_ENABLED`, `MCP_TOOLS_ENABLED`, `MCP_TOOLS_LIST_ENABLED`, `MCP_YOLO_MODE_ENABLED`, `MCP_TOOL_PATTERNS`, `MCP_PROVIDERS`

**Other external hosts referenced:**
- `https://api.openai.com`, `https://openrouter.ai`, `https://api.groq.com`, `https://api.nango.dev`, `https://api.elevenlabs.io`

## Data Storage

**Databases:**
- Supabase PostgreSQL (with pgvector)
  - Connection: `NEXT_PUBLIC_SUPABASE_URL` (public), `SUPABASE_ANON_KEY` (browser/anon), `SUPABASE_SERVICE_ROLE_KEY` (server only, bypasses RLS)
  - Client: `@supabase/supabase-js`, `@supabase/ssr`, `@supabase/auth-helpers-nextjs` (server clients in `src/lib/` and API routes)
  - Vector search: 1536-dimension embeddings in `document_chunks`, HNSW indexes (`m=64`, `ef_construction=200`), retrieval through Postgres RPC (`match_documents`)
  - Tables referenced in the app include chats, documents, `document_chunks` (embeddings and `metadata.image_url`), subscriptions, WhatsApp sessions
  - Schema: `supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql`, instructions in `supabase/README.md`
  - RLS: multi-tenant policies enforce per-user isolation. Do not bypass with the service role key in user-facing paths.

**File Storage:**
- Supabase Storage - Uploaded documents and generated media. Public URLs match `/storage/v1/object/public/**` (see `next.config.js`).
- Google Drive, Notion, Dropbox - Read-only sync sources via Nango (see Connectors)

**Caching:**
- In-memory `@cacheable/node-cache` in the WhatsApp service (`baileys-whatsapp/`)
- Client-side Zustand stores; no Redis or external cache detected

## Authentication & Identity

**Auth Provider:**
- Supabase Auth
  - Methods per `AGENTS.md`: GitHub OAuth, email and password, magic links
  - Callback: `src/app/auth/callback/page.tsx`
  - Implementation: Supabase session cookies via `@supabase/ssr`; server routes verify the session and enforce RLS
- Admin access for the config dashboard and admin features: `ADMIN_EMAIL`, `ADMIN_PASSWORD`
- Internal service-to-service calls: `MYRAG_INTERNAL_API_KEY` (shared secret for internal API routes)
- Embed widget: `src/app/api/embed/chat/route.ts`, served with frame-ancestors headers in `vercel.json`

## Monitoring & Observability

**Error Tracking:**
- None detected (no Sentry or similar SDK in `package.json`)

**Analytics:**
- Vercel Analytics via `@vercel/analytics`

**Logs:**
- `console` logging throughout. Retrieval logs are tagged `[Document Search]` (see `AGENTS.md`).
- WhatsApp service uses `pino`.
- Provider health and status: `src/app/api/whatsapp/monitor/route.ts`, `src/app/api/whatsapp/status/route.ts`

## CI/CD & Deployment

**Hosting:**
- Main app: Vercel (`vercel.json`, `.vercelignore`, `github.silent: true`)
- Voice agent: Fly.io (`voice-agent/fly.toml`, `voice-agent/Dockerfile`)
- WhatsApp service: Fly.io (`baileys-whatsapp/fly.toml`, `baileys-whatsapp/Dockerfile`, `baileys-whatsapp/DEPLOYMENT.md`) or Koyeb
- Database and storage: Supabase hosted project

**CI Pipeline:**
- None detected. No `.github/workflows/` directory in the repository.

## Environment Configuration

**Required env vars (names only, for a minimal working app):**
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY` (embeddings and vision, required for RAG ingestion)
- `OPENROUTER_API_KEY` or another chat provider key
- `NEXT_PUBLIC_SITE_URL`
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` for the config dashboard

**Feature-specific (only when the feature is enabled):**
- Voice: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ASSEMBLYAI_API_KEY`, `RESEMBLE_API_KEY`
- Documents: `LLAMA_CLOUD_API_KEY`
- Search: `EXA_API_KEY`, `FIRECRAWL_API_KEY`
- Media: `REPLICATE_API_TOKEN`, `FAL_API_KEY`
- Payments: `STRIPE_*` or `POLAR_*`
- Connectors: `NANGO_SECRET_KEY`, `NANGO_WEBHOOK_SECRET`
- WhatsApp: `WHATSAPP_PROVIDER`, `BAILEYS_URL` or `KOYEB_BAILEYS_URL`, `WHATSAPP_WEBHOOK_SECRET`
- Email: `RESEND_API_KEY`
- MCP: `MCP_ZAPIER_ENDPOINT` or `MCP_CUSTOM_SERVERS`

**Secrets location:**
- Local: `.env.local` at repo root, generated and edited through `npm run dev` and `npm run config` (port 3333). Git-ignored.
- Deployed: Vercel project environment variables, Fly.io secrets (`fly secrets`), Koyeb environment settings.
- Template defaults: `scripts/init-env.js`. Keep this file in sync with `src/lib/env.ts`, `scripts/config-server.js`, and `scripts/config-ui/index.html` when adding variables.
- Env files are never read or copied into project docs.

## Webhooks & Callbacks

**Incoming:**
- `src/app/api/webhooks/stripe/route.ts` - Stripe events, verified with `STRIPE_WEBHOOK_SECRET`
- `src/app/api/webhooks/route.ts` - Polar events, verified with `POLAR_WEBHOOK_SECRET`
- `src/app/api/nango/webhook/route.ts` - Nango sync and connection events, verified with `NANGO_WEBHOOK_SECRET`
- `src/app/api/whatsapp/webhook/route.ts` - Inbound WhatsApp messages from the Baileys service, verified with `WHATSAPP_WEBHOOK_SECRET`
- `src/app/api/chat/approve/route.ts` - MCP tool approval callbacks from the UI
- `src/app/api/embed/chat/route.ts` - Embed widget chat endpoint

**Outgoing:**
- WhatsApp service callbacks to `WHATSAPP_WEBHOOK_URL` (the app's `/api/whatsapp/webhook`)
- Outbound HTTP calls to LlamaCloud, Exa, Firecrawl, Resemble, ElevenLabs, Stripe, Polar, Resend, Nango, and MCP endpoints (listed above)

---

*Integration audit: 2026-11-22*
