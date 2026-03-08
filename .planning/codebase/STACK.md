# Technology Stack

**Analysis Date:** 2026-03-08

## Languages

**Primary:**
- TypeScript ^5 - All application code (`src/`), config files (`tailwind.config.ts`, `eslint.config.mjs`)
- JavaScript (ES2017 target) - Scripts (`scripts/`), Next.js config (`next.config.js`)

**Secondary:**
- Bash - Database setup (`scripts/setup-database.sh`)
- SQL - Schema definitions (`supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql`)

## Runtime

**Environment:**
- Node.js 18+ (required minimum)
- Next.js Node.js runtime (not Edge) for API routes (`export const runtime = 'nodejs'`)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Core:**
- Next.js ^16.1.6 - App Router, React Compiler enabled (`reactCompiler: true` in `next.config.js`), Turbopack dev server
- React ^19.2.1 - With React Compiler via `babel-plugin-react-compiler`
- Tailwind CSS ^3.4.1 - Styling with CSS custom properties (`tailwind.config.ts`)

**UI Component Libraries:**
- Radix UI - Primitives: accordion, avatar, checkbox, dialog, dropdown-menu, label, popover, radio-group, scroll-area, select, slider, slot, switch, tabs, toast, tooltip
- Framer Motion ^11.17.0 - Animations
- Lucide React ^0.471.2 - Icons
- Tabler Icons React ^3.29.0 - Additional icons

**State Management:**
- Zustand ^5.0.3 - Client state (use `useShallow` from `zustand/react/shallow`)

**AI/LLM:**
- Vercel AI SDK 5 (`ai` ^5.0.78) - Core streaming, tool calling, model messages
- `@ai-sdk/openai` ^2.0.53 - OpenAI provider
- `@ai-sdk/react` ^2.0.78 - React hooks for AI
- `@ai-sdk/rsc` ^1.0.78 - React Server Components integration
- `@ai-sdk/fal` ^1.0.17 - Fal.ai provider
- `@ai-sdk/replicate` ^1.0.13 - Replicate provider
- `@openrouter/ai-sdk-provider` ^1.2.0 - OpenRouter provider

**Testing:**
- Not detected (no test framework configured)

**Build/Dev:**
- ESLint ^9 with `eslint-config-next` ^16.0.3, `typescript-eslint` ^8 (`eslint.config.mjs`)
- PostCSS ^8 (`postcss.config.mjs`)
- TypeScript ^5 (`tsconfig.json` - strict mode, bundler module resolution)

## Key Dependencies

**Critical:**
- `@supabase/supabase-js` ^2.48.1 - Database client, auth, storage, realtime
- `@supabase/ssr` ^0.5.2 - Server-side rendering auth helpers
- `openai` ^4.103.0 - OpenAI API client (embeddings, TTS/STT, image generation)
- `ai` ^5.0.78 - Vercel AI SDK for streaming chat and tool calling
- `zod` ^3.25.76 - Schema validation (imported as `zod/v3` in route handlers)

**Infrastructure:**
- `stripe` ^17.6.0 - Payment processing (API version `2025-01-27.acacia`)
- `@mendable/firecrawl-js` ^4.8.2 - Web scraping
- `@nangohq/node` ^0.69.14, `@nangohq/frontend` ^0.69.14 - Document connector integrations
- `@modelcontextprotocol/sdk` ^1.15.0 - MCP tool protocol
- `llamaindex` ^0.8.30 - Document parsing via LlamaCloud API
- `exa-js` ^1.8.26 - Exa web search API
- `replicate` ^1.0.1 - Replicate AI model API
- `@fal-ai/client` ^1.4.0 - Fal.ai generative AI

**Document/PDF:**
- `@react-pdf/renderer` ^4.3.0 - PDF rendering in React
- `jspdf` ^4.2.0 + `jspdf-autotable` ^5.0.2 - PDF generation
- `pdfmake` ^0.2.18 - PDF document generation

**Markdown/Content:**
- `react-markdown` ^9.1.0 - Markdown rendering
- `remark-gfm` ^4.0.1 - GitHub Flavored Markdown
- `remark-math` ^6.0.0 + `rehype-katex` ^7.0.1 - Math rendering
- `marked` ^15.0.7 - Markdown parser
- `shiki` ^3.1.0 - Syntax highlighting

**Utilities:**
- `nanoid` ^5.1.0 - ID generation
- `uuid` ^11.1.0 - UUID generation
- `date-fns` ^4.1.0 - Date utilities
- `tiktoken` ^1.0.22 - Token counting for LLMs
- `dotenv` ^16.6.1 - Environment variable loading (scripts only)
- `class-variance-authority` ^0.7.1, `clsx` ^2.1.1, `tailwind-merge` ^2.6.0 - CSS class utilities
- `sharp` ^0.34.3 (dev) - Image processing

**UI Extras:**
- `next-themes` ^0.4.6 - Dark/light mode
- `sonner` ^2.0.2 - Toast notifications
- `react-hot-toast` ^2.5.2 - Alternative toast notifications
- `react-textarea-autosize` ^8.5.7 - Auto-resizing textarea
- `@tanstack/react-virtual` ^3.13.12 - Virtual scrolling
- `react-qr-code` ^2.0.18 - QR code generation (WhatsApp pairing)
- `@vercel/analytics` ^1.5.0 - Usage analytics

## Configuration

**Environment:**
- Configuration singleton: `src/lib/env.ts` (EnvironmentConfig class)
- `.env.local` - Primary environment file (auto-created by `scripts/init-env.js`)
- `.env.local.multi-tenant` - Multi-tenant variant
- Required server vars: `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- Required public vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Models must be synced across 5 locations: `.env.local`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, `scripts/config-ui/index.html`

**Build:**
- `next.config.js` - React Compiler enabled, Turbopack, server actions, TS build errors ignored
- `tsconfig.json` - Strict mode, path alias `@/*` maps to `./src/*`
- `tailwind.config.ts` - CSS custom properties via `hsl(var(--*))`, plugins: typography, animate, scrollbar
- `postcss.config.mjs` - PostCSS pipeline
- `eslint.config.mjs` - ESLint 9 flat config

**Deployment Modes:**
- Single-tenant (default): `NEXT_PUBLIC_CHATRAG_DEPLOYMENT_MODE=single-tenant`
- Multi-tenant: Organizations, team invites, storage quotas, usage analytics (feature-flagged)

## Platform Requirements

**Development:**
- Node.js 18+
- npm
- Supabase project (PostgreSQL + pgvector)
- API keys: OpenAI (required), OpenRouter (recommended), plus optional service keys

**Production:**
- Vercel (primary deployment target based on `@vercel/analytics`, server actions config)
- Supabase hosted PostgreSQL with pgvector HNSW indexes
- WhatsApp: Fly.io or Koyeb for Baileys deployment

---

*Stack analysis: 2026-03-08*
