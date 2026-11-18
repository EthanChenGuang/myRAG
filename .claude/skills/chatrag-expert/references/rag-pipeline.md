<overview>
The RAG (Retrieval-Augmented Generation) pipeline handles document processing, embedding, storage, retrieval, and context injection. It uses OpenAI embeddings (1536-dim), Supabase pgvector with HNSW indexes, and multi-stage retrieval with reranking.
</overview>

<document_processing>

## Document Processing Flow

**Entry:** POST `/api/process-document` (multipart/form-data)

1. **Parse:** Upload to LlamaCloud API → poll for completion (max 40 attempts, adaptive backoff)
   - Config: `LLAMACLOUD_PARSING_MODE`, `LLAMACLOUD_PARSE_MODE` (default: `parse_page_with_agent`)
   - OCR: `LLAMACLOUD_HIGH_RES_OCR=true`, table extraction enabled
   - Output: text, metadata, images, chunks

2. **Chunk:** `src/lib/document-processor.ts`
   - **Standard mode:** Token-based chunking via `createTokenBasedChunks(text, maxTokens, overlapTokens)`
   - **Enhanced mode** (`NEXT_PUBLIC_RAG_MODE=enhanced`): Semantic chunking via `src/lib/semantic-chunker.ts`
   - LlamaCloud config: `LLAMACLOUD_CHUNK_SIZE=2500`, `LLAMACLOUD_CHUNK_OVERLAP=992`

3. **Embed:** `createBatchEmbeddings(chunks)` → OpenAI `text-embedding-3-small` (1536-dim)
   - Batch size: 10 chunks per batch
   - Uses `Promise.allSettled` for fault tolerance
   - Cost: ~$0.00002 per 1K tokens

4. **Store:** `storeDocument()` in `src/lib/supabase.ts`
   - Insert into `documents` table
   - Insert chunks into `document_chunks` with embeddings
   - Enhanced metadata: temporal entities, financial data, key terms, URL extraction

</document_processing>

<semantic_chunker>

## Semantic Chunker (`src/lib/semantic-chunker.ts`)

Used when `NEXT_PUBLIC_RAG_MODE=enhanced`.

```typescript
interface ChunkingConfig {
  targetTokens?: number;      // Default: 500
  maxOutputTokens?: number;   // Default: 800
  minTokens?: number;         // Default: 200
  overlapTokens?: number;     // Default: 100
  preserveStructure?: boolean; // Default: true
  adaptiveSize?: boolean;     // Default: true
  sentenceBoundaries?: boolean; // Default: true
  paragraphBoundaries?: boolean; // Default: true
  sectionBoundaries?: boolean; // Default: true
}

interface SemanticChunk {
  content: string;
  metadata: {
    section?: string;
    subsection?: string;
    position: number;
    tokens: number;
    type: 'header' | 'paragraph' | 'list' | 'table' | 'code' | 'mixed';
    density: number; // Information density (0-1)
    boundaries: { start, end: 'sentence' | 'paragraph' | 'section' };
  };
}
```

Features: Respects document structure (H1-H6), calculates info density, detects content types, adaptive sizing

</semantic_chunker>

<retrieval_pipeline>

## Retrieval Pipeline

### Standard Search (`src/lib/supabase.ts`)

```typescript
searchSimilarChunks(queryEmbedding, matchCount?, similarityThreshold?)
```
- RPC: `match_document_chunks` or `match_documents_by_workspace` (multi-tenant)
- Vector index: HNSW (m=64, ef_construction=200, cosine similarity)

### Optimized Search (`src/lib/optimized-search.ts`)

Pipeline: Cache check → query enhancement → vector search → reranking → cache result

```typescript
optimizedSearch(query, options?: OptimizedSearchOptions): Promise<ChunkWithScore[]>
```

Config env vars:
- `NEXT_PUBLIC_RAG_QUERY_ENHANCEMENT_ENABLED` (default: false)
- `NEXT_PUBLIC_RAG_RERANKING_ENABLED` (default: false)
- `NEXT_PUBLIC_RAG_RERANKING_STRATEGY` (default: hybrid)
- `NEXT_PUBLIC_RAG_CACHE_ENABLED` (default: true)
- `NEXT_PUBLIC_RAG_CACHE_TTL` (default: 3600)
- `NEXT_PUBLIC_RAG_PERFORMANCE_MODE` (default: balanced)

### Enhanced Retrieval (`src/lib/enhanced-rag-retrieval.ts`)

Multi-strategy retrieval with temporal/financial intelligence.

**Strategies:**
1. **Exact Match** - For temporal/financial precision (threshold: max(suggestedThreshold, 0.7))
2. **Multi-Stage** - Semantic → filter/boost → diversity check
3. **Temporal Boosted** - Time-sensitive query scoring
4. **Semantic Only** - Standard vector search
5. **Fallback** - Lower threshold (0.35) when no results

**Scoring:**
- Base similarity: 1.0 max
- Temporal boost: +0.2 (exact) or +0.1 (partial)
- Financial boost: +0.15 (has data) or +0.05 (context)
- High-value chunk: +0.05

### Adaptive Retrieval (`src/lib/adaptive-retrieval.ts`)

Multi-stage pipeline with confidence-based progression:

1. **Query Analysis** - Complexity, type, specificity, intent
2. **Stage 1** - Initial retrieval (semantic/hybrid/keyword based on query type)
3. **Stage 2** - Adaptive expansion if confidence low (extract terms, keyword search, hybrid)
4. **Stage 3** - Re-ranking with MMR if still low confidence

**Confidence calculation:** Top similarity (0.3) + avg top-5 (0.3) + drop-off (0.2) + term coverage (0.2)

</retrieval_pipeline>

<temporal_detection>

## Temporal Query Detection (`src/lib/temporal-query-detector.ts`)

```typescript
interface TemporalQueryContext {
  isTemporalQuery: boolean;
  isFinancialQuery: boolean;
  isSpecificDataQuery: boolean;
  timeframe: string | null;
  financialMetrics: string[];
  requiredPrecision: 'low' | 'medium' | 'high' | 'exact';
  suggestedThreshold: number;
  searchStrategy: 'semantic_only' | 'temporal_boost' | 'exact_match' | 'multi_stage';
}
```

**Pattern matching:**
- Temporal: Q1-Q4, years, periods (annual/yearly/monthly), date ranges
- Financial: revenue, profit, earnings, EBITDA, ROI, amounts
- Specific: "how much", "what was the", "exact", "number"

**Thresholds:** Exact=0.75, High=0.65, Medium=0.55, Low=0.45

</temporal_detection>

<reranking>

## Reranking Modules

### BM25 Scorer (`src/lib/bm25-scorer.ts`)
- k1=1.2 (term frequency saturation), b=0.75 (length normalization)
- IDF: `log((totalDocs - df + 0.5) / (df + 0.5) + 1)`
- `hybridScore(bm25Score, semanticSimilarity, bm25Weight?)` for combining

### MMR Scorer (`src/lib/mmr-scorer.ts`)
- Formula: `MMR = λ × Relevance - (1-λ) × MaxSimilarity`
- Default λ=0.7 (favor relevance over diversity)
- Similarity: Jaccard (word overlap)
- `applyMMRWithGrouping()` ensures diversity across documents

### Reranker Local (`src/lib/reranker-local.ts`)
- Strategies: `bm25`, `hybrid`, `keyword-boost`
- `rerankChunks(query, chunks, options)` - main entry point

</reranking>

<rag_config>

## RAG Configuration Summary

**Core settings (env vars):**
- `RAG_BEHAVIOR_MODE`: strict | balanced | flexible | bypass (default: strict)
- `RAG_INITIAL_MATCH_COUNT`: 60 (documents to retrieve)
- `RAG_SIMILARITY_THRESHOLD`: 0.45 (minimum similarity)
- `RAG_FINAL_RESULT_COUNT`: 25 (final results after reranking)
- `RAG_MULTI_PASS`: true (multi-pass retrieval)
- `RAG_ADAPTIVE_RETRIEVAL`: true
- `RAG_MMR_LAMBDA`: 0.85 (diversity weight)
- `RAG_PERFORMANCE_MODE`: fast | balanced | accurate

**System prompt:** `RAG_SYSTEM_PROMPT` must contain `{{context}}` placeholder
- Validated by `SystemPromptManager.validatePrompt()`
- Context injected via `SystemPromptManager.injectContext(prompt, context)`

**Query enhancement:** `src/lib/query-enhancer-local.ts`
- `shouldEnhanceQuery(query)` / `quickEnhanceQuery(query)` / `enhanceQuery(query)`
- Local synonym expansion, keyword extraction, query expansion

</rag_config>
