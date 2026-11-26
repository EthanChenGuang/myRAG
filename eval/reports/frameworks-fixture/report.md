# Query-layer framework comparison: LangChain against LlamaIndex

> translate is compared as plumbing only: both frameworks render the same shared translate prompt, so a translate difference shows wiring, not prompt quality.
> Fused order: LangChain's EnsembleRetriever keeps first-seen order on tied fused scores while the native fusion breaks ties by chunk id, so tie-order differences are counted apart from rank differences.
> Fixture numbers reflect the lexical fixture embedder (word and n-gram hashing, not cross-lingual) and the scripted fake query LLM; they prove the comparison runs and the frameworks agree, not which framework retrieves better. The live comparison on the real golden set is a separate operator run.

Paired difference: langchain minus llamaindex, per item, on 229 items. Each cell is the mean difference with its 95% bootstrap interval (seed 20261123, 10000 resamples), the paired item count n and the count of items whose value differs (nz).

All paired differences zero: no.

| run | items | run config hash | embedder |
|---|---|---|---|
| llamaindex | 229 | `7d8a8b963811` | fixture-ngram |
| langchain | 229 | `9c011e5f7890` | fixture-ngram |

## Overall

| slice | recall_at_5 | recall_at_10 | mrr | correct_refusal_rate | false_refusal_rate |
|---|---|---|---|---|---|
| overall | +0.0000 [+0.0000, +0.0000] n=193 nz=0 | +0.0000 [+0.0000, +0.0000] n=193 nz=0 | -0.0033 [-0.0092, +0.0000] n=193 nz=2 | +0.0000 [+0.0000, +0.0000] n=36 nz=0 | +0.0000 [+0.0000, +0.0000] n=193 nz=0 |

## Per language

| slice | recall_at_5 | recall_at_10 | mrr | correct_refusal_rate | false_refusal_rate |
|---|---|---|---|---|---|
| en | +0.0000 [+0.0000, +0.0000] n=66 nz=0 | +0.0000 [+0.0000, +0.0000] n=66 nz=0 | -0.0076 [-0.0227, +0.0000] n=66 nz=1 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | +0.0000 [+0.0000, +0.0000] n=66 nz=0 |
| it | +0.0000 [+0.0000, +0.0000] n=66 nz=0 | +0.0000 [+0.0000, +0.0000] n=66 nz=0 | +0.0000 [+0.0000, +0.0000] n=66 nz=0 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | +0.0000 [+0.0000, +0.0000] n=66 nz=0 |
| zh | +0.0000 [+0.0000, +0.0000] n=61 nz=0 | +0.0000 [+0.0000, +0.0000] n=61 nz=0 | -0.0022 [-0.0066, +0.0000] n=61 nz=1 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | +0.0000 [+0.0000, +0.0000] n=61 nz=0 |

## Per category

| slice | recall_at_5 | recall_at_10 | mrr | correct_refusal_rate | false_refusal_rate |
|---|---|---|---|---|---|
| ambiguous | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 |
| cache_near_miss | +0.0000 [+0.0000, +0.0000] n=15 nz=0 | +0.0000 [+0.0000, +0.0000] n=15 nz=0 | -0.0089 [-0.0267, +0.0000] n=15 nz=1 | n=0 | +0.0000 [+0.0000, +0.0000] n=15 nz=0 |
| cache_paraphrase | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 |
| colloquial | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 |
| compound | +0.0000 [+0.0000, +0.0000] n=15 nz=0 | +0.0000 [+0.0000, +0.0000] n=15 nz=0 | +0.0000 [+0.0000, +0.0000] n=15 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=15 nz=0 |
| cross_lingual | +0.0000 [+0.0000, +0.0000] n=34 nz=0 | +0.0000 [+0.0000, +0.0000] n=34 nz=0 | +0.0000 [+0.0000, +0.0000] n=34 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=34 nz=0 |
| exact_term | +0.0000 [+0.0000, +0.0000] n=9 nz=0 | +0.0000 [+0.0000, +0.0000] n=9 nz=0 | +0.0000 [+0.0000, +0.0000] n=9 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=9 nz=0 |
| general | +0.0000 [+0.0000, +0.0000] n=18 nz=0 | +0.0000 [+0.0000, +0.0000] n=18 nz=0 | +0.0000 [+0.0000, +0.0000] n=18 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=18 nz=0 |
| injection | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 |
| injection_evasive | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 |
| multi_turn | +0.0000 [+0.0000, +0.0000] n=27 nz=0 | +0.0000 [+0.0000, +0.0000] n=27 nz=0 | -0.0185 [-0.0556, +0.0000] n=27 nz=1 | n=0 | +0.0000 [+0.0000, +0.0000] n=27 nz=0 |
| no_answer | n=0 | n=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=30 nz=0 | n=0 |
| scanned | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 |
| selective_filter | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=12 nz=0 |
| small_talk | n=0 | n=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | n=0 |
| table | +0.0000 [+0.0000, +0.0000] n=9 nz=0 | +0.0000 [+0.0000, +0.0000] n=9 nz=0 | +0.0000 [+0.0000, +0.0000] n=9 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=9 nz=0 |
| typo | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=6 nz=0 |

## Per language pair (query language -> evidence language)

| slice | recall_at_5 | recall_at_10 | mrr | correct_refusal_rate | false_refusal_rate |
|---|---|---|---|---|---|
| en->it | +0.0000 [+0.0000, +0.0000] n=5 nz=0 | +0.0000 [+0.0000, +0.0000] n=5 nz=0 | +0.0000 [+0.0000, +0.0000] n=5 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=5 nz=0 |
| en->zh | +0.0000 [+0.0000, +0.0000] n=8 nz=0 | +0.0000 [+0.0000, +0.0000] n=8 nz=0 | +0.0000 [+0.0000, +0.0000] n=8 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=8 nz=0 |
| it->en | +0.0000 [+0.0000, +0.0000] n=5 nz=0 | +0.0000 [+0.0000, +0.0000] n=5 nz=0 | +0.0000 [+0.0000, +0.0000] n=5 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=5 nz=0 |
| it->zh | +0.0000 [+0.0000, +0.0000] n=8 nz=0 | +0.0000 [+0.0000, +0.0000] n=8 nz=0 | +0.0000 [+0.0000, +0.0000] n=8 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=8 nz=0 |
| zh->en | +0.0000 [+0.0000, +0.0000] n=4 nz=0 | +0.0000 [+0.0000, +0.0000] n=4 nz=0 | +0.0000 [+0.0000, +0.0000] n=4 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=4 nz=0 |
| zh->it | +0.0000 [+0.0000, +0.0000] n=4 nz=0 | +0.0000 [+0.0000, +0.0000] n=4 nz=0 | +0.0000 [+0.0000, +0.0000] n=4 nz=0 | n=0 | +0.0000 [+0.0000, +0.0000] n=4 nz=0 |

## Per-transform output differences

| transform | items | item ids and differing fields |
|---|---|---|
| decompose | 1 | zh-cache-near-miss-015: sub_questions, variants[sub_question].count, status |

## Fused candidate order

Compared 229 items: 222 identical, 6 differ only by tie order, 1 differ by rank.

Tie order only: en-multi-turn-012, it-multi-turn-008, zh-multi-turn-001, zh-multi-turn-005, zh-multi-turn-007, zh-multi-turn-011

Rank differences: zh-cache-near-miss-015

## Problems

None.
