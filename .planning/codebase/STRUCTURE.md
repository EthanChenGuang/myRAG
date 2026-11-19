# Codebase Structure

**Analysis Date:** 2026-06-01

## Directory Layout

```
knows/                          # Project root
├── src/
│   ├── app/                    # Next.js App Router pages and API routes
│   │   ├── page.tsx            # Main chat SPA entry point
│   │   ├── layout.tsx          # Root layout (metadata + ClientLayout wrapper)
│   │   ├── client-layout.tsx   # Provider tree, fonts, global CSS, mobile viewport
│   │   ├── globals.css         # Tailwind base + custom scroll/layout styles
│   │   ├── api/                # Next.js API route handlers
│   │   │   ├── chat/           # Core chat + MCP approval
│   │   │   ├── process-document/  # Document ingestion
│   │   │   ├── upload/         # File upload to Supabase Storage
│   │   │   ├── documents/      # Document CRUD
│   │   │   ├── generate-image/ # Image generation (Flux/DALL-E)
│   │   │   ├── generate-video/ # Video generation (Luma/Runway)
│   │   │   ├── generate-3d/    # 3D model generation (Meshy)
│   │   │   ├── whatsapp/       # WhatsApp webhook + session management
│   │   │   ├── nango/          # Nango OAuth connector sync
│   │   │   ├── organizations/  # Multi-tenant org management
│   │   │   ├── admin/          # Admin auth + settings
│   │   │   ├── config/         # Runtime config (models, logo, RAG prompt)
│   │   │   ├── chats/          # Chat history CRUD + sharing
│   │   │   ├── folders/        # Folder management
│   │   │   ├── auth/           # Auth check
│   │   │   ├── webhooks/       # Stripe webhook
│   │   │   ├── invites/        # Team invite tokens
│   │   │   ├── user/           # User profile + preferences
│   │   │   ├── mcp/            # MCP server CRUD + health
│   │   │   ├── scrapers/       # Web scraping (Firecrawl)
│   │   │   ├── web-search/     # Web search
│   │   │   ├── audio/          # Audio transcription (ElevenLabs)
│   │   │   ├── title/          # Chat title generation
│   │   │   ├── extract-name/   # Document name extraction
│   │   │   ├── embed/          # Embeddable widget API
│   │   │   ├── tool-execution-state/  # MCP approval state
│   │   │   ├── ai-to-rag/      # AI-to-RAG pipeline
│   │   │   ├── create-checkout/       # Polar checkout
│   │   │   └── create-stripe-checkout/ # Stripe checkout
│   │   ├── auth/               # Auth pages (login, signup, verify-email, callback)
│   │   ├── embed/              # Embeddable chat widget pages + chat.js
│   │   ├── pricing/            # Polar pricing page
│   │   ├── pricing-stripe/     # Stripe pricing page
│   │   ├── shared/             # Shared chat viewer (public share links)
│   │   └── config-ui/          # Admin config dashboard page
│   ├── components/
│   │   ├── ui/                 # Feature and primitive UI components
│   │   │   ├── artifact-sidebar/   # Code/artifact display sidebar
│   │   │   ├── markdown/           # Markdown renderer components
│   │   │   ├── mcp-tools/          # MCP tool list, approval, status UI
│   │   │   ├── nango/              # Nango connector UI
│   │   │   ├── scrapers/           # Web scraper UI
│   │   │   └── settings/           # Settings modal + tabs
│   │   ├── providers/          # React context providers
│   │   │   ├── auth-provider.tsx
│   │   │   ├── model-provider.tsx
│   │   │   ├── artifact-provider.tsx
│   │   │   ├── sources-provider.tsx
│   │   │   ├── text-size-provider.tsx
│   │   │   ├── font-provider.tsx
│   │   │   ├── language-provider.tsx
│   │   │   └── markdown-provider.tsx
│   │   └── config-ui/          # Config dashboard UI components
│   ├── lib/                    # Business logic, AI, RAG, integrations
│   │   ├── supabase.ts         # Supabase singleton (admin + anon clients)
│   │   ├── supabase/           # Browser-side Supabase client + middleware
│   │   ├── env.ts              # Environment config singleton
│   │   ├── deployment-mode.ts  # Single/multi-tenant mode + feature flags
│   │   ├── chat-store.ts       # Zustand: chat list, folders, current chat
│   │   ├── document-processor.ts  # Parse + chunk + embed documents
│   │   ├── retrieval-strategies.ts # Multi-pass RAG retrieval
│   │   ├── optimized-search.ts    # BM25/MMR reranking + query enhancement
│   │   ├── enhanced-rag-retrieval.ts
│   │   ├── adaptive-retrieval.ts
│   │   ├── semantic-chunker.ts    # Semantic text chunking
│   │   ├── bm25-scorer.ts
│   │   ├── mmr-scorer.ts
│   │   ├── reranker-local.ts
│   │   ├── query-enhancer-local.ts
│   │   ├── query-classifier.ts    # Classify query: conversational/tool/doc/multi-step
│   │   ├── multi-step-parser.ts
│   │   ├── system-prompt-manager.ts
│   │   ├── thinking-rag-enhancer.ts
│   │   ├── mcp-cache.ts
│   │   ├── tool-execution-state.ts
│   │   ├── api-middleware.ts       # Zod request validation wrapper
│   │   ├── error-stream.ts         # SSE error formatting
│   │   ├── logger.ts              # Smart deduplicating logger
│   │   ├── dev-logger.ts
│   │   ├── openrouter.ts
│   │   ├── stripe.ts
│   │   ├── polar.ts
│   │   ├── supabase-auth.ts
│   │   ├── types.ts               # Shared lib types (chunks, documents)
│   │   ├── env-utils.ts
│   │   ├── upload-utils.ts
│   │   ├── url-extractor.ts
│   │   ├── pdf-utils.ts
│   │   ├── audio-utils.ts
│   │   ├── elevenlabs-utils.ts
│   │   ├── embed-rate-limit.ts
│   │   ├── chat-utils.ts
│   │   ├── chat-title-utils.ts
│   │   ├── rag-mode.ts
│   │   ├── temporal-metadata-extractor.ts
│   │   ├── temporal-query-detector.ts
│   │   ├── universal-tool-formatter.ts
│   │   ├── title-generator.ts
│   │   ├── title-generator-creative.ts
│   │   ├── title-generator-multimodal.ts
│   │   ├── admin-utils.ts
│   │   ├── performance-monitor.tsx
│   │   ├── ghost-mode-store.ts
│   │   ├── web-search-store.ts
│   │   ├── file-upload-store.ts
│   │   ├── multi-file-upload-store.ts
│   │   ├── document-mention-store.ts
│   │   ├── user-settings-store.ts
│   │   ├── auth/               # Auth helpers (organization-handler)
│   │   ├── config/             # Connector config loader
│   │   ├── framer-motion/      # Framer Motion lazy imports
│   │   ├── hooks/              # Shared React hooks
│   │   ├── mcp/                # MCP client, router, discovery, transports
│   │   │   ├── universal-client.ts
│   │   │   ├── smart-router.ts
│   │   │   ├── discovery.ts
│   │   │   ├── universal-discovery.ts
│   │   │   ├── production-router.ts
│   │   │   ├── transport-factory.ts
│   │   │   ├── transports/
│   │   │   ├── query-patterns/     # Per-server MCP tool detection patterns
│   │   │   │   └── servers/
│   │   │   ├── server-config.ts
│   │   │   ├── image-context-manager.ts
│   │   │   └── url-validator.ts
│   │   ├── nango/              # Nango OAuth sync (client, file-fetcher, sync-manager)
│   │   ├── scrapers/           # Firecrawl scraper helpers
│   │   ├── stores/             # Additional Zustand stores
│   │   │   ├── organization-store.ts
│   │   │   └── reasoning-store.ts
│   │   ├── supabase/           # Browser Supabase client + middleware
│   │   │   ├── client.ts
│   │   │   ├── server.ts
│   │   │   └── middleware.ts
│   │   ├── utils/              # Shared utility functions
│   │   │   ├── date-grouping.ts
│   │   │   ├── sanitize-title.ts
│   │   │   └── features.ts
│   │   └── whatsapp/           # WhatsApp client abstraction
│   │       ├── base-client.ts
│   │       ├── client-factory.ts
│   │       ├── flyio-client.ts
│   │       ├── koyeb-client.ts
│   │       ├── connection-monitor.ts
│   │       ├── message-converter.ts
│   │       ├── session-manager.ts
│   │       ├── webhook-handler.ts
│   │       └── types.ts
│   ├── contexts/               # React context (non-provider pattern)
│   │   └── mobile-tools-context.tsx
│   ├── hooks/                  # App-level React hooks
│   │   ├── use-mobile-detection.ts
│   │   ├── useShareChat.ts
│   │   ├── use-audio-settings.ts
│   │   ├── use-connector-config.ts
│   │   ├── use-firecrawl-config.ts
│   │   ├── use-nango.ts
│   │   ├── use-organization.ts
│   │   └── use-touch-device.ts
│   ├── types/                  # Shared TypeScript types
│   │   ├── chat.ts             # ExtendedMessage, APIMessage, ContentPart, DocumentContent
│   │   ├── folder.ts
│   │   ├── messages.ts
│   │   └── events.ts
│   └── translations/           # i18n translations (18 languages)
│       ├── en.ts               # English (primary, includes systemPrompts)
│       ├── index.ts
│       └── [lang].ts           # ar, de, es, fr, hi, hr, ja, ko, lt, pt, ru, sl, sr, sw, yo, zh
├── scripts/
│   ├── init-env.js             # Default .env.local template generator
│   ├── config-server.js        # Config dashboard dev server (port 3333)
│   ├── config-ui/              # Config dashboard HTML/JS app
│   │   ├── index.html
│   │   ├── admin/
│   │   ├── document-processing/
│   │   ├── pickers/
│   │   └── utils/
│   ├── rag/                    # RAG diagnostic scripts
│   │   ├── check-rag-flow.js
│   │   ├── decode-rag-prompt.js
│   │   ├── test-rag-system.js
│   │   └── reprocess-documents.js
│   ├── setup-database.sh       # Supabase schema setup
│   └── whatsapp/               # WhatsApp test scripts
├── public/
│   ├── icons/                  # UI icons
│   ├── logos/                  # AI provider logos + header logos
│   └── connectors/             # Connector brand assets
├── supabase/                   # Supabase migrations (if present)
├── .planning/
│   └── codebase/               # GSD codebase map documents
├── .claude/
│   ├── skills/                 # Project skills (myrag-expert, brainstorming)
│   └── commands/               # Custom Claude commands
├── .auto-claude/               # AI-generated ideation, specs, roadmap
├── next.config.js
├── tailwind.config.ts
├── tsconfig.json
├── package.json
├── vercel.json
└── CLAUDE.md                   # Project rules for Claude agents
```

## Directory Purposes

**`src/app/api/`:**
- Purpose: All server-side HTTP endpoints
- Contains: One `route.ts` per endpoint; all use `export const runtime = 'nodejs'`
- Key files: `chat/route.ts` (4255 lines, core pipeline), `chat/approve/route.ts`, `process-document/route.ts`

**`src/app/` (pages):**
- Purpose: App Router page components and layouts
- Contains: `page.tsx`, `layout.tsx`, `client-layout.tsx`, and sub-routes for auth/embed/pricing/shared
- Key files: `page.tsx` (main SPA), `client-layout.tsx` (provider tree + global CSS)

**`src/components/ui/`:**
- Purpose: All rendered UI components — feature components and primitives
- Contains: ~70 `.tsx` files plus subdirectories for complex components (artifact-sidebar, mcp-tools, settings, markdown)
- Key files: `chat-message.tsx`, `chat-input.tsx`, `sidebar.tsx`, `header.tsx`, `model-selector.tsx`, `settings-modal.tsx`

**`src/components/providers/`:**
- Purpose: React context providers wrapping the app in `client-layout.tsx`
- Contains: 8 providers — auth, model, artifact, sources, text-size, font, language, markdown

**`src/lib/`:**
- Purpose: All business logic, AI utilities, Zustand stores, and integration clients
- Contains: ~60 TypeScript modules across RAG pipeline, MCP client, WhatsApp, Nango, Stripe, Supabase, and stores

**`src/lib/mcp/`:**
- Purpose: Universal MCP tool discovery, routing, and execution
- Contains: `universal-client.ts` (singleton), `smart-router.ts`, `discovery.ts`, `transport-factory.ts`, `transports/`, `query-patterns/servers/`

**`src/lib/whatsapp/`:**
- Purpose: Provider-agnostic WhatsApp API abstraction
- Contains: `base-client.ts` (interface), `client-factory.ts` (singleton factory), `flyio-client.ts`, `koyeb-client.ts`

**`src/types/`:**
- Purpose: Shared TypeScript interfaces and type utilities used by both frontend and API routes
- Contains: `chat.ts` (primary message types + serialization), `folder.ts`, `messages.ts`, `events.ts`

**`src/translations/`:**
- Purpose: i18n string tables for 18 languages; includes system prompt templates
- Key file: `src/translations/en.ts` (authoritative English source with `systemPrompts` object)

**`scripts/`:**
- Purpose: Dev tooling — env initialization, config dashboard server, RAG diagnostics, DB setup
- Key files: `init-env.js` (must mirror model arrays from `src/lib/env.ts`), `config-server.js` (port 3333)

## Key File Locations

**Entry Points:**
- `src/app/page.tsx`: Main chat SPA
- `src/app/layout.tsx`: Root Next.js layout
- `src/app/client-layout.tsx`: Provider tree + global styles
- `src/app/api/chat/route.ts`: Core POST handler for all chat requests
- `src/app/auth/page.tsx`: Login/signup page

**Configuration:**
- `src/lib/env.ts`: All environment variable access (singleton)
- `src/lib/deployment-mode.ts`: Single/multi-tenant mode
- `next.config.js`: Next.js configuration
- `tailwind.config.ts`: Tailwind theme configuration
- `tsconfig.json`: TypeScript config with `@/` path alias → `src/`

**Core Logic:**
- `src/lib/document-processor.ts`: Document parse + embed pipeline
- `src/lib/retrieval-strategies.ts`: Multi-pass RAG retrieval
- `src/lib/optimized-search.ts`: BM25/MMR reranking
- `src/lib/query-classifier.ts`: Query routing classifier
- `src/lib/system-prompt-manager.ts`: System prompt assembly
- `src/lib/mcp/universal-client.ts`: MCP tool execution
- `src/lib/chat-store.ts`: Primary Zustand chat state
- `src/lib/supabase.ts`: Supabase singleton with `searchSimilarChunks()`, `storeDocument()`

**Types:**
- `src/types/chat.ts`: `ExtendedMessage`, `APIMessage`, `ContentPart`, `DocumentContent`, `fromAPIMessages()`, `toAPIMessage()`

## Naming Conventions

**Files:**
- API routes: `route.ts` (Next.js convention), one per directory
- Components: `kebab-case.tsx` (e.g., `chat-message.tsx`, `model-selector.tsx`)
- Stores: `[name]-store.ts` (e.g., `chat-store.ts`, `ghost-mode-store.ts`)
- Utilities: `[name]-utils.ts` or `[name].ts` for single-concern modules
- Hooks: `use-[name].ts` or `use[Name].ts` (mixed, prefer `use-[name].ts`)
- Types: `[domain].ts` in `src/types/`

**Directories:**
- Feature groupings use kebab-case: `artifact-sidebar/`, `mcp-tools/`, `query-patterns/`
- API routes mirror URL paths: `src/app/api/organizations/[id]/members/[userId]/route.ts`

**Variables/Functions:**
- React components: PascalCase (`ChatMessage`, `ModelSelector`)
- Functions: camelCase (`classifyQuery`, `optimizedSearch`, `formatErrorSSE`)
- Zustand stores: `use[Name]Store` hook pattern (`useChatStore`, `useOrganizationStore`)
- Singleton classes: PascalCase with `getInstance()` (`SupabaseManager`, `UniversalMcpClient`)
- Environment variables: `SCREAMING_SNAKE_CASE`; public vars prefixed `NEXT_PUBLIC_`

## Where to Add New Code

**New API Endpoint:**
- Create `src/app/api/[your-endpoint]/route.ts`
- Export named `POST`, `GET`, etc. (not default export)
- Add `export const runtime = 'nodejs'` at top
- Use `withValidation(schema, handler)` from `src/lib/api-middleware.ts` for POST body validation
- Return SSE stream via `streamText()` for AI responses; `NextResponse.json()` for REST

**New UI Feature Component:**
- Create `src/components/ui/[feature-name].tsx`
- For complex features with subcomponents, create `src/components/ui/[feature-name]/` directory
- Use Tailwind classes; import `cn()` from `src/lib/utils.ts`
- Access shared state via Zustand stores with `useShallow` selector

**New Zustand Store:**
- Create `src/lib/[name]-store.ts`
- Use `create<StoreType>()` from `zustand`
- Export named `use[Name]Store` hook
- If persistent: add `persist` middleware from `zustand/middleware`
- Register store usage in relevant components with `useShallow`

**New RAG Utility / Retrieval Module:**
- Create `src/lib/[descriptive-name].ts`
- Import `supabase` from `src/lib/supabase.ts` and `getQueryEmbedding` from `src/lib/document-processor.ts`
- Compose into `src/lib/retrieval-strategies.ts` or `src/lib/optimized-search.ts`

**New MCP Server Pattern:**
- Add query pattern file to `src/lib/mcp/query-patterns/servers/`
- Register in `src/lib/mcp/query-patterns/index.ts` (if present)
- Transport handled automatically by `TransportFactory` in `src/lib/mcp/transport-factory.ts`

**New Translation:**
- Add key to `src/translations/en.ts` first (source of truth)
- Add corresponding key to all other language files in `src/translations/`
- For system prompts: add under `systemPrompts` object with `preContext` / `postContext` structure

**New Environment Variable:**
- Add to `src/lib/env.ts` `EnvironmentConfig.envVars` object
- Mirror in `scripts/init-env.js` default template
- If model-related: also update `scripts/config-server.js` and `scripts/config-ui/index.html`

## Special Directories

**`.planning/codebase/`:**
- Purpose: GSD codebase map documents (ARCHITECTURE.md, STRUCTURE.md, etc.)
- Generated: Yes (by `/gsd:map-codebase` command)
- Committed: Yes

**`.claude/skills/`:**
- Purpose: Project-specific Claude agent skills and workflows
- Generated: No (maintained by team)
- Committed: Yes

**`.auto-claude/`:**
- Purpose: AI-generated ideation, specs, roadmap documents
- Generated: Yes (by AI analysis commands)
- Committed: Optional

**`.next/`:**
- Purpose: Next.js build output and cache
- Generated: Yes
- Committed: No (in `.gitignore`)

**`scripts/config-ui/`:**
- Purpose: Standalone HTML/JS admin config dashboard (no React, served by `config-server.js`)
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-06-01*
