---
slug: phase44-scanned-slice
status: resolved
resolution: diagnosis complete (no product, gate, spec, threshold or golden change)
date: 2026-11-28
branch: debug/44-scanned
base: origin/exec/04.4-19 (3af3bca9)
classification: "BM25 score / length normalization of the fixture reranker (local_bm25 pool statistics), not of the new BM25 lexical leg; fixture fragility amplifies it"
related:
  - eval/reports/phase-04.4/min-gate-n-v2/gate.md (raw DF, FAIL on gate (b))
  - eval/reports/phase-04.4-cluster-df/ (cluster DF, same offender)
  - .planning/debug/phase42-scanned-slice-regression.md (same item, same mechanism in Phase 4.2)
  - eval/config/phase44-comparison.json (D-36/D-37 pre-registered, unchanged)
---

# Phase 4.4 gate (b) FAIL on `category:scanned` (ingest)

## Symptom

`v2-lexical-bm25-on-ingest` against `v2-default-ingest`: `category:scanned:recall_at_10` 0.9286 < 0.9800 (reference 1.0000), n = 14,
so `min_gate_n` = 10 does not exempt it. Raw DF and cluster DF give the same value (one item of 14 = 0.0714).

## Method

Scratch only (nothing under `eval/out` or `eval/reports` was written or committed):
1. Re-ran the two ingest arms with `npx tsx eval/harness/run-smoke.mts --run-config <arm> --fixture-mode ingest --no-gate`
   (the run configs are what `phase44_gate.run_config_for` builds: the base config plus `off_env` on the reference). The slice
   reproduces exactly: 14 dev items, 13 hits with bm25 and 14 in the reference.
2. Added a temporary, uncommitted dump at the end of `runRerankStage` (`src/lib/rag/v2/stages/rank.ts`), printing the 75
   rerank inputs with fused score, leg ranks, rerank text and local_bm25 score for this one query. Reverted with
   `git checkout -- src/lib/rag/v2/stages/rank.ts`; the tree is clean apart from this file.
3. Recomputed the local_bm25 scores term by term from the dumped pool, with `lexicalTokens` / `queryLexicalTokens` and the
   same K1 = 1.2 and B = 0.75. The values match the trace to 4 decimals.
4. Counter-check: both arms re-run with `RAG_RERANKER=none`.

A single-item golden (only `en-scanned-001`) does **not** reproduce the result: both arms miss there, because the ingest corpus
loses the item-specific fixture documents and the rerank pool changes. Only the full-set runs are used as evidence.

## Q1. Which item, and its rank

The item is **`en-scanned-001`**: "What is the total due on invoice INV-24-00381?". The gold span is `scanned-invoice.en.md` §Totals
(chunk `16af6005`). The other 13 items are rank 1 in both arms. `context_k` = 8, so a "hit at 10" here means rank ≤ 8.

| Arm | first hit rank | final (rerank) position of gold | local_bm25 score of gold | slot 8 holder |
| --- | --- | --- | --- | --- |
| v2-default-ingest (reference, ts_rank_cd) | **8** | 8 | 0.1437 | gold |
| v2-lexical-bm25-on-ingest | **miss** | 9 | 0.1357 | `invoice-it.pdf` `07ad5e98` (0.1411) |

The margin is 0.0026 in the reference and −0.0054 with bm25. The item sits on the context boundary in both arms. It is the same
item, on the last slot again, as in the Phase 4.2 diagnosis.

## Q2. Root cause: the fixture reranker's pool statistics

Leg ranks and fused scores of the gold chunk (the same chunk id and content in both arms):

| | dense rank | lexical rank | fused (RRF) score | fused rank in the 75 | rerank position |
| --- | --- | --- | --- | --- | --- |
| reference (ts_rank_cd) | 10 | 34 | 0.0249 | 8 | 8 |
| bm25 | 10 | **8** | **0.0290** | **7** | 9 |

- **The new BM25 lexical leg is better for this item**: lexical rank 34 → 8, fused score up, fused rank 8 → 7.
- **The order is set by the reranker.** `RAG_RERANKER=auto` with an empty `COHERE_API_KEY` resolves to `local_bm25`
  (`src/lib/rag/rerank/local-bm25.ts`). It computes df and avgdl over the 75-candidate rerank pool and normalizes by the pool
  maximum. BM25 changes which chunks fill the lexical leg: 68 of the 75 are shared and 7 differ on each side. The pool statistics
  move with them:

| pool statistic | reference | bm25 |
| --- | --- | --- |
| avgdl (tokens) | 96.77 | 71.23 |
| df(`due`) | 8 | 9 |
| df(`invoice`) | 8 | 8 |
| max raw score (header chunk `3e967fdd`, the normaliser) | 21.0768 | 19.9966 |
| gold `16af6005` raw / normalized (matches `due` only, len 22) | 3.0297 / 0.1437 | 2.7130 / 0.1357 |
| `07ad5e98` raw / normalized (matches `invoice` only, len 25) | 2.9746 / 0.1411 | 2.8211 / 0.1411 |

  The gold chunk matches one query term, `due`. One more `due` chunk in the pool lowers its IDF. The shorter pool (avgdl −26%) weakens
  the length bonus that a short chunk gets. The `invoice` chunk loses about the same as the normaliser, so its normalized score stays
  0.1411. Together, the two cross at slot 8/9.
- **Why only one term matches (fixture).** The gold text is OCR-noised by design: `Subtota1 … Tota1 due 1449.36`. `Tota1` does not
  tokenize to `total`, so the reranker sees only `due`. The scores sit in a narrow band of about 0.13–0.16, where any pool change can
  reorder them.
- **Counter-check, `RAG_RERANKER=none` (ingest, full set):** scanned is 14/14 in both arms; `en-scanned-001` is rank 8 in the
  reference and rank **7** with bm25. Without the fixture reranker, bm25 improves this item.

Classification against the listed categories:
- **BM25 score / length normalization: yes**, but in the fixture reranker `local_bm25` (pool-relative df/avgdl), not in
  `rag_bm25_search_chunks`. The new lexical leg is the trigger, because it changes the pool, but it ranks the gold higher.
- ingest chunking: **no**. The chunk ids, contents and lengths are the same in both arms, and only ingest mode shows the flip because its
  pool differs from prechunked.
- RRF fusion: **no**. The fused score and rank of the gold improve.
- identifier filter: **no**. `RAG_IDENTIFIER_FILTER=false`, `RAG_IDENTIFIER_INDEX=false` and `diversify` disabled in both arms (trace
  `effective_config`). `exact_id` only adds the header chunk, in both arms.
- fixture: **contributing**. The OCR noise leaves one matching term, and the gold sits on the last context slot in the reference.
- DF mode (raw vs cluster): **no**. `RAG_DUP_CLUSTERS` is off, and the reported cells are equal.

Same mechanism as Phase 4.2: the pool-relative local_bm25 IDF moves when the pool changes. 04.2-40's document-level identifier
filter is not involved here, because the filter is off in both arms.

## Q3. Fix options

| # | Option | Touches | Risk | D-37 / owner |
| --- | --- | --- | --- | --- |
| A (recommended) | Record the offender as a fixture-reranker boundary flip, with this evidence: lexical rank 34 → 8, fused rank 8 → 7, the rerank-none pair 14/14 in both arms. The 4.4 verdict stays FAIL as measured; the owner accepts it as not a BM25 regression. No default changes (D-51 holds; the switch stays off). | decision note only (e.g. `eval/decisions/04.4-lexical-scoring.md`) | Low. It sets a precedent for waiving a pre-registered gate cell; contained by the trace evidence and the rerank-none counter-check. | Owner decision. No D-37 re-registration, because spec and thresholds are unchanged. |
| B | Re-register gate (b) so the ingest pair also runs, or is gated, with `RAG_RERANKER=none` (or the fixture reranker is reported only). | `eval/config/phase44-comparison.json` and the cluster-DF spec | Medium. It weakens the gate post hoc, after the result was seen (T-04.4-41), and needs a new pre-registration before any rerun. | **D-37 re-registration and owner decision.** |
| C | Make `local_bm25` use stable statistics, either corpus-level df/avgdl or a frozen per-tenant table (e.g. from the 4.4 `rag_lexical_df` / `rag_lexical_corpus`), instead of pool-relative ones. | `src/lib/rag/rerank/local-bm25.ts`, rerank stage, probably a tenant-scoped stats read | High. It changes every v2 run with `RAG_RERANKER=auto` without a Cohere key (the production fallback too) and needs new baselines and calibrated refusal cells. It is the root fix for both the 4.2 and the 4.4 flips. | Its own plan, with a new pre-registered comparison; owner sign-off. Not a 4.4 change. |
| D | OCR-tolerant lexical normalization (`1`/`l`, `O`/`0` folding for scanned text), so that `Tota1` matches `total`. | tokenizer, lexical version bump, relex, refusal-cell staleness (4.2 rule) | High: broad lexical change, a cross-language literal check, and every refusal cell recalibrated. | Its own plan (Phase 3.2 / 4.2 area); owner decision. |
| E | Change the fixture or golden item (e.g. a less noisy §Totals line, or a second accepted span). | `eval/fixtures/corpus/`, `eval/golden/` | Medium: the manifest and golden sha change, every baseline is re-recorded, and it hides a real reranker weakness. | Owner decision and D-37 re-registration (golden is frozen in the pre-registration). Not recommended. |
| F | Score at `context_k` 10 or widen the context budget. | metric definition or run config | Medium. It changes every report's meaning. | D-37 re-registration and owner decision. Not recommended. |

Recommendation: **A now, and C as a separate plan.** The 4.2 and 4.4 flips of `en-scanned-001` both come from pool-relative
local_bm25 statistics. Until the reranker is stable, any change that moves the rerank pool can flip this last-slot item.
