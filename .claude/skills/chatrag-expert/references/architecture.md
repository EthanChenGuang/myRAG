<overview>
ChatRAG is a production AI chat application with RAG (Retrieval-Augmented Generation), multi-model orchestration, and multi-modal generation capabilities. Built on Next.js 16 with React 19, it supports single-tenant and multi-tenant deployment modes.
</overview>

<system_architecture>

## System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    FRONTEND (Client)                          │
│  Next.js 16 App Router + React 19 + React Compiler           │
│                                                              │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌──────────────┐  │
│  │ Zustand  │  │ Provider │  │ Radix   │  │ Framer       │  │
│  │ Stores   │  │ Stack    │  │ UI      │  │ Motion       │  │
│  └─────────┘  └──────────┘  └─────────┘  └──────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ useChat() hook (Vercel AI SDK 5) - streaming interface  │ │
│  └─────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│                    API LAYER (Server)                         │
│  89 Next.js Route Handlers                                   │
│                                                              │
│  /api/chat (streaming) │ /api/documents │ /api/config        │
│  /api/generate-*       │ /api/mcp/*     │ /api/admin/*       │
│  /api/organizations/*  │ /api/auth/*    │ /api/whatsapp/*    │
├──────────────────────────────────────────────────────────────┤
│                    LIBRARY LAYER                              │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ RAG      │  │ MCP      │  │ AI       │  │ Document   │  │
│  │ Pipeline │  │ Router   │  │ Providers│  │ Processor  │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ System   │  │ Query    │  │ Reranker │  │ Temporal   │  │
│  │ Prompt   │  │ Enhance  │  │ (BM25+   │  │ Detector   │  │
│  │ Manager  │  │ Local    │  │ MMR)     │  │            │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                    DATA LAYER                                 │
│  Supabase (PostgreSQL + pgvector HNSW)                       │
│                                                              │
│  Tables: chats, documents, document_chunks, folders,         │
│  organizations, organization_members, subscriptions,         │
│  admin_users, admin_settings, tool_execution_states          │
│                                                              │
│  Vector: 1536-dim embeddings, HNSW (m=64, ef=200, cosine)  │
│  Auth: Supabase Auth + RLS policies                          │
│  Storage: chat-images, chat-videos, 3d-models, chat-attach  │
├──────────────────────────────────────────────────────────────┤
│                    EXTERNAL SERVICES                          │
│                                                              │
│  AI: OpenRouter, OpenAI, Anthropic (via OR)                  │
│  Gen: Fal.ai (images/video/3D), Replicate (fallback)        │
│  Audio: OpenAI Whisper/TTS, ElevenLabs                       │
│  Tools: MCP servers (Zapier, custom), Firecrawl, Exa        │
│  Payments: Stripe, Polar                                     │
│  Docs: LlamaCloud (parsing), Nango (connectors)             │
│  Chat: WhatsApp (Baileys on Fly.io/Koyeb)                   │
└──────────────────────────────────────────────────────────────┘
```

</system_architecture>

<directory_structure>

## Directory Structure

```
my-chat-rag/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Main chat interface (client component)
│   │   ├── layout.tsx            # Root layout (server)
│   │   ├── client-layout.tsx     # Client layout (provider stack)
│   │   ├── api/                  # 89 API route handlers
│   │   │   ├── chat/             # Chat + tool approval
│   │   │   ├── documents/        # Document CRUD
│   │   │   ├── process-document/ # Upload + process + embed
│   │   │   ├── generate-image/   # Image generation
│   │   │   ├── generate-video/   # Video generation
│   │   │   ├── generate-3d/      # 3D generation
│   │   │   ├── audio/            # TTS/STT
│   │   │   ├── config/           # Environment config CRUD
│   │   │   ├── admin/            # Admin auth + settings
│   │   │   ├── auth/             # Auth check
│   │   │   ├── mcp/              # MCP health/servers/execute/tools
│   │   │   ├── organizations/    # Multi-tenant org management
│   │   │   ├── folders/          # Chat folder CRUD
│   │   │   ├── chats/            # Chat list + sharing
│   │   │   ├── user/             # Profile + preferences
│   │   │   ├── nango/            # Document connectors
│   │   │   ├── scrapers/         # Web scraping
│   │   │   ├── whatsapp/         # WhatsApp integration
│   │   │   └── webhooks/         # Payment webhooks
│   │   ├── shared/[shareId]/     # Public shared chat view
│   │   ├── pricing/              # Pricing pages
│   │   └── embed/                # Embed widget
│   │
│   ├── components/
│   │   ├── ui/                   # 74+ reusable components
│   │   │   ├── chat-message.tsx
│   │   │   ├── chat-input.tsx
│   │   │   ├── sidebar.tsx
│   │   │   ├── header.tsx
│   │   │   ├── streaming-markdown.tsx
│   │   │   ├── model-selector.tsx
│   │   │   ├── document-dashboard.tsx
│   │   │   ├── settings-modal.tsx
│   │   │   ├── mcp-tool-box.tsx
│   │   │   ├── artifact-sidebar/
│   │   │   └── ... (74+ total)
│   │   ├── providers/            # Context providers
│   │   │   ├── auth-provider.tsx
│   │   │   ├── model-provider.tsx
│   │   │   ├── sources-provider.tsx
│   │   │   └── ... (8 providers)
│   │   └── theme-provider.tsx
│   │
│   ├── lib/
│   │   ├── env.ts                # Environment singleton
│   │   ├── supabase.ts           # DB client + document storage
│   │   ├── chat-store.ts         # Primary Zustand store
│   │   ├── user-settings-store.ts
│   │   ├── stores/               # Additional stores
│   │   │   ├── reasoning-store.ts
│   │   │   └── organization-store.ts
│   │   ├── mcp/                  # MCP system
│   │   │   ├── smart-router.ts
│   │   │   ├── universal-client.ts
│   │   │   ├── universal-discovery.ts
│   │   │   ├── production-router.ts
│   │   │   └── transport-factory.ts
│   │   ├── whatsapp/             # WhatsApp integration
│   │   ├── nango/                # Document connectors
│   │   ├── scrapers/             # Web scraping
│   │   ├── supabase/             # Supabase clients
│   │   ├── document-processor.ts # Chunking + embeddings
│   │   ├── semantic-chunker.ts   # Smart chunking
│   │   ├── enhanced-rag-retrieval.ts
│   │   ├── adaptive-retrieval.ts
│   │   ├── optimized-search.ts
│   │   ├── temporal-query-detector.ts
│   │   ├── reranker-local.ts
│   │   ├── bm25-scorer.ts
│   │   ├── mmr-scorer.ts
│   │   ├── query-enhancer-local.ts
│   │   ├── query-classifier.ts
│   │   ├── system-prompt-manager.ts
│   │   ├── types.ts              # Core types
│   │   ├── openrouter.ts         # OpenRouter client
│   │   ├── stripe.ts / polar.ts  # Payment clients
│   │   ├── deployment-mode.ts
│   │   ├── logger.ts             # SmartLogger
│   │   └── utils.ts              # cn() class merger
│   │
│   ├── hooks/                    # Custom React hooks
│   └── styles/                   # Global styles
│
├── scripts/
│   ├── init-env.js               # Environment initialization
│   ├── config-server.js          # Config dashboard server (:3333)
│   ├── setup-database.sh         # DB schema setup
│   ├── config-ui/                # Config dashboard UI + admin tools
│   ├── rag/                      # RAG diagnostic scripts
│   └── whatsapp/                 # WhatsApp utilities
│
├── supabase/
│   ├── single-tenant-setup.sql   # 1665 lines
│   └── multi-tenant-setup.sql    # 2199 lines
│
├── next.config.js                # React Compiler, Turbopack, image remotes
├── tailwind.config.ts            # Custom theme, typography, animations
├── tsconfig.json                 # Strict, ES2017, path alias @/*
├── CLAUDE.md                     # Project guidelines
└── package.json                  # 100+ dependencies
```

</directory_structure>

<build_config>

## Build Configuration

**next.config.js:**
- React Compiler: enabled
- Turbopack: enabled for dev
- TypeScript: `ignoreBuildErrors: true`
- Image: Remote patterns for Supabase, Replicate, custom hosts
- Server Actions: localhost:3000 allowed

**tsconfig.json:** Target ES2017, strict mode, module esnext, path alias `@/*` → `./src/*`

**Tailwind:** Custom HSL theme vars, dark mode (class-based), typography plugin, scrollbar plugin, custom animations

**Dependencies:** 100+ packages - Next.js 16, React 19, AI SDK 5, Supabase, Radix UI (15+ packages), Zustand, Framer Motion, multiple AI providers

</build_config>

<deployment_modes>

## Deployment Modes

**Single-Tenant (Default):**
- All users share same knowledge base
- `organization_id` always NULL
- No team/org management
- Simpler setup, fewer tables

**Multi-Tenant:**
- Per-organization knowledge bases
- Separate teams with invites
- Storage quotas per org
- Usage analytics
- Additional tables: organizations, organization_members, team_invites
- RLS policies filter by org membership
- Enabled via `NEXT_PUBLIC_CHATRAG_DEPLOYMENT_MODE=multi-tenant`

</deployment_modes>
