# Pitfalls Research

**Domain:** Production RAG pipeline upgrade on an existing multi-tenant chat app (Next.js/TS + Supabase pgvector + new Python sidecar + Weaviate/Qdrant)
**Researched:** 2026-11-22
**Confidence:** MEDIUM-HIGH. Vendor facts (pgvector limits, Voyage dims, Claude Citations constraints, HHEM licensing/languages, Qdrant/Weaviate tenancy) were verified against official docs. Failure modes drawn from the codebase are HIGH (read from `CONCERNS.md` and `PROJECT.md`). Items tagged `[VERIFY]` are domain-knowledge claims that a phase-level spike must confirm before being relied on.

**Phase key used below** (suggested names; the roadmapper may renumber):
`P-EVAL` evaluation harness + baseline + CI skeleton, `P-DATA` parsing / doc types / dedup / versioning, `P-EMB` embedding switch + re-embed, `P-BACKEND` Weaviate/Qdrant + sync + tenant isolation, `P-QUERY` rewrite/multi-query/HyDE/sub-question/RRF, `P-RANK` rerank/top-k/compression/refusal, `P-GEN` citations + HHEM, `P-FINAL` regression + defaults + Config UI + docs.

---

## Premise Corrections (read first — these change requirements in PROJECT.md)

1. **"HHEM-2.3 in the sidecar" is probably not possible as written.** Per the Hugging Face model card, HHEM-2.3 is "available exclusively via Vectara's platform" (commercial API). The open-weights model is HHEM-2.1-Open (Apache-2.0, English tagged). **Italian is not listed for either model**; Chinese (Simplified) is listed only for HHEM-2.3. Our three languages are therefore not covered by anything we can self-host. See Pitfall 14. (HIGH, official model card.)
2. **Claude Citations and structured outputs are mutually exclusive.** Enabling citations on any `document` or `search_result` block plus `output_config.format` returns HTTP 400. The requirement "use structured output for the citation list where possible" cannot apply to the Claude path. See Pitfall 9. (HIGH, official docs.)
3. **Voyage-4-large defaults to 1024 dimensions, and its 2048-dim option exceeds pgvector's 2000-dim `vector` HNSW limit by 48.** Qwen3-Embedding-8B is 4096-dim native (MRL-truncatable). Neither fits the current `vector(1536)` column or its RPC signatures. See Pitfall 3. (HIGH, official docs.)

---

## Critical Pitfalls

### Pitfall 1: Cross-tenant leakage through the external vector stores

**What goes wrong:**
A query against Qdrant/Weaviate returns chunks from another user's or organization's workspace. Variants, in rough order of likelihood for this codebase:
- The tenant filter is optional in the query builder, so one code path (voice, embed, a new "debug" call, the eval endpoint) forgets it. Qdrant does not isolate on index alone: the `is_tenant` payload index only makes tenant-filtered queries fast; a request without the filter returns everything (Qdrant multitenancy docs).
- The filter is built from request-supplied `user_id` / `organization_id` rather than values derived from the verified session (the embed and internal voice routes already authenticate differently from the main chat route).
- Null-handling bug: this app has personal chunks (`organization_id IS NULL`) and org chunks, plus single-tenant mode where both can be null. A payload filter `organization_id == X` or `user_id == Y` written as an AND instead of `(org = X) OR (user = Y AND org IS NULL)` leaks or hides data. In Weaviate, filtering on null requires `indexNullState` to be enabled at collection creation, otherwise null filters silently do not work `[VERIFY]`.
- Sync lag/revocation: a user is removed from an org, or a document is deleted/replaced, in Supabase, but the vectors (and the chunk text duplicated in the external store for BM25) remain and are still served. Supabase RLS no longer protects those bytes.
- Shared chunk rows or cross-tenant dedup (see Pitfall 6) place one tenant's content under another tenant's id.
- Stores keyed by one collection with a shared API key: one leaked read key reads all tenants.

**Why it happens:**
Supabase RLS gave "free" isolation; moving search outside Postgres silently removes it. Teams treat the filter as a query parameter instead of a security boundary, and the sync path is tested only for "does it appear", never "does it disappear".

**How to avoid:**
- One retrieval gateway module (the already-required single retrieval module) is the only code allowed to talk to any backend. Signature takes a server-derived `TenantScope` object (never raw ids from a request body); a backend adapter cannot be constructed or called without it. Lint/CI rule: no direct imports of the Weaviate/Qdrant clients outside the adapters.
- Qdrant: single collection per embedding model with a keyword payload index `tenant_key` marked `is_tenant: true`; the adapter injects the filter in code and throws if the final request has no tenant clause. Consider also a JWT with per-tenant payload-filter claims for the read-only retrieval key `[VERIFY: supported on the chosen Qdrant hosting tier]`. Weaviate: native multi-tenancy (tenant per workspace; each tenant is its own shard, per Weaviate docs), tenant argument mandatory in the adapter.
- Defence in depth that fits "Supabase is the single source of truth": after any external retrieval, re-validate the returned chunk ids against Supabase under the caller's RLS context (`select id from document_chunks where id = any($1)` with the user JWT, not service role) and drop anything not returned. This is one cheap indexed query and converts a silent leak into a logged metric (`tenant_validation_dropped > 0` is a page-worthy alert).
- Sync via an outbox, with delete-by-tenant/document filters and a reconciliation job (Pitfall 7). Revoking org membership must not require re-sync: because of the re-validation step above, stale vectors are filtered at read time.
- Two-tenant canary tests (below) run in CI against both backends with seeded, distinguishable data, including a personal-vs-org case and a null-org case.

**Warning signs:**
- Any retrieval call site that passes `organization_id` from `req.json()`.
- Result chunk ids not found when re-validated against Supabase.
- External store point count per tenant differs from `count(*)` in Supabase.
- Eval Recall suspiciously higher on one backend than on pgvector (it may be seeing foreign data, or the filter is not applied).

**Phase to address:** `P-BACKEND` (gateway + adapters + canary tests), but the `TenantScope` type and gateway must exist in `P-EVAL`/first retrieval refactor so pgvector goes through it too. The eval endpoint (Pitfall 11) must use it.

---

### Pitfall 2: Strict mode turns every retrieval failure into a confident false refusal

**What goes wrong:**
Strict RAG returns "information not available" when there is no useful context. Any backend error, partial sync, empty new index after a backend/embedding switch, wrong tenant filter, expired API key, or a reranker that returns nothing is indistinguishable from "the knowledge base has no answer". The product's core value (answer when known, refuse only when truly absent) silently inverts and nobody sees an error.

**Why it happens:**
Existing code treats empty results as a normal outcome. New moving parts (3 backends, sync lag, new embedding model, rerank API) multiply the ways to get empty results.

**How to avoid:**
- Retrieval returns a discriminated result: `{status: 'ok' | 'empty' | 'error' | 'degraded', ...}`. Only `empty` from a backend that is verified ready may trigger the refusal. `error`/`degraded` falls back to pgvector (the default, always-written store) and is logged.
- Per-tenant `index_state` row per backend and per embedding model (`ready`, `chunk_count_expected`, `chunk_count_synced`, `last_synced_at`). Backend selection for a tenant checks readiness; a global env switch cannot route a not-yet-synced tenant to an empty store.
- Reranker failure falls back to pre-rerank order and must disable score-threshold refusal for that request (a missing score is not a low score).
- Add "known-answerable questions must not be refused" as a CI metric (false-refusal rate), not only "unanswerable questions are refused".

**Warning signs:** Spike in "information not available" after any config flip; refusal rate differs by backend; refusal rate differs by tenant.

**Phase to address:** `P-EVAL` (false-refusal metric + characterization test of current strict behaviour), enforced in `P-BACKEND`, `P-RANK`.

---

### Pitfall 3: Embedding dimension mismatch and mixed-embedding indexes during the switch

**What goes wrong:**
- Schema: `document_chunks.embedding` is `vector(1536)` and the match RPC takes `vector(1536)`. New models do not fit: Qwen3-Embedding-8B is 4096 native; Voyage-4-large is 1024 by default and 2048/512/256 via `output_dimension`. pgvector HNSW on `vector` caps at 2000 dims; `halfvec` caps at 4000 (Supabase/pgvector docs). Voyage 2048 and Qwen3 4096 native therefore cannot use a plain `vector` HNSW index; 4096 does not even fit `halfvec` HNSW (4000 limit).
- Mixed index: documents embedded with model A, queries with model B (or half the corpus migrated). Cosine similarity across different models is meaningless but returns plausible-looking numbers; there is no error. Same failure if dimensions are truncated (MRL) for documents but not for queries, or not re-normalised.
- Asymmetric models: Qwen3-Embedding wants an instruction prefix on the query side only (model card: omitting it costs roughly 1-5% retrieval quality); Voyage has `input_type` query vs document. Re-embedding docs and forgetting query prefixes (or applying the prefix to documents) degrades silently.
- Existing similarity thresholds, adaptive retry ("lower threshold when too few results"), and financial/date boosts were tuned for `text-embedding-3-small` score distributions. They do not transfer. With a new model the same 0.3 cutoff can pass everything or nothing.
- Provider drift: Qwen3-8B is hosted by third parties; different hosts serve different precisions/quantizations and may not honour `dimensions`. Vectors from provider X (docs) and provider Y (queries) are not guaranteed identical. Voyage truncates over-length input by default `[VERIFY]`, silently clipping big Docling table chunks.
- Operational: `ALTER COLUMN TYPE` rewrites the table and takes locks; HNSW build at `m=64, ef_construction=200` on 2048-4096-dim vectors needs far more memory/time than the current index and can hit Supabase statement timeouts or memory limits.
- Each external store also fixes dimension at creation (Qdrant collection vector size; Weaviate named vector config). Enabling a Weaviate server-side vectorizer module would embed with a different model without any error.

**Why it happens:**
"Just swap the env var" mental model. Embedding model identity is not stored with the vector, so nothing can detect a mismatch.

**How to avoid:**
- Store `embedding_model_id` (provider + model + precision/host + dimension + query-prefix version) with every chunk vector, and an `embedding_models` registry table. The query path derives which model to embed the query with from the **index being searched**, never from the current env default.
- Add vectors in a new column/table per model (`embedding_qwen3_1024 halfvec(1024)`, etc.), dual-write during migration, cut over by switching the registry's `active` pointer after 100% backfill plus an eval gate. Keep the old column until a soak period passes (rollback = flip pointer). Never `ALTER TYPE` in place.
- Pick dimensions deliberately: for pgvector prefer MRL-truncated 1024 (or 1536 to keep parity) with `halfvec` and measure recall loss on the golden set; Voyage 2048 and Qwen3 4096 need `halfvec` plus index-expression casting at best, and 4096 cannot be indexed at all. Re-normalise after truncation.
- Thresholds: make every similarity cutoff a property of the embedding-model registry row, recalibrated per model on the golden set; prefer rank-based and reranker-score-based decisions over raw cosine cutoffs.
- Bring-your-own-vectors in Weaviate (`vectorizer: none`); collection naming `chunks__{model}__{dim}` in Qdrant.
- Guard at startup and per request: if `query_vector.length !== index.dimension` or `model_id` mismatch, throw (and fall back to the previous model index) instead of searching.
- Pin the Qwen3 hosting provider and precision; treat a provider change as a model change (new `embedding_model_id`, full re-embed).
- Re-embed from stored chunk text (see Pitfall 5), batch with checkpoint table `(chunk_id, target_model_id, status)`, idempotent upserts, concurrency limits matched to provider rate limits, and a pause/resume flag.
- Build the HNSW index after bulk load, outside the pooler, with raised `maintenance_work_mem`; test on a copy with production row counts first.

**Warning signs:** Recall@k collapses to near-random right after a switch; scores cluster around one value; zero results after switch (thresholds); `vector dimension` errors in logs only on some routes (voice/embed path forgot the model lookup).

**Phase to address:** `P-EMB` (all of it); registry table design should land with `P-DATA` metadata work so chunk rows are created with the field from the start.

---

### Pitfall 4: Latency blow-up from stacking query transforms, fusion, rerank and HHEM (voice most exposed)

**What goes wrong:**
Each capability looks affordable alone; stacked serially they are not. Rough per-stage additions: history rewrite LLM call (~0.5-1.5 s), HyDE generation (~1-3 s), sub-question decomposition (~1-2 s), N embedding calls for N rewritten queries, N parallel retrievals x 3 backends, RRF, rerank of 50-100 candidates (~0.2-0.8 s), then the answer model, then HHEM. Totals of 5-10 s before first token are easy. Chat route is capped at `maxDuration: 60` with no `AbortSignal.timeout` anywhere in the chat route today, so a stalled stage hangs the whole request. The voice path (LiveKit, barge-in, three-dot UI waiting on text/word timings) tolerates far less. Cost multiplies too: multi-query x rerank per query is billed per search call.

**Why it happens:**
Features are built and evaluated for quality in isolation; the project's own constraint ("latency budget") has no owner until late.

**How to avoid:**
- Write the latency budget into `P-EVAL` as a measured metric (p50/p95 time-to-retrieval-complete and TTFT per path: text, embed, voice) and make the CI gate fail on p95 regressions beyond a stated budget. Suggested starting budgets to be ratified from baseline: text chat retrieval stage p95 <= 2.5 s excluding answer generation; voice <= 600-800 ms for rewrite+retrieve+rerank combined.
- Gate transforms by a cheap classifier (rules + tiny model): single-fact, short, no-pronoun queries skip rewrite/HyDE/decomposition. Only decompose on detected compound questions. HyDE off by default; enable per query type only if eval shows gain.
- Run independent stages concurrently (embed all query variants in one batched call; retrieve variants in parallel), fuse with RRF **once**, rerank **once** on the fused list. Never rerank per sub-query.
- Every stage gets a timeout and a defined degrade path (timeout on rewrite -> use original query; timeout on rerank -> fused order). Return partial results rather than failing.
- Voice: allow only (a) a small-model history rewrite already present, (b) hybrid retrieve, (c) rerank with a hard 300-400 ms timeout, optional. No HyDE, no multi-query, no decomposition. Make the per-path allow-list explicit config.
- HHEM and any scoring run after the stream completes (async), never in the answer path. Message metadata is updated afterwards, so the persistence path needs an update-by-message-id step.
- Log per-stage latency in `[Document Search]`-style structured logs (not console spam) so regressions are visible.

**Warning signs:** TTFT p95 creeping up per PR; voice overlay stuck in three-dot state longer; 504/timeout rate on chat route; rerank API bill growing faster than traffic.

**Phase to address:** `P-EVAL` (measure), `P-QUERY` and `P-RANK` (budgeted implementation), voice-specific check in `P-FINAL`.

---

### Pitfall 5: Re-embedding by re-parsing (cost, drift, metadata loss)

**What goes wrong:**
The obvious route is to extend `scripts/rag/reprocess-documents.js`, which re-runs parsing. For an embedding switch this re-calls LlamaParse (paid), may produce different chunk boundaries (so chunk ids, citations and golden-set labels change), re-captions images via GPT-4o (paid), and drops Nango/crawler metadata (dates, financial fields) that only exist on the originally ingested rows because the two ingestion paths set different metadata.

**Why it happens:** "Re-process" and "re-embed" are conflated.

**How to avoid:** Two separate jobs. **Re-embed** reads existing `document_chunks.content` (and image caption text), embeds with the new model, and writes only the new vector column; chunk ids and metadata are untouched. **Re-parse** (parser or chunking change) is a different, explicit job that creates new chunk versions via the versioning mechanism (Pitfall 6). The re-embed script needs checkpointing, dry-run with cost estimate, per-batch verification (dimension, no NaN, norm), and resumability keyed by `(chunk_id, model_id)`. Handle "document changed while migration running" by comparing `content_hash` at write time and skipping stale writes.

**Warning signs:** Migration cost estimate includes parser calls; chunk counts differ before/after; image chunks lose `metadata.image_url`.

**Phase to address:** `P-EMB`.

---

### Pitfall 6: Dedup and versioning that leak, lose data, or leave a retrieval gap

**What goes wrong:**
- Cross-tenant dedup: hashing content globally and reusing the existing chunk row lets tenant B inherit tenant A's chunk (breaks RLS, deletion, and also leaks existence via "already uploaded"). Dedup scope must include the tenant.
- Hashing the wrong thing: raw file bytes change on re-export (PDF metadata/timestamps) so identical content is not deduped; parsed-text hashes change when the parser changes (LlamaParse vs Docling fallback), so the same file re-uploaded after a fallback is "new". Chunk-level dedup across documents removes legitimate repeated boilerplate and the second document silently loses its citation.
- "New version replaces old" identified by filename: two different `report.pdf` files get merged; or a connector's renamed file is treated as new. For Nango/crawler the stable external id (file id/URL) must be the version key; for uploads, prefer explicit user confirmation when similarity is ambiguous.
- Non-atomic replacement: delete-old-then-insert-new leaves a window where the document does not exist (false refusal) and, with the external stores, a longer window until sync catches up; insert-new-then-delete-old leaves both versions retrievable and contradicting each other.
- Hard-deleting old chunks that past messages cite breaks stored citations (Pitfall 9).
- Nango/crawler re-syncs that re-embed unchanged files because the hash check happens after embedding.
- Two ingestion paths (`process-document` route and `document-processor.ts`) implementing dedup/metadata differently: the "unified metadata" requirement fails the first time someone fixes one path.

**How to avoid:** One ingestion service module used by both paths (and by the sidecar callback). Hash tiers: `file_sha256` (upload-level, per tenant), `content_hash` of normalised parsed text per document, `chunk_hash` only for within-document dedup and for skipping unchanged chunk re-embeds. Unique constraint `(tenant_scope, external_id|file_key, version)`. Versioning is flip-based: new version chunks inserted with `is_current = false`, embedded and synced, then a single transaction flips `is_current` and marks old chunks `superseded_at` (soft); retrieval filters `is_current`. Garbage-collect superseded chunks only when no message references them (or snapshot the cited text into the message). Check hash before any paid call.

**Warning signs:** Same document appears twice in sources with different dates; users report "my update is not found yet"; embedding spend rises on idle connector syncs.

**Phase to address:** `P-DATA`; sync side in `P-BACKEND`.

---

### Pitfall 7: Supabase -> Weaviate/Qdrant sync that drifts (deletes, races, serverless death, re-embeds)

**What goes wrong:**
Fire-and-forget sync inside a route handler dies when the serverless function returns; deletes and replaces are not propagated (zombie vectors served, see Pitfall 1); update and delete race; re-embed writes land in the wrong collection (fixed dims); a failed batch leaves the tenant half-synced; there is no way to know.

**How to avoid:** Transactional outbox in Supabase (`vector_sync_outbox`: op, chunk_id, target_backend, model_id, attempts, status) written in the same transaction as the chunk change (trigger or ingestion service), consumed by a worker (sidecar job or scheduled function) with retries, dead-letter state and idempotent upserts using deterministic point ids (e.g. UUIDv5 of chunk id + model id). Deletes are first-class outbox ops, plus delete-by-filter on tenant/document/version for bulk removals (doc replace, user/org delete). A reconciliation job compares per-tenant counts and an id-set checksum between Supabase and each backend and enqueues repairs. Sync lag SLO surfaced in `index_state` (Pitfall 2). pgvector remains written synchronously so the default path never waits on external sync.

**Warning signs:** Outbox rows stuck in `pending`/`failed`; count mismatch; user finds a deleted document still cited.

**Phase to address:** `P-BACKEND`.

---

### Pitfall 8: Multilingual (especially Chinese) keyword/BM25 silently does nothing

**What goes wrong:**
Hybrid search's keyword half quietly degrades to near-zero for Chinese, partial for Italian, and the dense half carries the whole load while the team believes it has hybrid.
- Postgres full-text with `simple`/`english` configs does not segment Chinese (no whitespace); Italian needs the `italian` snowball config and has elisions (`l'azienda`, `dell'anno`). Supabase documents PGroonga as its multilingual (CJK-capable) full-text option; zhparser/pg_jieba availability on hosted Supabase was not confirmed.
- The existing local `bm25-scorer.ts` almost certainly tokenizes on whitespace/word boundaries `[VERIFY]`; the voice path's local BM25 hybrid rerank therefore does not work for Chinese today, and it will become the "baseline" if nobody checks.
- Weaviate tokenization is configured per property, default `word`; Chinese needs the `gse_ch` tokenizer enabled via environment variable, and a community report shows GSE inflating BM25 scores for English-heavy chunks in mixed zh/en text (single-character tokens). Tokenization is per property, so one `content` property cannot be right for three languages.
- Qdrant's BM25 is sparse vectors you produce; its language-specific tokenization/stemming is not automatic for Chinese `[VERIFY: text-index `multilingual` tokenizer vs client-side segmentation]`.
- Each backend fuses differently (pgvector: our SQL; Weaviate: relativeScore by default in recent versions; Qdrant: server-side RRF/DBSF), with different alpha semantics. A "backend comparison" then measures fusion differences, not backends.
- Cross-lingual queries (Italian question, Chinese document): keyword half contributes nothing by construction; only dense retrieval and rewriting-with-translation help.
- Per-chunk language detection is unreliable on short or mixed-language chunks (tables, bilingual contracts).

**How to avoid:**
- Single shared tokenizer for all backends: segment text in one place (TS `Intl.Segmenter` with `granularity: 'word'` for zh, or jieba in the sidecar; Italian via lowercase + elision stripping + stemming) and store the result as `content_tokens` (whitespace-joined). All three backends index `content_tokens` with a plain whitespace tokenizer and the query is tokenized by the same function. This makes BM25 comparable across backends and independent of hosted-extension availability. Choose the exact segmenter in a `P-DATA` spike with a Chinese retrieval test.
- Store `language` per chunk and per document (document-level majority vote, chunk-level only when confident) and expose it as a filter and an eval slice.
- Use one fusion algorithm implemented the same way for all three backends (fetch top-N dense + top-N sparse separately, fuse in the gateway with RRF) unless the spike shows native fusion is equivalent; otherwise report backend comparisons with fusion held constant.
- Eval slices per language and a keyword-sensitive subset (exact terms, codes, numbers, Chinese multi-character terms); gate on the zh slice individually.
- Treat the voice-path local BM25 as part of the baseline and fix its tokenizer when unifying retrieval.

**Warning signs:** zh slice Recall@k much lower than en/it with hybrid on; hybrid == dense-only results for zh queries; BM25 scores near zero or uniform for zh.

**Phase to address:** `P-DATA` (tokenizer + `content_tokens`), `P-BACKEND` (per-backend indexing), eval slices from `P-EVAL`.

---

### Pitfall 9: Citation-ID drift, and the Claude Citations vs structured-output conflict

**What goes wrong:**
- Chunk ids shown to the model are UUIDs; models mangle or invent them. IDs in the prompt differ from IDs persisted, so rendered citations point at the wrong source or nothing.
- Chunk ids change on re-chunk/re-embed/new version (Pitfalls 5, 6); old messages' citations dangle.
- Reordering (lost-in-the-middle placement), compression, or dedup after id assignment shifts what `[2]` means.
- Streaming splits markers (`[1`, `2]`) across deltas; a naive regex either misses or garbles them.
- Claude path (direct Anthropic API with Citations) returns citation objects with indexes into the `search_result`/`document` blocks you sent (and `cited_text` that is not billed as output tokens); the other path returns model-written markers. Two shapes persisted two ways = UI branching and bugs. Anthropic citations cannot be combined with structured outputs (400 error), so a "structured citation list" cannot be generated on the Claude path. Citation blocks cannot be prompt-cached directly (source documents can). Via OpenRouter the Citations feature is unavailable, so the Claude path needs the direct API, new `ANTHROPIC_API_KEY`, and a mapping from OpenRouter model ids to Anthropic ids that must stay in sync across the five model-config locations.
- Existing behaviour to preserve: sources, `webSearch` results, and `source_images` survive streaming and message persistence. New citation fields are a third thing that can fall off the persistence path.
- ID namespaces collide between document chunks and Exa web results.

**How to avoid:**
- Request-scoped short aliases (`[1]..[n]`) assigned **after** final ordering/compression, mapped server-side to stable `chunk_id` + `document_id` + `version` + page/section, and persisted with the message together with a snapshot (doc name, version, page, excerpt). Old messages render from the snapshot, never from live chunk lookups.
- Soft-supersede old chunks (Pitfall 6); never hard-delete chunks referenced by a message until snapshotted.
- Post-validate generated citations: drop any alias not in the request's map; log `invalid_citation_rate` as an eval/CI metric.
- Normalise both paths into one persisted `citations[]` schema (`{alias, chunk_id, doc_id, span?, cited_text?}`) behind one adapter; the UI only reads that schema.
- Claude path: build one `search_result` block per chunk (source = doc/version URI, title), enable citations on all of them (do not mix enabled/disabled documents), no `output_config.format` on that call. Other models: structured output (or well-delimited markers) for the citation list. Make the "structured output where possible" requirement explicitly path-dependent in requirements.
- Use a streaming-safe marker parser with a small look-behind buffer; add a contract test that feeds token-split marker streams.
- Prefix namespaces: `doc:`, `web:` aliases or separate numeric ranges.
- Spike whether Vercel AI SDK 6.0.3 surfaces Anthropic citations in its message/source parts or whether the route must consume the provider stream directly `[VERIFY]`; the SDK is pinned pre-stable and the streaming path has no tests.

**Warning signs:** Citation click opens the wrong passage; `invalid_citation_rate` > 0; old conversations lose source panels after a re-embed; 400s from Anthropic on citation calls.

**Phase to address:** `P-GEN`; alias/snapshot schema decided in `P-DATA` (ids, versions, page metadata); streaming contract tests in `P-EVAL`.

---

### Pitfall 10: Rerank thresholds and refusal calibrated on the wrong thing

**What goes wrong:**
- Using RRF fused scores for refusal (rank-based, not comparable to anything). RRF scores say nothing about relevance.
- Reranker scores are provider-specific (Cohere vs Voyage, and between model generations), not calibrated probabilities, and shift by language and query length. One global threshold over-refuses in one language and under-refuses in another. Switching reranker provider invalidates the threshold.
- Threshold tuned on the same 50-200 golden items that report success (Pitfall 12).
- "Retrieve more, rerank, cut" with larger candidate lists multiplies cost and latency (Pitfall 4); Cohere rerank has per-search billing and document-count/length limits, Cohere trial keys are rate-limited `[VERIFY]`.
- Reranker input: the text reranked must be what the model will actually read (display text vs contextualized embed text); mismatches cause good chunks to be cut.
- "Compression" by LLM paraphrase breaks verbatim citations and destroys tables; faithfulness scores rise artificially while evidence integrity falls.
- Lost-in-the-middle reordering fights with source ordering in the UI.
- Reranker unavailable -> missing scores treated as low scores -> mass refusals (Pitfall 2).

**How to avoid:** Threshold stored per `(reranker_provider, model, language)` and calibrated on the dev split by sweeping to a target false-refusal vs false-answer operating point; re-run on any reranker/embedding change. Refusal uses reranker score; if no reranker score is available, fall back to a conservative rule (top dense score above model-specific cutoff and keyword hit) but never refuse purely on absence of score. Use extractive compression only (sentence/span selection preserving verbatim text and table rows) and evaluate with and without; skip it for tables. Order after rerank then assign citation aliases (Pitfall 9). Top-k numbers come from an eval sweep, not guesses; document the sweep.

**Warning signs:** Refusal rate swings by language; threshold changes with every provider change; answers cite spans not present verbatim.

**Phase to address:** `P-RANK`, calibration protocol defined in `P-EVAL`.

---

### Pitfall 11: LLM-judge eval instability, cost, and a harness that does not test the real system

**What goes wrong:**
- Judge noise: even at temperature 0, judge scores vary between runs and with judge-model version updates; with 50-200 items split across three languages and several slices (tables, scans, multi-turn, no-answer), each slice has 10-40 items, so a 3-5 point swing is noise. A hard absolute threshold in CI flakes; teams then loosen or disable the gate.
- Judge-language bias and prompt language: Ragas metrics default to English instructions; for non-English the docs say to adapt prompts (and for Faithfulness both the statement-generator and NLI prompts), with instructions translated only if `adapt_instruction=True`. Un-adapted zh/it runs are measuring something else. Ragas' original validation was English-centric.
- Self-preference: Claude drafts the questions, Claude may generate answers, Claude may judge. Use a judge from a different family than the generator under test, pinned to an exact version.
- Cost: Faithfulness/Context metrics are multi-call per item; 200 items x ~6 LLM metrics x PR frequency is expensive and slow. Quota/provider outages then fail CI for unrelated reasons.
- Default-judge surprises: DeepEval and Ragas default to an OpenAI judge unless you configure one; a missing key silently changes provider or crashes in CI. Both frameworks send anonymous/telemetry data by default (DeepEval opt-out env `DEEPEVAL_TELEMETRY_OPT_OUT`, Ragas `RAGAS_DO_NOT_TRACK`) `[VERIFY: names]` and the golden set contains real documents.
- Retrieval metrics (Recall@k, MRR) need gold chunk labels; if gold labels are chunk UUIDs they all break the first time chunking, versioning, or the parser changes. Eval then measures label rot.
- Harness drift: if the eval calls a re-implementation of retrieval rather than the production code path, a green eval proves nothing. If it calls production through the public chat route, it cannot see retrieved chunks. The baseline must come from the same entry point every later phase uses.
- CI has no corpus: it cannot hit production Supabase. Without a fixture corpus and ephemeral DB/vector stores the gate cannot be deterministic.
- The eval entry point is itself a data-exfiltration surface (returns chunks for any tenant) if exposed unauthenticated.

**How to avoid:**
- Tiered gating. Tier 1 (every PR, no LLM): deterministic retrieval metrics Recall@k/MRR/nDCG on gold labels, refusal-rate and false-refusal on no-answer/known-answer items, citation validity, latency, config-schema check, tenant canary tests. Tier 2 (nightly or label-triggered): LLM-judge Faithfulness/Answer Relevance/Context Recall with n=3 repeats, bootstrap confidence intervals, judge outputs cached by `(item_id, answer_hash, judge_version)`. Gate on paired difference vs baseline with tolerance (regression > CI width), not on absolute scores. Report per-language slices but gate only slices with enough items; the rest are advisory.
- Anchor gold labels to `(document identity, page/section, answer-bearing text span)` and resolve to current chunk ids at run time by text-span match, so re-chunking does not invalidate them.
- A headless, authenticated eval entry point (shared secret, off in production by flag, uses `TenantScope`) that runs the exact production retrieval+generation module and returns retrieved chunks, scores, stage latencies, and the effective config. Record a config hash in every result file; a run without it is not comparable.
- Fixture KB for CI: small synthetic/redacted corpus (trilingual) ingested into ephemeral Postgres+pgvector (and Weaviate/Qdrant containers for Tier 1 backend tests). Customer data never in repo (AGENTS.md rule); private real-doc golden set lives outside git and runs from the nightly job with secrets.
- Pin judge model/version and use a different family from the generator; set telemetry opt-outs; configure the judge explicitly in code; fork PRs do not get secrets, so Tier 2 cannot run there by design.
- Adapt Ragas prompts per language and spot-check 20 judged items per language by hand to confirm judge agreement before trusting any slice.

**Warning signs:** Gate flips red/green on re-run of the same commit; zh Faithfulness differs wildly from en with no system change; eval green but production regressions; CI bill growth; baseline cannot be reproduced.

**Phase to address:** `P-EVAL` (everything above); revisit tier boundaries in `P-FINAL`.

---

### Pitfall 12: Golden-set contamination and overfitting

**What goes wrong:**
- Questions drafted by Claude directly from document text share vocabulary with the source, inflating BM25/hybrid and making retrieval look easier than real user questions; Ragas-synthesized questions are often unnatural and skew toward single-hop.
- The same 50-200 items are used to tune top-k, thresholds, fusion weights, prompts, and then to report improvement. Each tuning knob "wins" on noise.
- Reviewer fatigue: "user reviews each item" degrades after ~30 items; errors in gold answers become the benchmark.
- Translation-generated zh/it questions are stilted and under-test real phrasing; cross-lingual items (query language != document language) are forgotten.
- No-answer questions that are actually answerable from general knowledge (so a strict-mode refusal looks "wrong") or are actually answered somewhere in the corpus (label error).
- Golden docs change (new versions, Pitfall 6) and gold answers go stale.
- Few-shot examples in prompts or HyDE/rewriter prompts copied from golden items (leakage).
- Privacy: real customer documents in questions/answers committed to git.

**How to avoid:**
- Freeze a split on day one: dev set (tune freely, about 60-70%) and locked test set (about 30-40%, touched only at phase gates and final regression). Record item provenance (`drafted_by`, `reviewed_by`, `source_doc_hash`, `type`, `language`, `multi_turn`). Never tune on the locked split; keep a count of how many times it has been evaluated.
- Paraphrase pass: instruct the drafter to avoid copying source phrasing and add terse/keyword-style and noisy-user-style variants; include some real user queries from logs (redacted) if available.
- Sampling plan with minimum counts per slice (language x type: table, scan, exact-term, multi-turn, compound, no-answer, cross-lingual); say up front which slices are statistically too small to gate.
- Review protocol: reviewer sees question + gold passage + answer; review in batches with a checklist, and a second spot-check of 10-20%; no-answer items verified by searching the corpus (keyword + semantic) before acceptance.
- Version the golden set with the `content_hash` of each source document; flag items stale when the document version changes.
- Keep prompts free of golden items; add a scripted check that no golden question appears in any prompt file.

**Warning signs:** Large dev-vs-test gap; each phase shows gains but real users do not notice; items with near-verbatim overlap with source (measure n-gram overlap and report it).

**Phase to address:** `P-EVAL`; locked-set discipline enforced at every phase gate and `P-FINAL`.

---

### Pitfall 13: Sidecar availability, latency, and security treated as an afterthought

**What goes wrong:**
- The sidecar becomes a single point of failure for ingestion (Docling), post-answer scoring (HHEM), and eval. Docling and HHEM models are large downloads and slow cold starts; first request after deploy times out; torch memory causes OOM kills; Docling on CPU can take minutes for scanned PDFs, longer than Vercel's 60 s function cap, so a synchronous HTTP call from the route fails mid-ingest leaving half-written documents.
- HHEM latency (about 1.5 s for a 2k-token input on CPU per the HHEM-2.1-Open card) in the answer path adds directly to TTFT.
- Fallback semantics: "LlamaParse fails -> Docling" fails silently when the sidecar is also down; the document is marked processed with zero chunks, or garbled output from a failed OCR is ingested. Fallback parsers produce different structure (page numbers, heading hierarchy), so metadata and dedup hashes diverge by parser.
- Auth: shared secret compared with `===` (the existing internal voice API has this flaw), sidecar reachable from the public internet on Fly/Koyeb/Railway, accepts arbitrary URLs/paths (SSRF/file read), logs document text. Eval endpoints reachable from production traffic.
- No version pinning of models; a rebuild pulls a newer HF revision and scores/chunks change between runs.

**How to avoid:**
- Ingestion via async job: route enqueues `(document_id, parser, status)` in Supabase, sidecar (or worker) processes and calls back / is polled; document states `queued|parsing|embedding|ready|failed` with retry counts; UI shows state. No synchronous Docling call inside a request handler.
- Chat path never waits on the sidecar. HHEM is post-stream; sidecar down => score `null` ("unscored"), never "reliable". Circuit breaker + short timeouts + health endpoint including model-loaded status; readiness probe only passes after models are loaded (bake models into the image or a persistent volume; pin revisions).
- Parser fallback chain explicit and recorded: `parser_used`, `parser_version`, `fallback_reason` in chunk/doc metadata; if all parsers fail the document goes to `failed` with an actionable message, never `ready` with empty content. Normalise Docling and LlamaParse outputs into one intermediate schema before chunking (pages, headings, tables, language).
- Security from day one (project requires auth on all new endpoints): HMAC or bearer secret with `crypto.timingSafeEqual`, secret rotation, allow-list of caller, no URL fetching in sidecar (upload bytes or signed storage URL validated against the Supabase storage host), size/page limits, no document text in logs, separate internal network where the host allows. Sidecar organised like `voice-agent/` and `baileys-whatsapp/` with own Dockerfile and `.env.example` using obvious placeholders.
- Contract tests for the TS client (timeouts, error mapping) with a stub sidecar.

**Warning signs:** Documents stuck in `parsing`; cold-start 504s after deploy; chat latency rises when sidecar is slow; documents `ready` with 0 chunks.

**Phase to address:** `P-EVAL` (sidecar skeleton, auth, health, job model), `P-DATA` (Docling job path), `P-GEN` (HHEM async).

---

### Pitfall 14: HHEM score shown to users without language support or calibration

**What goes wrong:**
Self-hosted HHEM-2.1-Open is English-tagged; HHEM-2.3 is API-only; Italian is in neither. Scoring Italian/Chinese answers with an English model yields arbitrary scores, producing false "possibly unreliable" banners (user trust erosion) or false reassurance. Long concatenated contexts, premise/hypothesis order, and per-sentence vs whole-answer scoring all change results. The project decision "log only, do not block" is right, but the UI warning needs a threshold that does not exist yet (the stated plan is to observe first).

**How to avoid:** Phase-level decision (spike) among: (a) Vectara's hosted HHEM-2.3 API (supports zh but not it; data leaves the system, add to privacy list), (b) HHEM-2.1-Open for English-only gating, (c) an LLM-judge faithfulness check for unsupported languages, or (d) log-only for unsupported languages. Record `hhem_model`, `hhem_version`, `language_supported` with each score. Show the UI warning only for supported languages and above a threshold calibrated on the golden set (labelled supported/unsupported answers); ship the banner behind a flag labelled experimental until calibrated. Premise = the exact context shown to the model (post-compression); hypothesis = the answer sentences (score per sentence, aggregate by min or fraction below cutoff). Run post-stream and update message metadata.

**Warning signs:** Score distribution identical across languages; most Italian answers flagged; scores unrelated to human-labelled faithfulness on the golden set.

**Phase to address:** `P-GEN` (spike first), calibration against `P-EVAL` data.

---

### Pitfall 15: Query-transform quality traps (rewrite, multi-query, HyDE, decomposition, RRF)

**What goes wrong:**
- History-aware rewrite: drops exact identifiers/numbers/dates the existing adaptive thresholds and boosts key on; switches language (Chinese question rewritten into English, hurting zh BM25 and lexical match); invents constraints; rewrites a standalone question unnecessarily. The existing query-type detection (date/financial/exact) must run on the original **and** rewritten query or the boosts vanish.
- HyDE: invents a plausible answer that pulls near-duplicate-but-wrong chunks, directly defeating strict-mode refusal on unanswerable questions; hurts exact-term, numeric and table queries; hypothetical document drifts into another language.
- Multi-query: variants add noise and paraphrase redundancy; N-times cost; near-identical variants add no recall.
- Sub-question decomposition: over-splits simple queries; sub-answers needed for the final synthesis are not stitched together; each sub-question may need its own filters (date/type), and citations must still map to chunks.
- RRF: with different list lengths and a default constant of 60 it flattens genuinely strong top hits; it discards score magnitude, so refusal/threshold cannot use it (Pitfall 10); weights between original query and variants are implicit.
- LangChain.js / LlamaIndex.TS parity: not every Python abstraction (`create_history_aware_retriever`, `SubQuestionQueryEngine`, `QueryFusionRetriever`) has a maintained TS equivalent; adopting a framework wholesale adds a fourth parallel retrieval stack to a repo that already has duplicates `[VERIFY: TS availability]`.

**How to avoid:** Each transform is an independently flagged, independently evaluated step with an eval-proven default (off unless it improves its target slice without regressing others). Preserve original query: always include the original query as one retrieval variant with higher RRF weight. Rewriter prompt: keep language of the user, keep all numbers/names/dates verbatim, return original if already standalone. HyDE only for descriptive/vague queries and never for exact-term/numeric detection, and disabled in strict-mode unanswerable-prone paths until eval shows it does not raise false-answer rate. Decompose only on detected compound questions, cap sub-questions (e.g. 3-4). Implement the (small) algorithms in TS inside the single retrieval module in preference to importing frameworks; the sidecar is for Python-only needs, not for latency-critical query steps. Include multi-turn and compound questions in the golden set (already planned) and report them as separate slices.

**Warning signs:** Rewriter output language differs from input; false-answer rate on no-answer items rises after enabling HyDE; recall unchanged but cost up after multi-query.

**Phase to address:** `P-QUERY`.

---

### Pitfall 16: Config drift across the five locations (and new provider switches)

**What goes wrong:**
The repo already requires synchronized edits to `.env.local`, `scripts/init-env.js`, `src/lib/env.ts`, `scripts/config-server.js`, and three fallback arrays in `scripts/config-ui/index.html`; drift is "likely and silent" (`CONCERNS.md`). This milestone adds dozens of settings (embedding provider/model/dimension, backend, reranker, per-feature toggles and budgets, thresholds, sidecar URL/secret, Anthropic key, Weaviate/Qdrant URLs/keys, judge model) plus new model ids (direct Anthropic ids). A key missing from `init-env.js` means fresh installs run with `undefined`; a toggle present in Config UI but not read in `env.ts` does nothing; eval runs are irreproducible because the effective config is not recorded. Also: a global backend/embedding switch interacts with per-tenant sync state (Pitfall 2); new Config UI controls that write secrets through the unauthenticated `/api/config/*` routes would extend the existing exposure.

**How to avoid:**
- One RAG config manifest (key, type, default, secret?, description, per-tenant vs global, UI group) as the source of truth; a check script (`npm run check-config`) diffs it against `init-env.js`, `env.ts`, `config-server.js`, and the Config UI arrays and exits non-zero on mismatch; run in Tier-1 CI. Do the same for the model arrays (`CONCERNS.md` already recommends a diff check).
- Validate config at boot with a schema (fail fast on unknown embedding model/dimension combos, a backend selected without credentials, a threshold without model calibration).
- Effective-config snapshot + hash logged with every eval run and attached to message metadata (retrieval version tag) for debugging.
- Switches follow the existing `USE_*_PROVIDER` pattern; defaults keep current behaviour (flag-off = today). New endpoints (including Config UI endpoints for these keys) require auth from the start (explicit project constraint).
- Thresholds/top-k defaults live in committed defaults updated from eval results, not only in `.env.local`.

**Warning signs:** `git grep` for a new env key finds it in fewer than four of the places; fresh `npm run dev` env lacks a key; two machines produce different eval scores on the same commit.

**Phase to address:** `P-EVAL` (check script + manifest, since every later phase adds keys), `P-FINAL` (Config UI completeness).

---

## Moderate Pitfalls

### Pitfall 17: pgvector filtered HNSW returns too few (or zero) rows
**What goes wrong:** HNSW returns about `ef_search` (default 40) candidates and the `WHERE user_id/organization_id/type/date/source` filter is applied afterwards, so small tenants or selective filters get fewer rows than requested, sometimes none. New date/type/source filters make this worse; strict mode then refuses (Pitfall 2).
**Prevention:** pgvector 0.8 iterative index scans (`hnsw.iterative_scan`, off by default) `[VERIFY version on the project]`; raise `ef_search` per query; partial indexes or partitioning for the largest tenants; add a recall-vs-filter-selectivity test to the eval fixture; include filtered queries in the golden set.
**Phase:** `P-EMB`/`P-BACKEND`.

### Pitfall 18: Docling chunking/parsing configuration mismatches
**What goes wrong:** HybridChunker's token limit uses a tokenizer; if it is not the embedding model's tokenizer (or a conservative proxy), chunks are silently truncated at embed time or are too small. Repeating table headers inflates every table chunk. OCR defaults are English-oriented; Chinese and Italian scans need explicit OCR languages. The text to embed (heading-contextualized) differs from the text to display/cite; BM25/reranker/citation each need a consistent choice. Docling vs LlamaParse differ in page/section metadata.
**Prevention:** Set `max_tokens` below the smallest context among the active embedding models and the reranker, measured with the model's own tokenizer; store `content` (display) and `embed_text` (contextualized) separately and use `content` for citations; configure OCR languages from document-language detection; golden-set slices for scans and tables evaluated per parser; compare parsers on the same documents before enabling Docling as primary.
**Phase:** `P-DATA`.

### Pitfall 19: Document-type auto-detection used as a hard filter or as a trigger for expensive paths
**What goes wrong:** Misclassification (a scan detected as text, a contract as report) produces empty/poor chunks; using `doc_type` as a hard retrieval filter makes misclassified documents invisible; changing type after upload updates metadata but not chunking.
**Prevention:** Detection is a suggestion plus user confirmation; scan/low-text-density heuristics trigger OCR path; treat type as a soft boost unless the user or classifier explicitly filters; a type change enqueues a re-parse job (versioned) not an in-place update; per-type eval slices.
**Phase:** `P-DATA`.

### Pitfall 20: Fusion/quantization defaults make backend comparison meaningless
**What goes wrong:** Weaviate and Qdrant defaults for quantization (PQ/SQ/binary), HNSW parameters, and fusion differ from pgvector's `m=64, ef_construction=200`; comparing them measures configuration differences. The "default backend decided by eval" decision is then arbitrary. Managed-store cost and data-residency are also not in the comparison.
**Prevention:** Hold embeddings, tokenization, fusion, filters, candidate counts constant; match recall targets (equal ef/recall) before comparing latency; record each backend's index parameters in the config snapshot; include cost and operational burden in the decision; keep pgvector default unless a backend wins beyond CI width on the test split.
**Phase:** `P-BACKEND`, decision in `P-FINAL`.

### Pitfall 21: New tenant-sensitive data leaves the trust boundary
**What goes wrong:** Document text now goes to Qwen3 hosting, Voyage, Cohere, Weaviate/Qdrant clouds, Vectara (if HHEM API), and LLM judges. Multi-tenant orgs may have contractual limits; logs may capture content.
**Prevention:** Inventory of every third party receiving content, region and retention/no-training terms confirmed per vendor, per-tenant opt-out for external vector stores/rerankers where required, no content in logs, eval corpora only synthetic or private.
**Phase:** `P-EMB`, `P-BACKEND`, `P-RANK`.

### Pitfall 22: `ignoreBuildErrors: true` plus no tests meets a 4,500-line route
**What goes wrong:** New retrieval code piled into `src/app/api/chat/route.ts` (about 4,500 lines, about 830 `any` in `src/`) cannot be reviewed or tested; flipping `ignoreBuildErrors` to false in the same milestone blocks all work; type errors in new code are invisible.
**Prevention:** Put the pipeline in `src/lib/rag/` modules with strict types behind one function the three entry points call; route changes limited to calling it. Add a type-check ratchet (`tsc --noEmit` baseline error count may only decrease; zero errors required in new files) rather than all-or-nothing. Write characterization tests before changing behaviour: strict "information not available", `webSearch` + strict, `source_images` streaming, `{{context}}` placeholder, voice and embed paths returning the same retrieval output.
**Phase:** `P-EVAL`.

### Pitfall 23: Parallel retrieval stacks multiply
**What goes wrong:** `bm25-scorer.ts`, `adaptive-retrieval.ts`, `retrieval-strategies.ts`, `optimized-search.ts`, `query-enhancer-local.ts`, `reranker-local.ts` already exist unused; the new module becomes the fifth; voice keeps its own local BM25 rerank.
**Prevention:** Decide up front: reuse or delete each (document in the plan); one `retrieve()` for text, embed, voice with per-path stage allow-lists; remove dead modules after the new path passes baseline comparison.
**Phase:** `P-EVAL` (decision), `P-QUERY`/`P-RANK` (execution).

### Pitfall 24: Image RAG regressions during embedding/rerank changes
**What goes wrong:** Image chunks (caption text, `metadata.image_url`) get re-embedded, reranked and compressed like text; `source_images` stops appearing or captions are re-generated (cost) or cited as sources (the product shows images above the answer, not as citations).
**Prevention:** Re-embed from stored caption text only; metadata preserved; image chunks flagged and excluded from compression and citation numbering; regression test asserting `source_images` still streams and persists.
**Phase:** `P-EMB`, `P-GEN`.

---

## Minor Pitfalls

### Pitfall 25: Qwen3 / Voyage API details
Batch-size and per-request token limits, rate limits on third-party hosts, per-provider parameter differences (`dimensions`, instruction handling). Prevention: provider adapter with batching/backoff, explicit parameter capability table per provider, tests for the query-prefix and `input_type` handling.

### Pitfall 26: Local diagnostics scripts go stale
`scripts/rag/*` diagnostics and `npm run test-rag` are known broken/unmaintained. Prevention: fix or delete as required by the project; do not add new checks there; fold useful checks into the CI Tier 1 suite.

### Pitfall 27: Log spam and PII in new code
About 2,270 `console.log` calls already exist; new multi-stage pipeline logs per stage per request will add more and may include queries/chunk text. Prevention: route through `src/lib/logger.ts`, structured one-line per request with ids and timings, no content.

### Pitfall 28: Non-cancellable work on abandoned requests
Barge-in (voice) and client aborts leave rewrite/retrieve/rerank calls running and billed. Prevention: propagate `AbortSignal` through all stages.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| `ALTER COLUMN ... TYPE vector(N)` in place for the new model | One migration, no dual-write | Table rewrite and lock, no rollback, mixed-model window | Never on production data |
| Fire-and-forget external-store sync in route handlers | Fast to build | Lost writes/deletes on serverless, zombie vectors, cross-tenant exposure after revocation | Never; outbox from day one |
| Gold labels as chunk UUIDs | Simple Recall@k | All labels rot on any re-chunk/re-embed/version | Never; use doc+span anchors |
| Absolute-threshold CI gate on LLM-judge metrics | Easy to explain | Flaky, then ignored or disabled | Only for deterministic metrics |
| Per-backend native hybrid fusion without normalisation | Least code | Backend comparison is confounded | Only if documented as "not comparable" |
| One global refusal threshold | Simple | Wrong for 2 of 3 languages and breaks on reranker swap | MVP only, if per-language slice shows no gap |
| Synchronous Docling call from the upload route | Simple flow | Timeouts, half-written docs, blocks serverless | Only for tiny files with a hard size cap |
| Adding new retrieval code into `chat/route.ts` | No new plumbing | Untestable 4,500-line file grows | Never |
| `.env.local`-only defaults for tuned thresholds | Fast iteration | Results not reproducible, lost on fresh install | While tuning; commit final values |
| Show HHEM banner before calibration | Visible feature | Eroded user trust from false flags | Only behind experimental flag |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Qdrant | Relying on the `is_tenant` index as isolation; one shared key for everyone | Mandatory server-injected tenant filter in the adapter, read-only retrieval key, re-validate ids against Supabase |
| Weaviate | Enabling server-side vectorizer (embeds with a different model); one `content` property for 3 languages; tokenization left at `word` for zh | `vectorizer: none`, native multi-tenancy with mandatory tenant, shared pre-tokenized `content_tokens` or per-language properties |
| pgvector/Supabase | Keeping `match_documents(vector(1536))` signature; building HNSW through the pooler with default `maintenance_work_mem` | Per-model columns/functions, `halfvec`, build on a direct connection, test index build memory at real row counts |
| Qwen3-Embedding-8B host | Queries without instruction prefix; assuming `dimensions` is honoured; mixing providers for docs/queries | Prefix on queries only (model-card template), capability table per provider, pin provider+precision in `embedding_model_id` |
| Voyage-4-large / rerank | Assuming 2048 dims fits pgvector HNSW; ignoring `input_type`; default dim is 1024 | Choose dimension explicitly and record it; pass `input_type`; check truncation behaviour |
| Cohere / Voyage rerank | Per-sub-query reranking; global threshold; treating missing score as low | Rerank once on fused list; per-provider-per-language thresholds; fail-open ordering |
| Anthropic Citations | Combining with `output_config.format`; mixing citation-enabled and plain documents; routing through OpenRouter | No structured output on that call; enable on all blocks; direct API with own key and model-id mapping |
| Vercel AI SDK 6 | Assuming provider citations surface in SDK parts; streaming marker split | Spike before design; marker parser with buffer; streaming contract tests |
| HHEM | Treating HHEM-2.3 as self-hostable; applying an English model to it/zh answers | Decide hosted API vs 2.1-Open vs alternative per language; record support flag |
| DeepEval / Ragas | Default OpenAI judge, English prompts, telemetry on | Explicit judge config, language-adapted prompts, telemetry opt-out, pinned judge version |
| Docling | Chunker tokenizer not matching embedder; English-only OCR; sync call in request | Match tokenizer, set OCR langs, async job |
| Nango/crawler | Re-embedding unchanged files every sync | Hash/external-id check before any paid call |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Serial LLM calls in query pipeline | TTFT > 5 s | Gate, parallelize, per-stage timeout, budget gate in CI | As soon as 2+ transforms are on |
| Rerank per sub-query | Rerank bill and p95 multiply | Fuse first, rerank once | Multi-query/decomposition on |
| HNSW post-filter underfetch | Few/zero results for small tenants | Iterative scan, higher `ef_search`, partial indexes | Selective filters (date/type/source) or small tenants in a large table |
| HNSW build for 2048-4096-dim vectors | Build timeouts/OOM on Supabase | MRL truncation to 1024, halfvec, direct connection, off-peak | Corpus in the hundreds of thousands of chunks (test, do not guess) |
| Re-embedding without rate-limit handling | Provider 429s, partial migrations | Checkpointed batches, backoff, concurrency cap | Any non-trivial corpus |
| Sidecar cold start + large model load | First-request timeouts | Bake models, readiness probe, warm instance | After each deploy / scale-to-zero |
| HHEM in answer path | TTFT + ~1.5 s CPU for 2k tokens (HHEM-2.1-Open card) | Post-stream async scoring | Immediately |
| LLM-judge eval on every PR | Slow and costly CI | Tiered gating with caching | At first CI wiring |
| Unbounded in-memory caches for query rewrites/embeddings | Memory growth per instance | LRU caps (existing caches already unbounded) | Long-lived instances |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Tenant filter from request body or optional in adapter | Cross-tenant data disclosure (highest severity) | Server-derived `TenantScope`, adapters refuse missing scope, Supabase re-validation, CI canary |
| Stale vectors/text after delete or membership change | Deleted/revoked data still retrievable | Outbox deletes, reconciliation, read-time re-validation |
| Cross-tenant dedup or shared chunk rows | Existence leak, RLS bypass, deletion cross-effects | Tenant-scoped hash keys, no shared rows |
| Unauthenticated sidecar/eval endpoints | Data exfiltration, spend abuse | Shared secret with `timingSafeEqual`, network restriction, eval off in prod |
| Sidecar fetches arbitrary URLs / reads paths | SSRF, file read | Accept bytes or validated signed URL only |
| Document text to third parties without review | Contract/privacy breach | Vendor inventory, ZDR/no-train terms, per-tenant opt-out |
| Telemetry from eval frameworks | Golden-set data leaves the system | Opt-out env vars, review defaults |
| Customer data or real phone numbers in golden set committed | Violates AGENTS.md | Synthetic fixtures in repo; private set outside git |
| New Config UI endpoints writing secrets without auth | Extends existing unauthenticated `/api/config/*` exposure | Authenticated from creation; do not add to existing unauth routes |
| `connector_config` and admin issues in `CONCERNS.md` | Out of scope for this project but adjacent | Do not build new features on the unauthenticated admin/config routes |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| False "information not available" from infra errors | Users distrust the KB | Distinguish error/degraded from empty; fall back to pgvector |
| "Possibly unreliable" banner for unsupported languages | Alarm without basis | Language-gated, calibrated, experimental label |
| Doc-type picker with wrong auto-detect pre-filled | Wrong processing unnoticed | Show detected type with confidence; allow change; changing re-processes |
| Upload appears done but not yet searchable (async parse/sync) | "My document isn't found" | Visible status states; searchable only when `ready` and synced |
| Old conversations lose citations after re-index | Broken history | Persist citation snapshots |
| Citation numbers out of order after reordering | Confusing | Assign aliases after final ordering |
| Duplicate/Version confusion | Wrong answers from stale doc | Show version/date in sources; `is_current` filtering |

## "Looks Done But Isn't" Checklist

- [ ] **Tenant isolation:** Works for user A vs user B, but also org vs personal, null-org single-tenant, and a member removed from an org — verify with canary tests on every backend and the read-time re-validation counter at zero.
- [ ] **Backend switch:** Flag flips, but per-tenant readiness and fallback missing — verify an unsynced tenant is served by pgvector, not an empty store.
- [ ] **Embedding switch:** Documents re-embedded, but query prefix / `input_type` / dimension / threshold not updated — verify query and index `embedding_model_id` equality assertion, recalibrated thresholds, and Recall@k vs baseline on the dev split.
- [ ] **Re-embed script:** Resumable, but rollback untested — verify pointer flip back restores baseline metrics.
- [ ] **Hybrid for Chinese:** BM25 enabled, but tokenizer not segmenting — verify the zh keyword-only retrieval returns the right chunk for an exact multi-character term.
- [ ] **Dedup/versioning:** New version inserted, but old still retrievable or window with neither — verify atomic flip and old-version exclusion; verify cross-tenant hash isolation.
- [ ] **Citations:** Display works, but persisted citations break after re-chunk, or streaming splits markers — verify snapshot rendering of an old message and token-split marker test; verify Claude path persists the same schema.
- [ ] **Claude Citations:** Works in demo, but structured-output call also made — verify no 400s and no `output_config.format` on citation calls.
- [ ] **HHEM:** Score logged, but language support/calibration missing — verify per-language distribution on the golden set and that unsupported languages show no banner.
- [ ] **Rerank threshold:** Refusal works on dev set, but reranker outage refuses everything — verify fail-open behaviour and per-language thresholds.
- [ ] **Eval:** Baseline captured, but not reproducible (no config hash, judge unpinned, labels as chunk ids) — verify rerunning the baseline commit yields scores within CI width.
- [ ] **CI gate:** Gate exists, but fork PRs skip secrets / provider outage fails build — verify behaviour on both and that Tier 1 is deterministic.
- [ ] **Sidecar:** Health OK, but models not loaded or auth comparison not constant-time — verify readiness only after model load and `timingSafeEqual`.
- [ ] **Config:** Key added in `.env.local`, but missing in `init-env.js`/`env.ts`/`config-server.js`/Config UI — verify `check-config` passes in CI.
- [ ] **Voice:** Quality up, latency not measured on the voice path — verify voice budget and that disallowed stages are off.
- [ ] **Image RAG:** `source_images` still streams and persists after embedding/rerank changes.
- [ ] **Flag-off parity:** Every new flag off reproduces baseline metrics within CI width.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Cross-tenant leak found | HIGH | Disable external backends via flag (pgvector default), rotate backend API keys, purge/rebuild affected collections from Supabase, audit logs of `tenant_validation_dropped`, notify per policy, add the failing case to canary tests |
| Mixed-embedding index | MEDIUM | Flip registry pointer to the old model column (kept until soak ends), re-run backfill for affected chunks, re-run eval |
| Wrong dimension/ index build failure | LOW-MEDIUM | Drop the new index/column (old untouched), re-plan dimensions (MRL/halfvec), retry off-peak |
| Zombie vectors after missed deletes | MEDIUM | Run reconciliation, delete-by-filter, backfill outbox for missed ops, then add a test |
| Over-refusal after a config flip | LOW | Revert flag; check `index_state`; recalibrate thresholds |
| Golden-set overfit discovered | MEDIUM | Re-draft a fresh locked test set from untouched documents, re-baseline, discard tuning decisions not supported on it |
| Citation dangling in old messages | MEDIUM | Backfill snapshots from superseded chunks (if kept) or mark citations "source updated" in UI |
| Sidecar outage | LOW | Circuit breaker serves chat without scoring; ingestion jobs retry; fallback parser path |
| Config drift | LOW | Run `check-config`, regenerate from manifest |
| Eval flakiness | LOW | Move LLM-judge metrics to Tier 2, add repeats and CI-based tolerance |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1 Cross-tenant leakage | P-BACKEND (gateway/`TenantScope` introduced in P-EVAL) | Two-tenant canary tests on each backend; re-validation drop counter = 0 |
| 2 False refusals on failures | P-EVAL then P-BACKEND/P-RANK | False-refusal metric; fallback test with a killed backend |
| 3 Dimension/mixed embeddings | P-EMB | Model-id assertion; Recall@k vs baseline; rollback drill |
| 4 Latency stacking | P-EVAL (measure), P-QUERY, P-RANK | p95 per-path budgets in CI; voice allow-list test |
| 5 Re-embed via re-parse | P-EMB | Dry-run shows zero parser calls; chunk ids unchanged |
| 6 Dedup/versioning | P-DATA | Atomic flip test; tenant-scoped hash test; no-paid-call-on-unchanged-file test |
| 7 Sync drift | P-BACKEND | Outbox backlog metric; reconciliation count/checksum parity |
| 8 Multilingual BM25 | P-DATA / P-BACKEND | zh/it keyword-only exact-term tests; per-language Recall slices |
| 9 Citation drift + Citations/structured-output conflict | P-GEN (schema in P-DATA) | `invalid_citation_rate` = 0; old-message snapshot render; streaming marker test; no 400s |
| 10 Threshold/refusal calibration | P-RANK (protocol in P-EVAL) | Per-provider/language thresholds on dev set; test-set false-answer/false-refusal rates |
| 11 Eval instability/harness | P-EVAL | Rerun reproducibility within CI width; Tier 1 deterministic; config hash in results |
| 12 Golden-set contamination | P-EVAL (enforced each gate) | Locked-set discipline log; dev-test gap; n-gram overlap report |
| 13 Sidecar availability/security | P-EVAL (skeleton), P-DATA, P-GEN | Chat works with sidecar killed; readiness gating; auth tests |
| 14 HHEM language/calibration | P-GEN (spike first) | Per-language score distributions vs human labels |
| 15 Query-transform quality | P-QUERY | Per-transform slice results; flag-off parity; false-answer rate on no-answer set |
| 16 Config drift | P-EVAL (manifest/check), P-FINAL | `check-config` green in CI; fresh-install smoke test |
| 17 Filtered HNSW underfetch | P-EMB / P-BACKEND | Filtered-query recall test |
| 18-19 Docling/doc-type | P-DATA | Parser A/B on same docs; per-type slices |
| 20 Backend comparison confounds | P-BACKEND, P-FINAL | Constant embeddings/fusion/filters in comparison report |
| 21 Third-party data flow | P-EMB, P-BACKEND, P-RANK | Vendor inventory doc; per-tenant opt-out flag |
| 22-23 No tests / route size / duplicate stacks | P-EVAL | Characterization tests; type-check ratchet; module inventory decision |
| 24 Image RAG regression | P-EMB, P-GEN | `source_images` test |

## Phase-Specific Warnings (quick reference)

| Phase | Likely Pitfall | Mitigation |
|-------|---------------|------------|
| P-EVAL | Judge flake, golden-set contamination, harness not on prod path, no CI corpus, telemetry leak, sidecar skeleton without auth | Tiered gates, locked split, doc+span gold labels, authenticated eval endpoint, fixture KB, opt-outs, timing-safe secret |
| P-DATA | Chinese tokenization, dedup scope, non-atomic versioning, Docling tokenizer/OCR, doc-type as filter | Shared `content_tokens`, tenant-scoped hashes, flip-based versions, match tokenizer, soft type boost |
| P-EMB | Dim limits, mixed models, thresholds, query prefix, re-parse cost | Registry + per-model columns, dual-write, recalibrate, re-embed from stored text |
| P-BACKEND | Tenant leakage, sync drift, readiness, fusion/quantization confounds | Gateway + adapters + re-validation, outbox, `index_state`, constant comparison setup |
| P-QUERY | Latency stack, HyDE vs refusal, rewrite drops identifiers/language | Gating, voice allow-list, original-query retention, per-transform eval |
| P-RANK | Score calibration, compression breaks citations, fail-closed reranker | Per-provider thresholds, extractive-only compression, fail-open |
| P-GEN | Citations vs structured output, alias drift, HHEM language/licensing | Two-path adapter to one schema, snapshots, hosted-vs-open spike |
| P-FINAL | Config UI drift, default selection on noisy data, voice budget | `check-config`, locked-test-set regression with CIs, flag-off parity runs |

## Research Flags for Roadmap

- **Needs deeper research before planning:** `P-GEN` HHEM (hosted API vs 2.1-Open vs alternative, language coverage); `P-DATA` Chinese/Italian tokenization (Intl.Segmenter vs jieba vs PGroonga) and Docling OCR/chunker settings; `P-BACKEND` Qdrant/Weaviate BM25 tokenization and multi-tenancy limits on the chosen hosting tier; `P-GEN` AI SDK 6 handling of Anthropic citations; `P-EMB` Qwen3 host selection (dimension param, precision, rate limits).
- **Standard patterns, unlikely to need research:** outbox sync, per-model embedding registry, tiered CI gating, flag-based rollout, soft-supersede versioning.

## Sources

HIGH (official documentation, fetched this session):
- Hugging Face model card, `vectara/hallucination_evaluation_model` (HHEM-2.3 API-only; HHEM-2.1-Open Apache-2.0, English tag; language list for 2.3; ~1.5 s for 2k tokens on CPU; premise/hypothesis asymmetry): https://huggingface.co/vectara/hallucination_evaluation_model
- Anthropic Citations docs (citations + structured outputs -> 400; `cited_text` not billed as output tokens; citation blocks not directly cacheable; streaming `citations_delta`): https://platform.claude.com/docs/en/build-with-claude/citations.md
- Supabase pgvector HNSW docs (vector <= 2000, halfvec <= 4000 dims, halfvec index-expression pattern; iterative scans in pgvector 0.8): https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes
- Voyage flexible dimensions docs (2048/1024/512/256, default 1024, Matryoshka, shared space across Voyage 4 family): https://docs.voyageai.com/docs/flexible-dimensions-and-quantization
- Qdrant multitenancy docs (`is_tenant` payload index, filter required, shared shard statistics): https://qdrant.tech/documentation/manage-data/multitenancy/
- Weaviate concepts (tenant = shard with dedicated vector index; tenant limits per node): https://docs.weaviate.io/weaviate/concepts/data
- Weaviate tokenization docs (`gse_ch` etc. opt-in, per-property): https://docs.weaviate.io/weaviate/concepts/search/keyword-search ; mixed zh/en GSE issue thread: https://forum.weaviate.io/t/bm25-returns-high-scores-for-english-heavy-documents-when-query-contains-english-tokens-in-chinese-english-mxied-chunks-enable-gse/22248
- Ragas language-adaptation how-to (adapt prompts; Faithfulness has two prompts; `adapt_instruction`): https://docs.ragas.io/en/stable/howtos/customizations/metrics/metrics_language_adaptation/
- Supabase PGroonga extension doc (CJK full-text): https://supabase.com/docs/guides/database/extensions/pgroonga
- Qwen3-Embedding model card (query instruction, none for documents, 4096 dims, MRL): https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF
- Cohere Rerank 4/5 changelog (32k context): https://docs.cohere.com/changelog/rerank-v4.0 ; Voyage rerank listings: https://openrouter.ai/voyageai/rerank-3

MEDIUM / unverified (`[VERIFY]` in text): Docling HybridChunker table-header and OCR language options (docs: https://docling-project.github.io/docling/concepts/chunking/); Voyage default truncation; Qdrant multilingual tokenizer; Weaviate `indexNullState` behaviour; DeepEval/Ragas telemetry env var names; AI SDK 6 citation surfacing; TS ports of LangChain/LlamaIndex query components; zhparser/pg_jieba on hosted Supabase; Cohere rate limits.

Codebase evidence: `/home/user/myRAG/.planning/PROJECT.md`, `/home/user/myRAG/.planning/codebase/CONCERNS.md` (`ignoreBuildErrors`, no tests/CI, five-location config drift, no AbortSignal timeouts in chat route, non-constant-time internal key compare, unauthenticated config routes, unbounded caches, `maxDuration: 60`, duplicated retrieval modules, fail-open auth in multi-tenant config path).

---
*Pitfalls research for: production RAG pipeline upgrade (multi-tenant Next.js/Supabase + Python sidecar + Weaviate/Qdrant)*
*Researched: 2026-11-22*
