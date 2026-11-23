# Requirements: myRAG RAG 全链路升级

**Defined:** 2026-11-22
**Core Value:** 用户问知识库里有答案的问题，能拿到正确、带准确引用的回答；问知识库里没有答案的问题，系统明确说不知道，不硬编。并且这两点都能用评估分数证明。

All requirements are written so they can be checked. "Behind a switch" means an env flag that is mirrored in `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js` and the Config UI, and that restores current behavior when off.

## v1 Requirements

### Evaluation (EVAL)

- [ ] **EVAL-01**: A Python sidecar service exists in `rag-sidecar/` (FastAPI, Python 3.12, `pydantic>=2.14.4`), with health and readiness endpoints, a Dockerfile, and shared-secret auth that uses a constant-time compare and fails closed when the secret is unset
- [ ] **EVAL-02**: All structured contracts (sidecar requests/responses, golden-set items, eval results, LLM structured outputs) are defined once as Pydantic v2 models; the TypeScript side uses Zod schemas generated from their JSON Schema, and CI fails when the generated Zod schemas are out of date
- [x] **EVAL-03**: Golden-set items carry span-based gold evidence (document, section, quoted text), language, category (multi-turn, compound, exact term, table, scanned, no-answer) and review status — never chunk IDs
- [ ] **EVAL-04**: A synthetic fixture corpus and fixture golden set covering Chinese, English and Italian are committed, so CI can run without customer data
- [ ] **EVAL-05**: Tooling drafts a 50–200 item golden set from a real knowledge-base workspace (Claude-drafted plus Ragas-generated items) for the user to review; real-document items are stored outside git (gitignored path or a dedicated Supabase eval workspace), with a frozen dev/test split
- [ ] **EVAL-06**: An authenticated internal endpoint (`POST /api/internal/rag/run`, disabled in production unless explicitly enabled) runs the real TypeScript retrieval pipeline and returns a trace (query transforms, candidates, scores, final context, answer, citations)
- [ ] **EVAL-07**: The eval runner computes deterministic retrieval metrics (Recall@k, MRR, matched by gold span) and refusal metrics (correct-refusal rate and false-refusal rate, reported separately) without an LLM judge
- [ ] **EVAL-08**: The eval runner computes Faithfulness, Answer Relevance and Context Recall with DeepEval and Ragas using a pinned judge model from a different family than the generator, with telemetry disabled, and reports results per language and per category
- [ ] **EVAL-09**: A baseline of the current system is recorded (three runs, config hash per run, mean and spread), and later phases compare against it with paired differences
- [ ] **EVAL-10**: CI (new `.github/workflows`) runs a PR smoke tier (deterministic metrics on the fixture corpus, schema parity, config check, type-check) and a nightly full tier (judge metrics); a PR fails when a deterministic metric drops beyond the baseline noise band
- [ ] **EVAL-11**: `npm run test-rag` runs the eval smoke tier (the missing `scripts/test-rag-system.js` reference is fixed)
- [ ] **EVAL-12**: Characterization tests lock today's behavior: strict mode returns "information not available" with no context, webSearch + strict uses Exa results, `source_images` stream and persist, `{{context}}` substitution in `RAG_SYSTEM_PROMPT`
- [ ] **EVAL-13**: A config manifest lists every RAG env var once, and a `check-config` script (run in CI) fails when any of the five config locations is missing an entry

### Pipeline & Tenancy (PIPE)

- [ ] **PIPE-01**: One retrieval pipeline module (`src/lib/rag/`) is the only code that calls embedding providers, retrieval backends and rerankers; text chat, embedded chat and voice all call it
- [ ] **PIPE-02**: Every retrieval call requires a branded `TenantScope` that only `resolveTenantScope()` can create, after verifying workspace or organization membership server-side; an `organizationId` from the request body is never trusted directly
- [ ] **PIPE-03**: Embedded chat resolves its tenant from the embed widget's server-side configuration (the owning workspace), never from the caller
- [ ] **PIPE-04**: Voice retrieval resolves its tenant from a signed, expiring token minted by the app, not from a bare caller-supplied `userId`, and never falls back to a global search
- [ ] **PIPE-05**: Context assembly (dedupe, grouping, source labels, links section, image handling) lives in the pipeline and is shared by all three entry points, without per-chunk N+1 lookups
- [ ] **PIPE-06**: The pipeline returns a discriminated status (`ok | empty | error | degraded`); only a verified `empty` result may trigger the "information not available" refusal, and errors are logged and surfaced as errors
- [ ] **PIPE-07**: Each pipeline stage has its own switch, timeout and degrade-to-skip path; an `AbortSignal` flows through all stages
- [ ] **PIPE-08**: Unused retrieval modules (`retrieval-strategies.ts`, `optimized-search.ts`, `adaptive-retrieval.ts`, `reranker-adapter.ts`, never-called parts of `thinking-rag-enhancer.ts`) are removed; still-used logic is re-homed under `src/lib/rag/`
- [ ] **PIPE-09**: With all new switches off (`RAG_PIPELINE=legacy`), the eval results reproduce the baseline within its noise band
- [ ] **PIPE-10**: Node.js 22 is the documented and enforced runtime (`engines`, docs, CI), as required by the Weaviate and Qdrant clients

### Data Layer (DATA)

- [ ] **DATA-01**: One shared `ingest()` path and chunk writer serve chat/Config UI uploads, Nango sync, scrapers and image uploads
- [ ] **DATA-02**: Every chunk stores the same metadata: tenant, document ID, version, `is_current`, source, document type, document date, language, page or section, content hash, parser used, and the existing URL metadata
- [ ] **DATA-03**: The user can pick a document type per file at upload (financial/report, contract/legal, product/technical, scanned/image), with an auto-detected default they can change; unclassified documents fall back to `general`
- [ ] **DATA-04**: The document type selects a processing profile (parser options, chunk size and boundaries, OCR, metadata extraction such as dates and financial figures), and profiles are defined as data, not branching code
- [ ] **DATA-05**: Docling runs in the sidecar as an async parse job (HybridChunker with table headers repeated in each chunk, explicit tokenizer, OCR languages for zh/en/it) and is switchable with LlamaParse; LlamaParse failure or a missing key falls back to Docling, and `parser_used` is recorded
- [ ] **DATA-06**: Uploading a file whose normalized content hash already exists in the same tenant does not create duplicate chunks; hashes are never compared across tenants
- [ ] **DATA-07**: Uploading a new version of a document replaces the old one atomically (new version inserted, `is_current` flipped in one transaction, old version soft-superseded so existing message citations still resolve); retrieval returns current versions only
- [ ] **DATA-08**: Retrieval can filter by date range, source, document, document type and language

### Embeddings (EMB)

- [ ] **EMB-01**: Embedding providers are switchable: OpenAI `text-embedding-3-small` (kept), Voyage `voyage-4-large` (with `input_type`), and Qwen3-Embedding-8B through a hosted inference API (DeepInfra primary, OpenRouter fallback; query-side instruction prefix; MRL truncation and re-normalization)
- [ ] **EMB-02**: Each embedding profile (model + dimension) is stored side by side (`halfvec` where needed, partial HNSW index per profile), and switching the active profile is a pointer flip that can be rolled back
- [ ] **EMB-03**: The query-time embedding model is derived from the active index profile, and a model or dimension mismatch fails loudly at startup and per request
- [ ] **EMB-04**: A re-embedding job reads stored chunk text only (never re-parses), runs in batches, resumes from where it stopped, supports dry-run, and can roll back (extends `scripts/rag/reprocess-documents.js`)

### Retrieval (RET)

- [ ] **RET-01**: Retrieval backends are switchable — pgvector (kept permanently, default), Weaviate and Qdrant — behind one `RetrievalBackend` interface that only accepts a `TenantScope`
- [ ] **RET-02**: Each backend runs hybrid retrieval (lexical + vector, filters applied before search) and the results are fused with reciprocal rank fusion
- [ ] **RET-03**: Lexical search works for Chinese, English and Italian on all three backends using one shared application tokenizer that writes a `lexical_text` field; a Chinese exact-term test (model numbers, IDs, names) passes on every backend
- [ ] **RET-04**: The pgvector hybrid function is callable only by the server role, never by `anon`
- [ ] **RET-05**: Supabase stays the only source of truth; a trigger-fed outbox and a drain worker sync inserts, updates, deletes (including cascade deletes) and re-embeds to Weaviate and Qdrant, and a reconcile job detects and repairs drift
- [ ] **RET-06**: Weaviate uses one tenant per workspace; Qdrant uses a shared collection per embedding profile with an `is_tenant` index and a tenant filter injected by the adapter on every query and prefetch
- [ ] **RET-07**: Chunk IDs returned by Weaviate or Qdrant are re-validated against Supabase under the caller's scope before use
- [ ] **RET-08**: A cross-tenant canary test suite (personal vs organization, null organization, removed member, after delete, after version replace, after re-embed) runs against every backend in CI and is a release gate
- [ ] **RET-09**: Each tenant and backend has an index-ready state; if an external backend is not ready or fails, retrieval falls back to pgvector and reports `degraded`

### Rerank & Context (RNK)

- [ ] **RNK-01**: Rerankers are switchable — Cohere `rerank-v5.0-pro` / `rerank-v5.0-fast` and Voyage `rerank-3` (with `rerank-2.5` as the multilingual fallback), plus the existing local BM25 reranker — and run after hybrid retrieval on an enlarged candidate pool
- [ ] **RNK-02**: The candidate pool size and final top-k are chosen by an eval sweep, not hard-coded
- [ ] **RNK-03**: The most relevant chunks are placed at the start and end of the context; adjacent chunks from the same document are merged; the context respects a token budget
- [ ] **RNK-04**: Context compression (relevant-span extraction where the reranker supports it) is available behind a switch
- [ ] **RNK-05**: The system refuses to answer when the top rerank score is below a threshold calibrated per reranker provider and language on the dev split and checked on the holdout split
- [ ] **RNK-06**: When the reranker times out or fails, the fused order is used and threshold refusal is disabled for that request

### Query Layer (QRY)

- [ ] **QRY-01**: Follow-up questions in text chat are rewritten into standalone queries using the conversation history (LlamaIndex condense-question method), keeping the user's language and numbers, names and IDs verbatim; standalone questions pass through unchanged
- [ ] **QRY-02**: Multi-query expansion generates several query variants and fuses their results with reciprocal rank fusion (LlamaIndex `QueryFusionRetriever` method)
- [ ] **QRY-03**: HyDE (LlamaIndex `HyDEQueryTransform` method) is available, off by default, never used in voice
- [ ] **QRY-04**: Compound questions are decomposed into at most four sub-questions (LlamaIndex `SubQuestionQueryEngine` method), producing sub-questions only — never a synthesized answer
- [ ] **QRY-05**: A router reuses the existing query classifier to decide per query which transforms run; each transform has its own switch, timeout and latency budget, and the original query is always retained in retrieval
- [ ] **QRY-06**: The LlamaIndex implementation (default) is native TypeScript following LlamaIndex's algorithms and prompts, with no framework call at query time; both implementations use structured outputs defined by the Pydantic/Zod contract
- [ ] **QRY-08**: An admin can switch the query layer between LlamaIndex (default) and LangChain (`@langchain/classic`, confined to one adapter that wraps `src/lib/rag/` as a retriever, with its zod 4 isolated from the app's zod 3) in the Config UI (`RAG_QUERY_FRAMEWORK=llamaindex|langchain`); both produce the same transform outputs and are compared in eval
- [ ] **QRY-07**: Voice uses a reduced profile (history rewrite, hybrid retrieval, optional fast reranker) that stays within its latency budget

### Generation (GEN)

- [ ] **GEN-01**: When the selected chat model is Claude, the answer is generated through the direct Anthropic API with Citations enabled (one plain-text document per chunk), using an OpenRouter-to-Anthropic model ID map kept in the five model locations; tools, MCP and webSearch keep working or the turn falls back to the existing path
- [ ] **GEN-02**: For other models, the prompt asks for chunk-ID citations, and the server parses them from the stream, drops unknown IDs and validates each against the context actually sent
- [ ] **GEN-03**: Both paths produce the same persisted `citations[]` record with a snapshot of the cited text, so citations still resolve after documents are re-chunked or replaced
- [ ] **GEN-04**: Structured output is used for the non-Claude citation list and for helper calls; it is never combined with Claude Citations in one request
- [ ] **GEN-05**: After the answer streams, the sidecar scores groundedness: HHEM-2.3 via the Vectara API when the Vectara key is set and opt-in is on (Chinese and English); HHEM-2.1-Open locally for English when there is no key; Italian and other unsupported cases are recorded as "not checked"
- [ ] **GEN-06**: The score and its status are stored in message metadata and logs, and the UI shows a three-state badge (verified / possibly unreliable / not checked) in strict and balanced modes only; answers are never blocked
- [ ] **GEN-07**: Existing behavior is unchanged: strict-mode "information not available", webSearch + Exa, `source_images`, `{{context}}`, refusal text in the user's language

### Admin & Closeout (ADM)

- [ ] **ADM-01**: Every new provider and switch can be configured in the Config UI, with masked secrets, a Test-connection button and an index-compatibility warning when the active embedding profile and backend don't match
- [ ] **ADM-02**: A full regression on the locked test split sets the final defaults for backend, embedding profile and reranker, and the decision is recorded with the numbers
- [ ] **ADM-03**: `AGENTS.md`, `.env` templates and setup docs describe the sidecar, providers, switches, sync and eval workflow
- [ ] **ADM-04**: A vendor data-flow inventory lists which content goes to which external service (Vectara, Cohere, Voyage, DeepInfra, Weaviate, Qdrant, Anthropic, LlamaCloud)

## v2 Requirements

### Retrieval quality

- **RQ-01**: Contextual chunk prefixes (generated per-chunk context), evaluated by A/B
- **RQ-02**: Parent-child chunk expansion
- **RQ-03**: Contract-clause and financial-row specific chunkers
- **RQ-04**: Cross-language query variants

### Generation & UX

- **UX-01**: Sentence-level highlighting of cited spans
- **UX-02**: Citation click-through to the source page
- **UX-03**: Partial answers when only part of a compound question is answerable
- **UX-04**: User feedback on hallucination warnings
- **UX-05**: Chat filter chips (document type, date, source)
- **UX-06**: Document version-history UI

### Operations

- **OPS-01**: Production sampling into the eval pipeline
- **OPS-02**: Shadow dual-read between backends
- **OPS-03**: Editable document-type profiles in the Config UI
- **OPS-04**: Blocking answers on low groundedness scores

## Out of Scope

| Feature | Reason |
|---------|--------|
| Third-ranked products (Reducto, DSPy, Gemini Embedding, Elasticsearch/OpenSearch, Qwen3-Reranker, Galileo Luna-2, Langfuse) | User chose the top two per layer |
| Retiring pgvector | User wants it kept permanently |
| Self-hosted GPU for Qwen3-Embedding-8B | User chose hosted inference |
| Blocking answers on HHEM scores | This milestone only records and warns |
| Routing all RAG answers through Claude | Citations only when the selected model is Claude |
| Numeric "accuracy %" shown to users | Misleading; three-state badge instead |
| Per-tenant provider choice | One deployment-level configuration keeps eval comparable |
| Hot-switching embedding model or backend without migration | Causes mixed-model indexes; switching goes through profiles and sync |
| Existing security issues in `CONCERNS.md` (admin/config routes, Polar signature, `connector_config` RLS) | Handled separately; new surfaces in this project are authenticated from the start |
| Committing real customer documents or golden items built from them | `AGENTS.md` rule 7 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| EVAL-01 | Phase 1 | Pending |
| EVAL-02 | Phase 1 | Pending |
| EVAL-03 | Phase 1 | Complete |
| EVAL-04 | Phase 1 | Pending |
| EVAL-05 | Phase 1 | Pending |
| EVAL-06 | Phase 1 | Pending |
| EVAL-07 | Phase 1 | Pending |
| EVAL-08 | Phase 1 | Pending |
| EVAL-09 | Phase 1 | Pending |
| EVAL-10 | Phase 1 | Pending |
| EVAL-11 | Phase 1 | Pending |
| EVAL-12 | Phase 1 | Pending |
| EVAL-13 | Phase 1 | Pending |
| PIPE-01 | Phase 2 | Pending |
| PIPE-02 | Phase 2 | Pending |
| PIPE-03 | Phase 2 | Pending |
| PIPE-04 | Phase 2 | Pending |
| PIPE-05 | Phase 2 | Pending |
| PIPE-06 | Phase 2 | Pending |
| PIPE-07 | Phase 2 | Pending |
| PIPE-08 | Phase 2 | Pending |
| PIPE-09 | Phase 2 | Pending |
| PIPE-10 | Phase 2 | Pending |
| DATA-01 | Phase 3 | Pending |
| DATA-02 | Phase 3 | Pending |
| DATA-03 | Phase 3 | Pending |
| DATA-04 | Phase 3 | Pending |
| DATA-05 | Phase 3 | Pending |
| DATA-06 | Phase 3 | Pending |
| DATA-07 | Phase 3 | Pending |
| DATA-08 | Phase 4 | Pending |
| EMB-01 | Phase 3 | Pending |
| EMB-02 | Phase 3 | Pending |
| EMB-03 | Phase 3 | Pending |
| EMB-04 | Phase 3 | Pending |
| RET-01 | Phase 4 | Pending |
| RET-02 | Phase 4 | Pending |
| RET-03 | Phase 4 | Pending |
| RET-04 | Phase 4 | Pending |
| RET-05 | Phase 7 | Pending |
| RET-06 | Phase 7 | Pending |
| RET-07 | Phase 7 | Pending |
| RET-08 | Phase 7 | Pending |
| RET-09 | Phase 7 | Pending |
| RNK-01 | Phase 4 | Pending |
| RNK-02 | Phase 4 | Pending |
| RNK-03 | Phase 4 | Pending |
| RNK-04 | Phase 4 | Pending |
| RNK-05 | Phase 4 | Pending |
| RNK-06 | Phase 4 | Pending |
| QRY-01 | Phase 6 | Pending |
| QRY-02 | Phase 6 | Pending |
| QRY-03 | Phase 6 | Pending |
| QRY-04 | Phase 6 | Pending |
| QRY-05 | Phase 6 | Pending |
| QRY-06 | Phase 6 | Pending |
| QRY-07 | Phase 6 | Pending |
| QRY-08 | Phase 6 | Pending |
| GEN-01 | Phase 5 | Pending |
| GEN-02 | Phase 5 | Pending |
| GEN-03 | Phase 5 | Pending |
| GEN-04 | Phase 5 | Pending |
| GEN-05 | Phase 5 | Pending |
| GEN-06 | Phase 5 | Pending |
| GEN-07 | Phase 5 | Pending |
| ADM-01 | Phase 7 | Pending |
| ADM-02 | Phase 7 | Pending |
| ADM-03 | Phase 7 | Pending |
| ADM-04 | Phase 7 | Pending |

**Coverage:**
- v1 requirements: 69 total
- Mapped to phases: 69
- Unmapped: 0 ✓

**Mapping notes:**
- RET-01, RET-02 and RET-03 are mapped to Phase 4, which builds the retrieval adapter contract, the pgvector hybrid search, the shared tokenizer and backend-agnostic conformance tests. Their "every backend" clauses for Weaviate and Qdrant are verified in Phase 7 (success criterion 3).
- DATA-08 (metadata filters) is mapped to Phase 4 because filters are applied inside the hybrid search function built there; the metadata it filters on comes from Phase 3.
- QRY-08 adds a switchable LangChain implementation of the query layer (`RAG_QUERY_FRAMEWORK=llamaindex|langchain`, default `llamaindex`). The former Out of Scope row "LangChain (any layer)" was removed and QRY-06 reworded accordingly.

---
*Requirements defined: 2026-11-22*
*Last updated: 2026-11-22 after roadmap creation (traceability mapped, QRY-08 added to coverage)*
