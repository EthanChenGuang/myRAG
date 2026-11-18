# Workflow: Discuss Architecture & Explain Flows

<required_reading>
Read the reference file most relevant to the user's question:

- Architecture questions → `references/architecture.md`
- API questions → `references/api-endpoints.md`
- Store/state questions → `references/stores.md`
- RAG questions → `references/rag-pipeline.md`
- Component questions → `references/components.md`
- Database questions → `references/database.md`
- Integration questions → `references/integrations.md`
- Model questions → `references/ai-models.md`
- Environment questions → `references/environment.md`

For flow-tracing questions, read multiple references as needed.
</required_reading>

<process>

## Step 1: Identify the Question Type

- **"How does X work?"** → Explain the system/flow from reference knowledge
- **"Where is X?"** → Point to specific files and line references
- **"What does X do?"** → Explain purpose, inputs/outputs, dependencies
- **"How are X and Y connected?"** → Trace the data flow between them
- **"Why is X designed this way?"** → Explain architectural decisions

## Step 2: Answer from Pre-Baked Knowledge

Use the reference files to answer immediately. Include:
- Specific file paths (relative from project root)
- TypeScript interfaces when relevant
- Data flow diagrams for pipeline questions
- Configuration details for setup questions

## Step 3: Verify Currency (if needed)

If the question is about something that may have changed recently:
1. Read the specific file(s) to confirm current state
2. Note any differences from pre-baked knowledge
3. Update the user with current information

## Step 4: Offer Deeper Exploration

After answering, offer:
- "Want me to read the actual file for current implementation details?"
- "Should I trace this flow through the code?"
- "Want me to check if anything has changed recently?"

</process>

<common_flows>

## Pre-Traced Flows

**Chat Message Flow:**
```
User types in ChatInput (src/components/ui/chat-input.tsx)
  → onSubmit handler in page.tsx
  → useChat() sends POST to /api/chat
  → Route handler:
    1. Check auth (multi-tenant) or allow (single-tenant)
    2. If RAG enabled: embed query → search document_chunks → rerank → build context
    3. Inject context into RAG_SYSTEM_PROMPT at {{context}}
    4. Call AI provider (OpenRouter/OpenAI) via streamText()
    5. Stream response with tool calls
  → useChat() receives stream events
  → ChatMessage renders incrementally via StreamingMarkdown
  → On completion: useChatStore.updateChat() saves to Supabase
```

**Document Upload Flow:**
```
User uploads via UnifiedUploadButton
  → POST /api/process-document (multipart)
  → Upload to LlamaCloud API
  → Poll for completion (max 40 attempts, adaptive backoff)
  → Extract text, metadata, images
  → If permanent:
    1. Chunk text (token-based or semantic)
    2. Generate embeddings via OpenAI (batch of 10)
    3. Insert document into 'documents' table
    4. Insert chunks into 'document_chunks' with embeddings
  → Return document info to UI
  → DocumentDashboard updates
```

**MCP Tool Execution Flow:**
```
User message → classifyQuery() in query-classifier.ts
  → If needsMcp:
    SmartMcpRouter.analyzeAndRoute(query)
    → Discover tools from all servers (UniversalMcpClient)
    → Select best match + fallbacks
    → Check approval (unless YOLO mode)
    → If approval needed: return 202, show in McpToolBox
    → If approved: executeTool() → display result
```

</common_flows>

<success_criteria>
- Question answered accurately from pre-baked knowledge
- Specific file paths included
- Type definitions shown when relevant
- Offered to read actual files for verification if appropriate
</success_criteria>
