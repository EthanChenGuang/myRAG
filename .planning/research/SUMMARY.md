# Project Research Summary

**Project:** myRAG RAG full-pipeline upgrade (six layers: data, query, retrieval, rerank and context, generation, evaluation)
**Domain:** Production RAG upgrade of a multi-tenant Next.js 16 / React 19 / TypeScript chat app on Supabase pgvector, with a new Python sidecar
**Researched:** 2026-11-22
**Confidence:** MEDIUM overall

## User decisions that override research

PROJECT.md was written after the four research files. Where they conflict, PROJECT.md wins:

- **No LangChain in the query layer.** Query features use LlamaIndex methods only, implemented natively in TypeScript: history-condense rewrite, multi-query with RRF fusion, HyDE, and sub-question generation (no answer synthesis) are ported as algorithms and prompts. STACK.md's `@langchain/classic` imports and its `EnsembleRetriever` recommendation are dropped. The zod 3 vs zod 4 conflict that LangChain forced (STACK.md section 0, item 13) goes away.
- **Pydantic v2 (`pydantic>=2.14.4`) is the standard for all structured outputs:** sidecar request and response models, golden-set items, eval results, and LLM structured outputs (decomposition, doc-type detection, rewrite, judge scores). The TypeScript side uses Zod schemas generated from Pydantic-exported JSON Schema, with a CI parity check. STACK.md's `pydantic>=2.11,<3` is superseded.
- **pgvector is kept permanently** alongside Weaviate and Qdrant and stays the default backend. Whether a different default is chosen is decided by eval.
- **HHEM is split by key and language.** HHEM-2.3 is called through Vectara's hosted API as an explicit opt-in (answers and chunks leave the deployment). Italian answers are recorded as "not checked". With no Vectara key, English answers use HHEM-2.1-Open locally in the sidecar. The UI uses a three-state badge (verified / possibly unreliable / not checked). Nothing blocks answers in this phase.

Note: with no key, Chinese and Italian answers are "not checked" (HHEM-2.1-Open is English-only). Chinese is scored only when the Vectara key is set and opt-in is on.

## Executive Summary

myRAG is a multi-tenant chat product whose core promise is correct, cited answers from the user's own documents, with an honest "I don't know" when the documents lack the answer. Experts build this as a measured pipeline: parse and chunk with per-document-type profiles and rich metadata; hybrid retrieval (dense plus lexical) with metadata pre-filters; a cross-encoder reranker over an over-retrieved pool; refusal from calibrated reranker scores; citations validated against the context actually sent; and an evaluation harness that gates every change. Keep the Vercel AI SDK on v6, add provider packages for embeddings and rerankers (Voyage, Cohere, DeepInfra-hosted Qwen3), add the direct Anthropic path for Claude Citations, and put Docling, HHEM proxying, DeepEval, and Ragas in a Python sidecar. Use Pydantic v2 for every structured contract and generate the Zod side from it.

The approach is sequencing. Build golden-set evaluation and a baseline of the current system first. Introduce one retrieval pipeline (`src/lib/rag/`) with a branded `TenantScope`, and route the three entry points (text chat, embed, voice) through it behaviour-preservingly. Then change data (ingestion, metadata, doc types), embeddings (registry, shadow profiles, resumable re-embed), and retrieval quality (hybrid, rerank, abstention). Generation (citations and groundedness) can proceed in parallel. External vector backends come last, behind the same adapter contract.

Key risks: cross-tenant leakage once search leaves Postgres (no RLS safety net in Qdrant or Weaviate); false refusals that hide infrastructure failures as "information not available"; mixed-model or over-dimension indexes (pgvector HNSW caps at 2000 dims for `vector`, 4000 for `halfvec`); Chinese keyword search silently doing nothing on stock Postgres; latency stacking from serial LLM transforms on chat and voice. Open structural conflicts are listed under Gaps.

## Key Findings

### Recommended Stack
- Vercel AI SDK stays on v6; every `@ai-sdk/*` package installed with the `ai-v6` dist-tag (bare install resolves to incompatible v7-generation providers).
- `@ai-sdk/anthropic@3.x` for Claude Citations (`text/plain` and `application/pdf` file parts only); `@ai-sdk/voyage` and `@ai-sdk/cohere` for embeddings and reranking (string IDs such as `rerank-v5.0-pro`, `voyage-4-large`); `@ai-sdk/deepinfra` or `@ai-sdk/openai-compatible` for hosted Qwen3-Embedding-8B. `@anthropic-ai/sdk` only as an escape hatch for `search_result` blocks.
- Sidecar: Python 3.12, FastAPI, `docling==2.151.1` with `docling-core==2.108.0` (`HybridChunker` repeats table headers by default), `httpx`, `pydantic>=2.14.4`. Eval in a separate `pyproject.toml` (DeepEval, Ragas, Anthropic judge SDK) so Ragas' LangChain family does not bloat the production image.
- Embeddings: Qwen3-Embedding-8B is 4096-dim native and cannot be indexed by pgvector at that size. Truncate with MRL to 1024 or 2048, re-normalise, store as `halfvec`. Voyage-4-large defaults to 1024 (allowed 256/512/1024/2048). Qwen3 queries need an instruction prefix; documents do not.
- Rerankers: Cohere `rerank-v5.0-pro`/`-fast`; Voyage `rerank-3` (name verified only to MEDIUM; `rerank-2.5` is the stated multilingual fallback). Scores are per-provider; calibrate thresholds per provider and language.
- Hallucination scoring: HHEM-2.3 is API-only; the sidecar proxies `POST /v2/evaluate_factual_consistency` (`hhem_v2.3`). HHEM-2.1-Open (Apache-2.0, English, CPU, ~1.5 s for 2k tokens) is the local fallback. Italian is not supported by either.
- Vector backends: pgvector (default; `halfvec` HNSW; `hnsw.iterative_scan`). Weaviate `weaviate-client@3.15.3` (native multi-tenancy, immutable once enabled). Qdrant `@qdrant/js-client-rest@1.20.0` (shared collection, `is_tenant` index, mandatory filter per query). Both TS clients require Node >=22; the repo documents >=20.9.

### Expected Features

**Must have (milestone core):**
- Golden set (50–200 items, span-based gold labels: document, section, quote, never chunk IDs), covering zh/en/it and categories (multi-turn, compound, exact term, table, scanned, no-answer). Recall@k and MRR (deterministic), Faithfulness / Answer Relevance / Context Recall via DeepEval and Ragas, split refusal metric (correct-refusal and false-refusal), baseline run three times for noise, PR smoke gate and nightly full run.
- Unified metadata on every ingestion path; one shared `ingest()`; upload doc-type picker (auto-detected, overridable, `general` fallback).
- Docling as switchable parser with LlamaParse fallback; table header repetition; `parser_used` recorded.
- Tenant-scoped content-hash dedup; flip-based versioning (insert new, flip current, soft-supersede old).
- History-aware rewrite (skipped without history), with switches, timeouts, original query retained.
- Switchable embeddings (Qwen3 hosted, Voyage-4-large, OpenAI kept), model recorded per index; resumable shadow-profile re-embed.
- Hybrid retrieval with pre-filters (date, source, document, doc type, language); application-side RRF; one `TenantScope`-enforcing adapter.
- Cross-encoder rerank over an over-retrieved pool; fall back to fused order on timeout.
- Refusal from calibrated reranker threshold (per provider and language, holdout split); strict-mode "information not available" unchanged.
- Context assembly: dedupe, merge adjacent chunks, token budget, stable chunk IDs, best-at-edges ordering.
- Claude path: direct Anthropic with Citations; other models: chunk-alias tags with server-side validation; one normalized `Citation` record.
- Async post-stream groundedness with three-state badge; mode-aware display.
- Admin config for providers and switches: Test-connection, masked secrets, index-compatibility warnings, health.

**Should have (after baseline and comparison runs):** multi-query, sub-question decomposition, query router (per query class, only where eval shows gain); HyDE off by default and never in voice; contract clause and financial row chunking; contextual prefix (A/B only); parent-child expansion; partial answers; comparison reports; feedback on warnings; preset profiles.

**Defer (v2+):** sentence-level highlighting; citation click-through; shadow dual-read; chat filter chips; cross-language query variants; production sampling; version-history UI; editable doc-type profiles; extractive compression; any hallucination blocking.

**Avoid:** HyDE/multi-query/decomposition on every query; Claude Citations with structured output (HTTP 400); a global fixed rerank cutoff; numeric "accuracy" for users; global cross-tenant dedup; in-place re-embedding; gate thresholds set before baseline; Ragas questions as ground truth; LLM-judge as sole evidence.

### Architecture Approach

One pipeline module, `src/lib/rag/`, owns everything. The three entry points (`chat/route.ts`, `embed/chat/route.ts`, `internal/voice-rag/route.ts`) become thin adapters: authenticate, resolve `TenantScope`, call `runRetrieval()`, render for their transport. Nothing outside `rag/` imports a backend, embedding provider, or reranker.

- **Tenant isolation is a type:** branded `TenantScope`, minted only by `resolveTenantScope()` after membership check with the user-scoped client. Adapters accept only that type and inject the tenant predicate on every sub-query.
- **Supabase is the only writer;** external stores are derived. DB-trigger outbox carries notifications only; the drain worker re-reads current state; reconcile compares counts and ID sets.
- **Separate read and write interfaces:** `RetrievalBackend` (search) for the pipeline; `VectorIndexWriter` (upsert/delete) only for the sync worker.
- **Stage runner** with per-stage timeout, flag, and degrade-to-skip; retrieval core falls back to pgvector.
- **Two citation strategies behind one `Citation` type;** structured output only on helper calls, never on the streamed Claude answer.
- **Eval calls the real TS pipeline** through an authenticated internal endpoint returning traces; Python only scores.
- **Rollbackable embedding profiles:** per-profile columns or tables; switching is a pointer flip.
- **Processing profiles are data;** one `ingest()` and one `chunk-writer` replace the two ingestion paths.

**Major components:** (1) pipeline and tenant scope; (2) query stages (native); (3) embedding and reranker providers behind own interfaces; (4) read-side backend adapters; (5) context assembly and abstention; (6) generation (prompt with `{{context}}`, citation strategies, groundedness hook); (7) ingest and sync; (8) `rag-sidecar/` (FastAPI, Docling jobs, groundedness proxy, auth) and `eval/` package.

**Consolidation:** delete `reranker-adapter.ts`, `retrieval-strategies.ts`, `optimized-search.ts`, `adaptive-retrieval.ts`, and never-called functions in `thinking-rag-enhancer.ts`; re-home `enhanced-rag-retrieval.ts` as a `legacy` strategy, then delete; keep `temporal-query-detector.ts`, `reranker-local.ts` (as `LocalHybridReranker`), and `mmr-scorer.ts` behind a flag. Do deletions in a commit separate from extraction; check with `tsc --noEmit`.

### Critical Pitfalls

1. **Cross-tenant leakage via external stores.** Qdrant `is_tenant` is performance, not isolation. Mitigation: required `TenantScope`; adapter throws without a tenant clause; read-time re-validation of returned IDs against Supabase under caller RLS; two-tenant canary tests (personal vs org, null org, removed member) as release gate.
2. **Infrastructure failures become false refusals.** Mitigation: discriminated status `ok | empty | error | degraded`; only verified-ready `empty` may refuse; per-tenant per-backend `index_state`; missing reranker score disables threshold refusal for that request.
3. **Dimension limits and mixed-model indexes.** Never `ALTER COLUMN TYPE` in place; store `embedding_model_id` per vector; derive query model from the index; assert dimension and model at startup and per request; per-profile partial expression HNSW indexes; recalibrate thresholds per model.
4. **Latency stacking.** Gate transforms; embed variants in one batch; fuse once and rerank once; per-stage timeouts; voice allow-list (rewrite, hybrid, optional fast reranker; no HyDE or decomposition); groundedness post-stream; `AbortSignal` through all stages.
5. **Re-embedding by re-parsing.** Re-embed reads stored chunk text only, writes only the new vector column, resumable on `(chunk_id, model_id)`; re-parse is a separate versioned job.
6. **Dedup and versioning leaks or gaps.** Hash scope includes tenant; hash normalized parsed text; check file hash before paid calls; flip-based versions in one transaction; soft-supersede while messages cite old chunks.
7. **Chinese and Italian keyword search silently degrades.** Pick one lexical approach (see Gaps); zh exact-term retrieval test; per-language eval slices, gating zh individually.
8. **Citation drift and the Claude conflict.** Short aliases assigned after final ordering; streaming-safe marker parser with token-split tests; persisted citation snapshots; one `citations[]` schema; no `output_config.format` on Claude citation calls.
9. **Unstable or non-production eval.** Pin judge (different family from generator); explicit judge config; telemetry opt-outs (verify variable names); span-based labels; n=3 repeats with paired deltas; config hash in every run; authenticated eval endpoint off in production.
10. **Unauthenticated new surfaces.** Constant-time shared-secret compare (`timingSafeEqual`) on every new route; fail closed if secret unset; no URL fetching in sidecar; no document text in logs; async ingestion jobs; readiness only after models load.

Also track: config drift across the five locations (`check-config` script); HHEM on unsupported languages or before calibration; rewrite dropping identifiers or switching language; no tests and a 4,500-line route (characterization tests; type-check ratchet); parallel retrieval stacks; image RAG regressions; per-vendor data-flow inventory.

## Implications for Roadmap

Order follows ARCHITECTURE.md build order, merged where dependencies allow.

### Phase 1: Evaluation baseline and sidecar skeleton
**Rationale:** Nothing is accepted without a baseline; span-based labels must exist before chunking changes. Also fixes the Pydantic-to-Zod contract that later schemas depend on.
**Delivers:** `rag-sidecar/` (FastAPI, shared-secret auth, Dockerfile, health/readiness, `pyproject.toml`); eval package (DeepEval, Ragas, runner); golden-set JSONL with review status, dev and locked splits; authenticated `/api/internal/rag/run` wrapping current code, replicating the chat route's similarity filter; three-run baseline committed; PR-smoke and nightly CI; Pydantic source with Zod generation and CI parity check; `check-config` manifest; fix or remove `npm run test-rag`; characterization tests (strict refusal, webSearch+strict, `source_images`, `{{context}}`).
**Addresses:** EVL-01 to EVL-11, ADM-05, the contract.
**Avoids:** judge flake, contamination, harness drift, no-corpus CI, telemetry leak, unauthenticated sidecar.

### Phase 2: Pipeline seam, tenant scope, consolidation (behaviour-preserving)
**Rationale:** One plug-in point; `TenantScope` before any external backend; baseline must reproduce within noise.
**Delivers:** `src/lib/rag/` with `legacy` strategy; `TenantScope` with membership verification (closing unverified `organizationId` path); all three entry points through `runRetrieval`; context assembly extracted from chat (~L2169–2350) and embed (L143–210); dead modules deleted in separate commit; `RAG_PIPELINE=legacy|v2`; voice heuristics moved to voice-only step.
**Avoids:** parallel stacks, route growth, request-body tenant IDs.

### Phase 3: Ingestion unification, metadata, doc-type profiles, Docling
**Rationale:** Metadata is the keystone for filters, dedup, versioning, citations, eval matching; precedes hybrid and sync.
**Delivers:** one `ingest()` and `chunk-writer` behind both paths and connectors; schema additions (`doc_type`, `content_hash`, `version`, `is_current`, promoted columns, lexical text field); profiles registry (financial, legal, technical, scanned, default); doc-type picker with auto-detect and override; Docling as async sidecar parse job with LlamaParse fallback and `parser_used`; tenant-scoped dedup and flip-based versioning; explicit tokenizer for chunk sizing; OCR languages configured.
**Avoids:** sync Docling in handlers, cross-tenant hashes, doc-type as hard filter, tokenizer mismatch.

### Phase 4: Embedding registry, shadow profiles, resumable re-embed
**Rationale:** Highest-risk switch; needs model recorded per vector and rollback before new models are evaluated. After Phase 3 so one pass re-embeds final chunks.
**Delivers:** `EmbeddingProvider` registry (OpenAI kept, Voyage-4-large, hosted Qwen3-8B with MRL, query-side instruction, `input_type`); `embedding_profiles` with active pointer; per-profile `halfvec` and partial expression HNSW; `reprocess-documents.js` extended into resumable, dry-run re-embed-only job (no parser calls); dimension and model assertion at query time; provider capability table.
**Avoids:** mixed-model indexes, in-place ALTER, re-parse cost, pooler index builds, provider drift.

### Phase 5: Hybrid retrieval, rerank, context, abstention on pgvector
**Rationale:** Largest quality gain without new infrastructure; defines the backend contract for Phase 8.
**Delivers:** hybrid SQL RPC (dense plus lexical, filtered, RRF) granted to server role only, never `anon`; `RetrievalBackend` with mandatory scope; Cohere and Voyage rerankers and `LocalHybridReranker` returning chunk IDs and raw scores; candidate pool then top-k (eval sweep); best-at-edges ordering; MMR behind flag; abstention by per-provider, per-language threshold calibrated on dev split with holdout gate; fail-open order with refusal disabled on reranker failure.
**Avoids:** refusal on missing scores, global thresholds, per-sub-query rerank, RRF scores for refusal.

### Phase 6: Generation — citations and groundedness
**Rationale:** Needs stable chunk IDs (Phases 2, 5) and sidecar (Phase 1); parallel with 7 and 8; starts with a spike.
**Delivers:** `CitationStrategy` with `chunk-alias` (non-Claude; drops unknown aliases) and `claude-citations` (direct Anthropic, per-chunk `text/plain` documents, no structured output on that call; OpenRouter-to-Anthropic ID map in five-location sync); normalized `citations[]` persisted with snapshots; sidecar HHEM proxy (Vectara opt-in; HHEM-2.1-Open locally for English without key; Italian "not checked"; Chinese "not checked" without Vectara key); post-stream async scoring to message metadata and logs; three-state hedged badge; mode-aware display; `source_images` untouched.
**Avoids:** structured output with Citations (400), alias drift, English-only scorer on zh/it, HHEM in answer path, egress without opt-in.

### Phase 7: Query layer (native TypeScript, LlamaIndex algorithms)
**Rationale:** After rerank so extra candidate load is paid for by the reranker and measured.
**Delivers:** condense-question rewrite (same language; numbers and names verbatim; return original if standalone); multi-query with RRF; HyDE (off by default, per-language prompt, never voice); sub-question generation only (structured output, capped 3–4, no synthesis); shared RRF module; per-feature switches, timeouts, budgets; query trace; router reusing `query-classifier.ts`; original query always retained.
**Avoids:** latency stacking, HyDE false answers on no-answer items, identifier loss, framework runtime dependencies.

### Phase 8: External backends and sync (Weaviate, Qdrant)
**Rationale:** Most infrastructure, least certain benefit; pgvector stays default unless eval shows a clear win.
**Delivers:** `VectorIndexWriter`; outbox table, triggers (including cascade deletes), claim RPC, drain route with `SKIP LOCKED`, per-tenant reconcile; Weaviate adapter (tenant per workspace, `vectorizer: none`, named vectors per profile); Qdrant adapter (collection per profile, `is_tenant` index, wrapper-injected filter, re-validation against Supabase); per-tenant `index_state` with pgvector fallback; cross-tenant canary suite as release gate; comparison with fusion and embeddings held constant.
**Avoids:** tenant leakage, zombie vectors, dual-write, backend-specific features leaking past adapter.

### Phase 9: Closeout and defaults
**Delivers:** full regression on locked test set (count of uses recorded); defaults for backend, embedding, reranker; flag-off parity; Config UI complete with auth; Test-connection buttons; `AGENTS.md` and docs; voice latency check; vendor data-flow inventory.

### Phase Ordering Rationale
- Evaluation before everything: targets and rollback need a baseline; span labels survive chunking.
- Seam before features: TenantScope and one retrieval module before backends and transforms.
- Data before embeddings before retrieval: chunk shape and metadata define filters and payloads; re-embed once over final chunks.
- Generation alongside query work: citations depend on stable context blocks, not transforms.
- External backends last: pgvector default; contract proven first.

### Research Flags

Needs deeper research during planning:
- **Phase 1:** golden-set curation effort; Ragas language adaptation for zh and it; DeepEval and Ragas telemetry variable names (from memory).
- **Phase 3:** Docling OCR for scanned Chinese and Italian; async parse sizing on Fly; doc-type detection by LLM vs rules.
- **Phase 4:** Qwen3 host choice (dimension parameter, precision, rate limits, instruction handling: `input_type` vs manual prefix, not both); `halfvec` HNSW build cost.
- **Phase 5:** Chinese lexical behaviour under chosen approach; Cohere and Voyage calibration; Voyage `rerank-3` vs `rerank-2.5` on zh and it.
- **Phase 6 (deepest):** whether `@ai-sdk/anthropic` surfaces citations and accepts `search_result` in v6 streaming with tools and approvals; Citations with MCP and webSearch (may need direct SDK for turns without tools); Vectara API host, header, rate limits, `source_texts` limit, retention before multi-tenant use.
- **Phase 8:** Weaviate hybrid inside a tenant; Weaviate Cloud `gse_ch` availability; Qdrant per-prefetch filters and BM25 tokenizers; outbox worker hosting under 60 s cap.

Standard patterns (skip research-phase): Phase 2 (seam and characterization); Phase 7 (documented algorithms; only prompt localisation needs golden-set tuning); outbox sync, per-model registry, tiered CI gating, flag rollout, soft-supersede versioning.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM-HIGH | Versions verified from registries and packages; weaker on Voyage `rerank-3`, DeepInfra `dimensions`, Weaviate/Qdrant Chinese tokenizers. |
| Features | MEDIUM | Vendor facts checked; "what production systems do" is practitioner consensus; reference products from memory. |
| Architecture | MEDIUM-HIGH | Code-grounded findings HIGH; external-service specifics MEDIUM; build order is a recommendation. |
| Pitfalls | MEDIUM-HIGH | Vendor limits from primary sources; several items marked `[VERIFY]`. |

**Overall confidence:** MEDIUM.

### Gaps to Address
- **Chinese and Italian lexical approach (research conflict).** STACK.md: PGroonga for Chinese plus language-specific `tsvector` for en/it. ARCHITECTURE and PITFALLS: one shared application tokenizer (`Intl.Segmenter` or jieba) stored as `lexical_text`, indexed identically on all backends. Decide in Phase 3 or 5 with a zh exact-term test.
- **Node version.** Weaviate and Qdrant clients need Node >=22; repo documents >=20.9. Decide before Phase 8.
- **Chinese HHEM coverage.** HHEM-2.3 lists Simplified Chinese (zh-Hans), not Traditional. Treat Traditional as "not checked" until validated.
- **Voyage reranker name and multilingual quality.** Confirm `rerank-3` ID; compare with `rerank-2.5` on zh and it slices.
- **Anthropic Citations in AI SDK v6.** Whether `search_result` input and citation parts survive streaming, tools, approvals. Spike; direct SDK is fallback for turns without tools.
- **Zod generator choice.** Choose the Pydantic-JSON-Schema-to-Zod generator and confirm it targets the installed Zod major (app is on `^3.25.76`); add CI parity check in Phase 1.
- **Golden-set power.** At 50–200 items only large effects are detectable; gate on aggregate plus named slices.
- **Voice reduced profile.** Exact allowed stages need measured stage latencies.
- **Latency budgets** are starting points (chat pre-first-token ~2 s; voice ~800 ms), to be replaced with baseline p50/p95.
- **Embed widget and voice tenancy.** Embed passes no scope; voice trusts caller `userId`. Product decisions needed before Phase 2 finalises `resolveTenantScope`.
- **Eval telemetry opt-outs.** Confirm DeepEval and Ragas variable names before CI wiring.

## Sources

**Primary (HIGH):** Anthropic Citations and search-results docs; Vectara HHEM model card and language/REST docs; pgvector and Supabase HNSW docs; Qdrant multitenancy docs; Weaviate multi-tenancy and config references; Docling chunking docs; npm and PyPI metadata (`@langchain/classic@1.0.62`, `llamaindex@0.12.1`, `ai@6.0.333`, `@ai-sdk/*`, `docling-core@2.108.0`, `ragas@0.4.4`, `deepeval@4.3.4`); codebase inspection (chat, embed, voice-rag routes; `enhanced-rag-retrieval.ts`; `reranker-adapter.ts`; `document-processor.ts`; `vercel.json`; SQL setup files; `.planning/codebase/CONCERNS.md`).

**Secondary (MEDIUM):** Cohere Rerank docs and changelog; Voyage embeddings, flexible-dimensions, reranker docs; AI SDK provider pages; Qwen3-Embedding model card and hosting listings; Qdrant 1.20 notes and hybrid-query docs; Ragas language-adaptation how-to; DeepEval CI guide; Weaviate tokenization docs and GSE community thread; Supabase hybrid-search and PGroonga docs; arXiv 2610.05348 and 2502.17163.

**Tertiary (LOW, needs validation):** Cohere "calibrated scores" claim (secondary only); aggregator pricing; Together AI availability; Weaviate release numbers and `gse_ch` Cloud availability; DeepEval and Ragas telemetry variable names (from memory); Anthropic contextual-retrieval effect size (not used for a decision); competitor feature descriptions (from memory).

---
*Research completed: 2026-11-22*
*Ready for roadmap: yes, subject to the Gaps above (lexical approach and Node version must be decided during roadmap or the first affected phase)*
