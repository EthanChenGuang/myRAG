<overview>
Common debugging scenarios, diagnostic tools, and troubleshooting guides for ChatRAG.
</overview>

<diagnostic_scripts>

## Diagnostic Scripts

```bash
# Check RAG prompt configuration (validates {{context}} placeholder)
node scripts/rag/decode-rag-prompt.js

# Test RAG system end-to-end (embeddings, search, response)
node scripts/rag/test-rag-system.js

# Check complete RAG flow
node scripts/rag/check-rag-flow.js

# Reprocess all documents (regenerate embeddings/chunks)
node scripts/rag/reprocess-documents.js

# Open config dashboard (env management, admin, RAG tuning)
npm run config  # http://localhost:3333

# Check environment validation
node scripts/config-ui/check-env.js

# Database setup
npm run db:setup
```

</diagnostic_scripts>

<common_issues>

## Common Issues & Solutions

### Models not showing in UI
**Symptoms:** Model selector empty or missing models
**Root cause:** 5-file model sync broken
**Fix:**
1. Check JSON syntax in all 5 files: `.env.local`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, `scripts/config-ui/index.html`
2. Restart dev server
3. Clear browser `localStorage`
4. Verify model IDs match provider (openai/* or openrouter/*)

### Model icons not showing (reasoning/free/open-source badges)
**Root cause:** Boolean flags missing in model definition
**Fix:** Ensure `supportsReasoning`, `isFree`, `isOpenSource` flags are set correctly in all 5 sync files
**UI mapping:** `src/components/ui/model-selector.tsx`

### RAG not returning results
**Check order:**
1. `node scripts/rag/decode-rag-prompt.js` - verify `{{context}}` placeholder exists
2. `node scripts/rag/check-rag-flow.js` - test full pipeline
3. Check `OPENAI_API_KEY` is set (required for embeddings)
4. Check `document_chunks` table has data with embeddings
5. Check `RAG_SIMILARITY_THRESHOLD` isn't too high (default: 0.45)
6. Try `DEBUG_RAG=true` in `.env.local` for verbose logging

### RAG returning irrelevant results
**Tuning:**
- Increase `RAG_SIMILARITY_THRESHOLD` (try 0.55-0.65)
- Enable reranking: `RAG_RERANKING=true`, `RAG_RERANKING_STRATEGY=hybrid`
- Increase `RAG_MMR_LAMBDA` (higher = more relevance, less diversity)
- Check document chunk quality - may need reprocessing

### Document processing fails / times out
**Check:**
1. `LLAMA_CLOUD_API_KEY` is valid
2. File size < 20MB
3. Check LlamaCloud credits remaining
4. API route returns 504 if processing exceeds timeout (max 40 polling attempts)
5. Check `LLAMACLOUD_PARSE_MODE` credit cost

### Chat not saving / updating
**Check:**
1. Supabase connection: `NEXT_PUBLIC_SUPABASE_URL` and keys valid
2. RLS policies not blocking writes
3. Ghost mode not enabled (`GhostModeStore.isInGhostMode`)
4. Check browser console for Supabase errors
5. Multi-tenant: verify `organization_id` is correct

### MCP tools not working
**Check:**
1. `NEXT_PUBLIC_MCP_SYSTEM_ENABLED=true`
2. `GET /api/mcp/health` for connection status
3. MCP server endpoints reachable
4. Tool approval flow: check `NEXT_PUBLIC_MCP_YOLO_MODE_ENABLED`
5. Check `src/lib/mcp/smart-router.ts` logs

### Streaming response not showing
**Check:**
1. API route returning `streamText()` response correctly
2. `useChat()` hook configuration in `src/app/page.tsx`
3. Model ID valid for selected provider
4. API key valid for provider
5. Check browser Network tab for streaming response

### Auth issues (multi-tenant)
**Check:**
1. `NEXT_PUBLIC_AUTH_ENABLED=true`
2. Supabase Auth configured (dashboard → Authentication)
3. OAuth redirect URLs correct
4. RLS policies not blocking authenticated user
5. Session cookie present

### Performance issues
**Frontend:**
- Check Zustand selectors use `useShallow()` (not subscribing to full store)
- Verify `@tanstack/react-virtual` active on long lists
- Check for unnecessary re-renders (React DevTools)

**Backend:**
- Check HNSW index exists on `document_chunks.embedding`
- Verify `RAG_PERFORMANCE_MODE` setting
- Check for N+1 queries in API routes
- Monitor Supabase dashboard for slow queries

### Environment variable not taking effect
**Check:**
1. Variable in `.env.local` (not just `.env`)
2. Server restart required for non-NEXT_PUBLIC vars
3. For NEXT_PUBLIC vars: `POST /api/config/reload` or restart
4. Check `src/lib/env.ts` for default fallback values
5. Build-time vs runtime: NEXT_PUBLIC vars baked at build time

</common_issues>

<logging>

## Logging System

**SmartLogger** (`src/lib/logger.ts`):
- Deduplication: prevents duplicate logs within 30-second window (max 2 repeats)
- Methods: `startup()`, `env()`, `db()`, `error()`, `warn()`, `info()`, `debug()`, `mcp()`
- Some DEBUG/INFO logs only in development mode
- Cache cleanup at 100 entries

**DevLogger** (`src/lib/dev-logger.ts`):
- Development-only logging utility

**RAG Debug Mode:** Set `DEBUG_RAG=true` for verbose RAG pipeline logging

</logging>

<key_files_for_debugging>

## Key Files for Debugging

| Issue Area | Primary File | Secondary Files |
|------------|-------------|-----------------|
| Chat flow | `src/app/api/chat/route.ts` | `src/app/page.tsx` |
| RAG retrieval | `src/lib/enhanced-rag-retrieval.ts` | `optimized-search.ts`, `adaptive-retrieval.ts` |
| Document processing | `src/app/api/process-document/route.ts` | `src/lib/document-processor.ts` |
| Embeddings | `src/lib/document-processor.ts` | `createBatchEmbeddings()` |
| Vector search | `src/lib/supabase.ts` | `searchSimilarChunks()`, `match_document_chunks` RPC |
| MCP routing | `src/lib/mcp/smart-router.ts` | `universal-client.ts`, `query-classifier.ts` |
| Auth | `src/components/providers/auth-provider.tsx` | `src/lib/supabase/client.ts` |
| Stores | `src/lib/chat-store.ts` | `user-settings-store.ts`, `stores/` |
| Models | `src/lib/env.ts` | `scripts/init-env.js` |
| Config | `scripts/config-server.js` | `src/app/api/config/` |

</key_files_for_debugging>
