---
last_mapped_commit: 41a47818ac26f9ea788ccb18230fb3351065c2a2
last_mapped_at: 2026-11-22
---
<!-- refreshed: 2026-11-22 -->
# Architecture

**Analysis Date:** 2026-11-22

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│  Browser UI (Next.js App Router, React 19 client components)        │
│  `src/app/page.tsx`  `src/app/client-layout.tsx`  `src/components/` │
│  Zustand stores `src/lib/*-store.ts`, `src/lib/stores/`            │
└───────────────┬──────────────────────────────┬──────────────────────┘
                │ fetch / useChat (SSE)        │ Supabase JS (auth, RLS)
                ▼                              │
┌───────────────────────────────────────┐      │
│  Next.js API routes (Node runtime)    │      │
│  `src/app/api/**/route.ts` (~88)      │      │
│  Chat: `src/app/api/chat/route.ts`    │      │
└───┬──────────┬───────────┬────────────┘      │
    │          │           │                   │
    ▼          ▼           ▼                   ▼
┌────────┐ ┌─────────┐ ┌──────────────┐ ┌──────────────────────┐
│ RAG    │ │ MCP     │ │ AI providers │ │ Supabase (Postgres + │
│ `src/  │ │ router  │ │ `src/lib/    │ │ pgvector, storage,   │
│ lib/`  │ │ `src/lib│ │ openrouter`  │ │ auth) `supabase/`    │
│        │ │ /mcp/`  │ │ `@ai-sdk/*`  │ │                      │
└───┬────┘ └────┬────┘ └──────────────┘ └──────────▲───────────┘
    └───────────┴──────────── writes/reads ──────────┘

Side services (separate processes, separate deploys):
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ Voice agent `voice-agent/`   │   │ WhatsApp Baileys service     │
│ LiveKit + AssemblyAI + TTS   │   │ `baileys-whatsapp/server.ts` │
│ calls RAG via RAGClient      │   │ Express, called by Next.js   │
│ `voice-agent/src/rag_client.ts`│ │ `src/lib/whatsapp/`          │
└──────────────────────────────┘   └──────────────────────────────┘
Admin tooling: `scripts/config-server.js` (Express, port 3333) + `scripts/config-ui/`
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Root layout and providers | Fonts, theme, auth, model, language, sources, artifact providers | `src/app/layout.tsx`, `src/app/client-layout.tsx` |
| Main chat page | Chat UI state, message streaming via `useChat`, sidebar, persistence | `src/app/page.tsx` |
| Chat API | Query classification, RAG retrieval, MCP tool planning, `streamText` streaming, persistence | `src/app/api/chat/route.ts` |
| MCP approval | Executes approved MCP tool calls | `src/app/api/chat/approve/route.ts` |
| Document ingestion | Parsing, token-based chunking, embeddings, image captioning | `src/lib/document-processor.ts`, `src/app/api/process-document/route.ts`, `src/app/api/upload/route.ts` |
| Retrieval | Enhanced vector retrieval, comprehensive/aggregate strategies, reranking, MMR, BM25 | `src/lib/enhanced-rag-retrieval.ts`, `src/lib/retrieval-strategies.ts`, `src/lib/optimized-search.ts`, `src/lib/mmr-scorer.ts`, `src/lib/bm25-scorer.ts`, `src/lib/reranker-local.ts` |
| Query classification | Intent, tool-need, and temporal detection | `src/lib/query-classifier.ts`, `src/lib/temporal-query-detector.ts` |
| Supabase access | Singleton browser/admin clients, chat and document persistence | `src/lib/supabase.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, `src/lib/supabase/middleware.ts` |
| MCP integration | Universal client, transports, smart and production routers, caching | `src/lib/mcp/`, `src/lib/mcp-cache.ts` |
| Nango connectors | Google Drive / Notion / Dropbox sync into `document_chunks` | `src/lib/nango/`, `src/app/api/nango/` |
| WhatsApp | Provider factory (Koyeb or Fly.io) and webhook handling | `src/lib/whatsapp/client-factory.ts`, `src/lib/whatsapp/webhook-handler.ts` |
| Deployment mode | Single vs multi-tenant feature gating | `src/lib/deployment-mode.ts` |
| Env access | Typed environment access and defaults | `src/lib/env.ts`, `src/lib/env-utils.ts` |
| Voice pipeline | LiveKit agent, VAD, STT, LLM, TTS, query rewriting | `voice-agent/src/agent.ts`, `voice-agent/src/voice_agent.ts` |
| Config dashboard | Visual env, admin, model, and RAG prompt management | `scripts/config-server.js`, `scripts/config-ui/index.html` |

## Pattern Overview

**Overall:** Monolithic Next.js App Router application (frontend and API routes in one project) with several auxiliary services in subdirectories. Business logic lives in `src/lib/` and is called from route handlers. Persistence and auth are delegated to Supabase.

**Key Characteristics:**
- Single Next.js project; `@/` path alias maps to `src/` (`tsconfig.json`).
- All API handlers are Next.js route handlers (`route.ts`) exporting `POST`/`GET`, with `export const runtime = 'nodejs'` on heavy routes such as `src/app/api/chat/route.ts`.
- The chat endpoint streams Server-Sent Events via the Vercel AI SDK (`streamText`, `createUIMessageStream`) and the client consumes them with `useChat` from `@ai-sdk/react` in `src/app/page.tsx`.
- Client state is held in many small Zustand stores, not a single global store (for example `src/lib/chat-store.ts`, `src/lib/web-search-store.ts`, `src/lib/stores/voice-store.ts`).
- Multi-tenant vs single-tenant behaviour is switched at runtime by `isMultiTenant()` in `src/lib/deployment-mode.ts`, and by SQL setup files in `supabase/`.
- Provider selection is env-driven: `NEXT_PUBLIC_AI_PROVIDER` (`src/app/api/chat/route.ts`), `WHATSAPP_PROVIDER` (`src/lib/whatsapp/client-factory.ts`), `RAG_BEHAVIOR_MODE` (`src/app/api/chat/route.ts`).
- React Compiler and `turbopack.root` are enabled in `next.config.js`.

## Layers

**UI / Presentation:**
- Purpose: Chat, sidebar, settings, artifact preview, voice overlay, config UI components.
- Location: `src/components/`, `src/app/**/page.tsx`
- Contains: React function components, Radix-based primitives in `src/components/ui/`, providers in `src/components/providers/`.
- Depends on: `src/lib/` stores and hooks, `src/types/`, `src/translations/`.
- Used by: Next.js routing only.

**Client state and hooks:**
- Purpose: Zustand stores and React hooks encapsulating client behaviour.
- Location: `src/lib/*-store.ts`, `src/lib/stores/`, `src/lib/hooks/`, `src/hooks/`, `src/contexts/`
- Contains: Stores (chat, web search, file upload, organization, reasoning, voice, admin, user settings, ghost mode), hooks (`use-voice-mode.ts`, `use-nango.ts`, `use-organization.ts`).
- Depends on: `src/lib/supabase/client.ts`, `src/lib/chat-utils.ts`.
- Used by: `src/app/page.tsx` and components.

**API / Route handlers:**
- Purpose: HTTP boundary. Validate input, call services, return JSON or SSE.
- Location: `src/app/api/**/route.ts`
- Contains: About 88 route files across chat, documents, folders, MCP, Nango, WhatsApp, organizations, config, admin, scrapers, generators, internal voice endpoints.
- Depends on: `src/lib/` services, `src/lib/api-middleware.ts` (Zod validation via `withValidation`).
- Used by: Browser UI, the voice agent (`/api/internal/voice-chat`, `/api/internal/voice-rag`), embeds (`/api/embed/chat`), Stripe and Nango webhooks.

**Service / Domain logic:**
- Purpose: RAG, MCP routing, document processing, connectors, WhatsApp, payments.
- Location: `src/lib/`
- Contains: `document-processor.ts`, `enhanced-rag-retrieval.ts`, `thinking-rag-enhancer.ts`, `mcp/*`, `nango/*`, `whatsapp/*`, `stripe.ts`, `polar.ts`, `openrouter.ts`, `scrapers/*`.
- Depends on: `src/lib/env.ts`, `src/lib/supabase.ts`, `src/lib/logger.ts`, external SDKs.
- Used by: API routes.

**Data / Persistence:**
- Purpose: Supabase tables for chats, documents, `document_chunks` with pgvector embeddings, folders, organizations, subscriptions, WhatsApp sessions.
- Location: `src/lib/supabase.ts` (`getSupabase()`, `getSupabaseAdmin()`, `searchSimilarChunks`, `createChat`, `updateChat`), schema in `supabase/single-tenant-setup.sql` and `supabase/multi-tenant-setup.sql`.
- Depends on: `@supabase/supabase-js`, `@supabase/ssr`.
- Used by: All service and route layers.

**Auxiliary services (separate processes):**
- Voice agent: `voice-agent/src/` (`VoicePipeline` in `voice_agent.ts`, LiveKit worker in `agent.ts`, `RAGClient` in `rag_client.ts`, providers in `voice-agent/src/providers/`).
- WhatsApp Baileys: `baileys-whatsapp/server.ts` (Express API with `API_KEY` header check, session map, webhook dispatch) on top of the `src/` Baileys library.
- Config server: `scripts/config-server.js` (Express on port 3333) serving `scripts/config-ui/index.html`, plus admin and RAG helper scripts in `scripts/`.

## Data Flow

### Primary Request Path (chat, streaming)

1. The user submits a message in `src/app/page.tsx`, which sends it through `useChat` with `DefaultChatTransport` to the chat endpoint.
2. `POST` in `src/app/api/chat/route.ts` (line ~1180) parses the body. `ragMode` defaults to `strict`, and `RAG_BEHAVIOR_MODE` env overrides the default.
3. The query is classified (`classifyQuery`, `shouldSkipMcp` from `src/lib/query-classifier.ts`). Image and URL inputs are handled via `src/lib/url-extractor.ts`.
4. Retrieval runs. Query embedding comes from `getQueryEmbedding` in `src/lib/document-processor.ts`. Chunks come from `enhancedRetrieveChunks` (`src/lib/enhanced-rag-retrieval.ts`) or `optimizedSearch` / `comprehensiveRetrieval` (`src/lib/retrieval-strategies.ts`), which call `searchSimilarChunks` in `src/lib/supabase.ts`.
5. MCP tools are considered when `SUPPORTS_TOOLS` is true (provider is openai, openrouter, or groq). Tool cache is in `src/lib/mcp-cache.ts`. Planning goes through `src/lib/mcp/smart-router.ts` and `src/lib/mcp/production-router.ts`, using `src/lib/mcp/universal-client.ts`.
6. The system prompt is built from the `{{context}}` template via `src/lib/system-prompt-manager.ts` and `src/lib/rag-mode.ts`. When strict mode has no useful context and web search is disabled, the route returns a structured "information not available" response.
7. `streamText` (Vercel AI SDK) streams tokens through `createUIMessageStream` / `createUIMessageStreamResponse`. Source metadata, `source_images`, and tool results are attached to the stream.
8. Persistence: `createChat` / `updateChat` in `src/lib/supabase.ts` write messages; the client mirrors them through `src/lib/chat-store.ts`.

### Document Ingestion

1. Upload enters via `src/app/api/upload/route.ts` (images call `processImageDocument`) or `src/app/api/process-document/route.ts` (calls the document processor).
2. `uploadAndParseDocument`, `createTokenBasedChunks` (600 tokens, 100 overlap), and `processChunksInBatches` in `src/lib/document-processor.ts` create chunks and embeddings (1536-dim).
3. Chunks are stored in `document_chunks`. Image chunks carry `metadata.image_url`.
4. Nango connectors use `src/lib/nango/sync-manager.ts` and `src/lib/nango/document-adapter.ts` to feed the same table. Nango webhooks arrive at `src/app/api/nango/webhook/route.ts`.

### Approval Flow for MCP Tools

1. Chat route proposes a tool call and stores state through `src/lib/tool-execution-state.ts` (exposed at `src/app/api/tool-execution-state/route.ts`).
2. The user approves in the UI, which posts to `src/app/api/chat/approve/route.ts`.
3. The approve route runs the tool through the MCP router and returns the result.

### Voice Flow

1. Browser joins a LiveKit room. Token issued by `src/app/api/livekit/token/route.ts`.
2. `voice-agent/src/agent.ts` handles audio, VAD, and the mutex. `voice-agent/src/voice_agent.ts` (`VoicePipeline`) runs STT (`providers/assemblyai.ts`), LLM with query rewriting, and TTS (`providers/resemble.ts`).
3. Retrieval for voice goes through `voice-agent/src/rag_client.ts`, which calls the app's internal voice RAG endpoint (`src/app/api/internal/voice-rag/route.ts`). Voice chat messages are persisted through `src/app/api/internal/voice-chat/route.ts`.

### WhatsApp Flow

1. Inbound messages hit `src/app/api/whatsapp/webhook/route.ts`.
2. Outbound sending and session management go through the provider chosen in `src/lib/whatsapp/client-factory.ts` (`koyeb-client.ts` or `flyio-client.ts`, both extending `base-client.ts`), which calls the Baileys service.
3. `src/lib/whatsapp/session-manager.ts` and `connection-monitor.ts` maintain sessions and health.

**State Management:**
- Server: Stateless route handlers. Chat state persists in Supabase. MCP tool and connection caches are in-process (`src/lib/mcp-cache.ts`).
- Client: Zustand stores plus React state in `src/app/page.tsx`. Store subscriptions use `useShallow` from `zustand/react/shallow`.

## Key Abstractions

**Supabase Connection Manager:**
- Purpose: Single entry point for Supabase clients with build-phase guard and env validation.
- Examples: `src/lib/supabase.ts` (`SupabaseManager`, `getSupabase`, `getSupabaseAdmin`)
- Pattern: Singleton with lazy initialization; `supabase` and `supabaseAdmin` exported as Proxies.

**MCP Router and Client:**
- Purpose: Route natural-language intents to MCP servers and execute tools.
- Examples: `src/lib/mcp/universal-client.ts`, `src/lib/mcp/smart-router.ts` (`SmartMcpRouter`), `src/lib/mcp/production-router.ts` (`ProductionMcpRouter`), `src/lib/mcp/transport-factory.ts`, `src/lib/mcp/transports/`
- Pattern: Strategy-based transports (SSE, streamable HTTP) and per-server query patterns in `src/lib/mcp/query-patterns/servers/`.

**WhatsApp Provider Client:**
- Purpose: Uniform client across Baileys hosting providers.
- Examples: `src/lib/whatsapp/base-client.ts`, `src/lib/whatsapp/koyeb-client.ts`, `src/lib/whatsapp/flyio-client.ts`
- Pattern: Abstract base class with factory selection by `WHATSAPP_PROVIDER`.

**Retrieval Strategies:**
- Purpose: Choose among retrieval approaches per query.
- Examples: `src/lib/enhanced-rag-retrieval.ts`, `src/lib/retrieval-strategies.ts`, `src/lib/optimized-search.ts`, `src/lib/adaptive-retrieval.ts`
- Pattern: Functional pipelines with scorer modules (`mmr-scorer.ts`, `bm25-scorer.ts`, `reranker-adapter.ts`).

**Validation Middleware:**
- Purpose: Zod-based request validation with structured 400 responses.
- Examples: `src/lib/api-middleware.ts` (`validateRequest`, `withValidation`)
- Pattern: Route wraps handler; errors returned as `{ success: false, error, details }`.

**Typed Chat Messages:**
- Purpose: Convert between UI, API, and DB message shapes.
- Examples: `src/types/chat.ts` (`toAPIMessage`, `toDBMessages`, `fromUIMessage`, `toExtendedMessages`), `src/types/messages.ts`, `src/types/events.ts`
- Pattern: Pure conversion functions; `ExtendedMessage` carries sources and images.

## Entry Points

**Web app root:**
- Location: `src/app/layout.tsx` (server layout, metadata), `src/app/page.tsx` (chat home)
- Triggers: Browser navigation.
- Responsibilities: Mount providers and the main chat UI.

**Chat API:**
- Location: `src/app/api/chat/route.ts`
- Triggers: `useChat` POST from the UI and embed clients.
- Responsibilities: Full RAG + MCP + streaming pipeline.

**Embed:**
- Location: `src/app/embed/chat.js/route.ts` (script), `src/app/embed/window/page.tsx`, `src/app/api/embed/chat/route.ts`
- Triggers: Third-party sites loading the embed script.
- Responsibilities: Embeddable chat with rate limiting (`src/lib/embed-rate-limit.ts`).

**Shared chat:**
- Location: `src/app/shared/[shareId]/page.tsx`, `src/app/api/chats/[shareId]/route.ts`
- Triggers: Share links.
- Responsibilities: Read-only rendering of shared conversations.

**Voice agent worker:**
- Location: `voice-agent/src/agent.ts`
- Triggers: LiveKit dispatch; `cd voice-agent && npm run dev`.
- Responsibilities: Connect to room, run VAD, STT, LLM, TTS.

**WhatsApp service:**
- Location: `baileys-whatsapp/server.ts`
- Triggers: HTTP calls from Next.js WhatsApp clients.
- Responsibilities: Session lifecycle, QR and pairing code, message send and media upload, webhook dispatch.

**Config dashboard:**
- Location: `scripts/config-server.js` (port 3333), `src/app/config-ui/route.tsx` (in-app route)
- Triggers: `npm run config`.
- Responsibilities: Env edits, admin users, model lists, RAG prompt tuning.

## Architectural Constraints

- **Threading:** Node.js single-threaded event loop for Next.js routes (`runtime = 'nodejs'`). Voice agent uses a mutex for audio playback (`voice-agent/src/agent.ts`).
- **Global state:** Module-level singletons: `supabaseManager` in `src/lib/supabase.ts`, `productionMcpRouter` (`src/lib/mcp/production-router.ts`), `smartMcpRouter` (`src/lib/mcp/smart-router.ts`), `WhatsAppClientFactory.instance` (`src/lib/whatsapp/client-factory.ts`), `sessions` Map in `baileys-whatsapp/server.ts`, and MCP caches in `src/lib/mcp-cache.ts`. These are per-process and reset on cold start or across serverless instances.
- **Circular imports:** Not verified in this pass. `src/app/page.tsx` imports `src/lib/supabase.ts` (type and runtime) and `src/lib/chat-store.ts`, which both import Supabase helpers; keep new imports one-directional.
- **Middleware:** `src/middleware.disabled.ts` is present but not active (file name disables it). Session refresh logic exists in `src/lib/supabase/middleware.ts` and is not wired in.
- **Large files:** `src/app/api/chat/route.ts` (~4500 lines), `src/app/page.tsx` (~5000 lines), `scripts/config-server.js` (~3600 lines). Changes here carry high regression risk.
- **Type checking:** `next.config.js` sets `typescript.ignoreBuildErrors: true`, so type errors do not fail the build.

## Anti-Patterns

### Monolithic route handlers

**What happens:** `src/app/api/chat/route.ts` contains classification, retrieval, MCP planning, prompt building, streaming, and persistence in one file (~4500 lines, one `POST` function starting near line 1180).
**Why it's wrong:** Hard to test, and changes to one stage risk the others. The `AGENTS.md` strict-RAG rules are spread across the file.
**Do this instead:** Put new retrieval or prompt logic into a module under `src/lib/` (as with `src/lib/enhanced-rag-retrieval.ts`) and call it from the route. Keep route code to parsing, orchestration, and response shaping.

### Duplicate retrieval modules

**What happens:** Several overlapping retrieval modules exist: `src/lib/enhanced-rag-retrieval.ts`, `src/lib/retrieval-strategies.ts`, `src/lib/optimized-search.ts`, `src/lib/adaptive-retrieval.ts`, `src/lib/thinking-rag-enhancer.ts`.
**Why it's wrong:** Callers may pick different paths, which makes retrieval behaviour hard to reason about.
**Do this instead:** Add new retrieval behaviour to the module that already owns that strategy, and confirm the route's active path before editing.

### Duplicate Supabase helpers

**What happens:** Supabase access exists in `src/lib/supabase.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, and `src/lib/supabase-auth.ts`.
**Why it's wrong:** Mixed admin and user-scoped clients can bypass RLS if the wrong one is used.
**Do this instead:** Use the user-scoped client for request-bound data and `getSupabaseAdmin()` only for server tasks that must bypass RLS. Respect the RLS policies in `supabase/*.sql`.

## Error Handling

**Strategy:** Structured JSON errors on HTTP routes, and SSE error events on streaming routes.

**Patterns:**
- Request validation failures return HTTP 400 with `{ success: false, error, details }` (`src/lib/api-middleware.ts`).
- Streaming errors are formatted with `formatErrorSSE` (`src/lib/error-stream.ts`).
- Retrieval fallbacks fall through to "information not available" in strict mode (`src/app/api/chat/route.ts`).
- Voice timestamp failures fall back to estimated timings (`voice-agent/src/providers/resemble.ts`).

## Cross-Cutting Concerns

**Logging:** `src/lib/logger.ts` and `src/lib/dev-logger.ts`, with `console.log` in many places. The `[Document Search]` prefix is used for retrieval diagnostics.
**Validation:** Zod schemas (`zod/v3` imports) via `src/lib/api-middleware.ts`.
**Authentication:** Supabase Auth (GitHub OAuth, email/password, magic links) through `src/components/providers/auth-provider.tsx` and `src/lib/supabase-auth.ts`. Admin login is in `src/app/api/admin/login/route.ts`. Auxiliary services use shared API keys (`API_KEY` in `baileys-whatsapp/server.ts`).

---

*Architecture analysis: 2026-11-22*
