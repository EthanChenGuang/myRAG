---
name: myrag-expert
description: Instant deep expertise on the myRAG codebase. Use when discussing architecture, diagnosing issues, planning features, debugging, or answering any question about the codebase. Eliminates need to re-analyze files each session.
---

<essential_principles>

## myRAG at a Glance

Production AI chat app with RAG, multi-model orchestration, and multi-modal generation (text, images, video, 3D).

**Stack:** Next.js 16 (App Router, React Compiler) + React 19 + TypeScript + Tailwind CSS + Supabase (PostgreSQL + pgvector HNSW) + Vercel AI SDK 5 + Zustand

**Deployment Modes:** Single-tenant (default, shared knowledge base) or Multi-tenant (per-org isolation, teams, invites)

### 1. Architecture Layers

```
┌─────────────────────────────────────────────────┐
│  FRONTEND: React 19 + Zustand + Radix UI        │
│  src/app/page.tsx (chat) + src/components/ui/    │
├─────────────────────────────────────────────────┤
│  API LAYER: Next.js Route Handlers (89 routes)   │
│  src/app/api/ (chat, docs, config, mcp, gen...)  │
├─────────────────────────────────────────────────┤
│  LIBRARY: AI providers, RAG pipeline, MCP, utils │
│  src/lib/ (env, supabase, stores, processors)    │
├─────────────────────────────────────────────────┤
│  DATA: Supabase (PostgreSQL + pgvector HNSW)     │
│  Tables: chats, documents, document_chunks, ...  │
├─────────────────────────────────────────────────┤
│  EXTERNAL: OpenRouter, OpenAI, Fal.ai, Stripe    │
│  WhatsApp (Baileys), MCP servers, LlamaCloud     │
└─────────────────────────────────────────────────┘
```

### 2. Critical Conventions

- **State management:** Zustand stores + `useShallow` selectors (never subscribe to entire store)
- **Streaming:** All AI responses stream via Vercel AI SDK `useChat()` hook
- **Model sync:** Models MUST be synced across 5 files: `.env.local`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, `scripts/config-ui/index.html`
- **RAG prompt:** Must contain `{{context}}` placeholder - validated by `SystemPromptManager`
- **Auth:** Supabase session + RLS policies. Multi-tenant adds org-level isolation
- **Singletons:** `EnvironmentConfig`, `SupabaseManager`, `UniversalMcpClient`, `SmartMcpRouter`

### 3. Directory Map

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `src/app/page.tsx` | Main chat interface | Uses `useChat()`, connects all stores |
| `src/app/api/chat/` | Chat streaming endpoint | `route.ts` - dual-mode RAG, MCP tools |
| `src/app/api/` | 89 API routes total | Auth, docs, config, gen, MCP, orgs |
| `src/components/ui/` | 74+ UI components | chat-message, chat-input, sidebar, header |
| `src/components/providers/` | Context providers | Auth, Model, Theme, Language, Artifact, Sources |
| `src/lib/` | Core library | Stores, AI providers, RAG, MCP, utils |
| `src/lib/stores/` | Zustand stores | reasoning-store, organization-store |
| `src/lib/mcp/` | MCP system | smart-router, universal-client, discovery |
| `src/lib/whatsapp/` | WhatsApp integration | client-factory, providers, webhooks |
| `src/lib/supabase/` | DB clients | client.ts (browser), server.ts (SSR) |
| `scripts/` | CLI tools | init-env, config-server, RAG diagnostics |
| `supabase/` | SQL schemas | single-tenant-setup.sql, multi-tenant-setup.sql |

### 4. Core Data Flows

**Chat Flow:** User input (ChatInput) → `useChat()` hook → POST `/api/chat` → RAG retrieval → AI provider (OpenRouter/OpenAI) → streaming response → `ChatMessage` render → save to Supabase `chats` table

**RAG Flow:** Upload → LlamaCloud parse → semantic/token chunking → OpenAI embeddings (1536-dim) → store in `document_chunks` with pgvector → On query: embed query → HNSW search → rerank (BM25/MMR) → inject into `{{context}}` → AI response

**MCP Flow:** Query → `classifyQuery()` → if tool needed: `SmartMcpRouter.analyzeAndRoute()` → tool discovery → approval check (unless YOLO mode) → `UniversalMcpClient.executeTool()` → result display in `McpToolBox`

### 5. Key Zustand Stores

| Store | File | Key State |
|-------|------|-----------|
| ChatStore | `chat-store.ts` | `chats[]`, `folders[]`, `currentChatId`, CRUD operations |
| UserSettingsStore | `user-settings-store.ts` | Theme, font, voice, TTS/STT, audio prefs |
| ReasoningStore | `stores/reasoning-store.ts` | `enabled`, `effort`, `maxOutputTokens` |
| OrganizationStore | `stores/organization-store.ts` | `currentOrganization`, members, invites |
| AdminStore | `admin-store.ts` | `isAdmin`, admin status checking |
| WebSearchStore | `web-search-store.ts` | `isEnabled`, `isAvailable` |
| FileUploadStore | `file-upload-store.ts` | Single file upload state |
| GhostModeStore | `ghost-mode-store.ts` | Temporary unsaved chat mode |
| DocumentMentionStore | `document-mention-store.ts` | Documents referenced in chat |

### 6. Database Schema (Key Tables)

- **chats**: `id, user_id, title, messages(JSONB), pinned, folder_id, organization_id, shared, share_id`
- **documents**: `id, filename, content, metadata(JSONB), organization_id, source, source_provider`
- **document_chunks**: `id, document_id, content, embedding(vector(1536)), metadata(JSONB), organization_id`
  - HNSW index: `m=64, ef_construction=200, vector_cosine_ops`
- **folders**: `id, user_id, name, color, pinned, organization_id`
- **organizations**: Multi-tenant org management
- **organization_members**: Team membership with roles
- **subscriptions**: Stripe/Polar payment tracking
- **admin_users / admin_settings**: Admin access control

</essential_principles>

<intake>
What would you like to know about myRAG?

1. **Discuss architecture** - Ask questions about how things work
2. **Diagnose an issue** - Debug a problem or trace an error
3. **Plan a feature** - Design a new feature aligned with existing patterns
4. **Find code** - Locate specific files, functions, or patterns
5. **Understand a flow** - Trace a data flow end-to-end
6. **Something else** - Any other codebase question

**I can answer immediately from pre-baked knowledge, or read specific files for current state.**
</intake>

<routing>
| Response | Workflow |
|----------|----------|
| 1, "how does", "explain", "what is", "architecture" | `workflows/discuss.md` |
| 2, "bug", "error", "broken", "not working", "debug", "fix" | `workflows/diagnose.md` |
| 3, "add", "feature", "implement", "build", "create new" | `workflows/plan-feature.md` |
| 4, "where is", "find", "locate", "which file" | Answer directly from reference_index knowledge |
| 5, "how does X flow", "trace", "data flow", "pipeline" | `workflows/discuss.md` (flow tracing) |
| 6, other | Clarify intent, then route appropriately |

**After reading the workflow, follow it exactly.**
</routing>

<reference_index>

All in `references/`:

**Architecture:** architecture.md - Full system overview, layers, patterns
**API:** api-endpoints.md - All 89 API routes with contracts and auth
**Library:** lib-modules.md - All src/lib modules, exports, patterns
**Stores:** stores.md - All Zustand stores with full interfaces
**Components:** components.md - 74+ UI components, hierarchy, providers
**RAG:** rag-pipeline.md - Full RAG internals, chunking, retrieval, reranking
**AI Models:** ai-models.md - Model config, providers, routing, 5-file sync
**Database:** database.md - Schema, tables, indexes, RLS, vector search
**Integrations:** integrations.md - WhatsApp, Stripe, MCP, Nango, external services
**Environment:** environment.md - All env vars grouped by feature
**Debugging:** debugging.md - Common issues, diagnostic scripts, troubleshooting

</reference_index>

<workflows_index>

All in `workflows/`:

| File | Purpose |
|------|---------|
| discuss.md | Answer architecture questions, trace flows, explain patterns |
| diagnose.md | Debug issues, trace errors, identify root causes |
| plan-feature.md | Design new features aligned with existing patterns |
| modify-code.md | Guide code changes with awareness of dependencies |

</workflows_index>

<quick_answers>

**Common questions answered instantly:**

- "Where is the chat endpoint?" → `src/app/api/chat/route.ts`
- "Where are models defined?" → 5 files (see essential_principles #2)
- "How does RAG work?" → See essential_principles #4 RAG Flow
- "Where are stores?" → `src/lib/chat-store.ts`, `src/lib/user-settings-store.ts`, `src/lib/stores/`
- "What database tables exist?" → See essential_principles #6
- "How to add a new API route?" → Create `src/app/api/{name}/route.ts`, follow existing patterns
- "How to add a new model?" → Update all 5 sync files with Model interface
- "Where is auth?" → `src/components/providers/auth-provider.tsx` + Supabase session
- "How does streaming work?" → `useChat()` from `@ai-sdk/react` → `streamText()` in API route
- "What's the vector index?" → HNSW on `document_chunks.embedding`, m=64, ef_construction=200, cosine similarity

</quick_answers>

<success_criteria>
- Questions answered without needing to read files (from pre-baked knowledge)
- File paths and type definitions are accurate
- Architectural advice aligns with existing conventions
- Debugging guidance points to correct diagnostic tools
- Feature plans follow established patterns (Zustand, streaming, Supabase RLS)
</success_criteria>
