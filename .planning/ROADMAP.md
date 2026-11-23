# Roadmap: myRAG RAG 全链路升级

## Overview

This milestone upgrades myRAG's retrieval from "vector search plus heuristic boosts" to a measured six-layer pipeline, without breaking anything that is already live. It starts by building the evaluation harness and recording a baseline of today's system. Next, text chat, embedded chat and voice are routed through one tenant-safe pipeline that reproduces that baseline. On that seam it unifies ingestion and embedding profiles, then adds hybrid retrieval, reranking and calibrated refusal on pgvector. Verified citations with groundedness badges and the query layer (two switchable frameworks) follow in parallel. The milestone finishes with Weaviate and Qdrant as synced, tenant-safe backends, and a full regression that sets the shipped defaults.

**Rules that apply to every phase:**
- **Proven against the baseline:** a phase is complete only when the eval smoke tier, compared with the Phase 1 baseline by paired differences, shows no metric (overall, per language, per category) dropping beyond the noise band.
- **Behind a switch:** every new component has an env switch mirrored in the five config locations (`check-config` passes), and switching it off restores the previous behavior.
- **Authenticated from the start:** every new endpoint and sidecar route requires auth and fails closed.
- **Verification without live services:** this environment has no live vendor API keys and no live Supabase project, and no running Docker daemon. Success criteria are verified with tests, fakes, recorded vendor responses, the committed zh/en/it fixture corpus, and a local or CI-hosted Postgres with pgvector seeded from that corpus (Weaviate and Qdrant run as CI service containers). Steps that need a real key or the real knowledge base are listed per phase under **Live verification**. They are that phase's end-of-phase human verification items.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Evaluation Harness & Baseline** - Python sidecar, Pydantic/Zod contract, golden set, eval runner, CI gates and a measured baseline of today's system
- [ ] **Phase 2: Unified Retrieval Pipeline & Tenant Scope** - Text chat, embedded chat and voice run through one `src/lib/rag/` pipeline that only searches a server-verified tenant, reproducing the baseline
- [ ] **Phase 3: Unified Ingestion & Embedding Profiles** - One `ingest()` for every upload path with document types, Docling fallback, dedup, versioning, switchable embeddings and rollbackable re-embedding
- [ ] **Phase 4: Hybrid Retrieval, Reranking & Calibrated Refusal** - Filtered hybrid search on pgvector, switchable rerankers, edge-ordered context and refusal from calibrated rerank scores
- [ ] **Phase 5: Verified Citations & Groundedness** - Claude Citations, validated chunk-ID citations for other models, one persisted citation record and a post-stream groundedness badge
- [ ] **Phase 5.1: Prompt Injection Defense** (INSERTED) - Tagged, instruction-free context, runtime injection detection and an injection eval gated at 0
- [ ] **Phase 6: Query Layer (LlamaIndex & LangChain)** - History rewrite, multi-query fusion, HyDE and sub-questions with a router and budgets, in two switchable frameworks compared in eval
- [ ] **Phase 7: External Backends & Release Defaults** - Weaviate and Qdrant synced from Supabase behind tenant canaries; a full regression sets the defaults; Config UI and docs complete

## Phase Details

### Phase 1: Evaluation Harness & Baseline
**Goal**: The quality of today's RAG system is measured reproducibly, per language and per question category, and CI blocks any change that makes it worse
**Depends on**: Nothing (first phase)
**Requirements**: EVAL-01, EVAL-02, EVAL-03, EVAL-04, EVAL-05, EVAL-06, EVAL-07, EVAL-08, EVAL-09, EVAL-10, EVAL-11, EVAL-12, EVAL-13
**Success Criteria** (what must be TRUE):
  1. The `rag-sidecar/` service builds from its Dockerfile and answers health and readiness checks; sidecar tests show that requests with a missing or wrong shared secret are rejected and that every request is refused when the secret is unset.
  2. `npm run test-rag` runs the eval smoke tier on the committed zh/en/it fixture corpus through the authenticated `POST /api/internal/rag/run` endpoint (off in production unless enabled) and reports Recall@k, MRR, correct-refusal and false-refusal rates per language and per category, with no customer data, no live vendor keys and no LLM judge.
  3. A three-run baseline of the current system on the fixture corpus is committed with a config hash per run and the mean and spread of each metric, and a PR whose change drops a deterministic metric beyond that noise band fails the PR smoke workflow (shown with a deliberately degraded config).
  4. CI fails when a Pydantic model changes without its regenerated Zod schema, when an RAG env var is missing from any of the five config locations, or when a characterization test breaks; those tests pass on today's code for strict-mode "information not available", webSearch + strict using Exa results, `source_images` streaming and persistence, and `{{context}}` substitution.
  5. Pointed at a workspace, the drafting tool writes span-labelled golden items (document, section, quote, language, category, review status; never chunk IDs) to a gitignored location with a frozen dev/test split, and the nightly tier computes Faithfulness, Answer Relevance and Context Recall with a pinned judge from a different model family and telemetry disabled (verified with a stubbed judge and a fixture workspace).
**Live verification**: Draft the 50–200 item golden set from a real knowledge-base workspace and have the user review every item; record the three-run baseline on that real set with the OpenAI embedding key and the judge key, then set per-metric improvement targets from it; run the first nightly judge tier with real keys.
**Plans**: 21/22 plans executed

Plans:
**Wave 1**
- [x] 01-01-PLAN.md — Tracer: Pydantic eval-run contracts through `npm run gen:schemas` to generated zod/v3 schemas that accept Pydantic-built values (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 01-02-PLAN.md — PGlite fixture database with the repo SQL and 127.0.0.1 edge fakes running today's unmodified retrieval (wave 2)
- [x] 01-03-PLAN.md — Golden-set contracts (GoldenItem, split manifest, drafted-item batch) generated into Zod (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 01-04-PLAN.md — Authenticated eval route, legacy post-filter replica and `npm run test-rag` writing the first trace (wave 3)
- [x] 01-05-PLAN.md — Report, baseline, noise, gate, judge and sidecar contracts generated into Zod (wave 3)
- [x] 01-06-PLAN.md — Locked eval uv project with judge/draft extras, span matching and frozen split (wave 3)
- [x] 01-07-PLAN.md — English fixture corpus documents (wave 3)
- [x] 01-08-PLAN.md — Chinese and Italian fixture corpus documents (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 01-09-PLAN.md — Vitest infrastructure, route auth matrix, harness concurrency and HTTP transport tests (wave 4)
- [x] 01-10-PLAN.md — Reproducible runs: pinned eval env, hashed RunManifest, Pydantic validation of traces (wave 4)
- [x] 01-11-PLAN.md — New env vars in all five config locations, env manifest and check-config with knownGaps ratchet (wave 4)
- [x] 01-12-PLAN.md — rag-sidecar FastAPI skeleton: probes, fail-closed shared-secret auth, Dockerfile (wave 4)
- [x] 01-13-PLAN.md — Golden/trace loaders, Python corpus reader and deterministic metrics (wave 4)

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 01-14-PLAN.md — Eval answer generation (include_answer) and nightly harness entry point (wave 5)
- [x] 01-15-PLAN.md — 72-item trilingual fixture golden set, frozen split and integrity tests (wave 5)
- [x] 01-16-PLAN.md — Report writer and score CLI (wave 5)
- [x] 01-17-PLAN.md — Characterization tests: strict refusal, webSearch + Exa, source_images, {{context}}, legacy post-filter sentinel (wave 5)
- [x] 01-18-PLAN.md — Judge tier: DeepEval + Ragas, pinned non-Claude judge, telemetry off, stub-judge tests (wave 5)
- [x] 01-19-PLAN.md — Golden-set drafting tool: tenant-scoped sources, verified quotes, private output, frozen split (wave 5)

**Wave 6** *(blocked on Wave 5 completion)*
- [x] 01-20-PLAN.md — Three-run fixture baseline, noise-band gate, final npm run test-rag and degraded-config demo (wave 6)
- [x] 01-21-PLAN.md — Contract samples round trip and schema-parity tests over the final contract set (wave 6)

**Wave 7** *(blocked on Wave 6 completion)*
- [ ] 01-22-PLAN.md — GitHub Actions PR smoke and nightly workflows, new-code type-check (wave 7)

### Phase 2: Unified Retrieval Pipeline & Tenant Scope
**Goal**: Text chat, embedded chat and voice get their context from one pipeline that can only search a tenant verified on the server, and answers are unchanged from the baseline
**Depends on**: Phase 1
**Requirements**: PIPE-01, PIPE-02, PIPE-03, PIPE-04, PIPE-05, PIPE-06, PIPE-07, PIPE-08, PIPE-09, PIPE-10, OBS-01, OBS-02, EVAL-14, EVAL-15
**Success Criteria** (what must be TRUE):
  1. Text chat, embedded chat and voice all retrieve through `src/lib/rag/`; a CI check fails if any file outside it imports an embedding provider, retrieval backend or reranker; the unused retrieval modules are deleted and `tsc --noEmit` passes.
  2. Tests show that three kinds of request retrieve nothing outside the caller's verified tenant: an `organizationId` in the request body for an organization the caller does not belong to, an embedded chat request naming a different workspace than its server-side embed configuration, and a voice request with a bare `userId` or an expired or forged token. Voice never falls back to a global search.
  3. With `RAG_PIPELINE=legacy` and every new switch off, the eval smoke tier reproduces the Phase 1 baseline within its noise band, running on Node.js 22, which `engines`, the docs and CI enforce.
  4. Fault-injection tests show that a failing or timed-out stage is logged and surfaced as `error` or `degraded`, never as "information not available"; that only a verified `empty` result triggers the strict-mode refusal; that each stage can be switched off or skipped on timeout; and that aborting a request cancels in-flight stages.
  5. All three entry points share one context-assembly step (dedupe, grouping, source labels, links section, images), and a query-counting test shows its database query count stays fixed as the number of returned chunks grows.
  6. A production request produces one Langfuse trace with a span per stage (latency, candidate counts), sent asynchronously without delaying the answer, with a `[RAG Trace]` log line as the fallback when Langfuse is off or unreachable (tested with a fake Langfuse endpoint), and eval reports show p50/p95 latency per stage against the documented text-chat and voice budgets.
  7. Reports split every metric by provenance and the new `colloquial`, `ambiguous` and `typo` categories; a sampled, PII-masked share of production traces lands in a review queue, and online judge scores appear on the Langfuse traces (tested with a fake Langfuse endpoint and a stub judge).
**Live verification**: Check tenant resolution against a real Supabase project with personal and organization memberships in both single-tenant and multi-tenant modes; run a voice session with the running `voice-agent/` using the signed token; repeat the legacy-parity check on the real golden set.
**Plans**: TBD

### Phase 3: Unified Ingestion & Embedding Profiles
**Goal**: Every document enters the knowledge base through one path (typed, deduplicated, versioned and carrying the same metadata), and its chunks are embedded under a switchable embedding profile that can be rolled back
**Depends on**: Phase 2
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04, DATA-05, DATA-06, DATA-07, EMB-01, EMB-02, EMB-03, EMB-04, CHK-01, CHK-02, SEC-01, XLG-02, DATA-09, DATA-10, DATA-11
**Success Criteria** (what must be TRUE):
  1. User can pick a document type for each file at upload (financial/accounting report, contract/legal, invoice/receipt, product/technical, scanned/image), starting from a default set by the admin (fixed type or auto-detect, per tenant and per source) that they can change, and untyped files become `general`; each type applies its processing profile (parser options, chunk size and boundaries, OCR, metadata extraction), which is defined as data, as shown by ingesting a fixture file of every type.
  2. A fixture ingested through chat/Config UI upload, Nango sync, a scraper and image upload produces chunks with the same metadata fields on every path: tenant, document ID, version, `is_current`, source, type, date, language, page or section, content hash, `parser_used` and the URL metadata.
  3. Re-uploading the same content in the same tenant adds no chunks, while the same content in another tenant is ingested normally; uploading a new version flips `is_current` in one transaction, retrieval returns only current chunks, and a message citing the old version still resolves.
  4. With LlamaParse unconfigured or failing (stubbed), fixture PDFs including a table and a scan are parsed by the sidecar's async Docling job with OCR configured for zh/en/it; every table chunk repeats its header row, and `parser_used` records which parser ran.
  5. Tests with fake providers show the following. Switching the active embedding profile among OpenAI `text-embedding-3-small`, Voyage `voyage-4-large` and hosted Qwen3-Embedding-8B is a pointer flip that can be rolled back. The re-embed job (dry-run, batched, resumable after a kill, reads stored chunk text and makes zero parser calls) fills the new profile side by side. A query-model or dimension mismatch fails loudly at startup and per request.
  6. Every chunk carries `metadata.section_path`, prefixed into its embedding and `lexical_text` (not into the LLM text); on the contract fixture, the "exceptions to this clause" question retrieves the chunk holding the whole exception list, and clause pieces all carry the clause heading.
  7. A fixture document containing injection phrasing in zh, en or it is quarantined at ingestion and never appears in any retrieval result until an admin releases it in the Config UI.
  8. The fixture golden set has a `cross_lingual` category covering all six query-language/document-language pairs; its baseline under `RAG_PIPELINE=legacy` is recorded, and each embedding profile is compared on it per pair (the multilingual profiles must beat `text-embedding-3-small` on the cross-lingual slice to become the default candidate).
  9. Fixture invoices in zh, en and it yield validated invoice metadata (number, dates, parties, tax IDs, currency, totals, line items) that can be filtered by supplier, date and amount, and an invoice-number question retrieves the exact invoice; admin-set tenant and per-source default types are applied in the documented precedence, and changing an existing document’s type re-processes it as a new version; images inside a fixture PDF become captioned image chunks with page numbers that stream as `source_images`.
**Live verification**: Parse real documents with the LlamaCloud key, and run Docling OCR on real scanned Chinese and Italian files; call Voyage, DeepInfra and OpenRouter with real keys (check Qwen3 dimension parameter, instruction prefix, MRL truncation); run the re-embed job and the `halfvec` HNSW index build on the real Supabase project; compare each embedding profile with the baseline on the real golden set; sync a real Nango connection.
**Plans**: TBD
**UI hint**: yes

### Phase 4: Hybrid Retrieval, Reranking & Calibrated Refusal
**Goal**: On pgvector, questions in Chinese, English and Italian find the right chunks through filtered hybrid search and reranking, and the system refuses when the best reranked evidence is too weak
**Depends on**: Phase 3
**Requirements**: RET-01, RET-02, RET-03, RET-04, DATA-08, RNK-01, RNK-02, RNK-03, RNK-04, RNK-05, RNK-06, CHK-03, LAT-01, LAT-02, XLG-03, CHK-04, CHK-05
**Success Criteria** (what must be TRUE):
  1. Against a local Postgres with pgvector seeded with the fixture corpus, Chinese exact-term queries (model numbers, IDs, names) and their English and Italian counterparts retrieve the expected chunk. The search is hybrid lexical + vector over the shared tokenizer's `lexical_text`, fused with RRF. Filters by date range, source, document, document type and language apply before search, and the hybrid function runs for the server role and is refused for `anon`.
  2. Cohere `rerank-v5.0-pro`/`rerank-v5.0-fast`, Voyage `rerank-3` (with `rerank-2.5` as fallback) and the local BM25 reranker are switchable and rerank an enlarged candidate pool; when a fake reranker times out or errors, the fused order is used and threshold refusal is off for that request.
  3. The assembled context puts the most relevant chunks at its start and end, merges adjacent chunks from the same document and stays within the token budget; context compression changes the context only when its switch is on.
  4. Calibration tooling derives a refusal threshold per reranker provider and language on the dev split and checks it on the holdout split, and sweep tooling picks the candidate pool size and final top-k; both record their numbers (shown on the fixture set with fake rerankers). With the threshold applied, fixture no-answer questions are refused and answerable ones are not.
  5. The pgvector retrieval adapter accepts only a `TenantScope`, and its hybrid conformance tests (including the Chinese exact-term test) are written to run unchanged against any backend; the fixture eval records paired differences against baseline, and no language slice drops beyond the noise band on Recall@k or MRR.
  6. With `RAG_PARENT_CHILD` on, child hits return their parent once within the token budget and tenant scope, and the eval shows Recall gains on clause/exception items with no other slice dropping beyond the noise band.
  7. Retrieval paths run in parallel, candidates are deduplicated before rerank, the rerank input count is capped and reported, and the fast rerank tier keeps voice within its latency budget.
  8. Cross-language questions also succeed through the lexical path and the local BM25 reranker (translated query), and the refusal threshold calibrated on the cross-lingual slice does not raise its false-refusal rate above the same-language slices beyond the noise band.
  9. Admin can set child size, parent mode and parent size per document type in the Config UI (presets 128/512, 256/1024, 256/2048 or custom); a child size above the embedding input limit or a parent smaller than twice the child is rejected, ratio and context-budget problems are warned; the new profile is built side by side and can be activated and rolled back; the sweep report compares the candidate profiles on the fixture golden set per document type and question category, and the chosen profile is recorded with its numbers.
**Live verification**: Calibrate thresholds and sweep pool size and top-k with real Cohere and Voyage keys on the real golden set's dev split, then check them on the holdout split; compare Voyage `rerank-3` with `rerank-2.5` on the zh and it slices; apply the hybrid SQL migration to the real Supabase project and confirm Chinese lexical behavior there.
**Plans**: TBD

### Phase 5: Verified Citations & Groundedness
**Goal**: Every RAG answer cites only chunks that were actually sent to the model, its citations survive later document changes, and users can see whether the answer was checked for groundedness
**Depends on**: Phase 4
**Requirements**: GEN-01, GEN-02, GEN-03, GEN-04, GEN-05, GEN-06, GEN-07, EVAL-16
**Success Criteria** (what must be TRUE):
  1. Against recorded or fake Anthropic streams: when the selected model is Claude, the answer comes from the direct Anthropic API with Citations (one plain-text document per chunk) and no structured output on that call. The OpenRouter-to-Anthropic model ID map passes the five-location model check, and turns needing tools, MCP or webSearch keep working or fall back to the existing path.
  2. For other models, the server parses chunk-ID citations from the stream even when a marker is split across tokens, drops unknown IDs and IDs not in the context sent, and returns the citation list through structured output. Both paths persist the same `citations[]` record with a text snapshot that still resolves after the cited document is re-chunked or replaced.
  3. Tests with a fake Vectara endpoint and a stubbed local model show that after the answer finishes streaming, the sidecar groundedness check stores a score and status in message metadata and logs, and never delays or blocks the answer. HHEM-2.3 through Vectara runs only when the key is set and opt-in is on (Chinese, English); HHEM-2.1-Open runs locally for English when there is no key; Italian and other unsupported cases are recorded as "not checked".
  4. User sees a three-state badge (verified / possibly unreliable / not checked), never a numeric score, on RAG answers in strict and balanced modes only.
  5. The Phase 1 characterization tests still pass (strict-mode "information not available" in the user's language, webSearch + Exa, `source_images`, `{{context}}`), and the fixture eval shows no slice dropping beyond the noise band.
  6. User can mark any RAG answer helpful or not helpful; the vote is stored with the message, sent to Langfuse as a score, and "not helpful" votes and "possibly unreliable" results appear in the review queue.
**Live verification**: Start with a spike using a real `ANTHROPIC_API_KEY` to confirm Citations survive AI SDK v6 streaming with tools, MCP approvals and webSearch; call Vectara with a real key and opt-in, and confirm host, header, rate limits, `source_texts` limit and data retention before any multi-tenant use; download and run HHEM-2.1-Open in the sidecar; compare Faithfulness on the real golden set with the baseline.
**Plans**: TBD
**UI hint**: yes

### Phase 5.1: Prompt Injection Defense (INSERTED)
**Goal**: Content from the knowledge base is always treated as reference material, never as instructions the model follows
**Depends on**: Phase 5
**Requirements**: SEC-02, SEC-03, SEC-04, SEC-05
**Success Criteria** (what must be TRUE):
  1. Retrieved chunks reach the model wrapped in `<documents><doc id>` tags with embedded same-name tags escaped, under a system-prompt statement that tagged content is not instructions; `{{context}}` still works, and the Claude Citations path carries the same statement.
  2. Before generation, chunks are checked by the SEC-01 rules and, when switched on, Prompt Guard (sidecar) or Lakera Guard; flagged chunks are dropped or down-weighted and appear in the trace.
  3. The fixture `injection` category (zh/en/it) has an attack-success rate of 0, gated in CI, and no other category drops beyond the noise band; with all SEC switches off, results match the baseline.
  4. A design document describes reading critical facts (prices, stock) from the database through tools/MCP instead of document text.
**Live verification**: Run Prompt Guard in the sidecar image and Lakera Guard with a real key against the injection set and real documents; measure added latency against the OBS-02 budgets.
**Plans**: TBD

### Phase 6: Query Layer (LlamaIndex & LangChain)
**Goal**: Follow-up, vague and compound questions retrieve as well as standalone ones under either query framework, within their latency budgets, and voice stays fast
**Depends on**: Phase 4
**Requirements**: QRY-01, QRY-02, QRY-03, QRY-04, QRY-05, QRY-06, QRY-07, QRY-08, LAT-03, XLG-01, CACHE-01
**Success Criteria** (what must be TRUE):
  1. Under the default `RAG_QUERY_FRAMEWORK=llamaindex`, native TypeScript ports make no framework call at query time and do four things: rewrite follow-ups into standalone queries in the user's language with numbers, names and IDs verbatim (standalone questions pass through unchanged); fuse multi-query variants with RRF; run HyDE only when switched on; and decompose compound questions into at most four sub-questions with no synthesized answer. Outputs validate against the Pydantic-generated Zod schemas (fake LLM, fixture multi-turn and compound items).
  2. The router reuses the existing query classifier to choose transforms per query. Each transform has its own switch, timeout and latency budget, and is skipped without failing the request when it overruns (injected delays). The original query is always retrieved. Voice runs only history rewrite, hybrid retrieval and an optional fast reranker within its latency budget, never HyDE, multi-query or decomposition.
  3. With `RAG_QUERY_FRAMEWORK=langchain`, an adapter built on `@langchain/classic` (history-aware retriever, MultiQueryRetriever, HyDE port, RRF ensemble, decomposition prompt) returns the same output shapes for the same fixture inputs and wraps the `src/lib/rag/` pipeline as its retriever. A CI check fails if LangChain is imported outside that one adapter module, or if the adapter reaches a backend, embedding provider or reranker directly.
  4. Admin can switch the query framework between LlamaIndex (default) and LangChain in the Config UI; the switch is mirrored in the five config locations, and the zod 4 required by `@langchain/core` is isolated so the app's zod 3 schemas, type-check and build are unaffected.
  5. The eval runs both frameworks on the fixture golden set and records paired differences per language and category; under the default framework the multi-turn and compound slices hold or improve against Phase 4, and no slice drops beyond the noise band.
  6. Rewriting runs only when the router asks for it, with a small model and at most two variants; fixture items asking in English or Italian about Chinese documents retrieve the right chunks through translated-query fusion and are answered in the asker’s language.
  7. With the semantic cache on, cache hits have much lower p95 latency than misses, any document change in the tenant invalidates affected entries, and the cross-tenant canary suite includes the cache.
**Live verification**: Run both frameworks with real LLM keys; measure p50/p95 latency of each transform and of the whole pre-retrieval stage for chat (starting budget about 2 s before first token) and voice (about 800 ms), and replace the starting budgets with the measured ones; compare LlamaIndex and LangChain on the real golden set.
**Plans**: TBD
**UI hint**: yes

### Phase 7: External Backends & Release Defaults
**Goal**: Admins can switch retrieval to Weaviate or Qdrant without any cross-tenant leakage, every new provider and switch is configurable in the Config UI, and the shipped defaults are backed by a full regression
**Depends on**: Phase 5, Phase 5.1, Phase 6
**Requirements**: RET-05, RET-06, RET-07, RET-08, RET-09, ADM-01, ADM-02, ADM-03, ADM-04, EVAL-17
**Success Criteria** (what must be TRUE):
  1. Tests against Weaviate and Qdrant containers in CI show that inserts, updates, deletes (including cascade deletes), version replacements and re-embeds in Supabase reach both stores through the outbox and drain worker, and that the reconcile job detects and repairs injected drift. Weaviate uses one tenant per workspace; Qdrant uses a shared collection per embedding profile with an `is_tenant` index and a tenant filter injected on every query and prefetch.
  2. The cross-tenant canary suite (personal vs organization, null organization, removed member, after delete, after version replace, after re-embed) passes on pgvector, Weaviate and Qdrant in CI and blocks release on failure; chunk IDs from an external backend that fail re-validation against Supabase under the caller's scope are dropped.
  3. The Phase 4 hybrid conformance tests, including the Chinese exact-term test, pass unchanged on Weaviate and Qdrant; when an external backend is not ready for a tenant or fails, retrieval falls back to pgvector and reports `degraded`.
  4. Admin can configure every new provider and switch in the Config UI with masked secrets, a Test-connection button and a warning when the active embedding profile and backend don't match.
  5. The regression runner evaluates backend, embedding profile and reranker combinations on the locked test split and writes a defaults decision record with its numbers (shown on fixtures). `AGENTS.md`, the `.env` templates and setup docs describe the sidecar, providers, switches, sync and eval workflow. A vendor data-flow inventory lists what content goes to Vectara, Cohere, Voyage, DeepInfra, Weaviate, Qdrant, Anthropic, LlamaCloud and any other external service the pipeline calls.
  6. Admin can open a queued case in the Config UI, write its expected answer and evidence spans and promote it into the private golden set with provenance `production`; the next eval run includes it, and the periodic failure report groups new failures by layer and category.
**Live verification**: Provision Weaviate and Qdrant (cloud or self-hosted), host the drain worker within the 60 s function limit, and run the canary suite against them; run Test-connection for each real provider; run the full regression on the real locked test split with all real keys (the ADM-02 defaults decision is final only from this live run, not from fixtures); check voice latency end to end.
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 5.1 → 6 → 7. Phases 5 and 6 both depend only on Phase 4 and can run in parallel. Phase 7's backend and sync work needs only Phases 3 and 4; its regression and closeout need Phases 5 and 6.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Evaluation Harness & Baseline | 21/22 | In Progress | - |
| 2. Unified Retrieval Pipeline & Tenant Scope | 0/TBD | Not started | - |
| 3. Unified Ingestion & Embedding Profiles | 0/TBD | Not started | - |
| 4. Hybrid Retrieval, Reranking & Calibrated Refusal | 0/TBD | Not started | - |
| 5. Verified Citations & Groundedness | 0/TBD | Not started | - |
| 5.1. Prompt Injection Defense (INSERTED) | 0/TBD | Not started | - |
| 6. Query Layer (LlamaIndex & LangChain) | 0/TBD | Not started | - |
| 7. External Backends & Release Defaults | 0/TBD | Not started | - |
