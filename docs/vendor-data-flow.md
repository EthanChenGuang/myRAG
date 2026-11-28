# Vendor data flow

<!-- Generated from config/rag/vendor-data-flow.json by scripts/rag/gen-vendor-doc.mjs. Do not edit; run `node scripts/rag/gen-vendor-doc.mjs`. -->

Generated from config/rag/vendor-data-flow.json (ADM-04, D-20). Each row is one external host and the content that can reach it. Content kinds: query, chunk_text, answer, vectors, lexical_text (tokenised text, readable), file_bytes, traces. Vectors are listed as content because embeddings are partly invertible. A switch of "-" means the vendor has no single enabling variable (see the vendor name). Retention and training read to_verify until the live check confirms the vendor terms.

| Vendor | Name | Host | Content | Switch | Opt-in | Multi-tenant | Retention | Training |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `anthropic` | Anthropic (direct Claude Citations answer path) | `api.anthropic.com` | `query`, `chunk_text`, `answer` | `RAG_CLAUDE_CITATIONS` | yes | allowed | to_verify | to_verify |
| `cohere` | Cohere rerank (RAG_RERANKER=cohere, or auto with COHERE_API_KEY set) | `api.cohere.com` | `query`, `chunk_text` | `RAG_RERANKER` | yes | allowed | to_verify | to_verify |
| `deepinfra` | DeepInfra hosted BGE-M3 embeddings (profile bge-m3-1024, RAG_BGE_M3_SERVING=hosted) | `api.deepinfra.com` | `query`, `chunk_text` | `RAG_BGE_M3_SERVING` | yes | allowed | to_verify | to_verify |
| `exa` | Exa web search (per-request webSearch toggle, needs EXA_API_KEY) | `api.exa.ai` | `query` | - | yes | allowed | to_verify | to_verify |
| `ft_endpoint` | Operator fine-tuned embedding endpoint (RAG_FT_SLOT_A/B_BASE_URL; host set by the operator) | `ft-endpoint.operator.invalid` | `query`, `chunk_text` | `RAG_FINETUNE` | yes | allowed | to_verify | to_verify |
| `judge` | Eval LLM judge (operator-run eval harness: OpenRouter judge models, OpenAI embeddings for metrics) | `openrouter.ai` | `query`, `chunk_text`, `answer` | - | yes | allowed | to_verify | to_verify |
| `judge` | Eval LLM judge (operator-run eval harness: OpenRouter judge models, OpenAI embeddings for metrics) | `api.openai.com` | `query`, `chunk_text`, `answer` | - | yes | allowed | to_verify | to_verify |
| `lakera` | Lakera Guard prompt-injection check on retrieved chunks | `api.lakera.ai` | `chunk_text` | `RAG_INJECTION_LAKERA` | yes | requires `RAG_INJECTION_LAKERA_MULTI_TENANT_ACK`=true | to_verify | to_verify |
| `langfuse` | Langfuse tracing (masked query and answer text only with LANGFUSE_CAPTURE_CONTENT=true) | `cloud.langfuse.com` | `traces` | `LANGFUSE_ENABLED` | yes | allowed | to_verify | to_verify |
| `llamacloud` | LlamaCloud LlamaParse document parsing | `api.cloud.llamaindex.ai` | `file_bytes` | `RAG_PARSER_ALLOW_CLOUD` | no | allowed | to_verify | to_verify |
| `openai` | OpenAI embeddings, image captioning and transcription | `api.openai.com` | `query`, `chunk_text`, `file_bytes` | `RAG_OPENAI_EMBEDDINGS_VIA` | no | allowed | to_verify | to_verify |
| `openrouter` | OpenRouter chat generation, query layer and LLM judge models | `openrouter.ai` | `query`, `chunk_text`, `answer` | - | no | allowed | to_verify | to_verify |
| `openrouter_embeddings` | OpenRouter-routed BGE-M3 embeddings pinned to DeepInfra (bge-m3-1024, RAG_BGE_M3_VIA=openrouter) | `openrouter.ai` | `query`, `chunk_text` | `RAG_BGE_M3_VIA` | yes | allowed | to_verify | to_verify |
| `prompt_guard` | Hugging Face Hub (Prompt Guard weights at image build; nothing uploaded, scoring runs in the sidecar) | `huggingface.co` | `chunk_text` | `RAG_INJECTION_PROMPT_GUARD` | yes | allowed | to_verify | to_verify |
| `qdrant` | Qdrant external retrieval backend (cluster host from QDRANT_URL) | `cloud.qdrant.io` | `vectors`, `lexical_text` | `RAG_RETRIEVAL_BACKEND` | yes | allowed | to_verify | to_verify |
| `vectara` | Vectara HHEM groundedness scoring, called from the sidecar | `api.vectara.io` | `chunk_text`, `answer` | `RAG_GROUNDEDNESS_VECTARA_OPT_IN` | yes | requires `RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK`=true | to_verify | to_verify |
| `voyage` | Voyage rerank and embedding profiles | `api.voyageai.com` | `query`, `chunk_text` | `RAG_RERANKER` | yes | allowed | to_verify | to_verify |
| `weaviate` | Weaviate external retrieval backend (cluster host from WEAVIATE_URL) | `weaviate.cloud` | `vectors`, `lexical_text` | `RAG_RETRIEVAL_BACKEND` | yes | allowed | to_verify | to_verify |

## Manifest providers

- `anthropic`: `anthropic`
- `cohere`: `cohere`
- `deepinfra`: `deepinfra`
- `exa`: none (no managed url or secret variable)
- `ft_endpoint`: `ft_endpoint`
- `judge`: none (no managed url or secret variable)
- `lakera`: `lakera`
- `langfuse`: `langfuse`
- `llamacloud`: none (no managed url or secret variable)
- `openai`: none (no managed url or secret variable)
- `openrouter`: none (no managed url or secret variable)
- `openrouter_embeddings`: none (no managed url or secret variable)
- `prompt_guard`: none (no managed url or secret variable)
- `qdrant`: `qdrant`
- `vectara`: none (no managed url or secret variable)
- `voyage`: `voyage`
- `weaviate`: `weaviate`

## Open items

Fields still marked to_verify (operator action: confirm against the vendor terms during the live check):

- `anthropic`: retention, training
- `cohere`: retention, training
- `deepinfra`: retention, training
- `exa`: retention, training
- `ft_endpoint`: retention, training
- `judge`: retention, training
- `lakera`: retention, training
- `langfuse`: retention, training
- `llamacloud`: retention, training
- `openai`: retention, training
- `openrouter`: retention, training
- `openrouter_embeddings`: retention, training
- `prompt_guard`: retention, training
- `qdrant`: retention, training
- `vectara`: retention, training
- `voyage`: retention, training
- `weaviate`: retention, training
