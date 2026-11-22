---
last_mapped_commit: 41a47818ac26f9ea788ccb18230fb3351065c2a2
last_mapped_at: 2026-11-22
---
# Codebase Structure

**Analysis Date:** 2026-11-22

## Directory Layout

```
myRAG/                          # repo root (Next.js app + auxiliary services)
├── src/                        # Next.js application (path alias @/ -> src/)
│   ├── app/                    # App Router: pages, layouts, route handlers
│   │   ├── api/                # ~88 route.ts files (chat, documents, mcp, nango, whatsapp, ...)
│   │   ├── auth/               # Login, signup, verify-email, OAuth callback pages
│   │   ├── embed/              # Embeddable chat (script, window, demo)
│   │   ├── shared/[shareId]/   # Read-only shared chat pages
│   │   ├── pricing/, pricing-stripe/
│   │   └── config-ui/          # In-app route for config UI
│   ├── components/             # React components
│   │   ├── ui/                 # Most UI: chat, sidebar, settings, artifact-sidebar, nango, mcp-tools
│   │   ├── providers/          # Context providers (auth, model, language, sources, artifact, ...)
│   │   ├── voice/              # Voice mode overlay, orb, waveform
│   │   └── config-ui/          # Connector config components
│   ├── lib/                    # Services, stores, utilities (flat + subfolders)
│   │   ├── mcp/                # MCP routers, clients, transports, query patterns
│   │   ├── nango/              # Nango connector client, sync, file fetch
│   │   ├── whatsapp/           # WhatsApp provider clients and session logic
│   │   ├── scrapers/           # Firecrawl client and URL utilities
│   │   ├── supabase/           # client.ts, server.ts, middleware.ts
│   │   ├── stores/             # Zustand stores (organization, reasoning, voice)
│   │   ├── hooks/              # Shared React hooks (voice, nango, org, audio)
│   │   ├── auth/               # Organization handler
│   │   ├── config/             # Connector config
│   │   └── utils/              # date-grouping, sanitize-title
│   ├── types/                  # chat, messages, events, folder types
│   ├── translations/           # UI translations (20 files)
│   ├── hooks/                  # use-mobile-detection, useShareChat
│   ├── contexts/               # mobile-tools-context
│   ├── middleware.disabled.ts  # Inactive Next middleware (renamed to disable)
├── voice-agent/                # Separate Node service: LiveKit voice pipeline
│   ├── src/                    # agent.ts, voice_agent.ts, rag_client.ts, providers/
│   └── scripts/
├── baileys-whatsapp/           # Separate WhatsApp Baileys service (Express server.ts)
│   ├── src/                    # Baileys library source (Socket, Signal, Utils, Types, WABinary, ...)
│   ├── WAProto/                # Protobuf definitions and generator scripts
│   ├── proto-extract/          # Proto extraction tooling
│   └── Example/, Media/        # Examples and test media
├── scripts/                    # Node utilities and admin tooling
│   ├── config-ui/              # Browser UI for config dashboard (index.html + JS modules)
│   │   ├── admin/              # Admin user CLI scripts
│   │   ├── document-processing/# Document manager, status monitor, RAG config
│   │   └── pickers/            # Nango file, folder, and Notion pickers
│   ├── rag/                    # RAG diagnostics and reprocessing helpers
│   └── whatsapp/               # WhatsApp helper scripts and tests
├── supabase/                   # SQL setup: single-tenant and multi-tenant schemas
├── public/                     # Static assets (logos, connector icons, screenshots)
├── prompts/                    # Prompt notes for skill creation
├── artifacts/research/         # Research notes
├── .planning/codebase/         # GSD codebase map documents (this folder)
├── next.config.js, package.json, tsconfig.json, eslint.config.mjs, tailwind.config.ts
└── README*.md, AGENTS.md, CLAUDE.md
```

## Directory Purposes

**`src/app/api/`:**
- Purpose: HTTP route handlers. Each folder maps to one URL segment, and dynamic segments use `[id]`, `[shareId]`, `[lang]`, `[userId]`, `[token]`.
- Contains: `route.ts` files exporting `POST`, `GET`, `PUT`, or `DELETE`.
- Key files: `src/app/api/chat/route.ts` (chat), `src/app/api/chat/approve/route.ts` (MCP approval), `src/app/api/upload/route.ts`, `src/app/api/process-document/route.ts`, `src/app/api/internal/voice-rag/route.ts`, `src/app/api/internal/voice-chat/route.ts`, `src/app/api/whatsapp/webhook/route.ts`, `src/app/api/nango/webhook/route.ts`, `src/app/api/webhooks/stripe/route.ts`.

**`src/app/`:**
- Purpose: Pages and layouts (App Router).
- Key files: `src/app/layout.tsx` (root layout, `generateMetadata`), `src/app/client-layout.tsx` (client providers and sidebar wrapper), `src/app/page.tsx` (main chat UI, about 5000 lines), `src/app/globals.css`.

**`src/components/ui/`:**
- Purpose: Most presentational and feature components. Includes shadcn-style primitives (`button.tsx`, `dialog.tsx`, `card.tsx`, `dropdown-menu.tsx`).
- Key files: `src/components/ui/chat-input.tsx`, `src/components/ui/chat-message.tsx`, `src/components/ui/sidebar.tsx`, `src/components/ui/settings-modal.tsx`, `src/components/ui/settings/SettingsModal.tsx`, `src/components/ui/artifact-sidebar/index.tsx`, `src/components/ui/document-dashboard.tsx`.
- Subfolders: `artifact-sidebar/`, `markdown/`, `mcp-tools/`, `nango/`, `scrapers/`, `settings/` (with `tabs/`, `hooks/`, `components/`, `styles/`).

**`src/components/providers/`:**
- Purpose: React context providers mounted in `src/app/client-layout.tsx`.
- Key files: `auth-provider.tsx`, `model-provider.tsx` (`AVAILABLE_MODELS`), `artifact-provider.tsx`, `sources-provider.tsx`, `language-provider.tsx`, `font-provider.tsx`, `text-size-provider.tsx`, `markdown-provider.tsx`.

**`src/components/voice/`:**
- Purpose: Voice mode UI.
- Key files: `voice-mode-overlay.tsx`, `voice-mode-container.tsx`, `VoiceWidget.tsx`, `ogl-orb.tsx`, `voice-waveform.tsx`.

**`src/lib/`:**
- Purpose: Core services, stores, and utilities. Most files are flat at this level.
- Key files:
  - RAG: `src/lib/enhanced-rag-retrieval.ts`, `src/lib/retrieval-strategies.ts`, `src/lib/optimized-search.ts`, `src/lib/adaptive-retrieval.ts`, `src/lib/thinking-rag-enhancer.ts`, `src/lib/rag-mode.ts`, `src/lib/mmr-scorer.ts`, `src/lib/bm25-scorer.ts`, `src/lib/reranker-local.ts`, `src/lib/reranker-adapter.ts`, `src/lib/semantic-chunker.ts`
  - Documents: `src/lib/document-processor.ts`, `src/lib/pdf-utils.ts`, `src/lib/upload-utils.ts`, `src/lib/url-extractor.ts`
  - Query handling: `src/lib/query-classifier.ts`, `src/lib/query-enhancer-local.ts`, `src/lib/temporal-query-detector.ts`, `src/lib/temporal-metadata-extractor.ts`, `src/lib/multi-step-parser.ts`
  - AI and prompts: `src/lib/openrouter.ts`, `src/lib/system-prompt-manager.ts`, `src/lib/title-generator*.ts`, `src/lib/elevenlabs-utils.ts`
  - Persistence: `src/lib/supabase.ts`, `src/lib/chat-store.ts`, `src/lib/chat-utils.ts`
  - Config and env: `src/lib/env.ts`, `src/lib/env-utils.ts`, `src/lib/admin-utils.ts`, `src/lib/deployment-mode.ts`
  - Infra: `src/lib/api-middleware.ts`, `src/lib/logger.ts`, `src/lib/error-stream.ts`, `src/lib/mcp-cache.ts`, `src/lib/embed-rate-limit.ts`, `src/lib/stripe.ts`, `src/lib/polar.ts`
  - Stores (Zustand): `src/lib/chat-store.ts`, `src/lib/web-search-store.ts`, `src/lib/file-upload-store.ts`, `src/lib/multi-file-upload-store.ts`, `src/lib/document-mention-store.ts`, `src/lib/ghost-mode-store.ts`, `src/lib/admin-store.ts`, `src/lib/user-settings-store.ts`
  - Subfolder stores: `src/lib/stores/organization-store.ts`, `src/lib/stores/reasoning-store.ts`, `src/lib/stores/voice-store.ts`

**`src/lib/mcp/`:**
- Purpose: Model Context Protocol integration.
- Key files: `universal-client.ts`, `universal-discovery.ts`, `discovery.ts`, `smart-router.ts`, `production-router.ts`, `server-config.ts`, `transport-factory.ts`, `url-validator.ts`, `image-context-manager.ts`, `query-patterns/base.ts`, `query-patterns/index.ts`.
- Subfolders: `transports/` (`sse-transport.ts`, `streamable-http-transport.ts`), `query-patterns/servers/` (`zapier.ts`, README).

**`src/lib/whatsapp/`:**
- Purpose: WhatsApp provider clients and handling.
- Key files: `client-factory.ts`, `base-client.ts`, `koyeb-client.ts`, `flyio-client.ts`, `webhook-handler.ts`, `session-manager.ts`, `connection-monitor.ts`, `message-converter.ts`, `types.ts`.

**`src/lib/nango/`:**
- Purpose: Nango connector integration (Google Drive, Notion, Dropbox).
- Key files: `client.ts`, `sync-manager.ts`, `document-adapter.ts`, `file-fetcher.ts`, `types.ts`, `index.ts`.

**`src/lib/supabase/`:**
- Purpose: Supabase client factories by runtime. `client.ts` (browser), `server.ts` (server), `middleware.ts` (session refresh helper).
- Note: `src/lib/supabase.ts` (the file, not the folder) holds the connection manager and DB helpers. Both are imported; `@/lib/supabase` resolves to the file.

**`src/types/`:**
- Purpose: Shared TypeScript types. Key files: `chat.ts` (conversion helpers), `messages.ts`, `events.ts`, `folder.ts`.

**`src/translations/`:**
- Purpose: UI strings for 20 languages. Imported as `Language` type in `src/app/api/chat/route.ts`.

**`voice-agent/src/`:**
- Purpose: Voice service.
- Key files: `agent.ts` (LiveKit worker, VAD, audio mutex), `voice_agent.ts` (`VoicePipeline`), `rag_client.ts`, `providers/assemblyai.ts`, `providers/resemble.ts`, `providers/types.ts`.

**`baileys-whatsapp/`:**
- Purpose: Standalone WhatsApp Baileys service and the Baileys library source.
- Key files: `server.ts` (Express app), `src/index.ts` (library entry), `src/Socket/`, `src/Utils/`, `src/Types/`, `src/Signal/`, `src/WABinary/`. `Dockerfile`, `fly.toml`, and `Procfile` are its deploy configs.
- Note: Has its own `CLAUDE.md`, `package.json`, and `tsconfig.json`. Treat as a separate project.

**`scripts/`:**
- Purpose: Node tooling. Invoked through `package.json` scripts (`dev`, `config`, `db:setup`, `reprocess-docs`, `test-rag`).
- Key files: `init-env.js` (writes `.env.local` defaults), `config-server.js` (port 3333), `setup-database.sh`, `reprocess-documents.js`, `close-room.ts`, `apply-logo-size.js`.
- Subfolders: `config-ui/`, `rag/`, `whatsapp/`.

**`supabase/`:**
- Purpose: SQL schema and RLS setup.
- Key files: `single-tenant-setup.sql`, `multi-tenant-setup.sql`, `README.md`.

**`public/`:**
- Purpose: Static assets served by Next.js. Connector icons in `public/connectors/` and `public/icons/connectors/`, logos in `public/logos/`, screenshot in `public/screenshots/`.

## Key File Locations

**Entry Points:**
- `src/app/layout.tsx`: Root layout and metadata.
- `src/app/page.tsx`: Chat home page.
- `src/app/api/chat/route.ts`: Chat API.
- `voice-agent/src/agent.ts`: Voice worker.
- `baileys-whatsapp/server.ts`: WhatsApp service.
- `scripts/config-server.js`: Config dashboard server.

**Configuration:**
- `next.config.js`: Next.js options (React Compiler, image remote patterns, `ignoreBuildErrors`).
- `tsconfig.json`: `@/*` path alias to `./src/*`.
- `eslint.config.mjs`: ESLint config. `.eslintignore` lists exclusions.
- `tailwind.config.ts`, `postcss.config.mjs`, `components.json` (shadcn config).
- `vercel.json`: Deployment config for the Next.js app.
- `src/lib/env.ts`: Env schema and access. `scripts/init-env.js`: Default `.env.local` template.
- `voice-agent/fly.toml`, `baileys-whatsapp/fly.toml`: Fly.io configs.

**Core Logic:**
- `src/app/api/chat/route.ts`: Orchestration of RAG, MCP, and streaming.
- `src/lib/document-processor.ts`: Chunking, embedding, image processing.
- `src/lib/enhanced-rag-retrieval.ts`: Retrieval.
- `src/lib/mcp/production-router.ts`: MCP routing.
- `src/lib/supabase.ts`: Supabase access and chat/document persistence.

**Testing:**
- `baileys-whatsapp/jest.config.js`: Jest config for the WhatsApp service.
- `scripts/whatsapp/tests/`: WhatsApp formatting and number tests.
- `scripts/rag/test-rag-system.js` is referenced by `npm run test-rag`, but it is not in the repository tree. Check before relying on it.
- `scripts/rag/check-rag-flow.js`, `scripts/rag/decode-rag-prompt.js`: RAG diagnostics.

## Naming Conventions

**Files:**
- Next.js routing files: lowercase fixed names (`page.tsx`, `layout.tsx`, `route.ts`, `loading.tsx`, `error.tsx`).
- `src/lib/` modules: kebab-case (`enhanced-rag-retrieval.ts`, `mcp-cache.ts`), with suffixes `-store.ts` for Zustand, `-utils.ts` for helpers, `-client.ts` for SDK wrappers.
- React components: mostly kebab-case files exporting PascalCase components (`chat-input.tsx` → `ChatInput`). Some PascalCase files exist in `src/components/ui/settings/` and `src/components/voice/` (`SettingsModal.tsx`, `VoiceWidget.tsx`). Follow the local folder pattern.
- Voice agent: mix of `snake_case` and kebab-case (`voice_agent.ts`, `rag_client.ts`, `agent.ts`). Follow the existing names.
- Scripts: kebab-case `.js` or `.ts` (`init-env.js`, `check-rag-flow.js`).
- Documentation: `README_<TOPIC>.md` at root (`README_VOICE_INTEGRATION.md`, `README_NANGO_INTEGRATION.md`).

**Directories:**
- Route segments: lowercase kebab-case (`verify-email`, `pricing-stripe`, `process-document`).
- Dynamic segments: bracketed (`[id]`, `[shareId]`, `[lang]`, `[token]`).
- `src/lib/` subfolders: lowercase single words or kebab-case (`whatsapp`, `query-patterns`).

**Other conventions:**
- Environment variables: `NEXT_PUBLIC_*` for client-visible values, otherwise server-only.

## Where to Add New Code

**New API endpoint:**
- Implementation: `src/app/api/<segment>/route.ts`. Export `POST` (or `GET`) and validate input with `withValidation` from `src/lib/api-middleware.ts`. Return JSON errors in the `{ success: false, error, details }` shape.
- Tests: Follow an existing script or Jest config. Test helpers do not exist under `src/` today.

**New RAG retrieval or ranking behaviour:**
- Implementation: `src/lib/` next to the owning module (`enhanced-rag-retrieval.ts`, `retrieval-strategies.ts`, or a new scorer file such as `mmr-scorer.ts`).
- Keep `{{context}}` in any RAG system prompt string. Prompt strings live under `src/lib/system-prompt-manager.ts` and `src/lib/rag-mode.ts`.

**New document ingestion type:**
- Implementation: parsing and chunking in `src/lib/document-processor.ts` (or a new helper in `src/lib/`), upload route in `src/app/api/upload/route.ts` or `src/app/api/process-document/route.ts`.

**New MCP server integration:**
- Config and discovery: `src/lib/mcp/server-config.ts`, `src/lib/mcp/discovery.ts`.
- Per-server query patterns: `src/lib/mcp/query-patterns/servers/<name>.ts`, registered in `src/lib/mcp/query-patterns/index.ts`.

**New UI component:**
- Feature component: `src/components/ui/<kebab-name>.tsx`. If it belongs to a feature folder (settings, artifact-sidebar, mcp-tools, nango), add it there.
- Shared primitive: `src/components/ui/`.
- Context: `src/components/providers/<name>-provider.tsx`, then mount in `src/app/client-layout.tsx`.

**New Zustand store:**
- Implementation: `src/lib/<name>-store.ts`, or `src/lib/stores/<name>-store.ts` for grouped domains. Use `useShallow` from `zustand/react/shallow` in consumers.

**New page:**
- Implementation: `src/app/<segment>/page.tsx`. Add a `layout.tsx` if it needs a different shell (as in `src/app/pricing/layout.tsx`).

**New WhatsApp provider:**
- Implementation: `src/lib/whatsapp/<provider>-client.ts` extending `base-client.ts`, then register in `src/lib/whatsapp/client-factory.ts`.

**New Supabase table or policy:**
- Implementation: Add SQL to `supabase/single-tenant-setup.sql` and `supabase/multi-tenant-setup.sql`. Keep RLS aligned in both files.

**Utilities:**
- Shared helpers: `src/lib/utils.ts` (general), `src/lib/utils/` (date and title helpers).

**Environment variables:**
- Add to `src/lib/env.ts`, mirror in `scripts/init-env.js`, and expose in `scripts/config-server.js` when admin-editable.

**Models:**
- Keep the five locations listed in `AGENTS.md` section 7 in sync: `.env.local`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, and the three fallback arrays in `scripts/config-ui/index.html`.

## Special Directories

**`.planning/`:**
- Purpose: GSD planning and codebase map documents.
- Generated: Yes (by GSD mapper commands).
- Committed: Yes (`.planning/codebase/` is tracked in git).

**`.claude/`:**
- Purpose: Claude Code settings, skills, and commands.
- Generated: No.
- Committed: Varies by file. Excluded from this map.

**`artifacts/`:**
- Purpose: Research notes (`artifacts/research/`).
- Generated: No.
- Committed: Yes.

**`prompts/`:**
- Purpose: Prompt text used when authoring skills.
- Generated: No.
- Committed: Yes.

**`voice-agent/` and `baileys-whatsapp/` `node_modules/`, `.next/`:**
- Purpose: Build and dependency output.
- Generated: Yes.
- Committed: No (`.gitignore`).

**`scripts/config-ui/`:**
- Purpose: Static dashboard assets served by `scripts/config-server.js`.
- Generated: No.
- Committed: Yes.

---

*Structure analysis: 2026-11-22*
