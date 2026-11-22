# Stack Research

**Domain:** Production RAG pipeline upgrade (Next.js 16 / React 19 / TS app + Python sidecar) over Supabase pgvector
**Researched:** 2026-11-22
**Confidence:** MEDIUM-HIGH overall (package names, versions, exports and Node engines were verified directly from the npm/PyPI registries and by unpacking the published packages; vendor behaviour was verified from vendor docs and cross-checked where possible; items marked LOW are single-source)

Confidence legend: HIGH = read from registry metadata or the published package source. MEDIUM = vendor docs, ideally two sources agree. LOW = single or secondary source, or inferred. The `classify-confidence` seam rates raw web search or fetch results LOW by default. A finding is only upgraded here when it was cross-verified against package source or a second vendor page.

---

## 0. Corrections and Flags to the Chosen List (read first)

| # | Chosen item | Reality | Closest real equivalent / action | Confidence |
|---|-------------|---------|-----------------------------------|------------|
| 1 | "HHEM-2.3 in the Python sidecar" | HHEM-2.3 is **commercial, API-only** (Vectara platform). It has **no open weights**. The open model is **HHEM-2.1-Open** (English only, ~0.1B params, Apache-2.0, `vectara/hallucination_evaluation_model`, needs `trust_remote_code=True`). | The sidecar must **proxy to Vectara's `POST /v2/evaluate_factual_consistency`** (model `hhem_v2.3`). It cannot run HHEM-2.3 locally. | HIGH (two Vectara sources agree) |
| 2 | HHEM-2.3 languages "Chinese and Italian" | Supported: eng, deu, fra, spa, por, ara, kor, **zho**, rus, jpn, hin. **Italian is NOT supported** (Vectara docs: scores for other languages are "unreliable"). Chinese is supported (commercial model only). | Italian answers: do not store an HHEM score (store `null` + `unsupported_language`) or use an LLM-judge faithfulness fallback. See section 6. | HIGH (REST docs and HF model card agree) |
| 3 | LangChain.js `createHistoryAwareRetriever`, `MultiQueryRetriever`, HyDE | All three exist, but **not in `langchain` 1.x**. They moved to **`@langchain/classic`** ("Old abstractions from LangChain.js"). The HyDE class is `HydeRetriever`. Python's `create_history_aware_retriever` is `createHistoryAwareRetriever` in JS. | Import from `@langchain/classic/chains/history_aware_retriever`, `@langchain/classic/retrievers/multi_query`, `@langchain/classic/retrievers/hyde`. | HIGH (unpacked `@langchain/classic@1.0.62`) |
| 4 | LlamaIndex.TS `SubQuestionQueryEngine` | Exists (`llamaindex@0.12.1` root export). It decomposes and also **synthesises an answer** itself, which conflicts with the Citations flow (we need raw chunks). | Prefer a native port of the algorithm (see section 2). | HIGH |
| 5 | LlamaIndex.TS `QueryFusionRetriever` | **Does not exist in LlamaIndex.TS** (0.12.1 and `@llamaindex/core` 0.6.22 contain no fusion retriever). It is Python-only. | `EnsembleRetriever` in `@langchain/classic/retrievers/ensemble` (weighted reciprocal rank fusion, default `c=60`) or a 20-line native RRF function. | HIGH |
| 6 | "Voyage rerank-3" | Real. Voyage docs list `rerank-3` and `rerank-3-lite` (32,000-token context) as **current**, with `rerank-2.5` and `rerank-2.5-lite` as older. But `@ai-sdk/voyage`'s typed IDs and docs list only `rerank-2.5`, `rerank-2.5-lite`, `rerank-2`, `rerank-2-lite`, `rerank-1` and `rerank-lite-1`. The type is `(string & {})`, so `rerank-3` still compiles. Voyage docs do **not** state multilingual support for `rerank-3`. They do for `rerank-2.5`. | Use `rerank-3`, but gate adoption on the Chinese and Italian golden-set results. Keep `rerank-2.5` as the explicit multilingual fallback. | MEDIUM |
| 7 | "Cohere Rerank 5" | Real. Model IDs **`rerank-v5.0-pro`** and **`rerank-v5.0-fast`** (32k context, multilingual, Chinese named as a focus language). They are in Cohere's docs but **not** in `@ai-sdk/cohere`'s typed IDs (it lists v4.0 and v3.5; the type accepts any string). v5 adds `relevant_spans`, which is useful for context compression. | Use `rerank-v5.0-pro` / `rerank-v5.0-fast` via string ID. | MEDIUM-HIGH |
| 8 | Qwen3-Embedding-8B in pgvector | Native output is **4096 dims**. That exceeds the pgvector HNSW limit even for `halfvec` (4000 max). A 4096-dim HNSW index is impossible. | Truncate with MRL (Matryoshka) to 1024 or 2048 and L2-renormalise. Store as `halfvec`. See section 3. | HIGH |
| 9 | "Voyage-4-large" | Real, ID `voyage-4-large`. 32k context. Default **1024** dims. Allowed `output_dimension` 256, 512, 1024, 2048. | Default to 1024 or 2048, decided by eval. | HIGH |
| 10 | Weaviate and Qdrant TS clients | `weaviate-client@3.15.3` and `@qdrant/js-client-rest@1.20.0` declare **`engines.node >=22`**. The repo documents Node `>=20.9`. | Pin the Vercel project and CI to Node 22.x and raise root `engines.node`. | HIGH |
| 11 | Vercel AI SDK versions | npm `latest` is now **`ai@7.0.179`** and `@ai-sdk/anthropic@4.x`. The project is on **v6**. | Stay on the v6 line. Install provider packages with the **`ai-v6` dist-tag** (see Installation). Do not run bare `npm i @ai-sdk/anthropic`. It resolves to the v7-generation 4.x. | HIGH |
| 12 | Claude Citations through AI SDK 6 | Works **only** for `text/plain` and `application/pdf` file parts in user messages (`char_location` / `page_location`). `content_block_location` citations and `search_result` blocks are **not** surfaced by `@ai-sdk/anthropic@3.0.143`. Citations also return **HTTP 400 if combined with structured outputs**. | See section 5. | HIGH (read the provider source) |
| 13 | LangChain JS and zod | `@langchain/core@1.5.0` needs **`zod ^4.6.6`**. The app is on `zod ^3.25.76` (AI SDK peers accept `^3.25.76 \|\| ^4.1.8`). | Plan a zod 4 migration, or keep LangChain strictly behind an adapter module so zod 3 and 4 never meet. Verify in the first query-layer phase. | MEDIUM |

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| Vercel AI SDK (`ai`) | stay on **6.0.x** (dist-tag `ai-v6` = 6.0.333) | LLM calls, `embedMany`, `rerank`, `streamText` | `rerank()` and `RerankingModelV3` already exist in v6. Keeping v6 avoids a migration unrelated to RAG. | HIGH |
| `@ai-sdk/anthropic` | **3.0.143** (dist-tag `ai-v6`) | Direct Claude calls with Citations | 3.x is the v6-compatible line and has `providerOptions.anthropic.citations`. | HIGH |
| `@ai-sdk/voyage` | **1.0.44** (dist-tag `ai-v6`) | Voyage embeddings + rerank | Official Vercel provider. Typed IDs include `voyage-4-large`. Both model types accept any string. | HIGH |
| `@ai-sdk/cohere` | **3.0.79** (dist-tag `ai-v6`) | Cohere Rerank 5 | Official provider, supports `rerank()`. Use the string ID `rerank-v5.0-pro`. | HIGH |
| `@ai-sdk/deepinfra` | **2.0.98** (dist-tag `ai-v6`) | Qwen3-Embedding-8B embeddings | `embeddingModel(id)` accepts any string ID. Cheapest verified host. | MEDIUM-HIGH |
| `@langchain/core` + `@langchain/classic` | **1.5.0** / **1.0.62** | `createHistoryAwareRetriever`, `MultiQueryRetriever`, `HydeRetriever`, `EnsembleRetriever` | The only place these abstractions still live in JS. Node >=20. | HIGH |
| `@langchain/openrouter` | **0.4.26** | LangChain chat model for the query-rewrite LLM through the existing OpenRouter key | Gives `LanguageModelLike` for LangChain chains without adding a second provider key. Adapter risk: verify it supports the models you pick. | MEDIUM |
| `llamaindex` | **do NOT bump** (stay `^0.8.30`, used only for parsing helpers) | n/a | 0.12.1 is a large API jump. SubQuestion and Fusion are better ported natively (section 2). | MEDIUM |
| `@anthropic-ai/sdk` | **1.12.0** | Escape hatch: Citations with `search_result` or custom-content blocks | Only needed if the AI SDK path proves too limiting. Not on the default path. | MEDIUM |
| `weaviate-client` (TS) | **3.15.3** (Node >=22) | Weaviate backend | Current v3 TS client. Collections API. | HIGH |
| `@qdrant/js-client-rest` | **1.20.0** (Node >=22) | Qdrant backend | Matches Qdrant server 1.20. | HIGH |
| Python | **3.12** | Sidecar runtime | `torch`, `transformers`, `fastapi` and `langchain-core` all need >=3.11. Docling needs >=3.10. | HIGH |
| FastAPI + uvicorn | **0.165.0** / **0.54.0** | Sidecar HTTP | Python >=3.11 for FastAPI 0.165. | HIGH |
| `docling` + `docling-core` | **2.151.1** / **2.108.0** | Parsing + `HybridChunker` | Verified: `HybridChunker(repeat_table_header=True)` is the default in docling-core 2.108.0. | HIGH |
| `httpx` | **0.28.1** | Sidecar to Vectara HHEM API | Async client with timeouts. | HIGH |
| `deepeval` | **4.3.4** | Pytest-style eval with CI gate | `ContextualRecallMetric`, `FaithfulnessMetric`, `AnswerRelevancyMetric`, `assert_test`. | MEDIUM-HIGH |
| `ragas` | **0.4.4** | Synthetic test-set generation + RAG metrics | Faithfulness, ContextRecall, AnswerRelevancy and ID-based context recall in `ragas.metrics`. New-style metrics in `ragas.metrics.collections`. | MEDIUM-HIGH |

### Model and API Identifiers (verified)

| Product | Model ID | Dimensions / limits | Endpoint | Confidence |
|---------|----------|---------------------|----------|------------|
| Qwen3-Embedding-8B | `Qwen/Qwen3-Embedding-8B` (DeepInfra, SiliconFlow, Nebius), `qwen/qwen3-embedding-8b` (OpenRouter), `fireworks/qwen3-embedding-8b` (Fireworks) | Native **4096**. MRL range **32 to 4096**. Context 32k (OpenRouter lists 40,960). 100+ languages. Apache-2.0. | DeepInfra: `POST https://api.deepinfra.com/v1/openai/embeddings` (OpenAI-compatible) | HIGH (model card) / MEDIUM (host details) |
| Voyage embeddings | `voyage-4-large` (also `voyage-4`, `voyage-4-lite`, `voyage-4-nano` open-weight) | Default **1024**. `output_dimension` in {256, 512, 1024, 2048}. Context 32k. `output_dtype` float / int8 / uint8 / binary / ubinary. 1,000 texts per request. 120K tokens per request for `-large`. `input_type` = `query` or `document`. All 4-series models share one embedding space. | `https://api.voyageai.com/v1/embeddings` | MEDIUM-HIGH |
| Voyage rerank | `rerank-3`, `rerank-3-lite` (current). `rerank-2.5`, `rerank-2.5-lite` (older, multilingual stated). | 32,000 tokens. Max 1,000 docs. Query max 8,000 tokens. 600K total tokens. | `POST https://api.voyageai.com/v1/rerank` | MEDIUM |
| Cohere rerank | `rerank-v5.0-pro`, `rerank-v5.0-fast` (also `rerank-v4.0-pro/fast`, `rerank-v3.5`) | 32,768 tokens (query plus doc). `max_tokens_per_doc` default 4096. About 1,000 docs per request recommended. `relevance_score` 0 to 1. `relevant_spans` option (v5+). | `POST https://api.cohere.com/v2/rerank` | MEDIUM-HIGH |
| Vectara HHEM | `hhem_v2.3` (default; `hhem_v2.2` is aliased to it; anything else gives 400) | Returns `{score: 0..1}`, higher means more factually consistent. Request: `generated_text`, `source_texts[]`. Max length not documented. | `POST /v2/evaluate_factual_consistency` on Vectara's API host (`api.vectara.io`, auth header `x-api-key`; verify both against the live docs at build time) | HIGH (path, body, model) / LOW (host, header) |
| Claude (direct) | Use IDs from `GET /v1/models`. The Citations doc lists `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`, `claude-fable-5-2`, `claude-opus-4-8`, `claude-sonnet-4-6` etc. | All active models support Citations. | Anthropic Messages API | MEDIUM-HIGH |

> OpenRouter model IDs (e.g. `anthropic/claude-sonnet-4.5`) do **not** equal Anthropic API IDs (`claude-sonnet-4-5`). A maintained OpenRouter-to-Anthropic ID map is required to implement "when the model is Claude, call Anthropic directly". Fall back to the OpenRouter path when no mapping exists.

---

## 1. Parsing: LlamaParse + Docling

- **Docling in the sidecar**: use the `docling` Python library directly inside our own FastAPI app, not `docling-serve` as a separate deployment.
  - Why: we need our own tokenizer (the Qwen3 or a Voyage-compatible one), our own metadata (language, page, section, document type, content hash) and the same process also hosts the HHEM proxy. `docling-serve` (v1.38.2, CPU image about 4.4 GB, `X-Api-Key` header via `DOCLING_SERVE_API_KEY`) does not document `repeat_table_header` in its `chunking_options` (only `max_tokens`, `tokenizer`, `merge_peers`, markdown/image options). Its default tokenizer is `sentence-transformers/all-MiniLM-L6-v2`. (MEDIUM)
  - Use `docling-serve` only if you later want a drop-in queue and async API.
- **HybridChunker**: `HybridChunker(tokenizer=HuggingFaceTokenizer(...Qwen3 tokenizer..., max_tokens=...), repeat_table_header=True, merge_peers=True)`. Header repetition is default-on in docling-core 2.108.0 and there is also `omit_header_on_overflow`. (HIGH)
  - Do not leave the default English MiniLM tokenizer on a Chinese or Italian corpus. Token counts diverge and chunks overflow or underfill. Pass an explicit tokenizer. (HIGH)
- **OCR**: Docling's OCR language handling is engine-specific (EasyOCR codes or `iso:` BCP-47 tags, RapidOCR Chinese models, Tesseract). The docs fetched did not list the `chi_sim` / `ita` configuration. Pre-download models (`docling-tools models download`, `DOCLING_ARTIFACTS_PATH`) in the image build. Verify scanned Chinese and Italian PDFs on a real sample before committing the "scanned documents" document-type strategy. (MEDIUM-LOW, flag for phase research)
- **LlamaParse fallback logic**: stays an HTTP call from the TS app (existing). Docling is the fallback when LlamaParse fails or is not configured, per PROJECT.md.
- **Formats**: Docling handles PDF, DOCX, PPTX, XLSX, HTML, MD, CSV, images (PNG/JPEG/TIFF/BMP/WEBP). Legacy DOC/XLS/PPT need LibreOffice. (MEDIUM)

## 2. Query Layer (TypeScript)

| Capability | Package / import | Status | Recommendation |
|------------|------------------|--------|----------------|
| History-aware query rewrite | `import { createHistoryAwareRetriever } from "@langchain/classic/chains/history_aware_retriever"` | Exists. Params `{ llm, retriever, rephrasePrompt }`. Input `{ input, chat_history }`. Passes `input` straight through when history is empty. | Use it. Wrap our unified retriever as a `BaseRetriever` subclass. Run the rewrite on a small, fast model. Skip it entirely when `chat_history` is empty. |
| Multi-query | `import { MultiQueryRetriever } from "@langchain/classic/retrievers/multi_query"` | Exists. | Use it. Write the generation prompt to emit variants **in zh, en and it** so cross-language questions reach the BM25 leg. Dense retrieval handles cross-language on its own. BM25 does not. |
| HyDE | `import { HydeRetriever } from "@langchain/classic/retrievers/hyde"` | Exists, but it extends `VectorStoreRetriever` and needs a LangChain `VectorStore`. Built-in prompt keys: websearch, scifact, arguana, trec-covid, fiqa, dbpedia-entity, trec-news, mr-tydi (English-oriented). | Do **not** wire it to a LangChain VectorStore. Port the idea: one LLM call produces a hypothetical answer, we embed that answer with the document-side embedding and run it through our retriever. About 15 lines. Write the prompt per language. |
| Sub-question decomposition | `SubQuestionQueryEngine` in `llamaindex@0.12.1` (needs `queryEngineTools`, a question generator and a response synthesizer) | Exists, but bundles answer synthesis. | Port natively: `generateObject({ schema: z.object({ subQuestions: z.array(z.object({ q, tool? })) }) })`, run each sub-question through the unified retriever in parallel, then fuse. Keeps raw chunks available for Citations. Reuse the LlamaIndex prompt wording as a starting point. |
| Rank fusion | LlamaIndex `QueryFusionRetriever` is **Python only**. JS equivalent: `EnsembleRetriever` in `@langchain/classic/retrievers/ensemble` (weighted RRF, `c` default 60). | n/a in TS | Own 20-line RRF over `{id, rank}` lists. It must be shared between multi-query, sub-question and hybrid fusion. Keep `EnsembleRetriever` as an option. |

Decision: keep the LangChain dependency to **3 small imports** in a single `src/lib/rag/query/` adapter directory. Everything else (HyDE, sub-questions, RRF) is native TS over the AI SDK. This keeps zod 3 and 4 confined to one module and avoids dragging `@langchain/openai` into the main graph beyond what `@langchain/classic` already requires (it depends on `@langchain/openai@1.8.5` and `@langchain/textsplitters`). The Python alternative (sidecar hosting LangChain and LlamaIndex Python, where `QueryFusionRetriever` exists) costs a network hop on the hot path and is not recommended for chat latency.

LangChain chat model for the adapter: `@langchain/openrouter@0.4.26` against the existing OpenRouter key. Alternatively `ChatOpenAI` with `baseURL`. (MEDIUM, spike in phase)

## 3. Embeddings and pgvector

### Providers (switchable, selected by env)

| Provider | How | Notes |
|----------|-----|-------|
| Qwen3-Embedding-8B | `createDeepInfra()` from `@ai-sdk/deepinfra` with `.embeddingModel('Qwen/Qwen3-Embedding-8B')`; or `createOpenAICompatible` (`@ai-sdk/openai-compatible@2.0.94`, dist-tag `ai-v6`) pointed at the host | Hosts verified: DeepInfra (about $0.01 per 1M input tokens, listed on the model page), Nebius, SiliconFlow, Fireworks, OpenRouter (aggregates Nebius, DeepInfra and SiliconFlow; uses the existing key). Prices from aggregators vary and are unverified. Together AI was **not** verified to host it. |
| Voyage-4-large | `voyage.embedding('voyage-4-large')` with `providerOptions.voyage = { outputDimension, inputType: 'query' \| 'document' }` | Always set `inputType`. The `voyage-4` family shares an embedding space, so cheaper `voyage-4-lite` queries against `voyage-4-large` documents is a legitimate later optimisation. |
| OpenAI (existing) | unchanged | 1536 dims, `vector(1536)` stays valid. |

Qwen3 specifics (HIGH, model card):
- Queries need the instruction form `Instruct: {task description}\nQuery:{query}`. Documents need **no** instruction. Write the instruction **in English** even for zh and it text. Missing the instruction costs roughly 1 to 5 points of retrieval quality.
- DeepInfra documents an `input_type` and a custom-instruction field. Do not apply the instruction twice. Pick one mechanism and test it on the golden set.
- DeepInfra does not document a `dimensions` request parameter. **Truncate client-side**: slice the first N dims, then L2-normalise. This is how MRL works and it is provider-independent. (MEDIUM)

### Dimension decision (HIGH, from pgvector docs)

| Type | Max dims for HNSW or IVFFlat | Fits |
|------|------------------------------|------|
| `vector` | **2000** | OpenAI 1536. Qwen3 or Voyage at 1024 or 2048 does **not** fit at 2048 (2048 > 2000). |
| `halfvec` | **4000** | Voyage-4-large at 2048, Qwen3 at 1024 or 2048. **Qwen3 at native 4096 does not fit.** |

- Store new embeddings as **`halfvec`**: Voyage at 1024 or 2048, Qwen3 at 1024 or 2048. Final dimension is an eval decision. Default candidates: `voyage-4-large@1024`, `qwen3-8b@1024`, plus the 2048 variants.
- Different models produce incomparable vectors. Use a **side table** `chunk_embeddings(chunk_id, profile, embedding halfvec)` with one **partial expression HNSW index per profile**: `CREATE INDEX ... USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops) WHERE profile = '...'`. The column itself is unconstrained `halfvec`. The existing `vector(1536)` column is untouched, which gives the rollback path required by PROJECT.md. (MEDIUM, confirm the pattern on a Supabase branch)
- Use pgvector >= 0.8 iterative scans (`hnsw.iterative_scan`) for tenant- and filter-heavy queries. Without it, HNSW plus a selective WHERE returns fewer than `match_count` rows. (HIGH, Supabase's semantic-search page and pgvector docs both note this.)
- The existing `m=64, ef_construction=200` is a big index. Re-measure build time and RAM on the Supabase compute tier for the larger dimensions. Supabase's own docs say dimensionality is the main driver of compute-add-on size. (MEDIUM)

## 4. Hybrid Retrieval Backends

### pgvector on Supabase (default)

- Vector leg: `halfvec` HNSW (above).
- Keyword leg, **language-aware** (Postgres has no built-in Chinese text search config):
  - English and Italian: generated `tsvector` columns with the **`english`** and **`italian`** configs (both ship with Postgres), GIN index, selected by the chunk's `language` metadata. Add `unaccent` for Italian accents. (HIGH)
  - Chinese: **PGroonga** (`create extension pgroonga with schema extensions;`, index `USING pgroonga(content)`, operator `&@~`). It is enabled from the Supabase dashboard (Database > Extensions) and is positioned for CJK. Note that the Supabase page gives no Chinese example. (MEDIUM)
  - **Not available / not recommended on Supabase hosted**: ParadeDB `pg_search` (BM25) is only supported through a **separate ParadeDB instance fed by logical replication**. `zhparser` and `pg_jieba` were only found on BytePlus's Supabase-compatible service, not in Supabase's own docs. (MEDIUM)
  - `pg_trgm` is a weak, noisy fallback for Chinese. Use only if PGroonga is rejected.
- Fusion: Supabase's reference pattern is one SQL function with two CTEs (FTS rank and vector rank), a `FULL OUTER JOIN` and RRF (`1/(rrf_k + rank)`, default `rrf_k=50`, per-leg weights). Reuse that shape. It runs inside RLS or an RPC that receives `user_id` or `organization_id`. (HIGH)
- Note: Postgres `ts_rank` is **not** BM25. If true BM25 scoring matters, add a decision gate after baseline eval.

### Weaviate (TS `weaviate-client@3.15.3`)

- Server: use **>= 1.34** (ACORN is the default filter strategy from 1.34; later versions exist, 1.38 and 1.40 were seen). (MEDIUM)
- Multi-tenancy: one collection with `multiTenancyConfig: { enabled: true, autoTenantCreation: true }`. **Immutable after creation.** Tenant name = workspace ID (`user_id` or `organization_id`), queried through `collection.withTenant(...)`. This gives physical per-tenant isolation, which is the strongest of the three backends. (HIGH, config reference)
- Hybrid: `collection.query.hybrid(query, { alpha, vector, fusionType, filters, limit })`. `vector` lets us pass our own query vector so we control the embedding provider. `fusionType` is `'RelativeScore'` (default since 1.24) or `'Ranked'` (RRF-like). Use `Ranked` if you want parity with the other two backends' RRF. (MEDIUM)
- Use `vectorConfig` named vectors, one per embedding profile.
- **Chinese BM25**: tokenizers `gse` (Japanese dict), `gse_ch` (Chinese) and `trigram` are **opt-in by env var** (`ENABLE_TOKENIZER_GSE_CH=true`). The docs say `gse` segments Chinese poorly without error. Forum reports show BM25 over-scoring on mixed zh-en text. **Whether Weaviate Cloud exposes these env vars is not verified.** Mitigation: separate properties per language (`content_zh` with `gse_ch`, `content_latin` with `word`) so BM25 does not mix scripts, or self-host Weaviate. (LOW-MEDIUM, phase-level research flag)

### Qdrant (TS `@qdrant/js-client-rest@1.20.0`)

- Server: use **1.20**. It adds BM25 scoring on the full-text index (`field_schema: { type: "text", scoring: { type: "bm25" } }`, then `query: { text: "..." }, using: "<field>"`, per-query `k` and `b` with defaults 1.2 and 0.75). This replaces the older approach of client-computed sparse vectors. (MEDIUM; one vendor blog, so verify during the phase)
- Hybrid: Query API `prefetch` (dense plus text) with RRF or DBSF fusion. Weighted RRF exists from 1.17. (MEDIUM)
- Server-side `qdrant/bm25` **inference is Qdrant Cloud only**. For self-hosted use the full-text-index BM25 above, or compute sparse vectors in the sidecar with FastEmbed. (MEDIUM)
- Multi-tenancy: **one shared collection**, payload field `tenant_id`, keyword payload index with **`is_tenant: true`** (since v1.11), and a **mandatory `must` filter on every query**. Isolation is application-enforced, not server-enforced. Therefore centralise all Qdrant access behind one wrapper that cannot issue an unfiltered query. BM25/IDF statistics are shard-wide by default and blend tenants. Qdrant 1.19+ has an `idf` corpus filter to scope them. (HIGH for the tenant pattern, MEDIUM for IDF)
- Chinese: a multilingual tokenizer for the full-text index is mentioned for Chinese and Japanese in Qdrant's text-search guide, but details were not retrievable. Italian needs `language`-specific stemmer and stopwords (the docs show Spanish as an example). Verify both in the phase. (LOW-MEDIUM)

### Sync model (Supabase stays source of truth)
Implement the Supabase to Weaviate/Qdrant sync in **TypeScript** (the two TS clients above) alongside the ingestion code, not in the Python sidecar. This keeps Python to the four things that must be Python: Docling, HHEM proxy, DeepEval, Ragas.

## 5. Rerank and Generation

### Rerank (switchable; AI SDK `rerank()` verified in `ai@6.0.333`)

```ts
import { rerank } from 'ai';
import { cohere } from '@ai-sdk/cohere';
import { voyage } from '@ai-sdk/voyage';

const model = provider === 'cohere'
  ? cohere.reranking('rerank-v5.0-pro')     // typed IDs lag; accepts any string
  : voyage.reranking('rerank-3');           // typed IDs lag; accepts any string
const { ranking } = await rerank({ model, query, documents, topN });
// ranking[i] = { originalIndex, score, document }
```

- AI SDK Cohere `providerOptions.cohere` only exposes `maxTokensPerDoc` and `priority`. To use v5 `relevant_spans` (useful for context compression), call `https://api.cohere.com/v2/rerank` directly. (MEDIUM)
- Score semantics: Cohere scores are 0 to 1, **not ratios**. Secondary sources claim Rerank 5 scores are calibrated (LOW). PROJECT.md wants a rerank-score threshold for refusal. **Calibrate the threshold on the golden set per provider.** Do not reuse one number across Cohere and Voyage.
- Pass documents as plain strings. Object documents get stringified with a warning in the Cohere provider.

### Claude Citations via `@ai-sdk/anthropic@3` (HIGH, read from provider source and Anthropic docs)

What the provider does: for **user-message file parts** with `mediaType` `text/plain` (or `application/pdf`) and `providerOptions.anthropic.citations.enabled = true`, it emits Anthropic `document` blocks with `citations: {enabled: true}`. Responses surface as `source` parts (`sourceType: 'document'`) with `providerMetadata.anthropic = { citedText, startCharIndex, endCharIndex }` (text) or `{ citedText, startPageNumber, endPageNumber }` (PDF). Raw citations are also on `text.providerMetadata.anthropic.citations`.

Anthropic's own RAG guidance: put **each RAG chunk into its own plain-text document**. Anthropic then sentence-chunks inside it.

```ts
const content = [
  { type: 'text', text: question },
  ...chunks.map(c => ({
    type: 'file' as const,
    mediaType: 'text/plain' as const,
    data: Buffer.from(c.text, 'utf8'),
    filename: c.id,                          // chunk ID, comes back as source.filename
    providerOptions: { anthropic: {
      citations: { enabled: true },
      title: c.documentName,                 // shown to users
      context: JSON.stringify({ page: c.page, section: c.section }),  // not citable
    } },
  })),
];
```

Constraints to design around:
1. **Citations and structured outputs are mutually exclusive** (HTTP 400 if both `output_config.format` and citation-enabled documents are present). The PROJECT.md item "structured output for the citation list" must therefore come from the citations themselves for Claude. Use structured output only on the non-Claude, chunk-ID path.
2. **`content_block_location` is dropped by the AI SDK.** `createCitationSource` returns nothing for it, and custom-content documents or `search_result` blocks cannot be expressed in the AI SDK prompt format. Plain-text-per-chunk is the supported path. If you need exact block-level or `search_result` citations (GA, with `source` as any stable string such as a chunk URI), use `@anthropic-ai/sdk@1.12.0` directly as a contained escape hatch.
3. Citation `document_index` is positional across all citation-enabled documents in the request. **Never reorder or filter chunks after building the prompt.** Chunk ID in `filename` is the lookup key.
4. `cited_text` does not count toward output tokens. Citations do not combine with `prefill`. Source documents can use `cache_control`.
5. Needs a direct `ANTHROPIC_API_KEY` and an OpenRouter-to-Anthropic model ID map (see note above).
6. Other models stay on the existing OpenRouter path with chunk-ID prompt citations.

### HHEM (hallucination scoring), in the sidecar as an **API proxy**

- `POST /v2/evaluate_factual_consistency` with `{ generated_text, source_texts: [...], model_parameters?: { model_name: "hhem_v2.3" } }` returns `{ score }`. Source: Vectara REST docs. (HIGH for the shape)
- Run it **after** the answer streams, asynchronously, and write the score to message metadata and logs. `vercel.json` caps API routes at 60 seconds and chat latency must not wait on it. Phase 1 logs only (per PROJECT.md).
- Language routing: detect the answer's language. `en`/`zh` (and de/fr/es/pt/ar/ko/ru/ja/hi) go to Vectara. **`it` returns `score: null, reason: "unsupported_language"`** in v1. Optional later: an LLM-judge faithfulness fallback for Italian using the same DeepEval `FaithfulnessMetric`, or a multilingual NLI model such as an mDeBERTa XNLI checkpoint (LOW, unvalidated).
- **Privacy**: every scored answer plus its source chunks leaves the tenant boundary for Vectara. This must be a tenant- or admin-level switch, default OFF for multi-tenant deployments, and it must be documented. (Not stated on Vectara's page; verify its retention policy before enabling.)
- **HHEM-2.1-Open as a local fallback**: English only, 0.1B, Apache-2.0, `AutoModelForSequenceClassification.from_pretrained('vectara/hallucination_evaluation_model', trust_remote_code=True)` then `model.predict(pairs)`. `trust_remote_code=True` executes code from the HF repo. Pin a revision hash if used. Not recommended for a zh/it/en knowledge base.

## 6. Python Sidecar Hosting and Layout

- Follow the existing pattern: `sidecar/` sibling directory, Dockerfile, **Fly.io** app (as `voice-agent/` and `baileys-whatsapp/` do). Python 3.12-slim, CPU-only PyTorch wheels. Size the VM from measurement (docling-serve's CPU image is about 4.4 GB on disk, so give the machine ample RAM and disk and bake models in at build time; exact RAM is not verified, start at 4 GB and measure on a real scanned PDF). (MEDIUM-LOW on sizing)
- Auth: shared-secret header on every route, constant-time compare, fail closed if the secret is unset. Mirror `docling-serve`'s `X-Api-Key` convention. PROJECT.md requires auth from day one.
- **Split deployables**: the always-on sidecar (FastAPI + docling + HHEM proxy) and the **eval package** (deepeval + ragas) should have separate `pyproject.toml` files. Eval runs in CI and on a developer machine, not in production. Reasons: `ragas` hard-depends on `langchain`, `langchain-community`, `langchain_openai`, `datasets` and others, and `deepeval` pins `grpcio`, `opentelemetry`, `pydantic>=2.11.7`, `posthog`. That would bloat and destabilise the production image.
- Telemetry: DeepEval and Ragas both ship usage telemetry. Opt out in CI and local runs (the env vars are `DEEPEVAL_TELEMETRY_OPT_OUT=YES` and `RAGAS_DO_NOT_TRACK=true`; confirm names against current docs) so golden-set content derived from real customer documents is not sent out. (MEDIUM)
- Judge LLM: DeepEval metrics default to OpenAI. For Claude as judge, implement a `DeepEvalBaseLLM` subclass (class documented, example not retrieved). Ragas accepts custom LLM wrappers. Use a **multilingual-capable judge** and fix one model per baseline so scores stay comparable. (MEDIUM)
- Recall@k and MRR are rank metrics over chunk or document IDs and are **not LLM metrics**. Compute them yourself against golden-set `relevant_chunk_ids` (about 15 lines). Ragas has ID-based context recall variants in `_context_recall.py`, and DeepEval's `ContextualRecallMetric` is LLM-judged, so they are not interchangeable. (HIGH)
- CI gate: DeepEval's `assert_test` with explicit per-metric thresholds under pytest in a new `.github/workflows/` job. Gate on a **delta versus the stored baseline**, not only an absolute threshold. (MEDIUM)

---

## Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@ai-sdk/openai-compatible` | 2.0.94 (`ai-v6`) | OpenAI-compatible hosts | Qwen3 on Nebius, SiliconFlow, Fireworks or OpenRouter instead of DeepInfra |
| `voyageai` (npm) | 0.6.0 | Voyage raw SDK | Only if AI SDK provider options prove insufficient (e.g. `output_dtype` int8 or binary storage) |
| `cohere-ai` (npm) | 8.3.1 | Cohere raw SDK | Only for `relevant_spans` instead of hand-rolled `fetch` |
| `qdrant-client` (PyPI) | 1.20.0 | Qdrant from Python | Only in eval or diagnostics scripts |
| `weaviate-client` (PyPI) | 4.24.1 | Weaviate from Python | Only in eval or diagnostics scripts |
| `fastembed` (PyPI) | 0.9.1 | Client-side BM25 sparse vectors | Only if you choose sparse-vector BM25 on a self-hosted Qdrant instead of the 1.20 full-text BM25 |
| `anthropic` (PyPI) | 2.12.0 | Claude judge for DeepEval and Ragas | Eval package |

## Installation

```bash
# App (stay on AI SDK v6: use the ai-v6 dist-tag for every @ai-sdk/* package)
npm install @ai-sdk/anthropic@ai-v6 @ai-sdk/voyage@ai-v6 @ai-sdk/cohere@ai-v6 \
            @ai-sdk/deepinfra@ai-v6 @ai-sdk/openai-compatible@ai-v6
npm install @langchain/core@1.5.0 @langchain/classic@1.0.62 @langchain/openrouter@0.4.26
npm install weaviate-client@3.15.3 @qdrant/js-client-rest@1.20.0   # require Node >=22
# Optional escape hatch
npm install @anthropic-ai/sdk@1.12.0
# Raise engines.node to >=22 and set the Vercel project and CI to Node 22.x.
# .npmrc already has legacy-peer-deps=true; confirm only one zod copy per consumer after install.

# Sidecar (python 3.12)
pip install "docling==2.151.1" "docling-core==2.108.0" "fastapi==0.165.0" \
            "uvicorn==0.54.0" "httpx==0.28.1" "pydantic>=2.11,<3"
# CPU torch from the PyTorch CPU index, then `docling-tools models download` at image build

# Eval package (separate pyproject, CI only)
pip install "deepeval==4.3.4" "ragas==0.4.4" "anthropic==2.12.0"
```

Environment variable names to add (names only; mirror in `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, Config UI per AGENTS.md): `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `COHERE_API_KEY`, `DEEPINFRA_API_KEY`, `VECTARA_API_KEY`, `WEAVIATE_URL`, `WEAVIATE_API_KEY`, `QDRANT_URL`, `QDRANT_API_KEY`, `SIDECAR_URL`, `SIDECAR_API_KEY`, plus provider-switch variables in the style of `USE_REPLICATE_PROVIDER`.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Native HyDE, sub-question and RRF in TS, three LangChain imports | Run LangChain and LlamaIndex **Python** in the sidecar (has `QueryFusionRetriever`) | If the team wants literal parity with the Python APIs and accepts the extra network hop. Not for the voice path. |
| Docling as a library in our own FastAPI app | `docling-serve` 1.38.2 | If we want its async queue and OpenAPI out of the box and do not need `repeat_table_header` or a custom tokenizer from the API. |
| DeepInfra for Qwen3-Embedding-8B | OpenRouter (single key, three upstream hosts) | If vendor consolidation matters more than the lowest price, or for failover. Confirm what OpenRouter does with `dimensions`. |
| Plain-text-per-chunk Citations through the AI SDK | Direct `@anthropic-ai/sdk` with `search_result` blocks | If sentence-level citations inside a chunk are not precise enough and chunk-level `source` identity is wanted. |
| PGroonga for Chinese keyword search on Supabase | ParadeDB `pg_search` on a logical replica | If true BM25 on Postgres is required and a second database is acceptable. |
| Vectara HHEM-2.3 API | HHEM-2.1-Open locally, or LLM-judge faithfulness | Italian content, or when tenant data must not leave the deployment. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Bare `npm i @ai-sdk/anthropic` (or voyage, cohere, deepinfra) | Resolves to the v7-generation major (4.x and so on) and is incompatible with `ai@6` | `@ai-sdk/<pkg>@ai-v6` |
| `langchain` 1.x main package for history-aware, MultiQuery or HyDE | The classes are not exported there | `@langchain/classic` |
| LangChain `HydeRetriever` wired to a LangChain `VectorStore` | Forces a parallel retrieval stack, which PROJECT.md forbids ("no second parallel implementation") | Native HyDE over the unified retriever |
| `llamaindex` bump to 0.12.x just for SubQuestion | Large API jump from the current 0.8.30, and no fusion retriever exists in TS anyway | Native port |
| `halfvec(4096)` or `vector(4096)` HNSW for Qwen3 | Index creation fails above 4000 (halfvec) and 2000 (vector) | MRL-truncate to 1024 or 2048 |
| Citations plus structured output in the same Claude request | HTTP 400 | Citations alone for Claude. Structured output for the other models. |
| Reordering or de-duplicating chunk documents after building the Claude prompt | Breaks the positional `document_index` to chunk mapping | Build the final context once, then send it |
| Trusting HHEM scores on Italian text | Not a supported language | `null` score with a reason, or an LLM-judge fallback |
| `docling-serve` default tokenizer on zh and it content | MiniLM English tokenizer mis-sizes chunks | Explicit Qwen or Voyage-compatible tokenizer |
| Qdrant queries without the tenant filter, or sharing IDF stats across tenants unscoped | Cross-tenant leakage is the worst failure per PROJECT.md | One wrapper that always injects `tenant_id`, plus the 1.19+ `idf` corpus scoping |
| Reusing one rerank-score threshold across providers | Scores are not comparable | Calibrate per provider on the golden set |

## Stack Patterns by Variant

**If the active chat model is a Claude model:**
- Build chunk documents as `text/plain` file parts with citations enabled and call Anthropic directly via `@ai-sdk/anthropic`.
- Because Citations are incompatible with structured outputs, produce the citation list from `source` parts.

**If the active chat model is any other OpenRouter model:**
- Keep the current OpenRouter path with chunk IDs in the prompt. Request a structured citation list with `generateObject` or `Output.object` where the model supports it.

**If the voice path:**
- Use only the cheap steps: vector plus keyword in one SQL RPC with RRF, and optionally `rerank-v5.0-fast` or `rerank-3-lite`. Skip multi-query, HyDE and sub-questions.

**If Weaviate runs on Weaviate Cloud and Chinese BM25 is poor:**
- Use per-language properties with the `trigram` tokenizer for `content_zh`, or self-host with `ENABLE_TOKENIZER_GSE_CH=true`.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `ai@6.0.x` | `@ai-sdk/anthropic@3.0.143`, `@ai-sdk/voyage@1.0.44`, `@ai-sdk/cohere@3.0.79`, `@ai-sdk/deepinfra@2.0.98`, `@ai-sdk/openai-compatible@2.0.94` | All pin `@ai-sdk/provider@3.0.19` and `@ai-sdk/provider-utils@4.0.67`. Peer `zod ^3.25.76 \|\| ^4.1.8`. |
| `ai@7.x` | `@ai-sdk/*@latest` (4.x and so on) | Not for this milestone. |
| `@langchain/classic@1.0.62` | `@langchain/core@^1.5.0` | Needs `zod ^4.6.6`. Node >=20. Depends on `@langchain/openai@1.8.5`. |
| `weaviate-client@3.15.3`, `@qdrant/js-client-rest@1.20.0` | Node >=22 | Conflicts with the documented Node >=20.9 baseline. |
| `docling@2.151.1` | Python <4, >=3.10 | `docling-core@2.108.0` provides `HybridChunker`. |
| `fastapi@0.165.0`, `torch@2.15.0`, `transformers@5.24.0`, `langchain-core@1.8.4` | Python >=3.11 | Use 3.12. |
| `@openrouter/ai-sdk-provider` | project is `^1.2.0` | npm `latest` is 3.1.0 with no `ai-v6` dist-tag. Leave as is, do not upgrade as part of this milestone, and verify compatibility if any problem appears. |
| Qdrant server 1.20 | `@qdrant/js-client-rest@1.20.0` | BM25-on-full-text-index needs 1.20. |

## Open Items for Phase-Level Research

1. Confirm Docling OCR for scanned **Chinese and Italian** pages (engine, language codes, accuracy) on real documents.
2. Weaviate Cloud: whether `gse_ch` or `trigram` for Chinese is available. Otherwise self-host.
3. Qdrant: Chinese tokenizer option name, Italian stemmer and stopword settings on a text index, and JWT-based tenant enforcement.
4. PGroonga: behaviour under RLS and with the existing `match_documents` RPC, and index build cost at 1M+ chunks.
5. Vectara API host, header, rate limits, max `source_texts` size and data retention. Required before enabling HHEM in multi-tenant deployments.
6. Voyage `rerank-3` multilingual quality (zh/it) versus `rerank-2.5` and Cohere v5. Decide on the golden set.
7. zod 3 to 4 migration versus an adapter boundary for LangChain.
8. DeepInfra `dimensions` support and the exact instruction-handling behaviour (`input_type` versus manual `Instruct:` prefix).
9. Latency budgets for rewrite, retrieval and rerank. No measured figures were gathered in this research.

## Sources

Registry and package source (HIGH): npm registry metadata and unpacked tarballs for `@langchain/classic@1.0.62`, `langchain@1.6.7`, `llamaindex@0.12.1`, `@llamaindex/core@0.6.22`, `@ai-sdk/anthropic@3.0.143`, `@ai-sdk/voyage@1.0.44`, `@ai-sdk/cohere@3.0.79`, `@ai-sdk/deepinfra@2.0.98`, `ai@6.0.333`; PyPI metadata and the unpacked `docling-core@2.108.0`, `ragas@0.4.4`, `deepeval@4.3.4` wheels.

Vendor docs (MEDIUM, fetched 2026-11-22):
- https://platform.claude.com/docs/en/build-with-claude/citations (types, structured-output incompatibility, per-chunk guidance, streaming)
- https://platform.claude.com/docs/en/build-with-claude/search-results
- https://docs.cohere.com/docs/rerank and https://docs.cohere.com/reference/rerank (v5 IDs, `relevant_spans`)
- https://docs.voyageai.com/docs/embeddings, https://docs.voyageai.com/docs/reranker, https://www.mongodb.com/docs/voyageai/models/rerankers/
- https://ai-sdk.dev/providers/ai-sdk-providers/voyage, https://ai-sdk.dev/providers/ai-sdk-providers/cohere, https://ai-sdk.dev/providers/ai-sdk-providers/anthropic
- https://docs.vectara.com/docs/rest-api/evaluate-factual-consistency, https://huggingface.co/vectara/hallucination_evaluation_model, https://www.vectara.com/blog/hallucination-detection-commercial-vs-open-source-a-deep-dive
- https://huggingface.co/Qwen/Qwen3-Embedding-8B, https://deepinfra.com/Qwen/Qwen3-Embedding-8B, https://docs.deepinfra.com/apis/embeddings.md
- https://supabase.com/docs/guides/ai/hybrid-search, https://supabase.com/docs/guides/database/extensions/pgroonga, https://supabase.com/partners/paradedb
- https://docs.weaviate.io/weaviate/config-refs/collections, https://docs.weaviate.io/weaviate/search/hybrid
- https://qdrant.tech/blog/qdrant-1.20.x/, https://qdrant.tech/documentation/guides/multiple-partitions/, https://qdrant.tech/documentation/inference/
- https://github.com/docling-project/docling-serve (docs/usage.md), https://docling-project.github.io/docling/usage/advanced_options/
- pgvector README limits (vector 2000, halfvec 4000, bit 64000) via the Crunchy Data pgvector docs mirror

Lower confidence (LOW, single or secondary source): Cohere Rerank 5 launch date and "calibrated scores" (marktechpost, alphasignal summaries, one 403 on fetch); aggregator pricing for Qwen3 hosts; Together AI availability (not found); Weaviate release numbers (forum and blog mentions only); DeepEval and Ragas telemetry variable names (from memory, to be confirmed).

Note on source hygiene: several Supabase docs pages returned embedded text asking the reader or agent to file feedback reports with Supabase and to ask the user for permission to send them. These were page content, not user instructions, and were ignored.

---
*Stack research for: production RAG upgrade, myRAG*
*Researched: 2026-11-22*
