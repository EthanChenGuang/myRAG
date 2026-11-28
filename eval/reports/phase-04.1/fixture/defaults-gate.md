# Phase 4.1 defaults gate

Result: FAIL
Refusal basis: single_threshold
Floor: none chosen; no-key fallback: none chosen
Noise band: max(3.0 x spread, 0.02)
G2 absolute ingest Recall@10 floor (derived): 0.705610
Git sha: 405ee9172f010ee92f7e8a5dcf17074c94fd5c98; evaluated at: 2026-11-28T01:16:07.860032+00:00

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
| baseline:prechunked | eval/baselines/fixture-baseline.json | 1a93843f3de7fdb663d724356500a8c0fe7f8f73a7fac95a2f402011ca22f645 |
| baseline:ingest | eval/baselines/fixture-ingest-baseline.json | 0008a83d70d97ba2ad7cf7fdc5f535583c7642dc98252ef7ab54faddbd68408a |
| noise | eval/config/noise.json | d3d6534ac383888f369829ff0a88c3d115f334fc90310e9dc07feb2cd1bc57b7 |
| latency_budgets | eval/config/latency-budgets.json | 7eaadf5328479d25393d95cbfd43c0f32d13d2710354d14475d57dde3182d375 |
| g8 | eval/reports/phase-04.1/fixture/g8-input.json | aa317208e70deb3c8ac456a2ab308d6e4627346a5f205d6bebcd70177692496e |
| report:v2-default:prechunked | eval/out/p41g/v2-default-prechunked/report.json | b2a76b83e6eef8de3320f2e1bac10344586b0a3b57687abc26a958ce39b84200 |
| report:v2-default:ingest | eval/out/p41g/v2-default-ingest/report.json | 1302e60addf843714709c1189b4c563de15126eff3f4ff1a38e313d1c6e5df9b |
| report:v2-default-no-cells:prechunked | eval/out/p41g/v2-default-no-cells-prechunked/report.json | 774c746df1e6fc779f2091cc8c455d413f57516a5be7f30dd375f6ecc3fbd8c1 |
| report:v2-default-no-cells:ingest | eval/out/p41g/v2-default-no-cells-ingest/report.json | 9f02eb6bf128b963548d2ba55385307b7ed606797c74c6bab56f1d3a8c820828 |
| report:v2-default-hosted-fake:prechunked | eval/out/p41g/v2-default-hosted-fake-prechunked/report.json | 9235b2967715b65973e535db5fe108b7efced44cdf4da1e32ff4f55848c33690 |
| report:v2-default-hosted-fake:ingest | eval/out/p41g/v2-default-hosted-fake-ingest/report.json | 2049df23b22340d6bf7b04993ff08816aa98b7c91a7afaa5879b1bc9b06aa584 |
| report:v2-default-hosted-fake-no-cells:prechunked | eval/out/p41g/v2-default-hosted-fake-no-cells-prechunked/report.json | 2bb5062dc95eab2ab605b6ef68a078240f6a0e44ea52d6ab1e58755265b02a3c |
| report:v2-default-hosted-fake-no-cells:ingest | eval/out/p41g/v2-default-hosted-fake-no-cells-ingest/report.json | 6865237bc73b43b09b0df873528d59f9ad27be5e8c3ab4b15fe3954d00cb0c35 |
| report:v2-default-similarity-floor:prechunked | eval/out/p41g/v2-default-similarity-floor-prechunked/report.json | 365843ab783827dfda22799c9484dadf5e238135a7f91b69114aa4111c541007 |
| report:v2-default-similarity-floor:ingest | eval/out/p41g/v2-default-similarity-floor-ingest/report.json | 092b41c252b94f508856811b80db4d87dfe55005de885b68b54f5a8af77af566 |
| report:v2-default-similarity-floor-no-cells:prechunked | eval/out/p41g/v2-default-similarity-floor-no-cells-prechunked/report.json | 84dd4c1b15fb3e18b1cf827f62e0d08e3ca5eadfce9e8d9b6f4201b545cbedb4 |
| report:v2-default-similarity-floor-no-cells:ingest | eval/out/p41g/v2-default-similarity-floor-no-cells-ingest/report.json | 37e65833efb6423c983f42728023c7f2451f6b8da6bc8454019db1a3e2a1493b |
| report:v2-default-similarity-floor-hosted-fake:prechunked | eval/out/p41g/v2-default-similarity-floor-hosted-fake-prechunked/report.json | a582bcbb3af4cb78ba655a618a26722bbaa5423480a46d068222e2921412fbab |
| report:v2-default-similarity-floor-hosted-fake:ingest | eval/out/p41g/v2-default-similarity-floor-hosted-fake-ingest/report.json | 07f86aa58b7d549830ea57d7aa4a1bde9bbb509412d9331c1ed33d33b4517b83 |
| report:v2-default-similarity-floor-hosted-fake-no-cells:prechunked | eval/out/p41g/v2-default-similarity-floor-hosted-fake-no-cells-prechunked/report.json | 2782596f75be4cb6d79f578c1862dd4a4af1a27a27ac2f5bb48b3442f7fffa2f |
| report:v2-default-similarity-floor-hosted-fake-no-cells:ingest | eval/out/p41g/v2-default-similarity-floor-hosted-fake-no-cells-ingest/report.json | ebd67805e13dec227b6a5172e3beb7eb1ca07c61e3186b5a7c3cb04614e2546b |
| report:v2-default-fallback-none:prechunked | eval/out/p41g/v2-default-fallback-none-prechunked/report.json | 26171fe7b0909848d391db87b03dbe2e0c893c8028527f7ed6b1923f81f2941f |
| report:v2-default-fallback-none:ingest | eval/out/p41g/v2-default-fallback-none-ingest/report.json | 4cc34a86ee90b4f838c63df2b55ab0628354bc9a754fd59804a574475d898bce |
| report:v2-default-fallback-none-no-cells:prechunked | eval/out/p41g/v2-default-fallback-none-no-cells-prechunked/report.json | 1a4cee7ac848048d14f21939bb1f5e2e4de501621da4ef9a3d47dc58547afb89 |
| report:v2-default-fallback-none-no-cells:ingest | eval/out/p41g/v2-default-fallback-none-no-cells-ingest/report.json | 1f3c9b5cdc4e9f9450cbbcb746d80d4cb7ad7a7cfde6d4277d2c1fb1c90ad4c7 |
| report:legacy:prechunked | eval/out/p41g/legacy-prechunked/report.json | a2d7482e563183bdf4f13e3aaebcf82dcc77a780ba242b2fdab7bf4df1915f2a |
| report:legacy:ingest | eval/out/p41g/legacy-ingest/report.json | c90c73cb665fcdfd5f15e71a15d01c314f64f680b00929fd833852f16da934f8 |
| criteria | eval/config/defaults-gate.json | 82db8a3c02657f579cccfb067a4f8c8fce13f63a881d98edb2262d28fc22b0f5 |

## v2-default (required): fail

### prechunked: run 56e77967-3b8e-4022-ba4c-ffaff156447f, run_config_hash 8746ef079468c9f2c03c5122c65a6fda3db28b1c172264a7a11c156aa67d1212, report sha256 b2a76b83e6eef8de3320f2e1bac10344586b0a3b57687abc26a958ce39b84200

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | mrr | 0.5533 | 83 | 0.5684 | 0.5884 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.7267 | 236 | 0.6643 | 0.6843 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.2373 | 236 | 0.2573 | 0.2373 | 0.0200 | 0.2873 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 48 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 38 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5278 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.6364 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.5076 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.7778 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7222 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.7500 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.3552 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.0000 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | mrr | 0.0000 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8158 | 19 | 0.7958 | 0.8158 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8596 | 19 | 0.8747 | 0.8947 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 0.8889 | 9 | 0.8689 | 0.8889 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 0.8889 | 9 | 0.7207 | 0.7407 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 0.9643 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8929 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.4062 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.7857 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.5500 | 10 | 0.6800 | 0.7000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 0.4545 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.4091 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 31.0000 | 413 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 2.0000 | 413 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 5d590d00-21c3-4459-b3be-e3bdfb650b4d, run_config_hash 4689bf71cbe9bb507a8b0f80e58da37a1913b522f2606d4fea48264c5ccc71ac, report sha256 1302e60addf843714709c1189b4c563de15126eff3f4ff1a38e313d1c6e5df9b

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.7515 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.7515 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.1951 | 328 | 0.2121 | 0.1921 | 0.0200 | 0.2346 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 62 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 52 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5278 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.9091 | 11 | 0.7073 | 0.7273 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.7803 | 11 | 0.5709 | 0.5909 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7500 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.7500 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.3865 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.6667 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.6111 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.1111 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | mrr | 0.1111 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3696 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 0.8333 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8846 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8393 | 28 | 0.8193 | 0.8393 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8571 | 28 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.6967 | 0.7167 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 0.9643 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8929 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.6250 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.5260 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9375 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.9000 | 10 | 0.6300 | 0.6500 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 16 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8958 | 16 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:templated_collection | recall_at_10 | 0.4828 | 58 | 0.4110 | 0.4310 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:templated_collection | mrr | 0.3934 | 58 | 0.3707 | 0.3907 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 46.0000 | 561 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 2.0000 | 561 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-no-cells (required): fail

### prechunked: run 724690f1-7224-4268-b2b3-a145fcc3ee53, run_config_hash cb4fdc35fb2e7dbbd7bdd97e6132c6821d9659b7ac511d1381f4fcd39e905a4a, report sha256 774c746df1e6fc779f2091cc8c455d413f57516a5be7f30dd375f6ecc3fbd8c1

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | mrr | 0.5533 | 83 | 0.5684 | 0.5884 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.7267 | 236 | 0.6643 | 0.6843 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.2373 | 236 | 0.2573 | 0.2373 | 0.0200 | 0.2873 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 48 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 38 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5278 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.6364 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.5076 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.7778 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7222 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.7500 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.3552 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.0000 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | mrr | 0.0000 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8158 | 19 | 0.7958 | 0.8158 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8596 | 19 | 0.8747 | 0.8947 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 0.8889 | 9 | 0.8689 | 0.8889 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 0.8889 | 9 | 0.7207 | 0.7407 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 0.9643 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8929 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.4062 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.7857 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.5500 | 10 | 0.6800 | 0.7000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 0.4545 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.4091 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 32.0000 | 413 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 2.0000 | 413 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 1880ff8c-8ad3-49ef-b636-3b1132dbb973, run_config_hash b466df27e270cdfa9ed8fdf7736ac7ac7985e29430df041bf1381466026a519c, report sha256 9f02eb6bf128b963548d2ba55385307b7ed606797c74c6bab56f1d3a8c820828

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.7515 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.7515 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.1951 | 328 | 0.2121 | 0.1921 | 0.0200 | 0.2346 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 62 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 52 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5278 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.9091 | 11 | 0.7073 | 0.7273 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.7803 | 11 | 0.5709 | 0.5909 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7500 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.7500 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.3865 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.6667 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.6111 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.1111 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | mrr | 0.1111 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3696 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 0.8333 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8846 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8393 | 28 | 0.8193 | 0.8393 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8571 | 28 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.6967 | 0.7167 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 0.9643 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8929 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.6250 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.5260 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9375 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.9000 | 10 | 0.6300 | 0.6500 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 16 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8958 | 16 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:templated_collection | recall_at_10 | 0.4828 | 58 | 0.4110 | 0.4310 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:templated_collection | mrr | 0.3934 | 58 | 0.3707 | 0.3907 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 47.0000 | 561 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 2.0000 | 561 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-hosted-fake (required): fail

### prechunked: run 6144812c-64c2-42f7-9777-29685b5837a9, run_config_hash 362f175a3ee577c1dc92eb64d87ffb1d47c2744a538b4df41e50b6835547ac7e, report sha256 9235b2967715b65973e535db5fe108b7efced44cdf4da1e32ff4f55848c33690

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a | n/a | n/a | n/a | n/a | n/a | pass (no offender; 7 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.9047 | 236 | 0.6643 | 0.6843 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.0339 | 236 | 0.2573 | 0.2373 | 0.0200 | 0.0603 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 48 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 38 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.7083 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 1.0000 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.8636 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7778 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.9375 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.6725 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | recall_at_10 | 0.8889 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.9444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 1.0000 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | mrr | 0.8889 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.9211 | 19 | 0.7958 | 0.8158 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9474 | 19 | 0.8747 | 0.8947 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.8689 | 0.8889 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.7207 | 0.7407 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 1.0000 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8810 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.9375 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.7865 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 0.7500 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.7500 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.7500 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.7500 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.6500 | 10 | 0.6800 | 0.7000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8333 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.5000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 150.0000 | 413 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 127.0000 | 413 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 39eca42d-17ee-41dc-8ac4-669cf1e12fa5, run_config_hash b12856ebeb271162fc413d943beaae24145d904ed2878f21fb70351a793ef7a5, report sha256 2049df23b22340d6bf7b04993ff08816aa98b7c91a7afaa5879b1bc9b06aa584

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.9565 | 23 | 0.9800 | 1.0000 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8796 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8796 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.0396 | 328 | 0.2121 | 0.1921 | 0.0200 | 0.0623 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 0.9839 | 62 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 0.9808 | 52 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.7083 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cache_near_miss | recall_at_10 | 1.0000 | 11 | 0.7073 | 0.7273 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cache_near_miss | mrr | 0.8636 | 11 | 0.5709 | 0.5909 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cache_paraphrase | mrr | 0.7500 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.9375 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:colloquial | mrr | 0.6740 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | recall_at_10 | 0.8889 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | mrr | 0.9444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:context_overflow | recall_at_10 | 1.0000 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:context_overflow | mrr | 1.0000 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.3913 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 0.9615 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 0.9464 | 28 | 0.8193 | 0.8393 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9464 | 28 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:implicit_condition | mrr | 0.9286 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.6967 | 0.7167 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_step_calc | recall_at_10 | 1.0000 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_step_calc | mrr | 0.8810 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.9375 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | mrr | 0.7865 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:scanned | mrr | 0.9388 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:stale_version | mrr | 0.7500 | 10 | 0.6300 | 0.6500 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 16 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.8854 | 16 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:templated_collection | recall_at_10 | 0.7069 | 58 | 0.4110 | 0.4310 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:templated_collection | mrr | 0.6059 | 58 | 0.3707 | 0.3907 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.5000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 115.0000 | 561 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 76.0000 | 561 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-hosted-fake-no-cells (required): fail

### prechunked: run 97af1a22-1994-4882-9143-0ece04fb6ff0, run_config_hash d73e69f0f85938042a0a76c1331573ef252488a8a4d095cfd9008cf13948f8dc, report sha256 2bb5062dc95eab2ab605b6ef68a078240f6a0e44ea52d6ab1e58755265b02a3c

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a | n/a | n/a | n/a | n/a | n/a | pass (no offender; 7 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.7352 | 236 | 0.6643 | 0.6843 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.2373 | 236 | 0.2573 | 0.2373 | 0.0200 | 0.2873 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 48 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 38 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.6364 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.5000 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.7778 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7222 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.7500 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.5631 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.3333 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | mrr | 0.3333 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8158 | 19 | 0.7958 | 0.8158 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8684 | 19 | 0.8747 | 0.8947 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 0.8889 | 9 | 0.8689 | 0.8889 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 0.8889 | 9 | 0.7207 | 0.7407 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 0.9643 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8631 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.3958 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 0.7500 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.7500 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.6500 | 10 | 0.6800 | 0.7000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 0.4545 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.4091 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 155.0000 | 413 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 132.0000 | 413 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 84079729-a8e9-4180-9bb5-989433459509, run_config_hash 863ef204e82d3f6a9e939811803587101f0f17d1b781eaea5c7df137684f1620, report sha256 6865237bc73b43b09b0df873528d59f9ad27be5e8c3ab4b15fe3954d00cb0c35

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a | n/a | n/a | n/a | n/a | n/a | pass (no offender; 8 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.7759 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.7759 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.1951 | 328 | 0.2121 | 0.1921 | 0.0200 | 0.2346 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 62 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 52 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.9091 | 11 | 0.7073 | 0.7273 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.7727 | 11 | 0.5709 | 0.5909 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7500 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.7500 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.5646 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | recall_at_10 | 0.6667 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.6111 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.7778 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | mrr | 0.7778 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3913 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.9615 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8393 | 28 | 0.8193 | 0.8393 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8750 | 28 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 0.9286 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.6967 | 0.7167 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 0.9643 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8631 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.6250 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.5208 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9388 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.7500 | 10 | 0.6300 | 0.6500 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 16 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8854 | 16 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:templated_collection | recall_at_10 | 0.5000 | 58 | 0.4110 | 0.4310 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:templated_collection | mrr | 0.4526 | 58 | 0.3707 | 0.3907 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 119.0000 | 561 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 77.0000 | 561 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor (candidate): fail

### prechunked: run 367a7f47-caf4-4733-88dd-7c431b0c28a4, run_config_hash 31ecefdf29cb13903734c081755bdef32c5599cc5259ac039088ddef1645632f, report sha256 365843ab783827dfda22799c9484dadf5e238135a7f91b69114aa4111c541007

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a | n/a | n/a | n/a | n/a | n/a | pass (no offender; 7 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8665 | 236 | 0.6643 | 0.6843 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.0508 | 236 | 0.2573 | 0.2373 | 0.0200 | 0.0811 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 48 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 38 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.6944 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.9091 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.7803 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7778 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8125 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.4177 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.8889 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.9444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.1111 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | mrr | 0.0278 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.9211 | 19 | 0.7958 | 0.8158 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9649 | 19 | 0.8747 | 0.8947 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.8689 | 0.8889 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.7207 | 0.7407 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 1.0000 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.9107 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8750 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.6927 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.7857 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.5500 | 10 | 0.6800 | 0.7000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8485 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.6111 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 32.0000 | 413 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 2.0000 | 413 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run b805ed62-1b1b-43e8-873e-cdaf1e4f9db2, run_config_hash 4af115a287fa5eed90ebe9628c3131b56b3021522cd6262ba917dba9c4664beb, report sha256 092b41c252b94f508856811b80db4d87dfe55005de885b68b54f5a8af77af566

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.9565 | 23 | 0.9800 | 1.0000 | 0.0200 | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8171 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8171 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.0488 | 328 | 0.2121 | 0.1921 | 0.0200 | 0.0731 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 0.9839 | 62 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 0.9808 | 52 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.6944 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.9091 | 11 | 0.7073 | 0.7273 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.7803 | 11 | 0.5709 | 0.5909 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7500 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8125 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.4490 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.8889 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.9444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.1667 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | mrr | 0.1270 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3696 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 0.8333 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8846 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.9464 | 28 | 0.8193 | 0.8393 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9375 | 28 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.6967 | 0.7167 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 1.0000 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.9107 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8125 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.6719 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9375 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.7500 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.7500 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.9000 | 10 | 0.6300 | 0.6500 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 16 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8958 | 16 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:templated_collection | recall_at_10 | 0.5862 | 58 | 0.4110 | 0.4310 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:templated_collection | mrr | 0.4131 | 58 | 0.3707 | 0.3907 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.4444 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 42.0000 | 561 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 2.0000 | 561 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor-no-cells (candidate): fail

### prechunked: run 0dd13327-d3b4-4376-8383-8ed9abc2db09, run_config_hash b496f3cc354fd4e5ce7399941a2b6f8072ef66c24fd66e3889a3b462d06d7258, report sha256 84dd4c1b15fb3e18b1cf827f62e0d08e3ca5eadfce9e8d9b6f4201b545cbedb4

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a | n/a | n/a | n/a | n/a | n/a | pass (no offender; 7 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8665 | 236 | 0.6643 | 0.6843 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.0508 | 236 | 0.2573 | 0.2373 | 0.0200 | 0.0811 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 48 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 38 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.6944 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.9091 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.7803 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7778 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8125 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.4177 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.8889 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.9444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.1111 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | mrr | 0.0278 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.9211 | 19 | 0.7958 | 0.8158 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9649 | 19 | 0.8747 | 0.8947 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.8689 | 0.8889 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.7207 | 0.7407 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 1.0000 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.9107 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8750 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.6927 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.7857 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.5500 | 10 | 0.6800 | 0.7000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8485 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.6111 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 26.0000 | 413 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 2.0000 | 413 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run eb8e54fb-604c-48c9-8a9c-5662d51a9f8c, run_config_hash 397827af39939f0f0ff4becdfb842e5f5c70a1c1770d90b0e7621e96b8344c04, report sha256 37e65833efb6423c983f42728023c7f2451f6b8da6bc8454019db1a3e2a1493b

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.9565 | 23 | 0.9800 | 1.0000 | 0.0200 | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8171 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8171 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.0488 | 328 | 0.2121 | 0.1921 | 0.0200 | 0.0731 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 0.9839 | 62 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 0.9808 | 52 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.6944 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.9091 | 11 | 0.7073 | 0.7273 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.7803 | 11 | 0.5709 | 0.5909 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7500 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8125 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.4490 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.8889 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.9444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.1667 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | mrr | 0.1270 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3696 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 0.8333 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8846 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.9464 | 28 | 0.8193 | 0.8393 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9375 | 28 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.6967 | 0.7167 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 1.0000 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.9107 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8125 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.6719 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9375 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.7500 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.7500 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.9000 | 10 | 0.6300 | 0.6500 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 16 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8958 | 16 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:templated_collection | recall_at_10 | 0.5862 | 58 | 0.4110 | 0.4310 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:templated_collection | mrr | 0.4131 | 58 | 0.3707 | 0.3907 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.4444 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 44.0000 | 561 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 2.0000 | 561 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor-hosted-fake (candidate): fail

### prechunked: run c983fab5-fcad-4bbe-97e2-7d9ca8c0377a, run_config_hash 01f47170680ed1ad8a3630a3a282c51c72dfe3eb789000a69f52fc708d44adf7, report sha256 a582bcbb3af4cb78ba655a618a26722bbaa5423480a46d068222e2921412fbab

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a | n/a | n/a | n/a | n/a | n/a | pass (no offender; 7 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.9131 | 236 | 0.6643 | 0.6843 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.0254 | 236 | 0.2573 | 0.2373 | 0.0200 | 0.0496 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 48 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 38 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.7083 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 1.0000 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.8636 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7778 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.9375 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.6725 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | recall_at_10 | 0.8889 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.9444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 1.0000 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | mrr | 0.8889 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.9211 | 19 | 0.7958 | 0.8158 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9474 | 19 | 0.8747 | 0.8947 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.8689 | 0.8889 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.7207 | 0.7407 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 1.0000 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8810 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.9375 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.7865 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 0.7500 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.7500 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.6500 | 10 | 0.6800 | 0.7000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8333 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 151.0000 | 413 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 129.0000 | 413 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run d5d94fcd-ba51-41bf-899d-766f3dd55806, run_config_hash 7d54557d1b987d0b78d63f1cfdad61c03b30797109c1dd901893601bbe4286fa, report sha256 07f86aa58b7d549830ea57d7aa4a1bde9bbb509412d9331c1ed33d33b4517b83

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.9565 | 23 | 0.9800 | 1.0000 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8887 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8887 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.0213 | 328 | 0.2121 | 0.1921 | 0.0200 | 0.0397 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 0.9839 | 62 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 0.9808 | 52 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.7083 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cache_near_miss | recall_at_10 | 1.0000 | 11 | 0.7073 | 0.7273 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cache_near_miss | mrr | 0.8636 | 11 | 0.5709 | 0.5909 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cache_paraphrase | mrr | 0.7500 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.9375 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:colloquial | mrr | 0.6740 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | recall_at_10 | 0.8889 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | mrr | 0.9444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:context_overflow | recall_at_10 | 1.0000 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:context_overflow | mrr | 1.0000 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.3913 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 0.9615 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 0.9464 | 28 | 0.8193 | 0.8393 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9464 | 28 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:implicit_condition | mrr | 0.9286 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.6967 | 0.7167 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_step_calc | recall_at_10 | 1.0000 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_step_calc | mrr | 0.8810 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.9375 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | mrr | 0.7865 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:scanned | mrr | 0.9388 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:stale_version | mrr | 0.7500 | 10 | 0.6300 | 0.6500 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 16 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.8854 | 16 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:templated_collection | recall_at_10 | 0.7414 | 58 | 0.4110 | 0.4310 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:templated_collection | mrr | 0.6131 | 58 | 0.3707 | 0.3907 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 117.0000 | 561 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 75.0000 | 561 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor-hosted-fake-no-cells (candidate): fail

### prechunked: run 7c8f14b5-8654-4cf5-b0a6-8cbdd4b704d1, run_config_hash 105efe2c35a76ba1072c6643f58f07b2e2ae68fe2d34809df8fd6fa692160a01, report sha256 2782596f75be4cb6d79f578c1862dd4a4af1a27a27ac2f5bb48b3442f7fffa2f

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (pass) | noise_gate |  |  | n/a | n/a | n/a | n/a | n/a | n/a | pass (no offender; 7 skipped) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8962 | 236 | 0.6643 | 0.6843 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.0508 | 236 | 0.2573 | 0.2373 | 0.0200 | 0.0811 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 48 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 38 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.7083 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.9091 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.7727 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7778 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8125 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.6256 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | recall_at_10 | 0.8889 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.9444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 1.0000 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | mrr | 0.8889 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.9211 | 19 | 0.7958 | 0.8158 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9474 | 19 | 0.8747 | 0.8947 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.8689 | 0.8889 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.7207 | 0.7407 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 1.0000 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8810 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8750 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.7240 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 0.7500 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.7500 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.6500 | 10 | 0.6800 | 0.7000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8333 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 158.0000 | 413 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 134.0000 | 413 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run b1b7b8e5-327e-4127-baae-7df285009111, run_config_hash 43f229e2086cfaa1d952f69e8ae90a190aad0d12e9c3fea2dccbfd8a31c7cfe5, report sha256 ebd67805e13dec227b6a5172e3beb7eb1ca07c61e3186b5a7c3cb04614e2546b

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.9565 | 23 | 0.9800 | 1.0000 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8674 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8674 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.0488 | 328 | 0.2121 | 0.1921 | 0.0200 | 0.0731 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 0.9839 | 62 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 0.9808 | 52 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 0.8333 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.7083 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cache_near_miss | recall_at_10 | 0.9091 | 11 | 0.7073 | 0.7273 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cache_near_miss | mrr | 0.7727 | 11 | 0.5709 | 0.5909 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cache_paraphrase | mrr | 0.7500 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8125 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:colloquial | mrr | 0.6271 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | recall_at_10 | 0.8889 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:compound | mrr | 0.9444 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:context_overflow | recall_at_10 | 1.0000 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:context_overflow | mrr | 1.0000 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.3913 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:duplicate_flood | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 0.9615 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 0.9464 | 28 | 0.8193 | 0.8393 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9464 | 28 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:implicit_condition | mrr | 0.9286 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.6967 | 0.7167 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_step_calc | recall_at_10 | 1.0000 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_step_calc | mrr | 0.8810 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.8125 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:multi_turn | mrr | 0.7083 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:scanned | mrr | 0.9388 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.7500 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.7500 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:stale_version | mrr | 0.7500 | 10 | 0.6300 | 0.6500 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 16 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.8854 | 16 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:templated_collection | recall_at_10 | 0.7241 | 58 | 0.4110 | 0.4310 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:templated_collection | mrr | 0.5959 | 58 | 0.3707 | 0.3907 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 111.0000 | 561 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 73.0000 | 561 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-fallback-none (candidate): fail

### prechunked: run 9c401a73-c78c-4a4f-a02a-866f3327a05d, run_config_hash 6a225921c847d8fd1d55e010dfeec0a15a0c4385500b135d857df5a2dc4c4e60, report sha256 26171fe7b0909848d391db87b03dbe2e0c893c8028527f7ed6b1923f81f2941f

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | mrr | 0.5622 | 83 | 0.5684 | 0.5884 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.7331 | 236 | 0.6643 | 0.6843 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.2373 | 236 | 0.2573 | 0.2373 | 0.0200 | 0.2873 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 48 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 38 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.6364 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.5030 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.7778 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7778 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.7500 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.3745 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.3333 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | mrr | 0.3333 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 0.7500 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8158 | 19 | 0.7958 | 0.8158 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8947 | 19 | 0.8747 | 0.8947 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 0.8889 | 9 | 0.8689 | 0.8889 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 0.7778 | 9 | 0.7207 | 0.7407 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 0.9286 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 0.9643 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8155 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.3750 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.7917 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.4750 | 10 | 0.6800 | 0.7000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 0.4545 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.3409 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 25.0000 | 413 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 413 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 13184963-70ab-4030-abe5-6288327d95e1, run_config_hash c7f7fd5330c75ea0c638c11c72cc4f44839f2247afa6b19d841872208382f0ae, report sha256 4cc34a86ee90b4f838c63df2b55ab0628354bc9a754fd59804a574475d898bce

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | category:cross_lingual | mrr | 0.3478 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.7683 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.7683 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.1951 | 328 | 0.2121 | 0.1921 | 0.0200 | 0.2346 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 62 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 52 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.9091 | 11 | 0.7073 | 0.7273 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.7758 | 11 | 0.5709 | 0.5909 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7500 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.7500 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.4161 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.6667 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.6111 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.7778 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | mrr | 0.7778 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3478 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 0.7500 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 1.0000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8393 | 28 | 0.8193 | 0.8393 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8333 | 28 | 0.8371 | 0.8571 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.5667 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 0.8929 | 14 | 0.6967 | 0.7167 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 0.9643 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8036 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.6250 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.4656 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9018 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.9000 | 10 | 0.6300 | 0.6500 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 16 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8854 | 16 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:templated_collection | recall_at_10 | 0.4828 | 58 | 0.4110 | 0.4310 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:templated_collection | mrr | 0.3545 | 58 | 0.3707 | 0.3907 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 45.0000 | 561 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 561 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-fallback-none-no-cells (candidate): fail

### prechunked: run 89bac984-1ee4-4481-b250-54f02a26f27b, run_config_hash 28044bad2e7b35d9e6359c238f7e3aef251b31166e62db73c6acc551b2e931f7, report sha256 1a4cee7ac848048d14f21939bb1f5e2e4de501621da4ef9a3d47dc58547afb89

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | mrr | 0.5622 | 83 | 0.5684 | 0.5884 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.7331 | 236 | 0.6643 | 0.6843 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.2373 | 236 | 0.2573 | 0.2373 | 0.0200 | 0.2873 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 48 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 38 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.6364 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.5030 | 11 | 0.4345 | 0.4545 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.7778 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7778 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.7500 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.3745 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.4444 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.4444 | 9 | 0.4244 | 0.4444 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.3333 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | mrr | 0.3333 | 9 | 0.3133 | 0.3333 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4286 | 21 | 0.4086 | 0.4286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4286 | 21 | 0.3848 | 0.4048 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 0.7500 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8750 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8158 | 19 | 0.7958 | 0.8158 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8947 | 19 | 0.8747 | 0.8947 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 0.8889 | 9 | 0.8689 | 0.8889 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 0.7778 | 9 | 0.7207 | 0.7407 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 0.9286 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 0.9643 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8155 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.5000 | 16 | 0.3550 | 0.3750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.3750 | 16 | 0.3237 | 0.3438 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | mrr | 0.7917 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.4750 | 10 | 0.6800 | 0.7000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 0.4545 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.3409 | 11 | 0.3436 | 0.3636 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 27.0000 | 413 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 413 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run d1776710-e30f-4e82-9c3f-365faf950767, run_config_hash 967e25126cb2dd448ec848dd886f9d952e4d8fea2591fb9a161df776f1c844b1, report sha256 1f3c9b5cdc4e9f9450cbbcb746d80d4cb7ad7a7cfde6d4277d2c1fb1c90ad4c7

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | category:cross_lingual | mrr | 0.3478 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.7683 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.7683 | 328 | 0.7056 | 0.7256 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | overall | false_refusal_rate | 0.1951 | 328 | 0.2121 | 0.1921 | 0.0200 | 0.2346 | pass |
| G3 (pass) | refusal | overall | correct_refusal_rate | 1.0000 | 62 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G3 (pass) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 52 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cache_near_miss | recall_at_10 | 0.9091 | 11 | 0.7073 | 0.7273 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_near_miss | mrr | 0.7758 | 11 | 0.5709 | 0.5909 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | recall_at_10 | 0.8889 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cache_paraphrase | mrr | 0.7500 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.7500 | 16 | 0.6050 | 0.6250 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:colloquial | mrr | 0.4161 | 16 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:compound | recall_at_10 | 0.6667 | 9 | 0.5356 | 0.5556 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:compound | mrr | 0.6111 | 9 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:context_overflow | recall_at_10 | 0.7778 | 9 | 0.7022 | 0.7222 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:context_overflow | mrr | 0.7778 | 9 | 0.7578 | 0.7778 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.3913 | 23 | 0.3713 | 0.3913 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.3478 | 23 | 0.3496 | 0.3696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:duplicate_flood | recall_at_10 | 0.7500 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:duplicate_flood | mrr | 1.0000 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 1.0000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 0.8393 | 28 | 0.8193 | 0.8393 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.8333 | 28 | 0.8371 | 0.8571 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:identifier_near_miss | recall_at_10 | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:identifier_near_miss | mrr | 1.0000 | 9 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:implicit_condition | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:implicit_condition | mrr | 1.0000 | 7 | 0.9086 | 0.9286 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.5667 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 14 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection_evasive | mrr | 0.8929 | 14 | 0.6967 | 0.7167 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | recall_at_10 | 0.9643 | 28 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_step_calc | mrr | 0.8036 | 28 | 0.7865 | 0.8065 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.6250 | 16 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:multi_turn | mrr | 0.4656 | 16 | 0.2987 | 0.3187 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:off_topic_context | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:partial_answer | recall_at_10 | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:partial_answer | mrr | 1.0000 | 7 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9018 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.5000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.5000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:small_talk | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:small_talk | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:stale_version | recall_at_10 | 1.0000 | 10 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:stale_version | mrr | 0.9000 | 10 | 0.6300 | 0.6500 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 16 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8854 | 16 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table_split | recall_at_10 | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:table_split | mrr | 1.0000 | 3 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:templated_collection | recall_at_10 | 0.4828 | 58 | 0.4110 | 0.4310 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:templated_collection | mrr | 0.3545 | 58 | 0.3707 | 0.3907 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:typo | recall_at_10 | 0.3333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.1667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 42.0000 | 561 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 561 | 600.0000 | n/a | n/a | n/a | pass |

## legacy (legacy): pass

### prechunked: run 6fdadf1d-5292-46c0-a3b0-d9ed0165ee21, run_config_hash 0ca45ac4cfe789158d2f32dba3ad962c32da3549171283a1201f5e49928cb70e, report sha256 a2d7482e563183bdf4f13e3aaebcf82dcc77a780ba242b2fdab7bf4df1915f2a

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G6 (pass) | paired_all_zero |  |  | n/a | n/a | n/a | n/a | n/a | n/a | pass |

### ingest: run 0ab3666c-da33-4d01-ac69-e3c0a1f0ec2e, run_config_hash 0a890aafd3bc9682dc2c33b3ea217f81ac8ed0e4793a067768b79f48799c5748, report sha256 c90c73cb665fcdfd5f15e71a15d01c314f64f680b00929fd833852f16da934f8

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G6 (pass) | paired_all_zero |  |  | n/a | n/a | n/a | n/a | n/a | n/a | pass |

## G8

Status: pass
- two-tenant matrix: single-tenant True, multi-tenant True
- negative checks fail as designed: drop_top_candidate True, max_results 1 True
- drop_top_candidate under v2-default (prechunked): exit 10, gate passed=False, offenders=42, mismatches=0, overall mrr margin 0.4956
- max_results 1 under v2-default (prechunked): exit 10, gate passed=False, offenders=13, mismatches=0
- control (plain v2-default, prechunked) against the same scratch baseline: exit 0, gate passed=True
- drop_top_candidate under v2-default (ingest): exit 11 (the absolute gate also fails), gate passed=False, offenders=42, mismatches=0, overall mrr margin 0.5433
- max_results 1 under v2-default (ingest): exit 10, gate passed=False, offenders=18, mismatches=0
- control (plain v2-default, ingest) against the same scratch baseline: exit 0, gate passed=True
- negative checks are gated against scratch baselines recorded with rag_eval.baseline record-reports from three v2-default runs per mode under eval/out/p41g and eval/out/p41g-det (not committed), without --allow-spread in both modes; the pr-smoke.yml jq conditions are applied to each gate.json
- two-tenant matrix under the D-01 values: node --test name pattern 'under the D-01 values: multi-tenant' exit 0 (3 cases, including the 04.1-18 exact_id and evidence-read foreign-tenant cases), 'under the D-01 values: single-tenant' exit 0 (keyless and with the fixture key)

## Floor (D-04)

Chosen: none (neither floor passes: no flip (D-13))

- legacy_rule: fail, score 0.9980, configurations v2-default, v2-default-no-cells, v2-default-hosted-fake, v2-default-hosted-fake-no-cells
  - v2-default failed
  - v2-default-no-cells failed
  - v2-default-hosted-fake failed
  - v2-default-hosted-fake-no-cells failed
- similarity: fail, score 0.9919, configurations v2-default-similarity-floor, v2-default-similarity-floor-no-cells, v2-default-similarity-floor-hosted-fake, v2-default-similarity-floor-hosted-fake-no-cells
  - v2-default-similarity-floor failed
  - v2-default-similarity-floor-no-cells failed
  - v2-default-similarity-floor-hosted-fake failed
  - v2-default-similarity-floor-hosted-fake-no-cells failed

## No-key fallback (D-06)

Chosen: none (neither fallback passes: no flip (D-13))

- local_bm25: fail, score n/a, configurations v2-default, v2-default-no-cells
  - v2-default failed
  - v2-default-no-cells failed
  - v2-default vs v2-default-fallback-none (prechunked) overall recall_at_10: 0.7267 vs 0.7131 (none 0.7331 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (prechunked) overall mrr: 0.6437 vs 0.6189 (none 0.6389 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (prechunked) category:cross_lingual recall_at_10: 0.4286 vs 0.4086 (none 0.4286 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (ingest) overall recall_at_10: 0.7515 vs 0.7483 (none 0.7683 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (ingest) overall mrr: 0.6749 vs 0.6512 (none 0.6712 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (ingest) category:cross_lingual recall_at_10: 0.3913 vs 0.3713 (none 0.3913 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (prechunked) overall recall_at_10: 0.7267 vs 0.7131 (none 0.7331 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (prechunked) overall mrr: 0.6437 vs 0.6189 (none 0.6389 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (prechunked) category:cross_lingual recall_at_10: 0.4286 vs 0.4086 (none 0.4286 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (ingest) overall recall_at_10: 0.7515 vs 0.7483 (none 0.7683 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (ingest) overall mrr: 0.6749 vs 0.6512 (none 0.6712 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (ingest) category:cross_lingual recall_at_10: 0.3913 vs 0.3713 (none 0.3913 - band 0.0200) pass
- none: fail, score n/a, configurations v2-default-fallback-none, v2-default-fallback-none-no-cells
  - v2-default-fallback-none failed
  - v2-default-fallback-none-no-cells failed

## G7

Live, report-only: filled from plan 04.1-08's result by plan 04.1-07.
