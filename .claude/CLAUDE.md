<!-- GSD:project-start source:PROJECT.md -->

## Project

**myRAG RAG 全链路升级**

myRAG 是一个基于 Next.js + Supabase 的 AI 聊天产品，核心是从用户自己的知识库里检索内容来回答问题（RAG），同时支持多模型、语音、WhatsApp、云盘同步和多模态生成。

这个项目把它的 RAG 流程从"纯向量检索 + 启发式加分"升级为六层都有成熟方案的流程：① 数据（解析与切块）② 查询（改写与分解）③ 召回（Embedding + 向量库/混合检索）④ 排序与上下文 ⑤ 生成（引用与防幻觉）⑥ 评估。每一步改动都要用评估数据证明有效。

**Core Value:** 用户问知识库里有答案的问题，能拿到正确、带准确引用的回答；问知识库里没有答案的问题，系统明确说不知道，不硬编。并且这两点都能用评估分数证明，而不是凭感觉。

### Constraints

- **配置同步**：新增的 `.env.local` 变量必须同步到 `scripts/init-env.js`、`src/lib/env.ts`、`scripts/config-server.js` 和 Config UI（`AGENTS.md` 规则）；模型列表五处同步规则照旧 — 否则配置会漂移
- **不能破坏现有行为**：strict 模式"信息不可用"、webSearch + Exa、`source_images`、`RAG_SYSTEM_PROMPT` 的 `{{context}}` 占位符、语音和嵌入式聊天路径 — 这些是已上线功能
- **多租户安全**：单租户和多租户都要支持，RLS 和租户隔离不能变弱；外部向量库必须按租户过滤 — 跨租户泄露是最严重的失败
- **可回退**：每个新组件都有开关，关掉回到当前行为 — 上线风险可控
- **证明有效**：每个阶段完成时都要和基线对比，任何一层指标明显变差就不算完成 — 防止凭感觉调参
- **延迟**：查询改写 + 检索 + 重排要有总延迟预算（研究阶段给出建议值）；语音路径预算更低，可以只启用部分步骤 — 语音对延迟敏感
- **密钥**：不提交任何密钥，测试和文档用占位值 — `AGENTS.md` 规则
- **Python 侧车**：Docling、HHEM、DeepEval、Ragas 放在 Python 侧车服务里，主应用通过 HTTP 调用 — 用户决定
- **标准输出格式用 Pydantic**：所有结构化输出都用 Pydantic v2（`pydantic>=2.14.4`，写进侧车的依赖文件）定义——侧车接口的请求和响应、golden set 条目、评估结果、LLM 结构化输出（查询分解、文档类型识别、改写、评估打分）。TypeScript 端用项目已有的 Zod 校验同一份结构，Zod schema 由 Pydantic 导出的 JSON Schema 生成，并在 CI 里检查两边一致 — 用户决定；两套手写 schema 会漂移
- **pgvector 维度**：换 Embedding 后若超过 2000 维，pgvector 的 `vector` HNSW 索引放不下，需要 `halfvec` 或降维

<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- TypeScript 5.x - Main web app (`src/`), voice agent (`voice-agent/src/`), WhatsApp service (`baileys-whatsapp/src/`, `baileys-whatsapp/server.ts`)
- JavaScript (ES modules / CJS) - Scripts and config (`scripts/*.js`, `next.config.js`, `scripts/config-server.js`, `scripts/init-env.js`)
- SQL - Supabase schema and RPC setup (`supabase/single-tenant-setup.sql`, `supabase/multi-tenant-setup.sql`)
- Bash - Database setup helper (`scripts/setup-database.sh`)
- HTML/CSS - Config dashboard (`scripts/config-ui/index.html`), Tailwind styles (`tailwind.config.ts`)

## Runtime

- Node.js 22 for the main app (`engines.node` `^22.12.0`, `.nvmrc` `22`, per `AGENTS.md`)
- Node.js 22 for the voice agent (`voice-agent/Dockerfile` uses `npm install` / `npm start` on the `node:22-slim` image)
- Node.js 20.18.0 for the WhatsApp service (`baileys-whatsapp/Dockerfile`, base `node:20.18.0-slim`); `baileys-whatsapp/package.json` engines `>=20.0.0`
- React Server Components / Next.js App Router runtime, with API routes under `src/app/api/`
- npm - Main app. Lockfile present: `package-lock.json` (root). `.npmrc` sets `legacy-peer-deps=true`.
- npm - Voice agent. Lockfile present: `voice-agent/package-lock.json`.
- Yarn - WhatsApp service. Lockfile present: `baileys-whatsapp/yarn.lock`.
- Declared `packageManager` in root `package.json` is `pnpm@10.28.1`, but no `pnpm-lock.yaml` is present. Treat npm as the working package manager.
- Lockfile version drift: `package.json` declares `next` `^16.1.6`, while `package-lock.json` resolves `next` 16.4.6. `AGENTS.md` lists Next.js 16.0.10. Trust the lockfile for the actual installed version.

## Frameworks

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
- `@livekit/agents` `^1.0.31`, `@livekit/agents-plugin-silero` `^1.0.31` - agent runtime and Silero VAD
- `@livekit/rtc-node` `^0.13.22`, `livekit-client` `^2.16.1`, `livekit-server-sdk` `^2.1.2` - LiveKit real-time audio and token signing
- `assemblyai` `^4.22.1` - streaming speech-to-text
- Express `^5.2.1` - HTTP surface of the agent service
- `ws` `^8.16.0` - WebSocket client (used for Resemble streaming TTS)
- `tsx` `^4.7.1` - dev runner (`npm run dev` runs `tsx watch src/agent.ts`)
- Baileys (package name `baileys` `6.7.18`, WhiskeySockets fork) - WhatsApp Web protocol client
- `libsignal` (git dependency from `whiskeysockets/libsignal-node`)
- Express `^4.18.2`, `ws` `^8.13.0`, `pino` `^9.6`, `protobufjs` `^7.2.4`, `music-metadata` `^11.7.0`
- `@cacheable/node-cache`, `async-mutex`, `@hapi/boom`
- Root app: no test runner in `package.json`. Test helpers are plain Node scripts: `scripts/test-rag-system.js` (`npm run test-rag`)
- WhatsApp service: Jest `^30` (`baileys-whatsapp/jest.config.js`, `npm test`)
- TypeScript `^5` (`tsconfig.json`, `tsconfig.node.json`); `typescript.ignoreBuildErrors: true` in `next.config.js`
- ESLint `^9` with `eslint-config-next` `^16.0.3`, `typescript-eslint` `^8`, `eslint-plugin-react-hooks` `^5` (`eslint.config.mjs`)
- `babel-plugin-react-compiler` `^19.1.0-rc.2` - React Compiler
- PostCSS `^8` (`postcss.config.mjs`), `sharp` `^0.34.3` (image processing)
- `ts-node` `^10.9.2` (dev)
- Baileys service: `tsc` build with `tsconfig.build.json`, `tsc-esm-fix`, ESLint, Prettier, TypeDoc

## Key Dependencies

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
- `openai` `^4.28.0` - OpenAI-compatible LLM client; base URL and provider chosen by `VOICE_AGENT_LLM_PROVIDER` (`openai`, `groq`, `openrouter`) in `voice-agent/src/agent.ts`
- `axios` `^1.6.7` - HTTP calls (ElevenLabs/Resemble/other REST integrations)
- Resemble.ai TTS (called via HTTP and WebSocket; no dedicated SDK)
- Baileys `6.7.18` - the whole WhatsApp session layer
- `dotenv` `^16.6.1` - env loading in scripts
- `nanoid` `^5.1.0`, `uuid` `^11.1.0` - ID generation
- `date-fns` `^4.1.0` - date utilities
- `zustand` `^5.0.3` - state
- `sonner` `^2.0.2`, `react-hot-toast` `^2.5.2` - toasts

## Configuration

- Runtime configuration comes from `.env.local` (created by `scripts/init-env.js`, invoked by `npm run dev` and `npm run config`). Copy the template defaults in `scripts/init-env.js` when adding new variables.
- `src/lib/env.ts` is the central typed reader for server-side env values (it defaults e.g. `OPENAI_EMBEDDING_MODEL` to `text-embedding-3-small`).
- Browser-exposed values use the `NEXT_PUBLIC_` prefix (e.g., `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_MCP_SYSTEM_ENABLED`, `NEXT_PUBLIC_NANGO_ENABLED`, `NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE`, feature toggles and theme settings).
- Variables are grouped by service. Names only, values are never recorded here:
- Configuration UI: `npm run config` starts `scripts/config-server.js` on port 3333 and serves `scripts/config-ui/index.html`, which edits `.env.local`.
- `next.config.js` - React Compiler, Turbopack root, server action origins, remote image hosts (Replicate CDN, Supabase storage, optional logo hosts), TypeScript build errors ignored
- `vercel.json` - Vercel build settings, `maxDuration: 60` for `src/app/api/**/*.ts`, security headers, `/embed/*` iframe headers, rewrites that 404 `/config` and `/scripts/*`, region `iad1`
- `tsconfig.json`, `components.json`, `tailwind.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `.eslintignore`, `.vercelignore`
- `voice-agent/tsconfig.json`, `baileys-whatsapp/tsconfig.json`, `baileys-whatsapp/tsconfig.build.json`, `baileys-whatsapp/typedoc.json`

## Platform Requirements

- Node.js 22 (`^22.12.0`) and npm
- A Supabase project (PostgreSQL with pgvector, storage, auth). Schema: `supabase/single-tenant-setup.sql` or `supabase/multi-tenant-setup.sql`, applied through `scripts/setup-database.sh`
- API keys for embeddings and chosen models (see Configuration)
- Optional: `cd voice-agent && npm run dev`, `cd baileys-whatsapp && npm run dev`
- Main app: Vercel (`vercel.json`, region `iad1`, Next.js framework preset)
- Voice agent: Fly.io app `myrag-voice-agent` (`voice-agent/fly.toml`, 512 MB shared-cpu-1x, always restarted, Docker image from `voice-agent/Dockerfile`)
- WhatsApp service: Fly.io app `baileys-myrag` (`baileys-whatsapp/fly.toml`, port 8080, `min_machines_running = 0`) and/or Koyeb, selected by `WHATSAPP_PROVIDER`. Container built from `baileys-whatsapp/Dockerfile` (multi-stage, `node:20.18.0-slim`). `baileys-whatsapp/Procfile` runs `node lib/server.js`.
- Database: Supabase hosted PostgreSQL with pgvector HNSW indexes (1536-dimension embeddings)

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- kebab-case for all TypeScript modules: `src/lib/chat-store.ts`, `src/lib/query-classifier.ts`, `src/lib/whatsapp/types.ts`
- React components also use kebab-case filenames with PascalCase exports: `src/components/ui/sidebar.tsx` exports `Header`, `ChatInput`, `CollapsibleButton`
- Next.js route files use the framework names: `src/app/api/chat/route.ts`, `src/app/api/chat/approve/route.ts`
- Scripts under `scripts/` use kebab-case `.js`: `scripts/rag/check-rag-flow.js`, `scripts/whatsapp/tests/test-formatting.js`
- camelCase for functions and hooks: `validateRequest`, `withValidation` in `src/lib/api-middleware.ts`, `getQueryEmbedding` in `src/lib/document-processor.ts`
- Named function declarations for exported components and helpers: `export function Header(...)` in `src/components/ui/header.tsx`
- `React.memo(function Name(...))` and `forwardRef<Handle, Props>(function Name(...))` for memoized/ref-forwarding components, e.g. `src/components/ui/` `CopyButton`, `ChatInput`
- camelCase for locals; module-level constants in SCREAMING_SNAKE_CASE: `STORAGE_BUCKET`, `CURRENT_CHAT_KEY` in `src/lib/chat-store.ts`, `DOCUMENT_URL_MAP` and `documentReferenceTool` in `src/app/api/chat/route.ts`
- Unused variables must be prefixed with `_` to satisfy the lint rule (`argsIgnorePattern: "^_"`, `varsIgnorePattern: "^_"`)
- PascalCase interfaces and type aliases, typically named `*Props`, `*State`, `*Store`, `*Input`: `ChatStore` and `CreateFolderInput` in `src/lib/chat-store.ts`, `ExtendedMessage` and `DBMessage` in `src/types/chat.ts`
- Prefer `interface` for object shapes (`src/types/chat.ts`); use `type` for unions and imported type-only symbols (`import type { ... }`)
- Enums are used sparingly for fixed sets: `LogLevel` in `src/lib/logger.ts`
- Client events are namespaced strings: `ChatEvents.CHAT_CREATED = 'myrag:chat_created'` in `src/lib/chat-store.ts`

## Code Style

- No Prettier config at the repository root. The app code in `src/` uses 2-space indentation (no tab-indented files found) and single quotes for imports and strings (about 333 `src/` files import with single quotes versus about 30 with double quotes)
- Semicolons are used in most files, but not uniformly; match the surrounding file rather than reformatting
- `baileys-whatsapp/.prettierrc` is the only explicit Prettier configuration: tabs (`useTabs: true`, `tabWidth: 2`), `semi: false`, `singleQuote: true`, `jsxSingleQuote: true`, `arrowParens: "avoid"`, `printWidth: 120`, `trailingComma: "none"`. Apply these settings only inside `baileys-whatsapp/`
- ESLint flat config at `eslint.config.mjs` extending `@eslint/js` recommended and `typescript-eslint` recommended
- `no-unused-vars` is `warn` with `_`-prefix ignore patterns
- `@typescript-eslint/no-explicit-any` is `warn`. The codebase still uses `any` heavily (roughly 800 occurrences under `src/`), so new code should type values explicitly and avoid adding new `any`
- `react-hooks/rules-of-hooks` is `error`; `react-hooks/exhaustive-deps` is `warn` for files under `src/**`
- Node-side files (`src/app/api/**`, `scripts/**`) turn off `no-undef` and `@typescript-eslint/no-require-imports`, so CommonJS `require` is acceptable in scripts
- `.eslintignore` ignores all files (`**/*`) so ESLint does not block Vercel builds; run `npm run lint` explicitly before handoff
- Suppression comments are rare (about 4 `eslint-disable`/`@ts-ignore` occurrences under `src/`); do not add new ones without a reason
- Root `tsconfig.json` has `strict: true`, `target: ES2018`, `moduleResolution: bundler`, `isolatedModules: true`, and the `@/*` path alias mapped to `./src/*`
- `baileys-whatsapp/tsconfig.json` additionally enables `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; code in that service must use `import type` for type-only imports

## Import Organization

- `@/*` → `src/*` (defined in `tsconfig.json`). Prefer it over deep relative paths such as `../../../lib/...`. Use relative imports only for siblings within the same folder (e.g. `./supabase` inside `src/lib/`)

## Error Handling

- Return structured JSON errors with `NextResponse.json({ error: '...' }, { status: N })`, for example `src/app/api/generate-image/route.ts`
- Validate request bodies with Zod through `withValidation(schema, handler)` or `validateRequest(req, schema)` from `src/lib/api-middleware.ts`. Validation failures return HTTP 400 with `{ success: false, error, details: [{ path, message }] }`
- Use `z` from `zod/v3` in API code (this import path is the established pattern in `src/app/api/chat/route.ts` and `src/lib/api-middleware.ts`)
- Streaming chat responses report errors in-band with `formatErrorSSE(message)` from `src/lib/error-stream.ts`, which emits a UI-message-stream `error` event followed by `[DONE]`. Do not emit the legacy v4 wire format
- Zustand store actions catch Supabase errors and write a human-readable string into `error` state (`ChatStore.error` in `src/lib/chat-store.ts`) rather than throwing into components
- Domain errors extend `Error`: `WhatsAppError` in `src/lib/whatsapp/types.ts`
- Wrap `JSON.parse`/`req.json()` in try/catch and return a 400 on failure (see `validateRequest`)
- Log the failure with a bracketed prefix before returning (see Logging)

## Logging

- Prefix every log line with a bracketed tag naming the subsystem: `console.log('[Document Reference Tool] ...')`, `console.error('[Nango] ...')`, `console.log('[RAG SYSTEM] ...')`, `console.error('[ToolExecutionState] ...')`
- Use `[Document Search]` for retrieval diagnostics (required by `AGENTS.md` section 6)
- Log structured data as a second argument object rather than string concatenation: `console.log('[Document Reference Tool] Document referenced:', { documentId, documentName })`
- Avoid log spam in hot paths (streaming loops, per-token handlers); the codebase already has many verbose `[DEBUG]` lines, so do not add new unconditional debug logs. Prefer `logger` for anything that should be silenced in production
- Never log API key values; log presence or length only (see the `OPENROUTER_API_KEY_STATUS` pattern in `src/app/api/chat/route.ts`)

## Comments

- Keep comments minimal (per `AGENTS.md` section 4). Comments explain why a non-obvious workaround exists, e.g. the explanation of the v5 SSE payload in `src/lib/error-stream.ts`
- Section headers with `// ---` or `// Folder management` labels group related members inside a large interface (`src/lib/chat-store.ts`)
- Used on exported utilities and public helpers with `@param` / `@returns` tags, e.g. `validateRequest` and `withValidation` in `src/lib/api-middleware.ts`
- Not required on components or internal helpers

## Function Design

## Module Design

- Create stores with `create<State>()(...)` (`src/lib/user-settings-store.ts`) or `create<State>((set) => ...)` (`src/lib/stores/voice-store.ts`)
- Subscribe in components with selectors and `useShallow` from `zustand/react/shallow`, selecting only the fields a component needs. Example from `src/components/ui/sidebar.tsx`:
- Single-field selectors are fine without `useShallow`: `useChatStore((s) => s.currentChatId)`. Never call `useChatStore()` without a selector in components
- Functional components only; the React Compiler is enabled in `next.config.js`, so avoid manual `useMemo`/`useCallback` unless a dependency genuinely needs stability
- Tailwind utility classes for styling; merge conditional classes with `cn()` from `src/lib/utils.ts` (wraps `clsx` and `tailwind-merge`)
- Animations use Framer Motion; icons come from `lucide-react` and `@tabler/icons-react`
- Radix primitives are wrapped under `src/components/ui/` (shadcn style, configured by `components.json`)

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

```text

```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Root layout and providers | Fonts, theme, auth, model, language, sources, artifact providers | `src/app/layout.tsx`, `src/app/client-layout.tsx` |
| Main chat page | Chat UI state, message streaming via `useChat`, sidebar, persistence | `src/app/page.tsx` |
| Chat API | Query classification, RAG retrieval, MCP tool planning, `streamText` streaming, persistence | `src/app/api/chat/route.ts` |
| MCP approval | Executes approved MCP tool calls | `src/app/api/chat/approve/route.ts` |
| Document ingestion | Parsing, token-based chunking, embeddings, image captioning | `src/lib/document-processor.ts`, `src/app/api/process-document/route.ts`, `src/app/api/upload/route.ts` |
| Retrieval | Enhanced vector retrieval, comprehensive/aggregate strategies, reranking, MMR, BM25 | `src/lib/enhanced-rag-retrieval.ts`, `src/lib/retrieval-strategies.ts`, `src/lib/optimized-search.ts`, `src/lib/mmr-scorer.ts`, `src/lib/bm25-scorer.ts`, `src/lib/reranker-local.ts` |
| Query classification | Intent, tool-need, and temporal detection | `src/lib/query-classifier.ts`, `src/lib/temporal-query-detector.ts` |
| Supabase access | Singleton browser/admin clients, chat and document persistence | `src/lib/supabase.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/server.ts`, `src/lib/supabase/middleware.ts` |
| MCP integration | Universal client, transports, smart and production routers, caching | `src/lib/mcp/`, `src/lib/mcp-cache.ts` |
| Nango connectors | Google Drive / Notion / Dropbox sync into `document_chunks` | `src/lib/nango/`, `src/app/api/nango/` |
| WhatsApp | Provider factory (Koyeb or Fly.io) and webhook handling | `src/lib/whatsapp/client-factory.ts`, `src/lib/whatsapp/webhook-handler.ts` |
| Deployment mode | Single vs multi-tenant feature gating | `src/lib/deployment-mode.ts` |
| Env access | Typed environment access and defaults | `src/lib/env.ts`, `src/lib/env-utils.ts` |
| Voice pipeline | LiveKit agent, VAD, STT, LLM, TTS, query rewriting | `voice-agent/src/agent.ts`, `voice-agent/src/voice_agent.ts` |
| Config dashboard | Visual env, admin, model, and RAG prompt management | `scripts/config-server.js`, `scripts/config-ui/index.html` |

## Pattern Overview

- Single Next.js project; `@/` path alias maps to `src/` (`tsconfig.json`).
- All API handlers are Next.js route handlers (`route.ts`) exporting `POST`/`GET`, with `export const runtime = 'nodejs'` on heavy routes such as `src/app/api/chat/route.ts`.
- The chat endpoint streams Server-Sent Events via the Vercel AI SDK (`streamText`, `createUIMessageStream`) and the client consumes them with `useChat` from `@ai-sdk/react` in `src/app/page.tsx`.
- Client state is held in many small Zustand stores, not a single global store (for example `src/lib/chat-store.ts`, `src/lib/web-search-store.ts`, `src/lib/stores/voice-store.ts`).
- Multi-tenant vs single-tenant behaviour is switched at runtime by `isMultiTenant()` in `src/lib/deployment-mode.ts`, and by SQL setup files in `supabase/`.
- Provider selection is env-driven: `NEXT_PUBLIC_AI_PROVIDER` (`src/app/api/chat/route.ts`), `WHATSAPP_PROVIDER` (`src/lib/whatsapp/client-factory.ts`), `RAG_BEHAVIOR_MODE` (`src/app/api/chat/route.ts`).
- React Compiler and `turbopack.root` are enabled in `next.config.js`.

## Layers

- Purpose: Chat, sidebar, settings, artifact preview, voice overlay, config UI components.
- Location: `src/components/`, `src/app/**/page.tsx`
- Contains: React function components, Radix-based primitives in `src/components/ui/`, providers in `src/components/providers/`.
- Depends on: `src/lib/` stores and hooks, `src/types/`, `src/translations/`.
- Used by: Next.js routing only.
- Purpose: Zustand stores and React hooks encapsulating client behaviour.
- Location: `src/lib/*-store.ts`, `src/lib/stores/`, `src/lib/hooks/`, `src/hooks/`, `src/contexts/`
- Contains: Stores (chat, web search, file upload, organization, reasoning, voice, admin, user settings, ghost mode), hooks (`use-voice-mode.ts`, `use-nango.ts`, `use-organization.ts`).
- Depends on: `src/lib/supabase/client.ts`, `src/lib/chat-utils.ts`.
- Used by: `src/app/page.tsx` and components.
- Purpose: HTTP boundary. Validate input, call services, return JSON or SSE.
- Location: `src/app/api/**/route.ts`
- Contains: About 88 route files across chat, documents, folders, MCP, Nango, WhatsApp, organizations, config, admin, scrapers, generators, internal voice endpoints.
- Depends on: `src/lib/` services, `src/lib/api-middleware.ts` (Zod validation via `withValidation`).
- Used by: Browser UI, the voice agent (`/api/internal/voice-chat`, `/api/internal/voice-rag`), embeds (`/api/embed/chat`), Stripe and Nango webhooks.
- Purpose: RAG, MCP routing, document processing, connectors, WhatsApp, payments.
- Location: `src/lib/`
- Contains: `document-processor.ts`, `enhanced-rag-retrieval.ts`, `thinking-rag-enhancer.ts`, `mcp/*`, `nango/*`, `whatsapp/*`, `stripe.ts`, `polar.ts`, `openrouter.ts`, `scrapers/*`.
- Depends on: `src/lib/env.ts`, `src/lib/supabase.ts`, `src/lib/logger.ts`, external SDKs.
- Used by: API routes.
- Purpose: Supabase tables for chats, documents, `document_chunks` with pgvector embeddings, folders, organizations, subscriptions, WhatsApp sessions.
- Location: `src/lib/supabase.ts` (`getSupabase()`, `getSupabaseAdmin()`, `searchSimilarChunks`, `createChat`, `updateChat`), schema in `supabase/single-tenant-setup.sql` and `supabase/multi-tenant-setup.sql`.
- Depends on: `@supabase/supabase-js`, `@supabase/ssr`.
- Used by: All service and route layers.
- Voice agent: `voice-agent/src/` (`VoicePipeline` in `voice_agent.ts`, LiveKit worker in `agent.ts`, `RAGClient` in `rag_client.ts`, providers in `voice-agent/src/providers/`).
- WhatsApp Baileys: `baileys-whatsapp/server.ts` (Express API with `API_KEY` header check, session map, webhook dispatch) on top of the `src/` Baileys library.
- Config server: `scripts/config-server.js` (Express on port 3333) serving `scripts/config-ui/index.html`, plus admin and RAG helper scripts in `scripts/`.

## Data Flow

### Primary Request Path (chat, streaming)

### Document Ingestion

### Approval Flow for MCP Tools

### Voice Flow

### WhatsApp Flow

- Server: Stateless route handlers. Chat state persists in Supabase. MCP tool and connection caches are in-process (`src/lib/mcp-cache.ts`).
- Client: Zustand stores plus React state in `src/app/page.tsx`. Store subscriptions use `useShallow` from `zustand/react/shallow`.

## Key Abstractions

- Purpose: Single entry point for Supabase clients with build-phase guard and env validation.
- Examples: `src/lib/supabase.ts` (`SupabaseManager`, `getSupabase`, `getSupabaseAdmin`)
- Pattern: Singleton with lazy initialization; `supabase` and `supabaseAdmin` exported as Proxies.
- Purpose: Route natural-language intents to MCP servers and execute tools.
- Examples: `src/lib/mcp/universal-client.ts`, `src/lib/mcp/smart-router.ts` (`SmartMcpRouter`), `src/lib/mcp/production-router.ts` (`ProductionMcpRouter`), `src/lib/mcp/transport-factory.ts`, `src/lib/mcp/transports/`
- Pattern: Strategy-based transports (SSE, streamable HTTP) and per-server query patterns in `src/lib/mcp/query-patterns/servers/`.
- Purpose: Uniform client across Baileys hosting providers.
- Examples: `src/lib/whatsapp/base-client.ts`, `src/lib/whatsapp/koyeb-client.ts`, `src/lib/whatsapp/flyio-client.ts`
- Pattern: Abstract base class with factory selection by `WHATSAPP_PROVIDER`.
- Purpose: Choose among retrieval approaches per query.
- Examples: `src/lib/enhanced-rag-retrieval.ts`, `src/lib/retrieval-strategies.ts`, `src/lib/optimized-search.ts`, `src/lib/adaptive-retrieval.ts`
- Pattern: Functional pipelines with scorer modules (`mmr-scorer.ts`, `bm25-scorer.ts`, `reranker-adapter.ts`).
- Purpose: Zod-based request validation with structured 400 responses.
- Examples: `src/lib/api-middleware.ts` (`validateRequest`, `withValidation`)
- Pattern: Route wraps handler; errors returned as `{ success: false, error, details }`.
- Purpose: Convert between UI, API, and DB message shapes.
- Examples: `src/types/chat.ts` (`toAPIMessage`, `toDBMessages`, `fromUIMessage`, `toExtendedMessages`), `src/types/messages.ts`, `src/types/events.ts`
- Pattern: Pure conversion functions; `ExtendedMessage` carries sources and images.

## Entry Points

- Location: `src/app/layout.tsx` (server layout, metadata), `src/app/page.tsx` (chat home)
- Triggers: Browser navigation.
- Responsibilities: Mount providers and the main chat UI.
- Location: `src/app/api/chat/route.ts`
- Triggers: `useChat` POST from the UI and embed clients.
- Responsibilities: Full RAG + MCP + streaming pipeline.
- Location: `src/app/embed/chat.js/route.ts` (script), `src/app/embed/window/page.tsx`, `src/app/api/embed/chat/route.ts`
- Triggers: Third-party sites loading the embed script.
- Responsibilities: Embeddable chat with rate limiting (`src/lib/embed-rate-limit.ts`).
- Location: `src/app/shared/[shareId]/page.tsx`, `src/app/api/chats/[shareId]/route.ts`
- Triggers: Share links.
- Responsibilities: Read-only rendering of shared conversations.
- Location: `voice-agent/src/agent.ts`
- Triggers: LiveKit dispatch; `cd voice-agent && npm run dev`.
- Responsibilities: Connect to room, run VAD, STT, LLM, TTS.
- Location: `baileys-whatsapp/server.ts`
- Triggers: HTTP calls from Next.js WhatsApp clients.
- Responsibilities: Session lifecycle, QR and pairing code, message send and media upload, webhook dispatch.
- Location: `scripts/config-server.js` (port 3333), `src/app/config-ui/route.tsx` (in-app route)
- Triggers: `npm run config`.
- Responsibilities: Env edits, admin users, model lists, RAG prompt tuning.

## Architectural Constraints

- **Threading:** Node.js single-threaded event loop for Next.js routes (`runtime = 'nodejs'`). Voice agent uses a mutex for audio playback (`voice-agent/src/agent.ts`).
- **Global state:** Module-level singletons: `supabaseManager` in `src/lib/supabase.ts`, `productionMcpRouter` (`src/lib/mcp/production-router.ts`), `smartMcpRouter` (`src/lib/mcp/smart-router.ts`), `WhatsAppClientFactory.instance` (`src/lib/whatsapp/client-factory.ts`), `sessions` Map in `baileys-whatsapp/server.ts`, and MCP caches in `src/lib/mcp-cache.ts`. These are per-process and reset on cold start or across serverless instances.
- **Circular imports:** Not verified in this pass. `src/app/page.tsx` imports `src/lib/supabase.ts` (type and runtime) and `src/lib/chat-store.ts`, which both import Supabase helpers; keep new imports one-directional.
- **Middleware:** `src/middleware.disabled.ts` is present but not active (file name disables it). Session refresh logic exists in `src/lib/supabase/middleware.ts` and is not wired in.
- **Large files:** `src/app/api/chat/route.ts` (~4500 lines), `src/app/page.tsx` (~5000 lines), `scripts/config-server.js` (~3600 lines). Changes here carry high regression risk.
- **Type checking:** `next.config.js` sets `typescript.ignoreBuildErrors: true`, so type errors do not fail the build.

## Anti-Patterns

### Monolithic route handlers

### Duplicate retrieval modules

### Duplicate Supabase helpers

## Error Handling

- Request validation failures return HTTP 400 with `{ success: false, error, details }` (`src/lib/api-middleware.ts`).
- Streaming errors are formatted with `formatErrorSSE` (`src/lib/error-stream.ts`).
- Retrieval fallbacks fall through to "information not available" in strict mode (`src/app/api/chat/route.ts`).
- Voice timestamp failures fall back to estimated timings (`voice-agent/src/providers/resemble.ts`).

## Cross-Cutting Concerns

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

| Skill | Description | Path |
|-------|-------------|------|
| brainstorming | "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation." | `.claude/skills/brainstorming/SKILL.md` |
| myrag-expert | Instant deep expertise on the myRAG codebase. Use when discussing architecture, diagnosing issues, planning features, debugging, or answering any question about the codebase. Eliminates need to re-analyze files each session. | `.claude/skills/myRAG-expert/SKILL.md` |
| frontend-design | Distinctive UI direction for new interfaces (Anthropics skill, pinned in repo). | `.claude/skills/frontend-design/SKILL.md` |
| impeccable | Critique and polish built UI before ship (pbakaus/impeccable, pinned). | `.claude/skills/impeccable/SKILL.md` |
| web-design-guidelines | Final code review against Vercel Web Interface Guidelines on changed UI files. | `.claude/skills/web-design-guidelines/SKILL.md` |
<!-- GSD:skills-end -->

## Frontend design pipeline (GSD + skills)

For UI surface work (`scripts/config-ui/`, `src/components/`, `src/app/`), follow **in order**:

1. `/gsd-ui-phase` → UI-SPEC.md (`gsd-ui-researcher` + **frontend-design**)
2. Implement with **frontend-design** direction on new interfaces
3. **Impeccable** critique/polish on built pages (`reference/*.md`; avoid launcher network download unless `IMPECCABLE_BIN` is set)
4. **web-design-guidelines** on every touched file — fix all findings
5. `/gsd-ui-review` (`gsd-ui-auditor`)
6. `/gsd-verify-work` — verifier runs `node scripts/ci/check-frontend-design-summary.mjs` (BLOCKER on UI phases)

Authoritative contract: `.claude/gsd-core/references/frontend-design-pipeline.md` and `frontend-design-verifier-gate.md`. Shared toggles: `.planning/config.json` → `workflow.ui_phase`, `ui_safety_gate`, `ui_review` (enabled). Skill pins: `.cursor/skills/FRONTEND-SKILLS.md` (same SHAs under `.claude/skills/`).

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-fast` for a trivial task inline, with no subagents and no PLAN.md
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
