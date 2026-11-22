---
last_mapped_commit: 41a47818ac26f9ea788ccb18230fb3351065c2a2
last_mapped_at: 2026-11-22
---
# Technology Stack

**Analysis Date:** 2026-11-22

## Languages

**Primary:**
- TypeScript 5.x - Main web app (`src/`), voice agent (`voice-agent/src/`), WhatsApp service (`baileys-whatsapp/src/`, `baileys-whatsapp/server.ts`)
- JavaScript (ES modules / CJS) - Scripts and config (`scripts/*.js`, `next.config.js`, `scripts/config-server.js`, `scripts/init-env.js`)

**Secondary:**
- SQL - Supabase schema and RPC setup (`supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql`)
- Bash - Database setup helper (`scripts/setup-database.sh`)
- HTML/CSS - Config dashboard (`scripts/config-ui/index.html`), Tailwind styles (`tailwind.config.ts`)

## Runtime

**Environment:**
- Node.js >=20.9.0 for the main app (per `AGENTS.md`)
- Node.js 20 for the voice agent (`voice-agent/Dockerfile` uses `npm install` / `npm start` on a Node 20 image)
- Node.js 20.18.0 for the WhatsApp service (`baileys-whatsapp/Dockerfile`, base `node:20.18.0-slim`); `baileys-whatsapp/package.json` engines `>=20.0.0`
- React Server Components / Next.js App Router runtime, with API routes under `src/app/api/`

**Package Managers:**
- npm - Main app. Lockfile present: `package-lock.json` (root). `.npmrc` sets `legacy-peer-deps=true`.
- npm - Voice agent. Lockfile present: `voice-agent/package-lock.json`.
- Yarn - WhatsApp service. Lockfile present: `baileys-whatsapp/yarn.lock`.
- Declared `packageManager` in root `package.json` is `pnpm@10.28.1`, but no `pnpm-lock.yaml` is present. Treat npm as the working package manager.
- Lockfile version drift: `package.json` declares `next` `^16.1.6`, while `package-lock.json` resolves `next` 16.4.6. `AGENTS.md` lists Next.js 16.0.10. Trust the lockfile for the actual installed version.

## Frameworks

**Core (main app):**
- Next.js `^16.1.6` (lockfile: 16.4.6) - App Router, API routes, React Compiler enabled via `reactCompiler: true` in `next.config.js`
- React `^19.2.1` (lockfile: 19.2.1) and React DOM `^19.2.1` - UI
- Vercel AI SDK `ai` `^6.0.3` plus `@ai-sdk/react` `^3.0.3`, `@ai-sdk/openai` `^3.0.1`, `@ai-sdk/provider` `^3.0.0`, `@ai-sdk/provider-utils` `^4.0.1`, `@ai-sdk/mcp` `^1.0.1`, `@ai-sdk/fal` `^1.0.17`, `@ai-sdk/replicate` `^1.0.13`, `@ai-sdk/rsc` `^1.0.78` - LLM streaming, tool calls, media generation
- `@openrouter/ai-sdk-provider` `^1.2.0` - OpenRouter model access (`src/lib/openrouter.ts`)
- `@modelcontextprotocol/sdk` `^1.15.0` - MCP client (`src/lib/mcp/`)
- Tailwind CSS `^3.4.1` with `tailwindcss-animate`, `tailwind-merge`, `@tailwindcss/typography` (`tailwind.config.ts`, `postcss.config.mjs`)
- Radix UI primitives (`@radix-ui/react-*`) and shadcn-style config (`components.json`)
- Zustand `^5.0.3` - client state stores (`src/lib/**` stores such as `src/lib/user-settings-store.ts`)
- Framer Motion `^11.17.0` - animation
- Express `^5.1.0` - used by the app's Node-side tooling (listed in root `package.json`)

**Core (voice agent, `voice-agent/`):**
- `@livekit/agents` `^1.0.31`, `@livekit/agents-plugin-silero` `^1.0.31` - agent runtime and Silero VAD
- `@livekit/rtc-node` `^0.13.22`, `livekit-client` `^2.16.1`, `livekit-server-sdk` `^2.1.2` - LiveKit real-time audio and token signing
- `assemblyai` `^4.22.1` - streaming speech-to-text
- Express `^5.2.1` - HTTP surface of the agent service
- `ws` `^8.16.0` - WebSocket client (used for Resemble streaming TTS)
- `tsx` `^4.7.1` - dev runner (`npm run dev` runs `tsx watch src/agent.ts`)

**Core (WhatsApp service, `baileys-whatsapp/`):**
- Baileys (package name `baileys` `6.7.18`, WhiskeySockets fork) - WhatsApp Web protocol client
- `libsignal` (git dependency from `whiskeysockets/libsignal-node`)
- Express `^4.18.2`, `ws` `^8.13.0`, `pino` `^9.6`, `protobufjs` `^7.2.4`, `music-metadata` `^11.7.0`
- `@cacheable/node-cache`, `async-mutex`, `@hapi/boom`

**Testing:**
- Root app: no test runner in `package.json`. Test helpers are plain Node scripts: `scripts/test-rag-system.js` (`npm run test-rag`)
- WhatsApp service: Jest `^30` (`baileys-whatsapp/jest.config.js`, `npm test`)

**Build/Dev:**
- TypeScript `^5` (`tsconfig.json`, `tsconfig.node.json`); `typescript.ignoreBuildErrors: true` in `next.config.js`
- ESLint `^9` with `eslint-config-next` `^16.0.3`, `typescript-eslint` `^8`, `eslint-plugin-react-hooks` `^5` (`eslint.config.mjs`)
- `babel-plugin-react-compiler` `^19.1.0-rc.2` - React Compiler
- PostCSS `^8` (`postcss.config.mjs`), `sharp` `^0.34.3` (image processing)
- `ts-node` `^10.9.2` (dev)
- Baileys service: `tsc` build with `tsconfig.build.json`, `tsc-esm-fix`, ESLint, Prettier, TypeDoc

## Key Dependencies

**Critical (main app):**
- `@supabase/supabase-js` `^2.48.1`, `@supabase/ssr` `^0.5.2`, `@supabase/auth-helpers-nextjs` `^0.10.0` - database, auth, storage clients
- `openai` `^4.103.0` - embeddings, image generation (`gpt-image-1`), vision captioning, Whisper transcription, TTS (`src/lib/**`, `src/app/api/**`)
- `@fal-ai/client` `^1.4.0`, `@fal-ai/serverless-client` `^0.15.0` - Flux and other FAL-hosted image generation
- `replicate` `^1.0.1` - Replicate-hosted image, video, and 3D models
- `exa-js` `^1.8.26` - Exa web search for strict RAG tool results
- `@mendable/firecrawl-js` `^4.8.2` - web scraping and crawling
- `llamaindex` `^0.8.30` - document utilities; LlamaCloud parsing is called over HTTP
- `@nangohq/node` and `@nangohq/frontend` `^0.69.14` - OAuth connectors (Google Drive, Notion, Dropbox)
- `stripe` `^17.6.0` - subscriptions and checkout
- `@livekit/components-react` `^2.9.17`, `@livekit/components-styles` `^1.2.0`, `livekit-client` `^2.16.1`, `livekit-server-sdk` `^2.15.0` - voice UI and token minting
- `tiktoken` `^1.0.22` - token counting
- `zod` `^3.25.76` - request/response validation
- `multer` `^1.4.5-lts.2` - multipart uploads
- `pdfmake` `^0.2.18`, `@react-pdf/renderer` `^4.3.0`, `jspdf` `^4.2.0`, `jspdf-autotable` `^5.0.2` - PDF export
- `react-markdown` `^9.1.0`, `remark-gfm`, `remark-math`, `rehype-katex`, `shiki`, `react-syntax-highlighter` - rendering of chat output
- `@tanstack/react-virtual` `^3.13.12` - list virtualization
- `@vercel/analytics` `^1.5.0` - analytics

**Critical (voice agent):**
- `openai` `^4.28.0` - OpenAI-compatible LLM client; base URL and provider chosen by `VOICE_AGENT_LLM_PROVIDER` (`openai`, `groq`, `openrouter`) in `voice-agent/src/agent.ts`
- `axios` `^1.6.7` - HTTP calls (ElevenLabs/Resemble/other REST integrations)
- Resemble.ai TTS (called via HTTP and WebSocket; no dedicated SDK)

**Critical (WhatsApp service):**
- Baileys `6.7.18` - the whole WhatsApp session layer

**Infrastructure:**
- `dotenv` `^16.6.1` - env loading in scripts
- `nanoid` `^5.1.0`, `uuid` `^11.1.0` - ID generation
- `date-fns` `^4.1.0` - date utilities
- `zustand` `^5.0.3` - state
- `sonner` `^2.0.2`, `react-hot-toast` `^2.5.2` - toasts

## Configuration

**Environment:**
- Runtime configuration comes from `.env.local` (created by `scripts/init-env.js`, invoked by `npm run dev` and `npm run config`). Copy the template defaults in `scripts/init-env.js` when adding new variables.
- `src/lib/env.ts` is the central typed reader for server-side env values (it defaults e.g. `OPENAI_EMBEDDING_MODEL` to `text-embedding-3-small`).
- Browser-exposed values use the `NEXT_PUBLIC_` prefix (e.g., `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_MCP_SYSTEM_ENABLED`, `NEXT_PUBLIC_NANGO_ENABLED`, `NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE`, feature toggles and theme settings).
- Variables are grouped by service. Names only, values are never recorded here:
  - Supabase: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - LLM and embeddings: `OPENAI_API_KEY`, `OPENAI_EMBEDDING_MODEL`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GROQ_MODELS`
  - Media generation: `REPLICATE_API_TOKEN`, `REPLICATE_*_MODEL`, `FAL_API_KEY`, `USE_REPLICATE_PROVIDER`, `USE_FAL_PROVIDER`, `USE_OPENAI_IMAGE`, `OPENAI_IMAGE_*`, `IMAGE_GENERATION_PROVIDER`
  - Document and search: `LLAMA_CLOUD_API_KEY`, `LLAMA_CLOUD_API_BASE`, `LLAMACLOUD_CHUNK_*`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `FIRECRAWL_*`
  - RAG tuning: `RAG_*` and `ENHANCED_RAG_*` (thresholds, result counts, multi-pass, hybrid search), `RAG_SYSTEM_PROMPT`
  - Voice: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_LANGUAGE`, `RESEMBLE_API_KEY`, `RESEMBLE_PROJECT_ID`, `RESEMBLE_VOICE_ID`, `RESEMBLE_STREAM_URL`, `VOICE_PROVIDER`, `VOICE_AGENT_LLM_PROVIDER`, `VOICE_AGENT_MODEL`, `VOICE_MODE_ENABLED`, `ELEVENLABS_*`, `TTS_PROVIDER`
  - Payments: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_ID_*`, `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_ORGANIZATION_*`, `POLAR_PRICE_ID_*`
  - Connectors: `NANGO_SECRET_KEY`, `NANGO_WEBHOOK_SECRET`, `NANGO_HOST`, `NANGO_ENABLED`, `NANGO_SYNC_INTERVAL_HOURS`
  - Email: `RESEND_API_KEY`
  - WhatsApp: `WHATSAPP_PROVIDER`, `WHATSAPP_ENABLED`, `WHATSAPP_WEBHOOK_SECRET`, `WHATSAPP_WEBHOOK_URL`, `BAILEYS_URL`, `KOYEB_BAILEYS_URL`, `KOYEB_API_KEY`
  - MCP: `MCP_SYSTEM_ENABLED`, `MCP_ZAPIER_ENDPOINT`, `MCP_CUSTOM_SERVERS`, `MCP_BRAVE_SEARCH_ENDPOINT`, `MCP_YOLO_MODE_ENABLED`
  - Admin and internal: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `MYRAG_INTERNAL_API_KEY`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `NEXT_PUBLIC_SITE_URL`
- Configuration UI: `npm run config` starts `scripts/config-server.js` on port 3333 and serves `scripts/config-ui/index.html`, which edits `.env.local`.

**Build:**
- `next.config.js` - React Compiler, Turbopack root, server action origins, remote image hosts (Replicate CDN, Supabase storage, optional logo hosts), TypeScript build errors ignored
- `vercel.json` - Vercel build settings, `maxDuration: 60` for `src/app/api/**/*.ts`, security headers, `/embed/*` iframe headers, rewrites that 404 `/config` and `/scripts/*`, region `iad1`
- `tsconfig.json`, `components.json`, `tailwind.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `.eslintignore`, `.vercelignore`
- `voice-agent/tsconfig.json`, `baileys-whatsapp/tsconfig.json`, `baileys-whatsapp/tsconfig.build.json`, `baileys-whatsapp/typedoc.json`

## Platform Requirements

**Development:**
- Node.js >=20.9.0 and npm
- A Supabase project (PostgreSQL with pgvector, storage, auth). Schema: `supabase/single-tenant-setup.sql` or `supabase/multi-tenant-setup.sql`, applied through `scripts/setup-database.sh`
- API keys for embeddings and chosen models (see Configuration)
- Optional: `cd voice-agent && npm run dev`, `cd baileys-whatsapp && npm run dev`

**Production:**
- Main app: Vercel (`vercel.json`, region `iad1`, Next.js framework preset)
- Voice agent: Fly.io app `myrag-voice-agent` (`voice-agent/fly.toml`, 512 MB shared-cpu-1x, always restarted, Docker image from `voice-agent/Dockerfile`)
- WhatsApp service: Fly.io app `baileys-myrag` (`baileys-whatsapp/fly.toml`, port 8080, `min_machines_running = 0`) and/or Koyeb, selected by `WHATSAPP_PROVIDER`. Container built from `baileys-whatsapp/Dockerfile` (multi-stage, `node:20.18.0-slim`). `baileys-whatsapp/Procfile` runs `node lib/server.js`.
- Database: Supabase hosted PostgreSQL with pgvector HNSW indexes (1536-dimension embeddings)

---

*Stack analysis: 2026-11-22*
