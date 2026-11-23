# Architecture Research

**Domain:** Production RAG pipeline upgrade of an existing Next.js + Supabase multi-tenant chat product (myRAG)
**Researched:** 2026-11-22
**Confidence:** MEDIUM-HIGH (code-grounded findings are HIGH; external-service specifics are MEDIUM and flagged inline)

## Headline Decisions

1. **One module tree, `src/lib/rag/`, owns the whole pipeline.** The three entry points become thin adapters over `runRetrieval()`. Nothing outside `src/lib/rag/` talks to a vector backend, embedding provider, or reranker.
2. **Tenant isolation is a type, not a convention.** Every backend call requires a branded `TenantScope` that can only be minted by a function that verifies workspace membership. External stores have no RLS safety net, so this is the single most important design rule.
3. **Supabase stays the only writer; external vector stores are derived indexes.** Sync = DB-trigger outbox + idempotent worker that reads current Supabase state at processing time (never trusts a queued payload) + periodic reconciliation.
4. **Read and write paths are separate interfaces.** `RetrievalBackend` (search) is used by the pipeline; `VectorIndexWriter` (upsert/delete) is used only by the sync worker.
5. **Python sidecar is a stateless HTTP service for Docling, groundedness scoring, and the eval runner.** The evaluation harness calls the *TypeScript* pipeline through an internal trace endpoint; it never re-implements retrieval in Python.
6. **Processing profiles are data (a registry of config objects), not branches in code.** One `ingest()` function replaces the two ingestion paths; one `chunk-writer` is the only code allowed to write `document_chunks`.
7. **Two citation strategies behind one `Citation` type.** Claude Citations (native `search_result` blocks) and short-alias chunk markers (`[S3]`) for every other model. Citations and structured outputs cannot be combined on the Claude path (API returns 400), so structured outputs go to helper calls, not the streamed answer.
8. **Evaluation baseline first, then a behavior-preserving seam, then features.** The baseline is measured through the same endpoint that later measures every change.

## What the Code Actually Looks Like Today (constraints on the design)

| Finding | Evidence | Design consequence |
|---------|----------|--------------------|
| Context assembly is duplicated and inline | Chat route `src/app/api/chat/route.ts` ~L2169-2350 (relevance filter, group by doc, per-chunk Supabase lookups, image-doc skipping, URL collection); embed route `src/app/api/embed/chat/route.ts` L143-210 (copy with fewer features); voice route returns raw JSON | Context assembly must be extracted into `src/lib/rag/context/` with renderers per entry point. This is where "context assembly" stage lives. |
| N+1 DB calls per chunk during assembly | Chat route does `documents` + `document_chunks` selects per chunk (up to 3 round trips x 25 chunks) | Backends must return full payload (doc name, metadata, image_url, page) with the hit. Removes latency that would otherwise eat the new rerank/transform budget. |
| Tenant handling is inconsistent and partly unverified | Chat takes `data.organizationId` from the request body and passes it to `match_documents_by_workspace` (SECURITY DEFINER, `GRANT ... TO anon`) with no membership check. Embed passes no org/user at all. Voice passes a caller-supplied `userId` with `p_org_id: null`, and with no `userId` falls back to `match_document_chunks` via the admin client (global) | A shared pipeline forces one tenant-resolution path. For Weaviate/Qdrant (no RLS), this must verify membership before search. Note: fixing the legacy RPC grants is tracked separately in CONCERNS.md, but the *new* hybrid RPC must not copy that pattern. |
| Dead retrieval code | `retrieval-strategies.ts`, `optimized-search.ts`, `adaptive-retrieval.ts`, `query-enhancer-local.ts`, `reranker-adapter.ts` are imported but never called from any live path (chat imports `comprehensiveRetrieval`, `optimizedSearch`, `enhanceQueryWithReasoning`, `intelligentSearch` but only `enhancedRetrieveChunks` and `createEnhancedRAGPrompt` are invoked). `bm25-scorer.ts` and `mmr-scorer.ts` are reachable only through those dead modules. Only `reranker-local.ts` (`hybridRerank`) is live, via the voice route | Consolidation is mostly deletion plus re-homing 4 pieces of live logic (see "Consolidation Plan"). Verify with `tsc --noEmit` because `ignoreBuildErrors: true` hides broken imports. |
| `document_chunks` write sites | Inserts: `src/app/api/process-document/route.ts` L522, `src/app/api/ai-to-rag/route.ts` L164, `storeDocument` in `src/lib/supabase.ts` (used by `src/lib/document-processor.ts`, hence Nango/crawler/images). Deletes: `src/app/api/documents/[id]/route.ts` plus FK `ON DELETE CASCADE` from `documents` | App-level sync hooks would miss paths. DB triggers on `document_chunks` (which also fire on cascade deletes) are the only complete capture point. |
| Query embedding is hard-wired | `getQueryEmbedding` in `src/lib/document-processor.ts` L27-36 calls OpenAI directly; `vector(1536)` in both SQL files; RPC signatures hard-code `vector(1536)` | Needs an embedding-profile registry. Embedding provider code moves out of `document-processor.ts`. |
| Claude is reached only through OpenRouter | `src/app/api/chat/route.ts` L155 `createOpenRouter`; no `@ai-sdk/anthropic` or `@anthropic-ai/sdk` in `package.json`; model IDs like `anthropic/claude-sonnet-4...` | Citations needs a direct Anthropic path plus an OpenRouter-id-to-Anthropic-id mapping (belongs to the five-place model sync rule). |
| Serverless time cap | `vercel.json` sets `maxDuration: 60` for all API routes | Long jobs (Docling parse, outbox drain, re-embed) must be async/batched/resumable. |
| Streaming + tools in one `streamText` call | Chat route L3931 `streamText` with MCP tools, webSearch (Exa), approval flow | A Claude-direct generation path would bypass tools. See "Generation" for the restriction. |

## Target System Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ENTRY POINTS (thin adapters: auth, request parsing, response shaping)       │
│  chat/route.ts (SSE)      embed/chat/route.ts       internal/voice-rag/route.ts │
│        │ profile=chat            │ profile=embed             │ profile=voice    │
└────────┼─────────────────────────┼───────────────────────────┼─────────────────┘
         ▼                         ▼                           ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ src/lib/rag/  (single pipeline)                                             │
│  tenant-scope ─► query/ (analyze, history-rewrite, multi-query, HyDE,        │
│                   decompose)  ─► embed (EmbeddingProvider)                   │
│                 ─► backend.search (hybrid, filtered)  ─► fusion (RRF)        │
│                 ─► Reranker ─► context/ (assemble, order, compress, abstain) │
│                 ─► RetrievalResult {contextBlocks, sources, images, trace}   │
│  generation/ (prompt, CitationStrategy, groundedness hook)                   │
└───────┬───────────────┬───────────────────┬──────────────────┬──────────────┘
        │               │                   │                  │
        ▼               ▼                   ▼                  ▼
  ┌──────────┐   ┌────────────┐     ┌──────────────┐   ┌───────────────────┐
  │ pgvector │   │  Weaviate  │     │   Qdrant     │   │ Rerank APIs        │
  │ (Supabase│   │ (derived)  │     │  (derived)   │   │ Cohere / Voyage    │
  │ default) │   └─────▲──────┘     └──────▲───────┘   │ Embedding APIs     │
  └────▲─────┘         │ VectorIndexWriter │           │ OpenAI/Voyage/Qwen │
       │               └──────┬────────────┘           └───────────────────┘
       │                      │
┌──────┴──────────────────────┴──────────────────────────────────────────────┐
│ SUPABASE (source of truth: documents, document_chunks, chunk embeddings,    │
│ RLS, orgs)  ──trigger──► vector_sync_outbox ──► sync worker (drain route)   │
└──────▲─────────────────────────────────────────────────────────────────────┘
       │ single writer: src/lib/rag/ingest/chunk-writer.ts
┌──────┴─────────────────────────────────────────────────────────────────────┐
│ INGESTION  src/lib/rag/ingest/ingest() ◄── process-document route,          │
│  Nango adapter, scrapers, images, ai-to-rag                                 │
│  parse (LlamaParse | Docling via sidecar) → profile chunker → enrich →      │
│  dedupe/version → embed (active profile) → chunk-writer                     │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ HTTP, x-api-key
┌──────────────────────────────▼──────────────────────────────────────────────┐
│ rag-sidecar/ (Python, FastAPI)   /v1/parse (Docling)  /v1/groundedness      │
│  eval/ CLI+runner (DeepEval, Ragas) ──HTTP──► app /api/internal/rag/run     │
└─────────────────────────────────────────────────────────────────────────────┘
Existing siblings unchanged: voice-agent/ (calls voice-rag route), baileys-whatsapp/
```

## Component Boundaries

| Component | Responsibility | Talks To | Proposed Path |
|-----------|---------------|----------|---------------|
| Entry-point adapters | Auth, request parse, call `runRetrieval`, render result for their transport (SSE system prompt, embed prompt, voice JSON). No retrieval logic. | `rag/` public API only | `src/app/api/chat/route.ts`, `src/app/api/embed/chat/route.ts`, `src/app/api/internal/voice-rag/route.ts` |
| Public API + types | `runRetrieval()`, `TenantScope`, `Candidate`, `RetrievalResult`, `RagConfig` | everything below | `src/lib/rag/index.ts`, `types.ts` |
| Config resolver | Reads env (via `src/lib/env.ts`), applies per-profile presets (chat/embed/voice/eval), accepts overrides only from the internal eval endpoint | pipeline | `src/lib/rag/config.ts` |
| Tenant scope | `resolveTenantScope()` verifies membership using the user-scoped SSR client; `tenantKeyFor()`; branded type | Supabase (user-scoped client) | `src/lib/rag/tenant-scope.ts` |
| Pipeline orchestrator | Stage sequencing, per-stage timeout + degrade-to-skip, trace collection, fallback to pgvector | all stages | `src/lib/rag/pipeline.ts` |
| Query stages | Analyze (reuse `temporal-query-detector.ts`), history rewrite, multi-query, HyDE, decomposition, RRF fusion | small LLM, embedding provider | `src/lib/rag/query/*.ts` |
| Embedding providers | `EmbeddingProvider` + `EmbeddingProfile` registry (OpenAI, Voyage-4-large, hosted Qwen3-8B) | provider HTTP APIs | `src/lib/rag/providers/embeddings/*.ts` |
| Backends (read) | `RetrievalBackend`: hybrid search with mandatory tenant + metadata filters | Supabase RPC / Weaviate / Qdrant | `src/lib/rag/backends/{pgvector,weaviate,qdrant,registry,types}.ts` |
| Lexical normalizer | One shared tokenization for ingestion and query so BM25 behaves the same on all three backends (zh/en/it) | none (pure) | `src/lib/rag/backends/lexical-text.ts` |
| Rerankers | `Reranker`: Cohere, Voyage, local-hybrid (from `reranker-local.ts`), none | rerank APIs | `src/lib/rag/providers/rerankers/*.ts` |
| Context assembly | Dedupe, per-doc grouping, best-at-edges ordering, MMR (reuse `mmr-scorer.ts`), compression, token budget, abstain decision, source + `source_images` extraction | none (pure) + optional small LLM for compression | `src/lib/rag/context/{assemble,sources,abstain}.ts` |
| Generation helpers | Prompt build (`{{context}}` placeholder preserved), `CitationStrategy`, groundedness hook | Anthropic API, sidecar | `src/lib/rag/generation/*.ts` |
| Sidecar client | Typed HTTP client, shared-secret header, timeouts, circuit breaker | `rag-sidecar/` | `src/lib/rag/sidecar/client.ts` |
| Ingestion | `ingest()`, parsers, profiles, doc-type detection, dedupe/version, `chunk-writer` | sidecar, Supabase, embedding providers | `src/lib/rag/ingest/**` |
| Sync (write) | Outbox claim/drain, `VectorIndexWriter` per backend, reconcile | Supabase admin, Weaviate, Qdrant | `src/lib/rag/sync/*.ts` + `src/app/api/internal/vector-sync/{drain,reconcile}/route.ts` |
| Eval trace endpoint | Runs the real pipeline + non-streaming generation, returns a full trace; accepts config overrides for ablations | pipeline, generation | `src/app/api/internal/rag/run/route.ts` |
| Python sidecar | Docling parse, groundedness scoring, eval runner | HTTP only; calls app trace endpoint for eval | `rag-sidecar/` |

### Interface Sketches (TypeScript)

```typescript
// src/lib/rag/types.ts
declare const brand: unique symbol;
export type TenantScope = Readonly<{
  [brand]: true;
  kind: 'single' | 'personal' | 'org';
  userId: string | null;          // set for personal workspace
  organizationId: string | null;  // set for org-scoped (personal project or team)
  tenantKey: string;              // 's:default' | 'u:<uuid>' | 'o:<uuid>'
}>;
// Only tenant-scope.ts can construct one. Internal endpoints use serviceScope(apiKeyVerified, explicitScope).

export interface Candidate {
  chunkId: string; documentId: string; content: string;
  docName: string; score: number; scoreKind: 'dense' | 'lexical' | 'fused' | 'rerank';
  metadata: ChunkMetadata;   // doc_type, doc_date, lang, page_start, section, content_hash, image_url...
}

// src/lib/rag/backends/types.ts  (READ side)
export interface RetrievalBackend {
  readonly id: 'pgvector' | 'weaviate' | 'qdrant';
  search(req: {
    scope: TenantScope;                 // mandatory; adapter applies it in EVERY sub-query
    embeddingProfile: string;           // backend is bound to the profile it was indexed with
    denseVector: number[];
    lexicalQuery: string;               // already passed through lexical-text.ts
    filters: { dateRange?: [string, string]; docIds?: string[]; sources?: string[]; docTypes?: string[]; currentOnly: true };
    limit: number;
  }): Promise<Candidate[]>;             // returns full payload: no follow-up DB lookups
  health(): Promise<{ ok: boolean; syncLagMs?: number }>;
}

// src/lib/rag/sync/types.ts  (WRITE side, sync worker only)
export interface VectorIndexWriter {
  upsertChunks(items: IndexedChunk[]): Promise<void>;   // idempotent on chunkId
  deleteChunks(ids: string[]): Promise<void>;
  deleteDocument(documentId: string, scope: TenantScope): Promise<void>;
  deleteTenant(scope: TenantScope): Promise<void>;
  listIds(scope: TenantScope, page?: string): Promise<{ ids: string[]; next?: string }>; // for reconcile
}

// providers
export interface EmbeddingProvider {
  readonly id: string; readonly dims: number; readonly maxBatch: number;
  embedQuery(text: string): Promise<number[]>;          // query/document asymmetry (Qwen3 instruction, Voyage input_type)
  embedDocuments(texts: string[]): Promise<number[][]>;
}
export interface Reranker {
  readonly id: string; readonly scoreSemantics: 'calibrated' | 'relative';
  rerank(q: string, c: Candidate[], o: { topN: number; timeoutMs: number }): Promise<Array<Candidate & { rerankScore: number }>>;
}

// generation
export interface Citation { chunkId: string; documentId: string; docName: string; page?: number; quote?: string; span?: [number, number] }
export interface CitationStrategy {
  readonly id: 'claude-citations' | 'chunk-alias';
  prepare(blocks: ContextBlock[], model: string): PreparedGeneration;     // prompt/context/provider options
  extract(output: GenerationOutput, blocks: ContextBlock[]): Citation[];  // validates every ref against blocks
}
```

## Recommended Project Structure

```
src/lib/rag/
├── index.ts, types.ts, config.ts, pipeline.ts, tenant-scope.ts
├── query/            analyze.ts rewrite-history.ts multi-query.ts hyde.ts decompose.ts fusion.ts
├── providers/
│   ├── embeddings/   types.ts registry.ts openai.ts voyage.ts qwen-hosted.ts
│   ├── rerankers/    types.ts registry.ts cohere.ts voyage.ts local-hybrid.ts none.ts
│   └── llm-lite.ts   small model for query transforms and doc-type detection (structured output)
├── backends/         types.ts registry.ts pgvector.ts weaviate.ts qdrant.ts lexical-text.ts
├── context/          assemble.ts sources.ts abstain.ts render-prompt.ts render-voice.ts
├── generation/       prompt.ts groundedness.ts citations/{claude-citations,chunk-alias,types}.ts
├── ingest/           ingest.ts chunk-writer.ts chunk-schema.ts detect-doc-type.ts dedupe.ts
│   ├── parsers/      types.ts llamaparse.ts docling.ts fallback.ts
│   ├── chunkers/     table-aware.ts semantic.ts (wraps semantic-chunker.ts) token.ts
│   └── profiles/     registry.ts default.ts financial.ts legal.ts technical.ts scanned.ts
├── sync/             outbox.ts worker.ts reconcile.ts mappers.ts writers/{weaviate,qdrant}.ts
└── sidecar/client.ts
src/app/api/internal/rag/run/route.ts
src/app/api/internal/vector-sync/{drain,reconcile}/route.ts
rag-sidecar/
├── Dockerfile, fly.toml, pyproject.toml          # mirrors voice-agent/ and baileys-whatsapp/ deploy style
├── app/ main.py auth.py routers/{parse,groundedness,eval}.py
├── app/parsers/docling_service.py   app/groundedness/{vectara_hhem,hhem_open}.py
├── eval/ runner.py metrics_retrieval.py metrics_generation.py golden_loader.py
└── tests/
supabase/migrations or additions to single-/multi-tenant-setup.sql   (see "Schema changes")
```

Structure rationale: `src/lib/` already uses subfolders for domains (`mcp/`, `nango/`, `whatsapp/`), so `rag/` fits the convention. Read/write interfaces live in different folders so a route can never accidentally import a writer. `ingest/` and `sync/` are separate because ingestion writes only to Supabase, and sync reads only from Supabase.

## Data Flows

### Retrieval (all three entry points)

```
Entry adapter ──► resolveTenantScope(request)           [verifies org membership; mints TenantScope]
              ──► runRetrieval({query, history, scope, profile, filters})
                    1 analyze: temporal-query-detector → filters.dateRange, hints (precision, intent)
                    2 transform (flagged, budgeted): history-rewrite + multi-query + sub-questions
                      in ONE structured-output small-LLM call; HyDE as optional extra vector
                    3 embed: provider bound to the index's profile (embedQuery)
                    4 backend.search per sub-query (parallel): hybrid, filtered, limit = N_candidates
                    5 fuse sub-query lists with RRF → candidate pool (dedupe by chunkId/content_hash)
                    6 rerank pool (timeout → keep fused order), top N_final
                    7 assemble: order (best at edges), MMR/diversity, compress, token budget
                    8 abstain decision (rerank-score threshold if reranker is calibrated; else legacy similarity rule)
              ◄── RetrievalResult {contextBlocks[chunkId, alias, docName, page, text], sources, sourceImages, abstain, trace[]}
Entry adapter renders: chat → `{{context}}` string or search_result blocks; embed → context string; voice → {results, source_images} (contract with voice-agent/src/rag_client.ts unchanged)
```

Each stage records `{stage, ms, inCount, outCount, skipped, reason}` into `trace`. A stage failure never fails the request: transform timeout falls back to the raw query, reranker failure keeps fused order, an unhealthy or lagging external backend falls back to pgvector.

### Ingestion (one path)

```
process-document route | Nango sync-manager → document-adapter | scrapers | images | ai-to-rag
   └─► ingest(file|text, {scope, docType?, source, sourceFileId?})
         1 detect doc type (rule + small-LLM structured output); user override wins
         2 profile = registry[docType]
         3 parse: profile.parser preference → LlamaParse | Docling(sidecar job API); failure/unconfigured → fallback chain
         4 chunk: Docling HybridChunker output if available, else profile TS chunker (table-aware repeats header rows)
         5 enrich: chunk-schema fields (source, doc_type, doc_date, version, content_hash, page/section, lang, lexical_text)
         6 dedupe + version: document content_hash match → skip; same source identity + new hash → supersede (is_current=false on old, in one transaction)
         7 embed with the ACTIVE embedding profile (+ any shadow profile being backfilled)
         8 chunk-writer (single writer) → document_chunks + embeddings via transactional RPC
         9 (DB triggers enqueue vector_sync_outbox rows automatically)
        10 if external backend active: bounded synchronous drain for this document before reporting "ready"
```

Existing `process-document/route.ts` (845 lines, its own LlamaParse + chunking + inserts) and `document-processor.ts` become thin wrappers over `ingest()`. The Nango adapter keeps calling `processDocument` (same signature) so the connector code is untouched.

### Sync (Supabase → Weaviate/Qdrant)

```
INSERT/UPDATE/DELETE on document_chunks (incl. FK cascade deletes), UPDATE of documents (org/user/is_current/metadata), embedding rows
   └─ trigger ─► INSERT vector_sync_outbox(op, chunk_id|document_id, tenant_key, profile_id, enqueued_at)   [notification only, no payload]
Drain trigger: pg_cron+pg_net or Vercel cron every minute, plus on-demand kick after ingestion
   └─► POST /api/internal/vector-sync/drain (x-api-key)
         claim batch: SELECT ... FOR UPDATE SKIP LOCKED (RPC claim_vector_sync_batch)
         coalesce by chunk_id; for each: READ CURRENT ROW from Supabase
             row exists  → upsert to writer (payload carries tenant_key + filter fields); same vectors copied from Supabase (no re-embedding per backend)
             row missing → delete from writer
         mark processed / attempts++ / last_error; dead-letter after N attempts (alert via log + health endpoint)
Reconcile (daily + after bulk ops): per tenant compare count + id set (+ max updated_at) between Supabase and backend; enqueue repairs.
Tenant removal (org deleted/user deleted): deleteTenant() (Weaviate: drop tenant; Qdrant: delete by tenant_key filter).
```

Why notification-only outbox: the worker always applies the latest state, so out-of-order or duplicate events cannot write stale data, and the payload cannot go out of sync with the row. Idempotency comes for free because chunk UUIDs are valid point/object IDs in both stores.

### Generation

```
RetrievalResult ──► if abstain && ragMode=strict && !webSearch → existing "information not available" response (unchanged behavior)
                ──► CitationStrategy.select(model):
                      Claude model + ANTHROPIC_API_KEY + flag + turn eligible → ClaudeCitationsStrategy
                      else → ChunkAliasStrategy
                ──► stream (createUIMessageStream) text + citation parts + source_images + sources (existing parts preserved)
                ──► after text completes: groundedness (sidecar, ≤ timeout) → `data-groundedness` part → persisted in message metadata by the existing client mirror; also logged
```

### Evaluation

```
rag-sidecar/eval/runner.py (CLI in CI; optional HTTP wrapper)
   for each golden item ─► POST app /api/internal/rag/run {question, history, overrides?}   (x-api-key, eval workspace scope)
        ◄─ trace: rewritten queries, candidates (chunkId + text), reranked, context, answer, citations, timings
   retrieval metrics (Recall@k, MRR) computed locally by evidence matching
   generation metrics (Faithfulness, Answer Relevance, Context Recall, refusal rate on unanswerable) via Ragas/DeepEval
   results JSON + compare-to-baseline → CI gate
```

## Patterns to Follow

### Pattern 1: Branded `TenantScope` required by every backend call
**What:** Backends and writers accept only `TenantScope`. The adapters add the tenant predicate themselves (pgvector WHERE, Qdrant filter on the `is_tenant` keyword index, Weaviate tenant name). Callers cannot forget it.
**When:** Always. Defense in depth: Qdrant gets the filter in every `prefetch` AND the top-level query; Weaviate gets the tenant on the collection handle.
**Trade-offs:** Slightly more ceremony at call sites; removes the "forgot the filter" failure class.
**Tenant model:** `tenantKey` is `u:<uuid>` for flat personal workspace (documents with `organization_id IS NULL`), `o:<uuid>` for any org-scoped document (personal project and team both belong to an org), `s:default` for single-tenant. This reproduces `match_documents_by_workspace` semantics exactly. Qdrant: one collection per embedding profile, payload `tenant_key` with `is_tenant: true`. Weaviate: multi-tenancy enabled, one tenant per `tenantKey` (name rule 4-64 chars `[A-Za-z0-9_-]`; `o_<uuid>` is 38 chars, valid), `autoTenantCreation` on.

### Pattern 2: Stage runner with budget, flag, and degrade
**What:** Each stage is `{name, enabled(cfg), timeoutMs, run, onFail: 'skip'|'fallback'|'throw'}`. The orchestrator is ~150 lines and owns tracing.
**When:** Every optional stage (transforms, HyDE, rerank, compression). Retrieval core (embed + search) is `throw` only after the pgvector fallback is exhausted.
**Trade-offs:** More indirection than a straight-line function, but it makes "each capability has a switch and a latency budget" (a requirement) structural rather than ad hoc.

```typescript
const stages: Stage[] = [
  analyze, transform /*skip on timeout*/, embed, search /*fallback: pgvector*/,
  fuse, rerank /*skip on timeout*/, assemble, decideAbstain,
];
```

### Pattern 3: Registry + env switch (matches `USE_REPLICATE_PROVIDER` precedent)
**What:** `RAG_EMBEDDING_PROFILE`, `RAG_RERANKER`, `RAG_BACKEND` select entries from registries; invalid or unconfigured values log once and fall back to the legacy default (OpenAI 1536 / local-hybrid / pgvector). Every new variable lands in `.env.local`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, and Config UI in the same change.
**When:** All three provider families. Per-request overrides exist only on the internal eval endpoint.
**Trade-offs:** None significant; this is what lets the eval runner A/B without redeploys.

### Pattern 4: Embedding profiles stored side by side (rollbackable re-embed)
**What:** An embedding profile = `{id, provider, model, dims, storage: 'vector'|'halfvec', index}`. Embeddings for a profile live in their own table/column (`chunk_embeddings_<profile>` keyed by `chunk_id`), and Weaviate/Qdrant get one collection per profile. Re-embedding fills a *shadow* profile; switching = flipping the active-profile pointer; rollback = flipping back. `reprocess-documents.js` is extended into a resumable job (cursor + batch size + per-chunk `embedded_at`).
**When:** Any embedding change. 
**Why:** The project constraint that pgvector HNSW cannot index >2000-dim `vector` means Qwen3-Embedding-8B / Voyage at full width must use `halfvec` (up to 4000 dims) or truncated dims. A single fixed `vector(1536)` column cannot hold two profiles, and in-place overwrite has no rollback. The query side must use the same profile as the index it hits (`embedQuery` with the matching provider), so the backend is bound to a profile.

### Pattern 5: Shared lexical normalization
**What:** Postgres FTS (`simple` config), Weaviate BM25, and Qdrant full-text/sparse all behave differently on Chinese. Do tokenization once in TypeScript (`Intl.Segmenter` for zh word segmentation, whitespace + lowercase/diacritic fold for en/it) and store the result as `lexical_text` per chunk; apply the same function to the query. Each backend indexes `lexical_text` with its simplest whitespace-style tokenizer.
**When:** All hybrid retrieval. 
**Trade-offs:** No per-engine language analyzers (no stemming gain), but identical lexical behavior across all three backends, which makes the backend comparison fair and avoids installing Chinese FTS extensions. MEDIUM confidence; validate Recall on the zh golden items in the hybrid phase and add stemming for en/it only if eval shows it matters.

### Pattern 6: Processing profiles as data
**What:** `ProcessingProfile = { docType, parserPreference[], chunker:{kind,maxTokens,overlap,repeatTableHeader}, metadataExtractors[], embeddingTextTemplate, ocr, retrievalHints }`. Registry keyed by `financial | legal | technical | scanned | default`. `ingest()` looks up the profile; nothing branches on doc type elsewhere. The selected type is stored in a real `doc_type` column and in chunk payloads so retrieval can filter and (later) route by type.
**When:** Always. A user override on upload wins over auto-detection; detection result and confidence are stored.

### Pattern 7: Eval endpoint is the seam, evidence is the label
**What:** The eval harness calls `POST /api/internal/rag/run`. Golden labels reference documents and evidence quotes (filename + quote text, optional page), not chunk IDs. A retrieval hit means a returned chunk overlaps the evidence span (normalized containment above a threshold), with document-level hit as a secondary metric.
**Why:** Re-chunking (Docling vs LlamaParse, profile changes) changes chunk IDs; ID-based labels would make every ingestion change look like a recall regression.

## Citations: Claude Citations vs chunk aliases

| Aspect | Claude Citations | Chunk alias (all other models) |
|--------|------------------|--------------------------------|
| Context delivery | Each chunk is a `search_result` block `{source: chunkId, title: docName, content:[{type:'text', text}], citations:{enabled:true}}` placed in the final user message (or a tool result). `citations.enabled` must be identical on all blocks in a request. | Context text with short aliases: `[S1] <docName, p.3>\n<text>`. Aliases (S1..Sn) map to chunk IDs server-side; UUIDs are never shown to the model (models mis-copy long IDs). |
| Output | Native citation objects on text blocks (`search_result_location` with block indices, cited text), streamed as `citations_delta` | Model emits `[S2]` markers inline; server parses and validates every alias against the context map, drops unknown ones |
| Unified type | Both normalize to `Citation {chunkId, documentId, docName, page?, quote?, span?}`; UI and persistence see one shape |
| Structured outputs | **Incompatible**: enabling citations plus `output_config.format` returns HTTP 400 | Possible but would break token streaming of the answer |
| `{{context}}` rule | Keep the `RAG_SYSTEM_PROMPT` with `{{context}}` intact; in Claude mode substitute a one-line stub ("sources are provided as search results in the user message") so the placeholder contract holds | Normal substitution |

Decisions:
- **Structured outputs go to helper calls**, not the streamed answer: query-transform JSON, doc-type detection, citation verification pass, golden-set drafting. This satisfies "use structured outputs where possible" without breaking streaming or Claude Citations.
- **Claude path needs a direct Anthropic call.** OpenRouter does not carry native citations. Two options in order of preference: (a) `@ai-sdk/anthropic` with `search_result` input if the installed `ai@6` provider supports it (the provider docs show citation output via `part.citations` and `providerMetadata.anthropic.citations`, but `search_result` *input* support was not confirmed; a community post references an open PR), which keeps `streamText`, MCP tools, and the approval flow; (b) `@anthropic-ai/sdk` streaming bridged into the existing `createUIMessageStream` writer. Option (b) loses the tool loop, so restrict it to turns with no MCP tools and webSearch off until proven otherwise. **This is the top research flag for the generation phase.**
- **Eligibility is per turn, not per conversation:** `isClaudeModel(modelId)` + key present + flag + turn has no tool plan. Otherwise fall back to aliases. Model ID mapping (OpenRouter `anthropic/claude-...` to Anthropic API ID) is added to the model registry and covered by the five-location sync rule.
- **Strict-mode abstention is unaffected:** the abstain decision happens before generation, so "information not available" remains the same code path.

### Groundedness (HHEM) placement
Runs after generation, never blocks tokens: the sidecar is called once the answer text is complete, with a short timeout; result becomes a `data-groundedness` UI part (score, label, model id) that the existing client mirror persists in message metadata and the UI renders as "may be unreliable". Not enforced this milestone. **Finding that changes the plan:** HHEM-2.3 is available only through Vectara's API (not open weights); the open model, HHEM-2.1-Open, is English-only. Vendor docs claim 11 languages for 2.3 but do not list them, so Italian and Chinese support is unconfirmed. Implement `GroundednessScorer` as a provider interface in the sidecar (`vectara_hhem` API implementation first; optional `hhem_open` for English; LLM-judge fallback) and validate on the zh/it golden items before showing the warning to users. Note the data egress: answers and context go to a third-party API.

## Python Sidecar Design

- **Transport:** HTTP+JSON, `x-api-key` shared secret (precedent: `MYRAG_INTERNAL_API_KEY` on voice-rag, `API_KEY` on baileys). Constant-time compare. Env: `RAG_SIDECAR_URL`, `RAG_SIDECAR_API_KEY`. Health endpoint unauthenticated and content-free.
- **Deploy:** own directory + `Dockerfile` + `fly.toml`, same as `voice-agent/` (Fly.io). Keep one machine warm (Docling model load). Heavy parse jobs run in a worker pool so `/health` and groundedness stay responsive.
- **Parse contract (async job, mirrors the existing LlamaParse upload-then-poll shape):** `POST /v1/parse/jobs` (file + `{docType, ocr, chunker}`) → `{jobId}`; `GET /v1/parse/jobs/{id}` → `{status, result?}` where `result = {markdown, chunks:[{text, contextualizedText, headings[], pages[], isTable}], pageCount, lang, parser:'docling', warnings[]}`. `HybridChunker` repeats table headers by default (`repeat_table_header=True`). Async is mandatory: a scanned 100-page PDF on CPU can exceed the 60 s Vercel cap, so `ingest()` must be resumable via the document's processing status (the Config UI already has a status monitor).
- **Failure behavior:** `parsers/fallback.ts` implements the chain: configured parser → other parser → plain-text extraction. LlamaParse failing or unconfigured routes to Docling; sidecar down routes to LlamaParse; both down marks the document failed with a retryable status. Circuit breaker in `sidecar/client.ts`.
- **Eval:** CLI-first. The runner is a Python package in the sidecar repo directory, executed directly in GitHub Actions against a staging app. The HTTP `eval` router is a thin optional wrapper (manual trigger from Config UI). The deployed sidecar still ships in phase 1 (auth, Dockerfile, health) so later Docling/HHEM work plugs in.
- **Privacy:** golden sets drafted from real documents contain real content. Do not commit them (AGENTS.md rule 7): keep them out of git or in a private path, and give CI a synthetic fixture corpus ingested into a dedicated eval workspace through the normal `ingest()` path.

## Schema changes (additions to both `single-tenant-setup.sql` and `multi-tenant-setup.sql`, kept RLS-aligned)

| Change | Purpose |
|--------|---------|
| `documents`: `doc_type`, `doc_type_source` (auto/user), `content_hash`, `version`, `supersedes_id`, `is_current`, `processing_status` (if not present) | Doc-type profiles, dedupe, versioning, resumable ingestion |
| `document_chunks`: promoted columns `doc_type`, `doc_date`, `lang`, `source`, `page_start`, `section`, `content_hash`, `is_current`, `lexical_text` (GIN `tsvector` over it) | Hot filters and hybrid retrieval; rest stays in `metadata` JSONB |
| `chunk_embeddings_<profile>` (halfvec where dims > 2000) + `embedding_profiles` table with active pointer | Side-by-side, rollbackable embeddings |
| `vector_sync_outbox` + triggers + `claim_vector_sync_batch()` | Sync |
| `hybrid_search_chunks(...)` RPC (dense + `tsvector` fused by RRF, filtered) | pgvector hybrid; **granted to `service_role` only**, tenant passed from server-verified `TenantScope`, `SECURITY INVOKER` or explicit checks; do not replicate the `GRANT ... TO anon` pattern of `match_documents_by_workspace` |
| `replace_document_chunks(doc_id, chunks jsonb)` RPC | Transactional version replace so outbox events stay coherent |

## Consolidation Plan (retire, don't add a fifth path)

| Existing module | Disposition | Where the live logic goes |
|-----------------|-------------|---------------------------|
| `src/lib/enhanced-rag-retrieval.ts` | **Re-home, then delete.** Strategy switch (exact/multi-stage/temporal/semantic) and fallback-threshold retry become the `legacy` pipeline strategy in phase 2 (behavior-preserving); temporal/financial boosts become `context`-stage features applied only when no reranker is active; its `analyzeQuery` output feeds `filters.dateRange` | `src/lib/rag/pipeline.ts`, `query/analyze.ts` |
| `src/lib/temporal-query-detector.ts`, `temporal-metadata-extractor.ts` | **Keep**, move behind `query/analyze.ts` and ingest metadata extractors | `rag/query/`, `rag/ingest/profiles/*` |
| `src/lib/reranker-local.ts` (`hybridRerank`, live in voice) | **Keep as a provider**: `LocalHybridReranker`. It is the default for `voice` and the `RAG_RERANKER=local` option | `rag/providers/rerankers/local-hybrid.ts` |
| `src/lib/bm25-scorer.ts` | **Keep only if `local-hybrid.ts` needs it** (in-process lexical score for reranking); otherwise delete | same |
| `src/lib/mmr-scorer.ts` | **Keep**, wire as optional diversity step in `context/assemble.ts` behind a flag; eval decides if it stays | `rag/context/assemble.ts` |
| `src/lib/reranker-adapter.ts` | **Delete.** Wraps the local reranker in the AI SDK `RerankingModel` shape (and the voice route already bypasses it because of an index bug). The new `Reranker` interface carries chunk IDs and raw scores, which abstention needs | none |
| `src/lib/retrieval-strategies.ts` (`comprehensiveRetrieval`, `aggregateChunks`) | **Delete.** Never called. If the golden set shows "list/aggregate all X" questions failing, reintroduce as an `exhaustive` search mode in the pipeline, not as a module | `rag/pipeline.ts` (conditional) |
| `src/lib/optimized-search.ts`, `adaptive-retrieval.ts` | **Delete** (imported by chat route, never invoked) | none |
| `src/lib/query-enhancer-local.ts` | **Delete** unless eval shows zero-latency synonym expansion helps the voice profile; otherwise absorbed into `query/analyze.ts` | optional |
| `src/lib/thinking-rag-enhancer.ts` | **Split.** `createEnhancedRAGPrompt` (live in chat + embed) moves to `generation/prompt.ts`; `intelligentSearch` / `enhanceQueryWithReasoning` (never called) deleted | `rag/generation/prompt.ts` |
| `src/lib/supabase.ts` `searchSimilarChunks` + `src/lib/document-processor.ts` `getQueryEmbedding` | **Delete / move**: embedding code to `providers/embeddings/openai.ts`; `searchSimilarChunks` replaced by the pgvector backend (verify no live callers first) | `rag/backends/pgvector.ts` |
| Inline assembly in chat route (L2169-2350), embed route (L143-210), voice-rag post-processing | **Extract** into `context/`. Voice's hard-coded person/logo image heuristics (names baked into the route) move into a `voice`-profile-only step `context/sources.ts` until eval shows they are unnecessary, then are removed; they also violate the no-customer-data rule | `rag/context/*` |

Mechanics: do the deletions in the same phase as the seam (phase 2), *before* new features, in a separate commit from the extraction so reverts are clean. Remove the dead imports from `chat/route.ts` (L10, L11, part of L17). Run `npx tsc --noEmit` (build ignores type errors) and grep for remaining references.

## Anti-Patterns

### Anti-Pattern 1: Backend adapters that accept a raw `organizationId` string
**What people do:** Pass `orgId` from the request body into whichever store is configured (current chat route does this).
**Why it's wrong:** With pgvector the RLS-bypassing RPC already trusts it; with Weaviate/Qdrant there is no second line of defense. A forged ID reads another tenant.
**Do this instead:** `resolveTenantScope()` verifies membership; adapters accept only the branded `TenantScope`.

### Anti-Pattern 2: Dual-writing to external stores from ingestion code
**What people do:** After inserting into Supabase, also call Weaviate/Qdrant from the same route.
**Why it's wrong:** Partial failures leave stores diverged; five write sites would each need the hook; cascade deletes are missed.
**Do this instead:** Trigger-fed outbox, worker re-reads current state, reconcile job heals drift.

### Anti-Pattern 3: Re-embedding in place
**What people do:** `UPDATE document_chunks SET embedding = new` across the corpus.
**Why it's wrong:** No rollback, and mixed old/new vectors during the run make retrieval garbage mid-migration.
**Do this instead:** Shadow profile, resumable backfill, pointer flip, keep old profile until the eval gate passes.

### Anti-Pattern 4: Sidecar owns retrieval logic
**What people do:** Re-implement retrieval in Python for evaluation convenience.
**Why it's wrong:** The evaluated system diverges from the shipped one; metrics stop meaning anything.
**Do this instead:** Eval calls the real TS pipeline; Python only scores.

### Anti-Pattern 5: Another parallel retrieval module
**What people do:** Add `hybrid-retrieval.ts` next to the six unused ones.
**Why it's wrong:** It is exactly the duplication the codebase map calls out.
**Do this instead:** Everything lives under `src/lib/rag/`; old modules are deleted in phase 2.

### Anti-Pattern 6: Different retrieval for voice
**What people do:** Keep voice on its own route logic because it is latency-sensitive.
**Why it's wrong:** Voice then never benefits from backend/rerank work and drifts from eval.
**Do this instead:** Same pipeline, `voice` profile: transforms off (the voice agent already rewrites queries), local or time-boxed reranker, tight stage timeouts.

### Anti-Pattern 7: ID-based golden labels
Covered under Pattern 7.

## Latency Budgets (starting values to be replaced with measured p95 from the baseline)

| Profile | Transforms | Embed | Search | Rerank | Pre-first-token overhead target |
|---------|-----------|-------|--------|--------|---------------------------------|
| chat | one combined small-LLM call, <= 800 ms | <= 200 ms | <= 400 ms | <= 600 ms (skip on timeout) | <= ~2 s |
| embed | rewrite only if history exists | same | same | same, shorter timeout | <= ~1.5 s |
| voice | off | <= 200 ms | <= 300 ms | local or <= 250 ms | <= ~800 ms total |
| eval | all on, no timeouts, deterministic | | | | n/a |

LOW-MEDIUM confidence: these are engineering targets, not measurements. Phase 1 baseline should record current per-stage p50/p95 first.

## Scaling Considerations

| Concern | Small (single tenant, ≤100k chunks) | Mid (multi-tenant, ~1M chunks) | Large |
|---------|-------------------------------------|--------------------------------|-------|
| Vector search | pgvector HNSW is sufficient; keep default | pgvector with promoted filter columns and per-tenant filtering still OK; watch HNSW build time on 2000+ dims (halfvec) | Weaviate/Qdrant justified; Qdrant shared collection with `is_tenant` index; Weaviate tenant-per-shard |
| BM25 statistics | Postgres FTS per query | Same | Qdrant sparse/BM25 IDF is shared across tenants by default (the `idf` search parameter, v1.19+, scopes it); otherwise one tenant's corpus skews another's ranking and leaks term-frequency signal |
| Sync | Cron drain every minute is fine | Batch size + parallel workers with `SKIP LOCKED` | Move worker to a long-running Node process (Vercel's 60 s cap) |
| Re-embedding | Script run | Shadow profile, rate-limited by provider | Provider batch APIs |
| Sidecar | One warm machine | Autoscale parse workers separately from groundedness | Separate Docling service |

First bottleneck will be the 60 s serverless cap on drain/re-embed/parse, not vector search.

## Integration Points

### External Services

| Service | Integration | Notes |
|---------|-------------|-------|
| Weaviate | `VectorIndexWriter` + `RetrievalBackend` via official TS client | Every operation names a tenant; tenant names constrained to 4-64 chars `[A-Za-z0-9_-]`. Hybrid-within-tenant not stated on the multi-tenancy page; verify in backend phase |
| Qdrant | Same, Query API `prefetch` (dense + sparse/text) with `rrf` fusion | Tenant keyword index with `is_tenant: true` (v1.11+); isolation depends on every query carrying the filter; confirm per-prefetch `filter` support in the backend phase |
| Cohere / Voyage rerank, Voyage + hosted Qwen3 embeddings | Direct `fetch` implementations behind own interfaces | Own interface over AI SDK `rerank` because we need chunk IDs and raw scores for abstention |
| Anthropic API | `@ai-sdk/anthropic` or `@anthropic-ai/sdk` (new dependency, new `ANTHROPIC_API_KEY`) | See Citations section |
| Vectara HHEM-2.3 | Called from the sidecar | API-only; language coverage for zh/it unverified |
| Docling | Library inside the sidecar | `repeat_table_header` default true |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Entry routes ↔ `rag/` | Direct function calls | Only `index.ts` exported; lint rule or path restriction against importing `rag/backends/*` elsewhere |
| `rag/` ↔ Supabase | pgvector backend via RPC; ingest via `chunk-writer` | User-scoped client for verification, admin client only in writer/sync |
| `rag/` ↔ sidecar | HTTP + shared secret | Always optional: pipeline works with sidecar down (groundedness skipped, Docling falls back) |
| voice-agent ↔ app | Unchanged `POST /api/internal/voice-rag` contract (`results`, `source_images`) | Adapter preserves shape; add the tenant fields to the request rather than trusting a bare `userId` |
| Eval runner ↔ app | `POST /api/internal/rag/run` | Overrides accepted only here; evaluates in a dedicated eval workspace |
| Config UI ↔ env | Existing config-sync rule | Each phase adds its variables in all five places; final phase only sets defaults |

## Suggested Build Order

Dependencies drive the order: evaluation first (everything is judged against it), then the seam (everything plugs into it), then data (chunk shape and metadata that retrieval filters and sync payloads depend on), then retrieval quality, then the riskiest/costliest items last.

1. **Evaluation baseline + sidecar skeleton.** `rag-sidecar/` (FastAPI, auth, Dockerfile, health), golden set tooling (evidence-based labels), runner, `POST /api/internal/rag/run` wrapping *current* code (`enhancedRetrieveChunks` + current prompt builder + non-streaming generate), baseline run, CI workflow, fix/remove `npm run test-rag`. Depends on nothing. Caveat: the chat route filters chunks after retrieval (similarity > 0.65 or name match), so the baseline endpoint must replicate that filter or the baseline will not describe production; record this explicitly.
2. **Pipeline seam + consolidation + tenant scope (behavior-preserving).** Create `src/lib/rag/` with a `legacy` strategy, extract context assembly, add `TenantScope` + membership verification, route all three entry points through `runRetrieval`, delete dead modules, add `RAG_PIPELINE=legacy|v2` switch. Gate: re-run the baseline through the new seam; metrics within noise of phase 1. Depends on 1. This also closes the unverified-`organizationId` hole for the new code path.
3. **Ingestion unification + metadata contract + processing profiles + Docling.** Schema additions, `ingest()`, `chunk-writer`, profile registry, upload UI doc-type selector (auto-detect, user override), content-hash dedupe and versioning, Docling parser via sidecar with fallback chain. Depends on 1 (sidecar, evidence-based labels survive re-chunking) and 2 (single place to read the new metadata). Must precede hybrid retrieval and sync because filters and payloads come from this schema.
4. **Embedding provider registry + shadow-profile storage + resumable re-embed.** `EmbeddingProvider`, `embedding_profiles`, per-profile tables (`halfvec` as needed), extend `reprocess-documents.js`. Depends on 3 (re-embed after re-chunk, one corpus pass if sequenced well).
5. **Hybrid retrieval on pgvector + `RetrievalBackend` interface + rerank + context assembly upgrades.** `lexical_text`, `hybrid_search_chunks`, RRF, Cohere/Voyage/local rerankers, candidates-up then top-k-down, best-at-edges ordering, compression, rerank-score abstention. Depends on 2, 3, 4. Doing this on pgvector first gives the biggest quality gain with no new infrastructure and defines the backend contract that Weaviate/Qdrant must satisfy.
6. **Generation: citations + groundedness.** `CitationStrategy` (alias first, Claude Citations second), `data-groundedness` part, UI warning, structured outputs for helper calls. Depends on 2 (stable chunk IDs and context blocks) and the sidecar from 1. Independent of 7 and 8; can run in parallel with them.
7. **Query layer.** History-aware rewrite, multi-query, HyDE, decomposition + RRF fusion, one combined structured-output transform call, per-feature flags and budgets. Depends on 5 (pipeline stage framework, backend search to fan out). Placed after rerank so the extra candidate load is paid for by a reranker and measured latency exists.
8. **External backends + sync.** Outbox + triggers + worker + reconcile, `VectorIndexWriter`, Weaviate and Qdrant adapters, tenant-isolation test suite (cross-tenant negative tests are mandatory release criteria), freshness/lag fallback to pgvector. Depends on 3 (payload schema), 4 (profiles), 5 (backend contract). Last because it is the most infrastructure and the least certain benefit; pgvector remains the default until eval says otherwise.
9. **Closeout.** Full regression eval, choose defaults (backend, embedding, reranker), finish Config UI controls, update `AGENTS.md` and docs.

**Research flags for phases:**
- Phase 3: Docling table/OCR quality on Italian and Chinese scans; async parse job sizing on Fly; whether `ProcessingProfile` doc-type auto-detection needs an LLM or rules suffice.
- Phase 4: Real output dimensions and instruction/prefix conventions for Qwen3-Embedding-8B (hosted provider choice) and Voyage-4-large; `halfvec` HNSW build cost.
- Phase 5: Chinese lexical behavior of the shared `lexical_text` approach; Cohere/Voyage rerank score calibration for abstention thresholds.
- Phase 6 (needs deeper research): whether `ai@6` `@ai-sdk/anthropic` accepts `search_result` input blocks; Claude Citations interaction with tools/MCP; HHEM-2.3 availability, cost, and Italian/Chinese coverage.
- Phase 8 (needs deeper research): Weaviate hybrid in a tenant; Qdrant BM25/sparse generation from TypeScript and per-prefetch filters; outbox worker hosting given the 60 s cap.
- Phases 1, 2, 7: standard patterns; Phase 1 needs golden-set curation effort, not technical research.

## Open Questions

1. **Embed widget tenant.** The embed route passes no scope; in single-tenant that effectively means "the whole corpus", in multi-tenant it must be bound explicitly (embed key to workspace). Needs a product decision before phase 2 finalizes `resolveTenantScope` for `profile=embed`.
2. **Voice tenant.** Voice currently trusts `userId` from the caller and ignores org. Decide whether the voice agent passes `organizationId` and who verifies membership (the agent holds the internal key, so verification must happen server-side from the LiveKit participant identity).
3. **Baseline fidelity.** Whether to freeze `ragMode`/model/system prompt for eval and which model generates the eval answers (cost vs production parity).
4. **Where the outbox drain runs** if Vercel cron frequency or the 60 s cap is insufficient (long-running Node worker alongside `voice-agent/` style deploys).

## Sources

- Codebase: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`, `.planning/PROJECT.md`; direct inspection of `src/app/api/chat/route.ts` (L2080-2350, import list), `src/app/api/embed/chat/route.ts`, `src/app/api/internal/voice-rag/route.ts`, `src/lib/enhanced-rag-retrieval.ts`, `src/lib/reranker-adapter.ts`, `src/lib/document-processor.ts`, `supabase/multi-tenant-setup.sql` (L203-230, L688-832), `vercel.json`, `package.json` (HIGH)
- Anthropic Citations: https://platform.claude.com/docs/en/build-with-claude/citations (structured-outputs incompatibility, `citations_delta`) (MEDIUM-HIGH, official docs fetched directly)
- Anthropic search results: https://platform.claude.com/docs/en/build-with-claude/search-results (block shape, user-message or tool-result placement, uniform `citations.enabled`) (MEDIUM-HIGH)
- AI SDK Anthropic provider: https://ai-sdk.dev/providers/ai-sdk-providers/anthropic (citation output exposure; `search_result` input unconfirmed) (MEDIUM)
- Qdrant multitenancy: https://qdrant.tech/documentation/guides/multiple-partitions/ (`is_tenant`, shared BM25 IDF caveat) (MEDIUM-HIGH)
- Qdrant hybrid queries: https://qdrant.tech/documentation/concepts/hybrid-queries/ (prefetch + RRF; per-prefetch filters unconfirmed on page read) (MEDIUM)
- Weaviate multi-tenancy: https://docs.weaviate.io/weaviate/manage-collections/multi-tenancy (tenant-per-shard, naming, auto-creation) (MEDIUM-HIGH)
- Docling chunking: https://docling-project.github.io/docling/concepts/chunking/ (`repeat_table_header`, `contextualize`) (MEDIUM-HIGH)
- Vectara HHEM: https://www.vectara.com/blog/hallucination-detection-commercial-vs-open-source-a-deep-dive (HHEM-2.3 API-only, 2.1-Open English-only) (MEDIUM)
- Supabase Queues / pgmq patterns (no built-in DLQ/retry limit, need custom handling): https://supabase.com/docs/guides/queues, community write-ups (LOW-MEDIUM; the outbox design here is an architectural recommendation, not a documented Supabase pattern)

---
*Architecture research for: production RAG pipeline upgrade of myRAG*
*Researched: 2026-11-22*
