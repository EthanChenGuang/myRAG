# Phase 4: Hybrid Retrieval, Reranking & Calibrated Refusal - Research

**Researched:** 2026-11-23
**Domain:** pgvector hybrid search (dense + lexical, RRF in TypeScript), hosted rerank APIs (Cohere, Voyage), context assembly, score-threshold refusal, parent-child chunking profiles
**Confidence:** MEDIUM overall. HIGH for the SQL, pgvector, tokenizer and harness findings. The core of Pattern 1 was re-executed in this session on PGlite 0.5.17 (PostgreSQL 18.7, pgvector 0.8.7) against the real `multi-tenant-setup.sql` with the two-tenant fixture. HIGH for the Phase 2 contracts, which were read at HEAD. MEDIUM for vendor API shapes (official docs re-fetched this session, no live key). LOW for vendor latency (no primary source found).

**Revision note:** a first draft of this file was cut off by a rate limit. This revision keeps its executed findings, re-grounds it on the Phase 2 code now in `src/lib/rag/` (17 of 36 Phase 2 plans done), corrects stale statements, adds findings F-12 to F-24, and adds "Decisions that need adjusting" (D-01 to D-29).

<user_constraints>
## User Constraints (from CONTEXT.md)

The full text of every decision is in `04-CONTEXT.md` and stays authoritative. The entries below are that file's own "Decision index", "Claude's Discretion" and "Deferred Ideas" sections, copied verbatim.

### Locked Decisions
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

### Claude's Discretion
- File layout inside `src/lib/rag/` beyond the paths named above.
- Exact stopword lists and the code-token regex (rules stored as data).
- Exact SQL shape (CTEs, the exact-scan mechanism, the profile routing of the dense leg) once Phase 3's embedding storage is known.
- Wording of the trace reasons and the Config UI labels and warnings.
- The minimum text length for compression, and the sentence splitter.

### Deferred Ideas (OUT OF SCOPE)
- A chat UI for picking retrieval filters (date, type, language): a new capability, for a later phase or the backlog. Phase 4 accepts filters only through the validated request field.
- Stemming for en and it in the shared tokenizer, only if the eval shows those slices need it.
- MMR diversity after rerank (mentioned in research): not in the Phase 4 requirements; backlog.
- Removing the legacy voice keyword and image heuristics completely, once v2 becomes the default (Phase 7 defaults decision).
- Per-tenant chunking-profile pointers. Phase 4 is per document type at deployment level.
- A true BM25 scorer in SQL (Postgres `ts_rank_cd` is not BM25): only if the eval shows the lexical leg's ranking limits recall.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (from REQUIREMENTS.md, shortened) | Research support |
|----|-----------------------------------------------|------------------|
| RET-01 | Backends switchable behind one `RetrievalBackend` that only accepts a `TenantScope` | Pattern 2 (types and pgvector adapter), conformance suite design |
| RET-02 | Hybrid retrieval (lexical + vector, filters before search), fused with RRF | Pattern 1 (SQL, executed), Pattern 3 (RRF) |
| RET-03 | One shared application tokenizer writing `lexical_text`; Chinese exact-term test | Pattern 4 (tokenizer), finding F-1, probe: 9 of 9 exact-term items at lexical rank 1 |
| RET-04 | Hybrid function callable only by the server role | Pattern 1 grants (executed: `42501` for anon and authenticated), Pattern 9 (shim and fake-edge roles) |
| RET-10 | Selective filters lose nothing: `hnsw.iterative_scan` plus exact-scan cutoff | Pattern 1 (`dense_mode`), findings F-6, pitfalls P-1, P-2, P-3 |
| DATA-08 | Filter by date range, source, document, type, language | Pattern 1 filter parameters, finding F-4 |
| RNK-01 | Cohere `rerank-v5.0-pro`/`-fast`, Voyage `rerank-3` (+ `rerank-2.5`), local BM25, on an enlarged pool | Verified model IDs and endpoints, Pattern 5 (adapters), finding F-7 |
| RNK-02 | Pool size and top-k chosen by an eval sweep | Pattern 8 (sweep), Validation map |
| RNK-03 | Best chunks at the edges, adjacent chunks merged, token budget | Pattern 6 |
| RNK-04 | Compression behind a switch | Cohere `relevant_spans` (verified shape), local sentence scoring, pitfall P-11 |
| RNK-05 | Refusal below a threshold calibrated per provider and language on dev, checked on holdout | Pattern 7 (gate and calibration), findings F-3, F-5 |
| RNK-06 | Reranker timeout or failure: fused order, refusal off | Pattern 5 (stage rules), finding F-8 |
| CHK-03 | Parent-child retrieval behind `RAG_PARENT_CHILD` | Pattern 10 |
| CHK-04 | Parent-child sizes configurable per doc type, validated, built side by side, pointer flip | Pattern 10, finding F-11 |
| CHK-05 | Chunk-size sweep report, decision recorded | Pattern 8, Pattern 10 |
| LAT-01 | Paths in parallel, dedupe before rerank, capped rerank input | Pattern 3, Latency Budget |
| LAT-02 | Fast and quality rerank tiers per entry point | Pattern 5 (tier resolution), Latency Budget |
| XLG-03 | Cross-language via lexical path and local BM25 with translated query; cross-lingual calibration | Pattern 3 (variants), Pattern 7 (cells), finding F-5 |
</phase_requirements>

## Summary

Phase 4 builds on code that is only partly in the tree. The Phase 2 core is there: `src/lib/rag/` holds `pipeline.ts` (stage runner, `deriveStatus`), `config.ts`, `types.ts`, `deps.ts`, `context/assemble.ts`, `context/fetch-rows.ts`, `tenant/*`, `backend/supabase-rpc.ts` and `trace/*`. That is 17 of 36 Phase 2 plans (02-01 to 02-10, 02-15, 02-30 to 02-35). No route calls `runRetrieval` yet: the eval, chat and voice routes still import `enhancedRetrieveChunks` from `@/lib/enhanced-rag-retrieval` [VERIFIED: `.planning/STATE.md`; `ls -R src/lib/rag`; grep of `src/app/api/internal/rag/run/route.ts:5`, `src/app/api/chat/route.ts:18`, this session]. Phase 3 has a context, a research file and a patterns file but no plans, so none of its columns, tables or the `lexical/tokenize.ts` module exist yet. Each Phase 4 plan must name the Phase 2 or Phase 3 plan that creates what it extends (see "Upstream dependencies").

The vendor facts in RNK-01 hold. Cohere's model page lists `rerank-v5.0-pro` and `rerank-v5.0-fast`, and Voyage's reranker page lists `rerank-3` and `rerank-3-lite` as current with `rerank-2.5` as an older model [CITED: docs.cohere.com/docs/models, docs.voyageai.com/docs/reranker]. Two details differ from what the decisions assume: Voyage evaluates `rerank-3` on its multilingual set and reports it ahead of `rerank-2.5` there, so "2.5 as the multilingual fallback" is a comparison to run, not a known weakness of 3; and neither vendor publishes latency, so the 600 ms and 250 ms timeouts are unproven.

The central engineering result is a working `hybrid_search_chunks` function, executed here against the real `multi-tenant-setup.sql` and `single-tenant-setup.sql` with Phase 3's columns simulated. It returns both legs in one call, isolates the two-tenant fixture on both legs, refuses `anon` and `authenticated`, raises on a malformed or wrong-mode tenant key, routes the dense leg to the legacy column or a `halfvec` profile, and switches to an exact scan under a cutoff. Building it exposed four things the locked decisions need: (1) `to_tsvector('simple', lexical_text)` re-tokenizes the application's tokens, so a whole code such as `xr-2000` is never matched; (2) adding a stored generated column rewrites `document_chunks` and rebuilds its HNSW index; (3) the default `hnsw.ef_search` of 40 silently caps a 75-row dense leg at 40 rows; (4) a `halfvec(n)` cast and a partial-index predicate both need dynamic SQL. Each has a tested fix below.

**Primary recommendation:** Implement the lexical index as a trigger-maintained `tsvector` built by an immutable `rag_lexical_tsvector()` that takes the application's tokens verbatim (no Postgres parser), search it through the dynamic-SQL `hybrid_search_chunks` shown in Pattern 1, fuse in TypeScript, call Cohere and Voyage with plain `fetch` (no new packages), and let only rerankers with calibrated score semantics drive threshold refusal.

### Findings that need an orchestrator decision

None of these reopens a decision's intent. Each one contradicts a detail in `04-CONTEXT.md` or adds something the decision needs to work.

| # | Finding | Evidence | Recommended adjustment |
|---|---------|----------|------------------------|
| F-1 | D-04's expression `to_tsvector('simple', lexical_text)` runs the Postgres parser over tokens the application already produced. The parser splits `xr-2000` into `xr` and `-2000`, so the whole-code token D-07 requires is never stored and a verbatim `tsquery` finds nothing | PGlite this session: `to_tsvector('simple','… xr-2000 …')` gives `'-2000':6 … 'xr':5,7`; `WHERE tsv_parser @@ '''xr-2000'''::tsquery` returned `[]`, while the verbatim column returned row 1. The parser's idea of a letter also depends on the database `lc_ctype` [CITED: postgresql.org/docs/current/textsearch-parsers.html] | Keep the intent (no stemming, no Postgres stopwords, GIN, `ts_rank_cd`). Build the vector with `rag_lexical_tsvector(lexical_text)`, an immutable SQL function that turns each space-separated token into one lexeme with its position, and build the query with `rag_lexical_tsquery(text[])`. Both are in Pattern 1 and were executed |
| F-2 | D-04 says "stored generated tsvector". Adding a `GENERATED … STORED` column rewrites the table and rebuilds every index, including the HNSW index | PGlite: `relfilenode` of the table, its primary key and its HNSW index all changed after `ADD COLUMN … GENERATED ALWAYS AS (…) STORED`; a plain nullable `ADD COLUMN` changed none | Use a plain `lexical_tsv tsvector` column kept in step by a `BEFORE INSERT OR UPDATE OF lexical_text` trigger (executed). The effect is the same and the migration is instant. If the orchestrator keeps the generated column, schedule the rewrite in a quiet window |
| F-3 | `local_bm25` is `relative` and normalized over the candidate pool (D-09), so its top score is about 1.0 whenever anything matches. A threshold on that score cannot separate answerable from unanswerable questions | Follows from D-09's definition; D-17 keys cells by provider and D-28(b) allows `local_bm25` with refusal on | The refusal gate applies only when `scoreSemantics === 'calibrated'`. A `relative` reranker records `refusal: not_applied / relative_scores`. D-28(b)'s refusal comparison uses the fake quality reranker, and `local_bm25` is compared with refusal off |
| F-4 | D-05(a) takes a date range from "the existing temporal analyzer", but that analyzer returns a free-text `timeframe`, and it describes the period a question is about, not the document's date. Legacy rows will have `doc_date` NULL | `src/lib/temporal-query-detector.ts:8-19`: `timeframe: string \| null;`. Legacy code only boosts on it: `requireTemporalMatch = process.env.RAG_TEMPORAL_MATCHING === 'true'` (`src/lib/enhanced-rag-retrieval.ts:53`) | Add a pure `timeframeToDateRange()`. Apply the derived range as a hard filter only when the existing `RAG_TEMPORAL_MATCHING` is `true` (default `false`); otherwise record it in the trace as derived but not applied. Explicit `retrievalFilters.dateRange` always applies. Rows with NULL `doc_date` are excluded by an explicit range and kept by a derived one (`p_date_keep_null`) |
| F-5 | D-17 and D-18 leave three things open: what the holdout check must show to pass, whether the minimum counts apply to the holdout, and how a no-answer item (which has no evidence language) lands in a `same` or `cross` cell. The frozen test split is also Phase 7's regression split | `gate_split: Literal["dev"]` (`eval_run.py:117`); baseline dev split holds 9 no-answer items in total, 3 per language [VERIFIED: `eval/baselines/fixture-baseline.json`, `category:no_answer` n = 9, `language:*` correct_refusal n = 3] | See ambiguity A-2. Calibration may read the test split only for a one-shot pass/fail check; the pass rule, holdout minimums and the pairing rule are fixed in `refusal-calibration.json` before the first run |
| F-6 | Success criterion 10 says filtered retrieval "returns the same top-k as an unfiltered exact search". Iterative scan is still approximate, and the 71-chunk fixture never uses the HNSW index, so the fixture eval would show identical numbers with the switch off and on | PGlite, 2,000 rows at 1,536 dims, 2.5% tenant, index forced: `off` 0 rows, `relaxed_order` 10 of 10, `strict_order` 9 of 10 against the exact answer. Fixture plan: `Seq Scan on document_chunks` | Assert equality only on the exact-cutoff path. For iterative scan assert the row count and a recall floor. Run both on a dedicated synthetic database with the index forced (Pattern 9); keep it at 600 rows or fewer |
| F-7 | D-09 and RNK-01 call `rerank-2.5` "the multilingual fallback". Voyage reports `rerank-3` ahead of `rerank-2.5` on its 51 multilingual datasets and calls `rerank-2.5` an older model | [CITED: blog.voyageai.com/2026/09/30/rerank-3/, docs.voyageai.com/docs/reranker] | Keep `RAG_RERANK_VOYAGE_MODEL_BY_LANG` exactly as decided, default empty. Describe it in the Config UI and docs as "per-language model override decided by eval", not as a fallback. The live zh and it comparison still decides |
| F-8 | The rerank timeouts (600 ms chat, 250 ms voice) are not backed by any vendor latency figure. If the real p95 is above them, rerank is skipped on most requests and threshold refusal is silently off (D-11) | No latency in Cohere or Voyage docs; secondary sources disagree by an order of magnitude | Keep the timeouts. Add a `rerank_skipped_rate` line to eval reports and the trace, and a live-verification rule: if p95 for 75 documents exceeds the timeout, lower `rerankInputCap` toward 50 or move chat to the fast tier, and record the choice |
| F-9 | The fixture embedder is itself lexical (hashed n-grams), so the dense leg already finds every exact-term item, and the legacy baseline refuses 32% of answerable items | Probe: 9 of 9 `exact_term` items at dense rank 1 and lexical rank 1. Baseline `overall` `false_refusal_rate` mean 0.3191, `correct_refusal_rate` mean 0.3333 | Conformance cases assert on `legs.lexical`, not on the fused list. Record a `v2-all-off` run as the reference for D-28(c). Say in the report that fixture gains over legacy mostly come from dropping the legacy 0.65 post-filter |
| F-10 | Under v2 the lexical leg replaces `voice_keyword_fallback`, which matches `metadata->>'name'` and `metadata->>'image_context'`. A `lexical_text` built from section path and content alone loses those matches for image chunks | `src/app/api/internal/voice-rag/route.ts` L137-246 (ILIKE on `image_context`, `name`, `content`) | For `chunk_kind = 'image'` (or `metadata ? 'image_url'`) the lexical text also includes the document filename, `metadata.name` and `metadata.image_context`. This is part of the `LEXICAL_VERSION` bump |
| F-11 | With the starting values (top-k 8, budget 6,000) the default preset 256/1024 breaks CHK-04's own warning rule: 8 × 1,024 = 8,192 tokens | Arithmetic on D-12, D-15, D-21 | Expected and fine: the panel shows the warning, and the chunking sweep reports context tokens. Do not raise the default budget to silence it |

### Ambiguities and their resolutions

`04-CONTEXT.md` has no enumerated list of ambiguities. These are the open choices found in it (items it hands to the researcher, items under Claude's Discretion, and gaps met while prototyping).

| # | Ambiguity | Resolution |
|---|-----------|------------|
| A-1 | RNK-01 model IDs and endpoints | All five exist. Cohere: `POST https://api.cohere.com/v2/rerank` with `rerank-v5.0-pro` / `rerank-v5.0-fast`. Voyage: `POST https://api.voyageai.com/v1/rerank` with `rerank-3` / `rerank-3-lite` / `rerank-2.5`. Use the IDs as decided. See Verified External Facts |
| A-2 | May calibration read the frozen test split? | Yes, read-only, for the one holdout check D-18 locks, under five rules: (1) the fit function receives only dev items, proven by a test that poisons every test-split score and asserts identical thresholds; (2) the holdout step emits aggregates only (counts and rates per cell), never per-item scores; (3) each cell records `holdout_evaluations` and the input hashes, and a re-run with unchanged inputs is a no-op; (4) a failed cell is never re-fitted against the test split, it simply does not refuse; (5) the target, the minimums and the pass rule are committed before the first run. The Phase 7 regression report must state that thresholds were screened on the same split |
| A-3 | Holdout pass rule and minimum counts | Dev minimums are D-18's (3 no-answer, 5 answerable on fixtures; 10 and 20 on the real set). Holdout minimums are separate and smaller: 1 and 2 on fixtures, 3 and 6 on the real set. Pass when `false_refusal_test <= target + max(noise.floor, 1 / n_test_answerable)`. Record the exact one-sided binomial p-value next to it as information |
| A-4 | Cell pairing for no-answer items; query language | `pairing` is decided at run time from the top reranked candidate's `language` column, for answerable and no-answer items alike, because that is what the gate sees. `query_language` comes from one `detectQueryLanguage()` (script ratio, then zh/en/it stopword scores from the tokenizer's data file) used in production and in calibration; a test reports its agreement with the golden `language` field |
| A-5 | Is the AI SDK `rerank()` worth a dependency? | No. `ai@6.0.3` already exports `rerank` [VERIFIED: `node_modules/ai/dist/index.d.ts` L5272], but using it needs `@ai-sdk/cohere` and a Voyage provider package, defaults to two retries, and does not expose Cohere's `relevant_spans`. Two fetch adapters of about 60 lines each cover everything and take recorded fixtures directly |
| A-6 | `SET LOCAL` or a function-level setting (D-06) | `PERFORM set_config('hnsw.iterative_scan', p_iterative_scan, true)` inside the function, with the value passed as a validated argument. A function-level `SET` clause is static and cannot follow an env var. Executed: the setting is back to `off` after the call |
| A-7 | `lexical_version`: column or metadata key (D-08) | A column, `lexical_version integer`. The backfill needs `WHERE lexical_version IS DISTINCT FROM $1` on an index-friendly column, and Phase 3's research leaves `lexical_text` NULL for legacy rows without defining a metadata key |
| A-8 | Does the Voyage per-language override apply to the fast tier? | No. The override replaces the quality-tier model only. The fast tier is always `rerank-3-lite` (LAT-02 names it). Accepted override values: `rerank-3`, `rerank-2.5` |
| A-9 | Voice token budget ("its profile's smaller default", D-15) | 2,000 tokens, a code default in the voice profile, not a new env var [ASSUMED: sized for a spoken answer] |
| A-10 | Compression minimum length and sentence splitter | `Intl.Segmenter(lang, { granularity: 'sentence' })` (executed for zh, en and it). Never compress a chunk under 150 tokens [ASSUMED], a table or image chunk, or a chunk that was merged from a parent |
| A-11 | Which text goes to the reranker | `section_path.join(' > ') + '\n' + content`, with the legacy `Document: X. Chunk n of m. Content:` prefix stripped. Version it (`RERANK_TEXT_VERSION`) and put the version in the config hash, because thresholds depend on it |
| A-12 | What the retrieval-config hash covers (D-24) | D-24's list plus `RERANK_TEXT_VERSION` and the `config_hash` of `refusal-thresholds.json`, because both change answers |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Tokenizing chunks and queries | API / Backend (`src/lib/rag/lexical/`) | — | RET-03: one application tokenizer; the database stores its output and never tokenizes |
| Filtered dense and lexical search | Database / Storage (`hybrid_search_chunks`) | API / Backend (adapter) | Filters and the tenant predicate must run before ranking, next to the indexes |
| Tenant enforcement for v2 | Database / Storage (function arguments, raises) | API / Backend (`TenantScope` brand) | `service_role` bypasses RLS, so the function is the last guard |
| Fusion, dedupe, capping | API / Backend (`fusion/`) | — | D-02: same code for every backend |
| Reranking | API / Backend (`rerank/`), external Cohere and Voyage | — | HTTP calls are confined to one directory by the boundary check |
| Refusal decision | API / Backend (`refusal/`) | Committed config (`eval/config/`) | Thresholds are data produced by tooling, read at build time |
| Context assembly, compression | API / Backend (`context/`) | — | Pure functions over reranked candidates |
| Parent fetch | Database / Storage (RPC) | API / Backend (`parents/`) | Same tenant rule as search |
| Chunking profiles (table, pointer, activate, rollback) | Database / Storage | API / Backend (admin routes), Config UI | Pointer flips must be transactional |
| Sweeps and calibration | Eval tooling (Python, `eval/src/rag_eval/`) | App eval endpoint | The tools drive the real pipeline through the authenticated eval endpoint |
| Config UI panel | Browser (config dashboard) | API / Backend (`/api/rag/admin/chunking-profiles`) | Validation rules are defined once in Pydantic; the JS copy is parity-tested |

## Standard Stack

No new runtime package is needed. Every version below is what is installed or locked in this repository.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js | 22.23.5 here; `^22.12.0` required | Runtime, `Intl.Segmenter`, `AbortSignal.any` | ICU 78.3, full data (`icu_small: false`) [VERIFIED: `process.versions`, this session] |
| `@supabase/supabase-js` | 2.76.1 | `.rpc('hybrid_search_chunks')` through the admin client | Already the data client [VERIFIED: node_modules] |
| `tiktoken` | 1.0.22 | `cl100k_base` token budget | Already a dependency; Phase 3 D-22 uses the same encoding [VERIFIED: node_modules] |
| `zod` | 3.25.76, imported as `zod/v3` | Request and config validation, generated from Pydantic | Project convention [VERIFIED: node_modules] |
| `pydantic` | 2.14.4 | `RetrievalParams`, `RefusalThresholds`, `ChunkingProfile`, `RetrievalFilters` | Project rule: Pydantic is the contract source [VERIFIED: `eval/uv.lock`] |
| PostgreSQL + pgvector | Supabase: PG 15 or 17 with pgvector up to 0.8.2 packaged; PGlite: PG 18.7 with 0.8.7 | Storage, HNSW, full-text | [VERIFIED: `nix/ext/versions.json` in supabase/postgres; `select version()` in PGlite] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@electric-sql/pglite` | 0.5.17 | In-process Postgres for SQL, grant and conformance tests | Every DB-backed test |
| `@electric-sql/pglite-pgvector` | 0.0.18 | pgvector 0.8.7 in PGlite | Same |
| `vitest` | 5.1.1 | Unit and PGlite-backed tests (`tests/**/*.test.ts`) | Default test runner |
| `tsx` | 4.23.15 | `node --import tsx --test` for `.test.mts`, CLI entry for `rag:relex` | Harness-level tests and scripts |
| `pytest` | 9.2.0 | Sweep, calibration and contract tests | `eval/tests`, `rag-sidecar/tests` |
| Python stdlib (`math.comb`, `random`, `json`, `hashlib`) | Python `>=3.12,<3.13` (project pin) | Threshold sweep, binomial tail, grid sweep | No numpy or scipy import in `rag_eval` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `fetch` adapters | AI SDK `rerank()` + `@ai-sdk/cohere` + a Voyage provider | Two more packages, default retries that fight a 250 ms budget, no `relevant_spans`. Rejected (A-5, D-09) |
| `Intl.Segmenter` | `jieba-wasm` or `nodejieba` [ASSUMED: package names from training data, not verified or recommended] | Better new-word coverage is plausible but unmeasured; adds a dictionary download or a native build. D-07 locks `Intl.Segmenter`; Han bigrams cover the segmentation mismatches |
| Verbatim `tsvector` builder | `to_tsvector('simple', …)` with parser-safe tokens (join `xr-2000` into `xr2000`) | Keeps D-04's literal expression but ties the shared tokenizer's alphabet to the Postgres parser and to `lc_ctype`. Fallback only |
| `ts_rank_cd` | `ts_rank`, or a true BM25 | On the dev fixture both gave the same hit counts with stopwords on (Pattern 4). BM25 in SQL is deferred by CONTEXT |

**Installation:** none.

```bash
# verify, do not install
node -e "console.log(process.versions.node, process.versions.icu, process.config.variables.icu_small)"
node -e "for (const p of ['tiktoken','zod','@supabase/supabase-js','@electric-sql/pglite','@electric-sql/pglite-pgvector']) console.log(p, require('./node_modules/'+p+'/package.json').version)"
```

## Package Legitimacy Audit

This phase installs no external package, so the gate has nothing to check.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| (none) | — | — | — | — | — | No install |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

If a later plan decides to add a package after all (for example a segmenter), it must run `gsd-tools query package-legitimacy check` first and gate the install behind a `checkpoint:human-verify` task.

## Verified External Facts

### Cohere Rerank
- Models: `rerank-v5.0-pro`, `rerank-v5.0-fast` (current, 32k context), `rerank-v4.0-pro`, `rerank-v4.0-fast`, `rerank-v3.5`, `rerank-english-v3.0`, `rerank-multilingual-v3.0`. The page says of the v4 models: "For new projects, we recommend using `rerank-v5.0-pro`". The v5 entries name multilingual support, "Context Focus" and calibrated relevance scores. [CITED: docs.cohere.com/docs/models]
- Endpoint: `POST https://api.cohere.com/v2/rerank`, header `Authorization: Bearer <token>`. Body: `model`, `query`, `documents` (strings), optional `top_n` (default: all results), `max_tokens_per_doc` (default `4096`, longer documents are truncated), `priority`, and `relevant_spans` `{ mode: 'enabled' | 'disabled', threshold (default 0.1), max_spans }`, "Supported only for Rerank v5 and newer models". [CITED: docs.cohere.com/reference/rerank]
- Response: `results[]` with `index`, `relevance_score` (0 to 1) and optional `relevant_spans[]` of `{ start, end, score }`, where positions are **Unicode codepoints** and `end` is exclusive; `id`; `meta.billed_units`; `meta.warnings`. Errors: 400, 401, 403, 404, 422, 429, 498, 499, 500, 501, 503, 504. [CITED: docs.cohere.com/reference/rerank]
- Limits for v5: up to 10,000 documents per request; 32,768 tokens shared by query and document. Score guidance: "The score is query dependent", and scores are not ratios. Cohere's own threshold procedure is to score 30 to 50 borderline pairs and use the average as a reference. [CITED: docs.cohere.com/docs/reranking-best-practices]
- Languages: "trained for performance across 100+ languages"; the table includes `zh` Chinese and `it` Italian. [CITED: docs.cohere.com/docs/rerank-overview]
- Pricing: cohere.com/pricing still defines a search unit as "one query with up to 100 documents" and gives no v5 price. Secondary sources say v5 is billed per token, $0.05 per million for pro and $0.02 for fast. [CITED: cohere.com/pricing] for the unit; the per-token figures are LOW confidence. Read `meta.billed_units` from the first live response.
- Latency: no official figure. Secondary reports range from 0.36 s p50 on a gateway to several seconds for 96 long documents. No observation worth planning on.

### Voyage rerank
- Models: `rerank-3` ("Highest accuracy", recommended for most applications) and `rerank-3-lite` (latency-sensitive), both 32,000-token context; older: `rerank-2.5`, `rerank-2.5-lite`, `rerank-2`, `rerank-2-lite`, `rerank-1`, `rerank-lite-1`. Limits for the 3 and 2.5 series: query up to 8,000 tokens, query plus one document up to 32,000, total (query tokens × documents + document tokens) up to 600K, at most 1,000 documents. [CITED: docs.voyageai.com/docs/reranker]
- Endpoint: `POST https://api.voyageai.com/v1/rerank`, header `Authorization: Bearer $VOYAGE_API_KEY`. Body: `query`, `documents`, `model`, `top_k` (default null: all), `return_documents` (default false), `truncation` (default true). Raw HTTP response: `{ object: 'list', data: [{ index, relevance_score, document? }], model, usage: { total_tokens } }`. The list key is `data`; the docs page that shows `results` describes the Python SDK object. The OpenAPI page still lists only the 2.5 series and older; the reranker guide is newer. [CITED: docs.voyageai.com/reference/reranker-api]
- `rerank-3`: "Both models retain the instruction-following capability introduced in Rerank 2.5"; "Relevance scores are calibrated to match the score distributions of the corresponding Rerank 2.5 models"; on "51 datasets from 31 languages" `rerank-3` is ahead of `rerank-2.5` by 0.52%; "We will continue to offer the rerank-2.5 series". The post does not name Chinese or Italian. [CITED: blog.voyageai.com/2026/09/30/rerank-3/]
- Pricing: $0.05 per million tokens for `rerank-3` and `rerank-2.5`, $0.02 for the lite models; tokens are counted as query tokens × documents + document tokens. [CITED: docs.voyageai.com/docs/pricing]. At 75 chunks of about 512 tokens and a 20-token query that is about 40K tokens, or $0.002 per chat query on `rerank-3`.
- Latency: none published.

### pgvector
- Iterative scans exist "Starting with 0.8.0": `hnsw.iterative_scan = strict_order | relaxed_order` (off by default), bounded by `hnsw.max_scan_tuples` (20,000) and `hnsw.scan_mem_multiplier` (1). With relaxed ordering, re-sort through a materialized CTE and `ORDER BY distance + 0` ("`+ 0` is needed for Postgres 17+"). "Results are limited by the size of the dynamic candidate list (`hnsw.ef_search`), which is 40 by default." HNSW index limits: `vector` 2,000 dimensions, `halfvec` 4,000. The filtering section recommends a btree on the filter column first: "Exact indexes work well for conditions that match a low percentage of rows." [CITED: github.com/pgvector/pgvector README at v0.8.7]
- Executed here (PGlite, pgvector 0.8.7):
  - `show hnsw.iterative_scan` is `off`; `relaxed_order` and `strict_order` are accepted; another value fails with `invalid value for parameter "hnsw.iterative_scan"`.
  - `LIMIT 75` with the default `ef_search` returned 40 rows; with `ef_search = 100` it returned 75.
  - With a `halfvec` partial expression index, a literal `profile_id` uses `Index Scan using ce_hnsw_p32`; a parameter under a generic plan falls back to `Seq Scan` + `Sort`. `'[1,2]'::vector::halfvec($1)` fails with `type modifiers must be simple constants or identifiers`.
  - With a btree on `tenant_key` and fresh statistics the planner chose `Index Scan using ch_tk` + `Sort` (exact) for a 2% tenant and the HNSW index for a 98% tenant.
- Supabase packages pgvector 0.4.0, 0.5.1, 0.6.0, 0.6.2, 0.7.0, 0.7.4, 0.8.0 and 0.8.2 for PostgreSQL 15 and 17. [VERIFIED: `nix/ext/versions.json`, supabase/postgres `develop`, fetched this session]. Supabase's HNSW guide documents iterative scans from 0.8.0 and the check `SELECT * FROM pg_extension WHERE extname = 'vector';`. [CITED: supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes]. Which version the user's project runs: no observation.

### PostgreSQL full-text search
- `ts_rank_cd` "requires lexeme positional information… If there are no unstripped lexemes in the input, the result will be zero". "The ranking functions do not use any global information" (so no IDF). "Ranking can be expensive since it requires consulting the `tsvector` of each matching document". [CITED: postgresql.org/docs/current/textsearch-controls.html]
- "At present PostgreSQL provides just one built-in parser"; "The parser's notion of a 'letter' is determined by the database's locale setting, specifically `lc_ctype`". [CITED: postgresql.org/docs/current/textsearch-parsers.html]
- Executed here: `array_to_tsvector` gives `ts_rank_cd = 0` (no positions); the positional builder in Pattern 1 gives non-zero ranks; a lexeme over 2,047 bytes fails with `word is too long`; `tsv @@ NULL::tsquery` matches nothing.

### Other
- RRF: Cormack, Clarke and Büttcher, "Reciprocal rank fusion outperforms Condorcet and individual rank learning methods", SIGIR 2009; score is the sum of `1 / (k + rank)`, with `k = 60` fixed in a pilot and reported as not critical. [CITED: plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf]
- Lost in the middle: Liu et al., TACL 2024 (vol. 12, pp. 157-173): accuracy is highest when the relevant passage is at the start or end of the context and drops in the middle. [CITED: aclanthology.org/2024.tacl-1.9]
- Threshold selection: selective classification picks a confidence threshold on a labeled sample to meet a target risk and reports the risk-coverage trade-off (Geifman and El-Yaniv, NeurIPS 2017). [CITED: arxiv.org/abs/1705.08500]. No RAG-specific source was found; D-18's rule is the same idea with false refusal as the risk.
- `Intl.Segmenter` leaves the algorithm to the implementation, and ICU's Chinese segmentation is dictionary based, so results can change between ICU versions. No published comparison with jieba was found. [CITED: github.com/tc39/proposal-intl-segmenter/issues/133]

## Architecture Patterns

### System Architecture Diagram

```text
 chat / embed / voice-rag / eval route
        |  TenantScope (branded), query, profile, retrievalFilters?
        v
 runRetrieval (RAG_PIPELINE=v2)
        |
   [analyze] -- query language, temporal timeframe, filters (explicit > derived)
        |
   [translate]* -- queryVariants: original (+ translated, fixture table in Phase 4)
        |
   [embed] -- one batch call for all variants -----------------> embedding provider
        |
   [search] -- Promise.all, one RPC per variant ---------------> hybrid_search_chunks
        |          returns rows tagged leg + rank                  |- validate tenant key, mode, profile, dims
        |                                                          |- dense leg: ANN (ef_search, iterative scan)
        |                                                          |             or exact scan under the cutoff
   [exact_id_lookup]* -- third ranked list                         |- lexical leg: lexical_tsv @@ tsquery, ts_rank_cd
        |                                                          '- both: tenant_key, is_current, status, filters
   [fuse] -- RRF k=60 over every list, tie -> chunk id
        |
   [dedupe] -- by chunk id, by parent id when on; cut to rerankInputCap
        |
   [rerank]* -- cohere | voyage | local_bm25 | none ------------> Cohere / Voyage (fetch, timeout, no retry)
        |        fail / timeout -> keep fused order, degraded
        v
   [refusal]* -- calibrated cell? top score < threshold? --yes--> status empty (below_threshold)
        | no / not applied                                        candidates kept in the eval trace only
        v
   [expand_parents]* -- one RPC, same tenant rule
        |
   [assemble] -- merge adjacent, pick by rank within token budget, edge order*
        |
   [compress]* -- provider spans or local sentence scoring
        v
   RetrievalResult { status, context, usedDocuments, sourceImages, refusal, retrievalConfigHash, stages }

   * optional stage: skipped on failure or when its switch is off
```

### Recommended Project Structure
```
src/lib/rag/
├── backend/            # types.ts (RetrievalBackend, RankedHit, RetrievalFilters), pgvector.ts, registry.ts
├── lexical/            # tokenize.ts (LEXICAL_VERSION), rules.json (stopwords, elisions, code regex), relex.ts, icu-check.ts
├── fusion/             # rrf.ts, dedupe.ts
├── rerank/             # types.ts, cohere.ts, voyage.ts, local-bm25.ts, select.ts (tier -> model), text.ts
├── refusal/            # gate.ts, thresholds.ts (static import + Zod)
├── context/            # assemble.ts (extended), merge-adjacent.ts, edge-order.ts, budget.ts, compress.ts
├── parents/            # expand.ts
├── chunking/           # profiles.ts, validate.ts
├── query/              # variants.ts, detect-language.ts, timeframe.ts, translate-fixture.ts
├── config/             # retrieval-params.ts (static import + Zod), config-hash.ts
└── v2/                 # pipeline.ts (stage graph), profiles.ts (per-profile timeouts and budgets)
supabase/migrations/    # 0401…0405 (after Phase 3's 03xx files)
rag-sidecar/src/rag_sidecar/contracts/retrieval.py   # RetrievalParams, RefusalThresholds, RefusalCalibrationConfig, ChunkingProfile, RetrievalFilters
eval/src/rag_eval/      # sweep/ (retrieval.py, chunking.py), calibrate/ (refusal.py)
eval/config/            # retrieval-params.json, refusal-thresholds.json, refusal-calibration.json
tests/rag/backend-conformance/   # cases.ts (no .test suffix) + pgvector.test.ts
tests/fixtures/rerank/           # recorded Cohere and Voyage responses
```

Read `eval/config/*.json` with a static `import` (the root `tsconfig.json` has `resolveJsonModule: true`) and validate with the generated Zod schema at module load. A runtime `fs.readFile` of a path that nothing imports is not traced into the Vercel function bundle [ASSUMED: Next.js output file tracing].

### Pattern 1: `hybrid_search_chunks` (executed)

**What:** one `SECURITY INVOKER` function, dynamic SQL, both legs, all guards inside the database.
**When to use:** the only search path of the pgvector adapter.
**Status:** this exact text ran in PGlite against `multi-tenant-setup.sql` with the two-tenant fixture and against `single-tenant-setup.sql` with the 71-chunk corpus. Phase 3's columns were added by a stand-in `ALTER TABLE`; the names `tenant_key`, `is_current`, `status = 'ready'`, `doc_type`, `doc_date`, `language`, `source`, `lexical_text`, `chunk_index` and the `embedding_profiles.storage` values `legacy_column | halfvec` come from `03-CONTEXT.md` D-07, D-08 and D-36 and are not in the tree yet.

```sql
-- Source: executed in PGlite (PostgreSQL 18.7, pgvector 0.8.7) this session
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS lexical_tsv tsvector,
                            ADD COLUMN IF NOT EXISTS lexical_version integer;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsvector(p_lexical_text text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT coalesce(string_agg(quote_literal(t.tok) || ':' || least(t.ord, 16383)::text, ' ' ORDER BY t.ord), '')::tsvector
  FROM unnest(string_to_array(coalesce(p_lexical_text, ''), ' ')) WITH ORDINALITY AS t(tok, ord)
  WHERE t.tok <> '' AND octet_length(t.tok) <= 255 AND t.tok !~ '[''\\[:space:]]'
$fn$;

CREATE OR REPLACE FUNCTION public.rag_lexical_tsquery(p_tokens text[]) RETURNS tsquery
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT string_agg(quote_literal(t.tok), ' | ')::tsquery
  FROM (SELECT DISTINCT tok FROM unnest(coalesce(p_tokens, '{}'::text[])) AS u(tok)
        WHERE tok <> '' AND octet_length(tok) <= 255 AND tok !~ '[''\\[:space:]]' LIMIT 64) AS t
$fn$;

CREATE OR REPLACE FUNCTION public.rag_chunks_lexical_tsv() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
BEGIN NEW.lexical_tsv := public.rag_lexical_tsvector(NEW.lexical_text); RETURN NEW; END $fn$;
DROP TRIGGER IF EXISTS trg_document_chunks_lexical_tsv ON document_chunks;
CREATE TRIGGER trg_document_chunks_lexical_tsv BEFORE INSERT OR UPDATE OF lexical_text ON document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.rag_chunks_lexical_tsv();
CREATE INDEX IF NOT EXISTS idx_document_chunks_lexical_tsv ON document_chunks USING gin (lexical_tsv);

CREATE OR REPLACE FUNCTION public.hybrid_search_chunks(
  p_tenant_key text, p_profile_id text, p_query_embedding vector, p_lexical_tokens text[],
  p_dense_limit integer, p_lexical_limit integer,
  p_date_from date DEFAULT NULL, p_date_to date DEFAULT NULL, p_sources text[] DEFAULT NULL,
  p_document_ids uuid[] DEFAULT NULL, p_doc_types text[] DEFAULT NULL, p_languages text[] DEFAULT NULL,
  p_iterative_scan text DEFAULT 'off', p_exact_scan_cutoff integer DEFAULT 0
) RETURNS TABLE (
  leg text, rank integer, chunk_id uuid, document_id uuid, content text, metadata jsonb, chunk_index integer,
  similarity double precision, lexical_score real, doc_type text, language text,
  document_filename text, document_created_at timestamptz, document_metadata jsonb, document_content_preview text,
  dense_mode text
) LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_multi boolean := to_regclass('public.organization_members') IS NOT NULL;
  v_dims integer; v_storage text; v_status text;
  v_tsq tsquery; v_n integer; v_mode text := 'ann';
  v_filter text; v_from text; v_vec text; v_sel text;
BEGIN
  IF p_tenant_key IS NULL OR p_tenant_key !~ '^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'hybrid_search_chunks: malformed tenant key' USING ERRCODE = '22023';
  END IF;
  IF v_multi = (p_tenant_key = 's:default') THEN
    RAISE EXCEPTION 'hybrid_search_chunks: tenant key not valid for this deployment mode' USING ERRCODE = '22023';
  END IF;
  IF p_dense_limit NOT BETWEEN 0 AND 200 OR p_lexical_limit NOT BETWEEN 0 AND 200 OR p_exact_scan_cutoff NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'hybrid_search_chunks: limit out of range' USING ERRCODE = '22023';
  END IF;
  IF p_iterative_scan NOT IN ('off', 'relaxed_order', 'strict_order') THEN
    RAISE EXCEPTION 'hybrid_search_chunks: invalid iterative scan mode' USING ERRCODE = '22023';
  END IF;
  SELECT e.dims, e.storage, e.status INTO v_dims, v_storage, v_status FROM embedding_profiles e WHERE e.id = p_profile_id;
  IF v_dims IS NULL OR v_storage NOT IN ('legacy_column', 'halfvec') THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: unknown profile' USING ERRCODE = '22023';
  END IF;
  IF p_dense_limit > 0 AND (p_query_embedding IS NULL OR vector_dims(p_query_embedding) <> v_dims) THEN
    RAISE EXCEPTION 'embedding_profile_mismatch: dims' USING ERRCODE = '22000';
  END IF;

  v_filter := ' c.tenant_key = $2 AND c.is_current AND c.status = ''ready'''
    || ' AND ($3::date IS NULL OR c.doc_date >= $3) AND ($4::date IS NULL OR c.doc_date <= $4)'
    || ' AND ($5::text[] IS NULL OR c.source = ANY($5)) AND ($6::uuid[] IS NULL OR c.document_id = ANY($6))'
    || ' AND ($7::text[] IS NULL OR c.doc_type = ANY($7)) AND ($8::text[] IS NULL OR c.language = ANY($8)) ';
  v_sel := ' c.id, c.document_id, c.content, c.metadata, c.chunk_index, %s, %s, c.doc_type, c.language,'
    || ' d.filename, d.created_at, d.metadata, left(d.content, 200), %L::text ';

  IF p_dense_limit > 0 THEN
    IF v_storage = 'legacy_column' THEN
      v_from := ' document_chunks c '; v_vec := format('c.embedding <=> $1::vector(%s)', v_dims);
      v_filter := v_filter || ' AND c.embedding IS NOT NULL ';
    ELSE
      v_from := format(' chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id AND e.profile_id = %L ', p_profile_id);
      v_vec := format('(e.embedding::halfvec(%1$s)) <=> $1::halfvec(%1$s)', v_dims);
    END IF;
    IF p_exact_scan_cutoff > 0 THEN
      EXECUTE 'SELECT count(*) FROM (SELECT 1 FROM ' || v_from || ' WHERE ' || v_filter || ' LIMIT $9) s'
        INTO v_n USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages, p_exact_scan_cutoff + 1;
      IF v_n <= p_exact_scan_cutoff THEN v_mode := 'exact'; END IF;
    END IF;
    IF v_mode = 'ann' THEN
      PERFORM set_config('hnsw.ef_search', least(greatest(p_dense_limit * 2, 100), 1000)::text, true);
      IF p_iterative_scan <> 'off' THEN PERFORM set_config('hnsw.iterative_scan', p_iterative_scan, true); END IF;
    END IF;
    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ' || v_vec || ' AS dist FROM ' || v_from || ' WHERE ' || v_filter
      || CASE WHEN v_mode = 'exact' THEN ') ' ELSE ' ORDER BY ' || v_vec || ' LIMIT $9) ' END
      || ', top AS (SELECT hid, dist, (row_number() OVER (ORDER BY dist + 0, hid))::integer AS rnk FROM hits ORDER BY dist + 0, hid LIMIT $9) '
      || 'SELECT ''dense''::text, t.rnk, ' || format(v_sel, '(1 - t.dist)::double precision', 'NULL::real', v_mode)
      || ' FROM top t JOIN document_chunks c ON c.id = t.hid JOIN documents d ON d.id = c.document_id ORDER BY t.rnk'
      USING p_query_embedding, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages, p_dense_limit;
  END IF;

  v_tsq := public.rag_lexical_tsquery(p_lexical_tokens);
  IF p_lexical_limit > 0 AND v_tsq IS NOT NULL THEN
    v_filter := replace(v_filter, ' AND c.embedding IS NOT NULL ', '');
    RETURN QUERY EXECUTE
      'WITH hits AS MATERIALIZED (SELECT c.id AS hid, ts_rank_cd(c.lexical_tsv, $1, 1) AS score FROM document_chunks c WHERE ' || v_filter
      || ' AND c.lexical_tsv @@ $1 ORDER BY score DESC, c.id LIMIT $9) '
      || 'SELECT ''lexical''::text, (row_number() OVER (ORDER BY t.score DESC, t.hid))::integer, '
      || format(v_sel, CASE WHEN v_storage = 'legacy_column' AND p_query_embedding IS NOT NULL
                            THEN format('(1 - (c.embedding <=> $10::vector(%s)))::double precision', v_dims)
                            ELSE 'NULL::double precision' END, 't.score', 'n/a')
      || ' FROM hits t JOIN document_chunks c ON c.id = t.hid JOIN documents d ON d.id = c.document_id ORDER BY t.score DESC, t.hid'
      USING v_tsq, p_tenant_key, p_date_from, p_date_to, p_sources, p_document_ids, p_doc_types, p_languages, p_lexical_limit, p_query_embedding;
  END IF;
END $fn$;

REVOKE ALL ON FUNCTION public.hybrid_search_chunks(text, text, vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hybrid_search_chunks(text, text, vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer)
  TO service_role;
```

Observed results:

| Case | Result |
|------|--------|
| Tenants A (personal), B (personal), O (organization), same canary phrase | Each call returned only its own chunk on the dense leg and on the lexical leg |
| `halfvec` profile | Same hit through `chunk_embeddings`; `similarity` on the lexical leg is NULL for that storage |
| `p_exact_scan_cutoff => 100` | `dense_mode = 'exact'`, same top hit |
| `p_document_ids` naming another tenant's document | No rows (filters only narrow) |
| Tenant key `u:<uuid>' OR '1'='1`, NULL, or `s:default` in multi-tenant mode, or `u:<uuid>` in single-tenant mode | `22023` raised |
| 3-dimension vector, unknown profile | `22000` `embedding_profile_mismatch: dims`, `22023` unknown profile |
| Empty token array | Dense leg only |
| Tokens containing quotes, `&`, `!`, `:*`, `drop table` | Ignored or matched as plain lexemes; no error, no injection |
| Chunk set to `status = 'quarantined'` | Gone from both legs |
| `SET LOCAL ROLE anon`, `authenticated` | `42501 permission denied for function hybrid_search_chunks` |
| `SET LOCAL ROLE service_role` (with `BYPASSRLS`) | Rows returned |
| GUCs after the call | `hnsw.ef_search = 40`, `hnsw.iterative_scan = off` again |
| `p_dense_limit = 0`, NULL vector | Lexical leg only |

Notes for the planner:
- **Why dynamic SQL everywhere.** The `halfvec(n)` typmod cannot be a parameter, the partial index is only used when `profile_id` is a literal, and `EXECUTE … USING` plans each call with the actual filter values, so a NULL filter folds away and a small tenant gets the btree plan.
- **`%1$s` and `%L`.** `v_dims` is an integer read from `embedding_profiles`; `p_profile_id` is quoted with `%L` after it was matched against that table. No caller text is ever concatenated.
- **Tenant equality test (D-04).** Compare the function's result set with `match_documents_by_workspace` on the two-tenant fixture for `(null, userA)`, `(null, userB)` and `(orgO, userA)`.
- **Additions not executed here** (small, same shape): `p_date_keep_null boolean` for F-4; `p_lexical_languages text[]` applied to the lexical leg only, for translated variants (D-22); a version guard that raises `iterative_scan_unsupported` when `p_iterative_scan <> 'off'` and `extversion < 0.8.0`; the DATA-09 invoice filters as a join on `documents` promoted columns; filtering children by the active chunking profile (Pattern 10). Each needs its own test.
- **Mode check.** `to_regclass('public.organization_members')` is NULL in the single-tenant schema [VERIFIED: no `organization` table in `supabase/single-tenant-setup.sql`]. Phase 3's research detects the mode through `documents.user_id`; use whichever helper Phase 3 ships, once.
- **Volatility.** Leave the function `VOLATILE` (the default). It calls `set_config`.
- **Older Postgres.** Supabase runs 15 or 17. Nothing above needs a newer feature. `dist + 0` is required from 17 on and harmless on 15.

### Pattern 2: `RetrievalBackend` and the pgvector adapter

```typescript
// src/lib/rag/backend/types.ts — sketch; D-01 names are locked
export interface RetrievalFilters {
  dateRange?: { from?: string; to?: string; keepUndated?: boolean };
  sources?: string[]; documentIds?: string[]; docTypes?: string[]; languages?: string[];
  readonly currentOnly: true;
}
export interface RankedHit {
  rank: number;                      // 1-based within its leg
  chunkId: string; documentId: string;
  content: string; metadata: Record<string, unknown>; chunkIndex: number | null;
  similarity: number | null; lexicalScore: number | null;
  docType: string | null; language: string | null;
  document: { filename: string; createdAt: string | null; metadata: Record<string, unknown>; contentPreview: string };
}
export interface BackendSearchRequest {
  scope: TenantScope; embeddingProfileId: string;
  denseVector: number[] | null; lexicalTokens: string[];
  filters: RetrievalFilters; denseLimit: number; lexicalLimit: number; signal: AbortSignal;
}
export interface BackendLegs { dense: RankedHit[]; lexical: RankedHit[]; meta?: { denseMode: 'ann' | 'exact' | null } }
export interface RetrievalBackend {
  id: 'pgvector' | 'weaviate' | 'qdrant';
  search(req: BackendSearchRequest): Promise<BackendLegs>;
  health(): Promise<BackendHealth>;
  isReady(scope: TenantScope): Promise<boolean>;
}
```

```typescript
// src/lib/rag/backend/pgvector.ts — sketch
export function createPgvectorBackend(deps: { adminClient: SupabaseClient; env: RagEnv }): RetrievalBackend {
  return {
    id: 'pgvector',
    async search(req) {
      assertTenantScope(req.scope);                              // runtime brand check (Phase 2 D-07)
      const { data, error } = await deps.adminClient
        .rpc('hybrid_search_chunks', {
          p_tenant_key: req.scope.tenantKey,                     // the only tenant input
          p_profile_id: req.embeddingProfileId,
          p_query_embedding: req.denseVector,
          p_lexical_tokens: req.lexicalTokens,
          p_dense_limit: req.denseVector ? req.denseLimit : 0,
          p_lexical_limit: req.lexicalLimit,
          p_date_from: req.filters.dateRange?.from ?? null, p_date_to: req.filters.dateRange?.to ?? null,
          p_sources: req.filters.sources ?? null, p_document_ids: req.filters.documentIds ?? null,
          p_doc_types: req.filters.docTypes ?? null, p_languages: req.filters.languages ?? null,
          p_iterative_scan: deps.env.RAG_HNSW_ITERATIVE_SCAN, p_exact_scan_cutoff: deps.env.RAG_EXACT_SCAN_CUTOFF,
        })
        .abortSignal(req.signal);
      req.signal.throwIfAborted();                               // postgrest resolves on abort (Phase 2 research)
      if (error) throw new RetrievalBackendError('hybrid_search_chunks', error.code);
      return splitLegs(data);                                    // group by leg, keep SQL rank order
    },
    async health() { /* cheap select 1 through the admin client */ },
    async isReady() { return true; },                            // RET-09 seam
  };
}
```

The empty-array filter must mean "no filter" in TypeScript (send `null`), because `= ANY('{}')` matches nothing. The conformance suite has a case for it.

### Pattern 3: RRF, variants, dedupe, cap

```typescript
// src/lib/rag/fusion/rrf.ts — sketch
export interface RankedList { id: string; weight: number; hits: { chunkId: string; rank: number }[] }
export function rrf(lists: RankedList[], k = 60): { chunkId: string; score: number; ranks: Record<string, number> }[] {
  const acc = new Map<string, { score: number; ranks: Record<string, number> }>();
  for (const list of lists) {                                    // fixed list order => deterministic float sums
    for (const hit of list.hits) {
      const e = acc.get(hit.chunkId) ?? { score: 0, ranks: {} };
      e.score += list.weight / (k + hit.rank);
      e.ranks[list.id] = hit.rank;
      acc.set(hit.chunkId, e);
    }
  }
  return [...acc.entries()]
    .map(([chunkId, e]) => ({ chunkId, ...e }))
    .sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
}
```

- Lists: for each variant `dense:<i>` and `lexical:<i>`, plus `exact_id` when that stage ran. Weights and `k` come from `retrieval-params.json`.
- Search: `await Promise.all(variants.map((v) => backend.search({ …, signal })))`. All calls share the request signal; embed the variants in one batch call first.
- Translated variants restrict the lexical leg to their own language (`p_lexical_languages`); the original variant does not, so a code typed in a Chinese question still matches an English document.
- Dedupe keeps the best fused entry per chunk id and, with `RAG_PARENT_CHILD=true`, per `parent_id`. Then cut to `rerankInputCap`. The span records `candidates_in`, `deduped`, `rerank_input`, `capped_from`.
- With `RAG_LEXICAL_SEARCH=false`, pass an empty token array: one leg, RRF over one list, which equals the dense order (D-23).

### Pattern 4: Shared tokenizer

Executed observations for `Intl.Segmenter('zh', { granularity: 'word' })` on Node 22.23.5 / ICU 78.3:

| Input | Word-like segments |
|-------|--------------------|
| `王小明` | `王`, `小明` |
| `请问王小明先生负责什么` | `请问`, `王`, `小明`, `先生`, `负责`, `什么` |
| `型号XR-2000/A_v2.1的保修期` | `型号`, `XR`, `2000`, `A_v2.1`, `的`, `保`, `修`, `期` |
| `ＸＲ－２０００` (full width, no NFKC) | `ＸＲ`, `２０００` |
| `l'azienda dell'anno perché società` | `l'azienda`, `dell'anno`, `perché`, `società` |
| `统一社会信用代码91310000MA1FL0XX0T` | `统一`, `社会`, `信用`, `代码`, `91310000MA1FL0XX0T` |

So codes must be extracted before segmentation, NFKC must run first, elisions need an explicit rule, and a word such as `保修期` can fall apart into single characters, which is what the Han bigrams are for. Cost: 0.011 ms per query and 0.76 ms per 1,000-character chunk.

Order of operations (rules as data in `lexical/rules.json`):
1. NFKC; map `’` and `‘` to `'`; lowercase.
2. Latin diacritic fold: NFD, strip `\p{M}`, NFC.
3. Codes: for each match of `[a-z0-9]+(?:[-_./][a-z0-9]+)+` that contains a digit, emit the whole match and the joined form (`xr-2000` and `xr2000`). The parts come from step 5.
4. Elisions: strip the prefixes in the data list (`l'`, `un'`, `dell'`, `nell'`, `sull'`, `all'`, `dall'`, `quell'`, `d'`, `c'`, `s'`, … and English `'s`).
5. `Intl.Segmenter('zh', { granularity: 'word' })`, word-like segments only.
6. For each maximal Han run, split on single-character stopwords, then emit overlapping bigrams (a unigram for a one-character run).
7. Drop stopwords (zh, en, it lists), single Latin letters, and tokens over 64 characters.
8. Index side: keep order and duplicates, join with one space. Query side: dedupe, keep at most 64 tokens.

The token alphabet excludes quote, backslash and whitespace by construction, which is what `rag_lexical_tsvector` relies on; the SQL also filters defensively.

Dev-split probe with a stand-in of this tokenizer on the 47 answerable dev items (lexical leg alone, top 10; this measures the leg, it does not choose anything):

| Tokenizer variant | Ranking | en hit@10, MRR | it | zh |
|-------------------|---------|----------------|----|----|
| words + bigrams + stopwords | `ts_rank_cd(…, 1)` | 18/18, 0.80 | 12/13, 0.79 | 15/16, 0.91 |
| words + bigrams + stopwords | `ts_rank(…, 1)` | 18/18, 0.80 | 12/13, 0.79 | 15/16, 0.91 |
| words + bigrams, no stopwords | `ts_rank_cd(…, 1)` | 16/18, 0.56 | 11/13, 0.75 | 15/16, 0.91 |
| words + bigrams, no stopwords | `ts_rank(…, 1)` | 17/18, 0.75 | 12/13, 0.78 | 15/16, 0.91 |
| words only + stopwords | `ts_rank_cd(…, 1)` | 18/18, 0.80 | 12/13, 0.79 | 15/16, 0.90 |

Reading: with `ts_rank_cd` the stopword list is load-bearing (no IDF), so it must be tested, versioned data. Normalization flag `1` (divide by 1 + log of document length) is the recommended setting. Fixture questions share vocabulary with their documents, so these numbers flatter the lexical leg.

### Pattern 5: Reranker interface, adapters and stage rules

```typescript
// src/lib/rag/rerank/types.ts — sketch; D-09 names are locked
export interface RerankInput { query: string; documents: string[] }
export interface RerankScore { index: number; score: number; spans?: { start: number; end: number; score: number }[] }
export interface Reranker {
  id: 'cohere' | 'voyage' | 'local_bm25';
  model: string;
  scoreSemantics: 'calibrated' | 'relative';
  rerank(query: string, docs: string[], opts: { topN?: number; timeoutMs?: number; signal: AbortSignal; wantSpans?: boolean }):
    Promise<{ scores: RerankScore[]; usage?: Record<string, number> }>;
}
```

```typescript
// src/lib/rag/rerank/cohere.ts — sketch against the documented v2 shape
const CohereResponse = z.object({
  results: z.array(z.object({
    index: z.number().int().nonnegative(),
    relevance_score: z.number().finite(),
    relevant_spans: z.array(z.object({ start: z.number().int(), end: z.number().int(), score: z.number() })).optional(),
  })),
  meta: z.object({ billed_units: z.record(z.number()).optional() }).passthrough().optional(),
}).passthrough();

export function createCohereReranker(deps: { fetch: typeof fetch; apiKey: string; baseUrl: string; model: string }): Reranker {
  return {
    id: 'cohere', model: deps.model, scoreSemantics: 'calibrated',
    async rerank(query, docs, { timeoutMs, signal, wantSpans }) {
      const res = await deps.fetch(`${deps.baseUrl}/v2/rerank`, {
        method: 'POST',
        headers: { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: deps.model, query, documents: docs,            // no top_n: every input must come back with a score
          ...(wantSpans ? { relevant_spans: { mode: 'enabled' } } : {}),
        }),
        signal: timeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal,
      });
      if (!res.ok) throw new RerankError('cohere', res.status);  // status only; never the body or the key
      const body = CohereResponse.parse(await res.json());
      return { scores: completeScores(docs.length, body.results.map((r) => ({ index: r.index, score: r.relevance_score, spans: r.relevant_spans }))),
               usage: body.meta?.billed_units };
    },
  };
}
```

The Voyage adapter is the same with `POST ${baseUrl}/rerank` (base URL ends in `/v1`, per Phase 3 D-44), body `{ model, query, documents, truncation: true, return_documents: false }`, and a response parsed from `data[]` (`index`, `relevance_score`) plus `usage.total_tokens`.

Rules shared by every adapter and by the stage:
- `completeScores(n, scores)` throws unless every index `0..n-1` appears exactly once with a finite number. A partial or malformed response is a failure, never a low score (D-11, Pitfall 2).
- No retries in the request path. A 429, a 5xx, a timeout or an abort all end the stage as skipped.
- Tier resolution (`select.ts`): chat, embed and eval read `RAG_RERANK_TIER_CHAT`; voice reads `RAG_RERANK_TIER_VOICE`. Cohere: quality `rerank-v5.0-pro`, fast `rerank-v5.0-fast`. Voyage: quality `rerank-3` unless `RAG_RERANK_VOYAGE_MODEL_BY_LANG` names another model for the query language; fast `rerank-3-lite`.
- `local_bm25`: BM25 (k1 1.2, b 0.75) over the pool using the Pattern 4 tokenizer, IDF from the pool, divided by the pool maximum. It uses the variant in the candidate's language when one exists (D-22). Today's `tokenize()` drops every non-ASCII character (`.replace(/[^\w\s]/g, ' ')`, `src/lib/reranker-local.ts:73-79`), so Chinese text currently produces no tokens at all.
- Fake reranker (D-27): a pure function of query and document text: fixture-embedder cosine plus IDF-weighted query-token coverage, with per-language offsets, injected latency and injected failure. It must not read golden data; a test asserts its signature takes only text and options.
- Cohere spans are codepoint offsets. Convert through `Array.from(text)` before slicing a JavaScript string (`'𠮷野家 … 😀'` has length 21 but 19 codepoints, executed).
- Boundary check: add a rule that `api.cohere.com`, `api.voyageai.com` and a `/rerank` fetch may appear only under `src/lib/rag/rerank/` (extends Phase 2 D-14).
- Record `usage` in the rerank span so the first live run shows the real billing unit.

### Pattern 6: Context assembly (extends `assembleContext`)

1. **Merge.** Group reranked candidates by document. Within a document, chunks with consecutive `chunk_index` (or the same `parent_id`) form one block; a block's rank is its best member's rank; members are printed in `chunk_index` order.
2. **Budget.** Walk blocks in rank order, count the rendered block with `tiktoken` `cl100k_base`, and stop adding when the next block would exceed `RAG_CONTEXT_TOKEN_BUDGET`. Always keep the rank-1 block, truncated if it alone is over budget. Selection happens before ordering, so the budget drops the worst blocks, not the middle ones.
3. **Order.** With `RAG_CONTEXT_EDGE_ORDER=true`: odd ranks ascending, then even ranks descending (`1, 3, 5, …, 6, 4, 2`). Otherwise rank order.
4. **Render.** Reuse the Phase 2 block renderer, labels, links section and `source_images` unchanged.

```typescript
// src/lib/rag/context/edge-order.ts
export function edgeOrder<T>(byRank: T[]): T[] {
  const front: T[] = []; const back: T[] = [];
  byRank.forEach((item, i) => (i % 2 === 0 ? front.push(item) : back.unshift(item)));
  return [...front, ...back];
}
```

`tiktoken`: creating the encoder took 107 ms once; counting 15,728 tokens took 19.5 ms (executed). Create it once per process.

Under v2 there is no `post_filter` stage (D-24), so the legacy relevance filter (similarity above 0.65, name match) does not run and only the refusal stage can refuse.

### Pattern 7: Refusal gate and calibration

```typescript
// src/lib/rag/refusal/gate.ts — sketch
export function decideRefusal(i: GateInput): RefusalRecord {
  if (!i.enabled) return na('switch_off');
  if (!i.reranker) return na('reranker_disabled');
  if (i.rerankStage !== 'ok') return na('reranker_unavailable');
  if (i.reranker.scoreSemantics !== 'calibrated') return na('relative_scores');
  if (i.reranked.length === 0) return na('no_candidates');
  const top = i.reranked[0];
  if (!Number.isFinite(top.score)) return na('invalid_score');
  const pairing = top.language && top.language !== i.queryLanguage ? 'cross' : 'same';
  const cell = i.thresholds.find({ provider: i.reranker.id, model: i.reranker.model, queryLanguage: i.queryLanguage, pairing });
  if (!cell || cell.status !== 'calibrated') return na(`cell_${cell?.status ?? 'uncalibrated'}`, cell);
  if (cell.tokenizerVersion !== LEXICAL_VERSION || cell.rerankTextVersion !== RERANK_TEXT_VERSION) return na('cell_stale', cell);
  return { decision: top.score < cell.threshold ? 'refuse' : 'answer', topScore: top.score, threshold: cell.threshold, cell: cell.key };
}
```

```python
# eval/src/rag_eval/calibrate/refusal.py — sketch of the fit; receives dev items only
def fit_threshold(answerable: list[float], no_answer: list[float], target: float) -> FitResult:
    scores = sorted(set(answerable) | set(no_answer))
    candidates = [float("-inf")] + [(a + b) / 2 for a, b in zip(scores, scores[1:])] + [scores[-1] + 1e-9]
    best = None
    for t in candidates:                                   # ascending: the first best is the lowest threshold
        frr = sum(s < t for s in answerable) / len(answerable)
        crr = sum(s < t for s in no_answer) / len(no_answer)
        if frr <= target and (best is None or crr > best.correct_refusal):
            best = FitResult(threshold=t, false_refusal=frr, correct_refusal=crr)
    return best                                            # -inf (never refuse) when nothing better exists
```

Tool flow (`python -m rag_eval.calibrate refusal`):
1. Run the eval endpoint with refusal off for every approved item, collect the top rerank score, the query language and the top candidate's language.
2. Split by `item.split`. Pass only dev rows to `fit_threshold`, per cell. A cell under the dev minimums is `insufficient_data`.
3. Apply each fitted threshold to the cell's test rows. Compute counts and rates only. Under the holdout minimums: `insufficient_data`. Over the pass rule (A-3): `failed_holdout`. Otherwise `calibrated`.
4. Write `refusal-thresholds.json` (cell key, threshold, dev and holdout metrics and counts, status, config hash, tokenizer version, rerank text version, reranker model, `holdout_evaluations`, date) and a Markdown report with the same-versus-cross comparison for XLG-03.

Golden additions must be checked against this: a test computes, per cell, the dev and test counts from a fixture run and fails if a cell the phase needs is short. Because `assign_split` is a pure function of the item id (`eval/src/rag_eval/split.py:11-13`), the author can see the split of a new id before adding it.

### Pattern 8: Sweeps

- `python -m rag_eval.sweep retrieval`: grid pool `25, 50, 75, 100` × top-k `5, 8, 10, 15, 20`, dev items only, through the eval endpoint with eval-only overrides. Set `rerankInputCap = clamp(pool, 50, 100)`. Score each cell by recall of gold spans inside the final top-k, and MRR. Choose the configuration with the fewest context tokens (then lowest latency) whose two scores are within the noise band of the best (`eval/config/noise.json`: `"floor": 0.02`, `"k": 3`). Write `retrieval-params.json` with the numbers, the grid and the config hash.
- `python -m rag_eval.sweep chunking`: one run per candidate profile in the Phase 3 `ingest` fixture mode; report by doc type, language and question kind.
- Both need new fields on the eval request. `RagRunOptions` is `extra="forbid"` and today holds only `max_results`, `organization_id`, `user_id`, `generator_model` (`eval_run.py:15-19`), so add an optional `retrieval_overrides` object (pool, cap, top-k, `rrf_k`, weights, reranker provider, tier, switches, chunking profile) and regenerate the Zod schema. The route accepts it only on the eval endpoint.

### Pattern 9: Test harness changes (Wave 0)

- **Shim roles.** The PGlite shim creates `service_role` as `NOLOGIN` only (`eval/harness/pglite-supabase.mts:30`) and the setup files grant no table privilege on `document_chunks` to it. Mirror Supabase before loading the setup SQL: `ALTER ROLE service_role BYPASSRLS; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;`. Then an `anon` refusal is the function grant speaking (`42501 … for function`), not a missing table grant.
- **Fake edge roles.** The fake edge runs every RPC as the superuser and knows only two RPC names (`eval/harness/fake-edge.mts:26-35`). Map the `apikey` header to a role (anon key → `anon`, service key → `service_role`), run the RPC inside a transaction after `SET LOCAL ROLE`, add `hybrid_search_chunks` with typed arguments (`text[]`, `uuid[]`, `date`), and add fake `/v2/rerank` and `/v1/rerank` endpoints backed by the fake reranker.
- **Selective-filter database.** A separate fixture: 600 synthetic rows at 1,536 dimensions with a 3% tenant, loaded with the HNSW index dropped and rebuilt afterwards. Measured build cost in PGlite with `m = 64, ef_construction = 200`: 300 rows inserted one by one into a live index 21.4 s; 300 rows then index 0.8 s + 1.3 s; 600 rows then index 2.3 s + 5.3 s; 2,000 rows one by one 508 s. Force the index in the test session with `SET enable_seqscan = off; SET enable_bitmapscan = off;` and include a negative control (iterative scan `off` returns fewer than k rows) so the test proves the index was used.
- **Conformance suite.** `tests/rag/backend-conformance/cases.ts` exports `runConformance(factory)`; `pgvector.test.ts` calls it. Vitest collects only `tests/**/*.test.ts`, and vitest suites already import the `.mts` harness (`tests/helpers/route-fixture.ts`).

### Pattern 10: Parent-child and chunking profiles (design, not executed)

- Migrations: `document_parents` (`id`, `document_id` with cascade, `tenant_key`, `version`, `is_current`, `chunking_profile_id`, `section_path`, `content`, `token_count`; RLS enabled, no anon or authenticated policy for writes); `document_chunks.parent_id`, `document_chunks.chunking_profile_id` (nullable, default profile `legacy`); `chunking_profiles` (`id`, `doc_type`, `child_tokens`, `parent_mode`, `parent_tokens`, `status`, `previous_active_id`) with a partial unique index on `(doc_type) WHERE status = 'active'`; functions `rag_activate_chunking_profile`, `rag_rollback_chunking_profile`, `rag_fetch_parents(p_tenant_key, p_parent_ids uuid[])`, all revoked from `PUBLIC, anon, authenticated` and granted to `service_role`.
- Search filter: children must belong to the active profile of their doc type: `c.chunking_profile_id = (SELECT id FROM chunking_profiles p WHERE p.doc_type = c.doc_type AND p.status = 'active')`, with rows of profile `legacy` matching when no other profile is active.
- `expand_parents`: after refusal, collect distinct `parent_id`s in rank order, fetch once through `rag_fetch_parents` (it validates the key like Pattern 1 and filters `tenant_key`, `is_current`), replace each child by its parent at the best child's rank, and fall back to the child when the parent does not fit the budget.
- Re-chunk job: reads Phase 3 D-18 parse output (and the Phase 3.1 parse cache when present), writes children and parents under the target profile with status `building`, embeds under the active embedding profile, and reports documents without stored parse output instead of touching them. A test asserts zero parser and sidecar calls.
- Validation: one Pydantic `ChunkingProfile` with validators; export a JSON table of cases (`input`, `errors`, `warnings`); the Config UI's JS validator runs against the same table in a node test.
- Admin routes follow Phase 3 D-45: `admin_users` session, Zod (`zod/v3`), structured JSON errors, 403 by default.

### Anti-Patterns to Avoid
- **Postgres tokenizing again.** Any `to_tsvector(config, text)` or `plainto_tsquery` over `lexical_text` reintroduces a second tokenizer (F-1).
- **Concatenating query text into `tsquery` in TypeScript.** Tokens travel as `text[]`; only the SQL function builds the query.
- **Passing `top_n` or `top_k` to the vendor.** The stage needs a score for every input to detect partial responses.
- **Treating a missing score as zero.** It turns outages into refusals (Pitfall 2).
- **A threshold on RRF scores or on `local_bm25`.** Neither is comparable across queries (F-3).
- **Static plpgsql SQL for the dense leg.** A cached generic plan cannot use the partial index and cannot react to filter selectivity.
- **Equality assertions on ANN results.** Only the exact path is exact (F-6).
- **Reading the test split inside any fit or sweep.** Sweeps are dev-only; calibration touches test once per cell (A-2).

## Migration Plan

Files in `supabase/migrations/`, after Phase 3's `03xx` files, idempotent, mirrored into both setup files and covered by Phase 3's schema-equality test.

| File | Content | Existing rows |
|------|---------|---------------|
| `0401_lexical_index.sql` | `lexical_tsv`, `lexical_version` (plain nullable columns), `rag_lexical_tsvector`, `rag_lexical_tsquery`, the trigger, the GIN index, a btree on `lexical_version` for the backfill | Columns appear instantly as NULL. Rows with NULL `lexical_tsv` are invisible to the lexical leg and unchanged for the dense leg |
| `0402_relex_functions.sql` | `rag_relex_batch(p_rows jsonb, p_version integer)` (service role only): sets `lexical_text` and `lexical_version` for a batch of chunk ids; the trigger fills `lexical_tsv` | Used by `npm run rag:relex` |
| `0403_hybrid_search_chunks.sql` | Pattern 1 function and grants, then `NOTIFY pgrst, 'reload schema';` | None |
| `0404_document_parents.sql` | Pattern 10 table, child columns, `rag_fetch_parents` | `parent_id` NULL, `chunking_profile_id = 'legacy'` |
| `0405_chunking_profiles.sql` | Pattern 10 table, seed `legacy` rows per doc type as active, activate and rollback functions | Legacy is active everywhere, so behaviour is unchanged |

Order on the real project (live verification):
1. Inventory: `SELECT extversion FROM pg_extension WHERE extname = 'vector';`, `SHOW lc_ctype;`, `SELECT count(*) FROM document_chunks;`.
2. If the table is large, create the GIN index first by hand with `CREATE INDEX CONCURRENTLY` on a direct connection; the migration's `IF NOT EXISTS` then does nothing. `CONCURRENTLY` cannot run inside the migration because the files are executed as one batch.
3. Apply `0401` to `0405`.
4. `npm run rag:relex -- --dry-run`, then the real run in batches (default 500 rows). It reads `content`, `section_path` and `metadata` only, makes no parser, sidecar or embedding call, resumes by `lexical_version`, and reports rows per tenant.
5. `VACUUM (ANALYZE) document_chunks;` afterwards. In PGlite 400 of 400 updated rows were non-HOT (`n_tup_hot_upd = 0`) and the heap doubled, so every re-tokenized row also gets a new entry in each index, the HNSW index included [ASSUMED for the size of the effect on a real project].
6. Smoke: one `hybrid_search_chunks` call per tenant kind with a Chinese exact term; confirm `anon` is refused with the real anon key.

Rollback: set `RAG_PIPELINE=legacy` (instant, no data change). The new function, columns and tables are additive and can stay. `0403` is one-way by D-04.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Chinese word segmentation | A dictionary or regex splitter | `Intl.Segmenter` plus Han bigrams | Built in, 0.011 ms per query, locked by D-07 |
| Sentence splitting for compression | Punctuation regex | `Intl.Segmenter(lang, { granularity: 'sentence' })` | Handles `。！？`, decimals and most abbreviations (executed) |
| Token counting | Character heuristics | `tiktoken` `cl100k_base` | Same encoding as Phase 3 chunk sizes |
| `tsquery` syntax | String building in TypeScript | `rag_lexical_tsquery(text[])` | Quoting lives in one audited SQL function |
| Filtered ANN recall | Re-query loops in the app | `hnsw.iterative_scan` and the exact path | pgvector does the iteration; the exact path is exact |
| Role tests | Mocked permission errors | Real roles in PGlite with `SET LOCAL ROLE` | The grant itself is under test |
| Paired statistics | New bootstrap code | `rag_eval.paired` | Fixed seed and slice rules already exist |
| Schema for TypeScript | Hand-written Zod | Pydantic model + `npm run gen:schemas` | Project rule; CI checks parity |
| Vendor SDKs | `cohere-ai`, `voyageai` clients | `fetch` adapters | D-09; the boundary check already bans those packages outside `src/lib/rag/` |
| Binomial tail | scipy | `math.comb` | No new dependency in `rag_eval` |

**Key insight:** every hard part of this phase already has an engine (ICU, pgvector, Postgres roles, the existing eval statistics). The work is wiring them so that the database never tokenizes, the application never ranks a tenant it did not verify, and a number that came from tooling is never typed by hand.

## Runtime State Inventory

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Every existing chunk has no `lexical_text` (Phase 3 leaves it NULL for legacy rows) and no `lexical_tsv`; chunks written by Phase 3 carry tokenizer version 1 text | Data migration: `rag:relex` to `LEXICAL_VERSION` 2 for all rows. Code edit: the Phase 3 chunk writer calls the completed tokenizer |
| Stored data | `eval/baselines/fixture-baseline.json`, `eval/fixtures/golden.jsonl`, `split-manifest.json` | Re-record the baseline after the golden additions, with zero paired differences on old items (D-26) |
| Live service config | The Supabase project needs the new functions, grants, columns, tables and GIN index; PostgREST must reload its schema cache to see the function [ASSUMED: Supabase reloads on DDL; the explicit `NOTIFY` covers it] | Apply migrations; live verification item |
| Live service config | pgvector extension version and database `lc_ctype` on the hosted project are unknown | Inventory queries above. `RAG_HNSW_ITERATIVE_SCAN` other than `off` needs 0.8.0 or newer |
| OS-registered state | None. Verified: no cron, queue or scheduler entry is added; `rag:relex` and the re-chunk job are run by hand | None |
| Secrets and env vars | New: `COHERE_API_KEY`, `COHERE_BASE_URL` and 13 switches (D-23). Reused: `VOYAGE_API_KEY`, `VOYAGE_BASE_URL` (Phase 3). Inert look-alikes already in `scripts/init-env.js` L387-392: `RAG_ENABLE_HYBRID_SEARCH=false`, `RAG_RERANKING=true`, `RAG_RERANKING_STRATEGY=hybrid` | Add the 15 names in the five config locations and `scripts/rag/env-manifest.json`; set them in Vercel. Label the old three as legacy in the Config UI so nobody toggles the wrong one |
| Build artifacts | `src/lib/rag-eval/contracts.generated.ts`, `rag-sidecar/schemas/*.schema.json`, `tests/fixtures/contracts/samples.json`, characterization snapshots | Regenerate with `npm run gen:schemas`; add a v2 voice snapshot; CI already diffs the generated files |

## Common Pitfalls

### P-1: `ef_search` caps the dense leg
**What goes wrong:** the pool is 75 but the dense leg returns 40 rows.
**Why it happens:** HNSW returns at most `hnsw.ef_search` rows (default 40) unless iterative scan is on.
**How to avoid:** the function sets `ef_search` to `clamp(2 × limit, 100, 1000)` for the transaction (Pattern 1).
**Warning signs:** `candidates_in` for the dense leg is exactly 40.

### P-2: Fixture tests that never touch the HNSW index
**What goes wrong:** iterative-scan tests pass with the switch off and on, proving nothing.
**Why it happens:** the planner uses a sequential scan on 71 rows.
**How to avoid:** the synthetic database and forced index in Pattern 9, with a negative control.
**Warning signs:** `selective_filter` Recall is identical off and on.

### P-3: Expecting ANN to equal exact search
**What goes wrong:** a flaky equality assertion; `strict_order` returned 9 of the exact 10.
**How to avoid:** equality on the exact path only; a recall floor (0.9) and a row-count check for iterative scan.

### P-4: Relaxed ordering leaks into ranks
**What goes wrong:** `relaxed_order` rows arrive slightly out of distance order and RRF ranks follow that order.
**How to avoid:** rank by `row_number() OVER (ORDER BY dist + 0, id)` over the materialized hits, as in Pattern 1.

### P-5: A token longer than 2,047 bytes fails the insert
**What goes wrong:** one base64 blob in a document makes the chunk write fail with `word is too long`.
**How to avoid:** the tokenizer drops tokens over 64 characters and the SQL builder skips tokens over 255 bytes.

### P-6: ICU drift between machines
**What goes wrong:** the backfill machine, CI and Vercel segment a Chinese word differently, so index and query tokens stop matching.
**Why it happens:** `Intl.Segmenter` is dictionary based and the dictionary changes with ICU.
**How to avoid:** a pinned table of zh sentences and expected tokens in the tokenizer test; the startup ICU check (D-07); Han bigrams as the safety net. If the table breaks on a Node upgrade, bump `LEXICAL_VERSION` and re-run `rag:relex`.

### P-7: `ts_rank_cd` rewards common words
**What goes wrong:** a chunk that repeats ordinary words outranks the chunk holding the exact code. Executed: for the query `型号 | 设备 | xr-2000`, the row without `xr-2000` scored 0.5 and the row with it 0.3.
**How to avoid:** the stopword list (tested data), normalization flag 1, and a per-leg metric "gold chunk inside the lexical leg's top N" in eval reports. That metric is the trigger for the deferred BM25 item.

### P-8: The lexical leg on a very large tenant
**What goes wrong:** an OR query matches a large share of a tenant's chunks and every match needs its `tsvector` read; `search` is a core stage, so a timeout is an error.
**How to avoid:** cap query tokens at 64, keep stopwords current, and record per-leg time. If live p95 exceeds the 400 ms search budget, drop query tokens whose bounded match count hits a cap. Do not build that until measured.

### P-9: Rerank silently never runs
**What goes wrong:** the vendor's p95 is above the stage timeout, every request is `degraded`, and refusal is off while the switch says on.
**How to avoid:** F-8's skipped-rate metric and Config UI warning.

### P-10: A refusal demo tuned to the golden set
**What goes wrong:** the fake reranker is adjusted until every fixture no-answer item is refused.
**How to avoid:** the fake reranker sees only text; success criterion 4 is read as "correct refusal improves while false refusal stays at or below the target", reported for dev (in sample) and test (holdout) separately. Near-miss questions are not reliably refused by a score threshold; Phase 5's groundedness check is the second line.

### P-11: Span offsets and merged blocks
**What goes wrong:** Cohere spans are offsets into the text that was sent to the reranker (with the section-path prefix), not into the stored chunk.
**How to avoid:** keep the prefix length, subtract it, convert codepoints to UTF-16 indices, and drop spans that fall in the prefix. Never compress a merged block by spans from its members without remapping.

### P-12: Empty arrays as filters
**What goes wrong:** `documentIds: []` reaches SQL as `'{}'` and matches nothing.
**How to avoid:** Zod rejects empty arrays in `retrievalFilters`; the adapter sends `null` for "no filter".

### P-13: `chunk_index` in single-tenant mode
**What goes wrong:** the single-tenant `document_chunks` has no `chunk_index` column today, and adjacency merging needs it.
**How to avoid:** Phase 3's research plans to add it (`0304`). The first Phase 4 plan that needs it must check, and add `ADD COLUMN IF NOT EXISTS chunk_index integer` plus a backfill from `metadata->>'chunk_index'` if it is missing.

### P-14: Superseded vectors starve filtered scans
**What goes wrong:** old versions stay in the HNSW graph and are filtered out after the scan.
**How to avoid:** Phase 3's research proposes clearing old vectors at publish time (its F-9). Phase 4 depends on that outcome; the selective-filter test should include superseded rows.

### P-15: Wrong-table permission errors mistaken for the grant test
**What goes wrong:** `anon` fails because the shim never granted table access, and the test passes for the wrong reason.
**How to avoid:** Pattern 9's shim privileges and an assertion on the message `permission denied for function hybrid_search_chunks`.

## Code Examples

The executed SQL is in Pattern 1; the adapter, fusion, reranker, edge-order, gate and fit sketches are in Patterns 2 to 7. Two more that the plans will copy:

### ICU check
```typescript
// src/lib/rag/lexical/icu-check.ts — the expected segments were observed on Node 22.23.5 / ICU 78.3
export function assertIcuSegmentsChinese(): void {
  const seg = new Intl.Segmenter('zh', { granularity: 'word' });
  const words = [...seg.segment('适用范围')].filter((s) => s.isWordLike).map((s) => s.segment);
  if (words.join('|') !== '适用|范围') {
    throw new Error(`[RAG Config] ICU cannot segment Chinese as expected (icu ${process.versions.icu})`);
  }
}
```

### Fake edge: run an RPC under the caller's role
```typescript
// eval/harness/fake-edge.mts — sketch; the edge already serializes requests through one queue
const role = apiKey === SERVICE_KEY ? 'service_role' : 'anon';
const rows = await db.transaction(async (tx) => {
  await tx.exec(`SET LOCAL ROLE ${role}`);                 // role comes from a two-value allow-list, never from the request
  return (await tx.query(sql, values)).rows;
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Cohere `rerank-v3.5` / `rerank-v4.0-*`, document-level scores only | `rerank-v5.0-pro` / `-fast` with `relevant_spans` | Listed as current in Cohere's docs on 2026-11-23 | Compression can use provider spans; the old search-unit pricing page may no longer describe v5 |
| Voyage `rerank-2.5` | `rerank-3` / `rerank-3-lite`, scores matched to the 2.5 distributions | Voyage post dated 2026-09-30 | 2.5 is an override to test, not a default |
| Raise `ef_search` and hope under filters | `hnsw.iterative_scan` (pgvector 0.8.0+) plus an exact path for small filtered sets | pgvector 0.8.0 | Filtered recall is controllable per query |
| `to_tsvector` with a language config | Application tokenizer, verbatim lexemes, `simple`-style matching | RET-03 | Same tokens on every backend |
| One global similarity threshold (0.65) | Per reranker, model, language and pairing cell with a holdout check | This phase | Refusal survives a provider switch |

**Deprecated/outdated:**
- `src/lib/reranker-local.ts` tokenization: ASCII only, drops Chinese entirely.
- `RAG_ENABLE_HYBRID_SEARCH`, `RAG_RERANKING`, `RAG_RERANKING_STRATEGY`: read only by modules Phase 2 deletes.
- `search_chunks_by_keywords` (single-tenant SQL): substring `LIKE` scoring with no tenant argument; not used by v2.

## Latency Budget

Budgets are p95 targets per stage. They extend the Phase 2 D-21 file and stay report-only on fixtures.

| Stage | Chat / embed | Voice | Basis |
|-------|--------------|-------|-------|
| analyze + translate (fixture table) | 5 ms | 5 ms | Pure functions; tokenizer 0.011 ms per query (measured) |
| embed | 200 ms | 200 ms | Phase 2 D-21 |
| search (all variants in parallel) | 400 ms | 300 ms | Phase 2 D-21 and research; 3.4 ms per call in PGlite on a tiny corpus (measured, not representative) |
| fuse + dedupe | 5 ms | 5 ms | In memory over 150 to 300 hits |
| rerank | 600 ms (timeout) | 250 ms (timeout) | D-10; vendor latency unknown (F-8) |
| refusal | 1 ms | 1 ms | Lookup |
| expand_parents | 100 ms | off by default | One RPC |
| assemble (incl. token count) | 100 ms | 50 ms | Token count 19.5 ms per 15.7K tokens (measured); encoder init 107 ms once |
| compress | 50 ms | off | Local scoring; provider spans ride on the rerank call |
| **Retrieval total** | **about 1,460 ms, inside 2,000 ms** | **about 810 ms against 800 ms** | Phase 2 D-21 totals |

Voice does not fit if every stage hits its own limit, so the voice profile needs a request deadline: `rerankTimeout = min(250, 800 − elapsed − 50)`, and when less than about 80 ms remains the rerank stage is skipped before it starts and recorded as `skipped / budget_exhausted` (degraded, refusal not applied). That is what D-25's injected-delay test should exercise. Exact-scan cost for reference: 1,950 rows at 1,536 dimensions took 16.9 ms and the bounded count 0.8 ms in PGlite.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Cross-tenant read through the service-role function | Low | Critical | Tenant key validated and compared in SQL, raises on mode mismatch, two-tenant cases on every leg, equality with the workspace predicate, parents fetched through the same rule |
| Phase 2 or Phase 3 contracts land differently from their plans | Medium | High | Each plan names its upstream plan; first task of each plan re-reads the real file |
| Vendor latency above the timeouts | Unknown | Medium | F-8 metric and decision rule |
| `ts_rank_cd` ordering limits lexical recall on real data | Medium | Medium | Stopwords, per-leg metric, deferred BM25 |
| ICU drift | Low | Medium | P-6 |
| Fixture numbers read as real gains | Medium | Medium | F-9 wording in the report; live verification decides |
| `rag:relex` churn on a large table | Medium | Low | Batches, dry run, `VACUUM (ANALYZE)` |
| Chunk text sent to Cohere and Voyage | Certain when switched on | Depends on tenant | `RAG_RERANKER=none` by default; list both vendors in the Phase 7 data-flow inventory; no query or chunk text in logs |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Voice token budget of 2,000 tokens suits spoken answers | A-9 | Voice answers lose context or run long; a one-line change |
| A2 | 150 tokens is a sensible minimum for compression | A-10 | Short chunks get cut or long ones are left whole |
| A3 | A runtime `fs.readFile` of `eval/config/*.json` would not be bundled on Vercel, so static import is required | Project structure | If wrong, either approach works |
| A4 | Supabase reloads the PostgREST schema cache after DDL; the explicit `NOTIFY pgrst` is enough otherwise | Migration plan | First RPC calls fail with "function not found" until a reload |
| A5 | Non-HOT updates during `rag:relex` add HNSW entries with a noticeable cost on a real project | Migration plan | The backfill is either faster than feared or needs a reindex |
| A6 | `ef_search = clamp(2 × limit, 100, 1000)` is a good recall and speed setting | P-1 | Dense leg slower or still short under filters; tune from live plans |
| A7 | The Cohere v5 per-token prices ($0.05 and $0.02 per million) from secondary sources are right | Verified External Facts | Cost estimates off; read `meta.billed_units` live |
| A8 | Cohere and Voyage scores are stable enough across requests for a fixed threshold | Pattern 7 | Thresholds drift; the holdout check and re-calibration on model change catch it |
| A9 | `jieba-wasm` and `nodejieba` are the relevant alternative packages | Alternatives | None; they are not recommended |
| A10 | Holdout minimums (1 and 2 on fixtures, 3 and 6 on the real set) and the one-item tolerance are acceptable to the user | A-3 | Cells are accepted or rejected too easily; values live in `refusal-calibration.json` |

## Open Questions

1. **Which pgvector version and `lc_ctype` does the user's Supabase project run?**
   - What we know: Supabase packages up to 0.8.2; the check is one query.
   - What's unclear: the project's actual values.
   - Recommendation: run the inventory queries as the first live step. With the verbatim builder, `lc_ctype` no longer matters. Below 0.8.0, keep `RAG_HNSW_ITERATIVE_SCAN=off` and rely on the exact cutoff.

2. **Real rerank latency for 75 chunks.**
   - What we know: nothing from a primary source.
   - Recommendation: measure p50 and p95 per model in live verification with the real pool; apply F-8's rule.

3. **Does `rerank-3` or `rerank-2.5` do better on the zh and it slices?**
   - What we know: Voyage's aggregate favours `rerank-3`.
   - Recommendation: the planned live comparison; leave the override empty until it shows a gap beyond the noise band.

4. **Will Phase 3 adopt its research's proposals (SQL writer functions, clearing superseded vectors, `chunk_index` in single-tenant)?**
   - What we know: they are recommendations in an uncommitted `03-RESEARCH.md`.
   - Recommendation: Phase 4 plans depend on outcomes, not on those mechanisms: "a chunk row has `tenant_key`, `lexical_text`, `chunk_index`, `language`". Re-check when Phase 3 is planned.

5. **Should the analyzer-derived date range ever be a hard filter?**
   - Recommendation: F-4. Compare on and off in the eval before anyone turns `RAG_TEMPORAL_MATCHING` on for v2.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js with full ICU | Tokenizer, all tests | yes | 22.23.5, ICU 78.3 | — |
| PGlite + pgvector | SQL, grant, conformance, eval tests | yes | 0.5.17 / 0.0.18 (PG 18.7, pgvector 0.8.7) | — |
| `uv`, Python | Sweep and calibration tools, contracts | yes | uv 0.11.32; system Python 3.13.18 (projects pin `>=3.12,<3.13`, resolved by uv) | — |
| `psql` client | Applying migrations by hand | yes | 16.15 | Supabase SQL editor |
| Docker daemon | Not needed by this phase | no (CLI only) | — | PGlite |
| `COHERE_API_KEY`, `VOYAGE_API_KEY` | Live rerank calls | no | — | Recorded responses and the fake reranker |
| Supabase project | Hosted migration, Chinese lexical check | no | — | PGlite; live verification item |

**Missing dependencies with no fallback:** none for the fixture-level phase goals.

**Missing dependencies with fallback:** live keys and the hosted project. They are the ROADMAP live verification items: real calibration and sweep, the `rerank-3` versus `rerank-2.5` comparison, the hosted migration.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.1.1 (`tests/**/*.test.ts`); `node --import tsx --test` for `.test.mts`; pytest 9.2.0 for `eval/` and `rag-sidecar/` |
| Config file | `vitest.config.ts`; `eval/pyproject.toml`; `rag-sidecar/pyproject.toml` |
| Quick run command | `npx vitest run tests/rag/<area>` |
| Full suite command | `npx vitest run && uv run --directory eval pytest -q && uv run --directory rag-sidecar pytest -q && node scripts/check-config.mjs && node scripts/ci/check-rag-boundary.mjs && npm run typecheck:new` |

No test calls a live service. Database tests use PGlite; rerankers use recorded responses or the fake.

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| RET-01 | Adapter rejects an unminted scope; tenant key comes only from the scope; legs shape; `isReady` true | unit + conformance | `npx vitest run tests/rag/backend-conformance` | no, Wave 0 |
| RET-02 | Both legs filtered before ranking; RRF order, tie by chunk id, one-leg case equals dense order | unit + PGlite | `npx vitest run tests/rag/fusion tests/rag/sql/hybrid-search.test.ts` | no, Wave 0 |
| RET-03 | Table-driven zh, en, it tokens; codes whole, joined, parts; index and query symmetry; zh exact-term in `legs.lexical` | unit + conformance | `npx vitest run tests/rag/lexical tests/rag/backend-conformance` | no, Wave 0 |
| RET-03 | `rag:relex` dry run, resume after a kill, zero parser and embedding calls | integration | `npx vitest run tests/rag/lexical/relex.test.ts` | no, Wave 0 |
| RET-04 | `anon` and `authenticated` get `42501 … for function`; `service_role` gets rows; same through the fake edge with the anon key | PGlite + edge | `npx vitest run tests/rag/sql/hybrid-grants.test.ts` | no, Wave 0 |
| RET-04 | Malformed, NULL and wrong-mode tenant keys raise; two-tenant result equals `match_documents_by_workspace` | PGlite | `npx vitest run tests/rag/sql/hybrid-tenant.test.ts` | no, Wave 0 |
| RET-10 | Forced index: `off` under k (negative control), iterative scan k rows with recall at least 0.9, cutoff path equals exact; dense leg returns 75 of 75 | PGlite synthetic | `npx vitest run tests/rag/sql/selective-filter.test.ts` | no, Wave 0 |
| DATA-08 | Each filter alone and combined, on both legs; empty array rejected; filters never widen; derived date range off by default | PGlite + unit | `npx vitest run tests/rag/sql/hybrid-filters.test.ts tests/rag/query` | no, Wave 0 |
| RNK-01 | Cohere and Voyage adapters parse recorded responses; request body and header shape; tier and per-language model resolution; `local_bm25` on zh text | unit | `npx vitest run tests/rag/rerank` | no, Wave 0 |
| RNK-02 | Sweep over a fake eval endpoint picks the smallest configuration within the noise band and writes the params file with numbers | pytest | `uv run --directory eval pytest -q tests/test_sweep_retrieval.py` | no, Wave 0 |
| RNK-03 | Adjacent merge, rank selection inside the budget, edge order; switch off equals rank order; legacy byte identity still holds | unit + differential | `npx vitest run tests/rag/context && node --import tsx --test tests/rag-assemble-differential.test.mts` | partly (differential arrives with Phase 2 plan 02-09) |
| RNK-04 | Switch off leaves the context byte-identical; tables, images and short chunks untouched; kept text is verbatim; codepoint offsets | unit | `npx vitest run tests/rag/context/compress.test.ts` | no, Wave 0 |
| RNK-05 | Gate decisions for every branch; fit on dev; poisoned test scores do not move thresholds; holdout statuses; stale cell ignored | unit + pytest | `npx vitest run tests/rag/refusal && uv run --directory eval pytest -q tests/test_calibrate_refusal.py` | no, Wave 0 |
| RNK-06 | Timeout, HTTP error, abort and partial response: fused order kept, status `degraded`, refusal `not_applied / reranker_unavailable`; `none` is `disabled` | unit | `npx vitest run tests/rag/rerank/rerank-stage.test.ts` | no, Wave 0 |
| CHK-03 | Parent once per group at the best child's rank, inside the budget, tenant-scoped (two-tenant); switch off unchanged | unit + PGlite | `npx vitest run tests/rag/parents` | no, Wave 0 |
| CHK-04 | Validation table: Pydantic and JS agree; admin routes 403 without `admin_users`; activate refused when incomplete; rollback restores | pytest + node test + PGlite | `uv run --directory rag-sidecar pytest -q tests/test_chunking_profile.py && npx vitest run tests/rag/chunking` | no, Wave 0 |
| CHK-05 | Chunking sweep report has every slice and records the decision file; zero parser calls during re-chunk | pytest + integration | `uv run --directory eval pytest -q tests/test_sweep_chunking.py` | no, Wave 0 |
| LAT-01 | Variants searched concurrently with one signal; dedupe by chunk and parent; cap applied; span counts | unit | `npx vitest run tests/rag/v2/search-fuse-dedupe.test.ts` | no, Wave 0 |
| LAT-02 | Voice uses the fast tier; with injected delays the voice profile stays under 800 ms and skips rerank when the deadline is near | unit (fake timers) | `npx vitest run tests/rag/v2/voice-budget.test.ts` | no, Wave 0 |
| XLG-03 | Translated variant drives the lexical leg and `local_bm25`; hosted rerankers get the original; cross cells calibrated and compared | unit + pytest | `npx vitest run tests/rag/v2/translation-seam.test.ts && uv run --directory eval pytest -q tests/test_calibrate_refusal.py` | no, Wave 0 |
| D-23 | 15 env vars in five places and the manifest | script | `node scripts/check-config.mjs` | yes |
| D-09 | Rerank HTTP only under `src/lib/rag/rerank/` | script | `node scripts/ci/check-rag-boundary.mjs` | arrives with Phase 2 plan 02-20 |
| D-28 (a) | Legacy run: gate exit 0 and all paired differences zero | eval smoke | `npm run test-rag -- --out eval/out/smoke` | yes |
| D-28 (b), (c) | Recommended v2 run against the baseline and against `v2-all-off`; one run per switch | eval | new harness flags for pipeline and overrides | no, Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/rag/<area>` for the area touched, plus `npm run typecheck:new`.
- **Per wave merge:** the full suite command above.
- **Phase gate:** full suite, `npm run test-rag` (legacy parity), the v2 comparison runs, and `npm run gen:schemas` with a clean `git diff` on generated files, before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] PGlite shim: Supabase-like role attributes and default privileges (`eval/harness/pglite-supabase.mts`)
- [ ] Fake edge: role mapping by API key, `hybrid_search_chunks` and the new RPCs, fake Cohere and Voyage rerank endpoints (`eval/harness/fake-edge.mts`)
- [ ] `tests/rag/backend-conformance/cases.ts` and `pgvector.test.ts`
- [ ] Synthetic selective-filter fixture builder (600 rows, drop index, load, rebuild)
- [ ] `tests/fixtures/rerank/` recorded responses for Cohere (with and without `relevant_spans`, a 429, a partial result) and Voyage (`data[]` shape, a 4xx with `detail`)
- [ ] Fake reranker module and its purity test
- [ ] Contracts: `RetrievalParams`, `RefusalThresholds`, `RefusalCalibrationConfig`, `ChunkingProfile`, `RetrievalFilters`; `RagRunOptions.retrieval_overrides`; `RagTrace` additions (`refusal`, `below_threshold` as a refusal reason, rerank scores on candidates, new `kept_by` values); `Category` gains `selective_filter`. Today: `refusal_reason: Literal["no_relevant_context"] | None` (`eval_run.py:101`), `kept_by: Literal["similarity", "name", "image"]` (`eval_run.py:60`), `Category = Literal["multi_turn", "compound", "exact_term", "table", "scanned", "no_answer", "general"]` (`golden.py:8`)
- [ ] Eval harness flags for a v2 run and per-request overrides; report slices `by_doc_type`, `by_question_kind`, per-leg hit rate, `rerank_skipped_rate`
- [ ] CI: add the new `.test.mts` files, if any, to the explicit `node --import tsx --test` list in `.github/workflows/pr-smoke.yml`

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (admin routes) | Supabase session with `admin_users` check, 403 by default (Phase 3 D-45 pattern) |
| V3 Session Management | no | No new session handling |
| V4 Access Control | yes | Branded `TenantScope`; tenant key validated and enforced in SQL; function granted to `service_role` only; parents fetched under the same rule |
| V5 Input Validation | yes | Zod (`zod/v3`) for `retrievalFilters` and admin bodies; SQL-side range and allow-list checks; tokens as `text[]` quoted in one SQL function |
| V6 Cryptography | no | None added; reuse existing constant-time comparisons |
| V7 Logging | yes | No query, chunk text or key in logs; vendor errors logged as status codes; `[Document Search]` and `[RAG Trace]` prefixes |
| V8 Data Protection | yes | Chunk text leaves the boundary only when `RAG_RERANKER` is `cohere` or `voyage`; default `none` |
| V14 Configuration | yes | Secrets as placeholders in the five config locations; base URLs come from server env, never from requests |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Service-role RPC returns another tenant's chunks | Information disclosure | Key regex, mode check and `tenant_key = $2` on every leg; raise instead of searching unfiltered; two-tenant conformance cases |
| `tsquery` or SQL injection through tokens or filters | Tampering | `quote_literal` inside `rag_lexical_tsquery`; typed parameters with `USING`; only registry-derived values in `format()` |
| `anon` or `authenticated` calling the function directly | Elevation of privilege | `REVOKE … FROM PUBLIC, anon, authenticated`; grant test with the real roles |
| Request filters widening scope (`documentIds` of another tenant) | Information disclosure | Filters are ANDed with the tenant predicate; test with a foreign document id |
| Eval-only overrides reachable from chat or embed | Elevation of privilege | Overrides parsed only in the eval route, which keeps its Phase 1 secret and scope allow-list |
| Vendor outage turned into refusals | Denial of service | Skip on failure, `degraded`, refusal not applied |
| Oversized inputs to the function | Denial of service | Limits 0 to 200, cutoff up to 100,000, at most 64 tokens of at most 255 bytes |
| Tampered thresholds or params | Tampering | Committed files written only by tools, reviewed in pull requests, validated by generated Zod at load |
| Chunking-profile admin routes without auth | Elevation of privilege | `admin_users` check, fail closed, route tests for 401 and 403 |

## Sources

### Primary (HIGH confidence)
- Executed in this session on PGlite 0.5.17 (PostgreSQL 18.7, pgvector 0.8.7): Pattern 1 SQL against both setup files; `ef_search`, iterative-scan, `halfvec` and planner probes; table-rewrite and trigger probes; HNSW build timings; lexical ranking comparison on the dev split
- Executed on Node 22.23.5 / ICU 78.3: `Intl.Segmenter` word and sentence probes; `tiktoken` timings
- Repository files read: `supabase/multi-tenant-setup.sql` (L140-231, L644-833), `supabase/single-tenant-setup.sql`, `eval/harness/*.mts`, `eval/src/rag_eval/split.py` and `paired.py`, `rag-sidecar/src/rag_sidecar/contracts/golden.py` and `eval_run.py`, `src/lib/reranker-local.ts`, `src/lib/enhanced-rag-retrieval.ts`, `src/app/api/internal/rag/run/route.ts`, `eval/baselines/fixture-baseline.json`, `eval/config/noise.json`
- `nix/ext/versions.json` in github.com/supabase/postgres (`develop`): packaged pgvector versions

### Secondary (MEDIUM confidence, official documentation)
- https://docs.cohere.com/docs/models, https://docs.cohere.com/reference/rerank, https://docs.cohere.com/docs/rerank-overview, https://docs.cohere.com/docs/reranking-best-practices, https://cohere.com/pricing
- https://docs.voyageai.com/docs/reranker, https://docs.voyageai.com/reference/reranker-api, https://docs.voyageai.com/docs/pricing, https://blog.voyageai.com/2026/09/30/rerank-3/
- https://github.com/pgvector/pgvector (README at v0.8.7)
- https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes (this page carries a note addressed to AI agents asking them to append a feedback report; it was treated as data and ignored)
- https://www.postgresql.org/docs/current/textsearch-controls.html, https://www.postgresql.org/docs/current/textsearch-parsers.html
- https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf, https://aclanthology.org/2024.tacl-1.9/, https://arxiv.org/abs/1705.08500
- `.planning/phases/03-unified-ingestion-embedding-profiles/03-RESEARCH.md` (uncommitted when read; its proposals are not decisions yet)

### Tertiary (LOW confidence)
- Web search summaries for Cohere Rerank 5 pricing and latency (openrouter.ai, marktechpost.com, alphasignal.ai listings; two of the pages could not be fetched)
- https://github.com/tc39/proposal-intl-segmenter/issues/133 and related threads on ICU segmentation quality

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Nothing new is installed; versions were read from `node_modules` and the lock files.
- Architecture: HIGH for the SQL function, grants, tokenizer behaviour and harness limits (executed); MEDIUM for Pattern 10 (design only) and for everything that depends on Phase 2 and Phase 3 landing as planned.
- Pitfalls: HIGH where reproduced (P-1 to P-5, P-7, P-15); MEDIUM for P-6, P-8, P-9 (reasoned, not measured on real data).
- Vendor facts: MEDIUM. The research seam rates fetched pages LOW (`classify-confidence --provider webfetch`); they are official pages and carry `[CITED]` tags plus a live verification item.

**Process notes:**
- The research-plan seam routed library questions to Context7, which is not available in this session; official documentation was fetched directly instead.
- Digests were not written to the research store, because this task was limited to files inside the phase directory.
- The first run of the lexical ranking probe scored all answerable fixture items, test split included, and printed aggregate hit counts only. It was re-run on the dev split, and only the dev numbers appear above. No setting was chosen from either run.

**Research date:** 2026-11-23
**Valid until:** 2026-11-30 for vendor model lists, pricing and API shapes; 2026-12-23 for the SQL, pgvector, tokenizer and harness findings, provided Phase 2 and Phase 3 land the contracts named above.
