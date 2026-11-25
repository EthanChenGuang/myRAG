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
- [x] **Phase 2: Unified Retrieval Pipeline & Tenant Scope** - Text chat, embedded chat and voice run through one `src/lib/rag/` pipeline that only searches a server-verified tenant, reproducing the baseline
- [ ] **Phase 3: Unified Ingestion & Embedding Profiles** - One `ingest()` for every upload path with document types, Docling fallback, dedup, versioning, switchable embeddings and rollbackable re-embedding
- [ ] **Phase 3.1: Tiered Parsing, Incremental Queue & Bulk Backfill** (INSERTED) - Cheapest-tier-that-passes parse routing with escalation, cloud and budget constraints, an ingestion ledger and parse cache, an async upload queue and a budgeted, resumable backfill. **2026-11-24 pause:** trunk merge train at `56b0349d` (#10 #9 #4 #5 merged); resume per `.planning/phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/.continue-here.md`.
- [ ] **Phase 03.1.1: Domain embedding model candidates and per-doc-type model selection** (INSERTED) - Voyage law and finance models as a model catalog, per-doc-type and per-tenant bindings with their own gate, and an extra gated, rollback-able retrieval leg proven per doc type on our own test set
- [ ] **Phase 3.2: Language Support & Ingestion Hardening** (INSERTED) - Deployment-level supported languages chosen at setup, a language-pack registry, chunk languages, scope tags, captions and document translation in the document's language, BGE-M3 fallback, table headers in every profile and row serialization, hidden-text and link checks, optional upload approval
- [ ] **Phase 3.2.1: BGE-M3 Open-Source Fallback Embedding** (INSERTED) - BGE-M3 profile hosted and in the sidecar, catalog entry, activation gate and comparison (split from 3.2, needs 3.1.1)
- [ ] **Phase 4: Hybrid Retrieval, Reranking & Calibrated Refusal** - Filtered hybrid search on pgvector, switchable rerankers, edge-ordered context and refusal from calibrated rerank scores
- [ ] **Phase 04.1: Hybrid retrieval and rerank on by default, proven by eval** (INSERTED) - v2 with hybrid search, `RAG_RERANKER=auto` and threshold refusal become the defaults after a pre-registered eval gate passes; `RAG_PIPELINE=legacy` restores today exactly
- [ ] **Phase 04.1.1: Domain terminology dictionary: expert-maintained synonyms, query expansion, index-time synonyms, log mining** (INSERTED) - Versioned, audited shared and per-tenant dictionary, down-weighted query-time expansion, CSV import/export, mined candidates for expert review; index-time synonyms recorded as not built
- [ ] **Phase 4.2: Retrieval Tuning Additions** (INSERTED) - Rerank pool floor 25 and nDCG, tenant tokenizer dictionary and eval-gated Italian stemming, version-aware retrieval, structured table lookup, near-duplicate clusters and result diversity, TTFT tracing and CI gate
- [ ] **Phase 4.3: Document Access Groups** (INSERTED) - Access groups inside a tenant enforced before ranking on every leg and backend, in the cache, logs and citations, synced from connectors, with same-tenant canaries
- [ ] **Phase 5: Verified Citations & Groundedness** - Claude Citations, validated chunk-ID citations for other models, one persisted citation record and a post-stream groundedness badge
- [ ] **Phase 5.1: Prompt Injection Defense** (INSERTED) - Tagged, instruction-free context, runtime injection detection and an injection eval gated at 0
- [ ] **Phase 05.1.1: Feedback Loop & Real Domain Test Set** (INSERTED) - Tenant-safe retrieval log, refusal and embed feedback, weekly failure mining into an expert-labelled queue, dictionary and training exports, and a real domain test set that gates releases
- [ ] **Phase 5.2: Grounded Answers & Output Safety** (INSERTED) - Partial-answer rule, a citation per factual sentence, claim-level grounding marks, LLM-judge groundedness for unsupported languages, output-length cap, per-language refusal texts, output link and credential guard, uploader tracing
- [ ] **Phase 5.2.1: Calculation Tool & Prompt Budget** (INSERTED) - Deterministic calculation tool and numeric check, whole-prompt token budget that never trims the question (split from 5.2)
- [ ] **Phase 5.3: Evaluation Gates & Online Monitoring** (INSERTED) - No-answer share and absolute false-answer gates, eval gate on Config UI changes, release gate on production promotion, LLM-judge agreement checks, daily drift alerts, representative and versioned test sets with drift monitoring
- [ ] **Phase 6: Query Layer (LlamaIndex & LangChain)** - History rewrite, multi-query fusion, HyDE and sub-questions with a router and budgets, in two switchable frameworks compared in eval
- [ ] **Phase 06.1: Embedding fine-tuning pipeline: synthetic queries, hard negatives, MNRL training, re-embed and switch** (INSERTED) - Consent-gated per-tenant export, synthetic and mined pairs, hard negatives, CachedMNRL training, offline proof, fine-tune slots switched through the EMB-05 gate or 3.1.1 bindings
- [ ] **Phase 6.2: Query Layer Additions** (INSERTED) - Complete decomposition, per-sub-question filters, comparison answers, translation glossary, query-language confidence, voice cross-language, speculative retrieval and Auto model routing behind switches
- [ ] **Phase 6.3: Source Deletion Sync & Purge** (INSERTED) - Change-feed deletions, scheduled reconciliation with alerts, purge across every store, source-of-truth recheck at retrieval, SharePoint/OneDrive connector
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
**Plans**: 22/22 plans executed

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
- [x] 01-22-PLAN.md — GitHub Actions PR smoke and nightly workflows, new-code type-check (wave 7)

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
**Plans**: 36/36 plans executed; verified 7/7 (SC5 by override) on 2026-11-24, 11 live checks pending

Plans:
**Wave 1**
- [x] 02-01-PLAN.md — Type-check config: exclude sibling packages, fix TS5097, per-file tsc ratchet in CI (wave 1)
- [x] 02-03-PLAN.md — New env vars in the five config places, LANGFUSE_* discovery in check-config (wave 1)
- [x] 02-05-PLAN.md — Filtering Supabase fake, fake-edge operators, two-tenant PGlite fixture (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 02-02-PLAN.md — Node.js 22 enforced: engines ^22.12.0, .nvmrc, voice-agent image, CI check, docs (wave 2)
- [x] 02-04-PLAN.md — Per-item baseline rows and rag_eval.paired; baseline re-recorded from pre-pipeline code (wave 2)
- [x] 02-06-PLAN.md — Embed, voice and chat characterization snapshots; frozen chat assembly oracle (wave 2)
- [x] 02-30-PLAN.md — Type fixes: MCP approve route and src/lib/mcp (wave 2)
- [x] 02-31-PLAN.md — Type fixes: WhatsApp clients, routes and components (wave 2)
- [x] 02-32-PLAN.md — Type fixes: embed window on the current useChat API, page/hook fixes (wave 2)
- [x] 02-35-PLAN.md — Type fixes: remaining lib/API files and async params in dynamic routes (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 02-07-PLAN.md — Tracer: branded TenantScope, re-homed legacy search, runRetrieval equals enhancedRetrieveChunks (wave 3)
- [x] 02-33-PLAN.md — Type fixes: providers, settings and UI components (wave 3)
- [x] 02-34-PLAN.md — Type fixes: system-prompt manager, semantic chunker, organization handler, chat utils (wave 3)

**Wave 4–7** *(sequential)*
- [x] 02-08-PLAN.md — Stage runner, switches/timeouts, status semantics, abort, trace collector and [RAG Trace] (wave 4)
- [x] 02-09-PLAN.md — Shared assembleContext, byte-identical to chat, fixed query count (wave 5)
- [x] 02-10-PLAN.md — Tenant resolvers: chat membership, embed config, signed voice token (wave 6)
- [x] 02-11-PLAN.md — Eval route on the pipeline; parity with all paired differences zero (wave 7)
- [x] 02-15-PLAN.md — Authenticated LiveKit token with server identity and voice RAG token (wave 7)

**Wave 8–12** *(sequential)*
- [x] 02-12-PLAN.md — Chat on the pipeline: verified scope, 403 before stream, status mapping (wave 8)
- [x] 02-22-PLAN.md — Langfuse OTel exporter, sampling, masking, fake endpoint (wave 8)
- [x] 02-13-PLAN.md — Chat references and overview fallback scoped; retired imports removed (wave 9)
- [x] 02-14-PLAN.md — Embed on the pipeline with configured tenant; widget error rendering (wave 10)
- [x] 02-16-PLAN.md — Voice-rag and voice-chat on the token scope; no global fallback (wave 11)
- [x] 02-23-PLAN.md — Trace id in chat message metadata; masked review-candidate export (wave 11)
- [x] 02-17-PLAN.md — Voice agent forwards the token, single active user, CI job, deploy docs (wave 12)
- [x] 02-18-PLAN.md — Media routes on the pipeline with the caller's scope (wave 12)
- [x] 02-29-PLAN.md — Type fixes: chat route (wave 12)

**Wave 13–21** *(sequential)*
- [x] 02-19-PLAN.md — Delete retired retrieval modules; ingestion embeddings via @/lib/rag (wave 13)
- [x] 02-20-PLAN.md — CI boundary check with self-test (wave 14)
- [x] 02-21-PLAN.md — Stronger negative control (degrade) and final parity proof (wave 15)
- [x] 02-24-PLAN.md — Latency budgets and per-stage p50/p95 in eval reports (wave 16)
- [x] 02-25-PLAN.md — EVAL-14 contracts: new categories, production provenance, provenance slices (wave 17)
- [x] 02-26-PLAN.md — EVAL-14 fixture items and baseline re-record (wave 18)
- [x] 02-27-PLAN.md — EVAL-15 review queue pull/promote (wave 19)
- [x] 02-28-PLAN.md — EVAL-15 online judge and nightly job (wave 20)
- [x] 02-36-PLAN.md — Zero tsc errors, plain tsc in CI, ignoreBuildErrors false (wave 21)

### Phase 3: Unified Ingestion & Embedding Profiles
**Goal**: Every document enters the knowledge base through one path (typed, deduplicated, versioned and carrying the same metadata), and its chunks are embedded under a switchable embedding profile that can be rolled back
**Depends on**: Phase 2
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04, DATA-05, DATA-06, DATA-07, EMB-01, EMB-02, EMB-03, EMB-04, EMB-05, CHK-01, CHK-02, SEC-01, XLG-02, DATA-09, DATA-10, DATA-11
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
  10. A test re-embed into a new profile shows that documents uploaded during the migration land in both profiles, activation is refused while any current chunk lacks a target vector or while the target profile's eval regresses (including on documents ingested before the migration), and a same-dimension model mismatch fails loudly (EMB-05).
**Live verification**: Parse real documents with the LlamaCloud key, and run Docling OCR on real scanned Chinese and Italian files; call Voyage, DeepInfra and OpenRouter with real keys (check Qwen3 dimension parameter, instruction prefix, MRL truncation); run the re-embed job and the `halfvec` HNSW index build on the real Supabase project; compare each embedding profile with the baseline on the real golden set; sync a real Nango connection.
**Plans**: 49 plans

Plans:
- [ ] 03-01-PLAN.md — Add the Phase 3 schema foundation as ordered, idempotent, additive migrations (wave 1)
- [ ] 03-02-PLAN.md — Define every new Phase 3 contract once in Pydantic and generate the Zod side (project constraint, Phase 1… (wave 1)
- [ ] 03-03-PLAN.md — Add every new Phase 3 environment variable to the five config locations with defaults that keep today's… (wave 1)
- [ ] 03-04-PLAN.md — Extend the Phase 2 boundary check (02-20, D-14) with the Phase 3 single-writer rule (wave 1)
- [ ] 03-05-PLAN.md — Install the Python packages Phase 3 needs (Docling and RapidOCR for parsing, tiktoken for the shared… (wave 1)
- [ ] 03-06-PLAN.md — Build the small, pure text functions every later ingest stage depends on (wave 1)
- [ ] 03-07-PLAN.md — Add the server-side scope resolvers the write paths need beyond the delivered chat resolver (wave 1)
- [ ] 03-08-PLAN.md — Implement the switchable embedding providers (wave 2)
- [ ] 03-09-PLAN.md — Create the side-by-side embedding storage (wave 2)
- [ ] 03-10-PLAN.md — Build the ingest writer as SQL functions (research Pattern 2) (wave 2)
- [ ] 03-11-PLAN.md — Add the cross_lingual golden category (XLG-02, D-41) in the Phase 2 D-25 order (wave 2)
- [ ] 03-12-PLAN.md — Give the sidecar the async parse job API of D-20 (as amended by F-4) with a converter seam, so plan 03-15… (wave 2)
- [ ] 03-13-PLAN.md — TRACER for Phase 3: wire one Markdown upload through every layer the phase touches to retrieval, and pin its duplicate and failure… (wave 3)
- [ ] 03-13b-PLAN.md — Complete the ingest() the tracer proved: the remaining five D-02 stages, deadline, state and resume, the ingestion… (wave 4)
- [ ] 03-14-PLAN.md — Implement the deterministic invoice extractor in the sidecar (wave 3)
- [ ] 03-15-PLAN.md — Implement the Docling side of DATA-05 (wave 3)
- [ ] 03-16-PLAN.md — Prove and complete the dedup and versioning semantics of D-09, D-10 and D-11 through the real ingest()… (wave 5)
- [ ] 03-17-PLAN.md — Store each version's original file and parse output in a private, tenant-scoped bucket (wave 5)
- [ ] 03-18-PLAN.md — Re-home today's chunk metadata enrichment (temporal and financial entities from storeDocument) as… (wave 5)
- [ ] 03-19-PLAN.md — Add the clause-aware legal chunker (CHK-02, D-25), the table-aware chunker that repeats headers on the… (wave 5)
- [ ] 03-20-PLAN.md — Scan ingested documents for prompt-injection phrasing in zh, en and it with rules stored as data, and… (wave 5)
- [ ] 03-21-PLAN.md — Add the deployment-level active-profile pointer read path (wave 5)
- [ ] 03-22-PLAN.md — Implement document-type resolution (wave 5)
- [ ] 03-23-PLAN.md — Move the scraper write path behind ingest() under RAG_INGEST_PIPELINE=unified (wave 5)
- [ ] 03-24-PLAN.md — Move the "save AI answer to the knowledge base" write path behind ingest() under unified, with the scope… (wave 5)
- [ ] 03-25-PLAN.md — Create the typed ingestion fixtures (wave 4)
- [ ] 03-26-PLAN.md — Derive the query embedding model from the active profile and search that profile's vectors, with… (wave 6)
- [ ] 03-27-PLAN.md — Implement the switchable parser with its fallback chain (wave 6)
- [ ] 03-28-PLAN.md — Make ingestion write every profile that must stay complete (wave 6)
- [ ] 03-29-PLAN.md — Ingest invoices as structured data (wave 6)
- [ ] 03-30-PLAN.md — Teach the document list, delete and status readers about versions (wave 6)
- [ ] 03-31-PLAN.md — Route chat and Config UI knowledge-base uploads through ingest() under unified (wave 7)
- [ ] 03-32-PLAN.md — Move image uploads behind ingest() under unified (wave 7)
- [ ] 03-33-PLAN.md — Move Nango sync ingestion behind ingest() under unified (wave 7)
- [ ] 03-34-PLAN.md — Expose ingestion status and resume over authenticated, scope-checked routes (wave 7)
- [ ] 03-35-PLAN.md — Add the optional exact_id_lookup retrieval stage (wave 7)
- [ ] 03-36-PLAN.md — Build the re-embed job (wave 7)
- [ ] 03-37-PLAN.md — Give admins release and delete for quarantined documents (wave 7)
- [x] 03-38-PLAN.md — Turn images inside PDFs into captioned, page-numbered image chunks of the same document (wave 8)
- [x] 03-39-PLAN.md — Expose the doc-type defaults (wave 8)
- [x] 03-40-PLAN.md — Expose the embedding-profile pointer flip and its rollback through the CLI and authenticated admin routes (wave 8)
- [x] 03-41-PLAN.md — Add the `ingest` fixture mode to the eval harness (wave 7)
- [x] 03-42-PLAN.md — Add the per-file document-type picker to the chat knowledge-base upload (wave 9)
- [x] 03-43-PLAN.md — Build the Config UI side of Phase 3 (wave 10)
- [x] 03-44-PLAN.md — Show Phase 3's success criteria 1, 2, 4, 6, 7 and 9 in ingest mode (wave 9)
- [x] 03-45-PLAN.md — Make the eval harness able to measure any embedding profile (wave 9)
- [x] 03-46-PLAN.md — Compare embedding profiles on the golden set per language and per cross-lingual pair (wave 10)
- [x] 03-47-PLAN.md — Close Phase 3 (wave 11)
- [ ] 03-48-PLAN.md — Run the Phase 3 live verification items from the ROADMAP as explicit human checkpoints (the orchestrator… (wave 12)
**UI hint**: yes

### Phase 3.1: Tiered Parsing, Incremental Queue & Bulk Backfill (INSERTED)
**Goal**: Each document is parsed by the cheapest tier that passes a quality check, never violating the cloud and budget constraints, and both a daily trickle of uploads and a one-time import of a large archive run through the same ledger-driven pipeline: uploads become searchable quickly, and a bulk import has a known cost before it starts and resumes after a crash
**Depends on**: Phase 3
**Requirements**: DATA-12, DATA-13, DATA-14, DATA-15, DATA-16, DATA-17
**Success Criteria** (what must be TRUE):
  1. With `RAG_PARSE_ROUTING=tiered`, the preflight probe routes each page — text pages to `fast`, table, figure and multi-column pages to `structured`, scanned or garbled pages to `structured` with OCR, and to `premium` (stubbed LlamaParse) only through a profile's `min_tier` or an L3 `complex` verdict — within each document-type profile's min/max tier; a mixed-pages fixture sends only its table pages to `structured` and is merged back in page order; a stub that returns empty or garbled text triggers an escalation that is recorded with its reason; with `fixed`, ingestion output equals Phase 3's.
  2. With `RAG_PARSER_ALLOW_CLOUD=false`, a test proves that no request reaches the LlamaParse stub for any fixture, including escalations; an exhausted premium budget or an over-cap document stays on the best allowed tier and is marked `needs_review`.
  3. Every fixture ingestion leaves a ledger row with status, class, tier, attempts, pages, estimated cost and stage timings; re-chunking with a different chunk size and the CHK-05 sweep make zero parser calls (parse cache), and running any stage twice produces no duplicate chunks.
  4. An upload returns 202 with a job id before parsing; the sidecar worker claims jobs with `SKIP LOCKED` (two workers never process the same job); a changed file under the same source key becomes a new version, an unchanged one is skipped, and a Nango deletion soft-deletes it; a failing stub is retried with backoff and then listed as failed with a retry action; a ≤ 20-page digital fixture PDF reaches `ready` within 60 s p95.
  5. A backfill dry run over a fixture archive with duplicates reports class shares, projected pages per tier, cost and time and refuses to run without `--budget`; the real run skips duplicates, is killed mid-way and resumes without reprocessing ready documents, does not delay a concurrent upload beyond its latency target, and with `RAG_EMBED_BATCH_MODE=batch_api` submits embeddings to a recorded OpenAI Batch API fake in batches of at most 50,000 inputs; the same fixture backfill run with `--runner ray` on a local Ray instance produces the same ledger rows and chunks as `--runner worker`, respects the budget and resumes after a kill, and the default sidecar image contains no Ray.
  6. The parser test set reports, per tier, text similarity, table cell F1, structure accuracy, seconds and cost per page, plus Recall@k on the linked golden items; `tiered` does not lower Recall@k or correct-refusal against `fixed` beyond the noise band, and the report shows premium page share and projected cost per 1,000 pages for both modes.
**Live verification**: Run the routed parse on a real sample of the user's documents (dry run first) and check the class shares and projected cost; run a small real OpenAI Batch API embedding job; confirm Supabase Realtime status updates and the sidecar worker on the deployed sidecar.
**Plans**: 54 plans in 14 waves — see `phases/03.1-tiered-parsing-incremental-queue-bulk-backfill/03.1-PLAN-INDEX.md`
**UI hint**: yes

### Phase 03.1.1: Domain embedding model candidates and per-doc-type model selection (INSERTED)
**Goal**: Domain embedding models (Voyage `voyage-law-2`, `voyage-finance-2`) can serve the document types they fit, per deployment or per tenant, as an extra gated and rollback-able retrieval leg, and a model is bound to a doc type only when our own zh/en/it test set shows it beats both the current model and a same-model control on that type without any slice getting worse
**Depends on**: Phase 3.1 (and Phase 3 complete incl. 03-48 live items; 03.1-49; Phase 4 v2 search on trunk and 04-29)
**Requirements**: EMB-06, EMB-07, EMB-08, EMB-09, EMB-10
**Success Criteria** (what must be TRUE):
  1. One catalog holds the official facts of every embedding model (dimensions, input limits, input types, price); `voyage-law-2` and `voyage-finance-2` are embedding profiles served by the existing Voyage key, requests to them carry no dimension parameter, and a same-dimension model swap still fails at startup and per request.
  2. A doc type can be bound (deployment-wide or for one tenant, the tenant binding winning) to a profile scoped to that type; a scoped profile can never become the global profile or hold a vector outside its types; its re-embed fills only its doc types and tenant scope; activation is refused while any in-scope chunk lacks a vector or the evidence is missing, stale, names the wrong baseline, has fewer than 30 real items, or shows a language or other-slice regression; rollback and deactivation are pointer flips; two-tenant tests show no influence across tenants.
  3. With `RAG_DOMAIN_EMBEDDINGS` on, new documents of a bound type are also written to the binding profile (a failure records gaps, never fails the document), and v2 retrieval adds one dense leg per active binding, fused by RRF, with its scores kept out of the similarity floor and refusal calibration; a slow or failing leg degrades the search stage only; voice and the legacy pipeline are unchanged.
  4. `run-binding-compare.mts` reproduces, from recorded hashes, a per-doc-type comparison of baseline, control (filtered extra leg on the current model) and each candidate, per language and cross-lingual pair; its output is the evidence the gate reads; on the fixture embedder the comparison runs end to end and its evidence is refused by the gate for lack of real items.
  5. With the switch off, or on with no binding, the prechunked, ingest and v2 smoke runs equal the baseline item by item (paired differences all zero), no domain-model request is made, and a fresh install from the setup files equals a migrated database.
**Live verification**: Call `voyage-law-2` and `voyage-finance-2` with a real Voyage key and confirm the catalog facts; apply migrations 0440–0442 and build the three HNSW indexes on the real Supabase project; for contract/legal and financial reports, run the comparison on the real golden set (needs ≥ 30 production or human items per type from Phase 5.1.1) after approving the dry-run cost, and activate a binding only if the gate passes and the PO approves; a no-gain verdict or too few real items leaves the binding inactive and still completes the phase.
**Plans**: 16 plans (03.1.1-01..03.1.1-16) — see `phases/03.1.1-domain-embedding-model-candidates-and-per-doc-type-model-sel/03.1.1-PLAN-INDEX.md`

Plans:
**Wave 1**
- [ ] 03.1.1-01-PLAN.md — Model catalog, model-aware Voyage provider and registry lookup, per-model prices (wave 1)
- [ ] 03.1.1-02-PLAN.md — Binding evidence, comparison and eval-override contracts in Pydantic with generated Zod (wave 1)
- [ ] 03.1.1-03-PLAN.md — `RAG_DOMAIN_EMBEDDINGS`, `_MAX_LEGS`, `_TIMEOUT_MS` in every config location (wave 1)
- [ ] 03.1.1-04-PLAN.md — Migration 0440: profile scope, bindings table, guard, scoped profiles and HNSW indexes (wave 1)
- [ ] 03.1.1-11-PLAN.md — Synthetic zh/en/it legal and financial fixture pack with golden items (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*
- [ ] 03.1.1-05-PLAN.md — Migration 0441: binding lifecycle, activation gate, rollback and deactivate (wave 2)
- [ ] 03.1.1-16-PLAN.md — Every provider lookup uses the profile's model (split from 01) (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*
- [ ] 03.1.1-06-PLAN.md — Migration 0442: re-embed scoped to doc types and tied to a backfilling binding (wave 3)
- [ ] 03.1.1-07-PLAN.md — Cached tenant-aware binding read, binding operations and CLI (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*
- [ ] 03.1.1-08-PLAN.md — Ingest and rechunk write binding profiles for bound doc types (wave 4)
- [ ] 03.1.1-09-PLAN.md — Binding legs in v2 search with RRF, score separation, degrade and two-tenant proof (wave 4)
- [ ] 03.1.1-13-PLAN.md — Admin routes and Config UI bindings panel (UI-SPEC via /gsd-ui-phase first) (wave 4)

**Wave 5** *(blocked on Wave 4 completion)*
- [ ] 03.1.1-10-PLAN.md — Eval route overrides for bindings and the control leg (wave 5)

**Wave 6** *(blocked on Wave 5 completion)*
- [ ] 03.1.1-12-PLAN.md — Reproducible per-doc-type comparison harness, decision rule and domain baseline (wave 6)

**Wave 7** *(blocked on Wave 6 completion)*
- [ ] 03.1.1-14-PLAN.md — Off parity, fold migrations, fixture comparison record, AGENTS.md (wave 7)

**Wave 8** *(blocked on Wave 7 completion)*
- [ ] 03.1.1-15-PLAN.md — Live verification as human checkpoints (wave 8)

### Phase 3.2: Language Support & Ingestion Hardening (INSERTED)
**Goal**: The deployment supports exactly the languages chosen at setup, every ingestion step works per language, and documents with hidden text, untrusted links or unapproved uploads never reach retrieval
**Depends on**: Phase 3, Phase 3.1 (the BGE-M3 profile, EMB-11, moved to Phase 3.2.1 on 2026-11-25 so this phase does not wait for Phase 3.1.1)
**Requirements**: LANG-01, LANG-02, LANG-03, LANG-04, LANG-05, LANG-06, XLG-04, XLG-06, SEC-07, SEC-08, SEC-09, DATA-18, CHK-06, CHK-07, EVAL-18, DATA-19, DATA-20 (plus the DATA-05 and XLG-02 deltas)
**Success Criteria** (what must be TRUE):
  1. First-run setup asks for the supported languages (single or multi-select, plus a primary language) in an interactive `scripts/init-env.js` run and in the Config UI, and writes them to `.env.local` and the five config locations; with them unset, the legacy pipelines behave as today (also when a newer default would select v2) with one startup warning and a Config UI banner pointing to the picker, while an explicit `RAG_PIPELINE=v2` or `RAG_INGEST_PIPELINE=unified` without languages fails with `languages_not_configured`; choosing one language turns off detection, translation and the cross-lingual slices.
  2. The language-pack registry is Pydantic data with generated Zod; the golden contract, eval corpus, drafting tools and `src/lib/rag/lang/detect.ts` validate against it, a CI check fails on a hard-coded `zh|en|it` literal outside the registry and fixtures, and saving a set with an incomplete pack or an unsupported embedding profile or reranker fails.
  3. One ingestion fingerprint combines the existing per-chunk versions and the settings snapshot; an ingestion-side change shows the affected document count and rebuilds only those documents side by side, rollbackable; chunks carry their own language with confidence (`und` when undetected), and Chinese chunks split at 。！？ with `cl100k_base` counting.
  4. A fixture scan with Chinese text and Italian accents comes out character-exact on Docling and LlamaParse, the legacy routes no longer hard-code `language: "en"`, captions of Chinese and Italian documents are written in that language, and with `RAG_DOC_TRANSLATION` on an Italian question hits a translation while the answer cites the original Chinese chunk.
  5. Every ingestion-side and query-side component reads the supported languages from the registry, and the language validator reports an embedding profile whose languages it cannot check as "not verified" instead of passing.
  6. Fixture documents with white-on-white text, tiny fonts, off-page text, zero-width characters and hidden Word runs, and documents containing links outside the allowlist, are quarantined with the reason shown to the admin; with `RAG_UPLOAD_APPROVAL` on, a member's upload stays out of retrieval and the cache until approved; scope tags filter retrieval to the documents tagged with the scope a question names.
  7. With every new switch off, the characterization tests pass and no slice drops beyond the noise band; machine-translated zh/it golden items count only after native-speaker review.
  8. In every processing profile, a 60-row fixture table cut into several chunks repeats its header in each chunk and a page-continued table carries the header forward; the synthetic `table_split` items in zh/en/it are answered from the asked column of the right row, not a neighbouring column; with `RAG_TABLE_ROW_SERIALIZATION` on, table chunks embed "column = value" lines while the LLM still sees the Markdown table.
  9. An older version uploaded as a separate file next to its newer version is flagged as a possible older version, and after admin confirmation only the newer version is current; with `RAG_EFFECTIVE_DATES` on, a policy whose effective date is next month is not used yet and an expired one is treated as historical.
**Live verification**: Run OCR on real scanned Chinese and Italian documents; review a sample of quarantined real documents.
**Plans**: 65 plans in 15 waves (see `phases/03.2-language-support-ingestion-hardening/03.2-PLAN-INDEX.md`); human steps in plans 36 (package check), 65 (live migration push 0801–0810) and 53 (live verification and native-speaker review). Line hints in plan reading lists are advisory: executors locate code by symbol name
**UI hint**: yes

### Phase 3.2.1: BGE-M3 Open-Source Fallback Embedding (INSERTED)
**Goal**: An open-source embedding model is available as a fallback profile, served hosted or self-run with identical vectors, and is only activated when the eval says it is good enough
**Depends on**: Phase 3.1.1 (model catalog, doc-type bindings, model-aware lookup), Phase 3.2 (language registry and validator, translation and sidecar groundwork)
**Requirements**: EMB-11
**Success Criteria** (what must be TRUE):
  1. BGE-M3 runs as an embedding profile through the hosted API and the sidecar with identical vectors (within a recorded tolerance), joins the Phase 3.1.1 catalog with its supported languages, and the language validator checks it.
  2. It passes the EMB-05 activation gate before it can serve, and it is compared with the active profile on every slice, language and cost; with the profile inactive, results match the Phase 3.2 baseline.
**Live verification**: Call the hosted BGE-M3 API, confirm the weights revision, compare hosted and sidecar vectors, and push migration 0811 live.
**Plans**: 5 plans in 4 waves (see `phases/03.2.1-bge-m3-open-source-fallback-embedding/03.2.1-PLAN-INDEX.md`); human steps in plans 02 (weights revision, hosted vectors) and 05 (live checks, migration 0811 push)

### Phase 4: Hybrid Retrieval, Reranking & Calibrated Refusal
**Goal**: On pgvector, questions in Chinese, English and Italian find the right chunks through filtered hybrid search and reranking, and the system refuses when the best reranked evidence is too weak
**Depends on**: Phase 3
**Requirements**: RET-01, RET-02, RET-03, RET-04, RET-10, DATA-08, RNK-01, RNK-02, RNK-03, RNK-04, RNK-05, RNK-06, CHK-03, LAT-01, LAT-02, XLG-03, CHK-04, CHK-05
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
  10. With a `selective_filter` golden category (a tenant or document type at ≤ 3% of rows), filtered pgvector retrieval with `hnsw.iterative_scan` and the exact-scan cutoff returns the same top-k as an unfiltered exact search over the matching rows; the eval reports Recall@k for this category with iterative scan off and on (RET-10).
**Live verification**: Calibrate thresholds and sweep pool size and top-k with real Cohere and Voyage keys on the real golden set's dev split, then check them on the holdout split; compare Voyage `rerank-3` with `rerank-2.5` on the zh and it slices; apply the hybrid SQL migration to the real Supabase project and confirm Chinese lexical behavior there.
**Plans**: 2/45 plans executed (04-01..04-45) — see `phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-PLAN-INDEX.md`
- [x] 04-01-PLAN.md
- [ ] 04-02-PLAN.md
- [x] 04-03-PLAN.md
- [ ] 04-04-PLAN.md
- [ ] 04-05-PLAN.md
- [ ] 04-06-PLAN.md
- [ ] 04-07-PLAN.md
- [ ] 04-08-PLAN.md
- [ ] 04-09-PLAN.md
- [ ] 04-10-PLAN.md
- [ ] 04-11-PLAN.md
- [ ] 04-12-PLAN.md
- [ ] 04-13-PLAN.md
- [ ] 04-14-PLAN.md
- [ ] 04-15-PLAN.md
- [ ] 04-16-PLAN.md
- [ ] 04-17-PLAN.md
- [ ] 04-18-PLAN.md
- [ ] 04-19-PLAN.md
- [ ] 04-20-PLAN.md
- [ ] 04-21-PLAN.md
- [ ] 04-22-PLAN.md
- [ ] 04-23-PLAN.md
- [ ] 04-24-PLAN.md
- [ ] 04-25-PLAN.md
- [ ] 04-26-PLAN.md
- [ ] 04-27-PLAN.md
- [ ] 04-28-PLAN.md
- [ ] 04-29-PLAN.md
- [ ] 04-30-PLAN.md
- [ ] 04-31-PLAN.md
- [ ] 04-32-PLAN.md
- [ ] 04-33-PLAN.md
- [ ] 04-34-PLAN.md
- [ ] 04-35-PLAN.md
- [ ] 04-36-PLAN.md
- [ ] 04-37-PLAN.md
- [ ] 04-38-PLAN.md
- [ ] 04-39-PLAN.md
- [ ] 04-40-PLAN.md
- [ ] 04-41-PLAN.md
- [ ] 04-42-PLAN.md
- [ ] 04-43-PLAN.md
- [ ] 04-44-PLAN.md
- [ ] 04-45-PLAN.md

### Phase 4.1: Hybrid retrieval and rerank on by default, proven by eval (INSERTED)

**Goal**: An install that has chosen its supported languages and sets nothing else gets hybrid retrieval and reranking, refuses no-answer questions at least as reliably as today without refusing more answerable ones, and can return to today's behaviour exactly with `RAG_PIPELINE=legacy`, with all of this shown on the eval before the defaults change; until the languages are chosen, or while the database lacks the Phase 4 functions, the install keeps serving the legacy pipeline
**Depends on:** Phase 4 (automated close, plan 04-42; 04-43 live checks not required); Phase 3.2 (LANG-01): complete before plan 04.1-09 flips the defaults, and its LANG-01 implementation on trunk before plan 04.1-13 (plans 04.1-01 to 04.1-08 do not wait for it). Runs before Phase 4.2.
**Requirements**: DFLT-01, DFLT-02, DFLT-03, DFLT-04, DFLT-05, DFLT-06, DFLT-07
**Success Criteria** (what must be TRUE):
  1. With the supported languages configured and no other `RAG_*` variable set, chat, embed, eval and voice run the v2 pipeline with the lexical leg, `RAG_RERANKER=auto`, threshold refusal on and the recorded fallback floor; every other Phase 4 switch keeps its Phase 4 default; the two-tenant matrix passes on every entry point in both tenancy modes.
  2. On a fresh install without rerank keys, `auto` reranks with the eval-chosen local fallback (or keeps the fused order) and no request is marked `degraded`; with `COHERE_API_KEY` set it uses Cohere's quality tier for chat and embed and its fast tier for voice, and Voyage is used only when named.
  3. Strict mode still answers verified-empty retrieval with "information not available" and never reports a knowledge-base failure that way; web search with Exa, `source_images` and the `{{context}}` placeholder work unchanged under the new defaults.
  4. A pre-registered gate, committed before any run, passes on both fixture modes against the baselines in force, with and without fixture-calibrated cells: no gated slice beyond the noise band, ingest-mode overall Recall@10 at least the floor the gate tool derives from the ingest baseline in force when the criteria are committed (baseline minus the band, recorded with the baseline's sha256), overall false refusal not above and correct refusal not below baseline beyond the band (judged on the single-threshold behaviour), no category with n of at least 8 dropping beyond the band, latency within `eval/config/latency-budgets.json`; the decision record lists every number and is marked provisional until the real-golden re-run.
  5. Real Cohere and Voyage rerankers were measured once on the fixture dev split (at most 600 requests): hosted quality is not below the local paths beyond the band, chat p95 is at most 600 ms and voice fast-tier p95 at most 250 ms, or the decision record takes the failing entry point off hosted rerank.
  6. A deployment that never set `RAG_PIPELINE` serves legacy answers instead of failing in two cases: its database lacks a Phase 4 function (one error log; retrieval and the ingest dual write both keep working), or it has not chosen its supported languages (Phase 3.2's startup log and Config UI banner, LANG-01). `RAG_PIPELINE=v2` set explicitly still fails loudly in both cases (`backend_error`, `languages_not_configured`). One resolver makes the decision.
  7. With `RAG_PIPELINE=legacy`, both legacy smoke tiers show zero paired differences against the legacy baselines in CI, and the legacy characterization snapshots are byte-identical to before the phase.
  8. The new switch and value are in every config location and the eval pin, the templates leave `RAG_PIPELINE` empty so the default stays implicit, `check-config` passes, and AGENTS.md and the deployment guide state the defaults, the vendor data flow under `auto`, the upgrade steps and the switch back.
**Live verification**: When the real golden dev split reaches the live calibration minimums (20 answerable, 10 no-answer), re-run the gate's slice and refusal criteria on it and record the result next to the 04.1 decision; on a staging Supabase project without migration 0407, deploy with `RAG_PIPELINE` unset and confirm the legacy fallback, then apply the migrations and confirm v2; measure voice p95 end to end with a Cohere key; on a fresh install skip the language picker and confirm legacy answers with the startup log and the banner, then choose the languages and confirm v2.
**Plans**: 13 plans in 7 waves — see `phases/04.1-hybrid-retrieval-and-rerank-on-by-default-proven-by-eval/04.1-PLAN-INDEX.md`

Plans:
- [ ] 04.1-01-PLAN.md — Legacy-rule refusal floor behind RAG_REFUSAL_FLOOR, shared keep predicate, legacy byte-identical (wave 1)
- [ ] 04.1-02-PLAN.md — Mirror RAG_REFUSAL_FLOOR and the auto value in every config location and the eval pin, defaults unchanged (wave 1)
- [ ] 04.1-06-PLAN.md — Run configs with placeholder-only key overlay, defaults gate tool, pre-registered criteria with the tool-derived floor (wave 1)
- [ ] 04.1-03-PLAN.md — RAG_RERANKER=auto: Cohere with key, local fallback otherwise, never degraded, hashes as resolved provider (wave 2)
- [ ] 04.1-04-PLAN.md — Implicit-default resolver: a missing Phase 4 function (retrieval, ingest dual write) or unchosen languages serve legacy, explicit v2 unchanged (wave 3)
- [ ] 04.1-05-PLAN.md — Pin legacy characterization; characterize the new defaults with AGENTS §14 assertions (wave 3)
- [ ] 04.1-08-PLAN.md — Capped live Cohere and Voyage quality and latency on the fixture, report-only (wave 3)
- [ ] 04.1-07-PLAN.md — Run the gate on both fixture modes with and without cells, record the retrieval-defaults decision (wave 4)
- [ ] 04.1-13-PLAN.md — Connect the Phase 3.2 language reader to the resolver, prove the three language cases, characterize unset languages (wave 4; needs the Phase 3.2 LANG-01 implementation on trunk)
- [ ] 04.1-09-PLAN.md — Flip the defaults in every location once the decision says flip and is current; templates keep the pipeline implicit (wave 5; needs Phase 3.2 complete)
- [ ] 04.1-10-PLAN.md — Legacy baselines, re-recorded default baselines, legacy all-zero CI tiers (wave 6)
- [ ] 04.1-11-PLAN.md — AGENTS.md and deployment guide: defaults, auto data flow, upgrade steps, switch back (wave 6)
- [ ] 04.1-12-PLAN.md — Implicit defaults on every entry point, two tenants, un-migrated database, unchosen languages, CI-equivalent run (wave 7)

**Cross-phase notes for the roadmap**:
- Phase 4 D-28's last sentence ("the shipped defaults stay off until the Phase 7 regression") is superseded for `RAG_PIPELINE`, `RAG_LEXICAL_SEARCH`, `RAG_RERANKER`, `RAG_REFUSAL_THRESHOLD` and `RAG_REFUSAL_FLOOR` by the product owner's decision of 2026-11-24; Phase 4 itself still closes with the defaults off (04-42 unchanged).
- Phase 7 keeps external backends, the embedding-profile and reranker-model decision on the real locked test split, and the release-defaults check; its incumbent is the 04.1 decision record (see REQUIREMENTS-ADDITIONS.md).
- Phases 5, 5.1, 5.1.1, 6, 6.1 and 7 run after the flip: their route-fixture tests that assert legacy output must pass `env: { RAG_PIPELINE: 'legacy' }`, and their "against Phase 4" comparisons use the post-flip baselines.
- Phase 3.2 (LANG-01) owns the supported-languages reader, its startup log, the Config UI banner and the `languages_not_configured` error. Phase 4.1 consumes them through one resolver; the flip (04.1-09) stops and reports unless Phase 3.2 is complete on trunk.
- Phase 4.2 (RNK-07) adds refusal thresholds per RAG mode. Phase 4.1 keeps the single-threshold behaviour, adds no mode key and records `refusal_basis: "single_threshold"`, so with the per-mode targets unset the Phase 4.2 result equals the 4.1 result.
- Phase 7 plan 07-30 must accept the empty template value of `RAG_PIPELINE` (the 4.1 decision lists it in `implicit_in_templates`).

*Section revised 2026-11-25. ROADMAP.md still carries the 2026-11-24 text; the differences are listed in `04.1-PLAN-INDEX.md` under "Wording changes needed outside this phase".*

### Phase 4.1.1: Domain terminology dictionary: expert-maintained synonyms, query expansion, index-time synonyms, log mining (INSERTED)

**Goal**: When users ask in their own words (informal terms, abbreviations, loosely typed codes and identifiers) in any enabled language, retrieval still finds the chunks that use the documents' own terms, through a dictionary that domain experts maintain per deployment and per tenant, that is versioned and audited, that never lets expansion outweigh the original query, that grows from reviewed candidates mined from missed queries, and that later phases read through one stable, tenant-scoped interface (tokenizer dictionary, translation glossary)
**Depends on**: Phase 4.1 (after its last plan, 04.1-12); Phase 3.2's registry-derived language type and language settings module on trunk (plans 04.1.1-01 and 04.1.1-09 stop and report without them). Phase 6 is executing in parallel: each plan that touches one of its seams (stage order, variant cap, semantic-cache key, prompts) implements the branch that matches trunk and waits for nothing.
**Requirements**: TERM-01, TERM-02, TERM-03, TERM-04, TERM-05, TERM-06, TERM-07, TERM-08, TERM-09, TERM-10, TERM-11, TERM-12
**Success Criteria** (what must be TRUE):
  1. On a local Postgres with pgvector seeded with the fixture corpus, synthetic documents and a synthetic dictionary, a colloquial question in each fixture language whose wording does not occur in the corpus retrieves the gold chunk under the effective v2 pipeline with `RAG_TERMINOLOGY` on, through a separate down-weighted lexical RRF list built from the standalone query after the query transforms and before the semantic cache and embedding; the original dense and lexical lists are unchanged, expansion is one hop and capped, and with the switch off candidates and `retrievalConfigHash` are identical to a database without a dictionary.
  2. With full original lists, an expansion-only hit reaches the rerank input at every cap the contract allows (including Phase 4.2's lower floor) through a bounded reservation, and never ahead of an original hit; no pool size, cap or weight is assumed.
  3. Dictionary entries live in a shared layer and per-tenant workspace layers in service-role-only tables; a tenant's effective dictionary, previews, read-API results, mined candidates and corpus document frequencies never include another tenant's data (two-tenant tests in both deployment modes); anon and authenticated cannot read the tables or execute any `rag_term_*` function, and CI fails if code outside the terminology module reads them.
  4. Every change bumps its layer version with an append-only audit row and fails on a stale expected version; the version a request used appears in its trace, its config hash and its semantic-cache key.
  5. Admins create, edit, delete, suppress, import (dry run, then atomic apply) and export (formula-safe CSV) entries, translation pairs included, and preview a query's expansion through Zod-validated admin routes; conflicts, chains, cycles, one-character Han variants, stopword-only variants, languages the deployment does not enable and malformed translation pairs are rejected with row-level issues; a Config UI Terminology panel built from a UI-SPEC covers all of it.
  6. Translation pairs are stored with their source and target languages, never expand queries, and are returned with the effective terms by `getTerminologyLexicon(scope, options)` from `@/lib/rag`, whose version and content hash Phase 4.2 and Phase 6.2 use; a contract test locks its shape.
  7. With `RAG_TERMINOLOGY_MINING` on, missed requests are recorded masked per tenant for 30 days, and `npm run rag:terms:mine` proposes candidate terms that admins accept (through the normal create path) or dismiss; nothing is applied automatically.
  8. The eval compares dictionary off and on: the colloquial-term slice improves on Recall@k and MRR, no other slice, language or category drops beyond the noise band, no-answer items containing dictionary terms are still refused, and the terminology stage stays within its chat and voice latency budgets; the three switches stay off (synthetic items are report-only per EVAL-14).
  9. Index-time synonyms are not built; the decision and its reasons (Supabase dictionary files, parser bypass, relex cost) are recorded, and the matched entries are exposed for the Phase 6 rewrite and HyDE prompts, both as stage output and through an earlier glossary helper.
**Live verification**: Apply 0471–0473 to the real Supabase project and confirm the anon key is refused on every terminology table and RPC; a domain expert imports a small real-domain CSV, enters one translation pair and checks previews; measure terminology and search p95 for chat and voice on staging; run the miner in dry-run mode on a short opt-in window.
**Plans**: 18 plans in 9 waves (04.1.1-01..04.1.1-18) — see `phases/04.1.1-domain-terminology-dictionary-expert-maintained-synonyms-que/04.1.1-PLAN-INDEX.md`
**UI hint**: yes (plan 13 requires `/gsd-ui-phase 04.1.1` first)

Plans:
- [ ] 04.1.1-01-PLAN.md — Terminology Pydantic contracts (translation pairs, read contract, stage name) and generated Zod (wave 1)
- [ ] 04.1.1-02-PLAN.md — Three switches in the five config places and the manifest; `terminology` stage and its budgets; run-config allowlist (wave 1)
- [ ] 04.1.1-03-PLAN.md — 0471 tables, RLS, append-only audit, translation-pair checks, `rag_term_effective` with a two-tenant test (wave 1)
- [ ] 04.1.1-04-PLAN.md — 0472 actor-checked, versioned, audited writers, suppression and atomic import (wave 2)
- [ ] 04.1.1-05-PLAN.md — TRACER: seeded dictionary → terminology stage on the standalone query → `term:0` list → RRF; caps, per-tenant cache (wave 2)
- [ ] 04.1.1-06-PLAN.md — Multi-script and identifier matching with property tests; validator with language and translation-pair rules (wave 3)
- [ ] 04.1.1-07-PLAN.md — Dense terminology variant counted against the variant and search caps (never voice); glossary helper for Phase 6 prompts (wave 3)
- [ ] 04.1.1-16-PLAN.md — Config-hash block and semantic-cache key, off-identity, multi-tenant end-to-end retrieval case (wave 3)
- [ ] 04.1.1-17-PLAN.md — Stable read API `getTerminologyLexicon`, contract lock, boundary rule, two-tenant test (wave 3)
- [ ] 04.1.1-08-PLAN.md — 0473 miss log (self-expiring), candidates, tenant df, decisions; opt-in masked miss recording (wave 4)
- [ ] 04.1.1-09-PLAN.md — Admin service and CRUD/versions/audit routes, translation pairs and enabled languages; two-tenant route matrix (wave 4)
- [ ] 04.1.1-10-PLAN.md — Synthetic documents and fixture dictionary, colloquial-term golden items, run configs, zero-diff re-baselines (wave 4)
- [ ] 04.1.1-18-PLAN.md — Bounded rerank-input reservation for expansion-only hits, proven with full lists at several caps (wave 4)
- [ ] 04.1.1-11-PLAN.md — CSV import/export with translation columns and dry run, expansion preview (wave 5)
- [ ] 04.1.1-12-PLAN.md — Miner CLI and candidate review routes; two-tenant mining matrix (wave 6)
- [ ] 04.1.1-13-PLAN.md — Config UI Terminology panel after UI-SPEC, translation pairs included (wave 7, autonomous: false)
- [ ] 04.1.1-14-PLAN.md — CLOSING: fold migrations, default-identity gates, on/off comparison, AGENTS.md (wave 8)
- [ ] 04.1.1-15-PLAN.md — Live verification (wave 9, autonomous: false)

### Phase 4.2: Retrieval Tuning Additions (INSERTED)
**Goal**: Retrieval keeps the smallest rerank pool that works, matches company terms as single words, can answer questions about earlier policy versions, and its time to first token is gated
**Depends on**: Phase 4, Phase 4.1, Phase 4.1.1 (TERM dictionary for LANG-07 and XLG-05), Phase 3.2
**Requirements**: LAT-04, LANG-07, RET-11, RET-12, DATA-21, RET-13, EVAL-20, RNK-07, RET-15, RET-16, EVAL-32 (plus the RNK-02 and LAT-01 deltas)
**Success Criteria** (what must be TRUE):
  1. The sweep grid includes a pool of 25, the rerank input cap accepts 25, and the sweep report adds nDCG@k with k equal to the chunks sent to the LLM.
  2. A multi-character term from a tenant's dictionary matches as one lexical term after `rag:relex`; Italian stemming makes singular and plural forms match and is turned on only if the it slice gains Recall with no other slice dropping.
  3. With `versions: all` or a period range, a fixture question comparing two versions of one policy retrieves chunks of both, superseded chunks carry their version and dates, and the default still returns current versions only; the semantic cache bypasses these queries.
  4. TTFT p50/p95 is on the trace for text, embed and voice, cache hits and misses are reported separately, and an injected pre-generation delay makes the CI latency gate fail.
  5. With `RAG_TABLE_LOOKUP` on, a question naming two cell values of one table row retrieves the matching table row through the lookup leg as an extra RRF list within the verified tenant, the row reaches the context with its header, no LLM-written SQL exists anywhere, and the cross-tenant canary includes the row store.
  6. With `RAG_DUP_CLUSTERS` on, a fixture FAQ pasted into 30 documents forms one duplicate cluster per tenant (never across tenants), and deleting one source document updates the cluster; with `RAG_RESULT_DIVERSITY=collapse` (or `mmr`), a synthetic two-intent question in zh/en/it gets the duplicated answer once, with all its sources listed, plus the other intent's chunk in the top-k; the `duplicate_flood` slice gates top-k redundancy and per-intent evidence, and no other slice drops beyond the noise band.
  7. The refusal calibration report lists every candidate threshold with its false-answer and false-refusal rates; strict mode takes the threshold that keeps false answers at or below 5% and balanced keeps today's false-refusal target, each cell records its mode, and with the per-mode targets unset the chosen thresholds equal the Phase 4 result.
  8. With `RAG_IDENTIFIER_INDEX` and `RAG_IDENTIFIER_FILTER` on, the synthetic `identifier_near_miss` questions in every spelling retrieve and cite only the asked identifier, near-miss identifiers never reach the context, an identifier the tenant does not have gets the refusal with suggestions, admin-defined identifier patterns are honoured, and the descriptive-question slice does not drop.
**Live verification**: Re-run the pool sweep with real rerankers including the 25 pool; measure real TTFT against the budget.
**Plans**: 38 plans in 11 waves (see `phases/04.2-retrieval-tuning-additions/04.2-PLAN-INDEX.md`); migrations 0851–0862 and 0864 (purge hooks, plan 38) (0863 only when the Phase 5.1.1 retrieval log exists); `hybrid_search_chunks` is redefined by Phase 3.2's 0802 first and then by 0856; human steps in plans 23, 25, 26 (design reviews) and 33 (live pool sweep and TTFT)

### Phase 4.3: Document Access Groups (INSERTED)
**Goal**: Inside one tenant, a member can only retrieve, be answered from, or see cached or logged content of documents their access groups allow, and this is enforced in code before ranking, never by the prompt
**Depends on**: Phase 4, Phase 3.2 (upload and admin surfaces), Phase 4.2 (all retrieval legs, including duplicate clusters and table rows)
**Requirements**: SEC-12, SEC-13, DATA-22, EVAL-21
**Success Criteria** (what must be TRUE):
  1. With `RAG_DOC_ACCESS_GROUPS` off, retrieval, cache and logs match the baseline and every document is in group `all`; with it on, a document restricted to one access group never appears in the retrieval candidates, context, citations, cache entries or logs of a member outside that group, on every leg (dense, lexical, exact-id, parents, translations, table rows) and on pgvector, and the filter runs before ranking.
  2. Groups come only from the verified session or signed scope token; a request body naming another group changes nothing; embedded chat sees only `all` documents unless its configuration names a group; voice uses the token's identity.
  3. The semantic cache never serves an answer across different group sets; the post-generation citation check drops a citation to a chunk the caller may not see and records a security event.
  4. A Google Drive, Notion or Dropbox document shared with a group is mapped to the matching access group on sync and re-mapped after a sharing change; an unmappable permission leaves it visible only to the uploader and admins. In multi-tenant mode connector documents stay in the owner's personal workspace, so the mapping changes visibility only in single-tenant mode (4.3 A-10).
  5. The same-tenant cross-group canaries (EVAL-21) pass in CI as a release gate, including after group changes and re-uploads; no other slice drops beyond the noise band.
**Live verification**: Sync a real shared Drive folder with restricted files and check the mapped groups; run the canaries against a real Supabase project in both deployment modes.
**Plans**: 38 plans in 13 waves (see `phases/04.3-document-access-groups/04.3-PLAN-INDEX.md`); migrations 0920–0931; human steps in 04.3-53 (live push of 0920–0931) and 04.3-54 (two-mode canaries, real Drive and Dropbox sync); pgvector and the seams (`scopeAccessFilter`, `document_chunks.access_groups`) are delivered here, the Weaviate/Qdrant filter by Phase 7 (07-38, 07-39)
**UI hint**: yes

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
**Plans**: 26 plans (passed plan check); see `.planning/phases/05-verified-citations-groundedness/`
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
**Plans**: 25 plans in 7 waves (05.1-01..05.1-25); closing plan 05.1-22 — plan index `phases/05.1-prompt-injection-defense/05.1-PLAN-INDEX.md`, validation contract `05.1-VALIDATION.md`

Plans:
- [ ] 05.1-01-PLAN.md — Six named indirect zh/en/it rules in the shared Phase 3 rule file (zh >= 7, en >= 8, it >= 6, >= 22), injection-rules.ts re-export with a content-derived version, clean-corpus zero-false-positive test (wave 1)
- [ ] 05.1-02-PLAN.md — wrapDocuments, tag and attribute escaping with look-alikes and tag characters, fixed notice and reminder, Claude replacement builder, 20,000-case property test (wave 1)
- [ ] 05.1-03-PLAN.md — Pydantic classify request/response and detector-config contracts with generated Zod, and the committed detector config file (wave 1)
- [ ] 05.1-04-PLAN.md — Nine switches and keys in the five config places and the manifest, Prompt-injection defense card, call-time security config reader (wave 1)
- [ ] 05.1-05-PLAN.md — SEC-05 design document for critical facts via tools; WhatsApp link-preview follow-up in the backlog (wave 1)
- [ ] 05.1-06-PLAN.md — TRACER: tagged, rule-checked context for one web-chat request on the legacy graph; flag, drop and downweight; status precedence and strict refusal (wave 2)
- [ ] 05.1-07-PLAN.md — Sidecar POST /v1/injection/classify with windowing and a fake scorer; app-side Prompt Guard client (wave 2)
- [ ] 05.1-08-PLAN.md — Lakera adapter on recorded shapes with the full lakeraAllowed gate, detector config loader, tenant-keyed verdict cache, lakera-http boundary rule (wave 2)
- [ ] 05.1-09-PLAN.md — Synthetic zh/en/it injection and evasive fixture documents, prechunked in ingest mode, both baselines re-recorded with zero change (wave 3)
- [ ] 05.1-10-PLAN.md — exposure_rate, attack_success_rate, detector false-positive rates and the absolute-zero gate kind (wave 3)
- [ ] 05.1-11-PLAN.md — Markdown image allowlist renderer behind its own switch (wave 2)
- [ ] 05.1-12-PLAN.md — Detector configuration summary in the Prompt-injection defense card (wave 2)
- [ ] 05.1-13-PLAN.md — Overview, voice and media graphs; overview and voice context wrapping; scoped released rule ids with a two-tenant test; trace counts and log redaction (wave 3)
- [ ] 05.1-14-PLAN.md — v2: check after expand_parents with the scoped released-rule read and a v2 two-tenant test, downweight ordering, wrapping after compression, retrievalConfigHash with Lakera's effective state, eval effective config (wave 4)
- [ ] 05.1-15-PLAN.md — Tool-result guard for webSearch, MCP and the approve-route summariser; YOLO suspension on all three consumer paths; injectionFlagged (wave 3)
- [ ] 05.1-16-PLAN.md — Notice on the Claude Citations path; citation-instruction sentinel; raw quotes and premises (wave 3)
- [ ] 05.1-17-PLAN.md — Injection and evasive golden items (4 and 2 per language) and the prechunked re-baseline (wave 4)
- [ ] 05.1-18-PLAN.md — Prompt Guard license, gated access, build-token and pin approval; promptguard extra in pyproject; orchestrator-only lock and sync (wave 3, autonomous: false)
- [ ] 05.1-19-PLAN.md — Eval route injection record, SEC run configs, all-off zero proof, CI absolute-zero step, nightly matrix, injection_check budgets (wave 5)
- [ ] 05.1-20-PLAN.md — Voice-rag context field and voice agent preference; chat, embed and eval entry points, sentinel and source_images (wave 4)
- [ ] 05.1-21-PLAN.md — Prompt Guard and Lakera inside injection_check: Lakera zero-request gate table and route-level multi-tenant case, language gate, warm cache, inner deadline, fault injection, two-tenant cache test (wave 5)
- [ ] 05.1-22-PLAN.md — CLOSING PLAN: phase comparison (all-off equals baseline; recommended passes absolute-zero and category noise), AGENTS.md, full gates (wave 6)
- [ ] 05.1-23-PLAN.md — Live verification: Lakera account, key, region and retention; Lakera live through the stage on synthetic chunks; Prompt Guard image; latency and live attack success (wave 7, autonomous: false)
- [ ] 05.1-24-PLAN.md — Golden attack field and injection categories, eval run, trace and report contract changes with regenerated Zod (wave 2)
- [ ] 05.1-25-PLAN.md — Prompt Guard scorer, bake step and promptguard image target on the orchestrator-locked environment (wave 4)

### Phase 05.1.1: Feedback Loop & Real Domain Test Set (INSERTED)
**Goal**: Production use continuously produces evaluation data: every retrieval is recorded privately per tenant, failed answers are found every week and labelled by the tenant's own experts, and improvements must be proven on a real domain test set before they go live
**Depends on**: Phase 5.1 (and Phase 5: builds on `rag_answer_records`, the web answer vote and the review reasons; Phase 4.1.1 for plan 05.1.1-24 only)
**Requirements**: FBK-01, FBK-02, FBK-03, FBK-04, FBK-05, FBK-06, FBK-07, FBK-08, FBK-09, FBK-10, EVAL-16 (embed and refusal extension), EVAL-17 (moved from Phase 7)
**Success Criteria** (what must be TRUE):
  1. With `RAG_RETRIEVAL_LOG` on, every chat, embed and voice retrieval writes one `rag_retrieval_log` row after the response (query masked or omitted, tenant, chunk ids, ranks and scores, config hash, refusal decision and outcome, latency, and the language codes of the query, the kept chunks and the answer), never answer or chunk text; eval, media and ghost chats are never logged; rows are service-role only, deleted with their user, organization or chat, purged after the retention window, and a tenant can lower or switch off logging; with every switch off the chat, embed and voice responses are byte-identical (characterization) and no row is written.
  2. Users can mark a strict refusal as "I expected an answer", embed visitors can rate answers through a signed per-answer token, opening a source is counted, and Phase 5's web answer votes reach the same table; votes on another user's or another tenant's retrieval are impossible (404 tests).
  3. Weekly mining turns thumbs-down, disputed refusals, refusals with high scores, zero-result and low-score retrievals and flagged groundedness into a capped, deduplicated review queue per tenant; database RLS ensures an expert of tenant A never sees tenant B's cases, shown by two-tenant tests at the SQL and API levels, and operator admins see a tenant only after an explicit grant in multi-tenant mode.
  4. In the Config UI an expert labels a case (correct documents and exact evidence spans, expected answer, PII check) and triages it into dictionary candidates (for Phase 4.1.1), training pairs with hard negatives and document groups (for Phase 6.1) and golden candidates; no training pair uses a document of the domain test split.
  5. Approved golden candidates become a real domain test set (provenance `production` or `human`, private path only, frozen document-group split, near-duplicates confirmed, append-only); `gate-population.json` switches the gate to real items with a minimum size, `ship_check` passes only on a real-set improvement without slice regressions, and a weekly report shows loop activity, metric trends and new failures by layer and category.
  6. The phase comparison against the Phase 5.1 closing report shows retrieval paired differences of exactly zero with the switches off and on, and request latency within the OBS-02 budgets.
**Live verification**: Apply 0531 to 0535 to the real project and check two-tenant RLS; confirm after()-written rows and latency on real streams, embed and voice; collect and label 100–300 real user questions with domain experts, PII-review and promote them; switch the gate to real items, record a three-run real baseline and set improvement targets for Phases 6 and 6.1 (plan 05.1.1-23).
**UI**: `/gsd-ui-phase 05.1.1` must produce `05.1.1-UI-SPEC.md` before execution (surfaces: Config UI switches, web chat refusal control and source-open signal, embed widget and window rating, Config UI expert labelling panel, Config UI feedback loop admin card).
**Ordering note**: Phase 6 plans that edit `src/app/api/chat/route.ts`, `src/app/api/embed/chat/route.ts`, `src/lib/rag/trace/finish.ts`, `src/lib/rag/pipeline.ts`, `src/lib/rag/index.ts`, `src/lib/rag/generation/messages.ts`, the five config files, `AGENTS.md` or the setup files depend on 05.1.1-22.
**Plans**: 25 plans in 8 waves (05.1.1-01..05.1.1-25); closing plan 05.1.1-22 — plan index `phases/05.1.1-feedback-loop-and-real-domain-test-set-thumbs-failed-query-m/05.1.1-PLAN-INDEX.md`

Plans:
**Wave 1**
- [ ] 05.1.1-01-PLAN.md — Pydantic feedback-loop contracts with generated Zod; docgroup manifest rule; mining review reasons; gate_population real (wave 1)
- [ ] 05.1.1-02-PLAN.md — Seven switches in the five config locations, manifest and eval pin; call-time config reader; mining thresholds file (wave 1)
- [ ] 05.1.1-03-PLAN.md — rag_retrieval_log (0531, 0532 per mode) and purge function (0533) with the 0410 lock, PGlite tests in both modes (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*
- [ ] 05.1.1-04-PLAN.md — Tenant settings, domain experts, review items with the RLS helper and immutable split (0534), mining function (0535), two-tenant RLS tests (wave 2)
- [ ] 05.1.1-05-PLAN.md — Log row builder and after-response writer on the trace seam; logOutcome holder (wave 2)
- [ ] 05.1.1-06-PLAN.md — Gate population switch (legacy default, real with min_items) and report wording (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*
- [ ] 05.1.1-07-PLAN.md — Chat, embed and voice log context and outcomes; characterization unchanged; two-tenant route test (wave 3)
- [ ] 05.1.1-08-PLAN.md — Tenant opt-out, purge CLI and route, optional pg_cron schedule (wave 3)
- [ ] 05.1.1-12-PLAN.md — Expert grants route; RLS-scoped review list, item and chunk routes with the two-tenant API test (wave 3)
- [ ] 05.1.1-25-PLAN.md — Mirror Phase 5 web answer votes onto the retrieval log row (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*
- [ ] 05.1.1-09-PLAN.md — Refusal vote and source-open routes; switch-guarded refusal metadata (wave 4)
- [ ] 05.1.1-10-PLAN.md — Signed embed feedback token, stream metadata and CORS vote route (wave 4)
- [ ] 05.1.1-11-PLAN.md — Weekly mining: module, CLI and admin route, end-to-end two-tenant test (wave 4)
- [ ] 05.1.1-13-PLAN.md — Label validation with exact quotes; review search inside the item's tenant (wave 4)

**Wave 5** *(blocked on Wave 4 completion)*
- [ ] 05.1.1-14-PLAN.md — Dictionary, training and golden exports with the held_out leakage guard; mark-exported route (wave 5)
- [ ] 05.1.1-15-PLAN.md — Web chat refusal control and source-open signal (UI) (wave 5)
- [ ] 05.1.1-16-PLAN.md — Embed widget and window rating control (UI) (wave 5)
- [ ] 05.1.1-17-PLAN.md — Config UI expert labelling panel (UI) (wave 5)
- [ ] 05.1.1-20-PLAN.md — Stats route, failure report and weekly report (wave 5)
- [ ] 05.1.1-24-PLAN.md — Bridge thumbs-down and disputed-refusal failures into Phase 4.1.1's miss log (wave 5)

**Wave 6** *(blocked on Wave 5 completion)*
- [ ] 05.1.1-18-PLAN.md — Config UI feedback loop admin card (UI) (wave 6)
- [ ] 05.1.1-19-PLAN.md — Document-group split, near-duplicates, promote-db and the export writer (wave 6)
- [ ] 05.1.1-21-PLAN.md — Ship check and the weekly workflow job with lint rules (wave 6)

**Wave 7** *(blocked on Wave 6 completion)*
- [ ] 05.1.1-22-PLAN.md — Fold migrations, AGENTS.md, comparison against Phase 5.1, full gates (wave 7)

**Wave 8** *(blocked on Wave 7 completion)*
- [ ] 05.1.1-23-PLAN.md — Live verification and the first real domain test set (wave 8, autonomous: false)

### Phase 5.2: Grounded Answers & Output Safety (INSERTED)
**Goal**: When the documents answer only part of a question, the answer says so instead of filling the gap, every claim can be traced to a block, no answer can carry a phishing link or a credential request, and every computed number in an answer is produced and checked by deterministic code
**Depends on**: Phase 5, Phase 5.1, Phase 5.1.1 (review queue and retrieval log), Phase 3.2 (language registry texts, output link allowlist, `pending_review`, effective dates, supersession candidates)
**Requirements**: GEN-08, GEN-09, GEN-10, GEN-11, GEN-12, LAT-05, LANG-09, SEC-06, SEC-10, GEN-14, EVAL-19, GEN-15 (plus the SEC-02 delta; GEN-16, GEN-17, EVAL-26, RNK-08 and EVAL-33 moved to Phase 5.2.1 on 2026-11-25)
**Success Criteria** (what must be TRUE):
  1. With `RAG_PARTIAL_ANSWER_RULE` on, the `partial_answer` fixture items (e.g. a limit is stated but not what happens above it) are answered for the covered part and say for the rest that the documents do not cover it, in zh, en and it; the share of answers adding unsupported content is 0 in CI; when strict mode calls webSearch, document and web parts are labelled separately; `RAG_SYSTEM_PROMPT` and `{{context}}` are unchanged.
  2. The eval reports `uncited_sentence_rate`, the UI marks sentences without a valid citation, and with `RAG_CLAIM_CHECK` on unsupported sentences are marked "not confirmed by the documents" without deleting or blocking text; with the LLM judge opted in, Italian answers get a calibrated groundedness label instead of "not checked".
  3. With `RAG_MAX_OUTPUT_TOKENS` on, answers are capped and asked to be concise, the strict refusal is never cut, citations before a cut-off are persisted and the truncation rate stays below 2%; refusal and notice texts come from the registry in the question's language and today's English text is byte-identical.
  4. With `RAG_OUTPUT_GUARD` on, a fixture document carrying a hidden phishing link and a "log in again and enter your password" instruction produces answers with the link replaced and the request blocked, even across stream tokens; allowlisted links pass; WhatsApp replies are filtered and no server-side preview is fetched for non-allowlisted hosts; the system prompt forbids outputting links found only in material and asking for passwords.
  5. Security events carry the uploader on the trace, in logs and in the review queue, and a fake uploader crossing the threshold raises an admin alert; with every switch off, results match the baseline recorded before this phase (the Phase 5.1.1 one).
  6. Context blocks carry version and effective-date labels; on the `stale_version` items the answer gives the current value and names its version, never both values, and the conflict sends both documents to the review queue as a supersession candidate.
  7. With `RAG_CONTEXT_RELEVANCE_RULE` on, the synthetic `off_topic_context` items (no-answer questions whose top chunks are on an adjacent subject) get the "information not available" text in strict mode and a labelled general answer in balanced mode, the share of answers repurposing adjacent context is 0 in CI, and with the switch off the strict characterization is byte-identical.
**Live verification**: Run the claim check and the LLM judge on real answers; send a real WhatsApp reply with an injected link and confirm no preview fetch.
**Plans**: 40 plans in 13 waves (see `phases/05.2-grounded-answers-and-output-safety/05.2-PLAN-INDEX.md`); migrations 0940–0944; chat-route plans run in order 05→06→09→10→13→31; human steps: 05.2-15 decision on the WhatsApp stream parser (D-91), 05.2-39 live push of 0940–0944 (after 3.2's 0801–0810 and 5.1.1's 0531–0535 are live), 05.2-40 live claim check, judge calibration, WhatsApp link test and output-cap sweep
**UI hint**: yes

### Phase 5.2.1: Calculation Tool & Prompt Budget (INSERTED)
**Goal**: Every computed number in an answer is produced and checked by deterministic code, and no request ever exceeds the model window or loses the user's question
**Depends on**: Phase 5.2 (split from it on 2026-11-25)
**Requirements**: GEN-16, GEN-17, EVAL-26, RNK-08, EVAL-33
**Success Criteria** (what must be TRUE):
  1. With `RAG_CALC_TOOL` on, the synthetic `multi_step_calc` items in zh/en/it are answered through the calculation tool with every step listed and the same number for every paraphrase; the tool rejects free-form code, unsourced operands and mixed units; with `RAG_CALC_CHECK` on, a fake model that skips the per-item rule gets a correction notice with the recomputed value, both values in metadata and a review-queue entry, and an operand missing from its cited chunk marks the answer "calculation not verified"; with both off, answers match the Phase 5.2 baseline.
  2. With `RAG_PROMPT_BUDGET` on, the `context_overflow` items never exceed a small fake model window, the question is present and last in every request, history is trimmed before documents, the highest-ranked parents are kept in both the v2 and legacy assembly, and prompt-part token counts and dropped documents are on the trace; with it off results equal the baseline.
**Live verification**: Push migration 0950 live; measure the live calculation error rate with and without the tool on real models; calibrate the token estimate against real usage.
**Plans**: 26 plans in 8 waves (see `phases/05.2.1-calculation-tool-and-prompt-budget/05.2.1-PLAN-INDEX.md`); migration 0950; chat-route plans run in order 14→18→21→26; plan 26 (`RAG_CONTEXT_OVERFLOW=refine`) is optional and last; human step 05.2.1-25
**UI hint**: yes

### Phase 5.3: Evaluation Gates & Online Monitoring (INSERTED)
**Goal**: A change that makes the system answer questions its documents cannot answer is stopped before release, whether it comes through CI or the Config UI, after release a drift in refusals, scores or votes raises an alert within a day, and the test set keeps looking like the questions real users ask
**Depends on**: Phase 5.1.1 (retrieval log, review queue and domain experts), Phase 5.2 (`off_topic_context` items), Phase 4.2 (per-mode refusal operating points)
**Requirements**: EVAL-22, EVAL-23, EVAL-24, EVAL-25, OBS-03, EVAL-27, EVAL-28, EVAL-29, EVAL-30
**Success Criteria** (what must be TRUE):
  1. A gated set whose no-answer share falls below 15% in any language fails the run; a fake model that answers 3 of 20 no-answer items fails CI on the absolute false-answer ceiling even when the noise-band rule would pass; ceilings and floors live in `eval/config/quality-gates.json`.
  2. In the Config UI, saving an edited `RAG_SYSTEM_PROMPT` that drops the refusal instruction shows a failing smoke-tier result before it applies; saving anyway needs a reason that is stored with the config hash and appears in the weekly report; changing the reranker model marks its refusal cells `uncalibrated` with a warning; a finished backfill batch starts the nightly tier on that tenant's real set.
  3. With `RAG_MONITOR` on, a seeded retrieval log whose refusal rate rises from 12% to 38% on day 5 while not-helpful votes stay flat raises one alert for that tenant and language; a shifted top-score distribution flags recalibration; alerts carry ids and counts but no query or answer text; with the switch off nothing runs.
  4. The judge-agreement report shows Cohen's kappa and accuracy per language and metric on a labelled sample; a judge seeded to disagree becomes report-only for that slice and the nightly gate ignores it; the length-bias check, the expanded- and assertive-answer probes and the judge's recall on human-flagged unsupported answers are reported; holistic 1–5 scores never gate.
  5. A commit whose nightly tier was skipped for missing keys, or whose `ship_check` failed, cannot be promoted to production: `rag-release-gate` reports `skipped` or `failed` and the promotion step stops; `pr-smoke` is a required check on trunk and `main`; an override needs an admin and a reason and appears in the weekly report.
  6. A seeded spike in knowledge-base `degraded` results raises an alert that lists the switch flipped in the same window and links sample trace ids.
  7. On a seeded production log, the weekly representative sample covers every topic cluster in proportion (within tolerance) and lands in the review queue tagged `representative`; reports show unweighted and production-weighted scores.
  8. When seeded production traffic shifts towards a cluster the test set barely covers, the drift report names that cluster, an alert says the test set is no longer representative, and the next sample draws from it; an offline score far above the online judge score on a slice is flagged the same way.
  9. Replacing the gold evidence document of a golden item marks the item `stale` and removes it from the gate until it is re-labelled or retired; every report prints the set version and manifest hash, and a run whose stale share exceeds the limit fails.
  10. An imported file of historical questions is PII-masked, tenant-tagged and queued with provenance `historical`; pilot users are sampled at the higher rate; paraphrased variants are reported for coverage only; synthetic `implicit_condition` items exist in zh/en/it.
**Live verification**: Run the daily monitor on a week of real logs and confirm a test alert reaches the admin channel; measure real judge agreement on expert-labelled review-queue cases; confirm a failing release gate blocks a real Vercel promotion.
**Plans**: TBD
**UI hint**: yes

### Phase 6: Query Layer (LlamaIndex & LangChain)
**Goal**: Follow-up, vague and compound questions retrieve as well as standalone ones under either query framework, within their latency budgets, and voice stays fast
**Depends on**: Phase 5, Phase 5.1 (plans require Phase 5 complete and share files with Phase 5.1)
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
**Plans**: 46 plans in 13 waves (06-01..06-46) — see `phases/06-query-layer-llamaindex-langchain/06-PLAN-INDEX.md`
**Ordering note (2026-11-24, Phase 5.1.1)**: Phase 6 plans that edit `src/app/api/chat/route.ts`, `src/app/api/embed/chat/route.ts`, `src/lib/rag/trace/finish.ts`, `src/lib/rag/pipeline.ts`, `src/lib/rag/index.ts`, `src/lib/rag/generation/messages.ts`, the five config files, `AGENTS.md` or the setup files depend on 05.1.1-22 (the Phase 5.1.1 close). The Phase 6 plans themselves are not yet rewritten for this edge; the executor adds it before running such a plan.
**Defaults note (2026-11-24, Phase 4.1 D-21)**: Phase 6 was planned while legacy was the default. Once Phase 4.1 flips the defaults (04.1-09), route-fixture tests that assert legacy output must pin `env: { RAG_PIPELINE: 'legacy' }`, and comparisons "against Phase 4" use the post-flip baselines.

Plans:
- [ ] 06-01-PLAN.md — W1: Pydantic query contracts (QueryPlan, transform outputs, RewriteGateResult) and query-params.json
- [ ] 06-02-PLAN.md — W1: Phase 6 env switches and REDIS_URL (always secret) in the five config locations, manifest and eval pin (MCP flag pinned)
- [ ] 06-03-PLAN.md — W1: locked rewrite gate, lexicon, protected tokens, fixture table and p99 < 1 ms benchmark
- [ ] 06-04-PLAN.md — W1: `rag_tenant_language_shares` server-role SQL (0601) with two-tenant tests
- [ ] 06-05-PLAN.md — W2: generated JSON Schema and Zod for the query contracts
- [ ] 06-06-PLAN.md — W2: deterministic R2 relative-date normalization
- [ ] 06-07-PLAN.md — W2: shared post-checks, gate-anchored time budget and prompt renderer with the mandatory suffix
- [ ] 06-08-PLAN.md — W2: `hybrid_search_chunks` `p_include_undated` (0602), single overload, default unchanged
- [ ] 06-09-PLAN.md — W2: semantic-cache contracts and golden cache-pair fields
- [ ] 06-10-PLAN.md — W3: config stages and switches, query-LLM client and deterministic fake
- [ ] 06-11-PLAN.md — W3: generated schemas for cache, golden, retrieval-params and filter contracts
- [ ] 06-12-PLAN.md — W3: `rag_semantic_cache` table, server-role functions and same-transaction triggers (0603)
- [ ] 06-13-PLAN.md — W4: TRACER — eval route to v2 query stage, gate, native condense, QueryPlan, variant seam, trace; layer-off parity
- [ ] 06-14-PLAN.md — W4: router (gate + classifier per A-1) and variant limits loader
- [ ] 06-15-PLAN.md — W4: native multi-query, HyDE and sub-question transforms
- [ ] 06-16-PLAN.md — W4: KB language-share client (per-tenant cache) and native translator
- [ ] 06-17-PLAN.md — W4: cache interface, key hash and deterministic bypass rules
- [ ] 06-18-PLAN.md — W4: CI boundary rules (LangChain fence, adapter reach, zod v4, query-LLM calls, cache RPCs)
- [ ] 06-19-PLAN.md — W5: full layer orchestration: parallel group, deadline, soft status, small talk
- [ ] 06-20-PLAN.md — W5: variants through the Phase 4 path with caps, dense-only HyDE, one batch and one RRF
- [ ] 06-21-PLAN.md — W5: pgvector and RedisVL cache backends behind a fail-open wrapper; RedisVL invalidation emission
- [ ] 06-22-PLAN.md — W5: package legitimacy checkpoint, then orchestrator-only install and lock (not before 2026-12-04, `--save-exact --before`); executor verifies the lock, zod isolation CI, optional RedisVL extra (autonomous: false)
- [ ] 06-23-PLAN.md — W6: real translator in the Phase 4 translate slot; en/it to zh cross-language retrieval
- [ ] 06-24-PLAN.md — W6: relative-date filter end to end with undated documents kept
- [ ] 06-25-PLAN.md — W6: sub-question coverage reservation; rerank and refusal on the standalone query
- [ ] 06-26-PLAN.md — W6: scope-bound retrieval port and search-delegate hook
- [ ] 06-27-PLAN.md — W6: chat and embed inputs (classification, history window, time zone, small talk)
- [ ] 06-28-PLAN.md — W6: server-side voice profile within the voice budget; token-bound history with a two-tenant test; server-rewrite header
- [ ] 06-29-PLAN.md — W6: eval overrides for layer, framework, transforms and cache; run configs
- [ ] 06-30-PLAN.md — W6: RedisVL cache endpoints in the sidecar behind the shared secret
- [ ] 06-31-PLAN.md — W7: voice-agent `VOICE_SERVER_QUERY_REWRITE` switch (default off)
- [ ] 06-32-PLAN.md — W7: `semantic_cache` stage, config hash, vector reuse and hit short-circuit
- [ ] 06-33-PLAN.md — W7: answer-language instruction appended in createEnhancedRAGPrompt
- [ ] 06-34-PLAN.md — W7: report sections and report-only query and cache budgets
- [ ] 06-35-PLAN.md — W7: LangChain adapter part 1 (condense, expand, HyDE port, fake chat model)
- [ ] 06-38-PLAN.md — W7: golden additions (protected-code, elliptical and relative-time follow-ups, compound, cross-language, small talk) and re-baseline
- [ ] 06-36-PLAN.md — W8: cache hits and post-groundedness stores in chat and embed (embed check-only by default)
- [ ] 06-37-PLAN.md — W8: LangChain adapter part 2 (decompose, translate, EnsembleRetriever over the port, framework switch)
- [ ] 06-39-PLAN.md — W8: golden cache paraphrase and near-miss pairs and re-baseline
- [ ] 06-40-PLAN.md — W9: authenticated clear-cache admin route and the Config UI "Query layer" panel
- [ ] 06-41-PLAN.md — W9: cache-pair run, threshold calibration and the near-miss wrong-hit gate
- [ ] 06-42-PLAN.md — W9: two-tenant canary suite with cache and query-layer rows (both frameworks)
- [ ] 06-43-PLAN.md — W10: framework comparison tool, fixture report and CI jobs
- [ ] 06-44-PLAN.md — W11: phase comparison against Phase 4 (D-42 a to e)
- [ ] 06-45-PLAN.md — W12: fold migrations into both setup files, full gates with defaults, AGENTS.md
- [ ] 06-46-PLAN.md — W13: live verification checkpoints (autonomous: false)
**UI hint**: yes

### Phase 06.1: Embedding fine-tuning pipeline: synthetic queries, hard negatives, MNRL training, re-embed and switch (INSERTED)
**Goal**: An operator can fine-tune an open multilingual embedding model on the knowledge base of tenants that consented, prove it beats the base and the production model on held-out documents and on the domain golden set, and switch production to it (or back) through the existing embedding-profile gate or a Phase 3.1.1 binding, without ever mixing vectors of two models or letting a model trained on one tenant's data serve another tenant without that consent
**Depends on**: Phase 6, Phase 3.1.1 (model candidates and per-doc-type selection), Phase 5.1.1 (real test set and mined pairs); reuses Phase 3 profiles, re-embed and the EMB-05 gate
**Requirements**: FT-01, FT-02, FT-03, FT-04, FT-05, FT-06, FT-07, FT-08, FT-09, FT-10
**Success Criteria** (what must be TRUE):
  1. With `RAG_FINETUNE=off` (default) nothing changes: the slot profiles exist unbound and unsearched, the fine-tune commands refuse, and the fixture eval equals the Phase 6 baseline on every metric and slice.
  2. `python -m rag_eval.finetune export` refuses any tenant without recorded `deployment` consent, reads only the listed tenants' current ready chunks, assigns a document-level 80/10/10 split (golden test-evidence documents forced to test), and a two-tenant test shows no row of tenant B in a bundle for tenant A.
  3. On the fixture corpus with a fake LLM, generation writes about three queries per chunk in zh/en/it (plus a cross-language share) within a required budget and resumes from its cache; the filters drop verbatim copies (character n-gram containment), near-duplicates, golden overlaps and unanswerable queries, and report every drop by reason and language; expert-confirmed mined pairs from Phase 5.1.1 are imported, filtered and clustered so near-identical queries never straddle train and test.
  4. Hard negatives are mined per tenant with the production model's stored vectors (or a sentence-transformers model) using a relative margin of 0.05 and the neighbour/duplicate guards; train pairs never take a negative from a dev or test document; the sampled false-negative upper bound must be ≤ 0.15 or mining fails; the NumPy miner matches `mine_hard_negatives` on a tiny model.
  5. A test-free training kit trains with `CachedMultipleNegativesRankingLoss` and `NO_DUPLICATES` batching from pinned configs on a GPU host (CPU tests use fakes and a tiny in-test model); offline evaluation reports Recall@10, MRR@10 and nDCG@10 per language and source for base, fine-tuned and production models with paired intervals, and a card that fails the offline rule cannot be registered.
  6. A registered model binds to a free fine-tune slot (`ft-a-1024`/`ft-b-1024`, halfvec + partial HNSW), is served from an OpenAI-compatible endpoint whose identity is proven by a probe check, is re-embedded with `npm run rag:reembed`, and is activated and rolled back only through the unchanged EMB-05 gate; binding a non-empty, active or rollback-target slot is refused, and a changed endpoint model fails loudly before any vector is written (PGlite lifecycle test in both modes, with a two-tenant canary).
  7. A tenant-private model (one tenant's data, `private` consent) is served only through Phase 3.1.1 bindings for that tenant: a binding for another tenant, a deployment-wide binding or a global activation of the scoped slot is refused (two-tenant PGlite test).
  8. Revoking a tenant's consent taints every model version trained on it in the same transaction, nulls the evidence of its bound non-active slot (activation then refuses), deactivates its bindings and reports an active tainted model with the rollback steps; `prune` removes text-bearing bundle files after 30 days or for a revoked tenant; no report or log contains chunk or query text.
**Live verification**: Record real consent; run generation and judging with a real key under an approved budget; mine with the production model and pass the FN audit; train on a GPU box or hosted GPU from the training image; deploy an OpenAI-compatible endpoint and pass `ft-check`; re-embed the real corpus (HNSW build time); run the EMB-05 comparison on the real golden set (production/human items) including cross-lingual and general slices; activate or record the gate's refusal; rollback drill; measure slot embed p50/p95 against the 200 ms budget; record all costs.
**Plans**: 20 plans in 10 waves — see `phases/06.1-embedding-fine-tuning-pipeline-synthetic-queries-hard-negati/06.1-PLAN-INDEX.md`

Plans:
- [ ] 06.1-01-PLAN.md — W1: Pydantic fine-tune contracts, `eval/config/finetune.json`, optional extras (package-approval checkpoint, autonomous: false)
- [ ] 06.1-02-PLAN.md — W2: generated JSON Schema and Zod for the fine-tune contracts
- [ ] 06.1-03-PLAN.md — W1: consent and model registry (0651) with revocation taint, two-tenant tests
- [ ] 06.1-04-PLAN.md — W1: `RAG_FINETUNE` and slot endpoint settings in the five config locations and the eval pin
- [ ] 06.1-05-PLAN.md — W2: fine-tune slots `ft-a-1024`/`ft-b-1024` with HNSW, bind/clear/release, taint and evidence triggers (0652)
- [ ] 06.1-06-PLAN.md — W2: consent-checked tenant export, document-level split, golden decontamination
- [ ] 06.1-07-PLAN.md — W3: synthetic query generation (structured, cached, budgeted)
- [ ] 06.1-08-PLAN.md — W4: filters (verbatim n-gram, near-duplicate, golden, answerability) and report
- [ ] 06.1-09-PLAN.md — W5: Phase 5.1.1 `TrainingPair` import, clustering and strictest split
- [ ] 06.1-10-PLAN.md — W3: production chunk and query vectors through `@/lib/rag` (0653), `npm run rag:finetune`
- [ ] 06.1-11-PLAN.md — W6: hard-negative mining (vectors / sentence-transformers), guards, FN audit
- [ ] 06.1-12-PLAN.md — W7: training kit, trainer (CachedMNRL), probes, training image and lock
- [ ] 06.1-13-PLAN.md — W7: offline evaluation vs base and production, model card, prune
- [ ] 06.1-14-PLAN.md — W3: OpenAI-compatible slot provider and probe check
- [ ] 06.1-15-PLAN.md — W4: `rag:embedding ft-*` operator commands
- [ ] 06.1-16-PLAN.md — W8: fixture pipeline end to end with leakage invariants
- [ ] 06.1-17-PLAN.md — W5: PGlite lifecycle (bind → re-embed → gate → activate → rollback), two-tenant canary, switch-off parity
- [ ] 06.1-20-PLAN.md — W6: scoped slots and the fine-tune binding guard on Phase 3.1.1 bindings (0654)
- [ ] 06.1-18-PLAN.md — W9: fold migrations, baseline parity report, AGENTS.md, gates
- [ ] 06.1-19-PLAN.md — W10: live verification checkpoints (autonomous: false)
**UI hint**: fields only (Config UI Embedding profiles card); no new screen

### Phase 6.2: Query Layer Additions (INSERTED)
**Goal**: Questions that bundle several periods, places or topics retrieve evidence for every part and get a structured comparison, cross-language queries use company terms, and the optional latency switches pay off only when the eval says so
**Depends on**: Phase 6, Phase 6.1, Phase 3.2, Phase 4.2, Phase 5.2
**Requirements**: QRY-09, QRY-10, QRY-11, GEN-13, XLG-05, XLG-07, LANG-08, LAT-06, LAT-07, QRY-12, QRY-13, QRY-14
**Success Criteria** (what must be TRUE):
  1. For synthetic questions in zh/en/it that compare two periods of one policy and ask about one scope, decomposition yields sub-questions covering both periods and the scope (a fake decomposer that drops one is corrected or discarded); with `RAG_QUERY_SUBQ_FILTERS` on, each sub-question is filtered by period, version scope or scope tag within the verified tenant, an empty filtered result falls back, and the answer has one cited part per sub-question plus the differences.
  2. The `version_compare` and `scoped_compound` slices report all-evidence recall and sub-question coverage above single-pass retrieval, and no other slice drops beyond the noise band.
  3. Glossary terms are enforced in translation, document translation and rewriting; short and mixed-script queries get the right language through the confidence fallback chain; the cross_lingual slice runs through the voice entry point and is gated.
  4. With `RAG_SPECULATIVE_RETRIEVAL` on, original-query retrieval starts before the transforms finish and a cache hit cancels it; with `RAG_MODEL_ROUTING=auto` and the Auto model selected, simple lookups go to the fast model; with both off, the Phase 6 order and model choice are unchanged.
  5. With `condense` forced to time out, a synthetic elliptical follow-up in zh/en/it is still retrieved through the previous-standalone-query variant and answered from the right passage; with `RAG_WHATSAPP_HISTORY` on, the same two-turn conversation over WhatsApp is condensed and answered correctly, history never crosses senders, and the reset command clears it.
  6. With `RAG_SCOPE_GATE` on, the off-domain fixture questions in zh/en/it skip retrieval as `out_of_scope` within 5 ms (strict refuses, balanced answers without knowledge-base context and says so), `unsure` queries always retrieve, correct refusals rise and false refusals stay within the noise band; with it off nothing changes.
**Live verification**: Run the multi-part fixtures and real comparison questions with real LLM keys; measure the speculative-retrieval and routing latency gains.
**Plans**: TBD

### Phase 6.3: Source Deletion Sync & Purge (INSERTED)
**Goal**: A document deleted or withdrawn at its source stops being retrieved, cited or served from cache within one sync, withdrawn content can be purged from every store, and SharePoint and OneDrive libraries can be connected
**Depends on**: Phase 6 (semantic cache), Phase 4.2 (table rows, duplicate clusters), Phase 4.3 (access groups for connector permissions), Phase 5.3 (golden-set lifecycle), Phase 3.2 (translations)
**Requirements**: DATA-23, DATA-24, DATA-25, RET-14, EVAL-31
**Success Criteria** (what must be TRUE):
  1. A file deleted at the source that the connector reports as deleted is removed or soft-deleted in the next webhook or sync run without waiting for a full listing; the scheduled reconciliation removes files that no change feed reported; a connection without a completed reconciliation for more than the configured age raises an alert, and a listing that would remove more than the configured share pauses for admin confirmation.
  2. Purging a document leaves no chunk, parent, vector in any profile, table row, cluster membership, translation, parse-cache entry, original, external-backend vector or cache entry of its lineage; past citations show the withdrawn marker; the audit row names actor and reason; golden items on it are stale.
  3. With `RAG_SOURCE_RECHECK` on, a chunk whose document was deleted directly in the index is dropped before rerank and counted on the trace; on Weaviate and Qdrant the recheck is always on.
  4. With the SharePoint switch on, a fixture drive (recorded Graph delta responses) syncs added, changed and deleted items with stored delta tokens and maps item permissions to access groups; with it off nothing changes.
  5. The deletion canaries pass in CI for `soft` and `purge`; with every new switch off and connections in the default deletion mode, behaviour matches the Phase 6.2 baseline.
**Live verification**: Connect a real SharePoint test site, delete and restore a file, and confirm the answer stops and resumes; purge a document and run the verification query against the live database.
**Plans**: 27 plans in 10 waves (see `phases/06.3-source-deletion-sync-and-purge/06.3-PLAN-INDEX.md`); migrations 0720–0728; human steps in plans 24 (live migration push), 25 (live SharePoint and purge checks) and 26 (live permission mapping); 06.3-14 waits for Phase 7 plan 07-37, 06.3-26 for Phase 4.3
**UI hint**: yes

### Phase 7: External Backends & Release Defaults
**Goal**: Admins can switch retrieval to Weaviate or Qdrant without any cross-tenant leakage, every new provider and switch is configurable in the Config UI, and the shipped defaults are backed by a full regression
**Depends on**: Phase 5, Phase 5.1, Phase 6, Phase 3.1.1, Phase 4.1, Phase 4.1.1, Phase 5.1.1, Phase 6.1, Phase 3.2, Phase 3.2.1, Phase 4.2, Phase 5.2, Phase 5.2.1, Phase 5.3, Phase 6.2, Phase 6.3, Phase 4.3 (the Weaviate and Qdrant adapters must inject the access-group filter on every query and prefetch)
**Requirements**: RET-05, RET-06, RET-07, RET-08, RET-09, ADM-01, ADM-02, ADM-03, ADM-04, LANG-10, LANG-11, SEC-11, SEC-12 (Weaviate/Qdrant adapter clause) (plus the ADM-02 delta and the RET-05 delta: the outbox carries DATA-24 purges and RET-14 is always on for Weaviate and Qdrant; EVAL-17 moved to Phase 5.1.1 on 2026-11-24)
**Success Criteria** (what must be TRUE):
  1. Tests against Weaviate and Qdrant containers in CI show that inserts, updates, deletes (including cascade deletes), version replacements and re-embeds in Supabase reach both stores through the outbox and drain worker, and that the reconcile job detects and repairs injected drift. Weaviate uses one tenant per workspace; Qdrant uses a shared collection per embedding profile with an `is_tenant` index and a tenant filter injected on every query and prefetch.
  2. The cross-tenant canary suite (personal vs organization, null organization, removed member, after delete, after version replace, after re-embed) passes on pgvector, Weaviate and Qdrant in CI and blocks release on failure; chunk IDs from an external backend that fail re-validation against Supabase under the caller's scope are dropped.
  3. The Phase 4 hybrid conformance tests, including the Chinese exact-term test, pass unchanged on Weaviate and Qdrant; when an external backend is not ready for a tenant or fails, retrieval falls back to pgvector and reports `degraded`.
  4. Admin can configure every new provider and switch in the Config UI with masked secrets, a Test-connection button and a warning when the active embedding profile and backend don't match.
  5. The regression runner evaluates backend, embedding profile and reranker combinations on the locked test split and writes a defaults decision record with its numbers (shown on fixtures). `AGENTS.md`, the `.env` templates and setup docs describe the sidecar, providers, switches, sync and eval workflow. A vendor data-flow inventory lists what content goes to Vectara, Cohere, Voyage, DeepInfra, Weaviate, Qdrant, Anthropic, LlamaCloud and any other external service the pipeline calls.
  6. *(Removed 2026-11-24: moved to Phase 5.1.1 with EVAL-17.)*
  7. Traces carry chunk languages; online judge scores, votes and the "information not available" rate are split per language, and a fixture where one language drops while the average holds raises an alert; a new embedding profile can be activated for chosen tenants or a traffic share first and rolled back per tenant; adding a fixture language records its baseline and reprocesses only `und`, scanned and out-of-date documents; a red-team run started from the Config UI replays the growing attack corpus and opens a review case per success; the defaults record includes cost per 1,000 documents and queries.
**Live verification**: Provision Weaviate and Qdrant (cloud or self-hosted), host the drain worker within the 60 s function limit, and run the canary suite against them; run Test-connection for each real provider; run the full regression on the real locked test split with all real keys (the ADM-02 defaults decision is final only from this live run, not from fixtures); check voice latency end to end; run the 07-50 live checks (purge, source recheck and access groups on the hosted backends, a gradual rollout and the LANG-10 alert channel end to end, a red-team run started from the Config UI).
**Plans**: 52 plans in 18 waves (48 active; 07-22, 07-23, 07-26 and 07-29 retired 2026-11-24, superseded by Phase 5.1.1; 07-35..07-52 added 2026-11-25 for the purge outbox, forced source recheck, access-group filter, LANG-10/11, SEC-11 red team and ADM-02 cost blocks; 07-37/07-44 wait for Phase 6.3, 07-38/07-39 for Phase 4.3, 07-46 for Phase 5.3; `/gsd-ui-phase 07` must produce `07-UI-SPEC.md` before 07-48, 07-49 and 07-52) — see `phases/07-external-backends-release-defaults/07-PLAN-INDEX.md`
**Incumbent defaults (2026-11-24, Phase 4.1)**: the regression and the release-defaults check (07-17, 07-25, 07-30) start from the Phase 4.1 decision `eval/decisions/04.1-retrieval-defaults.json` as the incumbent; route-fixture tests that assert legacy output pin `RAG_PIPELINE=legacy`.

Plans:
- [ ] 07-01-PLAN.md — Gate and install the two vector-store clients, and make the boundary check confine them to the adapter… (wave 1, autonomous: false)
- [ ] 07-02-PLAN.md — Create the change-capture half of RET-05: the notification-only outbox, the sync-target switch table,… (wave 1)
- [ ] 07-03-PLAN.md — Build the two pure pieces every external tenant check rests on: the lower-case tenant-key helper (A-5)… (wave 1)
- [ ] 07-04-PLAN.md — Add the ten D-24 variables to the five config locations, the env manifest and the eval pin, and parse… (wave 1)
- [ ] 07-05-PLAN.md — Define the Pydantic contracts the sync worker, the drain route and the backend fallback emit, and… (wave 1)
- [ ] 07-06-PLAN.md — Prove the external-backend architecture end to end on its thinnest path first (the phase tracer), then… (wave 2)
- [ ] 07-07-PLAN.md — Implement the Qdrant retrieval adapter, its sync store and collection setup, and run the unchanged Phase… (wave 3)
- [ ] 07-08-PLAN.md — Implement the Weaviate retrieval adapter, its sync store and collection setup with one tenant per… (wave 3)
- [ ] 07-09-PLAN.md — Expand the tracer's thin drain into the full sync engine: claim wrappers, a pure servable planner,… (wave 3)
- [ ] 07-10-PLAN.md — Extend the Phase 3 D-40 embedding-profile activation gate so a profile cannot become active while an… (wave 4)
- [ ] 07-11-PLAN.md — Build reconcile: detect and repair drift between Supabase's servable rows and each external store,… (wave 4)
- [ ] 07-12-PLAN.md — Make the backend switch real: per-entry-point selection, index-ready checks, the pgvector fallback with… (wave 4)
- [ ] 07-13-PLAN.md — Expose the sync engine to its three triggers: the authenticated drain route (scheduler), the… (wave 5)
- [ ] 07-14-PLAN.md — Write the cross-tenant canary suite that runs on every backend and gates release (D-12, RET-08),… (wave 5)
- [ ] 07-15-PLAN.md — Serve the index-compatibility warning and the sync-target switch to the Config UI through admin routes… (wave 6)
- [ ] 07-16-PLAN.md — Run the canary and conformance suites against real Weaviate and Qdrant in CI as a release gate, and… (wave 6)
- [ ] 07-17-PLAN.md — Define the closeout contracts in Pydantic and regenerate Zod: the defaults decision and its… (wave 7)
- [ ] 07-18-PLAN.md — Give every managed variable the metadata the generated Config UI section needs, and make check-config… (wave 7)
- [ ] 07-19-PLAN.md — Add the Test-connection route that checks each real provider with the app's loaded configuration (D-15). (wave 7)
- [ ] 07-20-PLAN.md — Render every managed switch and provider in the Config UI from the manifest, with masked secrets,… (wave 8)
- [ ] 07-21-PLAN.md — Ship the vendor data-flow inventory as data, generate its documentation, and make CI keep it complete… (wave 8)
- [ ] ~~07-22-PLAN.md~~ — **RETIRED 2026-11-24, superseded by 05.1.1-19 (Phase 5.1.1).** Was: Extend the review queue's single Python implementation to full promotion, append-only safety and… (wave 8)
- [ ] ~~07-23-PLAN.md~~ — **RETIRED 2026-11-24, superseded by 05.1.1-12 (Phase 5.1.1).** Was: Give the review panel the chunk text it needs for evidence spans, and nothing more (D-21). (wave 8)
- [ ] 07-24-PLAN.md — Build the regression runner's statistics and protocol: pre-registration, the decision rule, multiplicity… (wave 8)
- [ ] 07-25-PLAN.md — Connect the regression runner of plan 07-24 to the eval harness for external backends, then run the full… (wave 9)
- [ ] ~~07-26-PLAN.md~~ — **RETIRED 2026-11-24, superseded by 05.1.1-20/21 (Phase 5.1.1).** Was: Add the periodic failure report that lists new production failures by layer and category, and run it… (wave 8)
- [ ] 07-27-PLAN.md — Write the documentation ADM-03 asks for: a RAG pipeline guide with generated switch tables, the `.env`… (wave 10)
- [ ] 07-28-PLAN.md — Add the semantic-cache case to the cross-tenant canary suite on all three backends, for the chat, embed and voice… (wave 7)
- [ ] ~~07-29-PLAN.md~~ — **RETIRED 2026-11-24, superseded by 05.1.1-17/18 (Phase 5.1.1).** Was: Let admins work the review queue in the Config UI: open a queued case, see its question, answer,… (wave 9)
- [ ] 07-30-PLAN.md — Make CI prove that the shipped defaults equal the latest defaults decision: today's defaults while the… (wave 10)
- [ ] 07-31-PLAN.md — Close the automated part of Phase 7: fold the Phase 7 migrations into both setup files, prove every… (wave 11)
- [ ] 07-32-PLAN.md — Collect the three human decisions and actions Phase 7 needs before the live checks: the Vercel plan… (wave 12, autonomous: false)
- [ ] 07-33-PLAN.md — Run the Phase 7 live verification items as explicit checkpoints, then apply the shipped defaults from… (wave 13, autonomous: false)
- [ ] 07-34-PLAN.md — Extend the cross-tenant canary suite to the voice and embed entry points on pgvector, Weaviate and Qdrant,… (wave 6)
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 3.1 → 3.1.1 → 3.2 → 3.2.1 → 4 → 4.1 → 4.1.1 → 4.2 → 4.3 → 5 → 5.1 → 5.1.1 → 5.2 → 5.2.1 → 5.3 → 6 → 6.1 → 6.2 → 6.3 → 7. Phase 6 depends on Phase 5 (its plans build on Phase 5 contracts) and runs after Phase 5.1, which touches the same files. Phase 7's backend and sync work needs only Phases 3 and 4; its regression and closeout need Phases 5 and 6. Inserted 2026-11-24: 3.1.1 follows 3.1 (and needs Phase 4's v2 search on trunk); 4.1 follows Phase 4's automated close (04-42) and flips the retrieval defaults that every later phase runs on; 4.1.1 follows 4.1; 5.1.1 follows 5.1 (plan 05.1.1-24 also needs 4.1.1), takes over EVAL-17 from Phase 7, and Phase 6 plans sharing its files depend on 05.1.1-22; 6.1 needs Phases 6, 3.1.1 and 5.1.1. Phases 3.2, 4.2, 5.2 and 6.2 were inserted on 2026-11-25 so that no plan of a phase already executing changes, 3.2.1 (BGE-M3, split from 3.2 on 2026-11-25) follows 3.2 and needs 3.1.1, and later phases do not wait for it; 5.3 (evaluation gates and online monitoring) follows 5.2 without holding up Phase 6; 6.3 (source deletion sync and purge) follows 6.2, and Phase 7's outbox must carry its purges; Phase 7 had 2 of 34 plans executed and gains requirements through a plan revision. Phase 6 depends on Phase 5 (its plans build on Phase 5 contracts) and runs after Phase 5.1, which touches the same files. Phase 7's backend and sync work needs only Phases 3 and 4; its regression and closeout need Phases 5 and 6.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Evaluation Harness & Baseline | 22/22 | Executed (verification pending) | - |
| 2. Unified Retrieval Pipeline & Tenant Scope | 36/36 | Complete (live checks pending) | 2026-11-24 |
| 3. Unified Ingestion & Embedding Profiles | 53/53 (55 summaries incl. gap plans) | Executed (verification pending) | - |
| 3.1. Tiered Parsing, Incremental Queue & Bulk Backfill (INSERTED) | 54/55 | In Progress (live checks) | - |
| 3.1.1. Domain Embedding Model Candidates & Per-Doc-Type Selection (INSERTED) | 0/16 | Planned (plan-check PASS) | - |
| 3.2. Language Support & Ingestion Hardening (INSERTED) | 0/65 | Planned | - |
| 3.2.1. BGE-M3 Open-Source Fallback Embedding (INSERTED) | 0/5 | Planned (needs 3.1.1) | - |
| 4. Hybrid Retrieval, Reranking & Calibrated Refusal | 46/47 | In Progress (04-43 live calibration) | - |
| 4.1. Hybrid Retrieval & Rerank On by Default (INSERTED) | 0/13 | Planned (plan-check PASS, revised 2026-11-25) | - |
| 4.1.1. Domain Terminology Dictionary (INSERTED) | 0/18 | Planned (plan-check PASS, revised 2026-11-25) | - |
| 4.2. Retrieval Tuning Additions (INSERTED) | 0/38 | Planned (plan-check PASS) | - |
| 4.3. Document Access Groups (INSERTED) | 0/38 | Planned (plan-check PASS) | - |
| 5. Verified Citations & Groundedness | 18/26 | In Progress | - |
| 5.1. Prompt Injection Defense (INSERTED) | 10/25 | In Progress | - |
| 5.1.1. Feedback Loop & Real Domain Test Set (INSERTED) | 0/25 | Planned (plan-check PASS) | - |
| 5.2. Grounded Answers & Output Safety (INSERTED) | 0/40 | Planned (plan-check PASS) | - |
| 5.2.1. Calculation Tool & Prompt Budget (INSERTED) | 0/26 | Planned (plan-check PASS) | - |
| 5.3. Evaluation Gates & Online Monitoring (INSERTED) | 0/TBD | Not planned | - |
| 6. Query Layer (LlamaIndex & LangChain) | 12/46 | In Progress | - |
| 6.1. Embedding Fine-tuning Pipeline (INSERTED) | 0/20 | Planned (plan-check PASS) | - |
| 6.2. Query Layer Additions (INSERTED) | 0/TBD | Not planned | - |
| 6.3. Source Deletion Sync & Purge (INSERTED) | 0/27 | Planned (plan-check PASS) | - |
| 7. External Backends & Release Defaults | 2/52 | In Progress (revision 4 planned 2026-11-25; UI-SPEC pending for 07-48, 07-49, 07-52) | - |
