<overview>
myRAG integrates with multiple external services: MCP tool servers, WhatsApp (via Baileys), Stripe/Polar payments, Nango document connectors, Firecrawl web scraping, and various AI generation providers.
</overview>

<mcp_system>

## MCP (Model Context Protocol)

**Architecture:**
- Smart Router: `src/lib/mcp/smart-router.ts` - Query analysis, tool selection, fallback handling
- Universal Client: `src/lib/mcp/universal-client.ts` - Singleton, tool discovery, execution
- Universal Discovery: `src/lib/mcp/universal-discovery.ts` - Intent classification, server discovery
- Production Router: `src/lib/mcp/production-router.ts` - Rate limiting, monitoring
- Transport Factory: `src/lib/mcp/transport-factory.ts` - SSE, HTTP, Streamable HTTP
- Query Classifier: `src/lib/query-classifier.ts` - Determines if query needs MCP tools

**Flow:**
1. `classifyQuery(query)` → determines if MCP needed (confidence, category)
2. `SmartMcpRouter.analyzeAndRoute(query)` → selects best tool + fallbacks
3. Approval check (unless YOLO mode: `NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED`)
4. `UniversalMcpClient.executeTool(toolName, params)` → execute
5. Result displayed in `McpToolBox` component

**Configuration:**
- `MCP_ZAPIER_ENDPOINT` - Zapier MCP server
- `MCP_CUSTOM_SERVERS` - JSON array of custom server configs
- Server schema: `{ id, name, endpoint, type: 'http'|'sse', authentication, settings, enabled }`

**Tool execution states:** Tracked in `tool_execution_states` table
- Flow: pending → approved → running → completed/error/cancelled

</mcp_system>

<whatsapp>

## WhatsApp Integration

**Architecture:** Provider factory pattern selecting Fly.io or Koyeb Baileys deployment.

**Files in `src/lib/whatsapp/`:**
- `client-factory.ts` - Provider selection based on `WHATSAPP_PROVIDER` env var
- `base-client.ts` - Base implementation
- `flyio-client.ts` - Fly.io provider
- `koyeb-client.ts` - Koyeb provider
- `webhook-handler.ts` - Webhook processing
- `session-manager.ts` - Session lifecycle
- `connection-monitor.ts` - Health checks
- `message-converter.ts` - Format conversion
- `types.ts` - Type definitions

**API Routes:** `/api/whatsapp/*` (status, qr, connect, disconnect, monitor, webhook, conversations, test, test-numbers, provider-info)

**Key Config:**
- `WHATSAPP_PROVIDER`: `flyio` (default) or `koyeb`
- `WHATSAPP_DEFAULT_MODEL`: `openai/gpt-4o-mini`
- `WHATSAPP_MAX_SESSIONS_PER_USER`: 5
- `WHATSAPP_ENABLE_MCP`: false (MCP tools in WhatsApp)
- `WHATSAPP_ENABLE_WEB_SEARCH`: false

</whatsapp>

<payments>

## Payments (Stripe & Polar)

**Stripe** (`src/lib/stripe.ts`):
- Lazy initialization, API version `2025-01-27.acacia`
- `getStripeCheckoutUrl(priceId, successUrl, cancelUrl)`
- `verifyStripeWebhookSignature(payload, signature, webhookSecret)`
- Routes: `/api/create-stripe-checkout`, `/api/webhooks/stripe`
- Subscription tracking in `subscriptions` table

**Polar** (`src/lib/polar.ts`):
- Alternative payment provider
- Route: `/api/create-checkout`
- Uses `POLAR_ACCESS_TOKEN`, `POLAR_ORGANIZATION_ID`

</payments>

<nango>

## Nango Document Connectors

**Files in `src/lib/nango/`:**
- `client.ts` - Nango API client
- `types.ts` - Type definitions
- `sync-manager.ts` - Document sync orchestration
- `file-fetcher.ts` - File retrieval from connected sources
- `document-adapter.ts` - Format conversion
- `index.ts` - Exports

**Purpose:** Connect external document sources (Google Drive, Dropbox, OneDrive, Notion)
- Supported types: `NANGO_SUPPORTED_FILE_TYPES` (pdf, doc, docx, txt, md, html, pptx, xlsx)
- Max files per sync: 100
- Sync interval: 1 hour

**API Routes:** `/api/nango/*` (connections, files, folders, notion/pages, sync, session, webhook)

</nango>

<web_scraping>

## Web Scraping (Firecrawl)

**Client:** `src/lib/scrapers/firecrawl-client.ts`
**Adapter:** `src/lib/scrapers/scraper-adapter.ts`

**Config:**
- `FIRECRAWL_API_KEY` - API key
- `FIRECRAWL_ONLY_MAIN_CONTENT` - Extract main content only (default: true)
- `FIRECRAWL_WAIT_FOR_JS` - JS wait time in ms (default: 2000)

**Routes:** `/api/scrapers/scrape` (single URL), `/api/scrapers/crawl` (domain)

</web_scraping>

<ai_providers>

## AI Generation Providers

**Image Generation:**
- Fal.ai (default): SeedReam v4 text-to-image and edit
- OpenAI: DALL-E / GPT Image
- Replicate: Fallback provider
- Storage: `chat-images` Supabase bucket

**Video Generation:**
- Fal.ai (default): Veo3 text-to-video, image-to-video
- Replicate: Fallback
- Storage: `chat-videos/{date}/` prefix

**3D Generation:**
- Fal.ai: Trellis
- Replicate: Trellis (fallback)
- Storage: `3d-models` bucket

**Audio:**
- OpenAI: Whisper (STT), TTS-1 (TTS)
- ElevenLabs: TTS with voice selection
- Fallback: ElevenLabs → OpenAI

**Web Search:**
- OpenRouter with Haiku model + web search plugin
- Exa API for structured search
- Types: general, weather, stock

</ai_providers>
