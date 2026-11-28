# Phase 4.4 G1 diagnostic: duplicate_flood and templated_collection under bm25

Report only (quick-44, option B). The pre-registered spec, its noise bands, k1, b and the candidate cap are unchanged; nothing here is a gate.
Each group runs the gate-(b) pair (v2-default with ts_rank_cd against v2-lexical-bm25-on) with the group's extra switches on both arms.

## prechunked

### duplicate_flood

| group | arm | n | R@5 | R@10 | MRR | intent coverage | top-k redundancy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | ts_rank_cd | 6 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.1250 |
| baseline | bm25 | 6 | 0.7500 | 0.9167 | 1.0000 | 0.8333 | 0.1250 |
| dup_clusters | ts_rank_cd | 6 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.6458 |
| dup_clusters | bm25 | 6 | 0.7500 | 0.9167 | 1.0000 | 0.8333 | 0.4167 |
| collapse | ts_rank_cd | 6 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.1504 |
| collapse | bm25 | 6 | 0.7500 | 0.9167 | 1.0000 | 0.8333 | 0.1319 |

Offenders beyond the noise band (bm25 against ts_rank_cd):

- baseline: category:duplicate_flood:recall_at_5 dropped beyond the noise band (0.7500 < 0.9800, ts_rank_cd 1.0000); category:duplicate_flood:recall_at_10 dropped beyond the noise band (0.9167 < 0.9800, ts_rank_cd 1.0000)
- dup_clusters: category:duplicate_flood:recall_at_5 dropped beyond the noise band (0.7500 < 0.9800, ts_rank_cd 1.0000); category:duplicate_flood:recall_at_10 dropped beyond the noise band (0.9167 < 0.9800, ts_rank_cd 1.0000)
- collapse: category:duplicate_flood:recall_at_5 dropped beyond the noise band (0.7500 < 0.9800, ts_rank_cd 1.0000); category:duplicate_flood:recall_at_10 dropped beyond the noise band (0.9167 < 0.9800, ts_rank_cd 1.0000)

Lexical top-10 ties, baseline group (9 items):

| arm | items with a tie | with a duplicate tie | tie across rank 5 | tie across rank 10 | mean tied hits | mean near-duplicate pairs | mean distinct documents | mean duplicate score gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bm25 | 9 | 0 | 9 | 0 | 8.8889 | 6.7778 | 9.8889 | 0.0000 |
| ts_rank_cd | 9 | 0 | 9 | 0 | 9.4444 | 8.5556 | 10.0000 | 0.0000 |

**Verdict: `bm25_ranking`.** the drop stays with de-duplication on and bm25 shows no excess ties: the bm25 order itself ranks other spans lower.

### templated_collection

| group | arm | n | R@5 | R@10 | MRR | intent coverage | top-k redundancy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | ts_rank_cd | 0 | — | — | — | — | — |
| baseline | bm25 | 0 | — | — | — | — | — |
| dup_clusters | ts_rank_cd | 0 | — | — | — | — | — |
| dup_clusters | bm25 | 0 | — | — | — | — | — |
| collapse | ts_rank_cd | 0 | — | — | — | — | — |
| collapse | bm25 | 0 | — | — | — | — | — |

Offenders beyond the noise band (bm25 against ts_rank_cd):

- baseline: none
- dup_clusters: none
- collapse: none

**Verdict: `no_drop`.** no slice of this category drops beyond the noise band in the baseline pair.

## ingest

### duplicate_flood

| group | arm | n | R@5 | R@10 | MRR | intent coverage | top-k redundancy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | ts_rank_cd | 6 | 0.8333 | 0.8333 | 1.0000 | 0.6667 | 0.1250 |
| baseline | bm25 | 6 | 0.6667 | 0.8333 | 1.0000 | 0.6667 | 0.1250 |
| dup_clusters | ts_rank_cd | 6 | 0.8333 | 0.8333 | 1.0000 | 0.6667 | 0.1250 |
| dup_clusters | bm25 | 6 | 0.6667 | 0.8333 | 1.0000 | 0.6667 | 0.1250 |
| collapse | ts_rank_cd | 6 | 0.8333 | 0.8333 | 1.0000 | 0.6667 | 0.1250 |
| collapse | bm25 | 6 | 0.6667 | 0.8333 | 1.0000 | 0.6667 | 0.1250 |

Offenders beyond the noise band (bm25 against ts_rank_cd):

- baseline: category:duplicate_flood:recall_at_5 dropped beyond the noise band (0.6667 < 0.8133, ts_rank_cd 0.8333)
- dup_clusters: category:duplicate_flood:recall_at_5 dropped beyond the noise band (0.6667 < 0.8133, ts_rank_cd 0.8333)
- collapse: category:duplicate_flood:recall_at_5 dropped beyond the noise band (0.6667 < 0.8133, ts_rank_cd 0.8333)

Lexical top-10 ties, baseline group (9 items):

| arm | items with a tie | with a duplicate tie | tie across rank 5 | tie across rank 10 | mean tied hits | mean near-duplicate pairs | mean distinct documents | mean duplicate score gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bm25 | 9 | 0 | 9 | 0 | 9.0000 | 10.1111 | 10.0000 | 0.0000 |
| ts_rank_cd | 9 | 0 | 9 | 0 | 9.5556 | 11.6667 | 10.0000 | 0.0000 |

**Verdict: `bm25_ranking`.** the drop stays with de-duplication on and bm25 shows no excess ties: the bm25 order itself ranks other spans lower.

### templated_collection

| group | arm | n | R@5 | R@10 | MRR | intent coverage | top-k redundancy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | ts_rank_cd | 58 | 0.4655 | 0.4828 | 0.3934 | — | 0.1250 |
| baseline | bm25 | 58 | 0.4655 | 0.4655 | 0.3966 | — | 0.1250 |
| dup_clusters | ts_rank_cd | 58 | 0.4655 | 0.4828 | 0.3934 | — | 0.1250 |
| dup_clusters | bm25 | 58 | 0.4655 | 0.4655 | 0.3966 | — | 0.1250 |
| collapse | ts_rank_cd | 58 | 0.4655 | 0.4828 | 0.3934 | — | 0.1250 |
| collapse | bm25 | 58 | 0.4655 | 0.4655 | 0.3966 | — | 0.1250 |

Offenders beyond the noise band (bm25 against ts_rank_cd):

- baseline: none
- dup_clusters: none
- collapse: none

Lexical top-10 ties, baseline group (78 items):

| arm | items with a tie | with a duplicate tie | tie across rank 5 | tie across rank 10 | mean tied hits | mean near-duplicate pairs | mean distinct documents | mean duplicate score gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bm25 | 78 | 24 | 61 | 0 | 8.5128 | 7.8846 | 7.7821 | 0.0000 |
| ts_rank_cd | 67 | 15 | 38 | 0 | 5.6154 | 7.2308 | 6.6538 | 0.0000 |

**Verdict: `no_drop`.** no slice of this category drops beyond the noise band in the baseline pair.

