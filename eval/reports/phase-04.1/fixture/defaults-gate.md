# Phase 4.1 defaults gate

Result: FAIL
Refusal basis: single_threshold
Floor: none chosen; no-key fallback: none chosen
Noise band: max(3.0 x spread, 0.02)
G2 absolute ingest Recall@10 floor (derived): 0.685479

## Failures

- v2-default failed
- v2-default-no-cells failed
- v2-default-hosted-fake failed
- v2-default-hosted-fake-no-cells failed
- floor: neither floor passes: no flip (D-13)
- no-key fallback: neither fallback passes: no flip (D-13)

## Sources

| Role | Path | sha256 |
| --- | --- | --- |
| baseline:prechunked | eval/baselines/fixture-baseline.json | 08882ce5a26a4a7297b5c1eb1794f27b1161830a459fdbf6468495e4aa682d48 |
| baseline:ingest | eval/baselines/fixture-ingest-baseline.json | b8d2064ef98d2846451f97ce98e947d0f5170e38c37d1bddfaca04d22d6580fa |
| noise | eval/config/noise.json | 959adc75a6d7f06ad6319d5bc179daa692cf067b6a1bc731af1224d3f2d42333 |
| latency_budgets | eval/config/latency-budgets.json | a1db13ff1f595dc988d07a1ac3cbbfd3b34e21e3a659074b0fbd724cea369212 |
| g8 | eval/reports/phase-04.1/fixture/g8-input.json | 2626f2133c580d50b5a7812e7e458e556125559bb87db3305afed9026e791064 |
| report:v2-default:prechunked | eval/out/p41r/v2-default-prechunked/report.json | 1c18d61085e7f7cbebaaf0812ac2c7d89dfbb3a90e2f6637f66e44e17124f172 |
| report:v2-default:ingest | eval/out/p41r/v2-default-ingest/report.json | 1b9f749c0f1e97d7a2da8f59ce47643e5544f72a921ebc7612e8a612381dca17 |
| report:v2-default-no-cells:prechunked | eval/out/p41r/v2-default-no-cells-prechunked/report.json | 85f05ccf97647097cb42eead4d8e5c3cb2d105db8b36007656b5f91933bcfc00 |
| report:v2-default-no-cells:ingest | eval/out/p41r/v2-default-no-cells-ingest/report.json | e8c74b0b5bcdfb4dd9f4f61be1a20c883fbae3451dc95f95f6195f8cbad822fe |
| report:v2-default-hosted-fake:prechunked | eval/out/p41r/v2-default-hosted-fake-prechunked/report.json | 529c47cfc17b67142600b5f13b535c75af7f2aefd45e388e66d3d249f67c2892 |
| report:v2-default-hosted-fake:ingest | eval/out/p41r/v2-default-hosted-fake-ingest/report.json | 187892e49d2fd0a47cfb2b757cfadcf76638dc59ab357708912d32a39c91f436 |
| report:v2-default-hosted-fake-no-cells:prechunked | eval/out/p41r/v2-default-hosted-fake-no-cells-prechunked/report.json | bb9b276b889a4fc0d0181de6b8def372e8491a775c79e202f421e66807ed7d39 |
| report:v2-default-hosted-fake-no-cells:ingest | eval/out/p41r/v2-default-hosted-fake-no-cells-ingest/report.json | eb165ca641b9042c4058ce03aaad63c1bbe4c340ad41b9e7ee29a63cdab68f28 |
| report:v2-default-similarity-floor:prechunked | eval/out/p41r/v2-default-similarity-floor-prechunked/report.json | 36ac9082a2ec42ea8c5112a45aa38dac413c7a88346e4edf13112dde4cac71e6 |
| report:v2-default-similarity-floor:ingest | eval/out/p41r/v2-default-similarity-floor-ingest/report.json | d081af74c445c7b88bd83df55e376c7628f0952d95a13345277f393eaee03d6e |
| report:v2-default-similarity-floor-no-cells:prechunked | eval/out/p41r/v2-default-similarity-floor-no-cells-prechunked/report.json | 2709a9de5d7e8557ef5e13396a74905a7f48411626eb36d1c9a31a77e849b013 |
| report:v2-default-similarity-floor-no-cells:ingest | eval/out/p41r/v2-default-similarity-floor-no-cells-ingest/report.json | 34618dc7a6daf4d262ec72fa89a573472fda70f140e067479f911ff173dba475 |
| report:v2-default-similarity-floor-hosted-fake:prechunked | eval/out/p41r/v2-default-similarity-floor-hosted-fake-prechunked/report.json | 8cf79f39d43210dfe7f178f9c9f43202a8545ad855dae0a36e2c475a9d0a8017 |
| report:v2-default-similarity-floor-hosted-fake:ingest | eval/out/p41r/v2-default-similarity-floor-hosted-fake-ingest/report.json | f8a1db2b9937fcc90721b68ec486f5a4e3e40dfd900261ef461b89a87ab11287 |
| report:v2-default-similarity-floor-hosted-fake-no-cells:prechunked | eval/out/p41r/v2-default-similarity-floor-hosted-fake-no-cells-prechunked/report.json | a7412245daeac7bfc6e9557007576ea7bcf795ae3be0d1de8fd66b17cc101166 |
| report:v2-default-similarity-floor-hosted-fake-no-cells:ingest | eval/out/p41r/v2-default-similarity-floor-hosted-fake-no-cells-ingest/report.json | ead9364f656d3221f12882ee5ccf8294f37b1b4319fdf021d64160e4428c6991 |
| report:v2-default-fallback-none:prechunked | eval/out/p41r/v2-default-fallback-none-prechunked/report.json | d93d4190262cb6164aac82d6bf53ac72bb507da1c19d305e0aa8e1d1a19b1864 |
| report:v2-default-fallback-none:ingest | eval/out/p41r/v2-default-fallback-none-ingest/report.json | c340b0f5995d3d7670987886aa0b9cadfd313fc55c247dda00d4a05de152effe |
| report:v2-default-fallback-none-no-cells:prechunked | eval/out/p41r/v2-default-fallback-none-no-cells-prechunked/report.json | 123307b502bfd27aec1cf51afaae9f1022e7726c67138390bd9b09cb90cc33fd |
| report:v2-default-fallback-none-no-cells:ingest | eval/out/p41r/v2-default-fallback-none-no-cells-ingest/report.json | 588855fcfa691b905a28909cfefb62fd4eb86bb4988f6b89f84e461c1a2f92aa |
| report:legacy:prechunked | eval/out/p41r/legacy-prechunked/report.json | cc56f5eb1f6ebc01f06267dfc2a599d6ec01c8878cd3d5212845df3aa0ac7a24 |
| report:legacy:ingest | eval/out/p41r/legacy-ingest/report.json | f8c86c2f3ac6ac39cf35bc80064512bca2b77b54b0419c8c2c2e8283e4cb9343 |
| criteria | eval/config/defaults-gate.json | b72983d45f1898058d62b54d38832aa3f48c8b8a4232db8d291465506d1bbfe4 |

## v2-default (required): fail

### prechunked: run 0f912168-c2b7-4321-9840-cdb49b38742d, run_config_hash 20ea7611730b950bb79c589c1025c360cbc6854ea189f56930a1e561c8dca4b6, report sha256 1c18d61085e7f7cbebaaf0812ac2c7d89dfbb3a90e2f6637f66e44e17124f172

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a |  | n/a | n/a | n/a | n/a | pass (no offender; 7 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.5893 | 112 | 0.5068 | 0.5268 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.3750 | 112 | 0.3950 | 0.3750 | 0.0200 | 0.4566 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 0.7083 | 24 | 0.6883 | 0.7083 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 0.6667 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5278 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.2000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0500 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8571 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8214 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.4188 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.2500 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.1875 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 42.0000 | 202 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 19.0000 | 202 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 1156b2d3-d027-4699-8e02-98c06fca6769, run_config_hash 132f9c986a577a2afa31512abbb6fe5e79c4f885843dc32cdbe6980da11f6c27, report sha256 1b9f749c0f1e97d7a2da8f59ce47643e5544f72a921ebc7612e8a612381dca17

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | false_refusal_rate | 0.2698 |  | 0.2263 | 0.2063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_10 | 0.6825 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_5 | 0.6825 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | false_refusal_rate | 0.3333 |  | 0.2508 | 0.2308 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.6154 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.5897 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | false_refusal_rate | 0.3182 |  | 0.2473 | 0.2273 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_10 | 0.6818 |  | 0.7414 | 0.7614 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_5 | 0.6818 |  | 0.6959 | 0.7159 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | false_refusal_rate | 0.3014 |  | 0.2392 | 0.2192 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_10 | 0.6644 |  | 0.6855 | 0.7055 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_5 | 0.6575 |  | 0.6718 | 0.6918 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.1667 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G2 (fail) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.6644 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G2 (fail) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.6644 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.3014 | 146 | 0.2392 | 0.2192 | 0.0200 | 0.3699 | fail |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.6897 | 29 | 0.5317 | 0.5517 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.6538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5278 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.2000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0500 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3696 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.9231 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.8077 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | recall_at_10 | 0.8696 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8696 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.4083 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9464 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.5385 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | mrr | 0.5000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 0.6667 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 48.0000 | 263 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 18.0000 | 263 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-no-cells (required): fail

### prechunked: run 91c6f79e-7b1f-4bc5-9745-104e9277960f, run_config_hash 7a17df86cb32dfa3b6979c40c57b5bfafa998b69a22e7197418ef8c5d078524a, report sha256 85f05ccf97647097cb42eead4d8e5c3cb2d105db8b36007656b5f91933bcfc00

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a |  | n/a | n/a | n/a | n/a | pass (no offender; 7 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.5893 | 112 | 0.5068 | 0.5268 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.3750 | 112 | 0.3950 | 0.3750 | 0.0200 | 0.4566 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 0.7083 | 24 | 0.6883 | 0.7083 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 0.6667 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5278 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.2000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0500 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8571 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8214 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.4188 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.2500 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.1875 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 55.0000 | 202 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 25.0000 | 202 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 6bf95da3-e56e-48ec-af86-f8cb5c5e4a6c, run_config_hash a34a3fb2a24584a525b003a307ef0b4f3b8f8bbc181cb0423ebd1bf6ac10c6a6, report sha256 e8c74b0b5bcdfb4dd9f4f61be1a20c883fbae3451dc95f95f6195f8cbad822fe

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | false_refusal_rate | 0.2698 |  | 0.2263 | 0.2063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_10 | 0.6825 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_5 | 0.6825 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | false_refusal_rate | 0.3333 |  | 0.2508 | 0.2308 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.6154 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.5897 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | false_refusal_rate | 0.3182 |  | 0.2473 | 0.2273 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_10 | 0.6818 |  | 0.7414 | 0.7614 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_5 | 0.6818 |  | 0.6959 | 0.7159 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | false_refusal_rate | 0.3014 |  | 0.2392 | 0.2192 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_10 | 0.6644 |  | 0.6855 | 0.7055 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_5 | 0.6575 |  | 0.6718 | 0.6918 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.1667 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G2 (fail) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.6644 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G2 (fail) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.6644 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.3014 | 146 | 0.2392 | 0.2192 | 0.0200 | 0.3699 | fail |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.6897 | 29 | 0.5317 | 0.5517 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.6538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5278 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.2000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0500 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3696 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.9231 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.8077 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | recall_at_10 | 0.8696 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8696 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.4083 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9464 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.5385 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | mrr | 0.5000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 0.6667 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 52.0000 | 263 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 21.0000 | 263 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-hosted-fake (required): fail

### prechunked: run 9cb184e7-240e-46f1-a2cf-477586539618, run_config_hash 4e9d2a67db083baa84cbc1f170c4d0bfb995ac0bfaeb50c764b734a60230b1c0, report sha256 529c47cfc17b67142600b5f13b535c75af7f2aefd45e388e66d3d249f67c2892

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.5556 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.4286 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.5000 |  | 0.7300 | 0.7500 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.5000 |  | 0.6883 | 0.7083 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8333 | 112 | 0.5068 | 0.5268 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0536 | 112 | 0.3950 | 0.3750 | 0.0200 | 0.1030 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.5000 | 24 | 0.6883 | 0.7083 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.4286 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.7083 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 0.9259 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | mrr | 0.9444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.9375 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | mrr | 0.7958 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.7500 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.7500 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7708 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.5000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 80.0000 | 202 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 58.0000 | 202 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run f764cb0b-2264-470d-9a3f-34881abe557e, run_config_hash 3c0911137cce6db7a0224259a626fd5c96648c97f9f751ee3f5149dab1447904, report sha256 187892e49d2fd0a47cfb2b757cfadcf76638dc59ab357708912d32a39c91f436

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.3636 |  | 0.4345 | 0.4545 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.5000 |  | 0.7300 | 0.7500 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.3000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.3793 |  | 0.5317 | 0.5517 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8721 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8721 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0274 | 146 | 0.2392 | 0.2192 | 0.0200 | 0.0616 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.3793 | 29 | 0.5317 | 0.5517 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.3077 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.7083 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 0.9259 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | mrr | 0.9444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.3913 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 0.9615 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9565 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.9375 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | mrr | 0.7958 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:scanned | mrr | 0.9429 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 1.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 1.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.8590 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | recall_at_10 | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.5000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 91.0000 | 263 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 59.0000 | 263 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-hosted-fake-no-cells (required): fail

### prechunked: run 2017f9e8-196e-4a23-a8c0-97cf6ff1b272, run_config_hash f9b32533547a799a2915e3f8ee3e7ee4112dd98c112b1fa8374e18628eb4bb9b, report sha256 bb9b276b889a4fc0d0181de6b8def372e8491a775c79e202f421e66807ed7d39

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a |  | n/a | n/a | n/a | n/a | pass (no offender; 7 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.5893 | 112 | 0.5068 | 0.5268 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.3750 | 112 | 0.3950 | 0.3750 | 0.0200 | 0.4566 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 0.7083 | 24 | 0.6883 | 0.7083 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 0.6667 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.2000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.0286 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | mrr | 0.4444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 0.8571 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.8571 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | mrr | 0.4000 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:table | recall_at_10 | 0.2500 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.1875 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 85.0000 | 202 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 59.0000 | 202 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run f6adcb11-173f-44c7-823a-68e8683ae8cd, run_config_hash 291a5ddd38c4e6f913feea26ee16773b175cd7940b8b54dfe582de9da6de2ff8, report sha256 eb165ca641b9042c4058ce03aaad63c1bbe4c340ad41b9e7ee29a63cdab68f28

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | false_refusal_rate | 0.2698 |  | 0.2263 | 0.2063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_10 | 0.6825 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_5 | 0.6825 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | false_refusal_rate | 0.3333 |  | 0.2508 | 0.2308 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.6154 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.5897 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | false_refusal_rate | 0.3182 |  | 0.2473 | 0.2273 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_10 | 0.6818 |  | 0.7414 | 0.7614 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_5 | 0.6818 |  | 0.6959 | 0.7159 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | false_refusal_rate | 0.3014 |  | 0.2392 | 0.2192 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_10 | 0.6644 |  | 0.6855 | 0.7055 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_5 | 0.6575 |  | 0.6718 | 0.6918 | n/a | n/a | fail (noise_band) |
| G2 (fail) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.6644 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G2 (fail) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.6644 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.3014 | 146 | 0.2392 | 0.2192 | 0.0200 | 0.3699 | fail |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.6897 | 29 | 0.5317 | 0.5517 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.6538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.2000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0286 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3913 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.9231 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.8846 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8696 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8696 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.4000 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9429 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.5385 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | mrr | 0.5000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 85.0000 | 263 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 55.0000 | 263 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor (candidate): fail

### prechunked: run 5b827bb0-0556-458c-82c2-d2efd37c8119, run_config_hash 10061e1c920495496ce01bf77c6c579aeab0354c43c00a5a19b63031e4f2c3bb, report sha256 36ac9082a2ec42ea8c5112a45aa38dac413c7a88346e4edf13112dde4cac71e6

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.3333 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.2857 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.5000 |  | 0.7300 | 0.7500 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.3750 |  | 0.6883 | 0.7083 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8810 | 112 | 0.5068 | 0.5268 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0268 | 112 | 0.3950 | 0.3750 | 0.0200 | 0.0678 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.3750 | 24 | 0.6883 | 0.7083 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.7778 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.4900 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 0.9630 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | mrr | 0.9444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.5238 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.4425 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.9375 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | mrr | 0.7833 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7917 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 42.0000 | 202 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 18.0000 | 202 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run ad5f41bd-de9d-4e50-9a32-58d82856c9fc, run_config_hash f748851d4904090c141ad365b48875e51fa8715a5815308764aa88bbf2ab0aba, report sha256 d081af74c445c7b88bd83df55e376c7628f0952d95a13345277f393eaee03d6e

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | category:cross_lingual | false_refusal_rate | 1.0000 |  | 0.4113 | 0.3913 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | mrr | 0.0000 |  | 0.3496 | 0.3696 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_10 | 0.0000 |  | 0.3713 | 0.3913 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_5 | 0.0000 |  | 0.3713 | 0.3913 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | false_refusal_rate | 0.8095 |  | 0.2263 | 0.2063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | mrr | 0.1746 |  | 0.5996 | 0.6196 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_10 | 0.1905 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_5 | 0.1905 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | false_refusal_rate | 0.9231 |  | 0.2508 | 0.2308 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | mrr | 0.0641 |  | 0.4911 | 0.5111 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.0769 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.0769 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | false_refusal_rate | 0.9318 |  | 0.2473 | 0.2273 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | mrr | 0.0568 |  | 0.6323 | 0.6523 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_10 | 0.0682 |  | 0.7414 | 0.7614 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_5 | 0.0682 |  | 0.6959 | 0.7159 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | false_refusal_rate | 0.8767 |  | 0.2392 | 0.2192 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | mrr | 0.1096 |  | 0.5805 | 0.6005 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_10 | 0.1233 |  | 0.6855 | 0.7055 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_5 | 0.1233 |  | 0.6718 | 0.6918 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | false_refusal_rate | 1.0000 |  | 0.4200 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | mrr | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_10 | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_5 | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | false_refusal_rate | 1.0000 |  | 0.4486 | 0.4286 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | mrr | 0.0000 |  | 0.1943 | 0.2143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_10 | 0.0000 |  | 0.2657 | 0.2857 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_5 | 0.0000 |  | 0.2657 | 0.2857 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | false_refusal_rate | 1.0000 |  | 0.5200 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | mrr | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_10 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_5 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G2 (fail) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.1233 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G2 (fail) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.1233 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.8767 | 146 | 0.2392 | 0.2192 | 0.0200 | 0.9188 | fail |
| G3 (fail) | refusal | overall | correct_refusal_rate | 1.0000 | 29 | 0.5317 | 0.5517 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.1111 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | mrr | 0.1111 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.0000 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | mrr | 0.0000 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.0000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | recall_at_10 | 0.1304 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | mrr | 0.1304 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 0.6000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 0.6000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.0000 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:multi_turn | mrr | 0.0000 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 0.2857 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:scanned | mrr | 0.2857 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.1250 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.1250 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.0769 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | mrr | 0.0769 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table_split | recall_at_10 | 0.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 0.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | recall_at_10 | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 46.0000 | 263 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 19.0000 | 263 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor-no-cells (candidate): fail

### prechunked: run 8c41efbc-cdd1-4a4e-a7cb-1196943e97f8, run_config_hash 58b5193622f3b8432e268db7adeca59b32d4274bfe643a42443b4ca3baa1c8b8, report sha256 2709a9de5d7e8557ef5e13396a74905a7f48411626eb36d1c9a31a77e849b013

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.3333 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.2857 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.5000 |  | 0.7300 | 0.7500 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.3750 |  | 0.6883 | 0.7083 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8810 | 112 | 0.5068 | 0.5268 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0268 | 112 | 0.3950 | 0.3750 | 0.0200 | 0.0678 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.3750 | 24 | 0.6883 | 0.7083 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.7778 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.4900 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 0.9630 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | mrr | 0.9444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.5238 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.4425 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.9375 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | mrr | 0.7833 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7917 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 44.0000 | 202 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 19.0000 | 202 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run ca58bf6f-e5fd-413d-87a8-cd2cf3b46abe, run_config_hash 96de6d78819bbc852ffa9398caf0e7171400b2a05070daa47e67f45c6eb020a4, report sha256 34618dc7a6daf4d262ec72fa89a573472fda70f140e067479f911ff173dba475

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | category:cross_lingual | false_refusal_rate | 1.0000 |  | 0.4113 | 0.3913 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | mrr | 0.0000 |  | 0.3496 | 0.3696 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_10 | 0.0000 |  | 0.3713 | 0.3913 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_5 | 0.0000 |  | 0.3713 | 0.3913 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | false_refusal_rate | 0.8095 |  | 0.2263 | 0.2063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | mrr | 0.1746 |  | 0.5996 | 0.6196 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_10 | 0.1905 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_5 | 0.1905 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | false_refusal_rate | 0.9231 |  | 0.2508 | 0.2308 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | mrr | 0.0641 |  | 0.4911 | 0.5111 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.0769 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.0769 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | false_refusal_rate | 0.9318 |  | 0.2473 | 0.2273 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | mrr | 0.0568 |  | 0.6323 | 0.6523 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_10 | 0.0682 |  | 0.7414 | 0.7614 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_5 | 0.0682 |  | 0.6959 | 0.7159 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | false_refusal_rate | 0.8767 |  | 0.2392 | 0.2192 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | mrr | 0.1096 |  | 0.5805 | 0.6005 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_10 | 0.1233 |  | 0.6855 | 0.7055 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_5 | 0.1233 |  | 0.6718 | 0.6918 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | false_refusal_rate | 1.0000 |  | 0.4200 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | mrr | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_10 | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_5 | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | false_refusal_rate | 1.0000 |  | 0.4486 | 0.4286 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | mrr | 0.0000 |  | 0.1943 | 0.2143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_10 | 0.0000 |  | 0.2657 | 0.2857 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_5 | 0.0000 |  | 0.2657 | 0.2857 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | false_refusal_rate | 1.0000 |  | 0.5200 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | mrr | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_10 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_5 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G2 (fail) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.1233 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G2 (fail) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.1233 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.8767 | 146 | 0.2392 | 0.2192 | 0.0200 | 0.9188 | fail |
| G3 (fail) | refusal | overall | correct_refusal_rate | 1.0000 | 29 | 0.5317 | 0.5517 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.1111 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | mrr | 0.1111 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.0000 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | mrr | 0.0000 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.0000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | recall_at_10 | 0.1304 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | mrr | 0.1304 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 0.6000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 0.6000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.0000 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:multi_turn | mrr | 0.0000 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 0.2857 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:scanned | mrr | 0.2857 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.1250 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.1250 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.0769 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | mrr | 0.0769 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table_split | recall_at_10 | 0.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 0.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | recall_at_10 | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 50.0000 | 263 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 21.0000 | 263 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor-hosted-fake (candidate): fail

### prechunked: run 40898575-241e-4b38-ba0a-d009656dd4a9, run_config_hash 4ca16428c0e6897f3b17c1bbe1b98fb1234d720883640f9d1d0b881ce774c2e5, report sha256 8cf79f39d43210dfe7f178f9c9f43202a8545ad855dae0a36e2c475a9d0a8017

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.4444 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.2857 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.3750 |  | 0.7300 | 0.7500 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.3750 |  | 0.6883 | 0.7083 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8601 | 112 | 0.5068 | 0.5268 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0089 | 112 | 0.3950 | 0.3750 | 0.0200 | 0.0417 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.3750 | 24 | 0.6883 | 0.7083 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 0.9259 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | mrr | 0.9444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.9375 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | mrr | 0.7958 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7708 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 86.0000 | 202 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 62.0000 | 202 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 98923df2-3b9c-42c0-abb3-22dd4096b543, run_config_hash d74410a11dbb5e07b4448d97562e40b57f2cfd074b682587f6c69c85312af46b, report sha256 f8a1db2b9937fcc90721b68ec486f5a4e3e40dfd900261ef461b89a87ab11287

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | category:cross_lingual | mrr | 0.0870 |  | 0.3496 | 0.3696 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_10 | 0.0870 |  | 0.3713 | 0.3913 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_5 | 0.0870 |  | 0.3713 | 0.3913 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.3636 |  | 0.4345 | 0.4545 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.5000 |  | 0.7300 | 0.7500 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.3000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.3793 |  | 0.5317 | 0.5517 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | mrr | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_10 | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_5 | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | false_refusal_rate | 0.6667 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | mrr | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_10 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_5 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8037 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8037 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0959 | 146 | 0.2392 | 0.2192 | 0.0200 | 0.1458 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.3793 | 29 | 0.5317 | 0.5517 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.3077 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.9259 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.9444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.0870 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | mrr | 0.0870 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.9231 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.8846 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 1.0000 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9565 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8750 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.7333 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9429 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 1.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 1.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8590 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | recall_at_10 | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.5000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 88.0000 | 263 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 58.0000 | 263 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor-hosted-fake-no-cells (candidate): fail

### prechunked: run 8ecb5e7e-6b0b-4f3a-ac3a-2db9c2e4d1e9, run_config_hash ecaf1d09d8485b4444ed03778f7a13553971e8579913cd86ca5e5e6a6ce4a23f, report sha256 a7412245daeac7bfc6e9557007576ea7bcf795ae3be0d1de8fd66b17cc101166

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.3333 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.2857 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.5000 |  | 0.7300 | 0.7500 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.3750 |  | 0.6883 | 0.7083 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8601 | 112 | 0.5068 | 0.5268 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0268 | 112 | 0.3950 | 0.3750 | 0.0200 | 0.0678 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.3750 | 24 | 0.6883 | 0.7083 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 0.9259 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | mrr | 0.9444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.9375 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | mrr | 0.7958 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7708 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 86.0000 | 202 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 60.0000 | 202 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 193d18a3-638c-4ff9-a676-d7836402c565, run_config_hash 827cfece2aff71ff67a7e4cd5f5e7e677ebd4dc5829edb35a0c5b6d7aee30aa3, report sha256 ead9364f656d3221f12882ee5ccf8294f37b1b4319fdf021d64160e4428c6991

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | category:cross_lingual | false_refusal_rate | 1.0000 |  | 0.4113 | 0.3913 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | mrr | 0.0000 |  | 0.3496 | 0.3696 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_10 | 0.0000 |  | 0.3713 | 0.3913 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_5 | 0.0000 |  | 0.3713 | 0.3913 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | false_refusal_rate | 0.8095 |  | 0.2263 | 0.2063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | mrr | 0.1746 |  | 0.5996 | 0.6196 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_10 | 0.1905 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_5 | 0.1905 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | false_refusal_rate | 0.9231 |  | 0.2508 | 0.2308 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | mrr | 0.0641 |  | 0.4911 | 0.5111 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.0769 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.0769 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | false_refusal_rate | 0.9318 |  | 0.2473 | 0.2273 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | mrr | 0.0568 |  | 0.6323 | 0.6523 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_10 | 0.0682 |  | 0.7414 | 0.7614 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_5 | 0.0682 |  | 0.6959 | 0.7159 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | false_refusal_rate | 0.8767 |  | 0.2392 | 0.2192 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | mrr | 0.1096 |  | 0.5805 | 0.6005 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_10 | 0.1233 |  | 0.6855 | 0.7055 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_5 | 0.1233 |  | 0.6718 | 0.6918 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | false_refusal_rate | 1.0000 |  | 0.4200 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | mrr | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_10 | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_5 | 0.0000 |  | 0.1800 | 0.2000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | false_refusal_rate | 1.0000 |  | 0.4486 | 0.4286 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | mrr | 0.0000 |  | 0.1943 | 0.2143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_10 | 0.0000 |  | 0.2657 | 0.2857 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_5 | 0.0000 |  | 0.2657 | 0.2857 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | false_refusal_rate | 1.0000 |  | 0.5200 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | mrr | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_10 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_5 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G2 (fail) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.1233 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G2 (fail) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.1233 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.8767 | 146 | 0.2392 | 0.2192 | 0.0200 | 0.9188 | fail |
| G3 (fail) | refusal | overall | correct_refusal_rate | 1.0000 | 29 | 0.5317 | 0.5517 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.1111 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | mrr | 0.1111 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.0000 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | mrr | 0.0000 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.0000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | recall_at_10 | 0.1304 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | mrr | 0.1304 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 0.6000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 0.6000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.0000 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:multi_turn | mrr | 0.0000 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 0.2857 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:scanned | mrr | 0.2857 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.1250 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.1250 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.0769 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | mrr | 0.0769 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table_split | recall_at_10 | 0.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 0.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | recall_at_10 | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 78.0000 | 263 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 52.0000 | 263 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-fallback-none (candidate): fail

### prechunked: run 9e5fd27e-6550-453c-bf03-f9f392fc86c0, run_config_hash f8d0eccfaa72b98d42532823c96df7c2086c75ec859c916a2ad1934146f7499c, report sha256 d93d4190262cb6164aac82d6bf53ac72bb507da1c19d305e0aa8e1d1a19b1864

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a |  | n/a | n/a | n/a | n/a | pass (no offender; 7 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.5893 | 112 | 0.5068 | 0.5268 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.3750 | 112 | 0.3950 | 0.3750 | 0.0200 | 0.4566 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 0.7083 | 24 | 0.6883 | 0.7083 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 0.6667 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.2000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0286 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8571 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8571 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.3854 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.8333 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.2500 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.0938 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 24.0000 | 202 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 202 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run d39fd37c-5dbe-4541-b3d0-fee5d3ba8eff, run_config_hash 9d30dcf03e8639d1e44bb1808211db7b9a307fc3e322784410edd34e95a92930, report sha256 c340b0f5995d3d7670987886aa0b9cadfd313fc55c247dda00d4a05de152effe

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | false_refusal_rate | 0.2698 |  | 0.2263 | 0.2063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | mrr | 0.5926 |  | 0.5996 | 0.6196 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_10 | 0.6825 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_5 | 0.6667 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | false_refusal_rate | 0.3333 |  | 0.2508 | 0.2308 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.6154 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.5897 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | false_refusal_rate | 0.3182 |  | 0.2473 | 0.2273 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_10 | 0.6818 |  | 0.7414 | 0.7614 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_5 | 0.6818 |  | 0.6959 | 0.7159 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | false_refusal_rate | 0.3014 |  | 0.2392 | 0.2192 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_10 | 0.6644 |  | 0.6855 | 0.7055 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_5 | 0.6507 |  | 0.6718 | 0.6918 | n/a | n/a | fail (noise_band) |
| G2 (fail) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.6644 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G2 (fail) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.6644 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.3014 | 146 | 0.2392 | 0.2192 | 0.0200 | 0.3699 | fail |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.6897 | 29 | 0.5317 | 0.5517 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.6538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.2000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0286 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3696 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.9231 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.9231 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8696 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8261 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.5667 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 0.7000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.3490 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9048 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.5385 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | mrr | 0.5000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 0.8333 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 30.0000 | 263 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 263 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-fallback-none-no-cells (candidate): fail

### prechunked: run d5403cb3-d2b4-4577-819b-7647c327bd02, run_config_hash 764819dbdb61fa33f5b74f0d6435934cb6a9447cbc91d05b2de53b7effc718e5, report sha256 123307b502bfd27aec1cf51afaae9f1022e7726c67138390bd9b09cb90cc33fd

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a |  | n/a | n/a | n/a | n/a | pass (no offender; 7 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.5893 | 112 | 0.5068 | 0.5268 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.3750 | 112 | 0.3950 | 0.3750 | 0.0200 | 0.4566 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 0.7083 | 24 | 0.6883 | 0.7083 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 0.6667 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.2000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0286 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8571 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8571 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.3854 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.8333 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.2500 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.0938 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 22.0000 | 202 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 202 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 3e888924-8611-4b0f-b226-bc62e8cf72d8, run_config_hash 637a94208cf45ed17e3c6e3b5874b1dff85e05fc4c56c93adfe630c20509d90c, report sha256 588855fcfa691b905a28909cfefb62fd4eb86bb4988f6b89f84e461c1a2f92aa

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | false_refusal_rate | 0.2698 |  | 0.2263 | 0.2063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | mrr | 0.5926 |  | 0.5996 | 0.6196 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_10 | 0.6825 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_5 | 0.6667 |  | 0.6863 | 0.7063 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | false_refusal_rate | 0.3333 |  | 0.2508 | 0.2308 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.6154 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.5897 |  | 0.6210 | 0.6410 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | false_refusal_rate | 0.3182 |  | 0.2473 | 0.2273 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_10 | 0.6818 |  | 0.7414 | 0.7614 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_5 | 0.6818 |  | 0.6959 | 0.7159 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | false_refusal_rate | 0.3014 |  | 0.2392 | 0.2192 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_10 | 0.6644 |  | 0.6855 | 0.7055 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_5 | 0.6507 |  | 0.6718 | 0.6918 | n/a | n/a | fail (noise_band) |
| G2 (fail) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.6644 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G2 (fail) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.6644 | 146 | 0.6855 | 0.7055 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.3014 | 146 | 0.2392 | 0.2192 | 0.0200 | 0.3699 | fail |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.6897 | 29 | 0.5317 | 0.5517 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.6538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.2000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0286 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3696 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.9231 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.9231 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8696 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8261 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.5667 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 0.7000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.3490 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9048 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:table | recall_at_10 | 0.5385 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | mrr | 0.5000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 0.8333 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 33.0000 | 263 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 263 | 600.0000 | n/a | n/a | n/a | pass |

## legacy (legacy): pass

### prechunked: run 655196b3-0c0b-4bc9-aa54-dc954e329da1, run_config_hash 87b61a3eb219a6a87632c97d5a34fb7c1dcc730abb0ca2250b1f137097eacb72, report sha256 cc56f5eb1f6ebc01f06267dfc2a599d6ec01c8878cd3d5212845df3aa0ac7a24

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G6 (pass) | paired_all_zero |  |  | n/a |  | n/a | n/a | n/a | n/a | pass |

### ingest: run 2f5f7b2c-5fca-4c07-8b1d-6d95cb887cc4, run_config_hash fe268dbb9f94b6a346212ba24070a8f487db77f056dfc337c0f1ae53afec95d7, report sha256 f8c86c2f3ac6ac39cf35bc80064512bca2b77b54b0419c8c2c2e8283e4cb9343

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G6 (pass) | paired_all_zero |  |  | n/a |  | n/a | n/a | n/a | n/a | pass |

## G8

Status: pass
- two-tenant matrix: single-tenant True, multi-tenant True
- negative checks fail as designed: drop_top_candidate True, max_results 1 True
- drop_top_candidate under v2-default (prechunked): exit 10, gate passed=False, offenders=42, mismatches=0, overall mrr margin 0.4182
- max_results 1 under v2-default (prechunked): exit 10, gate passed=False, offenders=11, mismatches=0
- control (plain v2-default, prechunked) against the same scratch baseline: exit 0, gate passed=True
- drop_top_candidate under v2-default (ingest): exit 10, gate passed=False, offenders=39, mismatches=0, overall mrr margin 0.4566
- max_results 1 under v2-default (ingest): exit 10, gate passed=False, offenders=18, mismatches=0
- control (plain v2-default, ingest) against the same scratch baseline: exit 0, gate passed=True
- negative checks are gated against scratch baselines recorded with rag_eval.baseline record-reports from three v2-default runs per mode under eval/out/p41r-neg (not committed), without --allow-spread in both modes; the pr-smoke.yml jq conditions are applied to each gate.json
- two-tenant matrix under the D-01 values: node --test name pattern 'under the D-01 values: multi-tenant' exit 0, 'under the D-01 values: single-tenant' exit 0 (keyless and with the fixture key)

## Floor (D-04)

Chosen: none (neither floor passes: no flip (D-13))

- legacy_rule: fail, score 0.6342, configurations v2-default, v2-default-no-cells, v2-default-hosted-fake, v2-default-hosted-fake-no-cells
  - v2-default failed
  - v2-default-no-cells failed
  - v2-default-hosted-fake failed
  - v2-default-hosted-fake-no-cells failed
- similarity: fail, score 0.6099, configurations v2-default-similarity-floor, v2-default-similarity-floor-no-cells, v2-default-similarity-floor-hosted-fake, v2-default-similarity-floor-hosted-fake-no-cells
  - v2-default-similarity-floor failed
  - v2-default-similarity-floor-no-cells failed
  - v2-default-similarity-floor-hosted-fake failed
  - v2-default-similarity-floor-hosted-fake-no-cells failed

## No-key fallback (D-06)

Chosen: none (neither fallback passes: no flip (D-13))

- local_bm25: fail, score n/a, configurations v2-default, v2-default-no-cells
  - v2-default failed
  - v2-default-no-cells failed
  - v2-default vs v2-default-fallback-none (prechunked) overall recall_at_10: 0.5893 vs 0.5693 (none 0.5893 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (prechunked) overall mrr: 0.5301 vs 0.5036 (none 0.5236 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (prechunked) category:cross_lingual recall_at_10: 0.4286 vs 0.4086 (none 0.4286 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (ingest) overall recall_at_10: 0.6644 vs 0.6444 (none 0.6644 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (ingest) overall mrr: 0.5973 vs 0.5620 (none 0.5820 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (ingest) category:cross_lingual recall_at_10: 0.3913 vs 0.3713 (none 0.3913 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (prechunked) overall recall_at_10: 0.5893 vs 0.5693 (none 0.5893 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (prechunked) overall mrr: 0.5301 vs 0.5036 (none 0.5236 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (prechunked) category:cross_lingual recall_at_10: 0.4286 vs 0.4086 (none 0.4286 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (ingest) overall recall_at_10: 0.6644 vs 0.6444 (none 0.6644 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (ingest) overall mrr: 0.5973 vs 0.5620 (none 0.5820 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (ingest) category:cross_lingual recall_at_10: 0.3913 vs 0.3713 (none 0.3913 - band 0.0200) pass
- none: fail, score n/a, configurations v2-default-fallback-none, v2-default-fallback-none-no-cells
  - v2-default-fallback-none failed
  - v2-default-fallback-none-no-cells failed

## G7

Live, report-only: filled from plan 04.1-08's result by plan 04.1-07.
