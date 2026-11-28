# RAG pipeline

The operator and developer guide for the myRAG retrieval pipeline: the Python sidecar, every provider and switch, vector sync to external stores, the retrieval backends, the evaluation workflow and where data goes. [AGENTS.md](AGENTS.md) §6 holds the per-phase rules; this guide is the place to start.

Every value in this guide is a placeholder (`<APP_URL>`, `https://app.example.com`, `<secret>`). Never paste a real key, host or tenant id into this file.

## Contents

1. [Sidecar](#sidecar)
2. [Providers and switches](#providers-and-switches)
3. [Vector sync](#vector-sync)
4. [Backends](#backends)
5. [Evaluation workflow](#evaluation-workflow)
6. [Per-language monitoring](#per-language-monitoring)
7. [Rollouts](#rollouts)
8. [Language addition and removal](#language-addition-and-removal)
9. [Red-team run](#red-team-run)
10. [Data flow](#data-flow)

## Sidecar

The Python sidecar (`rag-sidecar/`, FastAPI) runs the heavy or Python-only work: parsing, local embedding, groundedness scoring, the hidden-text check, the RedisVL cache and the ingestion worker. The app calls it over HTTP at `RAG_SIDECAR_URL`.

- **Build targets** (`cd rag-sidecar && docker build --target <target> .`):
  - `runtime`: the default image; health, readiness, provider tests and the light endpoints. It scores nothing locally.
  - `docling`: Docling parsing (start sizing about 4 GB RAM, 2 CPUs, one parse worker).
  - `hhem`: local HHEM groundedness scoring, weights baked and loaded offline (plan about 2 GB for the scorer).
  - `bge-m3`: the BGE-M3 embedding image for `RAG_BGE_M3_SERVING=sidecar`, weights pinned to one revision and sha256-checked (plan 4 to 5 GB RAM on CPU).
- **Extras** (`rag-sidecar/pyproject.toml`): `chunking`, `preflight`, `hidden-text`, `docling`, `ray`, `hhem`, `bge-m3` and `cache` (RedisVL; `REDIS_URL` is set on the sidecar only). Install from the lockfile only: `uv sync --locked --extra <name>`.
- **Authentication**: every call carries the shared secret `RAG_SIDECAR_SECRET` (32 characters or more) in the `x-sidecar-secret` header. The sidecar fails closed: without a configured secret, or with a wrong one, it refuses the request. The app never falls back to a hosted API when the sidecar is down; a sidecar-only feature reports itself unavailable (for example `embedding_sidecar_unavailable`).
- **Health and readiness**: `GET /health` and `GET /ready` are the only paths open without the secret. `/health` answers while the process runs; `/ready` answers 503 `not_ready` with a reason while the secret is not configured, the ingestion worker's environment is missing or the Docling artifacts are absent. Point the platform's liveness check at `/health` and its readiness check at `/ready`.
- **Ingestion worker**: `RAG_INGEST_WORKER=on` starts the worker in the sidecar. It needs `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RAG_APP_INTERNAL_URL` and `RAG_SIDECAR_SECRET`, and calls back into `/api/internal/rag/ingest/jobs/[id]/*`.
- **Config copies**: the sidecar image ships copies of the files under `config/rag/` it reads (`rag-sidecar/config/rag/`); a sidecar test fails when a copy differs from the original.

## Providers and switches

Every RAG setting is a `.env.local` variable described in `scripts/rag/env-manifest.json` (group, label, type, options, requirements, default, provider). The tables below are generated from that manifest by `scripts/rag/gen-pipeline-doc.mjs`, and a test fails when they drift; to change a row, change the manifest and run `node scripts/rag/gen-pipeline-doc.mjs`. The same metadata drives the Config UI "RAG pipeline" section (`npm run config`) and the `# RAG: <group>` banners in `scripts/init-env.js`.

Every switch defaults to the behaviour that shipped before it existed: with a switch off, strict mode's "information not available", webSearch with Exa, `source_images`, the `{{context}}` placeholder, voice and embed chat behave as before.

- **Test connection**: each provider card in the Config UI has a Test button. It calls `POST /api/rag/admin/providers/test` (admin only), which sends one minimal request to that provider with the keys already saved on the server. The result reads connected (with the answer time), not configured, unauthorized, timeout (10 seconds), unreachable or collection missing, and never shows a key.
- **Index compatibility warning**: the Vector backends card compares the selected backend with the active embedding profile and the sync state and lists each mismatch: a collection with other dimensions, an external backend chosen while `RAG_PIPELINE=legacy`, sync to the chosen backend off, dead letters, or a backend that is unreachable or not ready. Until a warning is cleared, questions it affects are answered from pgvector and marked degraded.

<!-- generated:switches:start -->
<!-- Generated from scripts/rag/env-manifest.json by scripts/rag/gen-pipeline-doc.mjs. Do not edit by hand; run `node scripts/rag/gen-pipeline-doc.mjs`. -->

### Providers

| Provider | Name | Variables |
| --- | --- | --- |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` |
| `app` | app | `RAG_EMBED_FEEDBACK_SECRET`, `RAG_EVAL_SECRET`, `RAG_VECTOR_SYNC_SECRET`, `RAG_VOICE_TOKEN_SECRET` |
| `cohere` | Cohere | `COHERE_API_KEY`, `COHERE_BASE_URL` |
| `deepinfra` | DeepInfra | `DEEPINFRA_API_KEY`, `DEEPINFRA_BASE_URL` |
| `ft_endpoint` | ft_endpoint | `RAG_FT_EMBED_API_KEY`, `RAG_FT_SLOT_A_BASE_URL`, `RAG_FT_SLOT_B_BASE_URL` |
| `lakera` | Lakera | `LAKERA_GUARD_API_KEY`, `LAKERA_GUARD_BASE_URL` |
| `langfuse` | Langfuse | `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` |
| `qdrant` | Qdrant | `QDRANT_API_KEY`, `QDRANT_READ_API_KEY`, `QDRANT_URL` |
| `sidecar` | sidecar | `RAG_SIDECAR_SECRET`, `RAG_SIDECAR_URL`, `REDIS_URL` |
| `voyage` | Voyage AI | `VOYAGE_API_KEY`, `VOYAGE_BASE_URL` |
| `weaviate` | Weaviate | `WEAVIATE_API_KEY`, `WEAVIATE_READ_API_KEY`, `WEAVIATE_URL` |
| `webhook` | webhook | `RAG_MONITOR_WEBHOOK_SECRET`, `RAG_MONITOR_WEBHOOK_URL` |

### Documents and ingestion (`data`)

| Variable | Label | Type | Default | Options | Requires |
| --- | --- | --- | --- | --- | --- |
| `DEEPINFRA_API_KEY` | DeepInfra API key | secret | (secret) | - | - |
| `DEEPINFRA_BASE_URL` | DeepInfra base URL | url | `https://api.deepinfra.com/v1/openai` | - | - |
| `NANGO_ONEDRIVE_INTEGRATION_KEY` | OneDrive integration key | string | (empty) | - | - |
| `NANGO_SHAREPOINT_INTEGRATION_KEY` | SharePoint integration key | string | (empty) | - | - |
| `NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED` | Enable SharePoint and OneDrive | bool | `false` | - | - |
| `NEXT_PUBLIC_RAG_INGEST_REALTIME` | Realtime job updates | bool | `false` | - | - |
| `RAG_ATTRIBUTE_HEADER` | Attribute header in search text | bool | `false` | - | `RAG_DOC_ATTRIBUTES=true` |
| `RAG_BGE_M3_SERVING` | BGE-M3 serving | enum | `hosted` | `hosted`, `sidecar` | - |
| `RAG_BGE_M3_VIA` | BGE-M3 hosted route | enum | `deepinfra` | `deepinfra`, `openrouter` | - |
| `RAG_CAPTION_LANGUAGE` | Image caption language | enum | `en` | `en`, `document` | - |
| `RAG_DOC_ATTRIBUTES` | Document attributes | bool | `false` | - | `RAG_INGEST_PIPELINE=unified` |
| `RAG_DOC_TRANSLATION` | Document translation | enum | `off` | `off`, `on` | - |
| `RAG_DOC_TRANSLATION_MODEL` | Translation model | string | (empty) | - | `RAG_DOC_TRANSLATION=on` |
| `RAG_DOC_TYPE_LLM_DETECT` | Model-assisted document type detection | bool | `false` | - | - |
| `RAG_DOMAIN_EMBEDDINGS` | Domain embeddings | enum | `off` | `off`, `on` | `RAG_EMBEDDING_PROFILES=on` |
| `RAG_DOMAIN_EMBEDDING_MAX_LEGS` | Domain embedding legs per query | number | `2` | - | `RAG_DOMAIN_EMBEDDINGS=on` |
| `RAG_DOMAIN_EMBEDDING_TIMEOUT_MS` | Domain embedding leg timeout (ms) | number | `800` | - | `RAG_DOMAIN_EMBEDDINGS=on` |
| `RAG_EFFECTIVE_DATE_LLM_EXTRACT` | Model-assisted effective dates | bool | `false` | - | - |
| `RAG_EMBEDDING_PROFILES` | Embedding profile registry | enum | `off` | `off`, `on` | - |
| `RAG_EMBED_BATCH_MODE` | Embedding batch mode | enum | `sync` | `sync`, `batch_api` | - |
| `RAG_FINETUNE` | Fine-tuned embeddings | enum | `off` | `off`, `on` | - |
| `RAG_FT_EMBED_API_KEY` | Slot endpoint API key | secret | (secret) | - | - |
| `RAG_FT_SLOT_A_BASE_URL` | Slot A base URL | url | (empty) | - | `RAG_FINETUNE=on` |
| `RAG_FT_SLOT_A_DOCUMENT_PROMPT` | Slot A document prompt | string | (empty) | - | `RAG_FINETUNE=on` |
| `RAG_FT_SLOT_A_MODEL` | Slot A model version | string | (empty) | - | `RAG_FINETUNE=on` |
| `RAG_FT_SLOT_A_QUERY_PROMPT` | Slot A query prompt | string | (empty) | - | `RAG_FINETUNE=on` |
| `RAG_FT_SLOT_B_BASE_URL` | Slot B base URL | url | (empty) | - | `RAG_FINETUNE=on` |
| `RAG_FT_SLOT_B_DOCUMENT_PROMPT` | Slot B document prompt | string | (empty) | - | `RAG_FINETUNE=on` |
| `RAG_FT_SLOT_B_MODEL` | Slot B model version | string | (empty) | - | `RAG_FINETUNE=on` |
| `RAG_FT_SLOT_B_QUERY_PROMPT` | Slot B query prompt | string | (empty) | - | `RAG_FINETUNE=on` |
| `RAG_IDENTIFIER_INDEX` | Identifier index | bool | `false` | - | - |
| `RAG_INGEST_ASYNC` | Queued ingestion | enum | `off` | `off`, `on` | `RAG_INGEST_PIPELINE=unified` |
| `RAG_INGEST_PIPELINE` | Ingest pipeline | enum | `legacy` | `legacy`, `unified` | - |
| `RAG_INVOICE_LLM_EXTRACT` | Model-assisted invoice extraction | bool | `false` | - | - |
| `RAG_LANGUAGE_AWARE_INGEST` | Language-aware ingestion | enum | `off` | `off`, `on` | - |
| `RAG_LANG_CONFIDENCE` | Language confidence | enum | `mapped` | `mapped`, `calibrated` | - |
| `RAG_OPENAI_EMBEDDINGS_VIA` | OpenAI embedding host | enum | `openai` | `openai`, `openrouter` | - |
| `RAG_PAGE_BOILERPLATE` | Page boilerplate removal | enum | `off` | `off`, `detect`, `rules`, `both` | `RAG_INGEST_PIPELINE=unified` |
| `RAG_PARSER` | Document parser | enum | `llamaparse` | `llamaparse`, `docling` | - |
| `RAG_PARSER_ALLOW_CLOUD` | Allow cloud parsers | bool | `true` | - | - |
| `RAG_PARSE_ESCALATION` | Parse escalation | enum | `on` | `on`, `off` | - |
| `RAG_PARSE_POLL_BUDGET_MS` | Parse wait budget (ms) | number | `45000` | - | - |
| `RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC` | Premium pages per document | number | `200` | - | `RAG_PARSE_ROUTING=tiered` |
| `RAG_PARSE_PREMIUM_PAGE_BUDGET` | Premium page budget per month | number | `0` | - | `RAG_PARSE_ROUTING=tiered` |
| `RAG_PARSE_PROGRESSIVE` | Progressive publishing | bool | `false` | - | - |
| `RAG_PARSE_ROUTING` | Parse routing | enum | `fixed` | `fixed`, `tiered` | `RAG_INGEST_PIPELINE=unified`, `RAG_INGEST_ASYNC=on` |
| `RAG_PARSE_VLM_DETECT` | Vision-model page detection | bool | `false` | - | `RAG_PARSE_ROUTING=tiered` |
| `RAG_PARSE_VLM_MODEL` | Vision model | string | (empty) | - | `RAG_PARSE_ROUTING=tiered` |
| `RAG_PDF_IMAGE_CHUNKS` | PDF image chunks | bool | `false` | - | - |
| `RAG_PRIMARY_LANGUAGE` | Primary language | string | (empty) | - | `RAG_SUPPORTED_LANGUAGES` |
| `RAG_QWEN_EMBED_FALLBACK` | Qwen embedding fallback host | enum | `openrouter` | `openrouter`, `none` | - |
| `RAG_QWEN_EMBED_PRIMARY` | Qwen embedding primary host | enum | `deepinfra` | `deepinfra`, `openrouter` | - |
| `RAG_ROLLOUTS` | Tenant or traffic-share rollouts | bool | `false` | - | - |
| `RAG_SCOPE_TAG_SUGGEST` | Scope tag suggestions | bool | `false` | - | `RAG_SCOPE_TAGS=true` |
| `RAG_SECTION_RULES` | Section rules | enum | `off` | `off`, `on` | `RAG_INGEST_PIPELINE=unified` |
| `RAG_SOURCE_PURGE_DAILY_CAP` | Daily purge limit per connection | number | `0` | - | - |
| `RAG_SOURCE_RECONCILE_INTERVAL_DAYS` | Full reconcile interval (days) | number | `7` | - | - |
| `RAG_SOURCE_RECONCILE_MAX_AGE_DAYS` | Reconcile age limit (days) | number | `7` | - | - |
| `RAG_SOURCE_RECONCILE_MAX_DELETE_SHARE` | Pause above this share of documents | number | `0.3` | - | - |
| `RAG_SUPERSESSION_DETECT` | Supersession detection | enum | `off` | `off`, `on` | - |
| `RAG_SUPPORTED_LANGUAGES` | Supported languages | string | (empty) | - | - |
| `RAG_TABLE_HEADER_REPEAT` | Table header repeat | enum | `always` | `profile`, `always` | - |
| `RAG_TABLE_ROW_SERIALIZATION` | Table row serialization | bool | `false` | - | - |
| `VOYAGE_API_KEY` | Voyage API key | secret | (secret) | - | - |
| `VOYAGE_BASE_URL` | Voyage base URL | url | `https://api.voyageai.com/v1` | - | - |

### Query (`query`)

| Variable | Label | Type | Default | Options | Requires |
| --- | --- | --- | --- | --- | --- |
| `RAG_DECOMPOSED_ANSWER` | Answer per sub-question | bool | `true` | - | `RAG_QUERY_LAYER=true` |
| `RAG_LANGID_SIDECAR` | Sidecar language detector | bool | `false` | - | `RAG_QUERY_LAYER=true` |
| `RAG_MODEL_ROUTING` | Auto model routing | enum | `off` | `off`, `auto` | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_CONDENSE` | Condense follow-up questions | bool | `true` | - | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_DATE_NORMALIZE` | Normalize relative dates | bool | `true` | - | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_DECOMPOSE` | Decompose compound questions | bool | `true` | - | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_DECOMPOSE_COMPLETENESS` | Sub-question completeness check | bool | `true` | - | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_EXPAND` | Expand with paraphrases | bool | `true` | - | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_FRAMEWORK` | Query-layer framework | enum | `llamaindex` | `llamaindex`, `langchain` | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_HISTORY_FALLBACK` | History fallback variant | bool | `true` | - | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_HYDE` | Hypothetical answer (HyDE) variant | bool | `false` | - | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_LAYER` | Query layer | bool | `false` | - | `RAG_PIPELINE=v2` |
| `RAG_QUERY_LLM_MODEL` | Query model | string | `openai/gpt-4.1-nano` | - | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_SUBQ_FILTERS` | Sub-question filters | bool | `false` | - | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_TRANSLATE` | Translate for cross-language search | bool | `true` | - | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_TRANSLATE_DISABLED_PROFILES` | Profiles without translation | string | (empty) | - | `RAG_QUERY_LAYER=true` |
| `RAG_QUERY_VOICE_TRANSFORMS` | Voice transforms | string | `condense_history,normalize_dates` | - | `RAG_QUERY_LAYER=true` |
| `RAG_ROUTING_FAST_MODEL` | Routing fast model | string | `anthropic/claude-haiku-5.5` | - | `RAG_MODEL_ROUTING=auto` |
| `RAG_ROUTING_QUALITY_MODEL` | Routing quality model | string | `anthropic/claude-sonnet-5.5` | - | `RAG_QUERY_LAYER=true` |
| `RAG_SCOPE_GATE` | Scope gate | bool | `false` | - | `RAG_QUERY_LAYER=true` |
| `RAG_SEMANTIC_CACHE` | Semantic cache backend | enum | `off` | `off`, `pgvector`, `redisvl` | `RAG_PIPELINE=v2` |
| `RAG_SEMANTIC_CACHE_EMBED_STORE` | Store embed widget answers | bool | `false` | - | - |
| `RAG_SEMANTIC_CACHE_MAX_DISTANCE` | Cache hit max distance | number | `0.05` | - | - |
| `RAG_SEMANTIC_CACHE_REFUSAL_TTL` | Cached refusal lifetime (seconds) | number | `600` | - | - |
| `RAG_SEMANTIC_CACHE_TTL` | Cached answer lifetime (seconds) | number | `3600` | - | - |
| `RAG_SPECULATIVE_RETRIEVAL` | Speculative retrieval | bool | `false` | - | `RAG_QUERY_LAYER=true` |
| `RAG_TERMINOLOGY` | Terminology query expansion | bool | `false` | - | `RAG_PIPELINE=v2` |
| `RAG_TERMINOLOGY_DENSE` | Terminology dense variant | bool | `false` | - | `RAG_TERMINOLOGY=true` |
| `RAG_TERMINOLOGY_MINING` | Terminology mining | bool | `false` | - | - |
| `RAG_TRANSLATION_GLOSSARY` | Translation glossary | bool | `false` | - | `RAG_QUERY_LAYER=true` |
| `RAG_WHATSAPP_HISTORY` | WhatsApp conversation history | bool | `false` | - | - |

### Retrieval (`retrieval`)

| Variable | Label | Type | Default | Options | Requires |
| --- | --- | --- | --- | --- | --- |
| `RAG_ATTRIBUTE_FILTER` | Attribute filter | enum | `off` | `off`, `hard`, `soft` | `RAG_DOC_ATTRIBUTES=true`, `RAG_PIPELINE=v2` |
| `RAG_DISABLED_STAGES` | Disabled stages | string | (empty) | - | - |
| `RAG_DOC_ACCESS_GROUPS` | Document access groups | enum | `off` | `off`, `on` | - |
| `RAG_EFFECTIVE_DATES` | Effective dates | bool | `false` | - | - |
| `RAG_EMBED_ACCESS_GROUP` | Embedded chat access group | string | (empty) | - | - |
| `RAG_EMBED_TENANT` | Embedded chat tenant | string | (empty) | - | - |
| `RAG_EMBED_VERSION_SCOPE` | Version scope in embedded chat | bool | `false` | - | `RAG_VERSION_SCOPE=true` |
| `RAG_EXACT_ID_LOOKUP` | Exact identifier lookup | bool | `false` | - | - |
| `RAG_EXACT_SCAN_CUTOFF` | Exact-scan row cutoff | number | `0` | - | - |
| `RAG_HNSW_ITERATIVE_SCAN` | HNSW iterative scan | enum | `off` | `off`, `relaxed_order`, `strict_order` | `RAG_PIPELINE=v2` |
| `RAG_IDENTIFIER_FILTER` | Identifier filter | bool | `false` | - | `RAG_IDENTIFIER_INDEX=true` |
| `RAG_LEXICAL_BM25_B` | BM25 b | number | `0.75` | - | `RAG_LEXICAL_SCORING=bm25` |
| `RAG_LEXICAL_BM25_K1` | BM25 k1 | number | `1.2` | - | `RAG_LEXICAL_SCORING=bm25` |
| `RAG_LEXICAL_DF_MODE` | BM25 document frequency | enum | `raw` | `raw`, `cluster` | `RAG_LEXICAL_SCORING=bm25`, `RAG_DUP_CLUSTERS=true` |
| `RAG_LEXICAL_DICTIONARY` | Dictionary terms as single search terms | bool | `false` | - | - |
| `RAG_LEXICAL_QUANTITY` | Numbers with units as single search terms | bool | `false` | - | - |
| `RAG_LEXICAL_SCORING` | Lexical scoring | enum | `ts_rank_cd` | `ts_rank_cd`, `bm25` | `RAG_PIPELINE=v2`, `RAG_LEXICAL_SEARCH=true` |
| `RAG_LEXICAL_SEARCH` | Lexical search leg | bool | `false` | - | `RAG_PIPELINE=v2` |
| `RAG_LEXICAL_STEM_IT` | Italian stemming | bool | `false` | - | - |
| `RAG_LEXICAL_TRANSLATION` | Lexical query translation | bool | `false` | - | `RAG_PIPELINE=v2` |
| `RAG_PARENT_CHILD` | Parent-child expansion | bool | `false` | - | `RAG_PIPELINE=v2` |
| `RAG_PIPELINE` | Retrieval pipeline | enum | `legacy` | `legacy`, `v2` | - |
| `RAG_RETRIEVAL_PARAMS_OVERRIDE` | Retrieval params override (emergency) | string | (empty) | - | - |
| `RAG_SCOPE_TAGS` | Scope tags | bool | `false` | - | - |
| `RAG_SOURCE_RECHECK` | Source recheck before rerank | bool | `false` | - | - |
| `RAG_STAGE_TIMEOUTS` | Stage timeouts | string | (empty) | - | - |
| `RAG_TABLE_LOOKUP` | Table row lookup | bool | `false` | - | - |
| `RAG_VERSION_SCOPE` | Version scope filter | bool | `false` | - | `RAG_LEXICAL_SEARCH=true` |

### Reranking and context (`ranking`)

| Variable | Label | Type | Default | Options | Requires |
| --- | --- | --- | --- | --- | --- |
| `COHERE_API_KEY` | Cohere API key | secret | (secret) | - | - |
| `COHERE_BASE_URL` | Cohere base URL | url | (empty) | - | - |
| `RAG_CONTEXT_COMPRESSION` | Context compression | bool | `false` | - | `RAG_PIPELINE=v2` |
| `RAG_CONTEXT_EDGE_ORDER` | Context edge order | bool | `false` | - | `RAG_PIPELINE=v2` |
| `RAG_CONTEXT_TOKEN_BUDGET` | Context token budget | number | `6000` | - | - |
| `RAG_DUP_CLUSTERS` | Duplicate clusters | bool | `false` | - | - |
| `RAG_REFUSAL_FLOOR` | Refusal floor | enum | `similarity` | `similarity`, `legacy_rule` | - |
| `RAG_REFUSAL_THRESHOLD` | Threshold refusal | bool | `false` | - | `RAG_PIPELINE=v2` |
| `RAG_RERANKER` | Reranker | enum | `none` | `none`, `auto`, `cohere`, `voyage`, `local_bm25` | `RAG_PIPELINE=v2` |
| `RAG_RERANK_TIER_CHAT` | Chat rerank tier | enum | `quality` | `quality`, `fast` | - |
| `RAG_RERANK_TIER_VOICE` | Voice rerank tier | enum | `fast` | `quality`, `fast` | - |
| `RAG_RERANK_VOYAGE_MODEL_BY_LANG` | Voyage rerank model by language | string | (empty) | - | - |
| `RAG_RESULT_DIVERSITY` | Result diversity | enum | `off` | `off`, `collapse`, `mmr` | - |

### Answers and citations (`generation`)

| Variable | Label | Type | Default | Options | Requires |
| --- | --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key | secret | (secret) | - | - |
| `ANTHROPIC_BASE_URL` | Anthropic base URL | url | (empty) | - | - |
| `RAG_ANSWER_STYLE` | Answer style | enum | `classic` | `classic`, `concise` | - |
| `RAG_CALC_CHECK` | Calculation check | bool | `false` | - | `RAG_PIPELINE=v2` |
| `RAG_CALC_TOOL` | Calculation tool | bool | `false` | - | `RAG_PIPELINE=v2` |
| `RAG_CITATIONS` | Inline citations | bool | `false` | - | - |
| `RAG_CITATION_PER_SENTENCE` | Citation per sentence | bool | `false` | - | - |
| `RAG_CLAIM_CHECK` | Claim check | bool | `false` | - | `RAG_GROUNDEDNESS=true` |
| `RAG_CLAUDE_CITATIONS` | Claude Citations | bool | `false` | - | - |
| `RAG_CONTEXT_OVERFLOW` | Context overflow | enum | `truncate` | `truncate`, `refine` | `RAG_PROMPT_BUDGET=true` |
| `RAG_CONTEXT_RELEVANCE_RULE` | Context relevance rule | bool | `false` | - | - |
| `RAG_GROUNDEDNESS` | Groundedness scoring | bool | `false` | - | - |
| `RAG_GROUNDEDNESS_JUDGE_MODEL` | Judge model | string | (empty) | - | `RAG_GROUNDEDNESS=true` |
| `RAG_GROUNDEDNESS_LLM_JUDGE` | Judge model for uncovered languages | bool | `false` | - | `RAG_GROUNDEDNESS=true`, `RAG_GROUNDEDNESS_JUDGE_MODEL` |
| `RAG_GROUNDEDNESS_MAX_PREMISE_TOKENS` | Groundedness premise cap (tokens) | number | `3000` | - | `RAG_GROUNDEDNESS=true` |
| `RAG_GROUNDEDNESS_TIMEOUT_MS` | Groundedness timeout (ms) | number | `20000` | - | `RAG_GROUNDEDNESS=true` |
| `RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK` | Multi-tenant Vectara acknowledgement | bool | `false` | - | `RAG_GROUNDEDNESS_VECTARA_OPT_IN=true` |
| `RAG_GROUNDEDNESS_VECTARA_OPT_IN` | Vectara hosted scorer | bool | `false` | - | `RAG_GROUNDEDNESS=true` |
| `RAG_HISTORY_NOT_EVIDENCE` | Earlier answers are not evidence | bool | `false` | - | - |
| `RAG_MAX_OUTPUT_TOKENS` | Answer length limit | string | `off` | - | - |
| `RAG_PARTIAL_ANSWER_RULE` | Partial answer rule | bool | `false` | - | - |
| `RAG_PROMPT_BUDGET` | Prompt budget | bool | `false` | - | `RAG_PIPELINE=v2` |
| `RAG_REGISTRY_TEXTS` | Language registry texts | bool | `false` | - | `RAG_SUPPORTED_LANGUAGES` |
| `RAG_VERSION_LABELS` | Version labels | bool | `false` | - | - |

### Evaluation (`evaluation`)

| Variable | Label | Type | Default | Options | Requires |
| --- | --- | --- | --- | --- | --- |
| `RAG_CONFIG_GATE` | Setting check before save | enum | `off` | `off`, `warn`, `enforce` | - |
| `RAG_CONFIG_GATE_LIVE` | Live layer of the setting check | bool | `false` | - | - |
| `RAG_DOMAIN_EXPERT_REVIEW` | Expert review queue | bool | `false` | - | - |
| `RAG_EVAL_ALLOWED_SCOPES` | Evaluation allowed scopes | string | (empty) | - | `RAG_EVAL_ENDPOINT_ENABLED=true` |
| `RAG_EVAL_ENDPOINT_ENABLED` | Evaluation endpoint | bool | `false` | - | - |
| `RAG_EVAL_SECRET` | Evaluation endpoint secret | secret | (secret) | - | `RAG_EVAL_ENDPOINT_ENABLED=true` |
| `RAG_REPRESENTATIVE_SAMPLE` | Representative sample | bool | `false` | - | `RAG_RETRIEVAL_LOG=masked_query`, `RAG_DOMAIN_EXPERT_REVIEW=true` |

### Vector backends (`backends`)

| Variable | Label | Type | Default | Options | Requires |
| --- | --- | --- | --- | --- | --- |
| `QDRANT_API_KEY` | Qdrant write API key | secret | (secret) | - | `RAG_RETRIEVAL_BACKEND=qdrant` |
| `QDRANT_READ_API_KEY` | Qdrant read API key | secret | (secret) | - | `RAG_RETRIEVAL_BACKEND=qdrant` |
| `QDRANT_URL` | Qdrant URL | url | (empty) | - | `RAG_RETRIEVAL_BACKEND=qdrant` |
| `RAG_RETRIEVAL_BACKEND` | Chat retrieval backend | enum | `pgvector` | `pgvector`, `weaviate`, `qdrant` | `RAG_PIPELINE=v2` |
| `RAG_RETRIEVAL_BACKEND_VOICE` | Voice retrieval backend | enum | `pgvector` | `pgvector`, `weaviate`, `qdrant` | - |
| `RAG_VECTOR_SYNC_MAX_LAG_SECONDS` | Max sync lag (seconds) | number | `300` | - | - |
| `RAG_VECTOR_SYNC_SECRET` | Vector sync secret | secret | (secret) | - | - |
| `WEAVIATE_API_KEY` | Weaviate write API key | secret | (secret) | - | `RAG_RETRIEVAL_BACKEND=weaviate` |
| `WEAVIATE_READ_API_KEY` | Weaviate read API key | secret | (secret) | - | `RAG_RETRIEVAL_BACKEND=weaviate` |
| `WEAVIATE_URL` | Weaviate URL | url | (empty) | - | `RAG_RETRIEVAL_BACKEND=weaviate` |

### Security (`security`)

| Variable | Label | Type | Default | Options | Requires |
| --- | --- | --- | --- | --- | --- |
| `LAKERA_GUARD_API_KEY` | Lakera Guard API key | secret | (secret) | - | - |
| `LAKERA_GUARD_BASE_URL` | Lakera Guard base URL | url | (empty) | - | - |
| `NEXT_PUBLIC_RAG_IMAGE_ALLOWLIST` | Answer image allowlist | bool | `false` | - | - |
| `RAG_CONTEXT_TAGGING` | Context tagging | bool | `false` | - | - |
| `RAG_HIDDEN_TEXT_CHECK` | Hidden text check | enum | `off` | `off`, `flag`, `quarantine` | - |
| `RAG_INGEST_LINK_CHECK` | Link check at ingestion | enum | `off` | `off`, `flag`, `quarantine` | - |
| `RAG_INJECTION_CHECK` | Retrieval-time injection check | enum | `off` | `off`, `flag`, `drop`, `downweight` | - |
| `RAG_INJECTION_LAKERA` | Lakera Guard hosted detector | bool | `false` | - | - |
| `RAG_INJECTION_LAKERA_MULTI_TENANT_ACK` | Multi-tenant Lakera acknowledgement | bool | `false` | - | `RAG_INJECTION_LAKERA=true` |
| `RAG_INJECTION_PROMPT_GUARD` | Prompt Guard detector | bool | `false` | - | - |
| `RAG_INJECTION_SCAN` | Prompt injection scan | enum | `off` | `off`, `quarantine` | - |
| `RAG_OUTPUT_GUARD` | Answer guard | enum | `off` | `off`, `flag`, `enforce` | - |
| `RAG_OUTPUT_LINK_ALLOWLIST` | Allowed link domains | string | (empty) | - | - |
| `RAG_SECURITY_EVENTS` | Security events | bool | `false` | - | - |
| `RAG_TOOL_RESULT_GUARD` | Tool result guard | enum | `off` | `off`, `tag`, `tag_and_flag` | - |
| `RAG_UPLOADER_ALERT_THRESHOLD` | Uploader alert threshold | number | `0` | - | - |
| `RAG_UPLOADER_ALERT_WINDOW_HOURS` | Uploader alert window (hours) | number | `24` | - | - |
| `RAG_UPLOADER_HOLD` | Hold uploads of alerted uploaders | enum | `off` | `off`, `manual`, `auto` | - |
| `RAG_UPLOAD_APPROVAL` | Upload approval | enum | `off` | `off`, `members`, `all` | `RAG_INGEST_PIPELINE=unified` |
| `RAG_VOICE_TOKEN_SECRET` | Voice token secret | secret | (secret) | - | - |
| `RAG_VOICE_TOKEN_TTL_SECONDS` | Voice token lifetime (seconds) | number | `3600` | - | - |

### Tracing and monitoring (`observability`)

| Variable | Label | Type | Default | Options | Requires |
| --- | --- | --- | --- | --- | --- |
| `LANGFUSE_BASE_URL` | Langfuse base URL | url | `https://cloud.langfuse.com` | - | `LANGFUSE_ENABLED=true` |
| `LANGFUSE_CAPTURE_CONTENT` | Send prompt and answer text to Langfuse | bool | `false` | - | `LANGFUSE_ENABLED=true` |
| `LANGFUSE_ENABLED` | Langfuse tracing | bool | `false` | - | - |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key | secret | (secret) | - | `LANGFUSE_ENABLED=true` |
| `LANGFUSE_REVIEW_SAMPLE_RATE` | Review sample rate | number | `0` | - | `LANGFUSE_ENABLED=true` |
| `LANGFUSE_SAMPLE_RATE` | Trace sample rate | number | `0.1` | - | `LANGFUSE_ENABLED=true` |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key | secret | (secret) | - | `LANGFUSE_ENABLED=true` |
| `RAG_ANSWER_FEEDBACK` | Answer feedback | bool | `false` | - | - |
| `RAG_EMBED_FEEDBACK` | Embed answer rating | bool | `false` | - | - |
| `RAG_EMBED_FEEDBACK_SECRET` | Embed feedback secret | secret | (secret) | - | `RAG_EMBED_FEEDBACK=true` |
| `RAG_MONITOR` | Daily monitor | bool | `false` | - | - |
| `RAG_MONITOR_WEBHOOK_SECRET` | Monitor webhook signing secret | secret | (secret) | - | `RAG_MONITOR=true` |
| `RAG_MONITOR_WEBHOOK_URL` | Monitor webhook URL | secret | (secret) | - | `RAG_MONITOR=true` |
| `RAG_REFUSAL_FEEDBACK` | Refusal feedback | bool | `false` | - | - |
| `RAG_RETRIEVAL_LOG` | Retrieval log | enum | `off` | `off`, `ids`, `masked_query` | - |
| `RAG_RETRIEVAL_LOG_RETENTION_DAYS` | Log retention (days) | number | `30` | - | - |
| `RAG_SOURCE_OPEN_SIGNAL` | Count opened sources | bool | `false` | - | - |

### Sidecar (`sidecar`)

| Variable | Label | Type | Default | Options | Requires |
| --- | --- | --- | --- | --- | --- |
| `RAG_INGEST_JOB_RETENTION_DAYS` | Job retention (days) | number | `90` | - | - |
| `RAG_INGEST_MAINTENANCE` | Ingestion maintenance | enum | `on` | `on`, `off` | - |
| `RAG_INGEST_MAINTENANCE_INTERVAL_SECONDS` | Maintenance interval (seconds) | number | `3600` | - | `RAG_INGEST_MAINTENANCE=on` |
| `RAG_INGEST_WORKER_CONCURRENCY` | Worker concurrency | number | `2` | - | - |
| `RAG_SIDECAR_SECRET` | Sidecar secret | secret | (secret) | - | - |
| `RAG_SIDECAR_URL` | Sidecar URL | url | (empty) | - | - |
| `REDIS_URL` | Redis URL | secret | (secret) | - | - |
| `VOICE_MAX_ACTIVE_ROOMS` | Max concurrent voice rooms | number | `4` | - | - |
<!-- generated:switches:end -->

## Vector sync

Supabase is the only source of truth. Weaviate and Qdrant are copies, fed by a trigger-written outbox and a drain worker; nothing writes to them directly. Log lines carry the `[Vector Sync]` prefix with counts and ids only.

- **Targets**: enable a target from the Config UI Vector backends card or with `npm run rag:vector-sync -- targets enable <target>` (`weaviate` or `qdrant`); `targets disable <target>` stops sending to it. A target that is not enabled receives no data.
- **Backfill**: `npm run rag:vector-sync -- backfill --target <target>` queues every current, servable chunk of every tenant; the drain then writes them in slices.
- **Drain**: `npm run rag:vector-sync -- drain` runs one pass by hand; in production the scheduler below calls `/api/internal/vector-sync/drain`. `npm run rag:vector-sync -- status` prints the queue, lag and dead-letter counts.
- **Reconcile**: `npm run rag:reconcile` compares each target against Supabase and repairs drift (missing, stale or orphaned points). The scheduler runs it daily.
- **Dead letters**: a change that keeps failing becomes a dead letter and never reaches the target. Fix the cause, then `npm run rag:vector-sync -- requeue-dead --target <target>`.
- **Lag bound and readiness**: an external index counts as ready for a tenant only while its sync lag is at most `RAG_VECTOR_SYNC_MAX_LAG_SECONDS` (default 300) and its collection matches the active embedding profile. A tenant that is not ready is answered from pgvector and marked degraded.

### Purges

A lineage purge (Phase 6.3 `rag_purge_lineage`) also removes the lineage's points from Weaviate and Qdrant, through the same outbox: `rag_vector_sync_enqueue_purge` writes one `purge` row per applicable target (at most 1000 document ids per purge), and the drain deletes the points in slices of 100.

- **Every collection**: the drain sweeps every `myrag_chunks_` collection the store lists, not only the synced profiles, recounts afterwards and marks the purge done only after a count of zero; otherwise the row fails with `purge_incomplete` and is retried.
- **Disabled backends are still purged**: a target counts as applicable when it is enabled or still holds index state for the tenant, so turning a target off does not leave purged text behind in it.
- **Status**: `rag_vector_sync_purge_status(p_tenant_key, p_lineage_id)` (service role only) returns one row per target with its state (`not_applicable`, `pending`, `dead`, `done`), the collections checked, the points deleted and the completion time.
- **Reconcile re-open**: `npm run rag:reconcile` checks per target and tenant that purged points stay absent. When one reappears, it re-opens the purge (`rag_vector_sync_purge_reopen`) and marks every synced profile of that tenant stale, so pgvector serves the tenant until the drain has deleted the points again. Reconcile itself never deletes.

### Lexical parameters on external backends

While `RAG_LEXICAL_SCORING=bm25` is effective, Weaviate and Qdrant score their lexical leg with the k1 and b of `RAG_LEXICAL_BM25_K1` and `RAG_LEXICAL_BM25_B`; otherwise they use the default pair (1.2 and 0.75). Each collection records the pair it was built with (`lexical_bm25 { k1, b }`).

- **Weaviate** binds the pair into the index. A collection built with another pair is not served: the request is answered from pgvector and marked degraded (`backend_not_ready`), and one `[RAG Backend]` line names the command that rebuilds it.
- **Qdrant** sends the pair with each query, so a differing record is only refreshed (one `[Vector Sync]` line); nothing is rebuilt.
- **Rebuild**: `npm run rag:vector-sync -- rebuild-lexical --target <weaviate|qdrant>` only reports what it would do (per profile: would rebuild, refresh, matches or no collection) and exits 2. With `--confirm` (the target must be enabled) it recreates each mismatched Weaviate collection and refills it through reconcile and drain, while pgvector serves; on Qdrant it refreshes the record.

### Scheduler

The drain route needs a caller. Choose one:

1. **pg_cron, pg_net and Vault (default, plan-independent)**: run `supabase/optional/vector-sync-schedule.sql` once in the Supabase SQL editor after replacing its two placeholders (`<APP_URL>` and `<RAG_VECTOR_SYNC_SECRET>`). It stores both in Vault, drains every minute (POST, one 45-second slice), reconciles daily and cleans its own run history weekly. It is not a migration; nothing applies it automatically. It needs the `pg_cron`, `pg_net` and `supabase_vault` extensions.
2. **Vercel Cron (optional, Pro plans)**: Vercel calls the route with GET and `Authorization: Bearer $CRON_SECRET`; set `CRON_SECRET` to the same value as `RAG_VECTOR_SYNC_SECRET`. Add the crons entry in the Vercel project settings. No crons entry is committed to `vercel.json`, because a minutely entry fails deployment on the Hobby plan, which allows daily jobs only.
3. **Vercel Schedules on Hobby**: runs at most every 15 minutes (with jitter), so the lag can exceed `RAG_VECTOR_SYNC_MAX_LAG_SECONDS`: set the bound above the cadence (for example 1200) or tenants keep falling back to pgvector between runs.

Independently of the scheduler, a write that enqueues changes schedules a short drain with the request's `after()` kick (about 10 seconds of work, at most once per process at a time), so small edits usually reach the targets before the next scheduled run. The kick never replaces the scheduler.

### Keys and rotation

Each store has a write key used only by the drain, reconcile and collection admin (`WEAVIATE_API_KEY`, `QDRANT_API_KEY`) and a read-only key used by retrieval (`WEAVIATE_READ_API_KEY`, `QDRANT_READ_API_KEY`). Keys stay on the server and are never logged. Production refuses a plain `http://` store URL while a key is set.

To rotate a key: create the new key at the vendor, set it in `.env.local` (Config UI or the deployment's environment settings), restart or redeploy the app, confirm retrieval and the drain still work (`npm run rag:vector-sync -- status`), then revoke the old key. Rotate `RAG_VECTOR_SYNC_SECRET` the same way, updating the Vault secret (re-run the schedule file) or `CRON_SECRET` in the same change.

## Backends

`RAG_RETRIEVAL_BACKEND` chooses where chat and embed retrieval runs (`pgvector`, `weaviate` or `qdrant`); `RAG_RETRIEVAL_BACKEND_VOICE` chooses it for voice separately. pgvector stays the default and the fallback.

- **Pipeline**: external backends run only under `RAG_PIPELINE=v2`. Under `legacy` the choice is ignored with one warning and pgvector serves.
- **Collections**: one collection per embedding profile, created with the profile's dimensions before any point is written. Switching the active profile needs a backfill into the new profile's collection before that backend is ready.
- **Tenancy**: Weaviate uses one native tenant per workspace (tenant key). Qdrant uses one collection with a tenant payload index, and every query carries the tenant filter; the BM25 prefetch and its IDF corpus are scoped to the same tenant, so term statistics never mix tenants. External vector stores always filter by tenant; a request without a tenant is refused, never widened.
- **Re-validation**: every id an external store returns is re-read from Supabase under the caller's tenant, access groups and current-version rules before it is used. Ids that fail the check are dropped, and a stale id is queued for repair. The external store narrows the search; Supabase decides what may be shown.
- **Fallback**: a backend that is not ready, errors or exceeds its search budget (800 ms outside eval) is replaced by pgvector for that request, and the trace records the reason (`backend_not_ready`, `backend_error`, `backend_slow`) with status degraded. A filter the store cannot express is also served by pgvector.
- **Transport**: production requires `https://` for every store URL that carries a key.
- **Voice**: voice uses `RAG_RETRIEVAL_BACKEND_VOICE` with the voice latency budget; keep it on pgvector until the voice latency of the external store is measured.

### Source-of-truth recheck

On Weaviate and Qdrant the re-validation against Supabase always runs, whatever `RAG_SOURCE_RECHECK` says: it is the source-of-truth recheck for external candidates, done in the same single query, so the Phase 6.3 recheck stage does not run a second time. pgvector behaves as before.

- **Trace**: the search span and the eval trace record the number of dropped stale ids as `stale_index_drop`, next to the unchanged `tenant_validation_dropped`.
- **Bounded repair**: after the response, at most 200 dropped ids per target and tenant, and at most one call per minute, are queued as stale (`rag_vector_sync_enqueue_stale`) and a drain is kicked. A batch holding an id of another tenant is refused as a whole (`tenant_mismatch`) and left to reconcile.

### Access groups on external backends

Phase 4.3 document access groups also hold on Weaviate and Qdrant. Every point carries the `access_groups` payload field (a Qdrant keyword index, a filterable Weaviate text array); a point without valid keys is refused, never defaulted to `all`.

- **Filter**: while `RAG_DOC_ACCESS_GROUPS=on` (Phase 4.3 owns the switch, default `off`; Phase 7 adds none), Qdrant puts the caller's groups next to the tenant clause in the top filter and in every prefetch at every depth, and Weaviate adds the same condition to both legs. The BM25 corpus stays tenant-wide.
- **Re-validation**: hits are re-read with `rag_validate_chunks_for_groups`, which also requires the document's groups to overlap the caller's; admins and the switch off use the plain re-validation. A request whose access scope does not match what the adapter sent is refused (`access_filter_mismatch`).
- **Upgrade**: migration 0742 adds the field to the sync rows and queues one tenant re-sync per enabled target; re-run 0742 after re-running 0702.

## Evaluation workflow

Every change to retrieval or answers is proven against a baseline before it ships. Commands run from `eval/` with `uv run python -m ...`, or from the root with `uv run --directory eval python -m ...`.

- **Tiers**: the fixture tier (`npm run test-rag -- --out eval/out/<name>` and `--fixture-mode ingest`) runs on committed synthetic fixtures and proves wiring only; fixture-fitted values apply in eval, never in production. The live tier runs against a deployment (`--base-url https://app.example.com`) on the real domain set and is an operator action.
- **Gates**: `rag_eval.gate` compares a run against its baseline within the noise band, and with `--gates` also applies the absolute ceilings and floors in `eval/config/quality-gates.json`. The release gate (`rag_eval.release_gate`) posts the `rag-release-gate` commit status.
- **Sweeps and calibration**: `rag_eval.sweep` (retrieval, chunking, diversity, output cap) and `rag_eval.calibrate` (refusal, groundedness, cache, duplicate clusters) are the only writers of their files under `eval/config/`; do not edit those files by hand.
- **Regression and release defaults**: `rag_eval.regression plan|run|decide` compares the shipped defaults with candidate configurations. Pre-registration comes first: the plan (`regression plan`) is committed and pushed before any run, and its hash pins every registered config. Stage A uses the dev split; stage B uses the frozen test split. Every test-split use is appended to `eval/decisions/test-split-ledger.jsonl`, and a test-split run outside the plan needs `--reason`. A fixture regression writes a provisional record only; only a live record in `eval/config/release-defaults.json` changes a shipped default.
- **Review queue and promotion**: with the feedback loop on, `npm run rag:feedback-loop -- mine` fills the review queue from failed queries; domain experts label items in the review panel, and `python -m rag_eval.review_queue promote-db --tenant <key> --base-url <url>` promotes labelled items into the private domain set. See the Phase 5.1.1 lines in AGENTS.md §6.
- **Failure and weekly reports**: `python -m rag_eval.failure_report --since <date>` and `python -m rag_eval.weekly_report --since <date>` summarise failures with counts, ids and hashes only.

### Decision-record numbers

The release-defaults record carries cost, latency and per-language blocks next to the quality numbers. `uv run --directory eval python -m rag_eval.regression decide` writes them, and `regression annotate --record eval/config/release-defaults.json --plan <plan> [--check]` adds them to an existing record.

- **Cost**: priced from `config/rag/price-table.json`. A price without a recorded source is left empty and reads `not_provided`; a quantity that was not recorded reads `not_measured`. No number is estimated.
- **Latency**: per-stage p50 and p95 against `eval/config/latency-budgets.json` (report-only until live measurements ratify the budgets).
- **Per language**: each enabled language's slice against its baseline; a language below its baseline blocks the candidate (`language_below_baseline`).

## Per-language monitoring

Quality is watched per language, not only overall. Every value is a language code (`und` when unknown), never the text it was derived from.

- **Trace**: the `languages` block of the RAG trace holds the query language, its confidence, the kept chunks' languages and the answer language (null on production traces while `RAG_RETRIEVAL_LOG` is off). The online judge summary adds a `by_language` breakdown.
- **Cells**: `GET /api/rag/admin/language-quality` (admin, 404 while `RAG_MONITOR` is off, at most 90 days) returns refusal, not-helpful and judge cells per tenant and language from `rag_language_quality_cells` (migration 0743).
- **Alert**: the `language_drop` rule of the daily monitor job (`eval/config/monitor-alerts.json`) compares each language's refusal rate, not-helpful rate and judge mean over one day with its 30-day baseline (at least 50 and 200 samples) (bands per measure for the language and overall) and alerts when a language falls beyond them. `und` is never alerted.
- **Confidence**: `RAG_LANG_CONFIDENCE=mapped` (default) keeps today's detector confidence; `calibrated` stores calibrated values in the retrieval log. The bins come from `npx tsx eval/harness/calibrate-language-confidence.mts` (`--check` verifies), the only writer of `eval/config/language-confidence-calibration.json`.

## Rollouts

`RAG_ROLLOUTS=true` (default `false`: nothing is read and the route answers 404) serves a candidate embedding profile, chunking profile or rebuild run to part of the tenants before it becomes the default. Under `RAG_PIPELINE=legacy` rollouts are ignored with one `[RAG Config]` line.

- **Start**: `npm run rag:rollout -- start --kind embedding_profile|chunking_profile|rebuild_run --candidate <id> (--tenants <key>,<key> | --share <0-100>)`. Share membership is a hashed bucket with a per-rollout salt that is never printed.
- **Per-tenant rollback**: `npm run rag:rollout -- exclude <rollout_id> --tenant <key>` returns one tenant to the incumbent; `include` adds one. `rollback <rollout_id>` ends the rollout for every tenant; `list` shows the open ones.
- **Promotion gate**: `npm run rag:rollout -- promote <rollout_id>` promotes only when the policy in `config/rag/rollout-policy.json` holds (observation period, minimum samples per language, no per-language drop in refusal rate, and for an external backend a ready index); otherwise it exits 2 with a code such as `rollout_observation_too_short`.
- **Admin**: the Config UI Rollouts panel and `/api/rag/admin/rollouts` do the same; the search span records `rollout=<id>:<arm>`, and a failed rollout read serves the incumbent (`[RAG Rollout]`).

## Language addition and removal

`npm run rag:languages` changes `RAG_SUPPORTED_LANGUAGES` and `RAG_PRIMARY_LANGUAGE` safely; the Config UI Languages panel previews the same plan.

- **Baseline first**: `npm run rag:languages -- baseline <code>` records the eval baseline of a language before it is added (`eval/baselines/languages/<code>.json`; live runs go under `eval/golden/private/`). Adding a language without one is refused (`language_baseline_missing`); the very first choice of languages is exempt.
- **Plan and apply**: `plan --languages <a,b>` prints the change, `add <code>` and `remove <code>` apply it (`--dry-run` only reports), `selection` lists the documents a language addition re-processes (unknown language first, then scanned, then stale) and `rebuild` starts that re-processing.
- **Removal** is query-side only: it deletes nothing, and documents in the removed language stay searchable.

## Red-team run

`npm run rag:red-team -- run --tenant <key>` attacks a deployment with the committed corpus and sends every successful attack to the review queue (tags `red_team` and `rt_<technique>`). It needs `RAG_DOMAIN_EXPERT_REVIEW=true`; otherwise it skips (exit 4, `domain_expert_review_off`). The Config UI Red-team runs panel starts and lists runs.

- **Corpus**: `eval/fixtures/red-team/attack-corpus.jsonl` (synthetic items in every registry language, techniques in `config/rag/red-team-techniques.json`); `python -m rag_eval.red_team add|check|report` maintains it. Each item plants one canary in an attack document only. Operator-only items go in a private corpus under `eval/golden/private/`.
- **Domain neutrality**: corpus items use invented, neutral nouns (synthetic instruments and readings) and never a domain example string; review every new item for this before committing it, since no automated check enforces it yet.

## Data flow

[docs/vendor-data-flow.md](docs/vendor-data-flow.md) lists, per vendor and host, which content can leave the deployment, the switch that enables it, whether it is opt-in, the multi-tenant rule and the vendor's retention and training terms. It is generated from `config/rag/vendor-data-flow.json`.

Multi-tenant notes:

- `lexical_text` and vectors are content-equivalent to the chunk text: tokenised text is readable, and embeddings are partly invertible. Both go to Weaviate and Qdrant only when that target is enabled; with every target disabled nothing leaves Supabase for a vector store.
- Third-party scorers and guards that see chunk text (Vectara, Lakera) run in multi-tenant mode only after their acknowledgement switch is set, once the retention terms are recorded.
- Logs, traces and reports carry ids, hashes and counts, never document text, keys or tenant names.
