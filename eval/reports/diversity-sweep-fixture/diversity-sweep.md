# MMR lambda sweep

- Mode: fixture
- Run config: v2-diversity-mmr
- Grid: 0.5, 0.6, 0.7, 0.8, 0.9
- Noise band: 0.0200
- Scope: dev split only; the test split is never read.

## Choice rule

A lambda is eligible when no slice (overall, every language, every category) drops on Recall@10 beyond the noise band against the reference run (the same run config with RAG_RESULT_DIVERSITY=collapse). Among eligible lambdas take the highest duplicate_flood intent_coverage, then the lowest duplicate_flood topk_redundancy, then the highest mean Recall@10 over all slices, then the largest lambda. No eligible lambda: no choice, nothing written, the default 0.7 stays.

## Result

Chosen lambda: 0.9
- chosen lambda 0.9: duplicate_flood intent_coverage 1.0, topk_redundancy 0.1503968253968254, mean Recall@10 0.706411799054849

| lambda | duplicate_flood intent_coverage | duplicate_flood topk_redundancy | mean Recall@10 | eligible |
| --- | --- | --- | --- | --- |
| collapse (reference) | 1.0000 | 0.1504 | 0.7031 |  |
| 0.5 | 1.0000 | 0.1504 | 0.7064 | yes |
| 0.6 | 1.0000 | 0.1504 | 0.7064 | yes |
| 0.7 | 1.0000 | 0.1504 | 0.7064 | yes |
| 0.8 | 1.0000 | 0.1504 | 0.7064 | yes |
| 0.9 | 1.0000 | 0.1504 | 0.7064 | yes |

## Recall@10 per slice

| lambda | category:ambiguous | category:cache_near_miss | category:cache_paraphrase | category:colloquial | category:compound | category:cross_lingual | category:duplicate_flood | category:exact_term | category:general | category:identifier_near_miss | category:injection | category:injection_evasive | category:multi_turn | category:no_answer | category:scanned | category:selective_filter | category:small_talk | category:table | category:typo | language:en | language:it | language:zh | overall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| collapse | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.4286 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 0.5000 | n/a | 1.0000 | 0.5000 | n/a | 0.4545 | 0.3333 | 0.6017 | 0.7232 | 0.6961 | 0.6717 |
| 0.5 | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.4762 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 0.5000 | n/a | 1.0000 | 0.5000 | n/a | 0.4545 | 0.3333 | 0.6186 | 0.7232 | 0.6961 | 0.6777 |
| 0.6 | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.4762 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 0.5000 | n/a | 1.0000 | 0.5000 | n/a | 0.4545 | 0.3333 | 0.6186 | 0.7232 | 0.6961 | 0.6777 |
| 0.7 | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.4762 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 0.5000 | n/a | 1.0000 | 0.5000 | n/a | 0.4545 | 0.3333 | 0.6186 | 0.7232 | 0.6961 | 0.6777 |
| 0.8 | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.4762 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 0.5000 | n/a | 1.0000 | 0.5000 | n/a | 0.4545 | 0.3333 | 0.6186 | 0.7232 | 0.6961 | 0.6777 |
| 0.9 | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.4762 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 0.5000 | n/a | 1.0000 | 0.5000 | n/a | 0.4545 | 0.3333 | 0.6186 | 0.7232 | 0.6961 | 0.6777 |

## nDCG@k per slice

nDCG@k per slice is report-only: it is not a selection criterion.

| lambda | category:ambiguous | category:cache_near_miss | category:cache_paraphrase | category:colloquial | category:compound | category:cross_lingual | category:duplicate_flood | category:exact_term | category:general | category:identifier_near_miss | category:injection | category:injection_evasive | category:multi_turn | category:no_answer | category:scanned | category:selective_filter | category:small_talk | category:table | category:typo | language:en | language:it | language:zh | overall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| collapse | 0.5594 | 0.5392 | 0.7222 | 0.4529 | 0.4355 | 0.4286 | 0.8932 | 0.8750 | 0.8337 | 0.8889 | 0.7047 | 1.0000 | 0.4386 | n/a | 0.8289 | 0.5000 | n/a | 0.4210 | 0.3333 | 0.5233 | 0.6407 | 0.6644 | 0.6063 |
| 0.5 | 0.5594 | 0.5392 | 0.7222 | 0.4588 | 0.4355 | 0.4436 | 0.8932 | 0.8750 | 0.8337 | 0.8889 | 0.7047 | 1.0000 | 0.4332 | n/a | 0.8391 | 0.5000 | n/a | 0.4210 | 0.3333 | 0.5342 | 0.6357 | 0.6644 | 0.6085 |
| 0.6 | 0.5594 | 0.5392 | 0.7222 | 0.4588 | 0.4355 | 0.4436 | 0.8932 | 0.8750 | 0.8337 | 0.8889 | 0.7047 | 1.0000 | 0.4332 | n/a | 0.8391 | 0.5000 | n/a | 0.4210 | 0.3333 | 0.5342 | 0.6357 | 0.6644 | 0.6085 |
| 0.7 | 0.5594 | 0.5392 | 0.7222 | 0.4588 | 0.4355 | 0.4436 | 0.8932 | 0.8750 | 0.8337 | 0.8889 | 0.7047 | 1.0000 | 0.4332 | n/a | 0.8391 | 0.5000 | n/a | 0.4210 | 0.3333 | 0.5342 | 0.6357 | 0.6644 | 0.6085 |
| 0.8 | 0.5594 | 0.5392 | 0.7222 | 0.4588 | 0.4355 | 0.4436 | 0.8932 | 0.8750 | 0.8337 | 0.8889 | 0.7047 | 1.0000 | 0.4332 | n/a | 0.8391 | 0.5000 | n/a | 0.4210 | 0.3333 | 0.5342 | 0.6357 | 0.6644 | 0.6085 |
| 0.9 | 0.5594 | 0.5392 | 0.7222 | 0.4588 | 0.4355 | 0.4436 | 0.8932 | 0.8750 | 0.8337 | 0.8889 | 0.7047 | 1.0000 | 0.4332 | n/a | 0.8391 | 0.5000 | n/a | 0.4210 | 0.3333 | 0.5342 | 0.6357 | 0.6644 | 0.6085 |

## Notes

- Fixture run: eval/config/retrieval-params.json was not touched.
