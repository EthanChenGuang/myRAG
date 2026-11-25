# Phase 4 comparison (D-28)

Result: FAIL

Noise band: a slice drops beyond the noise band when it falls more than max(3 x baseline spread, 0.02) below its reference. Rules (b) and (c) check the overall, every language and every category slice on Recall@5, Recall@10 and MRR (the CI gate checks fewer slices).

- Fixture corpus only. Fixture gains mostly reflect the lexical fixture embedder (hashed n-grams, research F-9) and, against the legacy baseline, dropping the legacy 0.65 post-filter; live verification decides real gains.
- The shipped defaults stay off (D-28): every switch compared here is off in src/lib/env.ts until the Phase 7 regression.
- Slice comparisons of v2 runs align request_options with the observed run: a named run differs from its reference by design (for example rerank_model or chunking_profile_by_doc_type). Golden, corpus, embedder, tier and mode must still match.
- Parent-child runs use sweep candidate p128-512: the recorded contract_legal decision is legacy.
- XLG-03: no cross cell has a threshold on the fixture; XLG-03 is decided by the live calibration (04-43).

## Verdicts

| Rule | Verdict |
| --- | --- |
| (a) legacy parity | PASS |
| (b) v2-recommended vs baseline and v2-all-off | FAIL |
| (c) parent-child | PASS |
| (c) compression | PASS |
| (c) translation (local_bm25) | PASS |
| (c) iterative scan (synthetic database) | PASS |
| (d) conformance suite | PASS (exit 0) |
| (d) voice budget | PASS (exit 0) |
| local_bm25 refusal not threshold-based (F-3) | PASS |
| XLG-03 cross vs same false refusal | not_comparable |

## (a) Legacy parity

| Run | All paired differences zero | Gate passed | Non-zero cells |
| --- | --- | --- | --- |
| legacy-prechunked | yes | yes | none |
| legacy-ingest | yes | yes | none |

## (b) v2-recommended

#### Against the committed baseline: FAIL

- Correct refusal: 0.3333 (n=21) vs 0.6667; higher: no
- False refusal: 0.0116 (n=86, 95% upper 0.0540) vs 0.3953

No slice dropped beyond the noise band.

#### Against `v2-all-off`: FAIL

- Correct refusal: 0.3333 (n=21) vs 0.3333; higher: no
- False refusal: 0.0116 (n=86, 95% upper 0.0540) vs 0.0465

| Slice | Metric | Reference | Threshold | Observed |
| --- | --- | --- | --- | --- |
| category:scanned | mrr | 0.8333 | 0.8133 | 0.8125 |
| category:typo | mrr | 1.0000 | 0.9800 | 0.8333 |

Calibration outcome (plan 04-39): {"dev_correct_refusal_delta": 0.0, "dev_correct_refusal_improved": false, "dev_false_refusal_delta": -0.03488372093023256, "dev_false_refusal_upper_95_at_or_below_target": false, "dev_false_refusal_within_target_plus_noise": true}

## (c) Switches on and off

Chunking profile for the parent-child pair: `p128-512` (sweep_candidate; recorded contract_legal decision `legacy`).

### Parent-child (ingest mode): PASS

On `parent-child-on` vs off `parent-child-off`.

| Measure | Value |
| --- | --- |
| clause_recall_at_10_on | 0.5000 |
| clause_recall_at_10_off | 0.0000 |
| clause_recall_at_10_delta | 0.5000 |
| overall_recall_at_10_delta | 0.0303 |
| context_tokens_on | 765.0813 |
| context_tokens_off | 613.3821 |

Failures:
- none

No slice dropped beyond the noise band.

### Compression: PASS

On `compression-on` vs off `v2-recommended`.

| Measure | Value |
| --- | --- |
| context_tokens_on | 693.7570 |
| context_tokens_off | 942.6822 |
| context_tokens_delta | -248.9252 |
| overall_recall_at_10_delta | 0.0000 |
| overall_mrr_delta | 0.0000 |

Failures:
- none

No slice dropped beyond the noise band.

### Translation with local_bm25: PASS

On `translation-on` vs off `local-bm25`.

| Measure | Value |
| --- | --- |
| cross_lingual_recall_at_5_on | 0.8235 |
| cross_lingual_recall_at_5_off | 0.5294 |
| cross_lingual_recall_at_10_on | 0.8824 |
| cross_lingual_recall_at_10_off | 0.6471 |
| lexical_leg_hit_rate_at_10_on | 0.9302 |
| lexical_leg_hit_rate_at_10_off | 0.8837 |
| cross_lingual_lexical_leg_hit_rate_at_10_on | 0.8824 |
| cross_lingual_lexical_leg_hit_rate_at_10_off | 0.6471 |

Failures:
- none

No slice dropped beyond the noise band.

### Iterative scan: PASS

Fixture slice `category:selective_filter` (iterative-scan-relaxed vs v2-recommended), report only (the fixture never uses the HNSW index, research F-6): equal yes.

| Measure | Value |
| --- | --- |
| recall_at_5_on | 0.8750 |
| recall_at_5_off | 0.8750 |
| recall_at_10_on | 0.8750 |
| recall_at_10_off | 0.8750 |
| mrr_on | 0.8750 |
| mrr_off | 0.8750 |

Synthetic database (index forced):

| Slice | Mode | Rows | Recall@k | k |
| --- | --- | --- | --- | --- |
| rare_doc_type | off | 4 | 0.40 | 10 |
| rare_doc_type | relaxed_order | 10 | 1.00 | 10 |
| rare_doc_type | strict_order | 10 | 1.00 | 10 |
| rare_doc_type | exact | 10 | 1.00 | 10 |
| small_tenant | off | 1 | 0.10 | 10 |
| small_tenant | relaxed_order | 10 | 1.00 | 10 |
| small_tenant | strict_order | 10 | 1.00 | 10 |
| small_tenant | exact | 10 | 1.00 | 10 |

Failures:
- none

## (d) Commands

- Conformance: `npx vitest run tests/rag/backend-conformance` exit 0
- Voice budget: `npx vitest run tests/rag/v2/voice-budget.test.ts` exit 0

## local_bm25 with threshold refusal not applied (F-3)

Run `local-bm25`: rerank-threshold decisions 0; refusal bases {"none/answer": 96, "similarity_floor/refuse": 11}; correct refusal 0.3333, false refusal 0.0465.

## XLG-03

Verdict: not_comparable (0 comparable cells). no cross cell has a threshold on the fixture; XLG-03 is decided by the live calibration (04-43).

## Runs

| Run | Mode | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal (95% upper) | Lexical hit@10 | Context tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy-prechunked | prechunked | 0.5116 | 0.5116 | 0.5174 | 0.6667 | 0.3953 (0.4896) | n/a | 91.9 |
| legacy-ingest | ingest | 0.6263 | 0.6263 | 0.5791 | 0.5417 | 0.2626 (0.3452) | n/a | 130.6 |
| v2-all-off | prechunked | 0.8372 | 0.8721 | 0.7561 | 0.3333 | 0.0465 (0.1033) | 0.0000 | 895.6 |
| v2-recommended | prechunked | 0.8605 | 0.8837 | 0.7672 | 0.3333 | 0.0116 (0.0540) | 0.8721 | 942.7 |
| parent-child-off | ingest | 0.6616 | 0.6869 | 0.5967 | 0.2917 | 0.1515 (0.2237) | 0.6768 | 613.4 |
| parent-child-on | ingest | 0.6970 | 0.7172 | 0.6225 | 0.2917 | 0.1515 (0.2237) | 0.6667 | 765.1 |
| compression-on | prechunked | 0.8605 | 0.8837 | 0.7672 | 0.3333 | 0.0116 (0.0540) | 0.8721 | 693.8 |
| local-bm25 | prechunked | 0.8605 | 0.8953 | 0.7652 | 0.3333 | 0.0465 (0.1033) | 0.8837 | 916.3 |
| translation-on | prechunked | 0.9186 | 0.9419 | 0.8219 | 0.3333 | 0.0465 (0.1033) | 0.9302 | 912.1 |
| iterative-scan-relaxed | prechunked | 0.8605 | 0.8837 | 0.7672 | 0.3333 | 0.0116 (0.0540) | 0.8721 | 942.7 |
