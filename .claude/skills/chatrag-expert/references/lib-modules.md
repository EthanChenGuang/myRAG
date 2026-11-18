<overview>
All library modules in `src/lib/` with their exports, purpose, and key patterns. Stores are documented separately in `stores.md`.
</overview>

<core_modules>

## Core Modules

### env.ts - Environment Configuration
**Singleton:** `EnvironmentConfig` with lazy initialization
**Export:** `env` object + `getAppName()`, `getSiteTitle()`, `getFaviconUrl()`
- Groups: Public vars (client+server), Server-only vars, RAG config, Model defaults, Audio/Voice
- Build-phase safe: validation skipped during `next build`

### supabase.ts - Database Client
**Singleton:** `SupabaseManager`
```typescript
getSupabase(): SupabaseClient       // Anon key (client operations)
getSupabaseAdmin(): SupabaseClient   // Service role (admin operations)
storeDocument(filename, content, chunks, metadata?): Promise<string>
searchSimilarChunks(queryEmbedding, matchCount?, threshold?): Promise<ChunkResult[]>
```
- Document storage includes: temporal entities, financial data, key terms, URL extraction
- Multi-tenant: `match_documents_by_workspace` RPC for org filtering

### supabase/client.ts - Browser Client
- `createClient()`: Supabase client for browser (auth, realtime, client queries)

### supabase/server.ts - Server Client
- Server-side Supabase operations

### supabase/middleware.ts - Auth Middleware
- Supabase auth handling in Next.js middleware

### deployment-mode.ts - Deployment Mode
```typescript
getDeploymentMode(): 'single-tenant' | 'multi-tenant'
isSingleTenant(): boolean
isMultiTenant(): boolean
requireMultiTenant(): void  // Throws if wrong mode
getFeatureFlags(): FeatureFlags
```

### types.ts - Core Types
```typescript
interface ParsedDocument { id, filename, content, chunks, metadata, created_at }
interface DocumentChunk { id, document_id, content, embedding: number[], metadata }
interface ReasoningConfig { effort?, max_tokens?, exclude?, enabled? }
const REASONING_MODELS: Record<string, ModelReasoningCapability>
// Maps model IDs to reasoning support: method, defaultEffort, maxTokensLimit, minTokens
```

</core_modules>

<ai_modules>

## AI & Provider Modules

### openrouter.ts - OpenRouter Client
```typescript
const openRouter: OpenAI | null  // Cached, null if no API key
```
Base URL: `https://openrouter.ai/api/v1`, headers: GitHub referer + app name

### system-prompt-manager.ts - System Prompt Manager
```typescript
class SystemPromptManager {
  static getPromptTemplate(templateKey, language?): SystemPrompt | null
  static assemblePrompt(preContext, postContext?): string
  static validatePrompt(prompt): boolean  // Checks for {{context}}
  static ensureContextPlaceholder(prompt): string
  static injectContext(prompt, context): string
  static getDefaultPrompt(): string
}
```
Context placeholder: `{{context}}` - MUST exist in RAG prompts

### query-classifier.ts - Query Classification
```typescript
interface QueryClassification {
  needsMcp: boolean;
  confidence: number;
  category: 'conversational' | 'tool_required' | 'document_search' | 'complex' | 'multi_step';
  matchedServer?: string;
  isMultiStep?: boolean;
  steps?: QueryStep[];
}
function classifyQuery(query, hasAttachedImage?): QueryClassification
```
Returns non-MCP classification if `NEXT_PUBLIC_MCP_SYSTEM_ENABLED=false`

</ai_modules>

<rag_modules>

## RAG Pipeline Modules

### document-processor.ts - Document Processing
```typescript
createEmbedding(text): Promise<number[]>
createBatchEmbeddings(chunks): Promise<{ embeddings, cost, tokensUsed, cached }>
getQueryEmbedding(query): Promise<number[]>
createTokenBasedChunks(text, maxTokens?, overlapTokens?): string[]
estimateCost(chunks): { cost, tokens }
```
- Switches to semantic chunking if `NEXT_PUBLIC_RAG_MODE=enhanced`
- Batch size: 10 chunks, `Promise.allSettled` for fault tolerance

### semantic-chunker.ts - Semantic Chunking
- Detailed in `rag-pipeline.md`

### enhanced-rag-retrieval.ts - Enhanced Retrieval
- Multi-strategy with temporal/financial scoring - detailed in `rag-pipeline.md`

### adaptive-retrieval.ts - Adaptive Retrieval
- Multi-stage with confidence-based progression - detailed in `rag-pipeline.md`

### optimized-search.ts - Optimized Search
- Cache → enhance → search → rerank → cache - detailed in `rag-pipeline.md`

### temporal-query-detector.ts - Temporal Detection
- Pattern matching for time/financial queries - detailed in `rag-pipeline.md`

### query-enhancer-local.ts - Query Enhancement
```typescript
shouldEnhanceQuery(query): boolean
quickEnhanceQuery(query): string
enhanceQuery(query): Promise<{ enhanced, confidence, type, keywords }>
```

### reranker-local.ts - Reranking
```typescript
rerankChunks(query, chunks, options?): Promise<ChunkWithScore[]>
bm25Rerank(query, chunks, options?): ChunkWithScore[]
```
Strategies: `bm25`, `hybrid`, `keyword-boost`

### bm25-scorer.ts - BM25
```typescript
class BM25Scorer { scoreQuery(query), getTopK(query, k) }
function hybridScore(bm25Score, semanticSimilarity, bm25Weight?): number
```

### mmr-scorer.ts - MMR (Maximum Marginal Relevance)
```typescript
applyMMR(candidates, topK?, config?): ScoredChunk[]
applyMMRWithGrouping(candidates, topK?, config?): ScoredChunk[]
```
Default λ=0.7, Jaccard similarity

</rag_modules>

<mcp_modules>

## MCP Modules (`src/lib/mcp/`)

### smart-router.ts - Smart MCP Router (Singleton)
```typescript
class SmartMcpRouter {
  analyzeAndRoute(query): Promise<RouteDecision>
  executeRoute(decision, parameters): Promise<ExecutionResult>
}
```
Config: maxRetries=3, timeoutMs=30000, fallbackEnabled=true, learningEnabled=true

### universal-client.ts - Universal MCP Client (Singleton)
```typescript
class UniversalMcpClient {
  static getInstance(): UniversalMcpClient
  discoverAllTools(): Promise<McpTool[]>
  executeTool(toolName, params): Promise<ToolExecutionResult>
}
```
1-minute TTL cache for tool discovery

### universal-discovery.ts - Discovery
### production-router.ts - Production routing with rate limiting
### transport-factory.ts - Transport creation (SSE, HTTP, Streamable HTTP)

</mcp_modules>

<utility_modules>

## Utility Modules

### utils.ts
- `cn(...inputs): string` - Tailwind class merging (clsx + tailwind-merge)

### logger.ts - SmartLogger
- Deduplication (30s window, max 2 repeats), auto-cleanup at 100 entries

### tool-execution-state.ts
- `ToolExecutionStateService` - CRUD for tool execution states in Supabase
- Status flow: pending → approved → running → completed/error/cancelled

### title-generator.ts / title-generator-creative.ts / title-generator-multimodal.ts
- Chat title generation (AI-based + heuristic fallback)
- Creative titles for image/video generation chats

### chat-title-utils.ts
- `generateChatTitleFromToolCall()`, `isToolApprovalRequest()`, `extractToolCallInfo()`

### url-extractor.ts
- `extractURLs(text)`: Finds links with categories
- `enrichChunkWithURLs(chunk)`: Adds URL metadata to chunks

### temporal-metadata-extractor.ts
- `extractEnhancedMetadata(content)`: Temporal entities, financial data, key terms, density

### upload-utils.ts / pdf-utils.ts / audio-utils.ts / elevenlabs-utils.ts
- File upload to Supabase, PDF handling, audio processing, ElevenLabs TTS

### embed-rate-limit.ts
- Rate limiting for embed widget (default: 100 requests per IP)

### api-middleware.ts
- Shared API middleware: auth validation, CORS, error formatting

### stripe.ts / polar.ts
- Payment provider clients (lazy initialization)

### multi-step-parser.ts
- Parses complex multi-step queries into individual steps

### performance-monitor.tsx
- React component for performance monitoring

</utility_modules>

<architectural_patterns>

## Key Architectural Patterns

**Singleton:** EnvironmentConfig, SupabaseManager, UniversalMcpClient, SmartMcpRouter, TransportFactory

**Lazy Initialization:** OpenRouter client, Stripe client, Supabase admin client

**Pipeline:** Document: Upload → Parse → Chunk → Embed → Store. RAG: Query → Embed → Search → Score → Rerank → Return

**Multi-Tenant:** Organization filtering in queries, RPC with workspace context, user-id isolation fallback

**Environment Priority:** `.env.local` (highest) → `.env` → hard-coded defaults in code

</architectural_patterns>
