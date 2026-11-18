# Workflow: Diagnose Issues & Debug Problems

<required_reading>
**Always read first:** `references/debugging.md`

Then based on issue area:
- Chat issues → `references/api-endpoints.md` (chat section), `references/stores.md`
- RAG issues → `references/rag-pipeline.md`, `references/database.md`
- MCP issues → `references/integrations.md` (MCP section)
- UI issues → `references/components.md`
- Auth issues → `references/architecture.md`, `references/database.md` (RLS)
- Config issues → `references/environment.md`, `references/ai-models.md`
</required_reading>

<process>

## Step 1: Classify the Issue

Ask the user (if not already clear):
- What's the symptom? (error message, unexpected behavior, missing feature)
- When does it happen? (always, sometimes, after a change)
- What area? (chat, documents, RAG, UI, config, auth)

## Step 2: Identify Likely Root Cause from Knowledge

Use pre-baked knowledge to narrow down:

**Error in chat streaming** → Check: API route (`src/app/api/chat/route.ts`), model config, API keys
**RAG not returning results** → Check: embeddings exist, similarity threshold, {{context}} placeholder
**Models missing from UI** → Check: 5-file sync, JSON syntax, localStorage stale
**MCP tools not working** → Check: MCP_SYSTEM_ENABLED, server health, approval flow
**Auth failures** → Check: Supabase config, RLS policies, session cookies
**Document upload fails** → Check: LLAMA_CLOUD_API_KEY, file size, timeout

## Step 3: Suggest Diagnostic Steps

Recommend specific commands and file checks:

```bash
# RAG issues
node scripts/rag/decode-rag-prompt.js    # Check {{context}} placeholder
node scripts/rag/check-rag-flow.js       # Test full pipeline
node scripts/rag/test-rag-system.js      # End-to-end test

# Config issues
npm run config                            # Open config dashboard
node scripts/config-ui/check-env.js       # Validate environment

# MCP issues
# GET /api/mcp/health                     # Check MCP connections

# Database
npm run db:setup                          # Reset/setup schema
```

## Step 4: Read Actual Code (if needed)

If pre-baked knowledge isn't enough:
1. Read the specific file where the issue likely lives
2. Check for recent changes that might have introduced the bug
3. Look at error handling patterns in that module

## Step 5: Provide Fix Guidance

Based on diagnosis:
- Point to exact file and function to modify
- Show the expected pattern (from reference knowledge)
- Warn about related files that might need updating (especially the 5-file sync)
- Suggest verification steps after the fix

</process>

<quick_diagnosis_table>

## Quick Diagnosis Reference

| Symptom | Likely Cause | Check First |
|---------|-------------|-------------|
| Models empty in UI | 5-file sync broken | JSON syntax in .env.local |
| RAG returns nothing | Missing embeddings or threshold too high | `node scripts/rag/check-rag-flow.js` |
| Chat not saving | Supabase error or ghost mode | Browser console, GhostModeStore |
| 504 on doc upload | LlamaCloud timeout | LLAMA_CLOUD_API_KEY, file size |
| MCP tools missing | MCP not enabled | NEXT_PUBLIC_MCP_SYSTEM_ENABLED |
| Auth redirect loop | OAuth URL mismatch | NEXT_PUBLIC_SITE_URL |
| Streaming broken | AI provider key invalid | Check API key for selected model |
| Icons missing on models | Boolean flags wrong | supportsReasoning/isFree in model def |
| Env var not working | Not reloaded | Restart server, check NEXT_PUBLIC prefix |
| Slow RAG queries | HNSW index missing | Check database indexes |

</quick_diagnosis_table>

<success_criteria>
- Issue classified and root cause identified (or narrowed to 2-3 possibilities)
- Specific diagnostic commands provided
- Exact files to check/modify identified
- Fix guidance includes verification steps
- Related files that might need updating mentioned
</success_criteria>
