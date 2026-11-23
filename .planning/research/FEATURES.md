# Feature Research

**Domain:** Multi-tenant RAG chat product (existing myRAG app) -- six-layer RAG pipeline upgrade (data, query, retrieval, rerank and context, generation, evaluation)
**Researched:** 2026-11-22
**Confidence:** MEDIUM overall. HIGH on vendor facts verified this session (Claude Citations, HHEM versions and languages, Cohere Rerank 5, Voyage-4-large, Qwen3-Embedding hosting, Docling HybridChunker, Qdrant/Weaviate tenancy). MEDIUM on "what production systems typically do" (practitioner blogs and prior knowledge, not controlled benchmarks). LOW where marked.

How to read this file: features are grouped by the six layers plus one cross-cutting section (admin config). Each feature has an ID (`DATA-*`, `QRY-*`, `RET-*`, `RNK-*`, `GEN-*`, `EVL-*`, `ADM-*`) so requirements can reference them. Complexity is LOW / MEDIUM / HIGH relative to the existing codebase (large `chat/route.ts`, two divergent ingestion paths, three retrieval entry points).

---

## Findings That Change the Plan (read first)

These are facts discovered during research that conflict with, or constrain, assumptions in `PROJECT.md`. Roadmap and requirements must resolve them.

| # | Finding | Impact | Confidence |
|---|---------|--------|------------|
| F1 | **HHEM-2.3 is not self-hostable.** It is "available exclusively via Vectara's platform" (API). The open-weights model is HHEM-2.1-Open (Apache-2.0, runs on CPU, ~1.5 s for 2k tokens) and is **English only**. | `PROJECT.md` puts HHEM-2.3 "in the sidecar". It cannot run there. Either call Vectara's API (customer text leaves the tenant boundary, needs a key and a privacy decision) or run 2.1-Open (English only, not valid for zh/it answers). | HIGH (HF model card) |
| F2 | **HHEM-2.3 language list does not include Italian.** Listed: en, de, fr, pt, es, ar, zh-Hans, ko, ru, ja, hi. Italian is absent. Traditional Chinese is not listed either. | The KB is zh/en/it. A hallucination badge for Italian answers has no validated scorer. Need a per-language "checked / not checked" state, or a different scorer for Italian. | HIGH (HF card + Vectara blog) |
| F3 | **Claude Citations and structured outputs are mutually exclusive.** Enabling citations on any `document` or `search_result` block together with `output_config.format` returns HTTP 400. | The requirement "use structured output where possible (e.g. citation list)" cannot apply to the Claude path. On Claude, Citations *is* the structure. Structured output belongs on side calls (rewrite, decomposition, doc-type classification), not the answer stream. | HIGH (Anthropic docs) |
| F4 | **Reranker scores are not portable.** Cross-encoder scores are per-query relative; a fixed cutoff (for example 0.5) fails across query types, languages, and providers. Calibrate per reranker against a target false-refusal rate. | The "rerank score threshold decides refusal" requirement needs a labelled answerable/unanswerable set (the golden set) and a holdout. Cohere and Voyage thresholds are different numbers and must be stored per provider. | MEDIUM (practitioner posts + one arXiv study) |
| F5 | **pgvector HNSW on `vector` caps at 2000 dims** (from prior knowledge, verify against current pgvector docs; `halfvec` allows up to 4000). Qwen3-Embedding-8B is 4096-dim native (Matryoshka, 32..4096, hosted by DeepInfra, Nebius, SiliconFlow, Fireworks); Voyage-4-large offers 2048/1024/512/256 (default 1024). | Pick truncated dims (1024 or 1536) per provider. 4096 and 2048 do not fit a plain `vector` HNSW index. Dimension and model must be recorded per index. | HIGH for provider dims, MEDIUM for pgvector limit |
| F6 | **Lexical search for Chinese is not free.** Postgres `simple`/`english` text search configs do not segment Chinese; Weaviate needs an explicit tokenization choice for CJK; Qdrant needs sparse vectors built with your own tokenizer. | "Hybrid works in all three backends" is false for Chinese unless tokenization is designed. Italian needs stemming (`italian` config). Hybrid parity across three backends must be tested per language. | MEDIUM (prior knowledge; needs phase-level verification) |
| F7 | **Ragas and DeepEval judge prompts are English-first.** Ragas documents a language-adaptation step (few-shot examples translated, optionally instructions). Independent evidence for Ragas on zh/it is thin. | Judge-based metrics (Faithfulness, Answer Relevance) need per-language spot-checks against human labels before they gate CI. Retrieval metrics (Recall@k, MRR) should be computed deterministically with no LLM judge. | MEDIUM |
| F8 | **Name check needed: "Voyage rerank-3".** Verified this session: Cohere Rerank 5 exists (Pro and Fast tiers, 32k context, 100+ languages, text only, no instruction support). I did not verify the exact Voyage reranker model name. | Confirm the current Voyage reranker model id before writing the requirement. | LOW (unverified) |

---

## Layer 1: Data (parsing, chunking, metadata, dedup, versioning, document type)

### Table Stakes

| ID | Feature | Why Expected | Complexity | Notes |
|----|---------|--------------|------------|-------|
| DATA-01 | One unified chunk metadata schema on every ingestion path: source, doc type, doc date, version, content hash, page or section, language, `embedding_model` | Filters, citations, dedup, and eval gold-labelling all depend on it. Today `process-document` and `document-processor.ts` write different metadata | MEDIUM | Do this first in the layer. One shared ingestion function behind both paths (upload and Nango/crawler/image), not a third implementation |
| DATA-02 | Per-document type chosen at upload: financial/report, contract/legal, product/technical, scanned/image; auto-detected suggestion, user can override | Users who upload mixed libraries expect the system to "just handle" tables vs clauses vs scans. Competitors with doc-type templates (for example RAGFlow chunking templates) set this expectation | MEDIUM | See "Document-type selection UI" below. Type maps to a config-driven profile (parser, chunker, metadata extractors), not hard-coded branches |
| DATA-03 | Type written into chunk metadata and usable as a retrieval filter | Stated requirement; also needed for eval slicing by type | LOW | Depends on DATA-01 and RET-03 |
| DATA-04 | Table-aware chunking that repeats the header in every table chunk | Financial reports are the highest-value failure case: a chunk of numbers without column headers is unanswerable | MEDIUM | Docling `HybridChunker` has `repeat_table_header` (default True) and `omit_header_on_overflow`; the exact flag name and supported serializations vary by version, so pin the version and test with a real multi-page table |
| DATA-05 | Parser fallback chain: LlamaParse, then Docling when LlamaParse fails or is unconfigured; recorded in metadata (`parser_used`) | Reliability. A single parser outage should not fail uploads | MEDIUM | Sidecar owns Docling; main app owns LlamaParse call. Record which parser produced each doc so eval can compare |
| DATA-06 | Exact content-hash dedup, scoped to the tenant/workspace | Re-uploading the same file must not double the index and skew retrieval | LOW | Hash the normalized content, not the file bytes (same text in a different container should match). Scope per user/org: a global hash lookup lets one tenant detect that another tenant uploaded a document |
| DATA-07 | New version of a document replaces the old one with no empty window | Users re-upload updated contracts and reports. Chat during re-index must not return nothing or both versions | MEDIUM | Insert new chunks, then flip `is_current`, then delete or tombstone old ones. Keep the previous version (soft-deleted, excluded from retrieval) for a short retention window so rollback and the golden set's "stale answer" cases are testable |
| DATA-08 | Language detection per document and per chunk (zh/en/it) | Needed for language-specific lexical analyzers (F6), per-language eval slices, and HHEM routing (F2) | LOW | Cheap detector library; store in metadata |
| DATA-09 | Scanned/image documents get OCR or vision parsing and are flagged low-confidence in metadata | Scanned docs are a named golden-set category. Silent garbage text is worse than a visible "OCR quality low" status | MEDIUM | Existing GPT-4o image captioning path stays for standalone images (`source_images` behavior must not change) |
| DATA-10 | Per-document processing status (queued, parsing, chunking, embedding, ready, failed) with a readable error | Users upload and wait; without status they re-upload (which triggers dedup and version logic) | LOW | Likely partly present; extend rather than rebuild |

### Differentiators

| ID | Feature | Value Proposition | Complexity | Notes |
|----|---------|-------------------|------------|-------|
| DATA-11 | Contract/legal profile: clause-hierarchy chunking (section numbers, article headings kept as metadata) with parent-child retrieval (match the small clause, return the clause plus its parent heading) | Legal answers need clause context and precise "Article 4.2" citations | HIGH | Parent-child needs a stable `parent_chunk_id`; interacts with RNK-05 (neighbor expansion) |
| DATA-12 | Financial profile: row-level or section-level table chunks that carry caption, units, and reporting period in metadata | Numeric questions ("Q3 revenue") are exact-match problems that embeddings handle poorly | HIGH | Pairs with hybrid lexical (RET-02) |
| DATA-13 | Contextual chunk prefix (a one-sentence LLM-generated "where this chunk sits in the document" prepended before embedding and BM25) | Published results from Anthropic's contextual-retrieval work report materially fewer retrieval failures; cost is one LLM call per chunk at ingest | MEDIUM-HIGH | Only worth it if baseline eval shows retrieval is the bottleneck. Prompt-cache the document to cut cost. Make it an A/B in the eval harness, not a default |
| DATA-14 | Type auto-detection with a confidence score and the reason shown ("detected: contract, 0.91") | Builds trust in the override UI; low-confidence ones highlighted for the user | MEDIUM | Cheap heuristics first (text-layer ratio for scanned, keyword and structure signals), small-LLM classifier on first pages only when heuristics are ambiguous |
| DATA-15 | Version history UI for a document (list versions, restore previous) | Contract and report users need "what changed / go back" | MEDIUM | Cheap if DATA-07 keeps soft-deleted versions |
| DATA-16 | Re-process document under a different type from the document list, with a cost/time warning | Fixes mis-detection without re-upload | LOW-MEDIUM | Uses the same pipeline as DATA-07 |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Exposing raw parser/chunker knobs (chunk size, overlap, parser choice) to end users per upload | "Power users want control" | Explodes the eval matrix, and users cannot judge the effect. The four-type picker already is the control surface | Type picks a vetted profile; admins can edit profiles in Config UI |
| Embedding-based semantic chunking for all documents | Sounds smarter than fixed windows | Extra embedding cost at ingest, unstable boundaries, no evidence it beats structure-aware chunking on these doc types | Structure-aware chunking (Docling hybrid, headings, tables) per type; fixed-window only for "general" fallback |
| Global (cross-tenant) dedup | Saves storage | Cross-tenant existence leak and shared-chunk deletion bugs | Per-tenant hash scope |
| Near-duplicate (fuzzy) dedup in this milestone | Handles re-saved copies | Threshold tuning, false merges of legitimately similar contracts | Exact hash now; revisit only if eval shows duplicate-driven retrieval noise |
| Hard-deleting the old version immediately | Simplicity | No rollback, and the golden set cannot test version behavior | Soft-delete with retention window |
| A fifth/"auto" type as the only default with no explicit fallback | Fewer choices | Needs a deterministic fallback when detection is unsure | Keep an implicit `general` profile (the current behavior) as the fallback and as the "kill switch" profile. Confirm with the user that this is not a fifth visible type (open question) |

### Document-type selection UI: expected behavior

- **Upload dialog, one row per file**: filename, size, detected-type badge with confidence, a dropdown to change it, and an "apply to all selected" control. Upload is never blocked by detection. Unknown or low confidence defaults to `general` and shows a soft prompt ("not sure, pick a type for better answers").
- **Auto-detect is a suggestion, not a decision**: show it pre-selected, mark low-confidence rows visually, remember nothing silently.
- **Batch uploads (folder or Nango sync)**: no per-file prompt. Apply auto-detected type or a folder-level default, and surface a post-hoc review list ("12 documents detected as contract, review").
- **Document list**: type chip on each document, filterable. Changing type triggers a confirm dialog with a cost note and reprocesses (DATA-16).
- **Cloud connector sync** (Nango, crawler): auto-detect only; admin can set a default type per connector.
- **Embedded and voice users** never see this UI. Retrieval filters by type are API/Config-level in this milestone (a chat-side "search only in: contracts" chip is a differentiator, not table stakes).

---

## Layer 2: Query (rewrite, multi-query, HyDE, decomposition, fusion)

### Table Stakes

| ID | Feature | Why Expected | Complexity | Notes |
|----|---------|--------------|------------|-------|
| QRY-01 | History-aware rewrite: turn a follow-up ("what about its price?") into a standalone question before retrieval, for text, embedded, and voice paths | Multi-turn chat that retrieves on the raw follow-up fails; "multi-turn coreference" is a named golden-set category. Voice already does this | MEDIUM | Gate it: skip when there is no history or the query already looks self-contained. Keep the original query for display and for refusal logic. Rewrite in the **same language** as the user, do not translate |
| QRY-02 | Every query-layer feature has an individual on/off switch, a timeout, and a latency budget; on timeout or error, fall back to the original query | Stated constraint (rollback, latency). Rewriting is autoregressive and dominates TTFT if unguarded | MEDIUM | Use a small, fast model for rewrite. Log original and rewritten query under the existing `[Document Search]` prefix |
| QRY-03 | One shared fusion implementation (RRF) used for multi-query/sub-question results and, where applicable, for hybrid dense+lexical | Avoid a third parallel implementation (the codebase already has duplicates) | LOW-MEDIUM | Decide whether fusion lives in app code or in each backend's native hybrid; the app-level RRF must work identically over all three backends |
| QRY-04 | The query layer returns a trace (original, rewritten, variants, sub-questions, which switches fired, timings) | Debuggability, eval error analysis, and Config UI "why did it answer that" | LOW | Attach to retrieval result; log, do not stream to end users |

### Differentiators

| ID | Feature | Value Proposition | Complexity | Notes |
|----|---------|-------------------|------------|-------|
| QRY-05 | Multi-query (3-4 paraphrases) fused with RRF | Cheap recall gain on vocabulary-mismatch queries; production write-ups report solid gains at small latency cost when variants are retrieved in parallel | MEDIUM | Run variants' retrieval in parallel; dedupe before rerank so rerank cost does not multiply |
| QRY-06 | Sub-question decomposition for compound questions, only when a classifier says the query is compound | Compound questions are a named golden-set category and a real failure for single-shot retrieval | HIGH | Needs a decomposition step (structured output is appropriate here, F3 does not apply), parallel retrieval per sub-question, fusion, and answer synthesis that cites across sub-results. Bound to max N sub-questions |
| QRY-07 | HyDE, off by default, enabled per query class by the eval | Helps abstract or short queries; evidence says it adds substantial latency and can hurt exact-term and numeric queries | MEDIUM | Treat as an experiment: ship the switch, enable only where the golden set shows a win. Never in the voice path |
| QRY-08 | Cheap query router: skip expansion for short exact-term, numeric, or already-specific queries | A production case study found most queries need no LLM augmentation; skipping cut latency about a third | MEDIUM | Reuse `query-classifier.ts` signals rather than a new classifier |
| QRY-09 | Cross-language query variants (zh query also searched as en/it) | KB is zh/en/it and users may ask across languages | MEDIUM | Likely redundant with a strong multilingual embedder and reranker (Qwen3, Voyage-4, Cohere 5 are all multilingual). Test on the cross-lingual golden items before building |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| HyDE and multi-query and decomposition on every query by default | "More expansion is better recall" | Latency stacks, cost multiplies, and exact-term/financial queries degrade | Router (QRY-08) plus per-class enablement decided by eval |
| Agentic multi-hop retrieval loops | "Handles hard questions" | Unbounded latency and cost, hard to eval, hard to keep strict-mode refusal semantics | Bounded sub-question decomposition (max N, one round) |
| Rewrites that add facts or translate the question | "Better recall" | Injects wrong terms; breaks refusal because the rewritten query can retrieve something the user never asked about | Rewrite is coreference resolution plus minimal expansion, same language, validated by eval on the multi-turn slice |
| Importing LangChain.js and LlamaIndex.TS wholesale just for one function each | "PROJECT.md prefers libraries" | Two heavy dependency trees for roughly 100 lines of logic each in a 4500-line route that cannot absorb more abstraction | Use the libraries only where they remove real code; otherwise implement the same algorithm behind the single retrieval module (research phase decides, per `PROJECT.md`) |
| Query-layer features in the voice path beyond the existing rewrite | "Parity" | Voice has the tightest budget | Voice gets history rewrite plus hybrid (and optionally a fast reranker tier) only |

---

## Layer 3: Retrieval (embeddings, hybrid backends, filters, tenant isolation)

### Table Stakes

| ID | Feature | Why Expected | Complexity | Notes |
|----|---------|--------------|------------|-------|
| RET-01 | Switchable embedding provider (Qwen3-Embedding-8B hosted, Voyage-4-large, existing OpenAI), with model name, dimension, and instruction-prefix recorded **per index/collection** | Wrong-model query embeddings silently return garbage. Dify-style products lock the embedding model per knowledge base for this reason | MEDIUM | Query embedder must be resolved from the index's recorded model, never from a global env var alone. Qwen3 is instruction-aware: query-side prefix differs from document-side. Truncate dimensions (F5): 1024 or 1536 |
| RET-02 | Hybrid retrieval (dense plus lexical) in all three backends, pre-filtered, fused with RRF | Hybrid is the production default; exact terms, codes, and numbers need lexical | HIGH | pgvector: tsvector plus vector in SQL (or RPC). Weaviate: native hybrid. Qdrant: dense plus sparse. Per-language analyzers (F6) are the hard part; Chinese needs explicit tokenization, Italian stemming |
| RET-03 | Metadata filters applied **before** the vector search: date range, source, document, doc type, language | Post-filtering starves top-k. Stated requirement | MEDIUM | One filter DSL in the app, translated per backend. Index the filterable payload fields (Qdrant payload indexes, Weaviate properties, Postgres indexes) |
| RET-04 | Tenant isolation enforced inside the backend adapter, not by callers: every search, upsert, and delete takes a required `TenantScope` (user_id and/or organization_id); the adapter refuses calls without one | Cross-tenant leakage is the worst failure per `PROJECT.md`. Qdrant's `is_tenant` payload index improves performance but does **not** enforce isolation; the filter must be on every operation. Weaviate has structural per-tenant shards | MEDIUM-HIGH | Single-tenant mode uses a fixed scope, same code path. pgvector keeps RLS. Add an automated cross-tenant test (EVL-09) that runs against every backend |
| RET-05 | Supabase remains the source of truth; sync to Weaviate/Qdrant is idempotent and covers insert, update, delete, and re-embed, with a reconcile job that compares counts and IDs | Without reconcile, deletes silently leave orphan vectors that still answer (privacy bug) | HIGH | Outbox pattern keyed by chunk id and version. Delete propagation is the correctness-critical part (document deletion, version replacement, tenant deletion) |
| RET-06 | Re-embedding job: batched, checkpointed and resumable, builds a **new** index alongside the old, atomically switches, keeps the old index for rollback | Stated requirement. In-place re-embedding of a live index has no rollback and a mixed-model window | HIGH | Extends `scripts/rag/reprocess-documents.js`. Track per-chunk `embedding_model`; switch only when coverage is 100% and the eval comparison passes |
| RET-07 | Lexical and vector ranks are combined without a hand-tuned score blend; existing heuristic boosts (date, financial, exact-data thresholds) are either converted to metadata filters or removed | The heuristic layer and dynamic threshold retry in `enhanced-rag-retrieval.ts` are replaced by rerank and refusal threshold. Keeping both double-counts | MEDIUM | Decide per heuristic by A/B in eval; remove what does not help |
| RET-08 | Single retrieval module used by text chat, embedded chat, and voice, with the unused modules (`optimized-search`, `adaptive-retrieval`, `retrieval-strategies`, `reranker-local`, etc.) either reused or deleted | Stated context; avoids a third parallel implementation | MEDIUM | Voice calls with a reduced step list, same module |

### Differentiators

| ID | Feature | Value Proposition | Complexity | Notes |
|----|---------|-------------------|------------|-------|
| RET-09 | The same golden set runs against pgvector, Weaviate, and Qdrant, with a side-by-side report | Turns "which backend is default" into an evidence decision (a stated project goal) | MEDIUM | Needs the eval harness to take backend as a config parameter, and identical data and filters in all three |
| RET-10 | Dual-read shadow mode: serve from pgvector, also query the candidate backend, log overlap and latency | Safe production comparison without user impact | MEDIUM | Only if the golden set is too small to settle the decision. Costs extra queries |
| RET-11 | Matryoshka dimension sweep (for example 512/1024/1536) evaluated for recall versus storage and latency | Qwen3 and Voyage-4 both support truncation; lower dims shrink the HNSW index | LOW-MEDIUM | Re-embedding is not needed for Matryoshka truncation if full vectors were stored, but they usually are not; plan for a re-embed |
| RET-12 | Chat-side filter chips (document type, date range, folder) | Users with big mixed libraries narrow scope themselves | MEDIUM | UI work only once RET-03 exists |
| RET-13 | Per-language lexical analyzers configured by detected language | Fixes F6 properly | MEDIUM | Depends on DATA-08 |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Making Weaviate or Qdrant the source of truth | "Avoid dual writes" | Breaks the Supabase RLS and tenant model | Supabase authoritative, one-way sync with reconcile |
| Shared index with post-filtering by tenant | Simplest to build | Leak risk, starved top-k, wrong lexical statistics | Pre-filter plus adapter-enforced scope; Weaviate tenant per tenant if the collection count stays sane |
| Per-tenant choice of retrieval backend or embedding model | "Flexibility" | Multiplies the eval and support matrix by tenant count | Global admin choice; per-tenant only via future-milestone request |
| Backend-specific features exposed past the adapter | "Use Weaviate generative modules / Qdrant recommend API" | Breaks switchability, which is the entire point | Minimal common interface: `search(queryVec, queryText, filters, scope, k)`, `upsert`, `delete`, `count` |
| In-place re-embedding of the live index | Less storage | No rollback, mixed-model window | Shadow index plus atomic switch (RET-06) |
| Mixed embedding dimensions in one column or collection | "Gradual migration" | Invalid distances or errors | One index per (model, dims) |
| Retrying with a lowered similarity threshold until something comes back | Existing behavior | Directly undermines "say I do not know" | Refusal by calibrated rerank score (RNK-04) |

---

## Layer 4: Rerank and Context (rerank, top-k, ordering, compression, refusal)

### Table Stakes

| ID | Feature | Why Expected | Complexity | Notes |
|----|---------|--------------|------------|-------|
| RNK-01 | Cross-encoder rerank after hybrid retrieval, switchable provider (Cohere Rerank 5, Voyage reranker) | The single most reliable precision gain in production RAG | MEDIUM | Cohere Rerank 5: 32,768-token context per query-document pair, 100+ languages, text only, no custom instructions. Verify Voyage model id (F8) |
| RNK-02 | Over-retrieve then cut: candidate pool N (for example 30-50) reranked, final top-k (for example 5-8); both numbers set by eval | Stated requirement | LOW | Make N and k config values. Cost scales with N |
| RNK-03 | Reranker failure or timeout falls back to the fused order, and the trace records it | Third-party dependency on the hot path | LOW | Short timeout. Voice uses a smaller N or the provider's fast tier, or skips rerank |
| RNK-04 | Refusal threshold on the top rerank score, calibrated **per reranker provider** on the golden set (answerable vs unanswerable), with a holdout split | F4. Only way to produce the stated "say I don't know" behavior with evidence | MEDIUM | Choose the threshold from a tolerated false-refusal rate, not a round number. Keep the existing strict-mode "information not available" response and the webSearch-in-strict behavior unchanged; the threshold only feeds the same decision |
| RNK-05 | Context assembly: dedupe near-identical chunks, merge adjacent chunks from the same document, enforce a token budget from the model's context length, stamp each chunk with a stable ID for citations | Prerequisite for good citations (GEN-01, GEN-02) and for not blowing the context window | MEDIUM | Preserve the `{{context}}` placeholder contract. Image chunks continue to feed `source_images` |
| RNK-06 | Ordering to counter "lost in the middle": best chunks at the start and end of the context | Stated requirement; cheap | LOW | Apply after dedupe. Verify with eval; the effect is model-dependent |
| RNK-07 | Refusal text returned in the user's language (zh/en/it) as the existing structured "information not available" shape | A refusal in the wrong language reads as a bug | LOW | Detect from the query, not the KB |

### Differentiators

| ID | Feature | Value Proposition | Complexity | Notes |
|----|---------|-------------------|------------|-------|
| RNK-08 | Extractive context compression (sentence-level filtering that keeps original text and offsets) | Lower token cost, less distraction | MEDIUM-HIGH | Risk: compression can remove the evidence a citation points to and can break Claude Citations offsets. Off by default; enable only if eval shows no faithfulness loss. LLM-based abstractive compression is an anti-feature |
| RNK-09 | Parent-child expansion after rerank (return the surrounding section for the winning small chunk) | Better answer completeness for contracts and manuals | MEDIUM | Depends on DATA-11 |
| RNK-10 | Partial-answer behavior: answer the supported part and state what is missing, instead of binary answer/refuse | Much better UX than all-or-nothing in strict mode | MEDIUM | Needs the golden set to include partially answerable items. Not the same as flexible mode (no outside knowledge) |
| RNK-11 | Logged "retrieval gaps": queries that were refused, with their top score | Tells admins what documents to add | LOW | Dataset also seeds new golden items |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| One global fixed rerank cutoff (for example 0.5) | Simple | Scores differ per provider, query type, and language (F4) | Per-provider calibrated threshold plus holdout validation |
| Stacking MMR plus cross-encoder plus BM25 reweighting | "Belt and braces" | Hard to attribute effects and adds latency; `mmr-scorer.ts` and `reranker-local.ts` already exist unused | One reranker; dedupe handles redundancy |
| LLM listwise reranking on the main path | Higher quality claims | Latency and cost on every query | Dedicated cross-encoder API |
| Abstractive LLM context compression | Fewer tokens | Rewrites evidence, so faithfulness and citations degrade | Extractive only, or none |
| Tuning thresholds on the same items used for the CI gate | Convenient | Overfits and the gate stops detecting regressions | Calibrate on a tuning split, gate on a holdout split |

---

## Layer 5: Generation (citations, hallucination scoring, structured output)

### Table Stakes

| ID | Feature | Why Expected | Complexity | Notes |
|----|---------|--------------|------------|-------|
| GEN-01 | Claude path: direct Anthropic API with Citations enabled; retrieved chunks passed as `document` or `search_result` blocks carrying chunk ID, title, source, page; response citations mapped back to chunk IDs | Native, API-parsed citations are guaranteed to point to valid spans of the supplied content, and `cited_text` is not billed as output tokens. Anthropic docs list all active Claude models as supported | HIGH | Needs `ANTHROPIC_API_KEY`, OpenRouter-id to Anthropic-id model mapping, and a check of how Vercel AI SDK 6 / `@ai-sdk/anthropic` surfaces citations (MEDIUM confidence, verify in stack research). Source documents can be prompt-cached; citation blocks cannot. Tool use and web search must keep working on this path |
| GEN-02 | Non-Claude path: the prompt requires inline chunk-ID tags (`[C3]`) per claim; server parses them | Models via OpenRouter have no native citations | MEDIUM | Same normalized citation record as GEN-01: `{chunkId, docId, title, page/section, quote?}` |
| GEN-03 | **Server-side citation validation**: any cited ID not in the retrieved set is dropped or flagged; answers with zero valid citations in strict mode are treated as unsupported | Models fabricate IDs; unvalidated citations are decoration. Citation faithfulness is the stated Core Value | MEDIUM | Also record "cited vs retrieved" for eval |
| GEN-04 | Citations render inline (numbered markers) and in the sources list, each opening the exact passage with document name and page/section. Doc sources, web search sources, and `source_images` stay visually distinct, and images keep their current placement above the text and are not cited | Existing behavior to preserve. Users judge trust by clicking citations | MEDIUM | Persist normalized citations in message metadata so reload and shared chats render identically. Keep sidebar toggle click handling intact |
| GEN-05 | Hallucination scoring runs **after** the stream completes, asynchronously; result stored in message metadata and logs; never blocks or alters the answer | Stated this-phase scope (record and warn, do not block). Vectara cites ~5 s at 16k tokens for HHEM-2.3, so it cannot sit in the streaming path | MEDIUM | Premise is the context actually given to the model; hypothesis is the answer. Skip refusals ("information not available") since a score is meaningless there |
| GEN-06 | "May be unreliable" warning in the UI when the score is below a configured threshold; **three states**: supported, possibly unreliable, **not checked** (unsupported language, scorer down, or refusal) | F1 and F2: scorer coverage is partial. Showing "OK" when nothing was checked is a false assurance | MEDIUM | Warn text is hedged ("some statements may not be supported by your documents"). Threshold is a config value, default chosen from golden-set score distributions (the stated plan is to observe first) |
| GEN-07 | Warning shown only where the check is meaningful: strict and balanced modes against retrieved context; hidden or labelled "includes general knowledge" in flexible mode; none in bypass | In flexible/bypass the model is allowed to go beyond context, so low support is expected and the badge would be constant noise | LOW | Mode-aware display rule |
| GEN-08 | Structured output used only where it does not conflict with streaming or Citations: query decomposition, doc-type classification, rewrite results, eval judge calls. Not on the Claude answer path (F3) | Satisfies "structured where possible" without 400 errors or broken streaming | LOW-MEDIUM | For non-Claude answers, inline tags plus parsing streams naturally; a structured citation list would force buffered output |
| GEN-09 | Existing behaviors preserved: strict "information not available", Exa webSearch in strict mode, `RAG_SYSTEM_PROMPT` with `{{context}}`, `source_images`, source persistence | Constraint list in `PROJECT.md` and `AGENTS.md` section 14 | MEDIUM | Needs regression coverage in the eval and in a small non-LLM test suite, since the route has no tests |

### Differentiators

| ID | Feature | Value Proposition | Complexity | Notes |
|----|---------|-------------------|------------|-------|
| GEN-10 | Sentence-level hallucination highlighting (underline the unsupported sentences) | Far more actionable than a whole-message badge | HIGH | Requires sentence-level scoring (more scorer calls, more latency and cost) and mapping into the rendered markdown |
| GEN-11 | User feedback on the warning (thumbs, "this was fine") stored with the score | Builds labelled data to calibrate the threshold later (when blocking becomes in scope) | LOW-MEDIUM | Do not build a review dashboard |
| GEN-12 | Admin-only numeric score and per-claim detail in a debug drawer | Lets the team inspect score distribution without exposing false precision to users | LOW | Config UI or a debug flag |
| GEN-13 | Unified web-search plus document citations on the Claude path (Exa results as `search_result` blocks) | One citation model for all evidence | MEDIUM | Only after GEN-01 is stable |
| GEN-14 | Click-through from a citation to the original document page (PDF page anchor or highlighted passage) | Users verify faster; a strong trust feature in document QA | MEDIUM-HIGH | Needs page/offset metadata from DATA-01 |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Blocking or regenerating answers on a low hallucination score | "Stops bad answers" | Explicitly out of scope; threshold is uncalibrated and scorer coverage is partial (F1, F2) | Record and warn this phase; revisit with score distributions and feedback data |
| Showing a numeric "accuracy 87%" to end users | Looks scientific | A faithfulness score is not an accuracy probability; false precision and trust erosion | Three-state badge; numbers for admins only |
| Post-hoc fuzzy matching of answer sentences to documents to fabricate citations | Works with any model | Citations that were not produced by the generation are unverifiable decoration | Native Citations (Claude) or validated chunk-ID tags (others) |
| Routing all RAG answers through Claude | Single citation path | Out of scope per `PROJECT.md`; removes multi-model choice | Two citation paths with one normalized record |
| Forcing structured JSON for the whole answer on non-Claude models | "Clean citation list" | Kills token streaming; on Claude it is a 400 | Inline tags plus parsing |
| Using an English-only scorer for zh/it answers and showing the result as normal | Free and local | Scores for unsupported languages are unreliable (F1, F2) | "Not checked" state, or a validated multilingual scorer |

---

## Layer 6: Evaluation (golden set, metrics, baseline, CI gate)

### Table Stakes

| ID | Feature | Why Expected | Complexity | Notes |
|----|---------|--------------|------------|-------|
| EVL-01 | Golden set of 50-200 items stored in the repo (JSONL), versioned, each with: id, question, language, category, reference answer, gold evidence (document plus page/section plus quote), `answerable` flag, optional conversation history, `origin` (claude-drafted, ragas-generated, hand-written), review status | The stated "prove it" loop. Categories required: multi-turn coreference, compound, exact term, table, scanned, no-answer | MEDIUM | **Label gold evidence as document plus section/quote span, not chunk IDs.** Chunking changes in this very milestone, so chunk-ID labels would invalidate Recall@k after every change. Score retrieval hits by text overlap against the gold span |
| EVL-02 | Stratified coverage: language (zh/en/it) by category, with the no-answer share visible per language | Aggregates hide per-language regressions, and the product is explicitly multilingual | MEDIUM | At 200 items, each language-by-category cell is tiny. Report per-slice numbers as diagnostic, gate on aggregate plus a few named slices |
| EVL-03 | Deterministic retrieval metrics (Recall@k, MRR) computed from gold evidence with no LLM judge | Cheap, stable, and the fast PR signal | MEDIUM | Depends on EVL-01 gold spans and on a harness that can read the retrieved list before generation |
| EVL-04 | Generation metrics via DeepEval and Ragas: Faithfulness, Answer Relevance, Context Recall; judge model pinned and temperature 0 | Stated requirement | MEDIUM | Ragas needs language adaptation for zh/it (F7). Judge from a different model family than the generator where possible (self-preference bias). Spot-check a sample of judge verdicts per language against a human read before trusting them |
| EVL-05 | Refusal metrics **split in two**: correct-refusal rate on unanswerable items and false-refusal rate on answerable items | One "refusal rate" number rewards a system that refuses everything | LOW | Primary metric for RNK-04 calibration |
| EVL-06 | Baseline run of the current system, stored as a committed artifact (config snapshot plus per-item results plus aggregates) before any change; targets set after | Stated decision. Gate numbers chosen before a baseline have no basis | MEDIUM | Run baseline N times (3) to measure judge noise, so the gate tolerance is based on observed variance |
| EVL-07 | Evaluation targets a dedicated eval workspace/tenant with a fixed, versioned document set, and calls the app over HTTP with a service credential | Reproducibility, and avoids contaminating real tenants | MEDIUM-HIGH | Needs ingestion of the eval corpus through the same pipeline under test (so DATA changes are measured), and a stable way to re-seed |
| EVL-08 | CI (`.github/workflows`) that runs: a small PR smoke slice (retrieval metrics plus a handful of judge items) on RAG-path changes, and the full set nightly or on demand. Gate = no regression beyond measured noise on named metrics; hard floors on correct-refusal and cross-tenant tests | The repository has no CI or tests today. Full eval on every PR is slow and costly | MEDIUM-HIGH | Secrets in GitHub only; placeholder values in docs. `npm run test-rag` fixed or removed. Also unflip `ignoreBuildErrors` as a separate concern (not this milestone) |
| EVL-09 | **Automated cross-tenant leakage test** against every retrieval backend: tenant A's query must never return tenant B's chunk, including after delete, version replace, and re-embed | Multi-tenant product with three backends and a sync layer; this is the severest failure and is not an LLM-judge problem | MEDIUM | Plain deterministic test, not part of the quality metrics. Must pass for CI to pass |
| EVL-10 | Per-run report (JSON plus human-readable markdown/HTML): aggregates, per-language and per-category slices, per-item deltas versus baseline, list of regressed items, config snapshot, per-stage latency | The review step is "did it get better, where did it get worse" | MEDIUM | Paired comparison on the same items is far more sensitive than comparing two aggregates. With ~100-200 items only large effects are detectable, so say so in the report |
| EVL-11 | Sidecar (Python) exposes authenticated endpoints (shared secret) from day one: eval run, HHEM or hallucination score, Docling parse | Stated constraint: new endpoints must be authed | MEDIUM | Same pattern as the existing services with an `API_KEY` header |

### Differentiators

| ID | Feature | Value Proposition | Complexity | Notes |
|----|---------|-------------------|------------|-------|
| EVL-12 | Config comparison runs: any two config snapshots (backend, embedder, reranker, switches) against the same golden set, producing the comparison report | This is what makes every "switchable provider" decision evidence-based | MEDIUM | Reuses EVL-10 |
| EVL-13 | Eval run launcher and results page in Config UI (trigger run, see latest baseline versus current) | Lets non-CLI admins use the loop | MEDIUM | Thin page over sidecar output; do not build a dashboard product |
| EVL-14 | Latency per stage recorded in each eval run, with budget checks (rewrite plus retrieve plus rerank within the stated total; voice lower) | Latency budget is a stated constraint | LOW-MEDIUM | The query trace (QRY-04) provides the data |
| EVL-15 | HHEM (or chosen scorer) validated on the golden set: run it over known faithful and known unfaithful answers to see separation per language | Gives the threshold in GEN-06 an evidence basis and exposes the Italian gap (F2) early | MEDIUM | Can be built from the EVL-04 outputs plus a small hand-labelled set |
| EVL-16 | Production sampling: log retrieval trace and hallucination score for real chats (opt-in, tenant-scoped, redacted) and use refused queries to propose new golden items | Closes the loop from live usage | MEDIUM-HIGH | Privacy review needed; later milestone |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| LLM-judge scores as the only evidence | Easy to compute | Judge noise, English-first prompts (F7), self-preference | Deterministic retrieval metrics plus spot-checked judge metrics |
| Gate thresholds set before the baseline | "Need numbers in the plan" | No evidence basis; either always fails or never fails | Baseline first (EVL-06), targets after |
| Full golden set on every PR | "Maximum safety" | Slow and expensive, so people disable it | Smoke slice per PR, full nightly |
| Tuning thresholds on the gating items | Convenience | Overfitting; the gate stops meaning anything | Tuning split and holdout split |
| Sending customer documents or answers to a hosted eval platform | Nice dashboards | Privacy for a multi-tenant product | Local reports from the sidecar |
| A custom web app for golden-set authoring and review | "Better review UX" | Weeks of work for 50-200 rows | JSONL/CSV plus review status field plus a short checklist |
| Chunk-ID gold labels | Simple joins | Break on every chunking change (EVL-01) | Document plus span labels |
| Treating Ragas-generated questions as ground truth | Cheap volume | Synthetic questions skew easy and unanswerable cases are not generated | Claude-drafted and human-reviewed core; Ragas items tagged by `origin` and a minority |

### Evaluation workflow: expected behavior

1. **Author**: Claude drafts items from the real documents; Ragas adds a minority of synthetic items; the user reviews each item (status field in the file). Unanswerable items are written deliberately (including "near-miss" questions about topics adjacent to the corpus). All three languages, plus cross-lingual (question in one language, evidence in another).
2. **Seed**: ingest the eval corpus into the eval workspace through the real pipeline under test.
3. **Run**: harness calls the app (text-chat path, and a reduced profile for voice), captures retrieved list, final answer, citations, hallucination score, and stage latencies. Config snapshot stored with the run.
4. **Score**: deterministic retrieval metrics first, then judge metrics, then refusal split, per language and category.
5. **Compare**: paired per-item deltas against the committed baseline; flag items that flipped from pass to fail.
6. **Gate**: PR smoke in CI; full nightly. The gate fails on a regression larger than the measured noise, on a drop in correct-refusal rate, or on any cross-tenant failure.
7. **Decide**: each provider/backend switch becomes a documented eval comparison before the default changes. Final milestone task: full regression and lock defaults.

---

## Cross-Cutting: Admin Configuration (Config UI)

Expected behavior for "admin config of providers": the admin is a technical operator of one deployment, and mistakes here silently degrade or break retrieval.

### Table Stakes

| ID | Feature | Why Expected | Complexity | Notes |
|----|---------|--------------|------------|-------|
| ADM-01 | Provider selectors for: embedding, reranker, retrieval backend, parser (LlamaParse or Docling), each with a **Test connection** button that makes a real call | A misconfigured key discovered at first user query is a production incident | MEDIUM | Follows the existing `USE_*_PROVIDER` env style |
| ADM-02 | Switch plus parameters per pipeline feature: history rewrite, multi-query, HyDE, decomposition, rerank (N and k), compression, refusal threshold, HHEM display and threshold, latency budgets | Stated constraint: every capability toggleable with rollback to current behavior | MEDIUM | Defaults reproduce today's behavior. One "Reset to current behavior" preset |
| ADM-03 | Changing the embedding provider or dimensions shows an **index compatibility warning** and offers to start a re-embed job; the app never silently queries an index with a different model | RET-01 and RET-06 invariants must be visible to the operator | MEDIUM | Show per-index: model, dims, chunk count, coverage %, state (building, active, previous) |
| ADM-04 | Secrets entered masked, never returned by the config API; admin routes authenticated from the start | New endpoints must be authed (stated), and existing unauthenticated admin/config routes are a known separate problem | MEDIUM | Do not extend the unauthenticated surface; new config endpoints get auth even if old ones do not |
| ADM-05 | Config changes mirrored across `.env.local`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, and Config UI | Repository rule; drift is a known failure | LOW-MEDIUM | Make it a checklist item in every requirement that adds a variable; ideally a drift check script |
| ADM-06 | Sidecar and backend health on one page: reachable, version, last error, sync lag for Weaviate/Qdrant | Operators need to see why a feature is "not checked" or falling back | MEDIUM | Also feeds the "not checked" state in GEN-06 |
| ADM-07 | Re-embed and reindex job panel: progress, pause or resume, rollback to previous index | RET-06 exposure | MEDIUM-HIGH | Thin UI over the job table |

### Differentiators

| ID | Feature | Value Proposition | Complexity | Notes |
|----|---------|-------------------|------------|-------|
| ADM-08 | Preset profiles: "Current behavior", "Balanced", "High accuracy", "Low-latency voice", set from eval results | One click instead of a dozen interacting parameters | MEDIUM | Define after the baseline and comparison runs |
| ADM-09 | Effective-config readout per chat answer (which rewrite, backend, reranker, threshold fired), visible to admins | Support and debugging | LOW | Comes from the query trace (QRY-04) |
| ADM-10 | Edit doc-type profiles (chunk size, parser, table handling) | Fine-tuning per deployment | MEDIUM | Defer; ship fixed profiles first |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Per-tenant provider choices in the UI | "Enterprise flexibility" | Test matrix explodes; a tenant switching embedder breaks its index | Global deployment-level config |
| Hot-switching backend or embedder with no migration | "Just a dropdown" | Queries hit an empty or incompatible index | Switch only via the re-embed job plus atomic activation |
| Storing provider API keys in the database in plain text | Convenient | Leak and RLS risk | Env/secret store only (existing pattern) |
| A production-monitoring dashboard in Config UI | "While we are here" | Becomes a product of its own | Health page plus logs; eval results page only |

---

## Feature Dependencies

```
EVL-01 (golden set, span-labelled)
    └──requires──> real documents + EVL-07 (eval workspace)
EVL-06 (baseline) ──requires──> EVL-01, EVL-03, EVL-04, EVL-05, EVL-11 (sidecar auth)
Every later layer change ──requires──> EVL-06 (baseline to compare against)

DATA-01 (unified metadata) ──requires──> one shared ingestion function (both upload paths)
    ├──enables──> DATA-03 / RET-03 (type, date, source filters)
    ├──enables──> DATA-06, DATA-07 (hash dedup, versioning)
    ├──enables──> GEN-04 / GEN-14 (page/section in citations)
    └──enables──> EVL-01 gold-span matching
DATA-02 (doc type picker) ──requires──> DATA-01, DATA-14 (detection)
DATA-04 (table header repeat) ──requires──> DATA-05 (Docling in sidecar) + EVL-11
DATA-08 (language) ──enables──> RET-13 (per-language analyzers), GEN-06 (scorer routing)

RET-01 (switchable embedder) ──requires──> per-index model record
RET-06 (re-embed job) ──requires──> RET-01, DATA-01 (embedding_model per chunk)
RET-05 (sync to Weaviate/Qdrant) ──requires──> RET-04 (TenantScope in adapter), DATA-07 (delete/replace semantics)
RET-02 (hybrid x3 backends) ──requires──> RET-03 (filter DSL), RET-13 / F6 (CJK + Italian analyzers)
RET-09 (backend comparison) ──requires──> RET-02, RET-05, EVL-12
EVL-09 (cross-tenant test) ──requires──> RET-04, RET-05

QRY-03 (shared RRF) ──enables──> QRY-05, QRY-06 and RET-02
QRY-06 (decomposition) ──requires──> QRY-03, GEN-08 (structured output on side call)
QRY-07 (HyDE) ──enhances──> QRY-05 only where eval says so; conflicts with exact-term queries

RNK-01 (rerank) ──requires──> RET-02 output, RNK-02 (N and k)
RNK-04 (refusal threshold) ──requires──> RNK-01, EVL-05 (split refusal metric), EVL-01 (answerable/unanswerable items)
RNK-05 (context assembly, chunk IDs) ──requires──> DATA-01
GEN-01/GEN-02 (citations) ──requires──> RNK-05 (stable chunk IDs in context)
GEN-03 (citation validation) ──requires──> GEN-01 or GEN-02
GEN-05 (hallucination scoring) ──requires──> sidecar (EVL-11) and scorer decision (F1, F2)
GEN-06 (UI warning) ──requires──> GEN-05, DATA-08, GEN-07
ADM-03 (index compatibility warning) ──requires──> RET-01, RET-06

GEN-01 (Claude Citations) ──conflicts──> structured output on the same call (F3)
RNK-08 (compression) ──conflicts──> GEN-01 offsets / faithful citations unless extractive
Heuristic boosts (RET-07) ──conflicts──> RNK-04 (double-counted threshold logic)
```

### Dependency Notes

- **Evaluation precedes everything**: nothing else can be accepted without a baseline. Gold evidence must be span-based, otherwise the first chunking change invalidates the baseline.
- **Metadata is the keystone**: DATA-01 unblocks filters, dedup, versioning, citations (page/section), and eval matching. Doing retrieval work first on divergent metadata means redoing it.
- **Tenant scope before external backends**: RET-04 must exist in the adapter interface before Weaviate or Qdrant are wired, because adding it afterward means auditing every call site.
- **Threshold calibration needs labelled data**: RNK-04 and GEN-06 thresholds both come from golden-set distributions, so they cannot ship before EVL-01 contains enough unanswerable items.
- **Scorer decision (F1, F2) gates the hallucination UI**: pick API (privacy and Italian gap), open English-only model, or another validated multilingual scorer before designing GEN-05 and GEN-06 details.

---

## MVP Definition

All six layers are in scope for the milestone, so "MVP" here means the minimum per layer that satisfies the Core Value (correct, cited answers; honest "I do not know"; proven by scores).

### Launch With (milestone core)

- [ ] EVL-01, 03, 04, 05, 06, 07, 08, 09, 10, 11: golden set, metrics, baseline, CI gate, cross-tenant test, authenticated sidecar
- [ ] DATA-01, 02, 03, 05, 06, 07, 08, 10 plus DATA-04 for the financial/table profile: unified metadata, type picker, fallback parser, hash dedup, versioning
- [ ] QRY-01, 02, 03, 04: history-aware rewrite everywhere with switches, timeouts, shared RRF, trace
- [ ] RET-01, 02, 03, 04, 05, 06, 07, 08: switchable embedder, hybrid on three backends, filters, tenant-scoped adapter, sync with reconcile, re-embed job, single retrieval module
- [ ] RNK-01, 02, 03, 04, 05, 06, 07: rerank, over-retrieve, fallback, calibrated refusal, context assembly, ordering, localized refusal
- [ ] GEN-01 to 09: Claude Citations, chunk-ID tags with validation, normalized citation record and UI, async hallucination score with three-state warning, mode-aware display, preserved behaviors
- [ ] ADM-01 to 07: provider selectors with test connection, feature switches, index compatibility warning, secrets handling, config-sync, health, reindex panel

### Add After Baseline and Comparison Runs (v1.x within the milestone)

- [ ] QRY-05 (multi-query), QRY-06 (decomposition), QRY-08 (router): enable per query class only if eval shows gain within the latency budget
- [ ] QRY-07 (HyDE): experiment; likely default-off
- [ ] DATA-11, DATA-12, DATA-13 (clause, financial row, contextual prefix): enable if the baseline shows these slices are weak
- [ ] RNK-09, RNK-10 (parent-child expansion, partial answers)
- [ ] EVL-12, 13, 14, 15 (comparison runs, results page, latency checks, scorer validation)
- [ ] GEN-11, 12 (feedback, admin score detail), ADM-08 (preset profiles)

### Future Consideration (v2+)

- [ ] GEN-10 (sentence-level highlighting), GEN-14 (click-through to source page)
- [ ] RET-10 (shadow dual-read), RET-12 (chat-side filter chips), QRY-09 (cross-language variants, if eval shows need)
- [ ] EVL-16 (production sampling), DATA-15 (version history UI), ADM-10 (editable doc-type profiles)
- [ ] RNK-08 (extractive compression), only if eval shows token cost matters
- [ ] Hallucination blocking or regeneration (explicitly out of scope this phase)

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| EVL golden set plus baseline plus CI gate (EVL-01 to 08) | HIGH | MEDIUM-HIGH | P1 |
| Cross-tenant leakage test (EVL-09) | HIGH | MEDIUM | P1 |
| Unified metadata and shared ingestion (DATA-01) | HIGH | MEDIUM | P1 |
| Doc-type picker plus profiles (DATA-02, 03, 14) | HIGH | MEDIUM | P1 |
| Table header repeat via Docling (DATA-04, 05) | HIGH | MEDIUM | P1 |
| Hash dedup plus versioning (DATA-06, 07) | MEDIUM-HIGH | MEDIUM | P1 |
| History-aware rewrite (QRY-01, 02) | HIGH | MEDIUM | P1 |
| Hybrid retrieval, filters, tenant-scoped adapter (RET-02, 03, 04) | HIGH | HIGH | P1 |
| External-backend sync plus reconcile (RET-05) | MEDIUM (needed to offer the backends) | HIGH | P1 |
| Switchable embedder plus re-embed job (RET-01, 06) | MEDIUM-HIGH | HIGH | P1 |
| Rerank plus calibrated refusal (RNK-01 to 04) | HIGH | MEDIUM | P1 |
| Context assembly and ordering (RNK-05, 06) | MEDIUM-HIGH | MEDIUM | P1 |
| Claude Citations plus chunk-ID citations plus validation (GEN-01 to 04) | HIGH | HIGH | P1 |
| Hallucination score plus three-state warning (GEN-05 to 07) | MEDIUM-HIGH | MEDIUM-HIGH (blocked on scorer decision) | P1 |
| Admin provider and switch config (ADM-01 to 07) | MEDIUM-HIGH | MEDIUM-HIGH | P1 |
| Multi-query, decomposition, router (QRY-05, 06, 08) | MEDIUM | MEDIUM-HIGH | P2 |
| Contract/financial specialized chunking (DATA-11, 12) | MEDIUM-HIGH for those users | HIGH | P2 |
| Contextual chunk prefix (DATA-13) | MEDIUM | MEDIUM-HIGH | P2 |
| Backend and config comparison reports (RET-09, EVL-12) | HIGH (decision support) | MEDIUM | P2 |
| HyDE (QRY-07) | LOW-MEDIUM | MEDIUM | P3 |
| Sentence-level highlighting, citation click-through (GEN-10, 14) | MEDIUM | HIGH | P3 |
| Production sampling, shadow reads, chat-side filter chips | MEDIUM | MEDIUM-HIGH | P3 |

**Priority key:** P1 = needed for the milestone's Core Value; P2 = add once the baseline and comparison harness exist; P3 = later.

---

## Competitor and Reference Feature Analysis

Reference products are drawn from prior knowledge, not re-verified this session (MEDIUM-LOW confidence); use as directional expectation only.

| Feature | Reference behavior | Our Approach |
|---------|-------------------|--------------|
| Doc-type-specific chunking | RAGFlow offers chunking templates per document kind (general, paper, laws, manual, table, and others) chosen at upload | Four vetted profiles plus an implicit general fallback; auto-detected, user can override |
| Embedding model lock | Dify-style knowledge bases fix the embedding model per knowledge base | Same, per index; re-embed job to change |
| Hybrid plus rerank selection | Dify, Open WebUI, and AnythingLLM expose hybrid search and a rerank model picker | Config UI selectors with test connection; defaults chosen by eval |
| Inline citations with passage preview | NotebookLM, Perplexity, and Claude's own Citations UI show numbered claims linking to passages | Normalized citation record, inline markers, passage popover, page/section |
| Hallucination badge | Vectara surfaces factual-consistency scores via API; most chat products do not show per-answer warnings | Three-state, hedged badge, admin-only numeric score |
| Refusal | Most RAG chat products answer anyway; "I could not find this in your documents" is the trust differentiator | Calibrated rerank-score refusal, localized, measured by correct- and false-refusal rates |
| Evaluation in CI | Uncommon in chat products; common in RAG engineering teams (DeepEval pytest gates) | Smoke per PR, full nightly, gate on noise-aware regression plus hard floors |

---

## Open Questions for Requirements

1. **Hallucination scorer (F1, F2)**: use Vectara's hosted HHEM-2.3 (data leaves the deployment, Italian unlisted), run open HHEM-2.1 locally (English only), or choose another validated multilingual approach? This decides GEN-05, GEN-06, and the sidecar scope.
2. **Implicit `general` doc type**: confirm it is a hidden fallback, not a fifth user-visible option.
3. **Lexical search for Chinese (F6)**: choose a tokenization approach per backend; needs a phase-level spike.
4. **Voyage reranker model name (F8)**: confirm current id and context limits.
5. **Citations in the Vercel AI SDK 6 path (GEN-01)**: confirm how `@ai-sdk/anthropic` exposes Citations and tool-result `search_result` blocks while keeping existing streaming, source persistence, and tool approval behavior.
6. **Golden-set size versus power**: at 50-200 items, only large effects are detectable; accept this explicitly or plan for growth from RNK-11 retrieval-gap logging.
7. **Voice reduced profile**: define exactly which steps (rewrite, hybrid, fast rerank) are in the voice budget once stage latencies are measured.

---

## Sources

HIGH confidence (official or primary, fetched this session):
- Anthropic Citations documentation: https://platform.claude.com/docs/en/build-with-claude/citations (structured-outputs incompatibility, `cited_text` not billed, prompt caching on source documents, all active models supported)
- Anthropic search results documentation: https://platform.claude.com/docs/en/build-with-claude/search-results
- Vectara HHEM model card: https://huggingface.co/vectara/hallucination_evaluation_model (HHEM-2.1-Open English only, Apache-2.0, CPU; HHEM-2.3 API-only with listed languages)
- Vectara language support post: https://www.vectara.com/blog/hhem-expanded-language-support (language list, 16k context, latency)
- Cohere Rerank docs: https://docs.cohere.com/docs/rerank (Rerank 5, 32,768 tokens, 100+ languages, text only)
- Voyage-4-large listings: Azure catalog, OpenRouter, Vercel AI Gateway (2048/1024/512/256 dims, 32k tokens, Matryoshka)
- Qwen3-Embedding-8B listings: OpenRouter, Vercel AI Gateway, Fireworks, SiliconFlow (4096 dims, 32 to 4096 MRL, hosted providers)
- Qdrant multitenancy docs: https://qdrant.tech/documentation/manage-data/multitenancy/ (payload partitioning, `is_tenant`, filter on every operation)
- Weaviate multi-tenancy docs: https://docs.weaviate.io/weaviate/manage-collections/multi-tenancy (per-tenant shards)
- Docling chunking concepts: https://docling-project.github.io/docling/concepts/chunking/ (HybridChunker, `repeat_table_header`)
- Ragas language adaptation: https://docs.ragas.io/en/stable/howtos/customizations/metrics/metrics_language_adaptation/
- DeepEval CI/CD guide: https://deepeval.com/guides/guides-regression-testing-in-cicd

MEDIUM confidence (practitioner and preprint sources, not independently verified):
- Reranker score calibration: arXiv 2610.05348 (false-refusal-rate calibration of a bge reranker threshold); dev.to post on why 0.5 cutoffs fail
- Query augmentation cost and routing: Aarhus University "coverage illusion" production case study; practitioner write-ups on HyDE latency and multi-query gains
- Multilingual RAG evaluation gaps: MEMERAG (arXiv 2502.17163)
- LLM-eval-in-CI practices: Langfuse, qaskills, and other practitioner guides (smoke versus nightly, noise-aware gating)

LOW confidence or unverified (prior knowledge, verify in phase research):
- pgvector 2000-dim `vector` HNSW cap and 4000-dim `halfvec` cap
- Chinese tokenization options per backend (Postgres, Weaviate, Qdrant)
- Voyage reranker model name
- Competitor feature descriptions (RAGFlow, Dify, Open WebUI, AnythingLLM, NotebookLM)
- Anthropic contextual-retrieval effect size (cited from memory)

Note on method: the `research-plan` caching seam was not run; searches used the built-in WebSearch and WebFetch directly, so no digests were stored via `research-store`.

---
*Feature research for: multi-tenant RAG chat product, six-layer RAG pipeline upgrade*
*Researched: 2026-11-22*
