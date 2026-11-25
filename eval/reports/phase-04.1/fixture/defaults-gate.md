# Phase 4.1 defaults gate

Result: FAIL
Refusal basis: single_threshold
Floor: none chosen; no-key fallback: none chosen
Noise band: max(3.0 x spread, 0.02)
G2 absolute ingest Recall@10 floor (derived): 0.712283

## Failures

- v2-default failed
- v2-default-no-cells failed
- v2-default-hosted-fake failed
- v2-default-hosted-fake-no-cells failed
- floor: neither floor passes: no flip (D-13)
- no-key fallback: neither fallback passes: no flip (D-13)
- G8 fail

## Sources

| Role | Path | sha256 |
| --- | --- | --- |
| baseline:prechunked | eval/baselines/fixture-baseline.json | 734ad7d03cb62e7acc652355d7a6b4bd55d02dd3ac363547007249625fdcd51a |
| baseline:ingest | eval/baselines/fixture-ingest-baseline.json | aedc5e57c955b1676ee590faa2404cd69df2a2ed8ece98b333e600bd72652ca0 |
| noise | eval/config/noise.json | 959adc75a6d7f06ad6319d5bc179daa692cf067b6a1bc731af1224d3f2d42333 |
| latency_budgets | eval/config/latency-budgets.json | 8660989920a8e7f3715ec1cca52453d9d2d5de82e68674569e2439c0ebc78234 |
| g8 | eval/reports/phase-04.1/fixture/g8-input.json | 525f3ac4b5b85b05139681560eac63516554d63328aec7378a5909b95e9f14bb |
| report:v2-default:prechunked | eval/out/p41/v2-default-prechunked/report.json | 4522ad9fd7b206f4a762d79724c5116333a83df141a243f92a9941738cd34366 |
| report:v2-default:ingest | eval/out/p41/v2-default-ingest/report.json | d35e36ba4363e0b598c9e036fb63c0e23f250e471761e94d77f13a6aceb95a36 |
| report:v2-default-no-cells:prechunked | eval/out/p41/v2-default-no-cells-prechunked/report.json | 5355e96d966db4f18a249bc4b7333f9dea3ae9f7455e088782daf7edf04601d0 |
| report:v2-default-no-cells:ingest | eval/out/p41/v2-default-no-cells-ingest/report.json | 8d470bda1db0ffd8917cd7f4311cf6c78dd0c10e537c08e9b2a6b01016cbf965 |
| report:v2-default-hosted-fake:prechunked | eval/out/p41/v2-default-hosted-fake-prechunked/report.json | aeba8876f727803b5412a9a42a1c73f73baca34703b1ac91741bc30d532ffb58 |
| report:v2-default-hosted-fake:ingest | eval/out/p41/v2-default-hosted-fake-ingest/report.json | 8d83d20c332022653210be9df39c2bf11b4f7f8d208b9bbb3a997ddb4d2bb7fd |
| report:v2-default-hosted-fake-no-cells:prechunked | eval/out/p41/v2-default-hosted-fake-no-cells-prechunked/report.json | 9aca965014a8d3b4f79c82ede6007c7b6eee4d010365da0978495ba9a5ef6bdd |
| report:v2-default-hosted-fake-no-cells:ingest | eval/out/p41/v2-default-hosted-fake-no-cells-ingest/report.json | fbfae4271a47da3b9b1b0e06964c0c72b709394efa24cc181b1805711a5f0986 |
| report:v2-default-similarity-floor:prechunked | eval/out/p41/v2-default-similarity-floor-prechunked/report.json | 32b4060e3ca3f031b3386478ef6687b853c161a100d33af060021aa728049909 |
| report:v2-default-similarity-floor:ingest | eval/out/p41/v2-default-similarity-floor-ingest/report.json | 733d4c62a282ec8a78e619b7410dd73c17a7ed592b2ef315c4bfd97608909d07 |
| report:v2-default-similarity-floor-no-cells:prechunked | eval/out/p41/v2-default-similarity-floor-no-cells-prechunked/report.json | 2b014b8d1906a76fb8ffe6c3540fb1366997a38ea0d59857e5fd7be928ebcef9 |
| report:v2-default-similarity-floor-no-cells:ingest | eval/out/p41/v2-default-similarity-floor-no-cells-ingest/report.json | a1c36e33fa3fe44ed5ec48cbd4821102b1e4277f17c3484bf8386c2a0d6fb295 |
| report:v2-default-similarity-floor-hosted-fake:prechunked | eval/out/p41/v2-default-similarity-floor-hosted-fake-prechunked/report.json | b266f5e0753e5f4a4ece87bf451b6681b912246f34b2cc1f5e64a072c3cfa84c |
| report:v2-default-similarity-floor-hosted-fake:ingest | eval/out/p41/v2-default-similarity-floor-hosted-fake-ingest/report.json | b1ee989ade79782c80c66d8a9f13173342452cc883489a24b8ec6b8377cff69f |
| report:v2-default-similarity-floor-hosted-fake-no-cells:prechunked | eval/out/p41/v2-default-similarity-floor-hosted-fake-no-cells-prechunked/report.json | 8e2ea2733c096b3daa2f4f8b41db2b3538276e67358804c6cca28221e0aa26a2 |
| report:v2-default-similarity-floor-hosted-fake-no-cells:ingest | eval/out/p41/v2-default-similarity-floor-hosted-fake-no-cells-ingest/report.json | 38fef81cd2e4d2b442b274527fffbcbc094796c1ad482d46367b6a01ac966377 |
| report:v2-default-fallback-none:prechunked | eval/out/p41/v2-default-fallback-none-prechunked/report.json | de637added41a93c42e6d9a618a637399ae1363dd8f9d71ef7ddfd62b7808313 |
| report:v2-default-fallback-none:ingest | eval/out/p41/v2-default-fallback-none-ingest/report.json | d97beb12ccb508d2fb46519ef2cab5bbad45e6b9095b2ce2cfeb0b6c5af0f211 |
| report:v2-default-fallback-none-no-cells:prechunked | eval/out/p41/v2-default-fallback-none-no-cells-prechunked/report.json | 6ae5fea72b55dfbc2bf9027a6c6de5aba93c115113759320bad026a95947ca64 |
| report:v2-default-fallback-none-no-cells:ingest | eval/out/p41/v2-default-fallback-none-no-cells-ingest/report.json | cc86c5883b31cb48029cd4c2b72e8b16c9c762b16f44295ead0f83a7957bf07c |
| report:legacy:prechunked | eval/out/p41/legacy-prechunked/report.json | f6ed171348e419682a7b5da6cdae7b5b7e790129a5dc201a02f4dea4abfe7480 |
| report:legacy:ingest | eval/out/p41/legacy-ingest/report.json | b405e1e37e143ab172a2238bacdc6305b9d75ff3d96b44b1f729c5499bbbcff2 |
| criteria | eval/config/defaults-gate.json | 97a6da1df1286faf1e44d0a548360974074b45e36f3fd0a3363b600ca54cb0fb |

## v2-default (required): fail

### prechunked: run d8c8b501-8ded-4cd9-a437-da224df0e22f, run_config_hash e3468fd5140643d46eca1626739aface674e36558eadd634faa25fea617d5178, report sha256 4522ad9fd7b206f4a762d79724c5116333a83df141a243f92a9941738cd34366

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.0000 |  | 0.6050 | 0.6250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.1667 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.0476 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.9062 | 96 | 0.5425 | 0.5625 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0104 | 96 | 0.3742 | 0.3542 | 0.0200 | 0.0485 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.0476 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.0476 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.7778 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.4900 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | mrr | 0.9167 | 6 | 0.6467 | 0.6667 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.6471 | 17 | 0.5094 | 0.5294 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.5466 | 17 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | mrr | 0.5048 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7917 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 47.0000 | 164 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 22.0000 | 164 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 8208fbd0-34fe-4c0a-9ee7-ccac73b63a97, run_config_hash 4d90592524ed69fb06b60ea28f3aa9dcd0ad72efe4079da5f6d21d78c6c5c776, report sha256 d35e36ba4363e0b598c9e036fb63c0e23f250e471761e94d77f13a6aceb95a36

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.2000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.2857 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.4244 | 0.4444 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.1538 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.1667 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0630 | 127 | 0.2247 | 0.2047 | 0.0200 | 0.1108 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.7778 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.3233 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | mrr | 0.9167 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4737 | 19 | 0.4537 | 0.4737 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4474 | 19 | 0.4274 | 0.4474 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8846 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 1.0000 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9710 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | mrr | 0.5048 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9464 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8718 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 49.0000 | 210 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 19.0000 | 210 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-no-cells (required): fail

### prechunked: run 27de67ea-fa7f-45a6-aa4f-2d93db8559e0, run_config_hash 21dd519bc56dc8fa748bf623d2166bcccf5f4a4d6be780e3f9bbe75ef21234b6, report sha256 5355e96d966db4f18a249bc4b7333f9dea3ae9f7455e088782daf7edf04601d0

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.0000 |  | 0.6050 | 0.6250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.1667 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.0476 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.9062 | 96 | 0.5425 | 0.5625 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0104 | 96 | 0.3742 | 0.3542 | 0.0200 | 0.0485 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.0476 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.0476 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.7778 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.4900 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | mrr | 0.9167 | 6 | 0.6467 | 0.6667 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.6471 | 17 | 0.5094 | 0.5294 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.5466 | 17 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | mrr | 0.5048 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7917 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 52.0000 | 164 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 22.0000 | 164 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 0e39ec24-88c0-4877-adfa-4212dc9ec5dd, run_config_hash c99dd9d2c160e277da5bc5a4a38ba8130cbf5b6de222b8cbe6b23cf31b4a6c97, report sha256 8d470bda1db0ffd8917cd7f4311cf6c78dd0c10e537c08e9b2a6b01016cbf965

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.2000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.2857 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.4244 | 0.4444 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.1538 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.1667 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0630 | 127 | 0.2247 | 0.2047 | 0.0200 | 0.1108 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.7778 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.3233 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | mrr | 0.9167 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4737 | 19 | 0.4537 | 0.4737 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4474 | 19 | 0.4274 | 0.4474 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.8846 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 1.0000 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9710 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | mrr | 0.5048 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9464 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8718 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 47.0000 | 210 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 18.0000 | 210 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-hosted-fake (required): fail

### prechunked: run a7dd5176-d793-400e-abfc-eecd88253c5d, run_config_hash 4a8607c3f2be028ad05cd0433370e6221866ea760d93dbdc0fd34a55f9216f9d, report sha256 aeba8876f727803b5412a9a42a1c73f73baca34703b1ac91741bc30d532ffb58

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.3750 |  | 0.6050 | 0.6250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.1667 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.1905 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8854 | 96 | 0.5425 | 0.5625 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0104 | 96 | 0.3742 | 0.3542 | 0.0200 | 0.0485 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.1905 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.1905 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | mrr | 0.9167 | 6 | 0.6467 | 0.6667 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.5294 | 17 | 0.5094 | 0.5294 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.5294 | 17 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | mrr | 0.5333 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7708 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 76.0000 | 164 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 56.0000 | 164 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run f2706a97-86f5-4c24-88ff-562562c486fe, run_config_hash 866d3c530abc666ccc9ebac6764b153c0133fe8ef8a294bde664385e79558374, report sha256 8d83d20c332022653210be9df39c2bf11b4f7f8d208b9bbb3a997ddb4d2bb7fd

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.2000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.2857 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.4244 | 0.4444 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.1538 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0630 | 127 | 0.2247 | 0.2047 | 0.0200 | 0.1108 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | mrr | 0.9167 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4737 | 19 | 0.4537 | 0.4737 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4737 | 19 | 0.4274 | 0.4474 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.9615 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 1.0000 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9565 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | mrr | 0.5333 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9429 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8590 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 82.0000 | 210 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 54.0000 | 210 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-hosted-fake-no-cells (required): fail

### prechunked: run 980bd3c2-bf82-4670-b4ef-5c8bf533d8eb, run_config_hash e374f2ab97e904de193cef78bfaa4397cb7e2994e7fcdcc2a7b96594f45b2265, report sha256 9aca965014a8d3b4f79c82ede6007c7b6eee4d010365da0978495ba9a5ef6bdd

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.0000 |  | 0.6050 | 0.6250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.1667 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.0476 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8854 | 96 | 0.5425 | 0.5625 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0104 | 96 | 0.3742 | 0.3542 | 0.0200 | 0.0485 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.0476 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.0476 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | mrr | 0.9167 | 6 | 0.6467 | 0.6667 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.5294 | 17 | 0.5094 | 0.5294 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.5294 | 17 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | mrr | 0.5333 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7708 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 101.0000 | 164 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 73.0000 | 164 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 75ee48bd-1946-47b9-a1e2-f9162fcb95e5, run_config_hash 32213d3ac45e1079c64ec5428a87d624811be775e70a35c21539fadd63ade1ab, report sha256 fbfae4271a47da3b9b1b0e06964c0c72b709394efa24cc181b1805711a5f0986

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.2000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.2857 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.4244 | 0.4444 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.1538 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0630 | 127 | 0.2247 | 0.2047 | 0.0200 | 0.1108 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | mrr | 0.9167 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4737 | 19 | 0.4537 | 0.4737 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4737 | 19 | 0.4274 | 0.4474 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 0.9615 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 1.0000 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9565 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | mrr | 0.5333 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9429 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8590 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 97.0000 | 210 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 66.0000 | 210 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor (candidate): fail

### prechunked: run f7703990-44a5-44cf-bb6a-48484233389c, run_config_hash 01fce85d31672de9ad41277fdc4b34fca48c8df10c3c3f4215404f4f341e1a3f, report sha256 32b4060e3ca3f031b3386478ef6687b853c161a100d33af060021aa728049909

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.2500 |  | 0.6050 | 0.6250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.1667 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.4286 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.2857 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.9062 | 96 | 0.5425 | 0.5625 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0312 | 96 | 0.3742 | 0.3542 | 0.0200 | 0.0788 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.7778 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.4900 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | mrr | 0.9167 | 6 | 0.6467 | 0.6667 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.6471 | 17 | 0.5094 | 0.5294 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.5466 | 17 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | mrr | 0.5048 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7917 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 53.0000 | 164 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 23.0000 | 164 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 46798392-fed6-46d2-aac6-9ad434adfb9f, run_config_hash 5210f3458f2d95fac38150c1638d0ddd9954898fc8e23dee5b0d9ea7eae39bb8, report sha256 733d4c62a282ec8a78e619b7410dd73c17a7ed592b2ef315c4bfd97608909d07

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | category:cross_lingual | false_refusal_rate | 1.0000 |  | 0.4411 | 0.4211 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | mrr | 0.0000 |  | 0.4274 | 0.4474 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_10 | 0.0000 |  | 0.4537 | 0.4737 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_5 | 0.0000 |  | 0.4537 | 0.4737 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | false_refusal_rate | 0.7963 |  | 0.2052 | 0.1852 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | mrr | 0.1852 |  | 0.6251 | 0.6451 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_10 | 0.2037 |  | 0.7115 | 0.7315 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_5 | 0.2037 |  | 0.7115 | 0.7315 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | false_refusal_rate | 0.9091 |  | 0.2321 | 0.2121 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | mrr | 0.0758 |  | 0.5628 | 0.5828 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.0909 |  | 0.6770 | 0.6970 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.0909 |  | 0.6770 | 0.6970 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | false_refusal_rate | 0.9250 |  | 0.2450 | 0.2250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | mrr | 0.0625 |  | 0.6425 | 0.6625 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_10 | 0.0750 |  | 0.7425 | 0.7625 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_5 | 0.0750 |  | 0.6925 | 0.7125 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | false_refusal_rate | 0.8661 |  | 0.2247 | 0.2047 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | mrr | 0.1181 |  | 0.6144 | 0.6344 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_10 | 0.1339 |  | 0.7123 | 0.7323 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_5 | 0.1339 |  | 0.6965 | 0.7165 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | false_refusal_rate | 1.0000 |  | 0.6200 | 0.6000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | mrr | 0.0000 |  | 0.2800 | 0.3000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_10 | 0.0000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_5 | 0.0000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | false_refusal_rate | 1.0000 |  | 0.5200 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | mrr | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_10 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_5 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G2 (fail) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.1339 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | fail |
| G2 (fail) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.1339 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.8661 | 127 | 0.2247 | 0.2047 | 0.0200 | 0.9129 | fail |
| G3 (fail) | refusal | overall | correct_refusal_rate | 1.0000 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.1667 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | mrr | 0.1667 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.0000 | 19 | 0.4537 | 0.4737 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | mrr | 0.0000 | 19 | 0.4274 | 0.4474 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.0000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | recall_at_10 | 0.1304 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | mrr | 0.1304 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 0.6000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 0.6000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.0000 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | mrr | 0.0000 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 0.2857 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:scanned | mrr | 0.2857 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 0.0769 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | mrr | 0.0769 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:typo | recall_at_10 | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 53.0000 | 210 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 22.0000 | 210 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor-no-cells (candidate): fail

### prechunked: run 534f098b-708c-4519-87bd-46dea28672c3, run_config_hash 2555871e317efa3e501eeda0ed08de06edf80bf7e07baa900a9a165e427ea554, report sha256 2b014b8d1906a76fb8ffe6c3540fb1366997a38ea0d59857e5fd7be928ebcef9

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.2500 |  | 0.6050 | 0.6250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.1667 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.4286 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.2857 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.9062 | 96 | 0.5425 | 0.5625 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0312 | 96 | 0.3742 | 0.3542 | 0.0200 | 0.0788 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.7778 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.4900 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | mrr | 0.9167 | 6 | 0.6467 | 0.6667 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.6471 | 17 | 0.5094 | 0.5294 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.5466 | 17 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | mrr | 0.5048 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7917 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 53.0000 | 164 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 24.0000 | 164 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run cd2c481f-60e5-4d0d-be8d-61d13ae1ed97, run_config_hash d125e523178768e3ab276724a73a2c91a42cca0b8ad0b94c3172f16dfe2e21f7, report sha256 a1c36e33fa3fe44ed5ec48cbd4821102b1e4277f17c3484bf8386c2a0d6fb295

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | category:cross_lingual | false_refusal_rate | 1.0000 |  | 0.4411 | 0.4211 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | mrr | 0.0000 |  | 0.4274 | 0.4474 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_10 | 0.0000 |  | 0.4537 | 0.4737 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_5 | 0.0000 |  | 0.4537 | 0.4737 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | false_refusal_rate | 0.7963 |  | 0.2052 | 0.1852 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | mrr | 0.1852 |  | 0.6251 | 0.6451 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_10 | 0.2037 |  | 0.7115 | 0.7315 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_5 | 0.2037 |  | 0.7115 | 0.7315 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | false_refusal_rate | 0.9091 |  | 0.2321 | 0.2121 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | mrr | 0.0758 |  | 0.5628 | 0.5828 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.0909 |  | 0.6770 | 0.6970 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.0909 |  | 0.6770 | 0.6970 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | false_refusal_rate | 0.9250 |  | 0.2450 | 0.2250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | mrr | 0.0625 |  | 0.6425 | 0.6625 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_10 | 0.0750 |  | 0.7425 | 0.7625 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_5 | 0.0750 |  | 0.6925 | 0.7125 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | false_refusal_rate | 0.8661 |  | 0.2247 | 0.2047 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | mrr | 0.1181 |  | 0.6144 | 0.6344 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_10 | 0.1339 |  | 0.7123 | 0.7323 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_5 | 0.1339 |  | 0.6965 | 0.7165 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | false_refusal_rate | 1.0000 |  | 0.6200 | 0.6000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | mrr | 0.0000 |  | 0.2800 | 0.3000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_10 | 0.0000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_5 | 0.0000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | false_refusal_rate | 1.0000 |  | 0.5200 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | mrr | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_10 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_5 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G2 (fail) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.1339 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | fail |
| G2 (fail) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.1339 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.8661 | 127 | 0.2247 | 0.2047 | 0.0200 | 0.9129 | fail |
| G3 (fail) | refusal | overall | correct_refusal_rate | 1.0000 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.1667 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | mrr | 0.1667 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.0000 | 19 | 0.4537 | 0.4737 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | mrr | 0.0000 | 19 | 0.4274 | 0.4474 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.0000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | recall_at_10 | 0.1304 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | mrr | 0.1304 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 0.6000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 0.6000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.0000 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | mrr | 0.0000 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 0.2857 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:scanned | mrr | 0.2857 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 0.0769 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | mrr | 0.0769 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:typo | recall_at_10 | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 55.0000 | 210 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 23.0000 | 210 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor-hosted-fake (candidate): fail

### prechunked: run d9690e05-f6a0-4a71-a823-145dc6410a12, run_config_hash 5361f2ffb0adf90821d0b5aff1138dfffcc16209ce2e366b9766e3f735fe1525, report sha256 b266f5e0753e5f4a4ece87bf451b6681b912246f34b2cc1f5e64a072c3cfa84c

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.3750 |  | 0.6050 | 0.6250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.1667 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.2857 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.2857 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8854 | 96 | 0.5425 | 0.5625 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0104 | 96 | 0.3742 | 0.3542 | 0.0200 | 0.0485 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | mrr | 0.9167 | 6 | 0.6467 | 0.6667 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.5294 | 17 | 0.5094 | 0.5294 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.5294 | 17 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | mrr | 0.5333 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7708 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 106.0000 | 164 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 77.0000 | 164 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run e4a77120-8aaf-4499-9e7b-c4f41416a768, run_config_hash 9bdb5f39d6363bd4463d5cab29dbe3d7b3706c2c77636d2d273d63a4aaee8a95, report sha256 b1ee989ade79782c80c66d8a9f13173342452cc883489a24b8ec6b8377cff69f

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | category:cross_lingual | mrr | 0.1053 |  | 0.4274 | 0.4474 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_10 | 0.1053 |  | 0.4537 | 0.4737 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_5 | 0.1053 |  | 0.4537 | 0.4737 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.3000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.4286 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | mrr | 0.5432 |  | 0.5628 | 0.5828 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.6667 |  | 0.6770 | 0.6970 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.6364 |  | 0.6770 | 0.6970 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.2222 |  | 0.4244 | 0.4444 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.3077 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
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
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.7559 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.7559 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.1654 | 127 | 0.2247 | 0.2047 | 0.0200 | 0.2293 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.3077 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.3077 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.6667 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.5417 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | mrr | 0.9167 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.1053 | 19 | 0.4537 | 0.4737 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | mrr | 0.1053 | 19 | 0.4274 | 0.4474 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.9231 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.8846 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 1.0000 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9565 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | mrr | 0.5333 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9429 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8590 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.5000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 99.0000 | 210 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 69.0000 | 210 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-similarity-floor-hosted-fake-no-cells (candidate): fail

### prechunked: run 5ddfaf3e-4ff9-45df-a8cb-a0e97600f00b, run_config_hash fdceee60d7e5e4d903e87cd5a6e99279b34e20defd34319cf840651d8aff907b, report sha256 8e2ea2733c096b3daa2f4f8b41db2b3538276e67358804c6cca28221e0aa26a2

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.2500 |  | 0.6050 | 0.6250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.1667 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.4286 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.2857 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8854 | 96 | 0.5425 | 0.5625 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0312 | 96 | 0.3742 | 0.3542 | 0.0200 | 0.0788 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.2857 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.3786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | mrr | 0.9167 | 6 | 0.6467 | 0.6667 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.5294 | 17 | 0.5094 | 0.5294 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.5294 | 17 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 0.9643 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | mrr | 0.5333 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8125 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.7708 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 85.0000 | 164 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 64.0000 | 164 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run fb81e75a-0faa-4718-8b7a-9d72447a3d5d, run_config_hash cd814b6c5444594305ee2f8f1e8f073c0bdf6ccc542c39a06e67981c7ee9e76c, report sha256 38fef81cd2e4d2b442b274527fffbcbc094796c1ad482d46367b6a01ac966377

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | category:cross_lingual | false_refusal_rate | 1.0000 |  | 0.4411 | 0.4211 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | mrr | 0.0000 |  | 0.4274 | 0.4474 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_10 | 0.0000 |  | 0.4537 | 0.4737 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | category:cross_lingual | recall_at_5 | 0.0000 |  | 0.4537 | 0.4737 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | false_refusal_rate | 0.7963 |  | 0.2052 | 0.1852 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | mrr | 0.1852 |  | 0.6251 | 0.6451 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_10 | 0.2037 |  | 0.7115 | 0.7315 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:en | recall_at_5 | 0.2037 |  | 0.7115 | 0.7315 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | false_refusal_rate | 0.9091 |  | 0.2321 | 0.2121 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | mrr | 0.0758 |  | 0.5628 | 0.5828 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_10 | 0.0909 |  | 0.6770 | 0.6970 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | recall_at_5 | 0.0909 |  | 0.6770 | 0.6970 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | false_refusal_rate | 0.9250 |  | 0.2450 | 0.2250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | mrr | 0.0625 |  | 0.6425 | 0.6625 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_10 | 0.0750 |  | 0.7425 | 0.7625 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | recall_at_5 | 0.0750 |  | 0.6925 | 0.7125 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | false_refusal_rate | 0.8661 |  | 0.2247 | 0.2047 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | mrr | 0.1181 |  | 0.6144 | 0.6344 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_10 | 0.1339 |  | 0.7123 | 0.7323 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | recall_at_5 | 0.1339 |  | 0.6965 | 0.7165 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->it | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | mrr | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_10 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:en->zh | recall_at_5 | 0.0000 |  | 0.3133 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | false_refusal_rate | 1.0000 |  | 0.6200 | 0.6000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | mrr | 0.0000 |  | 0.2800 | 0.3000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_10 | 0.0000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:it->zh | recall_at_5 | 0.0000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | false_refusal_rate | 1.0000 |  | 0.3533 | 0.3333 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | mrr | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_10 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->en | recall_at_5 | 0.0000 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | false_refusal_rate | 1.0000 |  | 0.5200 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | mrr | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_10 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | pair:zh->it | recall_at_5 | 0.0000 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G2 (fail) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.1339 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | fail |
| G2 (fail) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.1339 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.8661 | 127 | 0.2247 | 0.2047 | 0.0200 | 0.9129 | fail |
| G3 (fail) | refusal | overall | correct_refusal_rate | 1.0000 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 1.0000 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.0000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 0.1667 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | mrr | 0.1667 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.0000 | 19 | 0.4537 | 0.4737 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:cross_lingual | mrr | 0.0000 | 19 | 0.4274 | 0.4474 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | recall_at_10 | 0.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:exact_term | mrr | 0.0000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | recall_at_10 | 0.1304 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:general | mrr | 0.1304 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.6000 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 0.6000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 0.6000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.0000 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | mrr | 0.0000 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 0.2857 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:scanned | mrr | 0.2857 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 0.0769 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | mrr | 0.0769 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:typo | recall_at_10 | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 99.0000 | 210 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 70.0000 | 210 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-fallback-none (candidate): fail

### prechunked: run 685c6b05-c35c-4c13-94cd-6068c4b63876, run_config_hash d147290660f442b73727ce595fc0009737d1073dfaad30323fdcb3e4eb48087f, report sha256 de637added41a93c42e6d9a618a637399ae1363dd8f9d71ef7ddfd62b7808313

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.0000 |  | 0.6050 | 0.6250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.1667 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.0476 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.9062 | 96 | 0.5425 | 0.5625 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0104 | 96 | 0.3742 | 0.3542 | 0.0200 | 0.0485 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.0476 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.0476 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.4952 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | mrr | 0.9167 | 6 | 0.6467 | 0.6667 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.6471 | 17 | 0.5094 | 0.5294 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.5496 | 17 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | mrr | 0.5714 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8333 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8125 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.6604 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 28.0000 | 164 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 164 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run bfe38a6b-6788-43aa-8a53-bc19eda249d9, run_config_hash ae67f2960de615c15bbcdc0daf83014005f639f9a24ce5a1d0190ac8f9a5b414, report sha256 d97beb12ccb508d2fb46519ef2cab5bbad45e6b9095b2ce2cfeb0b6c5af0f211

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.2000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.2857 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.4244 | 0.4444 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.1538 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0630 | 127 | 0.2247 | 0.2047 | 0.0200 | 0.1108 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.4650 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | mrr | 0.9167 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4737 | 19 | 0.4537 | 0.4737 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4474 | 19 | 0.4274 | 0.4474 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 1.0000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 1.0000 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9565 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.5667 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 0.7000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | mrr | 0.5595 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9048 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8718 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 34.0000 | 210 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 210 | 600.0000 | n/a | n/a | n/a | pass |

## v2-default-fallback-none-no-cells (candidate): fail

### prechunked: run 4e1b79d8-fab1-4803-bb90-ace72f9349b3, run_config_hash de57070bb92ae309118d31d96059ab8e25988d6265545b558cf02a0a2c9aade9, report sha256 6ae5fea72b55dfbc2bf9027a6c6de5aba93c115113759320bad026a95947ca64

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.0000 |  | 0.6050 | 0.6250 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.1667 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.0476 |  | 0.6467 | 0.6667 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.9062 | 96 | 0.5425 | 0.5625 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0104 | 96 | 0.3742 | 0.3542 | 0.0200 | 0.0485 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.0476 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.0476 | 21 | 0.6467 | 0.6667 | 0.0200 | n/a | fail |
| G4 (pass) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:colloquial | mrr | 0.4952 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:compound | mrr | 0.9167 | 6 | 0.6467 | 0.6667 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:cross_lingual | recall_at_10 | 0.6471 | 17 | 0.5094 | 0.5294 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:cross_lingual | mrr | 0.5496 | 17 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | recall_at_10 | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:exact_term | mrr | 1.0000 | 8 | 0.8550 | 0.8750 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | recall_at_10 | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:general | mrr | 1.0000 | 14 | 0.8371 | 0.8571 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection | mrr | 0.6000 | 5 | 0.5800 | 0.6000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:injection_evasive | mrr | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:multi_turn | mrr | 0.5714 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (pass) | category | category:scanned | recall_at_10 | 1.0000 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:scanned | mrr | 0.8333 | 4 | 0.7300 | 0.7500 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:selective_filter | recall_at_10 | 0.8750 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:selective_filter | mrr | 0.8125 | 8 | 0.4800 | 0.5000 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | recall_at_10 | 1.0000 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:table | mrr | 0.6604 | 8 | 0.1050 | 0.1250 | 0.0200 | n/a | pass |
| G4 (pass) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (pass) | category | category:typo | mrr | 0.8333 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 25.0000 | 164 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 164 | 600.0000 | n/a | n/a | n/a | pass |

### ingest: run 1629c877-4b25-4efc-a986-a0a6517524f1, run_config_hash 05599a5124e87c6f09b8133e9841c7914e9f13d07672c4f852283624b24654a2, report sha256 cc86c5883b31cb48029cd4c2b72e8b16c9c762b16f44295ead0f83a7957bf07c

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 (fail) | noise_gate | language:en | correct_refusal_rate | 0.2000 |  | 0.3800 | 0.4000 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:it | correct_refusal_rate | 0.2857 |  | 0.6943 | 0.7143 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | language:zh | correct_refusal_rate | 0.0000 |  | 0.4244 | 0.4444 | n/a | n/a | fail (noise_band) |
| G1 (fail) | noise_gate | overall | correct_refusal_rate | 0.1538 |  | 0.4800 | 0.5000 | n/a | n/a | fail (noise_band) |
| G2 (pass) | recall_at_10_vs_baseline | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G2 (pass) | recall_at_10_absolute_floor | overall | recall_at_10 | 0.8425 | 127 | 0.7123 | 0.7323 | 0.0200 | n/a | pass |
| G3 (fail) | refusal | overall | false_refusal_rate | 0.0630 | 127 | 0.2247 | 0.2047 | 0.0200 | 0.1108 | pass |
| G3 (fail) | refusal | overall | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G3 (fail) | refusal | category:no_answer | correct_refusal_rate | 0.1538 | 26 | 0.4800 | 0.5000 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:ambiguous | recall_at_10 | 1.0000 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:ambiguous | mrr | 0.8750 | 6 | 0.4800 | 0.5000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | recall_at_10 | 0.8000 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:colloquial | mrr | 0.4786 | 5 | -0.0200 | 0.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | recall_at_10 | 1.0000 | 6 | 0.8133 | 0.8333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:compound | mrr | 0.9167 | 6 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:cross_lingual | recall_at_10 | 0.4737 | 19 | 0.4537 | 0.4737 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:cross_lingual | mrr | 0.4737 | 19 | 0.4274 | 0.4474 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:exact_term | mrr | 1.0000 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | recall_at_10 | 1.0000 | 23 | 0.8496 | 0.8696 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:general | mrr | 0.9565 | 23 | 0.8061 | 0.8261 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:injection | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection | mrr | 0.5667 | 5 | 0.4200 | 0.4400 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | recall_at_10 | 1.0000 | 5 | 0.9800 | 1.0000 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:injection_evasive | mrr | 0.7000 | 5 | 0.1867 | 0.2067 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | recall_at_10 | 0.8571 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:multi_turn | mrr | 0.5595 | 7 | 0.1229 | 0.1429 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:no_answer | recall_at_10 | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:no_answer | mrr | n/a | 0 | n/a | n/a | n/a | n/a | not_gated (no_baseline_slice) |
| G4 (fail) | category | category:scanned | recall_at_10 | 1.0000 | 14 | 0.9086 | 0.9286 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:scanned | mrr | 0.9048 | 14 | 0.8729 | 0.8929 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:selective_filter | recall_at_10 | 0.0000 | 8 | 0.6050 | 0.6250 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:selective_filter | mrr | 0.0000 | 8 | 0.5217 | 0.5417 | 0.0200 | n/a | fail |
| G4 (fail) | category | category:table | recall_at_10 | 1.0000 | 13 | 0.9800 | 1.0000 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:table | mrr | 0.8718 | 13 | 0.8262 | 0.8462 | 0.0200 | n/a | pass |
| G4 (fail) | category | category:typo | recall_at_10 | 1.0000 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G4 (fail) | category | category:typo | mrr | 0.6667 | 3 | 0.3133 | 0.3333 | 0.0200 | n/a | not_gated (n_below_8) |
| G5 (pass) | total_p95 | retrieval_total |  | 32.0000 | 210 | 2000.0000 | n/a | n/a | n/a | pass |
| G5 (pass) | rerank_p95 | rerank |  | 0.0000 | 210 | 600.0000 | n/a | n/a | n/a | pass |

## legacy (legacy): pass

### prechunked: run 39758166-bb10-4010-bd43-fa96c0b2b7ef, run_config_hash 10e01e7f35f191adc05e0a2b5689d68c38cf5bf8a46ca607ed3da96ff930fdd5, report sha256 f6ed171348e419682a7b5da6cdae7b5b7e790129a5dc201a02f4dea4abfe7480

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G6 (pass) | paired_all_zero |  |  | n/a |  | n/a | n/a | n/a | n/a | pass |

### ingest: run 251952f2-adb5-44e9-b6c7-22c8d53d8af6, run_config_hash 5e230ec66d8c3d05cf24d1d33bf0d4edd57b9cc6c8b5888123e641a85e5b25ab, report sha256 b405e1e37e143ab172a2238bacdc6305b9d75ff3d96b44b1f729c5499bbbcff2

| Criterion | Check | Slice | Metric | Observed | n | Bound | Baseline | Band | Upper 95 | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G6 (pass) | paired_all_zero |  |  | n/a |  | n/a | n/a | n/a | n/a | pass |

## G8

Status: fail
- two-tenant matrix: single-tenant True, multi-tenant True
- negative checks fail as designed: drop_top_candidate False, max_results 1 False
- drop_top_candidate under v2-default (prechunked): gate passed=True, offenders=0, mismatches=0
- drop_top_candidate under v2-default (ingest): gate passed=True, offenders=0, mismatches=0
- max_results 1 under v2-default (prechunked): gate passed=True, offenders=0, mismatches=0
- max_results 1 under v2-default (ingest): gate passed=True, offenders=0, mismatches=0
- control (plain v2-default, prechunked) against the same scratch baseline: gate passed=True
- control (plain v2-default, ingest) against the same scratch baseline: gate passed=True
- negative checks are gated against scratch baselines recorded from three v2-default runs per mode under eval/out (not committed; the ingest one with --allow-spread because the v2 ingest runs differ on category:typo mrr); against the committed legacy-recorded baselines every v2-default run already fails G1 (see the configurations above), so a failure there would not show that the controls work
- the eval-profile degrade option and max_results are applied only on the legacy branch of runRetrieval; the v2 eval path ignores them, so both controls pass the gate under the D-01 values
- two-tenant matrix under the D-01 values: node --test name pattern 'under the D-01 values: multi-tenant' exit 0, 'under the D-01 values: single-tenant' exit 0 (keyless and with the fixture key)

## Floor (D-04)

Chosen: none (neither floor passes: no flip (D-13))

- legacy_rule: fail, score 0.1186, configurations v2-default, v2-default-no-cells, v2-default-hosted-fake, v2-default-hosted-fake-no-cells
  - v2-default failed
  - v2-default-no-cells failed
  - v2-default-hosted-fake failed
  - v2-default-hosted-fake-no-cells failed
- similarity: fail, score 0.5563, configurations v2-default-similarity-floor, v2-default-similarity-floor-no-cells, v2-default-similarity-floor-hosted-fake, v2-default-similarity-floor-hosted-fake-no-cells
  - v2-default-similarity-floor failed
  - v2-default-similarity-floor-no-cells failed
  - v2-default-similarity-floor-hosted-fake failed
  - v2-default-similarity-floor-hosted-fake-no-cells failed

## No-key fallback (D-06)

Chosen: none (neither fallback passes: no flip (D-13))

- local_bm25: fail, score n/a, configurations v2-default, v2-default-no-cells
  - v2-default failed
  - v2-default-no-cells failed
  - v2-default vs v2-default-fallback-none (prechunked) overall recall_at_10: 0.9062 vs 0.8862 (none 0.9062 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (prechunked) overall mrr: 0.7659 vs 0.7528 (none 0.7728 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (prechunked) category:cross_lingual recall_at_10: 0.6471 vs 0.6271 (none 0.6471 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (ingest) overall recall_at_10: 0.8425 vs 0.8225 (none 0.8425 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (ingest) overall mrr: 0.7262 vs 0.7109 (none 0.7309 - band 0.0200) pass
  - v2-default vs v2-default-fallback-none (ingest) category:cross_lingual recall_at_10: 0.4737 vs 0.4537 (none 0.4737 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (prechunked) overall recall_at_10: 0.9062 vs 0.8862 (none 0.9062 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (prechunked) overall mrr: 0.7659 vs 0.7528 (none 0.7728 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (prechunked) category:cross_lingual recall_at_10: 0.6471 vs 0.6271 (none 0.6471 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (ingest) overall recall_at_10: 0.8425 vs 0.8225 (none 0.8425 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (ingest) overall mrr: 0.7262 vs 0.7154 (none 0.7354 - band 0.0200) pass
  - v2-default-no-cells vs v2-default-fallback-none-no-cells (ingest) category:cross_lingual recall_at_10: 0.4737 vs 0.4537 (none 0.4737 - band 0.0200) pass
- none: fail, score n/a, configurations v2-default-fallback-none, v2-default-fallback-none-no-cells
  - v2-default-fallback-none failed
  - v2-default-fallback-none-no-cells failed

## G7

Live, report-only: filled from plan 04.1-08's result by plan 04.1-07.
