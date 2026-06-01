<!-- refreshed: 2026-06-01 -->
# Architecture

**Analysis Date:** 2026-06-01

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                        Browser / Client Layer                           │
│  `src/app/page.tsx` (main chat)  `src/app/embed/` (embeddable widget)   │
│  React 19 + AI SDK 5 useChat hook + Zustand stores + Framer Motion      │
└──────────────────────┬───────────────────────────────────────────────────┘
                       │ HTTP / SSE streaming
┌──────────────────────▼───────────────────────────────────────────────────┐
│                     Next.js API Routes (Node.js runtime)                  │
│  `src/app/api/chat/route.ts`         — core RAG + streaming LLM          │
│  `src/app/api/chat/approve/route.ts` — MCP tool approval pipeline        │
│  `src/app/api/process-document/`     — document ingestion                │
│  `src/app/api/upload/`               — file upload                       │
│  `src/app/api/generate-image/`       — image generation                  │
│  `src/app/api/generate-video/`       — video generation                  │
│  `src/app/api/generate-3d/`          — 3D model generation               │
│  `src/app/api/whatsapp/`             — WhatsApp webhook/session           │
│  `src/app/api/admin/`                — admin auth + settings              │
│  `src/app/api/nango/`                — Nango connector OAuth              │
│  `src/app/api/config/`               — runtime config endpoints           │
└───────────┬─────────────────────┬────────────────────────────────────────┘
            │                     │
┌───────────▼──────────┐  ┌──────▼────────────────────────────────────────┐
│    AI / LLM Layer    │  │              Data + Services Layer              │
│ `src/lib/`           │  │                                                 │
│  openrouter.ts       │  │  `src/lib/supabase.ts`   — DB + vector store   │
│  env.ts              │  │  `src/lib/supabase/`     — browser client      │
│  query-classifier.ts │  │  `src/lib/document-processor.ts` — embed+chunk │
│  retrieval-strategies│  │  `src/lib/optimized-search.ts`  — hybrid RAG   │
│  thinking-rag-enh.   │  │  `src/lib/mcp/`          — MCP tool execution  │
│  system-prompt-mgr.  │  │  `src/lib/whatsapp/`     — WhatsApp provider   │
│  deployment-mode.ts  │  │  `src/lib/nango/`        — connector sync       │
│  mcp-cache.ts        │  │  `src/lib/stores/`       — Zustand global state │
└───────────┬──────────┘  └──────┬────────────────────────────────────────┘
            │                    │
┌───────────▼────────────────────▼────────────────────────────────────────┐
│                      External Services                                   │
│  Supabase (PostgreSQL + pgvector + Storage + Auth + Realtime)           │
│  OpenRouter / OpenAI / Anthropic / DeepSeek / Gemini                   │
│  MCP Zapier endpoint  |  Nango OAuth connectors                         │
│  Stripe / Polar payments  |  Meshy / Luma / Runway (media generation)   │
│  WhatsApp (Baileys on Fly.io or Koyeb)                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Chat page | Main SPA: message list, input, sidebar orchestration | `src/app/page.tsx` |
| Chat route | RAG pipeline, streaming LLM, MCP dispatch, image routing | `src/app/api/chat/route.ts` |
| Approve route | MCP tool approval + YOLO auto-execution | `src/app/api/chat/approve/route.ts` |
| Document processor | Parse, chunk, embed, store documents | `src/lib/document-processor.ts` |
| Retrieval strategies | Multi-pass, adjacent-chunk, hybrid RAG retrieval | `src/lib/retrieval-strategies.ts` |
| Optimized search | Query enhancement + BM25/MMR reranking + cache | `src/lib/optimized-search.ts` |
| Query classifier | Classify query as conversational/tool/document/multi-step | `src/lib/query-classifier.ts` |
| Universal MCP client | Dynamic discovery + execution of any MCP tool | `src/lib/mcp/universal-client.ts` |
| Smart MCP router | Semantic routing to best MCP server/tool with fallback | `src/lib/mcp/smart-router.ts` |
| System prompt manager | Assemble RAG system prompts with `{{context}}` injection | `src/lib/system-prompt-manager.ts` |
| Deployment mode | Single-tenant vs multi-tenant feature gating | `src/lib/deployment-mode.ts` |
| Chat store | Zustand store: chat list, folders, current chat | `src/lib/chat-store.ts` |
| Supabase manager | Singleton DB client (anon + service-role) | `src/lib/supabase.ts` |
| WhatsApp factory | Provider-agnostic WhatsApp client (Fly.io or Koyeb) | `src/lib/whatsapp/client-factory.ts` |
| Client layout | Provider tree + global CSS + mobile viewport setup | `src/app/client-layout.tsx` |
| Auth provider | Supabase session management + route guards | `src/components/providers/auth-provider.tsx` |
| Model provider | Available model list + reasoning mode detection | `src/components/providers/model-provider.tsx` |

## Pattern Overview

**Overall:** Next.js App Router full-stack SPA with server-side RAG pipeline delivering SSE streams to the client via AI SDK 5's `useChat` hook.

**Key Characteristics:**
- Streaming-first: all AI responses delivered as SSE text streams; errors formatted as `formatErrorSSE` payloads (`src/lib/error-stream.ts`)
- Singleton pattern for shared infrastructure: `SupabaseManager`, `EnvironmentConfig`, `UniversalMcpClient`, `WhatsAppClientFactory`
- Zustand stores for all client-side state; selectors use `useShallow` from `zustand/react/shallow`
- Feature flags controlled via `NEXT_PUBLIC_*` env vars read through `src/lib/env.ts` singleton
- Deployment mode (`single-tenant` | `multi-tenant`) gates org/team/quota features at runtime via `src/lib/deployment-mode.ts`

## Layers

**Client UI Layer:**
- Purpose: Chat interface, sidebar, document upload, settings, modals
- Location: `src/app/page.tsx`, `src/components/ui/`, `src/components/providers/`
- Contains: React components, Framer Motion animations, Zustand selectors, AI SDK `useChat` hook
- Depends on: API routes (via fetch/SSE), Zustand stores, Supabase browser client
- Used by: End users directly

**API Route Layer:**
- Purpose: Business logic endpoints — RAG pipeline, LLM streaming, document processing, auth, payments, media generation
- Location: `src/app/api/`
- Contains: Next.js `route.ts` files, all with `export const runtime = 'nodejs'`
- Depends on: `src/lib/` utilities, Supabase admin client, external APIs
- Used by: Browser client (chat, upload, config), WhatsApp webhook, embed widget

**Business Logic / Library Layer:**
- Purpose: Reusable AI, RAG, store, and integration utilities
- Location: `src/lib/`
- Contains: Zustand stores (`chat-store.ts`, `stores/`), RAG modules, MCP client, document processor, env config, WhatsApp client
- Depends on: Supabase, OpenAI SDK, `src/types/`
- Used by: API routes and UI components

**Data / Types Layer:**
- Purpose: TypeScript interfaces shared across frontend and backend
- Location: `src/types/` (`chat.ts`, `folder.ts`, `messages.ts`, `events.ts`)
- Contains: Message types (`ExtendedMessage`, `APIMessage`, `ContentPart`, `DocumentContent`), serialization utilities
- Depends on: AI SDK `UIMessage` types
- Used by: All layers

## Data Flow

### Primary Chat Request Path

1. User submits message → `useChat` hook in `src/app/page.tsx`
2. `DefaultChatTransport` POSTs `APIMessage[]` to `/api/chat`
3. `POST` handler in `src/app/api/chat/route.ts` begins:
   - Classifies query via `classifyQuery()` (`src/lib/query-classifier.ts`)
   - If not bypassed, runs RAG: `optimizedSearch()` or `comprehensiveRetrieval()` → `searchSimilarChunks()` (pgvector HNSW)
   - Assembles system prompt with `{{context}}` via `SystemPromptManager`
   - If MCP enabled + query needs tools: discovers tools via `UniversalMcpClient`, passes as `ToolSet` to `streamText()`
   - Calls `streamText()` with OpenRouter provider (or OpenAI direct)
4. SSE stream returned to client; `useChat` appends tokens to message state
5. On stream end, frontend saves chat via `createChat`/`updateChat` in `src/lib/chat-store.ts` → Supabase

### Document Ingestion Path

1. User uploads file → `/api/upload` (stores in Supabase Storage `chat-attachments`)
2. `/api/process-document` called: text extraction (LlamaIndex Cloud or PDF.js) → semantic chunking (`src/lib/semantic-chunker.ts`) → embedding via OpenAI `text-embedding-3-small` → stored in `document_chunks` table with pgvector embedding
3. Document indexed; available for RAG in subsequent chats

### MCP Tool Approval Flow

1. Chat route calls `streamText()` with MCP tools registered
2. AI emits `tool_use` event; if `requiresApproval`, stream pauses
3. Client renders approval UI via `src/components/ui/mcp-tool-box.tsx`
4. User approves → POST `/api/chat/approve` with `toolCallId`
5. `ToolExecutionStateService` (`src/lib/tool-execution-state.ts`) marks approved
6. `UniversalMcpClient` executes tool via appropriate transport
7. Result injected into conversation; stream resumes

### WhatsApp Message Path

1. Incoming webhook → `/api/whatsapp/webhook/route.ts`
2. `WhatsAppClientFactory.getClient()` (`src/lib/whatsapp/client-factory.ts`) returns Fly.io or Koyeb client
3. Message converted to `APIMessage` via `src/lib/whatsapp/message-converter.ts`
4. Internal POST to `/api/chat` with `disableRAG` and `systemPromptOverride` options
5. Response streamed back; `WebhookHandler` sends reply to WhatsApp

**State Management:**
- Server state: Supabase tables (`chats`, `documents`, `document_chunks`, `folders`, `organizations`)
- Client state: Zustand stores — `useChatStore`, `useWebSearchStore`, `useFileUploadStore`, `useOrganizationStore`, `useReasoningStore`, `useGhostModeStore`, `useUserSettingsStore`, `useDocumentMentionStore`, `useMultiFileUploadStore`
- MCP approval state: `globalThis.toolApprovalState` map (server-side, in-memory)
- MCP tools cache: `getCachedTools`/`setCachedTools` (`src/lib/mcp-cache.ts`)

## Key Abstractions

**ExtendedMessage / APIMessage / ContentPart:**
- Purpose: Multi-modal message with text, image_url, document, generated_image, generated_video, generated_3d_model parts
- Examples: `src/types/chat.ts`, `src/types/messages.ts`
- Pattern: `fromAPIMessages()` / `toAPIMessage()` conversion at API boundary

**RAG Pipeline Composites:**
- Purpose: Layered retrieval — basic pgvector similarity → BM25 re-rank → MMR diversity → adjacent chunks
- Examples: `src/lib/optimized-search.ts`, `src/lib/retrieval-strategies.ts`, `src/lib/enhanced-rag-retrieval.ts`, `src/lib/adaptive-retrieval.ts`
- Pattern: Each module adds one optimization step; chat route composes them conditionally

**UniversalMcpClient (singleton):**
- Purpose: Discover and invoke any MCP tool without hardcoded tool names
- Examples: `src/lib/mcp/universal-client.ts`, `src/lib/mcp/discovery.ts`, `src/lib/mcp/transport-factory.ts`
- Pattern: `getInstance()` singleton; transport selected by `TransportFactory` (HTTP SSE vs WebSocket vs stdio)

**SystemPromptManager:**
- Purpose: Assemble final system prompt from i18n templates with `{{context}}` placeholder replaced at request time
- Examples: `src/lib/system-prompt-manager.ts`, `src/translations/en.ts`
- Pattern: Static class with `getPromptTemplate(key, language)` + `assemblePrompt(pre, context, post)`

**WhatsApp Provider Factory:**
- Purpose: Return correct WhatsApp API client (Fly.io or Koyeb Baileys) without changing call sites
- Examples: `src/lib/whatsapp/client-factory.ts`, `src/lib/whatsapp/base-client.ts`
- Pattern: Factory singleton; provider chosen by `WHATSAPP_PROVIDER` env var

## Entry Points

**Main Chat SPA:**
- Location: `src/app/page.tsx`
- Triggers: Direct browser navigation to `/`
- Responsibilities: Chat UI, model selection, file upload, sidebar, MCP tool controls

**Embedded Widget:**
- Location: `src/app/embed/window/page.tsx`, `src/app/embed/chat.js`
- Triggers: Third-party site iframes `/embed/window`
- Responsibilities: Lightweight chat widget with rate limiting (`src/lib/embed-rate-limit.ts`)

**Config Dashboard:**
- Location: `src/app/config-ui/page.tsx` (served at port 3333 via `scripts/config-server.js`)
- Triggers: `npm run config`
- Responsibilities: Visual env management, model arrays, RAG prompt tuning, admin users

**Auth Flow:**
- Location: `src/app/auth/page.tsx`, `src/app/auth/callback/route.ts`
- Triggers: Unauthenticated requests when `NEXT_PUBLIC_AUTH_ENABLED=true`
- Responsibilities: Supabase OAuth (GitHub), email/password, magic links

**WhatsApp Webhook:**
- Location: `src/app/api/whatsapp/webhook/route.ts`
- Triggers: POST from WhatsApp Baileys deployment
- Responsibilities: Receive messages, call internal chat API, return AI responses

## Architectural Constraints

- **Runtime:** All API routes explicitly declare `export const runtime = 'nodejs'` — no Edge runtime used
- **Streaming:** All AI responses use AI SDK 5 `streamText()` with SSE; never buffered full responses
- **Singleton infrastructure:** `SupabaseManager`, `EnvironmentConfig`, `UniversalMcpClient` use `getInstance()` pattern — safe for Node.js single-process; not safe for multi-process without external state
- **Global state:** `globalThis.toolApprovalState`, `globalThis.persistentMcpClient`, `globalThis.mcpImageContext` used for MCP state in `src/app/api/chat/route.ts` — process-scoped, lost on restart
- **Circular imports:** `src/lib/supabase.ts` imports `src/lib/env.ts` and `src/lib/document-processor.ts` imports `src/lib/supabase.ts` — keep this chain single-direction
- **Model synchronization:** Model lists must be kept in sync across 5 locations (`.env.local`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, `scripts/config-ui/index.html`)
- **Deployment mode:** Multi-tenant org/quota features are gated by `isMultiTenant()` from `src/lib/deployment-mode.ts`; defaulting to single-tenant

## Anti-Patterns

### globalThis as approval state store

**What happens:** `globalThis.toolApprovalState` in `src/app/api/chat/route.ts` holds pending tool approvals across requests.
**Why it's wrong:** Lost on process restart; incompatible with multi-instance deployments (Vercel serverless, load-balanced containers).
**Do this instead:** Store approval state in Supabase `tool_execution_state` table via `ToolExecutionStateService` (`src/lib/tool-execution-state.ts`), which already exists for this purpose.

### Oversized monolithic API route

**What happens:** `src/app/api/chat/route.ts` is 4255 lines containing RAG retrieval, MCP dispatch, image routing, multi-step orchestration, email intent detection, and system prompt assembly inline.
**Why it's wrong:** Extremely difficult to test, extend, or reason about; conditional branches interact non-obviously.
**Do this instead:** Extract each concern (RAG, MCP dispatch, image routing, multi-step) into dedicated handler modules under `src/lib/chat-handlers/` and compose them in the route handler.

### Log spam in hot paths

**What happens:** Extensive `console.log` calls throughout `src/app/api/chat/route.ts` and RAG modules run on every request.
**Why it's wrong:** Degrades server throughput; clutters observability; `CLAUDE.md` explicitly prohibits this.
**Do this instead:** Use `logger.debug()` from `src/lib/logger.ts` (suppressed in production) or the `devLog()` helper from `src/lib/dev-logger.ts`.

## Error Handling

**Strategy:** API routes catch errors and return SSE-formatted error events using `formatErrorSSE()` from `src/lib/error-stream.ts`. Structured JSON errors returned for non-streaming endpoints.

**Patterns:**
- SSE errors: `return new Response(formatErrorSSE(message), { headers: { 'Content-Type': 'text/event-stream' } })`
- REST errors: `return NextResponse.json({ success: false, error: '...', details: [...] }, { status: 4xx })`
- Provider-specific errors mapped to user-friendly messages via `friendlyProviderErrorMessage()` in `src/app/api/chat/route.ts`
- Request validation: `withValidation(schema, handler)` from `src/lib/api-middleware.ts` wraps Zod schema validation

## Cross-Cutting Concerns

**Logging:** `src/lib/logger.ts` (`SmartLogger` with deduplication) for server; `src/lib/dev-logger.ts` (`devLog()`) for development-only client/server logs; `NEXT_PUBLIC_DISABLE_DEBUG_LOGS=true` silences all console methods client-side.

**Validation:** Zod (`zod/v3`) used for API input validation; `withValidation()` in `src/lib/api-middleware.ts` wraps route handlers.

**Authentication:** Supabase Auth via `src/components/providers/auth-provider.tsx` (client) and `createRouteHandlerClient` (server routes); `NEXT_PUBLIC_AUTH_ENABLED` feature flag; admin auth via separate `src/app/api/admin/` endpoints.

**i18n:** `src/translations/` contains 18 language files; `src/components/providers/language-provider.tsx` supplies current language; `SystemPromptManager` resolves system prompts by language.

---

*Architecture analysis: 2026-06-01*
