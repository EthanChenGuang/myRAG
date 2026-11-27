# Eval report: run-test

- Tier: smoke
- Deployment mode: single
- Items: 4
- Run config hash: rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr
- Golden sha256: gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg
- Scored review statuses: approved; gated split: dev
- Gate population: all
- Corpus sha256: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
- Embedder: fixture-embedder (version 3)
- RAG mode: strict
- Golden set: version n/a, manifest n/a
- Stale items: 0 (share 0.000)
- Refusals (overall): correct refusal 1.000 (n=1), false answer 0.000 (n=1)

Rates are rounded to 3 decimals for display; report.json holds the unrounded values. n is the number of items behind each rate.

Overall, language, language pair and category tables cover the dev split only. Categories are report-only except cross_lingual; only overall, per-language, cross_lingual and per-language-pair slices gate (D-20, D-41). The held-out test split is reported under By split and never gates (D-14).

## Overall

| Slice | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal | False refusal upper 95 | nDCG@k | k = 0 |
|---|---|---|---|---|---|---|---|---|
| overall | 0.333 (n=3) | 0.333 (n=3) | 0.333 (n=3) | 1.000 (n=1) | 0.333 (n=3) | 0.865 | 0.333 (n=3) | 1 |

## By split

| Split | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal | False refusal upper 95 | nDCG@k | k = 0 |
|---|---|---|---|---|---|---|---|---|
| dev | 0.333 (n=3) | 0.333 (n=3) | 0.333 (n=3) | 1.000 (n=1) | 0.333 (n=3) | 0.865 | 0.333 (n=3) | 1 |

## By language

| Language | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal | False refusal upper 95 | nDCG@k | k = 0 |
|---|---|---|---|---|---|---|---|---|
| en | 0.000 (n=1) | 0.000 (n=1) | 0.000 (n=1) | 1.000 (n=1) | 1.000 (n=1) | 1.000 | 0.000 (n=1) | 1 |
| it | 0.000 (n=1) | 0.000 (n=1) | 0.000 (n=1) | n/a (n=0) | 0.000 (n=1) | 0.950 | 0.000 (n=1) | 0 |
| zh | 1.000 (n=1) | 1.000 (n=1) | 1.000 (n=1) | n/a (n=0) | 0.000 (n=1) | 0.950 | 1.000 (n=1) | 0 |

## By category

| Category | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal | False refusal upper 95 | nDCG@k | k = 0 |
|---|---|---|---|---|---|---|---|---|
| general | 0.333 (n=3) | 0.333 (n=3) | 0.333 (n=3) | n/a (n=0) | 0.333 (n=3) | 0.865 | 0.333 (n=3) | 1 |
| no_answer | n/a (n=0) | n/a (n=0) | n/a (n=0) | 1.000 (n=1) | n/a (n=0) | 1.000 | n/a (n=0) | - |

## By language and category

| Language/category | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal | False refusal upper 95 | nDCG@k | k = 0 |
|---|---|---|---|---|---|---|---|---|
| en/general | 0.000 (n=1) | 0.000 (n=1) | 0.000 (n=1) | n/a (n=0) | 1.000 (n=1) | 1.000 | 0.000 (n=1) | 1 |
| en/no_answer | n/a (n=0) | n/a (n=0) | n/a (n=0) | 1.000 (n=1) | n/a (n=0) | 1.000 | n/a (n=0) | - |
| it/general | 0.000 (n=1) | 0.000 (n=1) | 0.000 (n=1) | n/a (n=0) | 0.000 (n=1) | 0.950 | 0.000 (n=1) | 0 |
| zh/general | 1.000 (n=1) | 1.000 (n=1) | 1.000 (n=1) | n/a (n=0) | 0.000 (n=1) | 0.950 | 1.000 (n=1) | 0 |

## By document type

| Document type | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal | False refusal upper 95 | nDCG@k | k = 0 |
|---|---|---|---|---|---|---|---|---|
| general | 0.333 (n=3) | 0.333 (n=3) | 0.333 (n=3) | 1.000 (n=1) | 0.333 (n=3) | 0.865 | 0.333 (n=3) | 1 |

## By question kind

| Question kind | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal | False refusal upper 95 | nDCG@k | k = 0 |
|---|---|---|---|---|---|---|---|---|
| fact_lookup | 0.333 (n=3) | 0.333 (n=3) | 0.333 (n=3) | n/a (n=0) | 0.333 (n=3) | 0.865 | 0.333 (n=3) | 1 |
| other | n/a (n=0) | n/a (n=0) | n/a (n=0) | 1.000 (n=1) | n/a (n=0) | 1.000 | n/a (n=0) | - |

## By provenance

| Provenance | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal | False refusal upper 95 | nDCG@k | k = 0 |
|---|---|---|---|---|---|---|---|---|
| synthetic_fixture | 0.333 (n=3) | 0.333 (n=3) | 0.333 (n=3) | 1.000 (n=1) | 0.333 (n=3) | 0.865 | 0.333 (n=3) | 1 |

## By provenance and category

| Provenance/category | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal | False refusal upper 95 | nDCG@k | k = 0 |
|---|---|---|---|---|---|---|---|---|
| synthetic_fixture/general | 0.333 (n=3) | 0.333 (n=3) | 0.333 (n=3) | n/a (n=0) | 0.333 (n=3) | 0.865 | 0.333 (n=3) | 1 |
| synthetic_fixture/no_answer | n/a (n=0) | n/a (n=0) | n/a (n=0) | 1.000 (n=1) | n/a (n=0) | 1.000 | n/a (n=0) | - |

## Retrieval stage metrics

- Rerank skipped rate: n/a (n=0)
- Lexical leg hit rate@10: 0.333 (n=3)

False refusal upper 95 is the exact one-sided 95% Clopper-Pearson upper bound on the false-refusal rate of the slice (answerable items only); a point estimate at or below a target says nothing until this bound does too.

nDCG@k is report-only (D-07): k is the number of chunks sent to the model for each item, relevance is binary by gold-span match, and the ideal DCG uses the gold unit count capped at k. k = 0 counts answerable items whose context was empty or refused; they score 0.

## Native review backlog

Informational for the owner (D-45): zh and it items no native speaker has approved yet. Pending items are machine-translated or LLM-drafted and report-only until a named reviewer approves them; existing synthetic_fixture items keep counting so no baseline moves. Only a human reviewer records an approval.

- Items: 2

| Language | Pending (report-only) | Existing (still counting) | Total |
|---|---|---|---|
| it | 0 | 1 | 1 |
| zh | 0 | 1 | 1 |

| Item | Language | State |
|---|---|---|
| it-general-001 | it | existing, not yet reviewed, still counting |
| zh-general-001 | zh | existing, not yet reviewed, still counting |

## Notes

- Filter 1 Chinese empty-term quirk: the chat route's name/content filter derives an empty query term for Chinese queries, so every retrieved chunk passes Filter 1 and zh retrieval is not narrowed by it; zh slices can look better than en and it slices for that reason.
