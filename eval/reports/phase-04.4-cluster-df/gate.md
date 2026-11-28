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
| off-ingest.retrieval_total.p95_ms | 41.0000 |
| off-prechunked.nonzero_cells | 0 |
| off-prechunked.retrieval_total.p95_ms | 19.0000 |

## on (D-36 (b))

Runs: v2-lexical-bm25-on-prechunked, v2-default-prechunked, v2-lexical-bm25-on-ingest, v2-default-ingest.

| Number | Value |
| --- | --- |
| v2-default-ingest.mrr | 0.6343 |
| v2-default-ingest.recall_at_10 | 0.7058 |
| v2-default-prechunked.mrr | 0.6437 |
| v2-default-prechunked.recall_at_10 | 0.7267 |
| v2-lexical-bm25-on-ingest.mrr | 0.6375 |
| v2-lexical-bm25-on-ingest.recall_at_10 | 0.7073 |
| v2-lexical-bm25-on-ingest.refusal_differences | 0 |
| v2-lexical-bm25-on-ingest.retrieval_total.p95_ms | 76.0000 |
| v2-lexical-bm25-on-prechunked.mrr | 0.6458 |
| v2-lexical-bm25-on-prechunked.recall_at_10 | 0.7267 |
| v2-lexical-bm25-on-prechunked.refusal_differences | 0 |
| v2-lexical-bm25-on-prechunked.retrieval_total.p95_ms | 49.0000 |

Offenders:
- v2-lexical-bm25-on-ingest: category:scanned:recall_at_10 dropped beyond the noise band (0.9286 < 0.9800, v2-default-ingest 1.0000)

Below min_gate_n (reported, not gated):
- v2-lexical-bm25-on-prechunked: category:duplicate_flood:recall_at_5 below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.8333 vs threshold 0.9800, reference 1.0000, against v2-default-prechunked
- v2-lexical-bm25-on-ingest: category:duplicate_flood:recall_at_5 below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.7500 vs threshold 0.8133, reference 0.8333, against v2-default-ingest

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
| v2-default-rerank-none-prechunked.mrr | 0.6389 |
| v2-default-rerank-none-prechunked.recall_at_10 | 0.7331 |
| v2-default-rerank-none-prechunked.recall_at_5 | 0.7246 |
| v2-lexical-bm25-on-rerank-none-prechunked.mrr | 0.6500 |
| v2-lexical-bm25-on-rerank-none-prechunked.recall_at_10 | 0.7309 |
| v2-lexical-bm25-on-rerank-none-prechunked.recall_at_5 | 0.7225 |

Moves:
- category:general:mrr dropped beyond the noise band (0.8684 < 0.8747, v2-default-rerank-none-prechunked 0.8947)
- category:multi_turn:recall_at_5 dropped beyond the noise band (0.4375 < 0.4800, v2-default-rerank-none-prechunked 0.5000)
- category:duplicate_flood:recall_at_5 below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.6667 vs threshold 0.7300, reference 0.7500, against v2-default-rerank-none-prechunked
- category:duplicate_flood:recall_at_10 below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.6667 vs threshold 0.7300, reference 0.7500, against v2-default-rerank-none-prechunked

## Runs

| Run | Mode | Recall@10 | MRR | Run config hash |
| --- | --- | --- | --- | --- |
| off-prechunked | prechunked | 0.6843 | 0.6480 | `75406258994e` |
| off-ingest | ingest | 0.7256 | 0.6512 | `8017ec54df40` |
| v2-default-prechunked | prechunked | 0.7267 | 0.6437 | `7ec1e1109989` |
| v2-lexical-bm25-on-prechunked | prechunked | 0.7267 | 0.6458 | `e1c0c68f46b4` |
| v2-default-ingest | ingest | 0.7058 | 0.6343 | `ef652af6ce9b` |
| v2-lexical-bm25-on-ingest | ingest | 0.7073 | 0.6375 | `420157547352` |
| v2-default-rerank-none-prechunked | prechunked | 0.7331 | 0.6389 | `81fb5b4642a6` |
| v2-lexical-bm25-on-rerank-none-prechunked | prechunked | 0.7309 | 0.6500 | `869c7a850214` |

> Fixture corpus only: every gate and threshold here was committed before any on-run result was looked at (D-36, pre-registration). Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare. The default fixture reranker partly hides a change in lexical order, so the fixture shows the absence of a regression, not the size of an effect; the reranker-none pair is reported, not gated.
> Pre-registered by plan 04.4-13 before any on-run result was looked at (T-04.4-41); plan 04.4-14 runs it with python -m rag_eval.phase44_gate --spec eval/config/phase44-comparison.json --out eval/reports/phase-04.4.
> Off runs use no base run config, so they run the legacy pipeline the committed baselines were recorded with; the v2 reference runs set the same three variables explicitly to ts_rank_cd, 1.2 and 0.75 (D-36).
> No tool of this phase writes eval/config/retrieval-params.json, eval/config/refusal-thresholds.json or a refusal threshold (D-35).
> Derived from eval/config/phase44-comparison.json (D-50): every gate, noise band, baseline, budget, command, report_only pair and run name is equal; only the three bm25 runs take base eval/config/runs/v2-lexical-bm25-cluster-df-on.json (RAG_DUP_CLUSTERS=true, RAG_LEXICAL_DF_MODE=cluster) and the three v2 reference runs add RAG_DUP_CLUSTERS=true, so both arms of a pair have the same clusters and differ only in scoring; the off runs are unchanged (eval/tests/test_phase44_cluster_df_spec.py).
> Pre-registered by plan 04.4-18 before any cluster-mode run was looked at; plan 04.4-19 runs it with python -m rag_eval.phase44_gate --spec eval/config/phase44-cluster-df-comparison.json --out eval/reports/phase-04.4-cluster-df.
