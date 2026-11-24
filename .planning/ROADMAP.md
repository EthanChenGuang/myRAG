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
- [ ] **Phase 3.1: Tiered Parsing, Incremental Queue & Bulk Backfill** (INSERTED) - Cheapest-tier-that-passes parse routing with escalation, cloud and budget constraints, an ingestion ledger and parse cache, an async upload queue and a budgeted, resumable backfill
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
- [ ] 03-46-PLAN.md — Compare embedding profiles on the golden set per language and per cross-lingual pair (wave 10)
- [ ] 03-47-PLAN.md — Close Phase 3 (wave 11)
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
**Plans**: 45 plans (04-01..04-45) — see `phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-PLAN-INDEX.md`

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
**Plans**: 34 plans in 13 waves — see `phases/07-external-backends-release-defaults/07-PLAN-INDEX.md`

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
- [ ] 07-22-PLAN.md — Extend the review queue's single Python implementation to full promotion, append-only safety and… (wave 8)
- [ ] 07-23-PLAN.md — Give the review panel the chunk text it needs for evidence spans, and nothing more (D-21). (wave 8)
- [ ] 07-24-PLAN.md — Build the regression runner's statistics and protocol: pre-registration, the decision rule, multiplicity… (wave 8)
- [ ] 07-25-PLAN.md — Connect the regression runner of plan 07-24 to the eval harness for external backends, then run the full… (wave 9)
- [ ] 07-26-PLAN.md — Add the periodic failure report that lists new production failures by layer and category, and run it… (wave 8)
- [ ] 07-27-PLAN.md — Write the documentation ADM-03 asks for: a RAG pipeline guide with generated switch tables, the `.env`… (wave 10)
- [ ] 07-28-PLAN.md — Add the semantic-cache case to the cross-tenant canary suite on all three backends, for the chat, embed and voice… (wave 7)
- [ ] 07-29-PLAN.md — Let admins work the review queue in the Config UI: open a queued case, see its question, answer,… (wave 9)
- [ ] 07-30-PLAN.md — Make CI prove that the shipped defaults equal the latest defaults decision: today's defaults while the… (wave 10)
- [ ] 07-31-PLAN.md — Close the automated part of Phase 7: fold the Phase 7 migrations into both setup files, prove every… (wave 11)
- [ ] 07-32-PLAN.md — Collect the three human decisions and actions Phase 7 needs before the live checks: the Vercel plan… (wave 12, autonomous: false)
- [ ] 07-33-PLAN.md — Run the Phase 7 live verification items as explicit checkpoints, then apply the shipped defaults from… (wave 13, autonomous: false)
- [ ] 07-34-PLAN.md — Extend the cross-tenant canary suite to the voice and embed entry points on pgvector, Weaviate and Qdrant,… (wave 6)
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 5.1 → 6 → 7. Phase 6 depends on Phase 5 (its plans build on Phase 5 contracts) and runs after Phase 5.1, which touches the same files. Phase 7's backend and sync work needs only Phases 3 and 4; its regression and closeout need Phases 5 and 6.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Evaluation Harness & Baseline | 22/22 | In Progress | - |
| 2. Unified Retrieval Pipeline & Tenant Scope | 36/36 | Complete (live checks pending) | 2026-11-24 |
| 3. Unified Ingestion & Embedding Profiles | 12/49 | In Progress | - |
| 3.1. Tiered Parsing, Incremental Queue & Bulk Backfill (INSERTED) | 0/55 | Planned (plan-check PASS) | - |
| 4. Hybrid Retrieval, Reranking & Calibrated Refusal | 0/45 | Planned | - |
| 5. Verified Citations & Groundedness | 0/26 | Planned (plan-check PASS after W1 fix) | - |
| 5.1. Prompt Injection Defense (INSERTED) | 0/25 | Planned (revision pass 1) | - |
| 6. Query Layer (LlamaIndex & LangChain) | 0/46 | Planned (plan-check pending) | - |
| 7. External Backends & Release Defaults | 0/34 | Planned (34 plans, 13 waves; revised after plan-check pass 1) | - |
