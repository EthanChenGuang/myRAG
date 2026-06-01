# Technology Stack

**Analysis Date:** 2026-06-01

## Languages

**Primary:**
- TypeScript 5.x - All source code under `src/`, all scripts in `scripts/`

**Secondary:**
- JavaScript - Config files (`next.config.js`, `scripts/init-env.js`, `scripts/config-server.js`)
- SQL - Database schema (`supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql`)

## Runtime

**Environment:**
- Node.js 18+ (required, specified in `CLAUDE.md`)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- Next.js ^16.1.6 - App Router with React Compiler enabled, Node.js runtime for API routes (`export const runtime = 'nodejs'`)
- React ^19.2.1 - UI rendering
- React DOM ^19.2.1 - DOM binding

**State Management:**
- Zustand ^5.0.3 - Client state; stores in `src/lib/chat-store.ts`, `src/lib/user-settings-store.ts`, `src/lib/stores/`
- Always use `useShallow` from `zustand/react/shallow` for selectors

**AI / Streaming:**
- Vercel AI SDK `ai` ^5.0.78 - Core streaming primitives (`streamText`, `useChat`, `tool`)
- `@ai-sdk/react` ^2.0.78 - React hooks (`useChat`)
- `@ai-sdk/openai` ^2.0.53 - Direct OpenAI provider
- `@ai-sdk/replicate` ^1.0.13 - Replicate provider
- `@ai-sdk/fal` ^1.0.17 - Fal.ai provider
- `@openrouter/ai-sdk-provider` ^1.2.0 - OpenRouter AI SDK provider (primary chat path in `src/app/api/chat/route.ts`)
- `openai` ^4.103.0 - Raw OpenAI client (embeddings, image generation)

**RAG / Document Processing:**
- `llamaindex` ^0.8.30 - LlamaIndex JS library
- `tiktoken` ^1.0.22 - Token counting for chunking

**UI Component Library:**
- Radix UI (accordion, avatar, checkbox, dialog, dropdown-menu, label, popover, radio-group, scroll-area, select, slider, slot, switch, tabs, toast, tooltip) - Headless primitives
- Tailwind CSS ^3.4.1 - Utility-first styling
- `tailwind-merge` ^2.6.0 - Class merging
- `class-variance-authority` ^0.7.1 - Variant management
- `tailwindcss-animate` ^1.0.7 - Animation utilities
- Framer Motion ^11.17.0 - Animations
- Lucide React ^0.471.2 - Icons
- `@tabler/icons-react` ^3.29.0 - Additional icons

**Testing:**
- Not detected (no test runner or test config files present)

**Build/Dev:**
- Turbopack - Enabled in `next.config.js` (`turbopack: { root: __dirname }`)
- React Compiler - Enabled in `next.config.js` (`reactCompiler: true`)
- `babel-plugin-react-compiler` ^19.1.0-rc.2 - Compiler Babel plugin
- ESLint ^9 with `eslint-config-next` ^16.0.3 - Linting
- `typescript-eslint` ^8 - TypeScript linting
- PostCSS ^8 - CSS processing
- sharp ^0.34.3 - Image optimization (dev dep)

## Key Dependencies

**Critical:**
- `@supabase/supabase-js` ^2.48.1 - Primary database/auth client
- `@supabase/ssr` ^0.5.2 - SSR-aware Supabase client (`src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`)
- `@supabase/auth-helpers-nextjs` ^0.10.0 - Next.js auth middleware
- `zod` ^3.25.76 - Schema validation for API inputs and tool definitions
- `stripe` ^17.6.0 - Stripe payments SDK (`src/lib/stripe.ts`)
- `@modelcontextprotocol/sdk` ^1.15.0 - MCP protocol SDK (`src/lib/mcp/`)

**Infrastructure:**
- `@fal-ai/client` ^1.4.0 - Fal.ai SDK (image/video/3D generation)
- `@fal-ai/serverless-client` ^0.15.0 - Fal.ai serverless
- `replicate` ^1.0.1 - Replicate SDK (image/video/3D fallback)
- `@nangohq/frontend` ^0.69.14 - Nango OAuth frontend
- `@nangohq/node` ^0.69.14 - Nango server client
- `@mendable/firecrawl-js` ^4.8.2 - Firecrawl web scraping
- `exa-js` ^1.8.26 - Exa web search
- `nanoid` ^5.1.0 - ID generation
- `uuid` ^11.1.0 - UUID generation
- `date-fns` ^4.1.0 - Date utilities
- `marked` ^15.0.7 - Markdown parsing
- `react-markdown` ^9.1.0 - Markdown rendering
- `shiki` ^3.1.0 - Syntax highlighting
- `react-syntax-highlighter` ^15.6.1 - Code highlighting
- `@tanstack/react-virtual` ^3.13.12 - Virtual scrolling (large chat lists)
- `@react-pdf/renderer` ^4.3.0 - PDF generation
- `jspdf` ^4.2.0 - PDF export
- `react-qr-code` ^2.0.18 - QR code display (WhatsApp pairing)
- `multer` ^1.4.5-lts.2 - File upload middleware
- `express` ^5.1.0 - Config server (`scripts/config-server.js`)
- `next-themes` ^0.4.6 - Theme switching
- `sonner` ^2.0.2 - Toast notifications
- `react-hot-toast` ^2.5.2 - Additional toasts
- `framer-motion` ^11.17.0 - Animations
- `@vercel/analytics` ^1.5.0 - Usage analytics

**Markdown/Math:**
- `remark-gfm` ^4.0.1 - GFM tables/strikethrough
- `remark-math` ^6.0.0 - Math expressions
- `rehype-katex` ^7.0.1 - KaTeX math rendering
- `remark-breaks` ^4.0.0 - Line break handling

## Configuration

**Environment:**
- Loaded via `src/lib/env.ts` - Singleton `EnvironmentConfig` class
- Required at runtime: `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Optional: `OPENROUTER_API_KEY` (warns if missing), all feature flags default to `'false'`
- Template/defaults defined in `scripts/init-env.js` (auto-runs on `npm run dev`)
- Config dashboard at `http://localhost:3333` via `npm run config`

**Models must be synchronized across 5 files:**
1. `.env.local`
2. `scripts/init-env.js`
3. `src/lib/env.ts`
4. `scripts/config-server.js`
5. `scripts/config-ui/index.html`

**Build:**
- `next.config.js` - Next.js config with Turbopack, React Compiler, remote image patterns
- `tsconfig.json` - Strict TypeScript, `@/*` path alias for `./src/*`, `moduleResolution: bundler`
- `tailwind.config.ts` - Tailwind configuration
- `postcss.config.mjs` - PostCSS
- `eslint.config.mjs` - ESLint flat config

## Platform Requirements

**Development:**
- Node.js 18+, npm
- Supabase project with `NEXT_PUBLIC_SUPABASE_URL` and keys
- OpenAI API key (required for embeddings)
- OpenRouter API key (recommended for chat)

**Production:**
- Vercel (configured in `vercel.json`, region `iad1`, max function duration 60s)
- Supabase (PostgreSQL + pgvector extension)
- WhatsApp backend on Fly.io or Koyeb (Baileys service)

---

*Stack analysis: 2026-06-01*
