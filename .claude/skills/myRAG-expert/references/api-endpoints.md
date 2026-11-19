<overview>
myRAG has 89 API routes organized across functional domains. All use Node.js runtime, integrate with Supabase, and follow consistent error handling patterns.

**Error Pattern:** `{ error: string, details?: string }` with status codes 400/401/403/404/409/500/504
**Auth Patterns:** Supabase session (multi-tenant), public (single-tenant), admin cookie, bearer token
</overview>

<auth_routes>

## Authentication & Admin

**GET `/api/auth/check`** - Check if user is authenticated
- Auth: Supabase session cookie
- Response: `{ success, authenticated, user?: { id, email } }`

**POST `/api/admin/login`** - Admin login
- Body: `{ email, userId }`
- Sets `admin_session` cookie (httpOnly, 1-day maxAge)
- Verifies user is in `admin_users` table

**POST `/api/admin/logout`** - Admin logout (clears cookie)

**GET `/api/admin/check`** - Check admin status (5-min cache)
- Response: `{ isAdmin: boolean }`

**GET `/api/admin/status`** - Admin status + settings
- Response: `{ isAdmin, settings?: { read_only_doc_dashboard } }`

**GET/POST `/api/admin/settings`** - Read/update admin settings
- Auth: admin cookie required
- Body (POST): `{ read_only_doc_dashboard: boolean }`

</auth_routes>

<chat_routes>

## Chat

**POST `/api/chat`** - Main chat endpoint (streaming)
- Auth: Supabase session (multi-tenant) or public (single-tenant)
- Body:
```typescript
{
  messages: ExtendedMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  ragEnabled?: boolean;
  documentsContext?: string;
  usedDocuments?: { id: string; filename: string; relevance: number }[];
  includeReasoningTokens?: boolean;
  ragSettings?: { hybridSearch?: boolean; reranking?: boolean; topK?: number };
}
```
- Response: Streaming text with tool calls and document references
- Features: Dual-mode RAG, MCP tools, email intent analysis, reasoning model support

**POST `/api/chat/approve`** - Tool approval workflow
- Body: `{ toolName, toolInput, sessionId? }`
- Response: `{ requiresApproval: boolean }`

**GET `/api/chats`** - List user chats (paginated)
- Params: `page=1, limit=20, organization_id?`
- Response: `{ chats[], pagination: { page, limit, total, totalPages } }`

**GET `/api/chats/[shareId]`** - Get shared chat (public, no auth)
- Response: `{ chat: { title, messages, createdAt, updatedAt } }`

**POST `/api/chats/share`** - Share a chat publicly
- Auth: Bearer token
- Body: `{ chatId }`
- Response: `{ shareId: string }`

</chat_routes>

<document_routes>

## Documents

**GET `/api/documents`** - List documents with chunk counts
- Auth: Required (multi-tenant) or public (single-tenant)
- Params: `organization_id?`
- Response: `{ documents: [{ id, filename, created_at, chunk_count, status }] }`

**DELETE `/api/documents/[id]`** - Delete document + chunks (cascade)

**POST `/api/process-document`** - Upload and process document
- Content-Type: multipart/form-data
- Body: `{ file, isTemporary?, organization_id? }`
- Flow: Upload to LlamaCloud → poll completion (max 40 attempts) → extract text/images → generate embeddings → batch insert chunks
- Response: `{ type, name, text, pages?, extractedImages?, id, successfulChunks?, totalChunks? }`

**POST `/api/upload`** - Upload files to storage
- Max 10MB, types: JPEG, PNG, PDF, text, DOCX, GIF, WebP
- Bucket: `chat-images`
- Response: `{ success, uploaded, total, files: [{ originalName, fileName, downloadUrl, size, type }] }`

</document_routes>

<folder_routes>

## Folders

**GET `/api/folders`** - List folders
**POST `/api/folders`** - Create folder (`{ name, color?, pinned? }`)
**PUT `/api/folders/[id]`** - Update folder fields
**PATCH `/api/folders/[id]`** - Toggle pin
**DELETE `/api/folders/[id]`** - Delete folder (`?deleteChats=true`)
**POST `/api/folders/move-chats`** - Move chats to folder (`{ chatIds, folderId }`)

</folder_routes>

<config_routes>

## Configuration

**GET/POST `/api/config`** - Read/update `.env.local`
- Validation: Keys must match `/^[A-Z][A-Z0-9_]*$/i`

**GET `/api/config/get-env`** - Get single env var (only NEXT_PUBLIC_* or allowlisted)
**POST `/api/config/reload`** - Reload NEXT_PUBLIC_* vars from .env.local

**GET/POST `/api/config/models`** - Model configuration
- Response: `{ provider, openaiModels: ModelWithReasoning[], openrouterModels: ModelWithReasoning[] }`

**GET `/api/config/get-logo`** / **POST `/api/config/upload-logo`** - Logo management
**POST `/api/config/upload-favicon`** - Favicon upload
**GET/POST `/api/config/rag-prompt`** - RAG system prompt management
**POST `/api/config/system-prompts/validate`** - Validate prompt
**GET `/api/config/system-prompts/[lang]`** - Get localized prompt
**POST `/api/config/system-prompts/translate`** - Translate prompt

</config_routes>

<generation_routes>

## Media Generation

**POST `/api/generate-image`**
- Providers: OpenAI (DALL-E), Fal.ai, Replicate
- Body: `{ prompt, aspectRatio?, numOutputs?, quality?, style?, sourceImage?, useContext? }`
- Storage: `chat-images` bucket

**POST `/api/generate-video`**
- Providers: Fal.ai (Veo3, ByteDance), Replicate
- Body: `{ prompt?, sourceImage?, useFastMode?, requestedModel?, duration? }`
- Storage: `chat-videos/{date}/`

**POST `/api/generate-3d`**
- Providers: Fal.ai (Trellis), Replicate
- Body: `{ prompt?, imageData?, texturedMesh?, textureSize?, meshSimplify? }`
- Storage: `3d-models` bucket

**POST `/api/audio`**
- Actions: `speech` (TTS) or `transcribe` (STT)
- Providers: OpenAI (Whisper, TTS-1), ElevenLabs
- Body: `{ action, text?, file?, provider?, voiceId? }`

</generation_routes>

<mcp_routes>

## MCP (Model Context Protocol)

**GET `/api/mcp/health`** - Comprehensive MCP health check
- Response: `{ overall, zapier: { configured, reachable, diagnostics }, universalClient: { initialized, connectionCount, toolCache } }`

**GET `/api/mcp/servers`** - List MCP servers
**POST `/api/mcp/servers`** - Add custom MCP server (Zod validated)

**POST `/api/mcp/execute`** - Execute MCP tool
- Body: `{ toolName, parameters, sessionId?, approved? }`
- Returns 202 if approval required

**GET `/api/mcp/tools`** - List all available MCP tools

</mcp_routes>

<org_routes>

## Organizations (Multi-tenant)

**GET `/api/organizations`** - List orgs: `{ personal, teams[], all[] }`
**POST `/api/organizations`** - Create personal org
**GET/POST `/api/organizations/[id]`** - Get/update org
**GET/POST `/api/organizations/[id]/share`** - Share settings / convert to collaborative
**GET/POST `/api/organizations/[id]/members`** - List/invite members
**DELETE/PATCH `/api/organizations/[id]/members/[userId]`** - Remove/update member
**GET/POST `/api/organizations/[id]/invites`** - List/create invites
**POST `/api/organizations/[id]/settings`** - Update org settings

</org_routes>

<other_routes>

## Other Routes

**POST `/api/title`** - Generate chat title via AI
**POST `/api/extract-name`** - Extract display name from email (30-day cache)
**POST `/api/web-search`** - Web search via OpenRouter (types: general/weather/stock)
**POST `/api/embed/chat`** - Embed widget chat endpoint
**POST `/api/create-checkout`** - Polar checkout
**POST `/api/create-stripe-checkout`** - Stripe checkout
**POST `/api/webhooks/stripe`** - Stripe webhook handler

**GET `/api/user/profile`** - Current user profile
**GET/PATCH `/api/user/preferences`** - User preferences

**POST `/api/scrapers/scrape`** - Scrape single URL
**POST `/api/scrapers/crawl`** - Crawl domain

**WhatsApp routes:** `/api/whatsapp/*` (status, qr, connect, disconnect, monitor, webhook, conversations)
**Nango routes:** `/api/nango/*` (connections, files, folders, notion/pages, sync, session, webhook)

</other_routes>
