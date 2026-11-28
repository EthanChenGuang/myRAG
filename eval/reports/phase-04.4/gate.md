# Phase 04.4 gates

Verdict: **FAIL** over off_identity, on, cap_agreement. Noise band: max(3 x spread, 0.02).

| Gate | Decision | Verdict | Offenders |
| --- | --- | --- | --- |
| off_identity | D-36 (a) | PASS | 0 |
| on | D-36 (b) | FAIL | 1 |
| cap_agreement | D-36 (c) | PASS | 0 |

## off_identity (D-36 (a))

Runs: off-prechunked, off-ingest.

| Number | Value |
| --- | --- |
| command.characterization.exit_code | 0 |
| off-ingest.nonzero_cells | 0 |
| off-ingest.retrieval_total.p95_ms | 48.0000 |
| off-prechunked.nonzero_cells | 0 |
| off-prechunked.retrieval_total.p95_ms | 29.0000 |

## on (D-36 (b))

Runs: v2-lexical-bm25-on-prechunked, v2-default-prechunked, v2-lexical-bm25-on-ingest, v2-default-ingest.

| Number | Value |
| --- | --- |
| v2-default-ingest.mrr | 0.6357 |
| v2-default-ingest.recall_at_10 | 0.7063 |
| v2-default-prechunked.mrr | 0.6455 |
| v2-default-prechunked.recall_at_10 | 0.7271 |
| v2-lexical-bm25-on-ingest.mrr | 0.6396 |
| v2-lexical-bm25-on-ingest.recall_at_10 | 0.7063 |
| v2-lexical-bm25-on-ingest.refusal_differences | 0 |
| v2-lexical-bm25-on-ingest.retrieval_total.p95_ms | 90.0000 |
| v2-lexical-bm25-on-prechunked.mrr | 0.6475 |
| v2-lexical-bm25-on-prechunked.recall_at_10 | 0.7250 |
| v2-lexical-bm25-on-prechunked.refusal_differences | 0 |
| v2-lexical-bm25-on-prechunked.retrieval_total.p95_ms | 65.0000 |

Offenders:
- v2-lexical-bm25-on-ingest: category:scanned:recall_at_10 dropped beyond the noise band (0.9286 < 0.9800, v2-default-ingest 1.0000)

Below min_gate_n (reported, not gated):
- v2-lexical-bm25-on-prechunked: category:duplicate_flood:recall_at_5 below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.7500 vs threshold 0.9800, reference 1.0000, against v2-default-prechunked
- v2-lexical-bm25-on-prechunked: category:duplicate_flood:recall_at_10 below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.9167 vs threshold 0.9800, reference 1.0000, against v2-default-prechunked
- v2-lexical-bm25-on-ingest: category:duplicate_flood:recall_at_5 below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.6667 vs threshold 0.8133, reference 0.8333, against v2-default-ingest

## cap_agreement (D-36 (c))

Runs: v2-lexical-bm25-on-prechunked, v2-lexical-bm25-on-ingest.

| Number | Value |
| --- | --- |
| v2-lexical-bm25-on-ingest.mean_overlap_at_k | 1.0000 |
| v2-lexical-bm25-on-ingest.measured | 529 |
| v2-lexical-bm25-on-ingest.min_overlap_at_k | 1.0000 |
| v2-lexical-bm25-on-prechunked.mean_overlap_at_k | 1.0000 |
| v2-lexical-bm25-on-prechunked.measured | 399 |
| v2-lexical-bm25-on-prechunked.min_overlap_at_k | 1.0000 |

## Report-only (not gated)

### `v2-lexical-bm25-on-rerank-none-prechunked` against `v2-default-rerank-none-prechunked`

RAG_RERANKER=none on both arms (plan-check finding 8): the default fixture reranker partly hides a change in lexical order, so this pair shows the fused order without it. Reported, never gated.

| Number | Value |
| --- | --- |
| v2-default-rerank-none-prechunked.mrr | 0.6407 |
| v2-default-rerank-none-prechunked.recall_at_10 | 0.7333 |
| v2-default-rerank-none-prechunked.recall_at_5 | 0.7250 |
| v2-lexical-bm25-on-rerank-none-prechunked.mrr | 0.6517 |
| v2-lexical-bm25-on-rerank-none-prechunked.recall_at_10 | 0.7354 |
| v2-lexical-bm25-on-rerank-none-prechunked.recall_at_5 | 0.7271 |

Moves:
- category:general:mrr dropped beyond the noise band (0.8684 < 0.8747, v2-default-rerank-none-prechunked 0.8947)
- category:multi_turn:recall_at_5 dropped beyond the noise band (0.4375 < 0.4800, v2-default-rerank-none-prechunked 0.5000)

## Runs

| Run | Mode | Recall@10 | MRR | Run config hash |
| --- | --- | --- | --- | --- |
| off-prechunked | prechunked | 0.6854 | 0.6497 | `0191c5718504` |
| off-ingest | ingest | 0.7259 | 0.6523 | `d7ad2fe15e2d` |
| v2-default-prechunked | prechunked | 0.7271 | 0.6455 | `536750492449` |
| v2-lexical-bm25-on-prechunked | prechunked | 0.7250 | 0.6475 | `74aecb49f320` |
| v2-default-ingest | ingest | 0.7063 | 0.6357 | `bdedd4fc4d1d` |
| v2-lexical-bm25-on-ingest | ingest | 0.7063 | 0.6396 | `103f25872cb3` |
| v2-default-rerank-none-prechunked | prechunked | 0.7333 | 0.6407 | `2ff6253bf8d3` |
| v2-lexical-bm25-on-rerank-none-prechunked | prechunked | 0.7354 | 0.6517 | `40f387930819` |

> Fixture corpus only: every gate and threshold here was committed before any on-run result was looked at (D-36, pre-registration). Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare. The default fixture reranker partly hides a change in lexical order, so the fixture shows the absence of a regression, not the size of an effect; the reranker-none pair is reported, not gated.
> Pre-registered by plan 04.4-13 before any on-run result was looked at (T-04.4-41); plan 04.4-14 runs it with python -m rag_eval.phase44_gate --spec eval/config/phase44-comparison.json --out eval/reports/phase-04.4.
> Off runs use no base run config, so they run the legacy pipeline the committed baselines were recorded with; the v2 reference runs set the same three variables explicitly to ts_rank_cd, 1.2 and 0.75 (D-36).
> No tool of this phase writes eval/config/retrieval-params.json, eval/config/refusal-thresholds.json or a refusal threshold (D-35).
