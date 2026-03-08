# Architecture

**Analysis Date:** 2026-03-08

## Pattern Overview

**Overall:** Monolithic Next.js App Router application with a single-page chat UI, server-side API routes, and Supabase as the persistence layer.

**Key Characteristics:**
- Single-page application: the entire chat experience lives in `src/app/page.tsx` (4685 lines) as a client component
- API routes handle all backend logic (chat streaming, document processing, MCP tool execution, integrations)
- Zustand stores manage client-side state; no server-side state beyond Supabase
- RAG pipeline uses OpenAI embeddings + pgvector (HNSW) for semantic search
- Multi-model orchestration via OpenRouter as the primary AI gateway
- Supports single-tenant (shared knowledge base) and multi-tenant (organization-scoped) deployment modes

## Layers

**Presentation Layer:**
- Purpose: Renders the chat UI, sidebars, settings, and all user-facing components
- Location: `src/app/page.tsx`, `src/components/ui/`, `src/components/providers/`
- Contains: React client components, Zustand store consumers, Framer Motion animations
- Depends on: Zustand stores, provider contexts, API routes (via fetch/useChat)
- Used by: End users via browser

**Provider Layer:**
- Purpose: Wraps the app with context providers for auth, model selection, theming, language, etc.
- Location: `src/components/providers/`, `src/app/client-layout.tsx`
- Contains: React context providers (AuthProvider, ModelProvider, TextSizeProvider, FontProvider, LanguageProvider, ArtifactProvider, SourcesProvider)
- Depends on: `src/lib/supabase/client.ts` for auth, environment config
- Used by: All client components via `useAuth()`, `useModel()`, etc.

**State Layer:**
- Purpose: Client-side state management via Zustand stores
- Location: `src/lib/chat-store.ts`, `src/lib/web-search-store.ts`, `src/lib/file-upload-store.ts`, `src/lib/user-settings-store.ts`, `src/lib/ghost-mode-store.ts`, `src/lib/document-mention-store.ts`, `src/lib/multi-file-upload-store.ts`, `src/lib/stores/organization-store.ts`, `src/lib/stores/reasoning-store.ts`, `src/lib/admin-store.ts`
- Contains: Zustand store definitions with actions, selectors, localStorage persistence
- Depends on: Supabase client for data operations
- Used by: Presentation layer components

**API Layer:**
- Purpose: Server-side request handling, streaming AI responses, CRUD operations
- Location: `src/app/api/`
- Contains: Next.js Route Handlers (`route.ts` files) for chat, documents, config, auth, MCP, WhatsApp, payments, scrapers, etc.
- Depends on: RAG pipeline, Supabase admin client, AI providers, MCP client
- Used by: Frontend via fetch, external webhooks (Stripe, WhatsApp, Nango)

**RAG Pipeline Layer:**
- Purpose: Document ingestion, chunking, embedding, retrieval, and prompt assembly
- Location: `src/lib/document-processor.ts`, `src/lib/enhanced-rag-retrieval.ts`, `src/lib/retrieval-strategies.ts`, `src/lib/optimized-search.ts`, `src/lib/semantic-chunker.ts`, `src/lib/thinking-rag-enhancer.ts`, `src/lib/adaptive-retrieval.ts`, `src/lib/bm25-scorer.ts`, `src/lib/mmr-scorer.ts`, `src/lib/reranker-local.ts`
- Contains: Embedding generation (OpenAI), vector search (pgvector), temporal/financial query detection, BM25 scoring, MMR diversity, semantic chunking
- Depends on: Supabase (pgvector), OpenAI API, environment config
- Used by: Chat API route, document processing API

**MCP (Model Context Protocol) Layer:**
- Purpose: Dynamic tool discovery and execution across external MCP servers
- Location: `src/lib/mcp/`
- Contains: Universal client (`universal-client.ts`), transport factory (`transport-factory.ts`), discovery (`discovery.ts`), query classification (`query-patterns/`), smart routing (`smart-router.ts`)
- Depends on: MCP server configurations, transport protocols (SSE, stdio)
- Used by: Chat API route for tool-augmented responses

**Data Access Layer:**
- Purpose: Supabase client management and database operations
- Location: `src/lib/supabase.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, `src/lib/supabase/middleware.ts`
- Contains: Singleton Supabase manager, browser client, server client, admin client, CRUD helpers for chats/documents/chunks
- Depends on: Supabase JS SDK, environment config
- Used by: All server-side code and client-side stores

**Integration Layer:**
- Purpose: External service adapters for WhatsApp, Nango, Stripe, scrapers
- Location: `src/lib/whatsapp/`, `src/lib/nango/`, `src/lib/stripe.ts`, `src/lib/polar.ts`, `src/lib/scrapers/`
- Contains: WhatsApp client factory (Fly.io/Koyeb), Nango sync/document adapter, Stripe/Polar payment utils, Firecrawl scraper
- Depends on: External APIs, Supabase
- Used by: Corresponding API routes

## Data Flow

**Chat Message Flow:**

1. User types message in `src/components/ui/chat-input.tsx`, submits form
2. `src/app/page.tsx` handles submission via `useChat` hook from `@ai-sdk/react`
3. Request hits `src/app/api/chat/route.ts` (POST) with model, messages, config
4. Route classifies query (`src/lib/query-classifier.ts`), retrieves RAG context via `src/lib/enhanced-rag-retrieval.ts`
5. System prompt assembled via `src/lib/system-prompt-manager.ts` with `{{context}}` placeholder filled with retrieved chunks
6. `streamText()` from Vercel AI SDK streams response back through OpenRouter provider
7. Client receives streaming tokens, renders via `src/components/ui/chat-message.tsx`
8. Chat persisted to Supabase `chats` table via `src/lib/chat-store.ts`

**Document Ingestion Flow:**

1. User uploads file via `src/components/ui/document-dashboard.tsx` or `src/components/ui/unified-upload-button.tsx`
2. File sent to `src/app/api/upload/route.ts` or `src/app/api/process-document/route.ts`
3. `src/lib/document-processor.ts` extracts text, creates semantic chunks (`src/lib/semantic-chunker.ts`)
4. Embeddings generated via OpenAI embeddings API (text-embedding-3-small default)
5. Document metadata and chunk embeddings stored in Supabase (`documents` and `document_chunks` tables with pgvector)

**MCP Tool Execution Flow:**

1. Chat route classifies query for MCP tool intent (`src/lib/query-classifier.ts`, `src/lib/mcp/query-patterns/`)
2. `UniversalMcpClient` discovers available tools from configured MCP servers (`src/lib/mcp/discovery.ts`)
3. Tools injected as AI SDK tools into `streamText()` call
4. If tool requires approval, approval request sent to client; user approves via `src/app/api/chat/approve/route.ts`
5. Tool executed via appropriate transport (SSE/stdio), result returned to model for final response

**State Management:**
- Client state: Zustand stores with `useShallow` selectors for performance
- Persistence: Supabase for chats, documents, user data; localStorage for UI preferences (sidebar state, current chat ID, theme)
- Auth state: Supabase Auth with session management in `AuthProvider`

## Key Abstractions

**EnvironmentConfig Singleton:**
- Purpose: Centralizes all environment variable access with defaults and validation
- Examples: `src/lib/env.ts`
- Pattern: Singleton class with lazy initialization, accessed via `env` export

**SupabaseManager Singleton:**
- Purpose: Manages Supabase client instances (browser, admin) with singleton pattern
- Examples: `src/lib/supabase.ts`
- Pattern: Singleton with separate browser client and service-role admin client

**UniversalMcpClient Singleton:**
- Purpose: Discovers and executes MCP tools across any configured server
- Examples: `src/lib/mcp/universal-client.ts`
- Pattern: Singleton with transport factory, tool/schema caching, TTL-based cache invalidation

**SystemPromptManager:**
- Purpose: Assembles system prompts from i18n templates with RAG context injection
- Examples: `src/lib/system-prompt-manager.ts`
- Pattern: Static utility class, uses `{{context}}` placeholder substitution

**DeploymentMode:**
- Purpose: Controls single-tenant vs multi-tenant feature flags and data scoping
- Examples: `src/lib/deployment-mode.ts`
- Pattern: Functional module with `isSingleTenant()` / `isMultiTenant()` guards and `getFeatureFlags()`

**SmartLogger:**
- Purpose: Centralized logging with deduplication, log levels, and environment awareness
- Examples: `src/lib/logger.ts`
- Pattern: Class with log caching to suppress duplicate messages, level-based filtering

## Entry Points

**Main App Page:**
- Location: `src/app/page.tsx`
- Triggers: Browser navigation to `/`
- Responsibilities: Renders entire chat experience (messages, input, sidebar, header), manages chat lifecycle, handles streaming

**Root Layout:**
- Location: `src/app/layout.tsx` → `src/app/client-layout.tsx`
- Triggers: Every page load
- Responsibilities: Provider tree setup (Theme, Auth, Model, TextSize, Font, Language, Artifact, Sources, MobileTools), font loading, global styles

**Chat API Route:**
- Location: `src/app/api/chat/route.ts`
- Triggers: POST from `useChat` hook on message submission
- Responsibilities: RAG retrieval, system prompt assembly, AI streaming, MCP tool orchestration, multi-model support

**Document API Routes:**
- Location: `src/app/api/documents/route.ts`, `src/app/api/process-document/route.ts`, `src/app/api/upload/route.ts`
- Triggers: Document dashboard CRUD operations
- Responsibilities: Document listing, upload, processing, deletion

**Config API Routes:**
- Location: `src/app/api/config/` (models, rag-prompt, system-prompts, embed, connectors, etc.)
- Triggers: Config dashboard, settings modal
- Responsibilities: Runtime configuration management, model list serving, logo/favicon upload

**Embed Widget:**
- Location: `src/app/embed/`, `src/app/api/embed/`
- Triggers: External websites embedding the chat widget
- Responsibilities: Embeddable chat widget with iframe + JS loader

**Auth Pages:**
- Location: `src/app/auth/`, `src/app/api/auth/`
- Triggers: Login/signup flows
- Responsibilities: Supabase Auth (GitHub OAuth, email/password, magic links), session management

**Webhook Endpoints:**
- Location: `src/app/api/webhooks/stripe/route.ts`, `src/app/api/whatsapp/webhook/route.ts`, `src/app/api/nango/webhook/route.ts`
- Triggers: External service callbacks
- Responsibilities: Payment event processing, WhatsApp message relay, Nango sync notifications

## Error Handling

**Strategy:** Mixed approach - API routes use try/catch with JSON error responses; client-side uses toast notifications and error state in stores.

**Patterns:**
- API routes return `NextResponse.json({ success: false, error: '...' }, { status: N })` on failure
- `src/lib/api-middleware.ts` provides Zod-based request validation via `validateRequest()` / `withValidation()`
- Supabase errors checked inline after each query: `if (error) { throw/return error }`
- Client-side stores set `error` state properties for UI display
- No global error boundary detected; errors handled per-component

## Cross-Cutting Concerns

**Logging:** `src/lib/logger.ts` - SmartLogger singleton with deduplication, log levels (ERROR/WARN/INFO/DEBUG), dev-only debug output. Also `src/lib/dev-logger.ts` for development-only logging. Performance monitoring via `src/lib/performance-monitor.tsx`.

**Validation:** Zod (`zod/v3`) for API request validation via `src/lib/api-middleware.ts`. No client-side form validation library detected.

**Authentication:** Supabase Auth via `src/components/providers/auth-provider.tsx`. Supports GitHub OAuth, email/password, magic links. Auth can be disabled entirely via `NEXT_PUBLIC_AUTH_ENABLED` env var. Admin auth separate via `src/app/api/admin/` routes.

**Internationalization:** `src/translations/` with 20 language files. Used by `SystemPromptManager` for system prompt localization and `LanguageProvider` for UI translations.

**Multi-tenancy:** `src/lib/deployment-mode.ts` controls single-tenant vs multi-tenant. Multi-tenant adds organization scoping, team invites, storage quotas. Data isolation via Supabase RLS policies.

---

*Architecture analysis: 2026-03-08*
