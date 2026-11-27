# Phase 04.4 gates

Verdict: **FAIL** over off_identity, on, cap_agreement. Noise band: max(3 x spread, 0.02).

| Gate | Decision | Verdict | Offenders |
| --- | --- | --- | --- |
| off_identity | D-36 (a) | PASS | 0 |
| on | D-36 (b) | FAIL | 4 |
| cap_agreement | D-36 (c) | PASS | 0 |

## off_identity (D-36 (a))

Runs: off-prechunked, off-ingest.

| Number | Value |
| --- | --- |
| command.characterization.exit_code | 0 |
| off-ingest.nonzero_cells | 0 |
| off-ingest.retrieval_total.p95_ms | 40.0000 |
| off-prechunked.nonzero_cells | 0 |
| off-prechunked.retrieval_total.p95_ms | 31.0000 |

## on (D-36 (b))

Runs: v2-lexical-bm25-on-prechunked, v2-default-prechunked, v2-lexical-bm25-on-ingest, v2-default-ingest.

| Number | Value |
| --- | --- |
| v2-default-ingest.mrr | 0.6821 |
| v2-default-ingest.recall_at_10 | 0.7511 |
| v2-default-prechunked.mrr | 0.6370 |
| v2-default-prechunked.recall_at_10 | 0.7211 |
| v2-lexical-bm25-on-ingest.mrr | 0.6821 |
| v2-lexical-bm25-on-ingest.recall_at_10 | 0.7489 |
| v2-lexical-bm25-on-ingest.refusal_differences | 0 |
| v2-lexical-bm25-on-ingest.retrieval_total.p95_ms | 82.0000 |
| v2-lexical-bm25-on-prechunked.mrr | 0.6395 |
| v2-lexical-bm25-on-prechunked.recall_at_10 | 0.7186 |
| v2-lexical-bm25-on-prechunked.refusal_differences | 0 |
| v2-lexical-bm25-on-prechunked.retrieval_total.p95_ms | 68.0000 |

Offenders:
- v2-lexical-bm25-on-prechunked: category:duplicate_flood:recall_at_5 dropped beyond the noise band (0.7500 < 0.9800, v2-default-prechunked 1.0000)
- v2-lexical-bm25-on-prechunked: category:duplicate_flood:recall_at_10 dropped beyond the noise band (0.9167 < 0.9800, v2-default-prechunked 1.0000)
- v2-lexical-bm25-on-ingest: category:duplicate_flood:recall_at_5 dropped beyond the noise band (0.6667 < 0.8967, v2-default-ingest 0.9167)
- v2-lexical-bm25-on-ingest: category:duplicate_flood:recall_at_10 dropped beyond the noise band (0.8333 < 0.8967, v2-default-ingest 0.9167)

## cap_agreement (D-36 (c))

Runs: v2-lexical-bm25-on-prechunked, v2-lexical-bm25-on-ingest.

| Number | Value |
| --- | --- |
| v2-lexical-bm25-on-ingest.mean_overlap_at_k | 1.0000 |
| v2-lexical-bm25-on-ingest.measured | 392 |
| v2-lexical-bm25-on-ingest.min_overlap_at_k | 1.0000 |
| v2-lexical-bm25-on-prechunked.mean_overlap_at_k | 1.0000 |
| v2-lexical-bm25-on-prechunked.measured | 342 |
| v2-lexical-bm25-on-prechunked.min_overlap_at_k | 1.0000 |

## Report-only (not gated)

### `v2-lexical-bm25-on-rerank-none-prechunked` against `v2-default-rerank-none-prechunked`

RAG_RERANKER=none on both arms (plan-check finding 8): the default fixture reranker partly hides a change in lexical order, so this pair shows the fused order without it. Reported, never gated.

| Number | Value |
| --- | --- |
| v2-default-rerank-none-prechunked.mrr | 0.6279 |
| v2-default-rerank-none-prechunked.recall_at_10 | 0.7186 |
| v2-default-rerank-none-prechunked.recall_at_5 | 0.7085 |
| v2-lexical-bm25-on-rerank-none-prechunked.mrr | 0.6394 |
| v2-lexical-bm25-on-rerank-none-prechunked.recall_at_10 | 0.7211 |
| v2-lexical-bm25-on-rerank-none-prechunked.recall_at_5 | 0.7111 |

Moves:
- category:multi_turn:recall_at_5 dropped beyond the noise band (0.4375 < 0.4800, v2-default-rerank-none-prechunked 0.5000)

## Runs

| Run | Mode | Recall@10 | MRR | Run config hash |
| --- | --- | --- | --- | --- |
| off-prechunked | prechunked | 0.6709 | 0.6399 | `159433c21225` |
| off-ingest | ingest | 0.7790 | 0.6924 | `83a758ea395c` |
| v2-default-prechunked | prechunked | 0.7211 | 0.6370 | `a820381624f9` |
| v2-lexical-bm25-on-prechunked | prechunked | 0.7186 | 0.6395 | `47948afd8235` |
| v2-default-ingest | ingest | 0.7511 | 0.6821 | `a5026bda525b` |
| v2-lexical-bm25-on-ingest | ingest | 0.7489 | 0.6821 | `040cb288e106` |
| v2-default-rerank-none-prechunked | prechunked | 0.7186 | 0.6279 | `acba8225f1a5` |
| v2-lexical-bm25-on-rerank-none-prechunked | prechunked | 0.7211 | 0.6394 | `5ed23e8382bd` |

> Fixture corpus only: every gate and threshold here was committed before any on-run result was looked at (D-36, pre-registration). Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare. The default fixture reranker partly hides a change in lexical order, so the fixture shows the absence of a regression, not the size of an effect; the reranker-none pair is reported, not gated.
> Pre-registered by plan 04.4-13 before any on-run result was looked at (T-04.4-41); plan 04.4-14 runs it with python -m rag_eval.phase44_gate --spec eval/config/phase44-comparison.json --out eval/reports/phase-04.4.
> Off runs use no base run config, so they run the legacy pipeline the committed baselines were recorded with; the v2 reference runs set the same three variables explicitly to ts_rank_cd, 1.2 and 0.75 (D-36).
> No tool of this phase writes eval/config/retrieval-params.json, eval/config/refusal-thresholds.json or a refusal threshold (D-35).
