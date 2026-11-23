# Phase 4: Hybrid Retrieval, Reranking & Calibrated Refusal - Discussion Log

> **Audit trail only.** Do not use this file as input to planning, research or execution agents.
> The decisions are in CONTEXT.md. This log keeps the alternatives that were considered.

**Date:** 2026-11-23
**Phase:** 04-hybrid-retrieval-reranking-calibrated-refusal
**Mode:** `--auto`. Every area was auto-selected, and every question was resolved with the recommended option (the user's standing instruction: "all questions follow your recommendations").
**Areas discussed:** Backend contract and fusion, pgvector hybrid SQL, Shared tokenizer and lexical_text, Rerankers and tiers, Candidate pool and sweeps, Context assembly, Calibrated refusal, Parent-child and chunking profiles, Cross-language paths, Switches and status, Voice and latency, Evaluation and completion

---

## Backend contract and fusion

| Option | Description | Selected |
|--------|-------------|----------|
| Backend returns per-leg ranked lists; RRF in TypeScript for all backends | Same fusion everywhere; fair backend comparison | ✓ |
| Backend fuses natively (SQL RRF, Weaviate Ranked, Qdrant RRF) | Fewer round trips; fusion differs per backend | |
| Backend returns one fused list, fusion algorithm per adapter | Hides legs from trace and tests | |

**Choice:** [auto] Per-leg lists, RRF in TS (k=60, equal weights). The interface takes `TenantScope`, the embedding profile, filters and a signal, and has `health` and `isReady(scope)` for RET-06 and RET-09.
**Notes:** The conformance suite is parametrized by a backend factory, so Phase 7 reuses it unchanged.

---

## pgvector hybrid SQL

| Option | Description | Selected |
|--------|-------------|----------|
| One RPC returning both legs, simple tsvector over lexical_text, service_role only, admin client | One round trip; RET-04 satisfied; tenant from args | ✓ |
| Two RPCs (dense, lexical) called in parallel | Two round trips per variant | |
| Keep anon-client RPC pattern with RLS | Repeats the `GRANT ... TO anon` of the legacy RPC; violates RET-04 | |

**Choice:** [auto] One `hybrid_search_chunks` (SECURITY INVOKER, revoked from PUBLIC, anon and authenticated, granted to service_role). It raises an exception on inconsistent scope arguments. Tokens are passed as `text[]`.
**Notes:** Selective filters use `RAG_HNSW_ITERATIVE_SCAN` (default off) and `RAG_EXACT_SCAN_CUTOFF` (default 0) with a bounded count. PGlite bundles pgvector 0.8.7, so CI can test both paths.

---

## Shared tokenizer and lexical_text

| Option | Description | Selected |
|--------|-------------|----------|
| App tokenizer: Intl.Segmenter words + Han bigrams, codes kept whole, NFKC, diacritic fold, Italian elision split, no stemming | Same on every backend; robust zh exact terms | ✓ |
| PGroonga for zh + `english`/`italian` tsvector configs (STACK research) | Per-engine behavior; violates RET-03 shared tokenizer | |
| Segmenter words only | Context-dependent splits miss names and terms | |
| jieba in the sidecar | Extra network hop on every query | |

**Choice:** [auto] App tokenizer, versioned, with rules as data. The Phase 3 chunk writer calls it. A resumable backfill fills it from stored text.
**Notes:** If Phase 3 creates a provisional `lexical_text` column, Phase 4 adopts it.

---

## Rerankers and tiers

| Option | Description | Selected |
|--------|-------------|----------|
| Thin fetch adapters behind a `Reranker` interface, injected via RagDeps | Recorded responses plug in; Cohere spans reachable | ✓ |
| AI SDK `rerank()` with provider packages | Extra deps; no span access | |

| Option | Description | Selected |
|--------|-------------|----------|
| Voyage `rerank-2.5` as a per-language model override (env list) | Live eval on zh and it decides | ✓ |
| `rerank-2.5` used only on errors of `rerank-3` | Errors already fall back to fused order (RNK-06) | |

**Choice:** [auto]
- Tiers: chat, embed and eval use `quality`; voice uses `fast`. Rerank timeouts are 600 ms for chat and embed and 250 ms for voice.
- Failure: the rerank stage is skipped, the fused order is kept, the result is `degraded`, and refusal is off for the request.
- `RAG_RERANKER=none` means `disabled`.

---

## Candidate pool and sweeps

| Option | Description | Selected |
|--------|-------------|----------|
| Params in a committed `retrieval-params.json` written by a sweep tool (dev split) | RNK-02 "not hard-coded" with recorded numbers | ✓ |
| Env vars with hand-picked defaults | Hard-coded in practice | |

**Choice:** [auto]
- Starting values: pool 75 per leg, cap 75, top-k 8.
- Sweep grid: pool 25/50/75/100 × top-k 5/8/10/15/20.
- The sweep picks the smallest configuration within the noise band of the best.
- Variants are searched in parallel, deduplicated by chunk ID and parent ID, and capped before rerank.

---

## Context assembly

| Option | Description | Selected |
|--------|-------------|----------|
| Extend Phase 2 assembleContext: merge adjacent, best-at-edges, tiktoken budget; format unchanged | One assembly; legacy byte identity kept | ✓ |
| New v2 assembler | Second implementation drifts | |

| Option | Description | Selected |
|--------|-------------|----------|
| Extractive compression (provider spans or local sentence scoring), never tables or images | Verbatim text for Phase 5 citations | ✓ |
| LLM summarization | Breaks verbatim citations and tables (Pitfall 10) | |

**Choice:** [auto] `RAG_CONTEXT_EDGE_ORDER` and `RAG_CONTEXT_COMPRESSION` both default off. The budget is `RAG_CONTEXT_TOKEN_BUDGET=6000`.

---

## Calibrated refusal

| Option | Description | Selected |
|--------|-------------|----------|
| Cells keyed (provider, model, query language, same/cross); only `calibrated` cells refuse | No refusal from missing calibration or scores | ✓ |
| One global threshold per provider | Over-refuses some languages (Pitfall 10) | |

| Option | Description | Selected |
|--------|-------------|----------|
| Fit on dev: max correct refusal at false refusal ≤ 0.05; check on the frozen test split | Holdout = Phase 1 test split; never fitted on | ✓ |
| Youden's J on dev | Ignores the false-refusal cost | |

| Option | Description | Selected |
|--------|-------------|----------|
| Refusal sets status `empty` (reason below_threshold) so existing per-mode mappings apply | Strict refuses; balanced/flexible get no KB context | ✓ |
| New status value `refused` | Every entry point and test must change | |

**Choice:** [auto] As in the selected rows. Minimum item counts per cell: 3 no-answer and 5 answerable on fixtures, 10 and 20 on the real set.

---

## Parent-child and chunking profiles

| Option | Description | Selected |
|--------|-------------|----------|
| Separate `document_parents` table; children in `document_chunks` with parent_id | Legacy readers never see parents | ✓ |
| Parents as rows in `document_chunks` with a role column | Legacy retrieval would start returning parents | |

| Option | Description | Selected |
|--------|-------------|----------|
| `chunking_profiles` with per-doc-type active pointer, side-by-side rebuild from stored text/parse cache | Same rollback mechanism as EMB-02/04 | ✓ |
| Re-chunk in place | No rollback | |

**Choice:** [auto]
- Presets: 128/512, 256/1024 (default) and 256/2048, plus custom values.
- The validation rules are defined once in Pydantic, with a JS parity test.
- The Config UI panel is admin-authenticated.
- A chunking sweep reports by document type, language and question kind.

---

## Cross-language paths

| Option | Description | Selected |
|--------|-------------|----------|
| queryVariants seam + translate stage; fixture translation table now, XLG-01 translator in Phase 6 | No duplicate translator | ✓ |
| Build a small-model translator in Phase 4 | Duplicates Phase 6 XLG-01 | |

**Choice:** [auto] The lexical leg and `local_bm25` use the variant in the document's language. Hosted rerankers get the original query. Switch: `RAG_LEXICAL_TRANSLATION`, default off.

---

## Switches and status

| Option | Description | Selected |
|--------|-------------|----------|
| Sub-switches all default off; v2 with everything off = dense-only through the new RPC | Matches "every new switch defaults off" | ✓ |
| v2 turns on hybrid + rerank by default | Contradicts the default-off rule; defaults belong to Phase 7 | |

**Choice:** [auto] 15 new env vars across the five config locations.
- Stage names: analyze, translate, embed, search, fuse, dedupe, rerank, refusal, expand_parents, assemble, compress.
- `RetrievalResult` gains `refusal` and `retrievalConfigHash`.

---

## Voice and latency

| Option | Description | Selected |
|--------|-------------|----------|
| Same v2 graph with voice profile: fast tier, 250 ms rerank timeout, smaller budget, no compression, no keyword fallback | One pipeline (anti-pattern 6) | ✓ |
| Keep legacy voice heuristics under v2 | Duplicates the lexical leg | |

**Choice:** [auto] Rerank budgets are added (chat p95 600 ms, voice 250 ms) and are report-only. An injected-delay test keeps voice within 800 ms p95.

---

## Evaluation and completion

| Option | Description | Selected |
|--------|-------------|----------|
| Add selective_filter, more no_answer (≥ 8/language incl. near-misses), clause items after parity; re-baseline | Calibration cells reach minimums | ✓ |
| Calibrate on the existing 4 no_answer items per language | Too few for dev + holdout | |

**Choice:** [auto]
- Completion means: legacy paired differences are zero; the recommended v2 configuration has no slice dropping beyond the noise band on Recall@k or MRR, and correct refusal improves; every switch has an on/off comparison; the conformance suite passes on pgvector.
- The shipped defaults stay off until Phase 7.

---

## Reconciliation with Phase 3 CONTEXT (read after the first draft)

Phase 3's committed `03-CONTEXT.md` was read, and the Phase 4 decisions were aligned with it. No Phase 3 decision is overridden.
- **D-04:** The new SQL goes in `supabase/migrations/` (Phase 3 D-05). The dense leg is routed by the profile's storage: the legacy column, or `chunk_embeddings` with a `halfvec` cast (Phase 3 D-34 to D-36). The filter `is_current AND status = 'ready'` applies (Phase 3 D-08). The tenant is matched on the generated `tenant_key` column.
- **D-05:** Filters read the promoted chunk columns (Phase 3 D-07). Invoice filters use the Phase 3 D-27 document columns.
- **D-07 and D-08:** The tokenizer module and the `lexical_text` column are created by Phase 3 (D-07, D-32). Phase 4 completes the tokenizer, bumps `LEXICAL_VERSION`, adds the index and builds the `rag:relex` rebuild.
- **D-21:** `ProcessingProfile.parent_child` (Phase 3 D-13) is the seed only. Re-chunking reads the stored parse output (Phase 3 D-18). The Phase 3 admin route pattern (D-45) is reused. The evals run in the `ingest` fixture mode (Phase 3 D-42).
- **D-23:** `VOYAGE_API_KEY` and `VOYAGE_BASE_URL` are reused from Phase 3 D-44. Only `COHERE_API_KEY` and `COHERE_BASE_URL` are new.
- **D-24:** The Phase 3 D-28 `exact_id_lookup` stage joins v2 as a third RRF list.

## Claude's Discretion

- File layout inside `src/lib/rag/`.
- The stopword lists and the code-token regex.
- The exact SQL shape and the exact-scan mechanism.
- Trace reason strings and Config UI wording.
- The minimum compression length and the sentence splitter.

## Deferred Ideas

- A chat UI for retrieval filters.
- Stemming for en and it.
- MMR diversity.
- Removing the legacy voice heuristics.
- Per-tenant chunking pointers.
- A true BM25 scorer in SQL.
