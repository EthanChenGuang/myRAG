# Codebase Structure

**Analysis Date:** 2026-03-08

## Directory Layout

```
my-chat-rag/
├── public/                    # Static assets (logos, icons, connectors)
│   ├── connectors/            # Connector icons
│   ├── icons/                 # App icons
│   │   └── connectors/        # Connector-specific icons
│   └── logos/                 # Logo variants
│       ├── ai/                # AI response logos
│       ├── defaults/          # Default logo assets
│       └── header/            # Header logo assets
├── scripts/                   # Dev tools, config UI, database setup
│   ├── config-ui/             # Visual configuration dashboard HTML/JS
│   │   ├── admin/             # Admin panel UI
│   │   ├── document-processing/ # Doc processing config UI
│   │   ├── pickers/           # Color/setting pickers
│   │   └── utils/             # Config UI utilities
│   ├── rag/                   # RAG diagnostic scripts
│   └── whatsapp/              # WhatsApp integration scripts
│       └── tests/             # WhatsApp test scripts
├── src/                       # Application source code
│   ├── app/                   # Next.js App Router pages and API routes
│   │   ├── api/               # All API route handlers (see below)
│   │   ├── auth/              # Auth pages (callback, signup, verify-email)
│   │   ├── config-ui/         # Config UI page wrapper
│   │   ├── embed/             # Embeddable chat widget
│   │   ├── pricing/           # Polar pricing page
│   │   ├── pricing-stripe/    # Stripe pricing page
│   │   └── shared/            # Shared chat view ([shareId])
│   ├── components/            # React components
│   │   ├── config-ui/         # Config UI React components
│   │   │   └── connectors/    # Connector config components
│   │   ├── providers/         # React context providers (8 providers)
│   │   └── ui/                # UI components (86 files)
│   │       ├── artifact-sidebar/ # Artifact sidebar with hooks/types/utils
│   │       ├── markdown/      # Markdown rendering components
│   │       ├── mcp-tools/     # MCP tools UI (components/hooks/styles)
│   │       ├── nango/         # Nango integration UI
│   │       ├── scrapers/      # Web scraper UI
│   │       └── settings/      # Settings modal (components/hooks/styles/tabs)
│   ├── contexts/              # React contexts (mobile-tools-context.tsx)
│   ├── hooks/                 # Custom React hooks
│   ├── lib/                   # Core business logic and utilities
│   │   ├── auth/              # Auth utilities (organization-handler.ts)
│   │   ├── config/            # Configuration utilities (connectors.ts)
│   │   ├── framer-motion/     # Framer Motion utilities
│   │   ├── hooks/             # Shared hooks (non-component)
│   │   ├── mcp/               # MCP client, discovery, transports, patterns
│   │   │   ├── query-patterns/ # Query classification patterns
│   │   │   │   └── servers/   # Server-specific patterns
│   │   │   └── transports/    # MCP transport implementations
│   │   ├── nango/             # Nango integration logic
│   │   ├── scrapers/          # Firecrawl scraper adapter
│   │   ├── stores/            # Additional Zustand stores
│   │   ├── supabase/          # Supabase client variants (client/server/middleware)
│   │   ├── utils/             # Utility functions (date-grouping, sanitize-title)
│   │   └── whatsapp/          # WhatsApp client factory and adapters
│   ├── translations/          # i18n translation files (20 languages)
│   └── types/                 # TypeScript type definitions
├── supabase/                  # Database setup SQL files
├── screenshots/               # App screenshots
├── prompts/                   # Prompt templates
├── logs/                      # Application logs (gitignored)
├── artifacts/                 # Research artifacts
│   └── research/              # Research documents
├── .planning/                 # Planning documents
│   └── codebase/              # Codebase analysis (this file)
├── .auto-claude/              # Auto-Claude specs and roadmap
└── .claude/                   # Claude Code skills and data
```

## Directory Purposes

**`src/app/api/`:**
- Purpose: All server-side API route handlers
- Contains: 30+ route directories, each with a `route.ts` file
- Key routes:
  - `chat/` - Main chat streaming endpoint + `approve/` for MCP tool approval
  - `documents/` - Document CRUD + `[id]/` for single doc operations
  - `config/` - Runtime config management (models, rag-prompt, system-prompts, embed, logos, etc.)
  - `admin/` - Admin auth and settings (check, login, logout, settings, status)
  - `mcp/` - MCP server management (execute, health, servers, tools)
  - `whatsapp/` - WhatsApp connection management (connect, disconnect, qr, status, webhook, etc.)
  - `nango/` - Nango connector management (connections, files, folders, notion, sync, webhook)
  - `organizations/` - Multi-tenant org management
  - `webhooks/stripe/` - Stripe webhook handler
  - `generate-image/`, `generate-video/`, `generate-3d/` - Multi-modal generation
  - `scrapers/` - Web scraping (crawl, scrape)
  - `upload/` - File upload handler
  - `process-document/` - Document processing pipeline

**`src/components/ui/`:**
- Purpose: All UI components for the chat application
- Contains: 86 files including complex component directories
- Key files:
  - `chat-input.tsx` - Message input with attachments, model selection
  - `chat-message.tsx` - Message rendering with markdown, tools, media
  - `sidebar.tsx` - Chat history sidebar with folders
  - `header.tsx` - App header with navigation
  - `model-selector.tsx` - AI model selection dropdown
  - `document-dashboard.tsx` - Document management UI
  - `settings-modal.tsx` - User settings
  - `artifact-sidebar/` - Code/content artifact preview panel
  - `mcp-tools/` - MCP tool display and management

**`src/components/providers/`:**
- Purpose: React context providers that wrap the entire app
- Contains: 8 provider files
- Key files:
  - `auth-provider.tsx` - Supabase auth state
  - `model-provider.tsx` - AI model selection and available models
  - `language-provider.tsx` - i18n language selection
  - `artifact-provider.tsx` - Artifact sidebar state
  - `sources-provider.tsx` - RAG source tracking

**`src/lib/`:**
- Purpose: All core business logic, utilities, and service clients
- Contains: ~50 TypeScript files + 7 subdirectories
- Key files (see Architecture doc for full details):
  - `env.ts` - Environment config singleton
  - `supabase.ts` - Supabase connection manager
  - `chat-store.ts` - Main Zustand chat store
  - `document-processor.ts` - Document ingestion pipeline
  - `enhanced-rag-retrieval.ts` - RAG retrieval with temporal/financial intelligence
  - `system-prompt-manager.ts` - System prompt assembly with i18n
  - `deployment-mode.ts` - Single vs multi-tenant mode
  - `api-middleware.ts` - Zod request validation
  - `logger.ts` - Smart centralized logging

**`src/translations/`:**
- Purpose: Internationalization translation files
- Contains: 20 language files (en, es, fr, de, ja, ko, zh, ar, hi, pt, ru, etc.)
- Key files: `index.ts` (exports), `en.ts` / `en.json` (primary locale)

**`src/types/`:**
- Purpose: Shared TypeScript type definitions
- Contains: `chat.ts`, `folder.ts`, `messages.ts`, `events.ts`
- Key types: `ExtendedMessage`, `ContentPart`, `APIMessage`, `Chat`, `Folder`

**`scripts/`:**
- Purpose: Development tools, configuration UI, database setup
- Contains: Config dashboard (HTML/JS), RAG diagnostics, WhatsApp tools
- Key files:
  - `init-env.js` - Environment template generator
  - `config-server.js` - Config dashboard HTTP server (port 3333)
  - `config-ui/index.html` - Visual config dashboard
  - `setup-database.sh` - Database initialization script
  - `rag/` - RAG diagnostic scripts (decode-rag-prompt, check-rag-flow, test-rag-system, reprocess-documents)

**`supabase/`:**
- Purpose: Database schema setup SQL
- Contains: `single-tenant-setup.sql`, `multi-tenant-setup.sql`

## Key File Locations

**Entry Points:**
- `src/app/layout.tsx`: Root layout (server component, metadata generation)
- `src/app/client-layout.tsx`: Client layout (provider tree, global styles, fonts)
- `src/app/page.tsx`: Main chat page (4685 lines, entire chat experience)

**Configuration:**
- `next.config.js`: Next.js config (React Compiler, Turbopack, image remotes)
- `tsconfig.json`: TypeScript config (`@/*` path alias → `./src/*`)
- `tailwind.config.ts`: Tailwind CSS configuration
- `eslint.config.mjs`: ESLint configuration
- `postcss.config.mjs`: PostCSS configuration
- `components.json`: shadcn/ui component configuration
- `vercel.json`: Vercel deployment configuration
- `src/lib/env.ts`: Runtime environment variable singleton

**Core Logic:**
- `src/app/api/chat/route.ts`: Main chat streaming endpoint
- `src/lib/document-processor.ts`: Document ingestion and embedding
- `src/lib/enhanced-rag-retrieval.ts`: Smart RAG retrieval
- `src/lib/mcp/universal-client.ts`: MCP tool orchestration
- `src/lib/system-prompt-manager.ts`: Prompt assembly

**State Management:**
- `src/lib/chat-store.ts`: Chat CRUD and sidebar state (Zustand)
- `src/lib/web-search-store.ts`: Web search toggle state
- `src/lib/file-upload-store.ts`: File upload state
- `src/lib/user-settings-store.ts`: User preferences
- `src/lib/ghost-mode-store.ts`: Ghost mode (ephemeral chat) state
- `src/lib/stores/organization-store.ts`: Organization/workspace state
- `src/lib/stores/reasoning-store.ts`: AI reasoning mode state
- `src/lib/admin-store.ts`: Admin dashboard state

**Testing:**
- No test files detected in `src/`. No test framework configured in `package.json`.

## Naming Conventions

**Files:**
- Components: `kebab-case.tsx` (e.g., `chat-input.tsx`, `model-selector.tsx`)
- Stores: `kebab-case-store.ts` (e.g., `chat-store.ts`, `web-search-store.ts`)
- API routes: `route.ts` inside descriptive directory (e.g., `api/chat/route.ts`)
- Libraries: `kebab-case.ts` (e.g., `document-processor.ts`, `api-middleware.ts`)
- Types: `kebab-case.ts` in `src/types/` (e.g., `chat.ts`, `folder.ts`)
- Translations: `language-code.ts` (e.g., `en.ts`, `ja.ts`)

**Directories:**
- Kebab-case throughout (e.g., `mcp-tools/`, `config-ui/`, `artifact-sidebar/`)
- Feature directories use singular or descriptive names (e.g., `auth/`, `scrapers/`, `whatsapp/`)
- API routes use resource names (e.g., `documents/`, `chats/`, `organizations/`)
- Dynamic segments use `[param]` convention (e.g., `[id]/`, `[shareId]/`, `[lang]/`)

**Exports:**
- Components: Named exports with PascalCase (e.g., `export function ChatInput`)
- Stores: Named exports (e.g., `export const useChatStore = create<ChatStore>(...)`)
- Utilities: Named exports with camelCase (e.g., `export function validateRequest`)
- Classes: PascalCase singletons (e.g., `EnvironmentConfig`, `SupabaseManager`, `UniversalMcpClient`)

## Where to Add New Code

**New API Endpoint:**
- Create directory: `src/app/api/{resource-name}/route.ts`
- Use `NextRequest`/`NextResponse` from `next/server`
- Add Zod validation via `src/lib/api-middleware.ts`
- Set `export const runtime = 'nodejs'` for server-only features
- Use `createClient()` from `src/lib/supabase/server.ts` for authenticated Supabase access

**New UI Component:**
- Place in `src/components/ui/{component-name}.tsx`
- For complex components with hooks/utils, create a directory: `src/components/ui/{component-name}/`
- Use `'use client'` directive
- Follow Tailwind CSS styling with dark mode classes (`dark:`)
- Import shared utilities from `@/lib/utils`

**New Provider:**
- Create in `src/components/providers/{name}-provider.tsx`
- Add to provider tree in `src/app/client-layout.tsx`

**New Zustand Store:**
- Simple stores: `src/lib/{feature}-store.ts`
- Complex/grouped stores: `src/lib/stores/{feature}-store.ts`
- Use `useShallow` from `zustand/react/shallow` for selectors

**New RAG/AI Feature:**
- Core logic: `src/lib/{feature-name}.ts`
- Wire into chat route: `src/app/api/chat/route.ts`

**New External Integration:**
- Client/adapter: `src/lib/{service-name}/` directory
- API routes: `src/app/api/{service-name}/route.ts`
- UI components: `src/components/ui/{service-name}/` or `src/components/ui/{service-name}-{widget}.tsx`

**New Translation:**
- Add language file: `src/translations/{lang-code}.ts`
- Register in `src/translations/index.ts`

**New Type Definition:**
- Shared types: `src/types/{domain}.ts`
- Module-specific types: co-located in `src/lib/{module}/types.ts`

**New Script/Tool:**
- Utility scripts: `scripts/{name}.js`
- RAG diagnostics: `scripts/rag/{name}.js`

## Special Directories

**`node_modules/`:**
- Purpose: npm dependencies
- Generated: Yes
- Committed: No

**`.next/`:**
- Purpose: Next.js build output and dev cache
- Generated: Yes
- Committed: No

**`public/`:**
- Purpose: Static assets served at root URL
- Generated: No
- Committed: Yes

**`logs/`:**
- Purpose: Runtime application logs
- Generated: Yes
- Committed: No

**`artifacts/`:**
- Purpose: Research documents and generated artifacts
- Generated: Partially
- Committed: Selectively

**`.planning/`:**
- Purpose: Codebase analysis and planning documents
- Generated: Yes (by tooling)
- Committed: Yes

**`supabase/`:**
- Purpose: Database schema SQL files for setup
- Generated: No
- Committed: Yes

**`prompts/`:**
- Purpose: Prompt template files
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-03-08*
