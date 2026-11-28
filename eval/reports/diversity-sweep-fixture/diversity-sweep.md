# MMR lambda sweep

- Mode: fixture
- Run config: v2-diversity-mmr
- Grid: 0.5, 0.6, 0.7, 0.8, 0.9
- Noise band: 0.0200
- Scope: dev split only; the test split is never read.

## Choice rule

A lambda is eligible when no slice (overall, every language, every category) drops on Recall@10 beyond the noise band against the reference run (the same run config with RAG_RESULT_DIVERSITY=collapse). Among eligible lambdas take the highest duplicate_flood intent_coverage, then the lowest duplicate_flood topk_redundancy, then the highest mean Recall@10 over all slices, then the largest lambda. No eligible lambda: no choice, nothing written, the default 0.7 stays.

## Result

No lambda chosen: no eligible lambda. The default 0.7 stays.
- lambda 0.5: ineligible, Recall@10 drop beyond the band: category:scanned: 0.7500 < 1.0000 - 0.0200
- lambda 0.6: ineligible, Recall@10 drop beyond the band: category:scanned: 0.7500 < 1.0000 - 0.0200
- lambda 0.7: ineligible, Recall@10 drop beyond the band: category:scanned: 0.7500 < 1.0000 - 0.0200
- lambda 0.8: ineligible, Recall@10 drop beyond the band: category:scanned: 0.7500 < 1.0000 - 0.0200
- lambda 0.9: ineligible, Recall@10 drop beyond the band: category:scanned: 0.7500 < 1.0000 - 0.0200
- no eligible lambda: nothing chosen, the default 0.7 stays

| lambda | duplicate_flood intent_coverage | duplicate_flood topk_redundancy | mean Recall@10 | eligible |
| --- | --- | --- | --- | --- |
| collapse (reference) | 1.0000 | 0.1504 | 0.7288 |  |
| 0.5 | 1.0000 | 0.1504 | 0.7186 | no |
| 0.6 | 1.0000 | 0.1504 | 0.7186 | no |
| 0.7 | 1.0000 | 0.1504 | 0.7186 | no |
| 0.8 | 1.0000 | 0.1504 | 0.7186 | no |
| 0.9 | 1.0000 | 0.1504 | 0.7186 | no |

## Recall@10 per slice

| lambda | category:ambiguous | category:cache_near_miss | category:cache_paraphrase | category:colloquial | category:compound | category:context_overflow | category:cross_lingual | category:duplicate_flood | category:exact_term | category:general | category:identifier_near_miss | category:implicit_condition | category:injection | category:injection_evasive | category:multi_step_calc | category:multi_turn | category:no_answer | category:off_topic_context | category:partial_answer | category:scanned | category:selective_filter | category:small_talk | category:stale_version | category:table | category:typo | language:en | language:it | language:zh | overall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| collapse | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.0000 | 0.4286 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 1.0000 | 0.9643 | 0.5000 | n/a | n/a | 1.0000 | 1.0000 | 0.5000 | n/a | 1.0000 | 0.4545 | 0.3333 | 0.6566 | 0.7622 | 0.7676 | 0.7267 |
| 0.5 | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.0000 | 0.4286 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 1.0000 | 0.9643 | 0.5000 | n/a | n/a | 1.0000 | 0.7500 | 0.5000 | n/a | 1.0000 | 0.4545 | 0.3333 | 0.6446 | 0.7622 | 0.7676 | 0.7225 |
| 0.6 | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.0000 | 0.4286 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 1.0000 | 0.9643 | 0.5000 | n/a | n/a | 1.0000 | 0.7500 | 0.5000 | n/a | 1.0000 | 0.4545 | 0.3333 | 0.6446 | 0.7622 | 0.7676 | 0.7225 |
| 0.7 | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.0000 | 0.4286 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 1.0000 | 0.9643 | 0.5000 | n/a | n/a | 1.0000 | 0.7500 | 0.5000 | n/a | 1.0000 | 0.4545 | 0.3333 | 0.6446 | 0.7622 | 0.7676 | 0.7225 |
| 0.8 | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.0000 | 0.4286 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 1.0000 | 0.9643 | 0.5000 | n/a | n/a | 1.0000 | 0.7500 | 0.5000 | n/a | 1.0000 | 0.4545 | 0.3333 | 0.6446 | 0.7622 | 0.7676 | 0.7225 |
| 0.9 | 0.6667 | 0.6364 | 0.7778 | 0.7500 | 0.4444 | 0.0000 | 0.4286 | 1.0000 | 0.8750 | 0.8158 | 0.8889 | 1.0000 | 1.0000 | 1.0000 | 0.9643 | 0.5000 | n/a | n/a | 1.0000 | 0.7500 | 0.5000 | n/a | 1.0000 | 0.4545 | 0.3333 | 0.6446 | 0.7622 | 0.7676 | 0.7225 |

## nDCG@k per slice

nDCG@k per slice is report-only: it is not a selection criterion.

| lambda | category:ambiguous | category:cache_near_miss | category:cache_paraphrase | category:colloquial | category:compound | category:context_overflow | category:cross_lingual | category:duplicate_flood | category:exact_term | category:general | category:identifier_near_miss | category:implicit_condition | category:injection | category:injection_evasive | category:multi_step_calc | category:multi_turn | category:no_answer | category:off_topic_context | category:partial_answer | category:scanned | category:selective_filter | category:small_talk | category:stale_version | category:table | category:typo | language:en | language:it | language:zh | overall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| collapse | 0.5594 | 0.5392 | 0.7368 | 0.4529 | 0.4355 | 0.0000 | 0.4286 | 0.8932 | 0.8750 | 0.8073 | 0.8889 | 1.0000 | 0.7047 | 1.0000 | 0.9104 | 0.4285 | n/a | n/a | 1.0000 | 0.8333 | 0.5000 | n/a | 0.6678 | 0.4210 | 0.3333 | 0.5716 | 0.6748 | 0.7397 | 0.6580 |
| 0.5 | 0.5556 | 0.5392 | 0.7368 | 0.4425 | 0.4355 | 0.0000 | 0.4286 | 0.8932 | 0.8750 | 0.8073 | 0.8889 | 1.0000 | 0.7047 | 1.0000 | 0.9129 | 0.4234 | n/a | n/a | 1.0000 | 0.7500 | 0.5000 | n/a | 0.6678 | 0.4210 | 0.3333 | 0.5686 | 0.6713 | 0.7397 | 0.6558 |
| 0.6 | 0.5556 | 0.5392 | 0.7368 | 0.4425 | 0.4355 | 0.0000 | 0.4286 | 0.8932 | 0.8750 | 0.8073 | 0.8889 | 1.0000 | 0.7047 | 1.0000 | 0.9129 | 0.4234 | n/a | n/a | 1.0000 | 0.7500 | 0.5000 | n/a | 0.6678 | 0.4210 | 0.3333 | 0.5686 | 0.6713 | 0.7397 | 0.6558 |
| 0.7 | 0.5556 | 0.5392 | 0.7368 | 0.4425 | 0.4355 | 0.0000 | 0.4286 | 0.8932 | 0.8750 | 0.8073 | 0.8889 | 1.0000 | 0.7047 | 1.0000 | 0.9129 | 0.4234 | n/a | n/a | 1.0000 | 0.7500 | 0.5000 | n/a | 0.6678 | 0.4210 | 0.3333 | 0.5686 | 0.6713 | 0.7397 | 0.6558 |
| 0.8 | 0.5556 | 0.5392 | 0.7368 | 0.4425 | 0.4355 | 0.0000 | 0.4286 | 0.8932 | 0.8750 | 0.8073 | 0.8889 | 1.0000 | 0.7047 | 1.0000 | 0.9129 | 0.4234 | n/a | n/a | 1.0000 | 0.7500 | 0.5000 | n/a | 0.6678 | 0.4210 | 0.3333 | 0.5686 | 0.6713 | 0.7397 | 0.6558 |
| 0.9 | 0.5556 | 0.5392 | 0.7368 | 0.4425 | 0.4355 | 0.0000 | 0.4286 | 0.8932 | 0.8750 | 0.8073 | 0.8889 | 1.0000 | 0.7047 | 1.0000 | 0.9129 | 0.4234 | n/a | n/a | 1.0000 | 0.7500 | 0.5000 | n/a | 0.6678 | 0.4210 | 0.3333 | 0.5686 | 0.6713 | 0.7397 | 0.6558 |

## Notes

- Fixture run: eval/config/retrieval-params.json was not touched.
