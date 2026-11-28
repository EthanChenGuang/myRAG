# Phase 04.4 (local_rerank_stats) gates

Verdict: **FAIL** over off_identity, no_slice_drop, pool_independence, latency, refusal. Noise band: max(3 x spread, 0.02).

| Gate | Decision | Verdict | Offenders |
| --- | --- | --- | --- |
| off_identity | D-57 (a) | PASS | 0 |
| no_slice_drop | D-57 (b) | FAIL | 1 |
| pool_independence | D-57 (c) | PASS | 0 |
| latency | D-57 (d) | PASS | 0 |
| refusal | D-57 (e) | PASS | 0 |

## off_identity (D-57 (a))

Runs: off-prechunked, off-ingest, off-voice.

| Number | Value |
| --- | --- |
| command.characterization.exit_code | 0 |
| off-ingest.nonzero_cells | 0 |
| off-prechunked.nonzero_cells | 0 |
| off-voice.nonzero_cells | 0 |

## no_slice_drop (D-57 (b))

Runs: v2-default-tenant-prechunked, v2-default-pool-prechunked, v2-default-tenant-ingest, v2-default-pool-ingest, v2-bm25-tenant-prechunked, v2-bm25-pool-prechunked, v2-bm25-tenant-ingest, v2-bm25-pool-ingest, voice-tenant-prechunked, voice-pool-prechunked.

| Number | Value |
| --- | --- |
| v2-bm25-pool-ingest.mrr | 0.6396 |
| v2-bm25-pool-ingest.recall_at_10 | 0.7063 |
| v2-bm25-pool-ingest.recall_at_5 | 0.6973 |
| v2-bm25-pool-prechunked.mrr | 0.6475 |
| v2-bm25-pool-prechunked.recall_at_10 | 0.7250 |
| v2-bm25-pool-prechunked.recall_at_5 | 0.7083 |
| v2-bm25-tenant-ingest.mrr | 0.6588 |
| v2-bm25-tenant-ingest.recall_at_10 | 0.7274 |
| v2-bm25-tenant-ingest.recall_at_5 | 0.7199 |
| v2-bm25-tenant-prechunked.mrr | 0.6607 |
| v2-bm25-tenant-prechunked.recall_at_10 | 0.7396 |
| v2-bm25-tenant-prechunked.recall_at_5 | 0.7271 |
| v2-default-pool-ingest.mrr | 0.6357 |
| v2-default-pool-ingest.recall_at_10 | 0.7063 |
| v2-default-pool-ingest.recall_at_5 | 0.6943 |
| v2-default-pool-prechunked.mrr | 0.6455 |
| v2-default-pool-prechunked.recall_at_10 | 0.7271 |
| v2-default-pool-prechunked.recall_at_5 | 0.7146 |
| v2-default-tenant-ingest.mrr | 0.6584 |
| v2-default-tenant-ingest.recall_at_10 | 0.7274 |
| v2-default-tenant-ingest.recall_at_5 | 0.7199 |
| v2-default-tenant-prechunked.mrr | 0.6587 |
| v2-default-tenant-prechunked.recall_at_10 | 0.7396 |
| v2-default-tenant-prechunked.recall_at_5 | 0.7271 |
| voice-pool-prechunked.mrr | 0.8219 |
| voice-pool-prechunked.recall_at_10 | 0.9146 |
| voice-pool-prechunked.recall_at_5 | 0.9146 |
| voice-tenant-prechunked.mrr | 0.8351 |
| voice-tenant-prechunked.recall_at_10 | 0.9125 |
| voice-tenant-prechunked.recall_at_5 | 0.9125 |

Offenders:
- v2-default-tenant-ingest: category:scanned:recall_at_10 dropped beyond the noise band (0.9286 < 0.9800, v2-default-pool-ingest 1.0000)

Below min_gate_n (reported, not gated):
- v2-default-tenant-prechunked: category:selective_filter:mrr below_min_n (n=8 < min_gate_n=10, reported, not gated): 0.4375 vs threshold 0.4800, reference 0.5000, against v2-default-pool-prechunked
- v2-default-tenant-ingest: category:selective_filter:mrr below_min_n (n=8 < min_gate_n=10, reported, not gated): 0.4375 vs threshold 0.4800, reference 0.5000, against v2-default-pool-ingest
- v2-bm25-tenant-prechunked: category:selective_filter:mrr below_min_n (n=8 < min_gate_n=10, reported, not gated): 0.4375 vs threshold 0.4800, reference 0.5000, against v2-bm25-pool-prechunked
- v2-bm25-tenant-ingest: category:selective_filter:mrr below_min_n (n=8 < min_gate_n=10, reported, not gated): 0.4375 vs threshold 0.4800, reference 0.5000, against v2-bm25-pool-ingest
- voice-tenant-prechunked: category:ambiguous:recall_at_5 below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.8333 vs threshold 0.9800, reference 1.0000, against voice-pool-prechunked
- voice-tenant-prechunked: category:ambiguous:recall_at_10 below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.8333 vs threshold 0.9800, reference 1.0000, against voice-pool-prechunked
- voice-tenant-prechunked: category:ambiguous:mrr below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.7500 vs threshold 0.7633, reference 0.7833, against voice-pool-prechunked
- voice-tenant-prechunked: category:typo:mrr below_min_n (n=3 < min_gate_n=10, reported, not gated): 0.6111 vs threshold 0.6467, reference 0.6667, against voice-pool-prechunked

## pool_independence (D-57 (c))

Runs: v2-default-tenant-prechunked, v2-bm25-tenant-prechunked, v2-default-tenant-ingest, v2-bm25-tenant-ingest.

| Number | Value |
| --- | --- |
| v2-default-tenant-ingest~v2-bm25-tenant-ingest.inversions | 0 |
| v2-default-tenant-ingest~v2-bm25-tenant-ingest.items_compared | 602 |
| v2-default-tenant-ingest~v2-bm25-tenant-ingest.pairs_compared | 154016 |
| v2-default-tenant-prechunked~v2-bm25-tenant-prechunked.inversions | 0 |
| v2-default-tenant-prechunked~v2-bm25-tenant-prechunked.items_compared | 454 |
| v2-default-tenant-prechunked~v2-bm25-tenant-prechunked.pairs_compared | 111915 |

## latency (D-57 (d))

Runs: v2-default-tenant-prechunked, v2-default-tenant-ingest, v2-bm25-tenant-prechunked, v2-bm25-tenant-ingest, voice-tenant-prechunked.

| Number | Value |
| --- | --- |
| v2-bm25-tenant-ingest.rerank.p50_ms | 11.0000 |
| v2-bm25-tenant-ingest.rerank.p95_ms | 19.0000 |
| v2-bm25-tenant-prechunked.rerank.p50_ms | 10.0000 |
| v2-bm25-tenant-prechunked.rerank.p95_ms | 17.0000 |
| v2-default-tenant-ingest.rerank.p50_ms | 11.0000 |
| v2-default-tenant-ingest.rerank.p95_ms | 19.0000 |
| v2-default-tenant-prechunked.rerank.p50_ms | 11.0000 |
| v2-default-tenant-prechunked.rerank.p95_ms | 19.0000 |
| voice-tenant-prechunked.rerank.p50_ms | 10.0000 |
| voice-tenant-prechunked.rerank.p95_ms | 17.0000 |

## refusal (D-57 (e))

Runs: v2-default-tenant-prechunked, v2-default-pool-prechunked, v2-default-tenant-ingest, v2-default-pool-ingest, v2-bm25-tenant-prechunked, v2-bm25-pool-prechunked, v2-bm25-tenant-ingest, v2-bm25-pool-ingest, voice-tenant-prechunked, voice-pool-prechunked.

| Number | Value |
| --- | --- |
| v2-bm25-pool-ingest.correct_refusal_rate | 1.0000 |
| v2-bm25-pool-ingest.false_answer_rate | 0.0000 |
| v2-bm25-pool-ingest.false_refusal_rate | 0.2410 |
| v2-bm25-pool-prechunked.correct_refusal_rate | 1.0000 |
| v2-bm25-pool-prechunked.false_answer_rate | 0.0000 |
| v2-bm25-pool-prechunked.false_refusal_rate | 0.2375 |
| v2-bm25-tenant-ingest.correct_refusal_rate | 1.0000 |
| v2-bm25-tenant-ingest.false_answer_rate | 0.0000 |
| v2-bm25-tenant-ingest.false_refusal_rate | 0.2410 |
| v2-bm25-tenant-prechunked.correct_refusal_rate | 1.0000 |
| v2-bm25-tenant-prechunked.false_answer_rate | 0.0000 |
| v2-bm25-tenant-prechunked.false_refusal_rate | 0.2375 |
| v2-default-pool-ingest.correct_refusal_rate | 1.0000 |
| v2-default-pool-ingest.false_answer_rate | 0.0000 |
| v2-default-pool-ingest.false_refusal_rate | 0.2410 |
| v2-default-pool-prechunked.correct_refusal_rate | 1.0000 |
| v2-default-pool-prechunked.false_answer_rate | 0.0000 |
| v2-default-pool-prechunked.false_refusal_rate | 0.2375 |
| v2-default-tenant-ingest.correct_refusal_rate | 1.0000 |
| v2-default-tenant-ingest.false_answer_rate | 0.0000 |
| v2-default-tenant-ingest.false_refusal_rate | 0.2410 |
| v2-default-tenant-prechunked.correct_refusal_rate | 1.0000 |
| v2-default-tenant-prechunked.false_answer_rate | 0.0000 |
| v2-default-tenant-prechunked.false_refusal_rate | 0.2375 |
| voice-pool-prechunked.correct_refusal_rate | 0.1569 |
| voice-pool-prechunked.false_answer_rate | 0.8431 |
| voice-pool-prechunked.false_refusal_rate | 0.0083 |
| voice-tenant-prechunked.correct_refusal_rate | 0.1569 |
| voice-tenant-prechunked.false_answer_rate | 0.8431 |
| voice-tenant-prechunked.false_refusal_rate | 0.0083 |

## Report-only (not gated)

### `v2-default-pool-prechunked` against `v2-bm25-pool-prechunked`

Pool statistics under the same comparison (reported, not gated): the order flips the tenant statistics remove.

| Number | Value |
| --- | --- |
| inversions | 6115 |
| items_compared | 454 |
| pairs_compared | 111786 |

Moves:
- inversions in 41 item(s)

### `v2-default-pool-ingest` against `v2-bm25-pool-ingest`

Pool statistics under the same comparison (reported, not gated): the order flips the tenant statistics remove.

| Number | Value |
| --- | --- |
| inversions | 5102 |
| items_compared | 601 |
| pairs_compared | 149622 |

Moves:
- inversions in 72 item(s)

### `v2-bm25-tenant-ingest` against `v2-default-tenant-ingest`

The Phase 4.4 scanned offender (decision 3A) under tenant statistics: first hit rank in the bm25 arm and the default arm, ingest. Reported, not a gate.

| Number | Value |
| --- | --- |
| v2-bm25-tenant-ingest.en-scanned-001.first_hit_rank | — |
| v2-default-tenant-ingest.en-scanned-001.first_hit_rank | — |

### `v2-bm25-pool-ingest` against `v2-default-pool-ingest`

The same item under pool statistics, for comparison. Reported, not a gate.

| Number | Value |
| --- | --- |
| v2-bm25-pool-ingest.en-scanned-001.first_hit_rank | — |
| v2-default-pool-ingest.en-scanned-001.first_hit_rank | 8 |

## Runs

| Run | Mode | Recall@10 | MRR | Run config hash |
| --- | --- | --- | --- | --- |
| off-prechunked | prechunked | 0.6854 | 0.6497 | `faed322404ed` |
| off-ingest | ingest | 0.7259 | 0.6523 | `9355c5a40833` |
| off-voice | prechunked | 0.8812 | 0.7919 | `36d5b9644b08` |
| v2-default-pool-prechunked | prechunked | 0.7271 | 0.6455 | `409304557761` |
| v2-default-tenant-prechunked | prechunked | 0.7396 | 0.6587 | `8f6d3e39edcf` |
| v2-default-pool-ingest | ingest | 0.7063 | 0.6357 | `b8449402a559` |
| v2-default-tenant-ingest | ingest | 0.7274 | 0.6584 | `d42659f95126` |
| v2-bm25-pool-prechunked | prechunked | 0.7250 | 0.6475 | `79ff2642f86f` |
| v2-bm25-tenant-prechunked | prechunked | 0.7396 | 0.6607 | `6c62f728156d` |
| v2-bm25-pool-ingest | ingest | 0.7063 | 0.6396 | `8b3d2d0cf6b6` |
| v2-bm25-tenant-ingest | ingest | 0.7274 | 0.6588 | `11c0131cc0b0` |
| voice-pool-prechunked | prechunked | 0.9146 | 0.8219 | `6543333a856d` |
| voice-tenant-prechunked | prechunked | 0.9125 | 0.8351 | `349f11eae295` |

> Spec eval/config/phase44-local-rerank-stats-comparison.json sha256 37054fc730f9a5a943a0c54841af356440cee8e8060f758f8e60450792fe6b2e, registered in commit 842c269fec2a48a474483a9d9819a3577c2afcd5.
> Fixture corpus only: every gate and threshold here was committed before any on-run result was looked at (D-36, pre-registration). Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare. The default fixture reranker partly hides a change in lexical order, so the fixture shows the absence of a regression, not the size of an effect; the reranker-none pair is reported, not gated.
> Pre-registered by plan 04.4-22 before any tenant-mode eval run was made or looked at (D-37 of Phase 4.2, D-57); the gate run checks that the commit adding this file is an ancestor of HEAD and that the file is unchanged since.
> Outcome rule, fixed in advance (D-57): every gate passes: the decision record says 'gates PASS, owner decision pending' and work stops; any gate fails: the record lists the failing cells as measured and work stops. No retry with other bands, parameters, items or runs. The default RAG_RERANK_LOCAL_STATS=pool is not changed in either case; a change needs the owner's signature, its own plan through the config sync, recalibrated refusal cells for bm25-v3-tenant and the ship check once the gate population is real.
> Noise bands, slice rule, budgets and the text and ingest baselines are those of eval/config/phase44-comparison.json (sha256 2a613e1eaa344bd5304e7fad0573f70832915fb2ddb33512691e2f18e4624f88), which is not edited; the voice baseline is the committed one of Phase 6.2 (D-16).
> The runs may be produced one harness run at a time into <out>/harness/<run> and then gated with --reuse; every run is the same run the gate would start, made once.
> No tool of this plan writes eval/config/retrieval-params.json, eval/config/refusal-thresholds.json or a refusal threshold.
