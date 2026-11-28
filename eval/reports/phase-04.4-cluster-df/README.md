# Phase 4.4 gates with cluster-aware DF (plan 04.4-19)

Result: **gate (b) FAIL**. (a) PASS, (b) FAIL, (c) PASS. Exit code 1, recorded as measured. No default changed (D-51).

## Commands

Branch `exec/04.4-19`, from `origin/exec/04.4-18` (46c927ae). The derived spec was committed at `35da1b5a` (plan 04.4-18), before any cluster-mode run, and is unchanged.

```
uv run --directory eval python -m rag_eval.phase44_gate --spec eval/config/phase44-comparison.json --out eval/out/04.4-19-original
uv run --directory eval python -m rag_eval.phase44_gate --spec eval/config/phase44-cluster-df-comparison.json --out eval/reports/phase-04.4-cluster-df
```

The first command is the original spec (raw DF), run on the same tree for comparison. Its output is git-ignored. The raw harness runs of both commands (`harness/`) are git-ignored too.

Fixture items: 413 prechunked and 561 ingest (golden sha256 `dc812d5fa8c6…` and `cde5be0214a5…`). These are the same counts as the quick-44 re-run.

## Original spec on this tree (step 1)

Every metric cell of every run equals the committed `eval/reports/phase-04.4/min-gate-n-v2/gate.json`. Only the latency p95 values and `run_config_hash` differ. The golden set has not changed, so the committed report was not regenerated. Against the older `eval/reports/phase-04.4/gate.json`, which predates the owner's `min_gate_n` v2 rule, the metric cells are the same too. The only difference is that the three `duplicate_flood` cells (n=6) moved from offenders to "below_min_n, reported, not gated".

## Gates

| Gate | raw (original spec) | cluster (derived spec) |
| --- | --- | --- |
| (a) off identity | PASS, 0 differing cells in both modes | PASS, 0 differing cells in both modes |
| (b) bm25 on | FAIL, 1 offender | FAIL, 1 offender |
| (c) cap agreement | PASS, mean overlap@10 1.0 (399 / 529 measured) | PASS, mean overlap@10 1.0 (399 / 529 measured) |

The characterization command exited 0 in both runs.

### Gate (b) overall numbers

| Number | reference | raw bm25 | cluster bm25 |
| --- | --- | --- | --- |
| prechunked Recall@10 | 0.7267 | 0.7246 | 0.7267 |
| prechunked MRR | 0.6437 | 0.6458 | 0.6458 |
| ingest Recall@10 | 0.7058 | 0.7058 | 0.7073 |
| ingest MRR | 0.6343 | 0.6383 | 0.6375 |
| refusal differences (prechunked, ingest) | — | 0, 0 | 0, 0 |
| retrieval total p95 ms (prechunked, ingest) | — | 50, 67 | 49, 76 |

### Gate (b) offenders, `duplicate_flood` first

`duplicate_flood` has n=6, below `min_gate_n=10` (`no_slice_drop_rule` v2), so it is reported and not gated in both runs. Gated `duplicate_flood` offenders: 0 in cluster, 0 in raw. Reported drops beyond the band: 2 in cluster, 3 in raw.

| Run | Slice | n | Metric | reference | raw | cluster | bound | cluster beyond band |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bm25 prechunked | category:duplicate_flood | 6 | Recall@5 | 1.0000 | 0.7500 | 0.8333 | 0.9800 | yes (reported, not gated) |
| bm25 prechunked | category:duplicate_flood | 6 | Recall@10 | 1.0000 | 0.9167 | 1.0000 | 0.9800 | no (raw: yes) |
| bm25 prechunked | category:duplicate_flood | 6 | MRR | 1.0000 | 1.0000 | 1.0000 | — | no |
| bm25 ingest | category:duplicate_flood | 6 | Recall@5 | 0.8333 | 0.6667 | 0.7500 | 0.8133 | yes (reported, not gated) |
| bm25 ingest | category:duplicate_flood | 6 | Recall@10 | 0.8333 | 0.8333 | 0.9167 | 0.8133 | no |
| bm25 ingest | category:duplicate_flood | 6 | MRR | 1.0000 | 1.0000 | 1.0000 | — | no |

The per-language `duplicate_flood` cells (n=2 each) of the bm25 runs, raw and cluster:

| Mode | en R@5 / R@10 | it R@5 / R@10 | zh R@5 / R@10 |
| --- | --- | --- | --- |
| prechunked (raw) | 0.75 / 0.75 | 0.50 / 1.00 | 1.00 / 1.00 |
| prechunked (cluster) | 0.75 / 1.00 | 0.75 / 1.00 | 1.00 / 1.00 |
| ingest (raw) | 0.50 / 0.50 | 0.50 / 1.00 | 1.00 / 1.00 |
| ingest (cluster) | 0.50 / 0.75 | 0.75 / 1.00 | 1.00 / 1.00 |

#### Other offenders

| Run | Slice | n | Metric | reference | raw | cluster | bound | gated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bm25 ingest | category:scanned | 14 | Recall@10 | 1.0000 | 0.9286 | 0.9286 | 0.9800 | **yes: offender in both runs** |

Cluster DF does not change this cell. One of 14 items loses one span at rank 10, as in the quick-44 re-run. For comparison, ingest `templated_collection` (n=58) Recall@10 is 0.4655 in both bm25 runs against 0.4828 for the reference (bound 0.4628), so it stays inside the band.

## Reference shift

The derived spec turns `RAG_DUP_CLUSTERS=true` on in the three `v2-default-*` reference runs. Each slice cell of those runs (overall, language, category, doc type, question kind, split, language×category) was compared with the same run in the original-spec run.

| Run | cells compared | gated-metric cells that differ | cells that differ |
| --- | --- | --- | --- |
| v2-default-prechunked | 781 | 0 | 18, all `topk_redundancy` |
| v2-default-ingest | 890 | 0 | 25, all `topk_redundancy` |
| v2-default-rerank-none-prechunked | 781 | 0 | 16, all `topk_redundancy` |

Recall@5, Recall@10, MRR, nDCG, refusal and the other gated cells did not move. Only `topk_redundancy` changed. It is a diagnostic that counts duplicates in the top k, and it can count them only once clusters exist. Overall it went 0.1278 → 0.1482 (prechunked), 0.1259 → 0.1420 (ingest) and 0.1281 → 0.1539 (rerank none). On `duplicate_flood` it went 0.1250 → 0.6458, 0.5000 and 0.9375. So the reference is the same ranking as before, and the gate (b) comparison is not moved by the reference.

## Evidence that both fixture modes built clusters

| Run | `dup_clusters:eval_run` | clustered count input | `lexical_stats:cluster` | searches served with `lexical_df_cluster` |
| --- | --- | --- | --- | --- |
| v2-default-prechunked | yes | — (prechunked writes none) | — | — |
| v2-lexical-bm25-on-prechunked | yes | — | yes | 413 of 413 |
| v2-lexical-bm25-on-rerank-none-prechunked | yes | — | yes | 413 of 413 |
| v2-default-ingest | yes | `dup_clusters:clustered:405` | — | — |
| v2-lexical-bm25-on-ingest | yes | `dup_clusters:clustered:405` | yes | 561 of 561 |

The entries come from `sql_sha256` in each run's `run.json`. The trace codes come from `traces.jsonl` (`lexical_scoring_bm25;lexical_df_cluster` on every request). The raw bm25 runs of step 1 carry no `lexical_df_cluster` code. The harness enables cluster statistics, rebuilds them after clustering, and requires a clean check and `cluster_status` ready before the run. A cluster unit count below the chunk count is asserted by the 04.4-18 test on the ingest fixture. The per-run unit and ledger counts (`cluster_units`, `cluster_ledger_rows`) are kept in the harness session only and are not written to a run file, so they are not listed here.

## Search stage latency (chat budget: `search` 400 ms p95)

| Run | search p50 / p95 ms | retrieval total p95 ms |
| --- | --- | --- |
| cluster bm25 prechunked | 27 / 42 | 49 |
| cluster bm25 ingest | 35 / 58 | 76 |
| cluster bm25 rerank none prechunked | 28 / 45 | 49 |
| raw bm25 prechunked (step 1) | 27 / 44 | 50 |
| raw bm25 ingest (step 1) | 34 / 55 | 67 |

All runs are within budget. These are PGlite fixture timings, not live measurements.

## Report-only pair (`RAG_RERANKER=none`, prechunked)

| Number | reference | raw bm25 | cluster bm25 |
| --- | --- | --- | --- |
| Recall@5 | 0.7246 | 0.7267 | 0.7225 |
| Recall@10 | 0.7331 | 0.7352 | 0.7309 |
| MRR | 0.6389 | 0.6500 | 0.6500 |
| duplicate_flood Recall@5 / Recall@10 (n=6) | 0.7500 / 0.7500 | 0.8333 / 0.8333 | 0.6667 / 0.6667 |

Moves beyond the band in the cluster run: `category:general` MRR 0.8684 against 0.8947 (bound 0.8747) and `category:multi_turn` Recall@5 0.4375 against 0.5000 (bound 0.4800), the same two as the raw run. Also reported (below min_n): `duplicate_flood` Recall@5 and Recall@10 0.6667 against 0.7500 (bound 0.7300). Without the reranker, cluster DF ranks `duplicate_flood` lower than raw DF does (en and it lose one span each). Reported, never gated.

## Gate (c) overlap DF mode

- v2-lexical-bm25-on-prechunked: overlap df_mode: cluster (399 measured, mean 1.0, min 1.0)
- v2-lexical-bm25-on-ingest: overlap df_mode: cluster (529 measured, mean 1.0, min 1.0)
- v2-lexical-bm25-on-rerank-none-prechunked: overlap df_mode: cluster (399 measured, mean 1.0, min 1.0)

Each line was read from that run's `lexical-bm25-overlap.json`. All three files carry `df_mode: "cluster"`, so the gate (c) result is valid.
