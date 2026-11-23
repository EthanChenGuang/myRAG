# Phase 4: Hybrid Retrieval, Reranking & Calibrated Refusal - Context

**Gathered:** 2026-11-23
**Status:** Ready for planning
**Mode:** `--auto`. Every gray area was resolved with the recommended option, per the user's standing instruction "all questions follow your recommendations".

<domain>
## Phase Boundary

This phase implements `RAG_PIPELINE=v2` inside the Phase 2 `src/lib/rag/` pipeline, on pgvector. v2 does six things:
- runs filtered hybrid search (dense plus lexical over a shared-tokenizer `lexical_text`, fused with RRF) through a `RetrievalBackend` interface that accepts only a `TenantScope`;
- reranks an enlarged, deduplicated and capped candidate pool with switchable rerankers (Cohere, Voyage, local BM25) in a fast and a quality tier;
- assembles the context with the most relevant chunks at the edges, adjacent chunks merged, inside a token budget, with optional extractive compression;
- refuses when the top rerank score is below a threshold calibrated per reranker and language;
- optionally returns parents for child hits (`RAG_PARENT_CHILD`), with chunking profiles that can be configured, swept, activated and rolled back per document type;
- keeps selective filters lossless (`hnsw.iterative_scan` plus an exact-scan cutoff).

Pool size, top-k, refusal thresholds and chunking profiles come from eval sweeps and calibration tooling, not from guesses.

In scope: RET-01, RET-02, RET-03, RET-04, RET-10, DATA-08, RNK-01 to RNK-06, CHK-03, CHK-04, CHK-05, LAT-01, LAT-02, XLG-03. For RET-01 to RET-03, only the pgvector half is in scope; the backend-agnostic conformance suite is written here and run unchanged on Weaviate and Qdrant in Phase 7.

Out of scope:
- Weaviate and Qdrant adapters, sync, canaries, readiness fallback: Phase 7 (RET-05 to RET-09). The interface must already fit RET-06 and RET-09.
- Query rewriting, multi-query, HyDE, decomposition, the real query translator (XLG-01) and the semantic cache: Phase 6.
- Citations and groundedness: Phase 5.
- Prompt-injection tagging: Phase 5.1.
- Ingestion, metadata fields, embedding profiles and section paths: Phase 3 and 3.1. This phase consumes them.
- Choosing the shipped defaults: Phase 7 (ADM-02). Every switch added here stays off by default.

</domain>

<decisions>
## Implementation Decisions

### Backend contract and fusion
- **D-01:** Contract (RET-01):
  - `src/lib/rag/backend/types.ts` defines `RetrievalBackend { id: 'pgvector' | 'weaviate' | 'qdrant'; search(req): Promise<BackendLegs>; health(): Promise<BackendHealth>; isReady(scope): Promise<boolean> }`.
  - `req` is `{ scope: TenantScope; embeddingProfileId; denseVector; lexicalTokens: string[]; filters: RetrievalFilters; denseLimit; lexicalLimit; signal }`. The filter `currentOnly: true` cannot be turned off.
  - `BackendLegs` is `{ dense: RankedHit[]; lexical: RankedHit[] }`. Each hit carries the full chunk payload, so no follow-up lookups are needed.
  - The adapter derives the tenant only from `scope`: the SQL tenant parameters on pgvector; in Phase 7, the Weaviate tenant name and the Qdrant `tenant_id` filter, both from `scope.tenantKey`.
  - The adapter rejects a non-branded scope at runtime.
  - `isReady` is always true for pgvector. It is the RET-09 seam.
  - **Reversibility:** costly. The Phase 7 Weaviate and Qdrant adapters and the conformance suite are written against this contract.
- **D-02:** Fusion happens in TypeScript, never natively in a backend. Backends return per-leg ranked lists. One shared `fusion/rrf.ts` fuses every backend the same way: RRF with `k = 60`, equal leg weights, ties broken by chunk ID. So the Phase 7 backend comparison measures backends, not fusion algorithms (Pitfall 8). `rrf_k` and the leg weights live in the retrieval params file (D-12) and can be overridden only through the eval endpoint.
- **D-03:** The backend conformance suite lives in `tests/rag/backend-conformance/` and is parametrized by a backend factory. Phase 4 runs it on pgvector (the PGlite fixture edge); Phase 7 adds factories for Weaviate and Qdrant without editing any case. It covers:
  - the Chinese exact-term case (model numbers, IDs, names) and its English and Italian counterparts;
  - every DATA-08 filter, applied before search;
  - current versions only;
  - two-tenant isolation with identical content in both tenants, where every leg is filtered;
  - the selective-filter case, which must equal an exact search;
  - the shape of the legs, and a lexical query that is empty or made only of stopwords;
  - deterministic tie order.

### pgvector hybrid SQL
- **D-04:** A new RPC, `hybrid_search_chunks`, is added. It follows Phase 3 D-05: an ordered, idempotent file in `supabase/migrations/`, mirrored into both setup files, and covered by the schema-equality test and the PGlite loader.
  - One call returns both legs as rows tagged with `leg` and `rank`.
  - The dense leg orders by cosine distance on the active embedding profile's vectors, routed by the registry's `storage` field (Phase 3 D-34 to D-36):
    - `legacy_column` reads `document_chunks.embedding vector(1536)`;
    - `halfvec` reads `chunk_embeddings` with the cast `embedding::halfvec(<dims>)` and `profile_id = p_profile_id`, so the partial expression HNSW index is used.

    The query-side model and dims are checked as Phase 3 D-37 requires.
  - The lexical leg uses `ts_rank_cd` on a stored generated `tsvector` (`to_tsvector('simple', lexical_text)`) with a GIN index. Phase 3 D-07 left this index to Phase 4.
  - Both legs apply the Phase 3 D-08 filter `is_current AND status = 'ready'`, so quarantined chunks never appear.
  - The query tokens arrive as `text[]` and the tsquery is an OR built safely inside SQL. User text is never concatenated into tsquery syntax.
  - The function is `SECURITY INVOKER`. It has `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` and `GRANT EXECUTE ... TO service_role`, and the v2 adapter calls it through the admin client.
  - The tenant is passed as `p_tenant_key` (from `scope.tenantKey`) and matched on the Phase 3 generated `tenant_key` column, which has a btree index.
    - A two-tenant test asserts that the result equals the `match_documents_by_workspace` predicate.
    - The function raises an exception, and never searches unfiltered, when the key is malformed. In the multi-tenant file it also raises on `s:default`; in the single-tenant file only `s:default` is accepted.
  - A PGlite test with `SET ROLE anon` and a fake-edge test with the anon key both prove that anon is refused (RET-04).
  - The legacy RPCs and their grants are not touched.
  - **Reversibility:** one-way. This is a published SQL function and grant on real Supabase projects; undoing it needs a migration.
- **D-05:** Filters (DATA-08) are applied in the `WHERE` clause of both legs before ranking:
  - date range on the document date;
  - `sources[]`, `documentIds[]`, `docTypes[]`, `languages[]`;
  - `is_current = true`, always.

  They read the promoted Phase 3 D-07 chunk columns: `doc_date`, `source`, `document_id`, `doc_type`, `language`, `is_current` and `status`. Filters come from three places:
  - (a) the existing temporal analyzer (date range);
  - (b) `documentRefs` (document IDs);
  - (c) an optional `retrievalFilters` field on the chat, embed and eval request bodies, validated with Zod (`zod/v3`).

  Filters can only narrow the tenant scope, never widen it. There is no new chat filter UI in this phase. The DATA-09 invoice filters (supplier, date range, amount range) reuse the Phase 3 D-27 promoted `documents` columns through the same filter object, as a join on `document_id`.
- **D-06:** Lossless selective filtering (RET-10):
  - The function sets `hnsw.iterative_scan` from `RAG_HNSW_ITERATIVE_SCAN` (`off | relaxed_order | strict_order`, default `off`) with `SET LOCAL` or a function-level setting.
  - When a bounded count (`LIMIT cutoff + 1`) of the filtered rows is below `RAG_EXACT_SCAN_CUTOFF` (default `0`, which means disabled), the dense leg instead does an exact ordered scan over the matching rows, with no index.
  - The bundled PGlite pgvector is 0.8.7, so both paths are tested in CI. Hosted Supabase's pgvector version is checked during live verification.
  - The eval reports the `selective_filter` category with iterative scan off and on.

### Shared tokenizer and `lexical_text`
- **D-07:** One tokenizer for every backend (RET-03): `src/lib/rag/lexical/tokenize.ts`. Phase 3 D-32 creates it (zh `Intl.Segmenter`, en/it fold, identifiers verbatim, `LEXICAL_VERSION`). Phase 4 completes it as a pure function with its rules stored as data, bumps `LEXICAL_VERSION`, and adds the query side. The same function runs on chunks and on queries.
  - Every language: NFKC normalization (full-width to half-width) and lowercase.
  - Codes: runs of letters and digits with internal `-_./` (model numbers, IDs, invoice numbers) are kept whole, and their parts are emitted as well.
  - Chinese: `Intl.Segmenter('zh', { granularity: 'word' })` words, plus overlapping Han-character bigrams (a unigram for a single-character run). The bigrams cover the cases where context-dependent segmentation splits a name or term differently in the chunk and in the query.
  - English and Italian: diacritic fold; Italian elisions split (`l'azienda` becomes `azienda`, `dell'anno` becomes `anno`); no stemming.
  - A small zh, en and it stopword list, stored as data, is applied on both sides.
  - A startup check and a test fail loudly if the runtime's ICU cannot segment Chinese.

  PGroonga and per-language `tsvector` configurations (STACK research) are rejected in favour of RET-03's application tokenizer. Stemming is added only if the eval shows the en or it slices need it.
  - **Reversibility:** costly. Changing the tokenizer re-tokenizes every chunk (cheap, from stored text) and resets every threshold calibration.
- **D-08:** Ownership of `lexical_text`:
  - Phase 3 D-07 creates the `lexical_text` column, and its chunk writer fills it with the D-32 tokenizer from `section_path` plus content (CHK-01). The text sent to the LLM is not changed.
  - Phase 4 adds the generated `tsvector` and its GIN index, and a `lexical_version` column (or the metadata key, whichever Phase 3 uses).
  - A batched, resumable, dry-run-capable backfill job (`npm run rag:relex`, in the style of the Phase 3 D-38 re-embed job) rebuilds `lexical_text` from stored chunk columns, with zero parser, sidecar and embedding calls. It runs for every chunk whose version is older, including legacy chunks written before Phase 3.
  - There is never a second lexical column.

### Rerankers and tiers
- **D-09:** A `Reranker` interface (`src/lib/rag/rerank/`):
  - `id`, `model`, `scoreSemantics: 'calibrated' | 'relative'`, and `rerank(query, docs, { topN, timeoutMs, signal })`. It returns, for every input, the original index and the raw score.
  - The providers are `cohere`, `voyage` and `local_bm25`. Each is a thin adapter over `fetch`, injected through `RagDeps`, so recorded vendor responses and fakes plug in without the SDK. The researcher confirms whether the AI SDK `rerank()` adds anything worth the dependency.
  - Cohere uses `rerank-v5.0-pro` (quality) and `rerank-v5.0-fast` (fast).
  - Voyage uses `rerank-3` (quality) and `rerank-3-lite` (fast, LAT-02). `rerank-2.5` is the multilingual fallback, chosen per language through `RAG_RERANK_VOYAGE_MODEL_BY_LANG` (for example `zh=rerank-2.5`). The live comparison on the zh and it slices decides those overrides. The researcher verifies every model identifier and endpoint.
  - `local_bm25` is the Phase 2 re-homed `local-hybrid` reranker rebuilt on the D-07 tokenizer, which fixes its Chinese behaviour (Pitfall 8). Its IDF is computed over the candidate pool and its scores are normalized to [0, 1]. Its `scoreSemantics` is `relative`.
  - The boundary check (Phase 2 D-14) keeps reranker HTTP calls inside `src/lib/rag/rerank/`.
- **D-10:** Tiers per entry point (LAT-02):
  - `RAG_RERANK_TIER_CHAT` defaults to `quality` (it also applies to embed and eval).
  - `RAG_RERANK_TIER_VOICE` defaults to `fast`.
  - Per-profile rerank timeouts (overridable with `RAG_STAGE_TIMEOUTS`): chat and embed 600 ms, voice 250 ms, eval none.
- **D-11:** Failure handling (RNK-06):
  - `rerank` is an optional stage under the Phase 2 stage runner.
  - On timeout, error or abort, the stage is skipped, the fused order is kept, the result is `degraded` (Phase 2 D-05), threshold refusal is turned off for that request, and the trace records `refusal: not_applied / reranker_unavailable`.
  - A missing score never counts as a low score.
  - A reranker that is switched off by configuration (`RAG_RERANKER=none`, the default) is `disabled`, not `degraded`. In that case refusal is also not applied.

### Candidate pool, deduplication and sweeps
- **D-12:** Retrieval parameters (RNK-02, LAT-01):
  - `candidatePoolSize` (per leg), `rerankInputCap` (from 50 to 100, as LAT-01 requires), `finalTopK`, `rrfK` and the leg weights live in a committed `eval/config/retrieval-params.json` (Pydantic `RetrievalParams`, with Zod generated from it). That file is written only by the sweep tool and records its numbers and config hash.
  - The app reads the file at startup. Env overrides exist only for operator emergencies, and per-request overrides only on the eval endpoint.
  - Starting values until the sweep runs: pool 75 per leg, cap 75, top-k 8.
- **D-13:** Parallelism and deduplication (LAT-01):
  - The query variants (the original, plus translated variants from D-22) each call `hybrid_search_chunks` in parallel with `Promise.all`, sharing the request `AbortSignal`. Each call returns both legs in one round trip.
  - All lists are fused by RRF.
  - Candidates are deduplicated by chunk ID and, when parent-child is on, by parent ID (the best rank is kept).
  - The list is cut to `rerankInputCap` before rerank.
  - The trace span reports `candidates_in`, `deduped`, `rerank_input` and `capped_from`.
- **D-14:** The sweep tool is `python -m rag_eval.sweep retrieval`. It drives the eval endpoint with eval-only overrides over a grid (pool 25/50/75/100, top-k 5/8/10/15/20), on the dev split only.
  - It picks the smallest configuration whose Recall@k and MRR are within the noise band of the best, with context tokens and then latency as tie-breakers.
  - It writes `retrieval-params.json` plus a Markdown report.
  - On the fixtures it runs with fake rerankers, which proves the tooling. The live numbers come from the live verification item.

### Context assembly
- **D-15:** v2 assembly extends the Phase 2 `assembleContext()` and does not fork it (RNK-03):
  - After rerank, adjacent chunks of the same document (consecutive `chunk_index` or the same parent) are merged into one block.
  - Blocks are ordered best-at-edges: rank 1 first, rank 2 last, rank 3 second, and so on.
  - The context is cut to `RAG_CONTEXT_TOKEN_BUDGET`, counted with `tiktoken` `cl100k_base` as in Phase 3 D-22 (default 6000; voice uses its profile's smaller default).
  - The block format, source labels, links section, `source_images` and the `{{context}}` substitution stay as they are.
  - Edge ordering has its own switch, `RAG_CONTEXT_EDGE_ORDER` (default `false`). When it is off, blocks follow rerank order.
  - Under `RAG_PIPELINE=legacy` nothing changes: the Phase 2 byte-identity tests stay green.
- **D-16:** Compression (RNK-04) is extractive only. Verbatim sentences or table rows are kept, so Phase 5 citations stay verbatim.
  - It uses relevant spans from the provider when the reranker returns them. Otherwise it uses local sentence scoring with the D-07 tokenizer against the query.
  - Table chunks, image chunks and chunks under a minimum length are never compressed.
  - Switch: `RAG_CONTEXT_COMPRESSION` (default `false`). When the switch is off the context is unchanged, and a test asserts that.

### Calibrated refusal
- **D-17:** Thresholds (RNK-05, XLG-03) live in a committed `eval/config/refusal-thresholds.json` (Pydantic `RefusalThresholds`).
  - Each cell is keyed by `(provider, model, query_language, pairing: same | cross)`. `cross` means that the query language differs from the language of the top candidate's document.
  - Each cell stores the threshold, the dev metrics (correct-refusal and false-refusal rates), the holdout check result, the item counts, the config hash, the tokenizer version and the date.
  - A cell is applied only when its status is `calibrated` (the holdout check passed).
  - A cell that is `uncalibrated`, `insufficient_data` or `failed_holdout` means no threshold refusal for that cell. That is recorded in the trace, never treated as a refusal.
  - Any change of reranker model or tokenizer version invalidates the matching cells.
  - **Reversibility:** costly. The persisted contract is consumed by the gate, the Config UI warnings and Phase 7's regression.
- **D-18:** The calibration tool is `python -m rag_eval.calibrate refusal`.
  - Fit: on the dev split only, per cell, it sweeps the observed top rerank scores of answerable items against no-answer items and picks the threshold with the highest correct-refusal rate for which the false-refusal rate stays at or below the target in `eval/config/refusal-calibration.json` (default 0.05).
  - Holdout: the check runs on the frozen `test` split (the Phase 1 70/30 split). The fit never reads that split.
  - A cell needs at least `min_no_answer` and `min_answerable` items (defaults 3 and 5 on fixtures, 10 and 20 on the real set). With fewer, it is marked `insufficient_data`.
  - Every number is recorded.
  - XLG-03: the cross-lingual cells must not raise false refusals above the same-language cells by more than the noise band. The tool reports that comparison.
- **D-19:** Refusal is applied in the `refusal` stage after rerank. Switch: `RAG_REFUSAL_THRESHOLD` (default `false`).
  - When the threshold refuses, the result is `status: 'empty'` with reason `below_threshold`, plus a `refusal` record (`decision`, `topScore`, `threshold`, `cell`). Every existing entry-point mapping then works unchanged:
    - strict mode streams the localized "information not available" response;
    - balanced and flexible modes get no knowledge-base context, as today with an empty result;
    - embed follows chat;
    - voice-rag returns empty results, and the agent says it found nothing.
  - The candidates and the would-be context stay in the eval trace, so the refusal metrics are scored. They are never sent to the model.

### Parent-child and chunking profiles
- **D-20:** Parent storage (CHK-03):
  - Parents live in a new table, `document_parents`. It has tenant columns matching `document_chunks`, `document_id`, `version`, `is_current`, `chunking_profile_id`, `section_path`, `content`, `token_count`, RLS identical to chunks, and server-role writes only.
  - Children stay in `document_chunks` with `parent_id` and `chunking_profile_id`. Only children are vector- and lexically indexed.
  - Parents are kept out of `document_chunks` so that legacy retrieval and every existing reader never see them.
  - With `RAG_PARENT_CHILD=true` (default `false`), a new `expand_parents` stage runs after refusal and before assembly:
    - parents are fetched in one `in()` query, under the same tenant predicate;
    - a parent hit several times is included once, at its best child's rank;
    - parents count against the D-15 budget;
    - if a parent does not fit, the child is kept.
  - **Reversibility:** one-way. This is a new table and columns in both SQL setup files on real projects.
- **D-21:** Chunking profiles (CHK-04, CHK-05) follow the embedding-profile pattern (Phase 3 D-36, D-38 and D-40):
  - A `chunking_profiles` table stores `id`, `doc_type`, `child_tokens`, `parent_mode` (`structure` with a token cap, or `fixed`), `parent_tokens` and `status` (`building | ready | active | retired`). There is one active pointer per document type at deployment level. Activation and rollback each run as one SQL function that records `previous_active_id`.
  - The Phase 3 `ProcessingProfile.parent_child` field (reserved by Phase 3 D-13) holds only the seed preset for a document type. The editable, built variants live in the table.
  - The legacy flat chunks of each type form profile `legacy`, so turning everything off restores today's behaviour.
  - Retrieval filters children to the active profile of their document type.
  - A new profile is re-chunked side by side from the stored parse output (Phase 3 D-18 `rag-originals/...`, and the Phase 3.1 parse cache), with zero parser calls, embedded under the active embedding profile (dual-write while building, like Phase 3 D-39), and then activated by a pointer flip. Rollback flips the pointer back.
  - Activation is refused while any current document of that type lacks chunks in the target profile, or while the target's eval regresses beyond the noise band.
  - Documents with no stored parse output (from before Phase 3) are listed by the dry run, with a count and a cost estimate, for a budgeted re-ingest. They are never silently mixed into the new profile.
  - The parent-child evals run in the Phase 3 D-42 `ingest` fixture mode, against that mode's own baseline.
  - Presets: 128/512, 256/1024 (the default) and 256/2048, plus custom values.
  - The validation rules are defined once, in Pydantic validators (`ChunkingProfile`). The Config UI's JS validator is checked against the same table of cases by a parity test.
    - Hard errors: the child exceeds the active embedding profile's maximum input (from the Phase 3 registry); the parent is smaller than twice the child.
    - Warnings: a parent/child ratio outside 4 to 8; top-k × parent size above the context budget.
  - The Config UI panel, "Chunking profiles", calls new admin routes `/api/rag/admin/chunking-profiles` (list, validate, build, activate, rollback). They follow the Phase 3 D-45 pattern: `admin_users` auth through the Authorization forwarding in `config-server.js`, Zod validation and structured JSON errors, and they fail closed.
  - `python -m rag_eval.sweep chunking` reports, overall and per document type, language and question kind:
    - Recall@k and MRR;
    - refusal rates;
    - judge answer correctness (nightly tier; skipped with a notice without a key);
    - context tokens and latency.

    The question kind is derived from the category: `exact_term`, `general` and `table` are fact lookups; `compound`, `multi_turn` and clause items are context-heavy.
  - The admin picks a profile per document type from that report. The choice is recorded with its numbers in `eval/decisions/`.

### Cross-language paths
- **D-22:** XLG-03 is built through a query-variants seam. v2 `runRetrieval` accepts `queryVariants: { text, language, kind: 'original' | 'translated' }[]`, and the original is always present.
  - In this phase the variants come from a `translate` stage slot. Behind `RAG_LEXICAL_TRANSLATION` (default `false`), it is served by a fixture translation table in tests and eval. The real small-model translator (XLG-01) plugs into the same slot in Phase 6. Phase 4 does not build a second translator.
  - The lexical leg and the `local_bm25` reranker use the variant whose language matches the candidate document's language. The dense leg uses the original, plus variants when present. Hosted rerankers get the original query, because they are multilingual.

### Switches, config and status
- **D-23:** New env vars:
  - `RAG_LEXICAL_SEARCH=false`
  - `RAG_RERANKER=none` (`none | cohere | voyage | local_bm25`)
  - `RAG_RERANK_TIER_CHAT=quality`
  - `RAG_RERANK_TIER_VOICE=fast`
  - `RAG_RERANK_VOYAGE_MODEL_BY_LANG=`
  - `COHERE_API_KEY=` (placeholder only; `VOYAGE_API_KEY` and `VOYAGE_BASE_URL` already come from Phase 3 D-44 and are reused), `COHERE_BASE_URL=`
  - `RAG_REFUSAL_THRESHOLD=false`
  - `RAG_CONTEXT_EDGE_ORDER=false`
  - `RAG_CONTEXT_COMPRESSION=false`
  - `RAG_CONTEXT_TOKEN_BUDGET=6000`
  - `RAG_PARENT_CHILD=false`
  - `RAG_HNSW_ITERATIVE_SCAN=off`
  - `RAG_EXACT_SCAN_CUTOFF=0`
  - `RAG_LEXICAL_TRANSLATION=false`

  They are mirrored in the five config locations and marked `managed` in `scripts/rag/env-manifest.json`, and `check-config` passes. `RAG_PIPELINE` gains a working `v2`.
  - With v2 and every sub-switch off, the flow is: dense-only through `hybrid_search_chunks`, then RRF over one leg, then the Phase 2 assembly in rerank order, with no refusal.
  - With `RAG_PIPELINE=legacy`, nothing in this phase runs.
- **D-24:** The v2 stage names are `analyze`, `translate`, `embed`, `search`, `exact_id_lookup`, `fuse`, `dedupe`, `rerank`, `refusal`, `expand_parents`, `assemble` and `compress`.
  - `exact_id_lookup` is the Phase 3 D-28 stage, behind `RAG_EXACT_ID_LOOKUP`. Under v2 its hits enter RRF as a third ranked list instead of being prepended. Whether to retire it is decided by the eval, as Phase 3's deferred list says.
  - Core stages: `embed`, `search` and `fuse`. Every other stage is optional.
  - The names are the eval `stage_latency_ms` keys and the Langfuse span names (Phase 2 D-19).
  - `RetrievalResult` gains `refusal` and `retrievalConfigHash`. The hash covers the backend, embedding profile, tokenizer version, retrieval params, reranker and model, the active chunking profiles and the switches. It is the seam for the Phase 6 semantic-cache key.
- **D-25:** Voice under v2 runs the same stage graph with the voice profile:
  - hybrid search, the fast tier, a 250 ms rerank timeout and a smaller token budget; no compression, and no translation unless switched on;
  - the legacy-only `voice_keyword_fallback` stage does not run, because the lexical leg replaces it;
  - the voice wire contract `{results, source_images}` and the `source_images` characterization must hold under v2.

  The latency budgets add rerank (chat p95 600 ms or less, voice p95 250 ms or less) to the Phase 2 D-21 file. They are report-only on fixtures. A test with injected delays shows that the voice profile stays under its 800 ms p95 budget with a fake fast reranker, and skips rerank rather than exceeding the budget.

### Evaluation and completion
- **D-26:** Golden-set additions (fixture, synthetic, approved, both languages' quote rules) are made only after legacy parity is re-confirmed on the unchanged set:
  - a new `Category` value, `selective_filter` (RET-10): a tenant or document type at 3% or less of rows, at least 4 items per language;
  - at least 8 `no_answer` items per language in total, including near-miss items on topics that are in the corpus but missing the asked fact, so that every calibration cell can reach its minimum on dev and on test;
  - clause and exception items on the Phase 3 contract fixture (CHK-03).

  The baseline is re-recorded, and the paired differences on pre-existing items must be zero (the Phase 2 D-25 pattern). Reports gain `by_doc_type` (from the gold-evidence document's type) and `by_question_kind`.
  - **Reversibility:** costly. The persisted golden files and the baseline change.
- **D-27:** A fake reranker for fixtures is deterministic. It scores from the fixture embedder's cosine similarity plus token overlap, and it has configurable per-language offsets, so that per-language calibration is exercised. It can also inject latency and failures.

  Cohere and Voyage response parsing is tested against recorded vendor responses under `tests/fixtures/rerank/`, which were written from the documented response shapes and carry no secrets. No test calls a live service.
- **D-28:** Phase completion is proven by four results, all on the fixture corpus:
  - (a) With `RAG_PIPELINE=legacy`, every paired difference against the baseline is zero.
  - (b) The recommended v2 configuration (hybrid on, `local_bm25` or the fake quality reranker, refusal on with fixture-calibrated cells, edge order on) shows no overall, language or category slice dropping beyond the noise band on Recall@k or MRR, and correct refusal improves.
  - (c) Each switch is compared on and off: parent-child, compression, iterative scan, translation.
  - (d) The conformance suite passes on pgvector.

  The shipped defaults stay off until the Phase 7 regression.
- **D-29:** Rollout order inside the phase:
  1. tokenizer, `lexical_text` and backfill;
  2. SQL RPC with grants and the anon-refusal tests;
  3. `RetrievalBackend` and the pgvector adapter, with the conformance suite;
  4. v2 stages: search, fuse and dedupe;
  5. reranker interface, providers, fakes and recorded responses;
  6. assembly ordering, budget and compression;
  7. refusal stage and calibration tooling;
  8. retrieval sweep;
  9. selective-filter work;
  10. the translation seam;
  11. parent-child tables and `expand_parents`;
  12. chunking profiles, the Config UI and the chunking sweep;
  13. golden additions and re-baseline;
  14. the final v2 comparison.

### Claude's Discretion
- File layout inside `src/lib/rag/` beyond the paths named above.
- Exact stopword lists and the code-token regex (rules stored as data).
- Exact SQL shape (CTEs, the exact-scan mechanism, the profile routing of the dense leg) once Phase 3's embedding storage is known.
- Wording of the trace reasons and the Config UI labels and warnings.
- The minimum text length for compression, and the sentence splitter.

### Decision index
These are the IDs the plans cite. Each entry summarizes a decision recorded above.
- **D-01:** `RetrievalBackend { id, search(req) -> {dense, lexical}, health, isReady(scope) }`; req takes TenantScope, embeddingProfileId, denseVector, lexicalTokens, filters (currentOnly fixed), limits, signal; tenant derived only from scope (fits RET-06/RET-09) (costly)
- **D-02:** RRF fusion in TS for every backend (k=60, equal weights, chunk-ID tie-break); no native backend fusion
- **D-03:** backend-agnostic conformance suite in tests/rag/backend-conformance/ parametrized by factory; zh exact-term, filters, current-only, two-tenant, selective filter, legs shape, ties
- **D-04:** `hybrid_search_chunks` as a supabase/migrations/ file mirrored into both setup files (Phase 3 D-05); both legs in one call; dense leg routed by profile storage (legacy column or chunk_embeddings halfvec cast); simple-config tsvector over lexical_text with GIN; is_current AND status ready; tokens as text[]; SECURITY INVOKER, revoked from PUBLIC/anon/authenticated, granted to service_role, called via admin client; tenant via p_tenant_key on the tenant_key column (tested equal to the workspace predicate); raises on a malformed or wrong-mode key (one-way)
- **D-05:** DATA-08 filters (date range, sources, documentIds, docTypes, languages, is_current) in both legs' WHERE; from temporal analyzer, documentRefs and a Zod-validated retrievalFilters body field; narrow only; no new UI
- **D-06:** RAG_HNSW_ITERATIVE_SCAN off|relaxed_order|strict_order (default off) and RAG_EXACT_SCAN_CUTOFF (default 0) with bounded count; tested on PGlite pgvector 0.8.7; selective_filter reported off/on
- **D-07:** shared tokenizer src/lib/rag/lexical/tokenize.ts (created by Phase 3 D-32, completed here with a LEXICAL_VERSION bump): NFKC + lowercase, codes kept whole plus parts, zh Intl.Segmenter words + Han bigrams, en/it diacritic fold + Italian elision split, no stemming, data stopwords, versioned; ICU startup check; PGroonga rejected (costly)
- **D-08:** Phase 3 creates and fills lexical_text; Phase 4 adds the tsvector, the GIN index and lexical_version, plus `rag:relex`, a resumable dry-run rebuild from stored chunk columns with zero parser/embedding calls (also for pre-Phase-3 chunks); no second column
- **D-09:** Reranker interface (id, model, scoreSemantics, rerank -> index + raw score); fetch adapters for Cohere (v5.0 pro/fast) and Voyage (rerank-3 / rerank-3-lite, rerank-2.5 per-language fallback via RAG_RERANK_VOYAGE_MODEL_BY_LANG); local_bm25 rebuilt on the shared tokenizer, normalized, relative
- **D-10:** RAG_RERANK_TIER_CHAT=quality, RAG_RERANK_TIER_VOICE=fast; rerank timeouts chat/embed 600 ms, voice 250 ms, eval none
- **D-11:** rerank failure -> skipped, fused order, degraded, refusal off (not_applied/reranker_unavailable); reranker none -> disabled, no refusal
- **D-12:** RetrievalParams (pool, cap 50..100, top-k, rrfK, weights) in eval/config/retrieval-params.json written by the sweep; start pool 75 / cap 75 / top-k 8; eval-only per-request overrides
- **D-13:** variants searched in parallel (Promise.all, shared signal), one RPC round trip each; RRF; dedupe by chunk and parent ID; cap before rerank; counts in span
- **D-14:** `rag_eval.sweep retrieval` grid on dev split; smallest config within noise of best; writes params + report; fixtures with fake rerankers
- **D-15:** v2 assembly extends assembleContext: merge adjacent same-document chunks, best-at-edges ordering behind RAG_CONTEXT_EDGE_ORDER, tiktoken budget RAG_CONTEXT_TOKEN_BUDGET (6000); format, links, source_images, {{context}} unchanged; legacy byte-identity kept
- **D-16:** RAG_CONTEXT_COMPRESSION extractive only (provider spans or local sentence scoring); never tables, images or short chunks; off = unchanged context
- **D-17:** eval/config/refusal-thresholds.json (Pydantic RefusalThresholds) keyed by (provider, model, query_language, same|cross) with metrics, counts, hashes; only `calibrated` cells applied; others never refuse; invalidated on model or tokenizer change (costly)
- **D-18:** `rag_eval.calibrate refusal`: fit on dev to max correct-refusal at false-refusal <= target (0.05), holdout check on frozen test split, minimum counts else insufficient_data; cross vs same-language comparison reported
- **D-19:** refusal stage behind RAG_REFUSAL_THRESHOLD; refuse -> status empty, reason below_threshold, refusal record; existing per-entry mappings unchanged; eval trace keeps candidates
- **D-20:** document_parents table (tenant columns, RLS like chunks, server-role writes); children keep parent_id + chunking_profile_id; only children indexed; expand_parents stage behind RAG_PARENT_CHILD with one in() fetch, once per parent, counted in budget (one-way)
- **D-21:** chunking_profiles table with per-doc-type active pointer and activate/rollback SQL functions; ProcessingProfile.parent_child is the seed only; `legacy` profile = today; side-by-side re-chunk from stored parse output/parse cache with zero parser calls and dual-write; activation completeness and eval gates; documents without stored parse output listed for a budgeted re-ingest; evals in the Phase 3 `ingest` fixture mode; admin routes /api/rag/admin/chunking-profiles; presets 128/512, 256/1024 default, 256/2048, custom; Pydantic rules with JS parity test; authenticated Config UI panel; `rag_eval.sweep chunking` report per doc type/language/question kind; decision recorded in eval/decisions/
- **D-22:** queryVariants seam with a translate stage; RAG_LEXICAL_TRANSLATION uses a fixture translation table now, the XLG-01 translator in Phase 6; lexical leg and local_bm25 use the document-language variant; hosted rerankers get the original
- **D-23:** new env vars (lexical, reranker, tiers, Voyage per-language model, Cohere key and base URL (the Voyage key is reused from Phase 3), refusal, edge order, compression, token budget, parent-child, iterative scan, exact cutoff, translation) in five places and env-manifest; v2 with everything off = dense-only through the new RPC
- **D-24:** v2 stages analyze, translate, embed, search, exact_id_lookup (Phase 3 stage, as a third RRF list), fuse, dedupe, rerank, refusal, expand_parents, assemble, compress; core embed/search/fuse; names = stage_latency_ms keys and spans; RetrievalResult gains refusal and retrievalConfigHash
- **D-25:** voice under v2: same graph, fast tier, 250 ms rerank timeout, smaller budget, no compression, no voice_keyword_fallback; wire contract and source_images hold; rerank budgets added (chat p95 600 ms, voice 250 ms), report-only; injected-delay test keeps voice under 800 ms p95
- **D-26:** golden additions after parity: selective_filter category (>= 4/language), >= 8 no_answer per language incl. near-misses, clause/exception items; re-baseline with zero paired diffs on old items; by_doc_type and by_question_kind reports (costly)
- **D-27:** deterministic fake reranker (embedder cosine + overlap, per-language offsets, latency/failure injection); recorded Cohere/Voyage responses under tests/fixtures/rerank/; no live calls
- **D-28:** completion: legacy paired diffs zero; recommended v2 config within noise on every slice for Recall@k/MRR with correct refusal improved; per-switch on/off comparisons; conformance on pgvector; shipped defaults stay off
- **D-29:** rollout order: tokenizer/backfill, SQL + grants, backend + conformance, search/fuse/dedupe, rerankers, assembly, refusal + calibration, sweep, selective filter, translation seam, parent-child, chunking profiles + UI + sweep, golden additions, final comparison

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and requirements
- `.planning/ROADMAP.md` §"Phase 4: Hybrid Retrieval, Reranking & Calibrated Refusal": goal, the ten success criteria, live verification, and the rules for every phase (baseline, switch, auth, no live services).
- `.planning/REQUIREMENTS.md`: RET-01 to RET-04 and RET-10, DATA-08, RNK-01 to RNK-06, CHK-03 to CHK-05, LAT-01, LAT-02, XLG-03. Also read for constraints: RET-06 and RET-09 (interface fit), DATA-02, DATA-09, EMB-02, EMB-03, EMB-05, CHK-01, CHK-02, XLG-01, XLG-02, OBS-01, OBS-02, CACHE-01. The mapping notes cover RET-01 to RET-03 and DATA-08.
- `.planning/PROJECT.md` §Constraints and §Key Decisions: pgvector kept permanently as the default, top-two-per-layer switchable providers, Supabase as the source of truth, config sync, no secrets.

### Prior phase decisions
- `.planning/phases/01-evaluation-harness-baseline/01-CONTEXT.md`: PGlite fixture edge, eval endpoint contract, noise band, gate slices, the dev/test split (70/30 by hash), span matching, judge.
- `.planning/phases/02-unified-retrieval-pipeline-tenant-scope/02-CONTEXT.md`, including "Adjustments after research". D-01 to D-05 are the pipeline, stage runner and status; D-07 is `TenantScope`; D-14 is the boundary check; D-16 and D-17 are assembly; D-19 to D-21 are tracing and budgets; D-25 is the golden-addition pattern.
- `.planning/phases/02-unified-retrieval-pipeline-tenant-scope/02-07-PLAN.md` (the `src/lib/rag/` skeleton, `backend/supabase-rpc.ts`, `RetrievalBackendError`, `RagDeps`), `02-08-PLAN.md` (stage runner, a stage `disabled` by config, `[RAG Trace]`), `02-09-PLAN.md` (`assembleContext`), `02-20-PLAN.md` (boundary check) and `02-24-PLAN.md` (latency budgets file).
- `.planning/phases/03-unified-ingestion-embedding-profiles/03-CONTEXT.md`. Phase 4 consumes:
  - D-05: migrations convention;
  - D-07 and D-08: promoted chunk columns, `tenant_key`, the current and ready filter;
  - D-13: `ProcessingProfile.parent_child`;
  - D-18: stored originals and parse output;
  - D-22: `cl100k_base`;
  - D-27: invoice columns;
  - D-28: `exact_id_lookup`;
  - D-32: the tokenizer seam;
  - D-33 to D-37: embedding providers, the registry, `chunk_embeddings` and the mismatch check;
  - D-38 to D-40: the re-embed job and the activation gate patterns;
  - D-42: fixture modes;
  - D-44 and D-45: env vars and the admin route pattern.

### Specs and research
- `.planning/specs/ingestion-routing.md` §"Parse cache": the CHK-05 sweep and re-chunking reuse it with zero parser calls.
- `.planning/specs/semantic-cache.md`: the retrieval-config hash in the cache key (D-24 seam).
- `.planning/specs/query-rewrite-gate.md`: the Phase 6 translator and rewrite rules that later fill the D-22 variants slot.
- `.planning/research/ARCHITECTURE.md`: interface sketches (`RetrievalBackend`, `Reranker`), Pattern 5 (shared lexical normalization), schema changes, latency budgets.
- `.planning/research/STACK.md` §4 and §5: pgvector hybrid shape, Weaviate and Qdrant hybrid and tenancy notes (the D-01 fit), rerank APIs and score semantics.
- `.planning/research/PITFALLS.md`: Pitfall 2 (failures turned into refusals), 4 (latency), 8 (Chinese lexical), 10 (threshold calibration), 12 (golden overfitting).
- `.planning/research/SUMMARY.md` §"Phase 5: Hybrid retrieval, rerank, context, abstention" (the research numbering, which is this roadmap's Phase 4).

### Code
- `supabase/single-tenant-setup.sql` and `supabase/multi-tenant-setup.sql`: `document_chunks`, the HNSW index, `match_documents_by_workspace` (around L692) and its `anon` grant (L736), which is not repeated.
- `src/lib/reranker-local.ts` (`hybridRerank`, BM25 helpers): re-homed in Phase 2 to `src/lib/rag/rerank/local-hybrid.ts`, and the basis of `local_bm25`.
- `src/app/api/chat/route.ts` (the `ragMode` strict/balanced/flexible/bypass mapping), `src/app/api/embed/chat/route.ts`, `src/app/api/internal/voice-rag/route.ts`, `src/app/api/internal/rag/run/route.ts`.
- `eval/harness/pglite-supabase.mts`, `eval/harness/fake-edge.mts`, `eval/harness/two-tenant.mts`, `eval/harness/fixture-embedder.mts`, `eval/fixtures/golden.jsonl`, `eval/config/noise.json`.
- `rag-sidecar/src/rag_sidecar/contracts/golden.py` (`Category`) and `eval_run.py` (`RagTrace.stage_latency_ms`), plus the `npm run gen:schemas` pipeline.
- `scripts/rag/env-manifest.json`, `scripts/check-config.mjs`, `scripts/config-server.js`, `scripts/config-ui/index.html`, `scripts/init-env.js`, `src/lib/env.ts`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 2 `src/lib/rag/` (being built now): `runRetrieval`, the stage runner (`runStage`, `deriveStatus`, a stage `disabled` by config), `RagDeps` injection, the trace collector and `[RAG Trace]`, `assembleContext()`, the `TenantScope` brand and `tenantPredicate` / `workspaceRpcArgs`, and `RetrievalBackendError`. v2 stages plug into the same runner.
- Phase 1 eval stack:
  - the PGlite fixture edge, with pgvector 0.8.7 bundled, so `hnsw.iterative_scan` is testable;
  - the fixture embedder;
  - the two-tenant fixture;
  - the gate, the noise band and paired differences (Phase 2 D-23);
  - the eval endpoint's per-request overrides, which the sweeps use.
- `src/lib/reranker-local.ts` `hybridRerank`, `bm25Rerank` and `keywordBoostRerank`. Their tokenization is whitespace or word-boundary, which is wrong for Chinese, so `local_bm25` replaces it.
- `tiktoken` is already a dependency (the token budget). `Intl.Segmenter` ships in Node 22 with full ICU.

### Established Patterns
- Zod through `zod/v3`; Pydantic as the source, with generated Zod checked in CI; bracketed log prefixes (`[Document Search]`, `[RAG Trace]`, `[RAG Config]`); env read through `src/lib/env.ts`; provider switches in the style of `USE_REPLICATE_PROVIDER`.
- Legacy RPCs run on the anon client (Phase 2 P-18). v2 is the first retrieval path on the admin client, through a server-only function. The tenant is enforced by function arguments from `TenantScope`, because `service_role` bypasses RLS.
- Golden-set changes always follow a parity proof and a re-baseline with zero paired differences on the old items.

### Integration Points
- `src/lib/rag/` (v2 pipeline, `backend/`, `lexical/`, `rerank/`, `fusion/`, `context/`, `refusal/`); both Supabase setup SQL files plus an upgrade script; the Phase 3 chunk writer (tokenizer call, parent and child writes); the eval endpoint (v2 overrides); `eval/src/rag_eval/` (`sweep`, `calibrate`, new report slices); the Config UI and config-server (chunking profiles panel); the five config locations.

</code_context>

<specifics>
## Specific Ideas

- Cross-tenant safety is still the top risk. The new RPC runs as `service_role`, so the function arguments are the only tenant guard. It must raise an exception on inconsistent scope arguments, and every leg must be covered by the two-tenant conformance case.
- A refusal must never come from a missing score (Pitfall 2 and Pitfall 10). Only calibrated cells refuse.
- No live keys, Supabase project or Docker daemon here. The real Cohere and Voyage calibration, the sweep, the comparison of `rerank-3` with `rerank-2.5` on the zh and it slices, and the hosted SQL migration are the ROADMAP live verification items.

</specifics>

<deferred>
## Deferred Ideas

- A chat UI for picking retrieval filters (date, type, language): a new capability, for a later phase or the backlog. Phase 4 accepts filters only through the validated request field.
- Stemming for en and it in the shared tokenizer, only if the eval shows those slices need it.
- MMR diversity after rerank (mentioned in research): not in the Phase 4 requirements; backlog.
- Removing the legacy voice keyword and image heuristics completely, once v2 becomes the default (Phase 7 defaults decision).
- Per-tenant chunking-profile pointers. Phase 4 is per document type at deployment level.
- A true BM25 scorer in SQL (Postgres `ts_rank_cd` is not BM25): only if the eval shows the lexical leg's ranking limits recall.

</deferred>

---

*Phase: 04-hybrid-retrieval-reranking-calibrated-refusal*
*Context gathered: 2026-11-23*
