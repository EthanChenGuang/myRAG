# Phase 06 comparison

Result: FAIL

Noise band: max(3 x baseline spread, 0.02) on Recall@5, Recall@10 and MRR over the overall, every language and every category slice. Paired differences are against the committed baseline of the run's fixture mode.

## Notes

- Fixture corpus only. Fixture gains reflect the lexical fixture embedder (hashed n-grams, research P-13) and the scripted fake query LLM (D-39); cache distances are on the fixture-ngram profile, whose committed calibration is source default at 0.05. Live numbers are plan 06-46.
- Every switch compared here defaults to off in src/lib/env.ts; the on runs set them for the app under test only.
- Phase 6 (D-42): (a) with RAG_QUERY_LAYER=false both legacy smoke tiers have every paired difference zero against the Phase 4 baselines, and query-layer-off equals v2-all-off item by item; (b) the default framework (LlamaIndex) with the layer on holds multi_turn, compound and cross_lingual against query-layer-off, with no overall, language or category slice beyond the noise band on Recall@5, Recall@10, MRR or the refusal rates; (c) framework_parity and the paired framework report (rag_eval.compare frameworks --fixtures); (d) transform_delays and voice_budget; (e) the cache-pair run's hit p95 is at most half its miss p95, no near-miss pair hits at the effective distance, the cache-off and cache-on item runs equal the layer-on run item by item, and the two-tenant canary suite with its cache cases passes.
- The item runs send no semantic_cache override, so the eval route checks no cache in them (06-41); the cache is measured on the golden cache pairs (--cache-pairs), probed at 0.2 and judged at the effective distance.
- The shipped defaults stay off: RAG_QUERY_LAYER=false and RAG_SEMANTIC_CACHE=off in src/lib/env.ts until the Phase 7 regression decides them.

## Verdicts

| Check | Verdict | Evidence |
|---|---|---|
| (a) Layer off: legacy paired differences zero, query-layer-off equals v2-all-off | PASS | legacy-prechunked/gate, legacy-prechunked/paired_all_zero, legacy-ingest/gate, legacy-ingest/paired_all_zero, query-layer-off/equal_runs:v2-all-off |
| (b) Layer on (LlamaIndex): multi_turn, compound, cross_lingual hold; no slice beyond the noise band | FAIL | query-layer-llamaindex/slice_hold:query-layer-off (FAIL) |
| (c) Framework parity suite and the paired framework report | PASS | query-layer-llamaindex/framework_parity, query-layer-llamaindex/framework_report |
| (d) Transform injected-delay and failure tests, voice budget | PASS | query-layer-llamaindex/transform_delays, query-layer-llamaindex/voice_budget |
| (e) Cache: hit p95 at most half of miss p95, near-miss wrong hits 0, cache off and on equal the layer-on run, canary suite | PASS | cache-pairs/cache_latency, cache-pairs/near_miss_zero, query-layer-llamaindex-cache-off/equal_runs:query-layer-llamaindex, query-layer-llamaindex-cache-on/equal_runs:query-layer-llamaindex, cache-pairs/cache_canary, cache-pairs/two_tenant_matrix |

## Runs

### legacy-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: none. Harness flags: none.

Run-config env: RAG_PIPELINE=legacy, RAG_QUERY_LAYER=false.

Injection (all_off, report_only): 18 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 6 |
| language:en | 1.0000 | 1.0000 | 6 |
| language:it | 1.0000 | 1.0000 | 6 |
| language:zh | 1.0000 | 1.0000 | 6 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 2 |
| overall | 1.0000 | 1.0000 | 18 |

Recall@5 0.5664, Recall@10 0.5664, MRR 0.5396, correct refusal 0.6800, false refusal 0.3357, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| gate | PASS | - |
| paired_all_zero | PASS | - |

### legacy-ingest

Fixture mode: ingest. Result: PASS.

Switches: none. Harness flags: none.

Run-config env: RAG_PIPELINE=legacy, RAG_QUERY_LAYER=false.

Injection (all_off, report_only): 18 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 6 |
| language:en | 1.0000 | 1.0000 | 6 |
| language:it | 1.0000 | 1.0000 | 6 |
| language:zh | 1.0000 | 1.0000 | 6 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 2 |
| overall | 1.0000 | 1.0000 | 18 |

Recall@5 0.7119, Recall@10 0.7232, MRR 0.6177, correct refusal 0.5333, false refusal 0.1921, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| gate | PASS | - |
| paired_all_zero | PASS | - |

### v2-all-off

Fixture mode: prechunked. Result: PASS.

Switches: none. Harness flags: none.

Run-config env: RAG_PIPELINE=v2.

Injection (all_off, report_only): 18 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 6 |
| language:en | 1.0000 | 1.0000 | 6 |
| language:it | 1.0000 | 1.0000 | 6 |
| language:zh | 1.0000 | 1.0000 | 6 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 2 |
| overall | 1.0000 | 1.0000 | 18 |

Recall@5 0.8531, Recall@10 0.8741, MRR 0.7650, correct refusal 0.3600, false refusal 0.0210, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### query-layer-off

Fixture mode: prechunked. Result: PASS.

Switches: none. Harness flags: none.

Run-config env: RAG_PIPELINE=v2, RAG_QUERY_LAYER=false.

Injection (all_off, report_only): 18 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 6 |
| language:en | 1.0000 | 1.0000 | 6 |
| language:it | 1.0000 | 1.0000 | 6 |
| language:zh | 1.0000 | 1.0000 | 6 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 2 |
| overall | 1.0000 | 1.0000 | 18 |

Recall@5 0.8531, Recall@10 0.8741, MRR 0.7650, correct refusal 0.3600, false refusal 0.0210, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| equal_runs:v2-all-off | PASS | - |

| Check | Measure | Value |
|---|---|---|
| equal_runs:v2-all-off | items_compared | 247.0000 |
| equal_runs:v2-all-off | items_differing | 0.0000 |

### query-layer-llamaindex

Fixture mode: prechunked. Result: FAIL.

Switches: none. Harness flags: none.

Run-config env: RAG_PIPELINE=v2, RAG_QUERY_LAYER=true.

Injection (all_off, report_only): 18 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 6 |
| language:en | 1.0000 | 1.0000 | 6 |
| language:it | 1.0000 | 1.0000 | 6 |
| language:zh | 1.0000 | 1.0000 | 6 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 2 |
| overall | 1.0000 | 1.0000 | 18 |

Recall@5 0.8531, Recall@10 0.8741, MRR 0.7691, correct refusal 0.2400, false refusal 0.0210, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| slice_hold:query-layer-off | FAIL | category:small_talk:correct_refusal_rate 0.0000 < 0.9800 (query-layer-off 1.0000); language:en:correct_refusal_rate 0.2222 < 0.3133 (query-layer-off 0.3333); language:it:correct_refusal_rate 0.1250 < 0.2300 (query-layer-off 0.2500); language:zh:correct_refusal_rate 0.3750 < 0.4800 (query-layer-off 0.5000); overall:correct_refusal_rate 0.2400 < 0.3400 (query-layer-off 0.3600) |
| framework_parity | PASS | - |
| transform_delays | PASS | - |
| voice_budget | PASS | - |
| framework_report | PASS | - |

| Check | Measure | Value |
|---|---|---|
| slice_hold:query-layer-off | category:compound:mrr_delta | 0.0185 |
| slice_hold:query-layer-off | category:compound:recall_at_10_delta | 0.0000 |
| slice_hold:query-layer-off | category:compound:recall_at_5_delta | 0.0000 |
| slice_hold:query-layer-off | category:cross_lingual:mrr_delta | 0.0000 |
| slice_hold:query-layer-off | category:cross_lingual:recall_at_10_delta | 0.0000 |
| slice_hold:query-layer-off | category:cross_lingual:recall_at_5_delta | 0.0000 |
| slice_hold:query-layer-off | category:multi_turn:mrr_delta | 0.0260 |
| slice_hold:query-layer-off | category:multi_turn:recall_at_10_delta | 0.0000 |
| slice_hold:query-layer-off | category:multi_turn:recall_at_5_delta | 0.0000 |

### query-layer-llamaindex-cache-off

Fixture mode: prechunked. Result: PASS.

Switches: none. Harness flags: none.

Run-config env: RAG_PIPELINE=v2, RAG_QUERY_LAYER=true, RAG_SEMANTIC_CACHE=off.

Injection (all_off, report_only): 18 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 6 |
| language:en | 1.0000 | 1.0000 | 6 |
| language:it | 1.0000 | 1.0000 | 6 |
| language:zh | 1.0000 | 1.0000 | 6 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 2 |
| overall | 1.0000 | 1.0000 | 18 |

Recall@5 0.8531, Recall@10 0.8741, MRR 0.7691, correct refusal 0.2400, false refusal 0.0210, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| equal_runs:query-layer-llamaindex | PASS | - |

| Check | Measure | Value |
|---|---|---|
| equal_runs:query-layer-llamaindex | items_compared | 247.0000 |
| equal_runs:query-layer-llamaindex | items_differing | 0.0000 |

### query-layer-llamaindex-cache-on

Fixture mode: prechunked. Result: PASS.

Switches: none. Harness flags: none.

Run-config env: RAG_PIPELINE=v2, RAG_QUERY_LAYER=true, RAG_SEMANTIC_CACHE=pgvector.

Injection (all_off, report_only): 18 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 6 |
| language:en | 1.0000 | 1.0000 | 6 |
| language:it | 1.0000 | 1.0000 | 6 |
| language:zh | 1.0000 | 1.0000 | 6 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 2 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 2 |
| overall | 1.0000 | 1.0000 | 18 |

Recall@5 0.8531, Recall@10 0.8741, MRR 0.7691, correct refusal 0.2400, false refusal 0.0210, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| equal_runs:query-layer-llamaindex | PASS | - |

| Check | Measure | Value |
|---|---|---|
| equal_runs:query-layer-llamaindex | items_compared | 247.0000 |
| equal_runs:query-layer-llamaindex | items_differing | 0.0000 |

### cache-pairs

Fixture mode: prechunked. Result: PASS.

Switches: none. Harness flags: --cache-pairs.

Run-config env: RAG_PIPELINE=v2, RAG_QUERY_LAYER=true.

Cache-pair run: 27 golden pair(s), 54 trace(s), probe distance 0.2, embedding profile fixture-ngram.

| Check | Result | Detail |
|---|---|---|
| cache_latency | PASS | - |
| near_miss_zero | PASS | - |
| cache_canary | PASS | - |
| two_tenant_matrix | PASS | - |

| Check | Measure | Value |
|---|---|---|
| cache_latency | hit_p50_ms | 3.0000 |
| cache_latency | hit_p95_ms | 14.0000 |
| cache_latency | hits | 6.0000 |
| cache_latency | max_ratio | 0.5000 |
| cache_latency | miss_p50_ms | 19.0000 |
| cache_latency | miss_p95_ms | 51.0000 |
| cache_latency | misses | 36.0000 |
| cache_latency | ratio | 0.2745 |
| near_miss_zero | max_distance | 0.0500 |
| near_miss_zero | near_miss_pairs | 15.0000 |
| near_miss_zero | near_miss_wrong_hit_rate | 0.0000 |
| near_miss_zero | near_miss_wrong_hits | 0.0000 |
