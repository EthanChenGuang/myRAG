# Codebase Structure

**Analysis Date:** 2026-03-08

## Directory Layout

```
my-chat-rag/
├── src/
│   ├── app/                    # Next.js App Router pages and API routes
│   │   ├── api/                # All API route handlers
│   │   │   ├── admin/          # Admin auth and settings endpoints
│   │   │   ├── ai-to-rag/     # AI-to-RAG pipeline endpoint
│   │   │   ├── audio/          # Audio/TTS endpoint
│   │   │   ├── auth/           # Auth check endpoint
│   │   │   ├── chat/           # Core chat streaming + tool approval
│   │   │   ├── chats/          # Chat CRUD and sharing
│   │   │   ├── config/         # Runtime config, models, prompts, logos, env
│   │   │   ├── create-checkout/ # Polar payment checkout
│   │   │   ├── create-stripe-checkout/ # Stripe payment checkout
│   │   │   ├── documents/      # Document listing and management
│   │   │   ├── embed/          # Embeddable widget API + live config
│   │   │   ├── extract-name/   # Chat name extraction
│   │   │   ├── folders/        # Folder CRUD and chat moves
│   │   │   ├── generate-3d/    # 3D model generation (Meshy)
│   │   │   ├── generate-image/ # Image generation (Flux, Fal, Replicate)
│   │   │   ├── generate-video/ # Video generation (Luma, Runway)
│   │   │   ├── invites/        # Team invitation endpoints
│   │   │   ├── mcp/            # MCP server management
│   │   │   ├── nango/          # Nango connector endpoints
│   │   │   ├── organizations/  # Multi-tenant org management
│   │   │   ├── process-document/ # Document ingestion pipeline
│   │   │   ├── scrapers/       # Web scraping (Firecrawl)
│   │   │   ├── title/          # Chat title generation
│   │   │   ├── tool-execution-state/ # MCP tool state tracking
│   │   │   ├── upload/         # File upload handler
│   │   │   ├── user/           # User profile and preferences
│   │   │   ├── web-search/     # Web search (Exa)
│   │   │   ├── webhooks/       # Stripe webhook handler
│   │   │   └── whatsapp/       # WhatsApp connection, QR, messaging
│   │   ├── auth/               # Auth pages (login, signup, callback, verify)
│   │   ├── config-ui/          # Config dashboard page
│   │   ├── embed/              # Embeddable chat widget pages
│   │   ├── pricing/            # Polar pricing page
│   │   ├── pricing-stripe/     # Stripe pricing page
│   │   ├── shared/             # Shared chat view pages
│   │   ├── layout.tsx          # Root server layout (metadata)
│   │   ├── client-layout.tsx   # Client layout (providers, sidebar, theme)
│   │   ├── page.tsx            # Main chat page (4685 lines)
│   │   └── globals.css         # Global Tailwind styles
│   ├── components/
│   │   ├── providers/          # React context providers (8 providers)
│   │   ├── config-ui/          # Config dashboard components
│   │   │   └── connectors/     # Nango connector UI
│   │   └── ui/                 # All UI components (~90 files)
│   │       ├── artifact-sidebar/ # Code/content artifact viewer
│   │       ├── markdown/       # Markdown rendering components
│   │       ├── mcp-tools/      # MCP tool UI (components, hooks, styles)
│   │       ├── nango/          # Nango connector UI
│   │       ├── scrapers/       # Web scraper UI
│   │       └── settings/       # Settings modal (tabs, components, hooks)
│   ├── contexts/               # React contexts
│   │   └── mobile-tools-context.tsx
│   ├── hooks/                  # Custom React hooks
│   │   ├── use-mobile-detection.ts
│   │   └── useShareChat.ts
│   ├── lib/                    # Core business logic and utilities
│   │   ├── auth/               # Organization auth handler
│   │   ├── config/             # Connector configuration
│   │   ├── framer-motion/      # Motion animation utilities
│   │   ├── hooks/              # Lib-level hooks
│   │   ├── mcp/                # MCP client, router, discovery, transports
│   │   │   ├── query-patterns/ # Intent matching patterns per MCP server
│   │   │   └── transports/     # MCP transport implementations
│   │   ├── nango/              # Nango sync manager and adapters
│   │   ├── scrapers/           # Firecrawl client and adapter
│   │   ├── stores/             # Additional Zustand stores
│   │   ├── supabase/           # Supabase client/server/middleware helpers
│   │   ├── utils/              # Date grouping, title sanitization
│   │   └── whatsapp/           # WhatsApp client factory, providers, webhooks
│   ├── translations/           # i18n files (20 languages)
│   └── types/                  # TypeScript type definitions
│       ├── chat.ts             # Chat, message, content part types
│       ├── events.ts           # Event types
│       ├── folder.ts           # Folder types
│       └── messages.ts         # Message types
├── scripts/
│   ├── config-server.js        # Express server for config dashboard (port 3333)
│   ├── config-ui/              # Config dashboard HTML/JS frontend
│   │   ├── index.html          # Main config UI page
│   │   ├── admin/              # Admin management UI
│   │   ├── document-processing/ # Document processing config UI
│   │   ├── pickers/            # UI picker components
│   │   └── utils/              # Config UI utilities
│   ├── init-env.js             # Environment bootstrap (creates .env.local)
│   ├── setup-database.sh       # Supabase database setup script
│   ├── rag/                    # RAG diagnostic scripts
│   └── whatsapp/               # WhatsApp testing scripts
├── supabase/
│   ├── single-tenant-setup.sql # SQL schema for single-tenant mode
│   └── multi-tenant-setup.sql  # SQL schema for multi-tenant mode
├── public/                     # Static assets
│   ├── connectors/             # Connector icons
│   ├── icons/                  # App icons
│   └── logos/                  # Brand logos (ai, defaults, header)
├── prompts/                    # Prompt templates
├── next.config.js              # Next.js 16 config (React Compiler enabled)
├── tailwind.config.ts          # Tailwind CSS configuration
├── tsconfig.json               # TypeScript config (path alias: @/* -> src/*)
├── eslint.config.mjs           # ESLint flat config
├── postcss.config.mjs          # PostCSS config
├── vercel.json                 # Vercel deployment config
└── package.json                # Dependencies and scripts
```

## Directory Purposes

**`src/app/api/`:**
- Purpose: All server-side API endpoints
- Contains: `route.ts` files following Next.js App Router conventions
- Key files: `chat/route.ts` (4226 lines - main chat streaming), `chat/approve/route.ts` (4823 lines - MCP approval), `process-document/route.ts` (800 lines - document ingestion)

**`src/components/ui/`:**
- Purpose: All reusable UI components
- Contains: ~90 React component files, organized into subdirectories for complex features
- Key files: `chat-message.tsx` (5586 lines), `chat-input.tsx` (4875 lines), `sidebar.tsx` (2697 lines), `document-dashboard.tsx` (1697 lines), `model-selector.tsx`, `header.tsx`

**`src/components/providers/`:**
- Purpose: React context providers wrapping the entire app
- Contains: 8 provider files for auth, model, theme, font, text size, language, artifacts, sources
- Key files: `auth-provider.tsx`, `model-provider.tsx`, `language-provider.tsx`

**`src/lib/`:**
- Purpose: Core business logic, utilities, and service integrations
- Contains: Singletons (env, supabase, MCP client), RAG pipeline modules, Zustand stores, integration clients
- Key files: `env.ts` (env singleton), `supabase.ts` (DB manager), `chat-store.ts` (chat state), `document-processor.ts` (embeddings), `retrieval-strategies.ts` (RAG search)

**`src/lib/mcp/`:**
- Purpose: Model Context Protocol integration
- Contains: Universal client, transport factory, server discovery, query pattern matching, routing
- Key files: `universal-client.ts`, `production-router.ts`, `smart-router.ts`, `discovery.ts`

**`src/lib/whatsapp/`:**
- Purpose: WhatsApp integration via Baileys (Fly.io or Koyeb)
- Contains: Client factory pattern with provider-specific implementations
- Key files: `client-factory.ts`, `flyio-client.ts`, `koyeb-client.ts`, `webhook-handler.ts`

**`src/translations/`:**
- Purpose: Internationalization strings for 20 languages
- Contains: One file per language (`.ts` or `.json`)
- Key files: `en.ts` (primary), `index.ts` (language registry)

**`src/types/`:**
- Purpose: Shared TypeScript type definitions
- Contains: Chat types, message types, event types, folder types
- Key files: `chat.ts` (ContentPart, ExtendedMessage, APIMessage, DBMessage conversions)

**`scripts/`:**
- Purpose: Dev tooling, environment setup, diagnostics
- Contains: Node.js scripts and shell scripts
- Key files: `init-env.js` (env bootstrap), `config-server.js` (config dashboard server)

**`supabase/`:**
- Purpose: Database schema definitions
- Contains: SQL setup scripts for both deployment modes
- Key files: `single-tenant-setup.sql`, `multi-tenant-setup.sql`

## Key File Locations

**Entry Points:**
- `src/app/layout.tsx`: Root server layout (metadata generation)
- `src/app/client-layout.tsx`: Client layout shell (provider tree, sidebar, global styles)
- `src/app/page.tsx`: Main chat page (entire chat UI in one file)
- `src/app/api/chat/route.ts`: Core chat API (RAG + streaming + MCP)

**Configuration:**
- `next.config.js`: Next.js config (React Compiler, image domains, Turbopack)
- `tsconfig.json`: TypeScript config (`@/*` path alias to `src/*`)
- `tailwind.config.ts`: Tailwind theme and plugins
- `src/lib/env.ts`: Runtime environment variable singleton
- `src/lib/deployment-mode.ts`: Single/multi-tenant feature flags
- `scripts/init-env.js`: Default `.env.local` template

**Core Logic:**
- `src/app/api/chat/route.ts`: Chat streaming with RAG context injection
- `src/lib/document-processor.ts`: Document parsing and embedding generation
- `src/lib/retrieval-strategies.ts`: Multi-strategy RAG retrieval (vector + BM25 + MMR)
- `src/lib/enhanced-rag-retrieval.ts`: Temporal and financial-aware retrieval
- `src/lib/semantic-chunker.ts`: Document chunking logic
- `src/lib/mcp/universal-client.ts`: MCP tool discovery and execution
- `src/lib/system-prompt-manager.ts`: System prompt assembly with i18n

**State Management:**
- `src/lib/chat-store.ts`: Chat CRUD, folders, sidebar state (Zustand)
- `src/lib/file-upload-store.ts`: File upload tracking (Zustand)
- `src/lib/user-settings-store.ts`: User preferences (Zustand)
- `src/lib/web-search-store.ts`: Web search toggle state (Zustand)
- `src/lib/ghost-mode-store.ts`: Ghost mode state (Zustand)
- `src/lib/stores/organization-store.ts`: Organization/tenant state (Zustand)
- `src/lib/stores/reasoning-store.ts`: Reasoning mode state (Zustand)

**Database:**
- `src/lib/supabase.ts`: Supabase connection manager singleton
- `src/lib/supabase/client.ts`: Browser Supabase client
- `src/lib/supabase/server.ts`: Server Supabase client
- `src/lib/supabase/middleware.ts`: Supabase auth middleware
- `supabase/single-tenant-setup.sql`: Single-tenant schema
- `supabase/multi-tenant-setup.sql`: Multi-tenant schema

**Testing:**
- No test framework or test files detected in `src/`
- `scripts/rag/test-rag-system.js`: RAG system integration test script
- `scripts/whatsapp/tests/`: WhatsApp integration test scripts

## Naming Conventions

**Files:**
- Components: `kebab-case.tsx` (e.g., `chat-message.tsx`, `model-selector.tsx`)
- Stores: `kebab-case-store.ts` (e.g., `chat-store.ts`, `ghost-mode-store.ts`)
- Lib modules: `kebab-case.ts` (e.g., `document-processor.ts`, `retrieval-strategies.ts`)
- API routes: `route.ts` inside descriptive directory (e.g., `api/chat/route.ts`)
- Types: `kebab-case.ts` (e.g., `types/chat.ts`)
- Providers: `kebab-case-provider.tsx` (e.g., `auth-provider.tsx`)

**Directories:**
- API routes: `kebab-case` (e.g., `process-document/`, `generate-image/`)
- Dynamic routes: `[paramName]` (e.g., `[id]/`, `[shareId]/`, `[lang]/`)
- Feature groups: `kebab-case` (e.g., `mcp-tools/`, `artifact-sidebar/`)

**Exports:**
- Components: PascalCase named exports (e.g., `export function ChatMessage`)
- Stores: camelCase hook exports (e.g., `export const useChatStore`)
- Utilities: camelCase function exports (e.g., `export function getQueryEmbedding`)
- Types: PascalCase interfaces (e.g., `export interface ContentPart`)
- Singletons: camelCase instances (e.g., `export const env`, `export const supabase`)

## Where to Add New Code

**New API Endpoint:**
- Create directory: `src/app/api/{endpoint-name}/`
- Add: `route.ts` with `export async function POST/GET/etc.`
- Use `withValidation` from `src/lib/api-middleware.ts` for request validation
- Import env from `src/lib/env.ts`, supabase from `src/lib/supabase.ts`

**New UI Component:**
- Simple component: `src/components/ui/{component-name}.tsx`
- Complex feature: `src/components/ui/{feature-name}/` directory with `index.tsx`, `hooks/`, `components/`, `styles/`
- Follow pattern: `'use client'` directive, functional component, Tailwind classes

**New Zustand Store:**
- Simple store: `src/lib/{feature}-store.ts`
- Feature-grouped store: `src/lib/stores/{feature}-store.ts`
- Follow pattern: `create<StoreInterface>()((set, get) => ({ ... }))`
- Use `useShallow` in consuming components

**New React Provider:**
- Location: `src/components/providers/{feature}-provider.tsx`
- Add to provider tree in `src/app/client-layout.tsx`

**New RAG Module:**
- Location: `src/lib/{module-name}.ts`
- Integrate into `src/lib/retrieval-strategies.ts` or `src/lib/enhanced-rag-retrieval.ts`

**New MCP Integration:**
- Query patterns: `src/lib/mcp/query-patterns/servers/{server-name}.ts`
- Transport: `src/lib/mcp/transports/{transport-name}.ts`

**New Integration/External Service:**
- Client library: `src/lib/{service-name}/` directory
- API routes: `src/app/api/{service-name}/route.ts`

**New Translation:**
- Add language file: `src/translations/{lang-code}.ts`
- Register in `src/translations/index.ts`

**Utilities:**
- General helpers: `src/lib/utils.ts` (contains `cn()` classname merger)
- Specialized utils: `src/lib/utils/{utility-name}.ts`
- Date utils: `src/lib/utils/date-grouping.ts`

## Special Directories

**`scripts/config-ui/`:**
- Purpose: Standalone configuration dashboard (HTML/JS, not React)
- Generated: No (hand-written)
- Committed: Yes
- Note: Served by Express via `scripts/config-server.js` on port 3333, separate from Next.js

**`.next/`:**
- Purpose: Next.js build output and cache
- Generated: Yes
- Committed: No (in `.gitignore`)

**`public/`:**
- Purpose: Static assets served at root URL
- Generated: No
- Committed: Yes
- Contains: Logos, icons, connector images

**`supabase/`:**
- Purpose: Database schema SQL files (not Supabase CLI project)
- Generated: No
- Committed: Yes
- Note: Applied manually via Supabase dashboard or `scripts/setup-database.sh`

**`prompts/`:**
- Purpose: Prompt template documentation
- Generated: No
- Committed: Yes

**`logs/`:**
- Purpose: Runtime log output
- Generated: Yes
- Committed: No (in `.gitignore`)

---

*Structure analysis: 2026-03-08*
