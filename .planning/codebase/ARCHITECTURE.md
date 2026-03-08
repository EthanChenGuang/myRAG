# Architecture

**Analysis Date:** 2026-03-08

## Pattern Overview

**Overall:** Next.js App Router monolith with client-heavy SPA pattern

**Key Characteristics:**
- Single-page chat application rendered entirely client-side (`'use client'` on `page.tsx`)
- Server-side limited to API routes (no RSC data fetching in pages)
- Zustand for client state management with localStorage persistence
- Supabase as the unified backend (auth, database, storage, realtime)
- AI SDK 5 (`ai` package) for streaming LLM interactions via OpenRouter
- Multi-tenant / single-tenant deployment mode toggled by environment variable
- React Compiler enabled via Next.js 16 (`reactCompiler: true` in `next.config.js`)

## Layers

**Presentation Layer (Client Components):**
- Purpose: Renders the chat UI, sidebar, settings, and multi-modal content
- Location: `src/components/ui/`, `src/components/providers/`
- Contains: React components, context providers, hooks
- Depends on: Zustand stores, `@ai-sdk/react` `useChat` hook, Supabase client
- Used by: `src/app/page.tsx` (main page), `src/app/client-layout.tsx` (layout shell)

**Provider Layer (React Context):**
- Purpose: Global state injection for auth, model selection, theme, fonts, language, artifacts, sources
- Location: `src/components/providers/`
- Contains: `AuthProvider`, `ModelProvider`, `ArtifactProvider`, `TextSizeProvider`, `FontProvider`, `LanguageProvider`, `SourcesProvider`, `MarkdownProvider`
- Depends on: Supabase auth client, environment config
- Used by: `src/app/client-layout.tsx` (nested provider tree)

**State Management Layer (Zustand Stores):**
- Purpose: Client-side state for chats, files, settings, organizations, reasoning, ghost mode, web search, MCP, documents
- Location: `src/lib/chat-store.ts`, `src/lib/file-upload-store.ts`, `src/lib/user-settings-store.ts`, `src/lib/web-search-store.ts`, `src/lib/ghost-mode-store.ts`, `src/lib/document-mention-store.ts`, `src/lib/multi-file-upload-store.ts`, `src/lib/stores/organization-store.ts`, `src/lib/stores/reasoning-store.ts`
- Contains: Zustand `create()` stores with Supabase CRUD operations
- Depends on: Supabase client, localStorage
- Used by: Components via `useShallow` selectors

**API Layer (Next.js Route Handlers):**
- Purpose: Server-side request handling, AI streaming, document processing, integrations
- Location: `src/app/api/`
- Contains: `route.ts` files using `NextRequest`/`NextResponse`
- Depends on: `src/lib/` modules, Supabase admin client, AI SDK, external APIs
- Used by: Client via fetch/`useChat` transport

**RAG Pipeline Layer:**
- Purpose: Document ingestion, chunking, embedding, retrieval, and context assembly
- Location: `src/lib/document-processor.ts`, `src/lib/retrieval-strategies.ts`, `src/lib/enhanced-rag-retrieval.ts`, `src/lib/optimized-search.ts`, `src/lib/adaptive-retrieval.ts`, `src/lib/semantic-chunker.ts`, `src/lib/bm25-scorer.ts`, `src/lib/mmr-scorer.ts`, `src/lib/thinking-rag-enhancer.ts`, `src/lib/temporal-query-detector.ts`, `src/lib/temporal-metadata-extractor.ts`
- Contains: Embedding generation (OpenAI), hybrid search (vector + BM25), MMR reranking, temporal/financial boost scoring, adaptive multi-pass retrieval
- Depends on: Supabase pgvector, OpenAI embeddings API
- Used by: `src/app/api/chat/route.ts`, `src/app/api/process-document/route.ts`

**MCP (Model Context Protocol) Layer:**
- Purpose: Dynamic tool discovery and execution via MCP servers
- Location: `src/lib/mcp/`
- Contains: `UniversalMcpClient` singleton, transport factory, discovery, smart router, query classifier, query patterns
- Key files: `src/lib/mcp/universal-client.ts`, `src/lib/mcp/production-router.ts`, `src/lib/mcp/smart-router.ts`, `src/lib/mcp/discovery.ts`, `src/lib/mcp/transport-factory.ts`
- Depends on: `@modelcontextprotocol/sdk`, external MCP servers
- Used by: `src/app/api/chat/route.ts`, `src/app/api/chat/approve/route.ts`

**Integration Layer:**
- Purpose: External service connectors (WhatsApp, Nango, Stripe, scrapers)
- Location: `src/lib/whatsapp/`, `src/lib/nango/`, `src/lib/stripe.ts`, `src/lib/polar.ts`, `src/lib/scrapers/`
- Contains: Client factories, webhook handlers, sync managers
- Depends on: External APIs, environment configuration
- Used by: Respective API routes

**Environment & Config Layer:**
- Purpose: Centralized env loading, deployment mode, feature flags
- Location: `src/lib/env.ts`, `src/lib/deployment-mode.ts`, `src/lib/config/connectors.ts`
- Contains: `EnvironmentConfig` singleton, deployment mode helpers, feature flag computation
- Depends on: `.env.local`, `process.env`
- Used by: All server-side modules

## Data Flow

**Chat Message Flow:**

1. User types message in `ChatInput` component (`src/components/ui/chat-input.tsx`)
2. `useChat` hook from `@ai-sdk/react` sends message via `DefaultChatTransport` to `POST /api/chat`
3. `src/app/api/chat/route.ts` receives message, classifies query intent (`src/lib/query-classifier.ts`)
4. If RAG-relevant: generates embedding via OpenAI, performs hybrid search (vector + BM25) in Supabase pgvector, applies MMR reranking
5. Assembles system prompt with `{{context}}` placeholder filled by retrieved chunks (`src/lib/system-prompt-manager.ts`)
6. Calls `streamText()` from AI SDK 5 with OpenRouter provider, streams response back
7. Client renders streaming tokens in `ChatMessage` component (`src/components/ui/chat-message.tsx`)
8. On completion, chat is persisted to Supabase via `useChatStore`

**Document Ingestion Flow:**

1. User uploads file via `src/components/ui/document-dashboard.tsx` or `unified-upload-button.tsx`
2. `POST /api/upload` receives file, stores in Supabase storage
3. `POST /api/process-document/route.ts` parses document (LlamaIndex Cloud or local), creates semantic chunks (`src/lib/semantic-chunker.ts`)
4. Generates embeddings via OpenAI (`src/lib/document-processor.ts`)
5. Stores document metadata, chunks, and embeddings in Supabase tables

**MCP Tool Execution Flow:**

1. Chat route classifies query for MCP tool relevance (`src/lib/query-classifier.ts`)
2. `UniversalMcpClient` discovers available tools from configured MCP servers
3. Tools registered with AI SDK `streamText()` as `ToolSet`
4. If tool requires approval: returns pending state, awaits `POST /api/chat/approve`
5. Tool executed via MCP transport, result injected into conversation

**State Management:**
- Client state: Zustand stores with `useShallow` selectors (prevents unnecessary re-renders)
- Server state: Supabase PostgreSQL with RLS policies
- Chat persistence: Zustand store syncs to Supabase on create/update
- Session: Supabase Auth (cookie-based via `@supabase/ssr`)
- Preferences: localStorage via Zustand `persist` middleware or direct localStorage access

## Key Abstractions

**EnvironmentConfig Singleton:**
- Purpose: Single source of truth for all environment variables
- Location: `src/lib/env.ts`
- Pattern: Singleton class, lazily initialized, validates on first access

**SupabaseManager Singleton:**
- Purpose: Manages Supabase client instances (browser + admin)
- Location: `src/lib/supabase.ts`
- Pattern: Singleton with separate browser client (anon key) and admin client (service role key)

**UniversalMcpClient Singleton:**
- Purpose: Dynamic MCP tool discovery and execution
- Location: `src/lib/mcp/universal-client.ts`
- Pattern: Singleton with transport factory, tool caching (60s TTL), schema cache

**SystemPromptManager:**
- Purpose: Assembles system prompts with RAG context and i18n support
- Location: `src/lib/system-prompt-manager.ts`
- Pattern: Static class, template lookup by language with `{{context}}` placeholder injection

**DeploymentMode:**
- Purpose: Feature flag computation based on single-tenant vs multi-tenant mode
- Location: `src/lib/deployment-mode.ts`
- Pattern: Pure functions reading from env, guard functions (`requireMultiTenant()`)

**Chat Store:**
- Purpose: Central chat CRUD with Supabase sync, folder management, sidebar state
- Location: `src/lib/chat-store.ts`
- Pattern: Zustand store with async Supabase operations, event emission for cross-component updates

## Entry Points

**Main Chat Page:**
- Location: `src/app/page.tsx` (4685 lines)
- Triggers: Browser navigation to `/`
- Responsibilities: Full chat UI including message list, input, sidebar integration, image/video/3D generation handlers, streaming state management

**Root Layout:**
- Location: `src/app/layout.tsx` -> `src/app/client-layout.tsx`
- Triggers: Every page load
- Responsibilities: Provider nesting (Theme > Auth > Model > TextSize > Font > Language > Artifact > Sources > MobileTools), global styles, sidebar wrapper, toaster

**Chat API:**
- Location: `src/app/api/chat/route.ts` (4226 lines)
- Triggers: `POST /api/chat` from `useChat` hook
- Responsibilities: Query classification, RAG retrieval, MCP tool integration, AI streaming, document reference tracking

**Chat Approve API:**
- Location: `src/app/api/chat/approve/route.ts` (4823 lines)
- Triggers: `POST /api/chat/approve` when user approves MCP tool execution
- Responsibilities: Tool approval workflow, execution, result streaming

**Document Processing API:**
- Location: `src/app/api/process-document/route.ts` (800 lines)
- Triggers: `POST /api/process-document` after file upload
- Responsibilities: Document parsing, chunking, embedding generation, Supabase storage

**Embed Widget:**
- Location: `src/app/embed/` (embeddable chat widget)
- Triggers: External websites embedding the chat
- Responsibilities: Standalone chat interface for third-party embedding

**Config Dashboard:**
- Location: `scripts/config-server.js` + `scripts/config-ui/`
- Triggers: `npm run config` (separate Express server on port 3333)
- Responsibilities: Visual env management, admin users, RAG prompt tuning

## Error Handling

**Strategy:** Mixed - no unified error handling pattern

**Patterns:**
- API routes: try/catch with `NextResponse.json({ error: ... }, { status: N })`
- Validation: Zod schemas via `src/lib/api-middleware.ts` `withValidation` wrapper
- Client: try/catch in async store operations, error state in Zustand stores
- Streaming: Error events from AI SDK `useChat` hook, `onError` callbacks
- Supabase: Direct `.error` check on query results (no centralized error handler)

## Cross-Cutting Concerns

**Logging:** Custom `logger` utility (`src/lib/logger.ts`) with level-based output (startup, debug, error). Performance monitor component at `src/lib/performance-monitor.tsx`. Noisy console logs can be disabled via `NEXT_PUBLIC_DISABLE_DEBUG_LOGS`.

**Validation:** Zod schemas for API request validation via `src/lib/api-middleware.ts`. No client-side form validation library detected.

**Authentication:** Supabase Auth via `src/components/providers/auth-provider.tsx`. Supports GitHub OAuth, email/password, magic links. Toggleable via `NEXT_PUBLIC_AUTH_ENABLED`. Multi-tenant mode adds organization-scoped RLS.

**Internationalization:** 20 language files in `src/translations/` (en, es, fr, de, ja, ko, zh, ar, hi, pt, ru, etc.). System prompts are translatable. UI strings accessed via `LanguageProvider`.

**Theming:** `next-themes` via `src/components/theme-provider.tsx`. Light/dark mode with CSS custom properties. Default dark.

---

*Architecture analysis: 2026-03-08*
