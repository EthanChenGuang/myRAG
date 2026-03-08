# Technology Stack

**Analysis Date:** 2026-03-08

## Languages

**Primary:**
- TypeScript ^5 - All application code (`src/`), config files (`tailwind.config.ts`)
- JavaScript (ES2017 target) - Scripts (`scripts/`), Next.js config (`next.config.js`)

**Secondary:**
- Bash - Database setup script (`scripts/setup-database.sh`)
- SQL - Supabase schema files (`supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql`)

## Runtime

**Environment:**
- Node.js 18+ (current dev environment: v23.10.0)
- No `.nvmrc` or `.node-version` file present

**Package Manager:**
- npm
- Lockfile: `package-lock.json` (present)

## Frameworks

**Core:**
- Next.js ^16.1.6 - Full-stack React framework (App Router)
  - React Compiler enabled (`reactCompiler: true` in `next.config.js`)
  - Turbopack enabled for dev
  - Server Actions enabled
  - TypeScript build errors ignored (`ignoreBuildErrors: true`)
  - Runtime: Node.js (not Edge) for API routes
- React ^19.2.1 - UI library
- React DOM ^19.2.1

**AI / ML:**
- Vercel AI SDK (`ai`) ^5.0.78 - Core AI streaming, tool calling, model abstraction
- `@ai-sdk/openai` ^2.0.53 - OpenAI provider for AI SDK
- `@ai-sdk/react` ^2.0.78 - React hooks for AI SDK
- `@ai-sdk/rsc` ^1.0.78 - React Server Components integration
- `@ai-sdk/fal` ^1.0.17 - Fal.ai provider for AI SDK
- `@ai-sdk/replicate` ^1.0.13 - Replicate provider for AI SDK
- `@openrouter/ai-sdk-provider` ^1.2.0 - OpenRouter provider for AI SDK
- `openai` ^4.103.0 - Direct OpenAI client (embeddings, image generation)
- `@modelcontextprotocol/sdk` ^1.15.0 - MCP tool integration
- `llamaindex` ^0.8.30 - Document parsing via LlamaCloud
- `tiktoken` ^1.0.22 - Token counting

**Styling:**
- Tailwind CSS ^3.4.1
- `tailwindcss-animate` ^1.0.7 - Animation utilities
- `tailwind-scrollbar` ^3.1.0 - Custom scrollbar styling
- `@tailwindcss/typography` ^0.5.16 - Prose/typography plugin
- `tailwind-merge` ^2.6.0 - Class merging utility
- `class-variance-authority` ^0.7.1 - Variant-based component styling
- `clsx` ^2.1.1 - Conditional class names

**UI Components:**
- Radix UI - Headless component primitives (accordion, avatar, checkbox, dialog, dropdown-menu, label, popover, radio-group, scroll-area, select, slider, slot, switch, tabs, toast, tooltip)
- `lucide-react` ^0.471.2 - Icon library
- `@tabler/icons-react` ^3.29.0 - Additional icon library
- `framer-motion` ^11.17.0 - Animation library
- `next-themes` ^0.4.6 - Dark mode support
- `sonner` ^2.0.2 - Toast notifications
- `react-hot-toast` ^2.5.2 - Additional toast library

**Testing:**
- Not detected (no test framework in dependencies)

**Build/Dev:**
- `babel-plugin-react-compiler` ^19.1.0-rc.2 - React Compiler babel plugin
- ESLint ^9 with `eslint-config-next` ^16.0.3
- PostCSS ^8
- `sharp` ^0.34.3 - Image optimization
- `ts-node` ^10.9.2 - TypeScript execution for scripts

## Key Dependencies

**Critical:**
- `@supabase/supabase-js` ^2.48.1 - Supabase client (database, auth, storage, realtime)
- `@supabase/ssr` ^0.5.2 - Supabase SSR helpers (cookie-based auth)
- `@supabase/auth-helpers-nextjs` ^0.10.0 - Legacy Supabase auth helpers
- `ai` ^5.0.78 - Vercel AI SDK core (streaming, tool use, model routing)
- `openai` ^4.103.0 - OpenAI API client (embeddings, image gen, chat)
- `stripe` ^17.6.0 - Payment processing
- `zod` ^3.25.76 - Schema validation (used with `zod/v3` subpath)
- `zustand` ^5.0.3 - Client state management

**Infrastructure:**
- `express` ^5.1.0 - Config server (`scripts/config-server.js`)
- `dotenv` ^16.6.1 - Environment variable loading for scripts
- `nanoid` ^5.1.0 - ID generation
- `uuid` ^11.1.0 - UUID generation
- `node-fetch` ^2.7.0 - HTTP client for Node.js
- `form-data` ^4.0.1 - Multipart form data
- `multer` ^1.4.5-lts.2 - File upload handling
- `eventsource` ^3.0.6 - SSE client

**Content Processing:**
- `react-markdown` ^9.1.0 - Markdown rendering
- `marked` ^15.0.7 - Markdown parser
- `remark-gfm` ^4.0.1 - GitHub Flavored Markdown
- `remark-math` ^6.0.0 + `rehype-katex` ^7.0.1 - Math/LaTeX rendering
- `remark-breaks` ^4.0.0 - Line break handling
- `react-syntax-highlighter` ^15.6.1 - Code highlighting
- `shiki` ^3.1.0 - Syntax highlighting engine
- `react-code-blocks` ^0.1.6 - Code block component

**PDF / Document:**
- `@react-pdf/renderer` ^4.3.0 - PDF generation (React-based)
- `jspdf` ^4.2.0 + `jspdf-autotable` ^5.0.2 - PDF generation (imperative)
- `pdfmake` ^0.2.18 - PDF document builder

**External Service Clients:**
- `exa-js` ^1.8.26 - Exa web search API
- `replicate` ^1.0.1 - Replicate AI models
- `@fal-ai/client` ^1.4.0 - Fal.ai client
- `@fal-ai/serverless-client` ^0.15.0 - Fal.ai legacy client
- `@mendable/firecrawl-js` ^4.8.2 - Firecrawl web scraping
- `@nangohq/frontend` ^0.69.14 + `@nangohq/node` ^0.69.14 - Nango document connectors

**Other:**
- `@vercel/analytics` ^1.5.0 - Vercel analytics
- `@tanstack/react-virtual` ^3.13.12 - Virtualized lists
- `react-textarea-autosize` ^8.5.7 - Auto-resizing textarea
- `react-qr-code` ^2.0.18 - QR code generation (WhatsApp pairing)
- `date-fns` ^4.1.0 - Date utilities

## Configuration

**Environment:**
- Environment managed via `.env.local` (auto-created by `scripts/init-env.js`)
- Singleton pattern in `src/lib/env.ts` loads and validates all env vars
- Multi-tenant mode supported via `NEXT_PUBLIC_CHATRAG_DEPLOYMENT_MODE` (`single-tenant` | `multi-tenant`)
- Required server vars: `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Required public vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Models must be synchronized across 5 locations (see CLAUDE.md section 7)

**Build:**
- `next.config.js` - Next.js configuration (React Compiler, Turbopack, image remotePatterns)
- `tsconfig.json` - TypeScript (ES2017 target, bundler module resolution, `@/*` path alias to `./src/*`)
- `tailwind.config.ts` - Tailwind with shadcn/ui CSS variable theme, dark mode via `class`
- `postcss.config.mjs` - PostCSS configuration
- `eslint.config.mjs` - ESLint flat config

**Scripts:**
- `npm run dev` - Development server (auto-creates `.env.local`)
- `npm run build` - Production build
- `npm run config` - Visual configuration dashboard at `http://localhost:3333`
- `npm run db:setup` - Database schema setup (auto-selects single/multi-tenant)
- `npm run reprocess-docs` - Reprocess document embeddings
- `npm run test-rag` - RAG system diagnostics

## Platform Requirements

**Development:**
- Node.js 18+
- npm
- Supabase project (PostgreSQL + pgvector)
- API keys: OpenAI (required), OpenRouter (recommended)

**Production:**
- Vercel (primary deployment target, uses `@vercel/analytics`)
- Supabase hosted instance
- Optional: Fly.io or Koyeb for WhatsApp Baileys service

---

*Stack analysis: 2026-03-08*
