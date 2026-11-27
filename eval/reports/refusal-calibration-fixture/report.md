# Refusal calibration

- Source: fixture (fake edge; fixture cells never drive production refusal, they prove the tooling only)
- Run config: v2-recommended
- Reranker: cohere / fake-quality-v1
- Versions: tokenizer 2, rerank text 1
- Target false-refusal rate: 0.050
- Holdout pass rule: `false_refusal_test <= target + max(noise_floor, 1 / n_test_answerable)` (noise floor 0.020)
- Scope: thresholds are fitted on the dev split only. The frozen test split is read once per cell that has a threshold; this report carries counts and rates for it, never per-item scores. A failed cell is not re-fitted on test.

## Cells

| Cell | Status | Threshold | Dev answerable / no-answer | Dev false refusal (95% upper) | Dev correct refusal | Holdout answerable / no-answer | Holdout false refusal (95% upper) | Holdout correct refusal | Holdout evaluations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cohere\|fake-quality-v1\|en\|cross | insufficient_data | - | 2 / 1 | 0.000 (0.776) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|en\|cross\|balanced | insufficient_data | - | 2 / 1 | 0.000 (0.776) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|en\|cross\|flexible | insufficient_data | - | 2 / 1 | 0.000 (0.776) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|en\|cross\|strict | insufficient_data | - | 2 / 1 | 0.000 (0.776) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|en\|same | calibrated | 0.1419 | 48 / 12 | 0.000 (0.061) | 0.250 | 20 / 3 | 0.050 (0.216) | 0.333 | 3 |
| cohere\|fake-quality-v1\|en\|same\|balanced | calibrated | 0.1419 | 48 / 12 | 0.000 (0.061) | 0.250 | 20 / 3 | 0.050 (0.216) | 0.333 | 2 |
| cohere\|fake-quality-v1\|en\|same\|flexible | calibrated | 0.1419 | 48 / 12 | 0.000 (0.061) | 0.250 | 20 / 3 | 0.050 (0.216) | 0.333 | 2 |
| cohere\|fake-quality-v1\|en\|same\|strict | calibrated | 0.7281 | 48 / 12 | 0.875 (0.944) | 1.000 | 20 / 3 | 0.950 (0.997) | 1.000 | 2 |
| cohere\|fake-quality-v1\|it\|cross | insufficient_data | - | 4 / 2 | 0.000 (0.527) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross\|balanced | insufficient_data | - | 4 / 2 | 0.000 (0.527) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross\|flexible | insufficient_data | - | 4 / 2 | 0.000 (0.527) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross\|strict | insufficient_data | - | 4 / 2 | 0.000 (0.527) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|it\|same | calibrated | 0.1564 | 36 / 9 | 0.000 (0.080) | 0.333 | 22 / 4 | 0.091 (0.259) | 0.500 | 3 |
| cohere\|fake-quality-v1\|it\|same\|balanced | calibrated | 0.1564 | 36 / 9 | 0.000 (0.080) | 0.333 | 22 / 4 | 0.091 (0.259) | 0.500 | 2 |
| cohere\|fake-quality-v1\|it\|same\|flexible | calibrated | 0.1564 | 36 / 9 | 0.000 (0.080) | 0.333 | 22 / 4 | 0.091 (0.259) | 0.500 | 2 |
| cohere\|fake-quality-v1\|it\|same\|strict | calibrated | 0.6694 | 36 / 9 | 0.917 (0.977) | 1.000 | 22 / 4 | 0.864 (0.962) | 1.000 | 2 |
| cohere\|fake-quality-v1\|zh\|cross | insufficient_data | - | 3 / 4 | 0.000 (0.632) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross\|balanced | insufficient_data | - | 3 / 4 | 0.000 (0.632) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross\|flexible | insufficient_data | - | 3 / 4 | 0.000 (0.632) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross\|strict | insufficient_data | - | 3 / 4 | 0.000 (0.632) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|same | calibrated | 0.0745 | 47 / 8 | 0.000 (0.062) | 0.125 | 24 / 4 | 0.042 (0.183) | 0.250 | 3 |
| cohere\|fake-quality-v1\|zh\|same\|balanced | calibrated | 0.0745 | 47 / 8 | 0.000 (0.062) | 0.125 | 24 / 4 | 0.042 (0.183) | 0.250 | 2 |
| cohere\|fake-quality-v1\|zh\|same\|flexible | calibrated | 0.0745 | 47 / 8 | 0.000 (0.062) | 0.125 | 24 / 4 | 0.042 (0.183) | 0.250 | 2 |
| cohere\|fake-quality-v1\|zh\|same\|strict | calibrated | 0.7185 | 47 / 8 | 0.957 (0.992) | 1.000 | 24 / 4 | 0.917 (0.985) | 1.000 | 2 |

A point estimate at or below target is not evidence until its 95% upper bound is. Only `calibrated` cells are applied; every other status never refuses.

## Operating points per mode

- strict favours fewer false answers: the lowest false-refusal threshold whose dev false-answer rate (no-answer items answered) is at or below 0.050; holdout rule `false_answer_test <= cap + max(noise_floor, 1 / n_test_no_answer)`.
- balanced favours fewer false refusals: the threshold with the most correct refusals whose dev false-refusal rate is at or below 0.050 (the Phase 4 rule); holdout rule `false_refusal_test <= target + max(noise_floor, 1 / n_test_answerable)`.
- flexible favours fewer false refusals: the threshold with the most correct refusals whose dev false-refusal rate is at or below 0.050 (the Phase 4 rule); holdout rule `false_refusal_test <= target + max(noise_floor, 1 / n_test_answerable)`.
- `*` is the shared cell: voice (no mode), bypass and any mode without its own cell use it.

A cap on false answers is only as strong as the number of no-answer items behind it: with n items, a cap c admits at most floor(c * n) observed false answers, and the 95% upper bound beside each rate shows what the sample can prove.

| Cell | Mode | Status | Threshold | Dev false-answer | Dev false refusal | Holdout false-answer | Holdout false refusal | Holdout evaluations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cohere\|fake-quality-v1\|en\|cross | * | insufficient_data | - | 1.000 (n=1, 95% upper 1.000) | 0.000 (n=2, 95% upper 0.776) | - | - | 0 |
| cohere\|fake-quality-v1\|en\|cross | balanced | insufficient_data | - | 1.000 (n=1, 95% upper 1.000) | 0.000 (n=2, 95% upper 0.776) | - | - | 0 |
| cohere\|fake-quality-v1\|en\|cross | flexible | insufficient_data | - | 1.000 (n=1, 95% upper 1.000) | 0.000 (n=2, 95% upper 0.776) | - | - | 0 |
| cohere\|fake-quality-v1\|en\|cross | strict | insufficient_data | - | 1.000 (n=1, 95% upper 1.000) | 0.000 (n=2, 95% upper 0.776) | - | - | 0 |
| cohere\|fake-quality-v1\|en\|same | * | calibrated | 0.1419 | 0.750 (n=12, 95% upper 0.928) | 0.000 (n=48, 95% upper 0.061) | 0.667 (n=3, 95% upper 0.983) | 0.050 (n=20, 95% upper 0.216) | 3 |
| cohere\|fake-quality-v1\|en\|same | balanced | calibrated | 0.1419 | 0.750 (n=12, 95% upper 0.928) | 0.000 (n=48, 95% upper 0.061) | 0.667 (n=3, 95% upper 0.983) | 0.050 (n=20, 95% upper 0.216) | 2 |
| cohere\|fake-quality-v1\|en\|same | flexible | calibrated | 0.1419 | 0.750 (n=12, 95% upper 0.928) | 0.000 (n=48, 95% upper 0.061) | 0.667 (n=3, 95% upper 0.983) | 0.050 (n=20, 95% upper 0.216) | 2 |
| cohere\|fake-quality-v1\|en\|same | strict | calibrated | 0.7281 | 0.000 (n=12, 95% upper 0.221) | 0.875 (n=48, 95% upper 0.944) | 0.000 (n=3, 95% upper 0.632) | 0.950 (n=20, 95% upper 0.997) | 2 |
| cohere\|fake-quality-v1\|it\|cross | * | insufficient_data | - | 1.000 (n=2, 95% upper 1.000) | 0.000 (n=4, 95% upper 0.527) | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross | balanced | insufficient_data | - | 1.000 (n=2, 95% upper 1.000) | 0.000 (n=4, 95% upper 0.527) | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross | flexible | insufficient_data | - | 1.000 (n=2, 95% upper 1.000) | 0.000 (n=4, 95% upper 0.527) | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross | strict | insufficient_data | - | 1.000 (n=2, 95% upper 1.000) | 0.000 (n=4, 95% upper 0.527) | - | - | 0 |
| cohere\|fake-quality-v1\|it\|same | * | calibrated | 0.1564 | 0.667 (n=9, 95% upper 0.902) | 0.000 (n=36, 95% upper 0.080) | 0.500 (n=4, 95% upper 0.902) | 0.091 (n=22, 95% upper 0.259) | 3 |
| cohere\|fake-quality-v1\|it\|same | balanced | calibrated | 0.1564 | 0.667 (n=9, 95% upper 0.902) | 0.000 (n=36, 95% upper 0.080) | 0.500 (n=4, 95% upper 0.902) | 0.091 (n=22, 95% upper 0.259) | 2 |
| cohere\|fake-quality-v1\|it\|same | flexible | calibrated | 0.1564 | 0.667 (n=9, 95% upper 0.902) | 0.000 (n=36, 95% upper 0.080) | 0.500 (n=4, 95% upper 0.902) | 0.091 (n=22, 95% upper 0.259) | 2 |
| cohere\|fake-quality-v1\|it\|same | strict | calibrated | 0.6694 | 0.000 (n=9, 95% upper 0.283) | 0.917 (n=36, 95% upper 0.977) | 0.000 (n=4, 95% upper 0.527) | 0.864 (n=22, 95% upper 0.962) | 2 |
| cohere\|fake-quality-v1\|zh\|cross | * | insufficient_data | - | 1.000 (n=4, 95% upper 1.000) | 0.000 (n=3, 95% upper 0.632) | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross | balanced | insufficient_data | - | 1.000 (n=4, 95% upper 1.000) | 0.000 (n=3, 95% upper 0.632) | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross | flexible | insufficient_data | - | 1.000 (n=4, 95% upper 1.000) | 0.000 (n=3, 95% upper 0.632) | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross | strict | insufficient_data | - | 1.000 (n=4, 95% upper 1.000) | 0.000 (n=3, 95% upper 0.632) | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|same | * | calibrated | 0.0745 | 0.875 (n=8, 95% upper 0.994) | 0.000 (n=47, 95% upper 0.062) | 0.750 (n=4, 95% upper 0.987) | 0.042 (n=24, 95% upper 0.183) | 3 |
| cohere\|fake-quality-v1\|zh\|same | balanced | calibrated | 0.0745 | 0.875 (n=8, 95% upper 0.994) | 0.000 (n=47, 95% upper 0.062) | 0.750 (n=4, 95% upper 0.987) | 0.042 (n=24, 95% upper 0.183) | 2 |
| cohere\|fake-quality-v1\|zh\|same | flexible | calibrated | 0.0745 | 0.875 (n=8, 95% upper 0.994) | 0.000 (n=47, 95% upper 0.062) | 0.750 (n=4, 95% upper 0.987) | 0.042 (n=24, 95% upper 0.183) | 2 |
| cohere\|fake-quality-v1\|zh\|same | strict | calibrated | 0.7185 | 0.000 (n=8, 95% upper 0.312) | 0.957 (n=47, 95% upper 0.992) | 0.000 (n=4, 95% upper 0.527) | 0.917 (n=24, 95% upper 0.985) | 2 |

## Candidate sweep

Every candidate threshold of each cell: never refuse, each midpoint between neighbouring dev scores, and just above the top score. A false refusal is an answerable item refused; a false-answer is a no-answer item answered. Holdout columns are filled only for cells whose frozen test split was read (a cell with a threshold). `Chosen by` names the modes that picked the row (`*` is the shared cell).

### cohere|fake-quality-v1|en|cross

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/2, 95% upper 0.776) | 1.000 (1/1, 95% upper 1.000) | - | - |  |
| 0.2635 | 0.000 (0/2, 95% upper 0.776) | 0.000 (0/1, 95% upper 0.950) | - | - |  |
| 0.4486 | 0.500 (1/2, 95% upper 0.975) | 0.000 (0/1, 95% upper 0.950) | - | - |  |
| 0.5821 | 1.000 (2/2, 95% upper 1.000) | 0.000 (0/1, 95% upper 0.950) | - | - |  |

### cohere|fake-quality-v1|en|same

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/48, 95% upper 0.061) | 1.000 (12/12, 95% upper 1.000) | 0.000 (0/20, 95% upper 0.139) | 1.000 (3/3, 95% upper 1.000) |  |
| 0.0883 | 0.000 (0/48, 95% upper 0.061) | 0.917 (11/12, 95% upper 0.996) | 0.050 (1/20, 95% upper 0.216) | 0.667 (2/3, 95% upper 0.983) |  |
| 0.1098 | 0.000 (0/48, 95% upper 0.061) | 0.833 (10/12, 95% upper 0.970) | 0.050 (1/20, 95% upper 0.216) | 0.667 (2/3, 95% upper 0.983) |  |
| 0.1419 | 0.000 (0/48, 95% upper 0.061) | 0.750 (9/12, 95% upper 0.928) | 0.050 (1/20, 95% upper 0.216) | 0.667 (2/3, 95% upper 0.983) | *, balanced, flexible |
| 0.1680 | 0.021 (1/48, 95% upper 0.095) | 0.750 (9/12, 95% upper 0.928) | 0.100 (2/20, 95% upper 0.283) | 0.667 (2/3, 95% upper 0.983) |  |
| 0.1815 | 0.042 (2/48, 95% upper 0.125) | 0.750 (9/12, 95% upper 0.928) | 0.150 (3/20, 95% upper 0.344) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.1927 | 0.062 (3/48, 95% upper 0.154) | 0.750 (9/12, 95% upper 0.928) | 0.150 (3/20, 95% upper 0.344) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.1964 | 0.083 (4/48, 95% upper 0.181) | 0.750 (9/12, 95% upper 0.928) | 0.150 (3/20, 95% upper 0.344) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.2031 | 0.104 (5/48, 95% upper 0.207) | 0.750 (9/12, 95% upper 0.928) | 0.200 (4/20, 95% upper 0.401) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.2110 | 0.125 (6/48, 95% upper 0.232) | 0.750 (9/12, 95% upper 0.928) | 0.200 (4/20, 95% upper 0.401) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.2172 | 0.146 (7/48, 95% upper 0.257) | 0.750 (9/12, 95% upper 0.928) | 0.200 (4/20, 95% upper 0.401) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.2328 | 0.167 (8/48, 95% upper 0.281) | 0.750 (9/12, 95% upper 0.928) | 0.200 (4/20, 95% upper 0.401) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.2514 | 0.188 (9/48, 95% upper 0.304) | 0.750 (9/12, 95% upper 0.928) | 0.200 (4/20, 95% upper 0.401) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.2580 | 0.208 (10/48, 95% upper 0.328) | 0.750 (9/12, 95% upper 0.928) | 0.200 (4/20, 95% upper 0.401) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.2653 | 0.229 (11/48, 95% upper 0.351) | 0.750 (9/12, 95% upper 0.928) | 0.200 (4/20, 95% upper 0.401) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.2730 | 0.250 (12/48, 95% upper 0.373) | 0.750 (9/12, 95% upper 0.928) | 0.200 (4/20, 95% upper 0.401) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.2865 | 0.271 (13/48, 95% upper 0.396) | 0.750 (9/12, 95% upper 0.928) | 0.250 (5/20, 95% upper 0.456) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.3013 | 0.292 (14/48, 95% upper 0.418) | 0.750 (9/12, 95% upper 0.928) | 0.250 (5/20, 95% upper 0.456) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.3080 | 0.312 (15/48, 95% upper 0.440) | 0.750 (9/12, 95% upper 0.928) | 0.250 (5/20, 95% upper 0.456) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.3153 | 0.333 (16/48, 95% upper 0.461) | 0.750 (9/12, 95% upper 0.928) | 0.250 (5/20, 95% upper 0.456) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.3436 | 0.354 (17/48, 95% upper 0.483) | 0.750 (9/12, 95% upper 0.928) | 0.300 (6/20, 95% upper 0.508) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.3698 | 0.375 (18/48, 95% upper 0.504) | 0.750 (9/12, 95% upper 0.928) | 0.300 (6/20, 95% upper 0.508) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.3722 | 0.396 (19/48, 95% upper 0.525) | 0.750 (9/12, 95% upper 0.928) | 0.300 (6/20, 95% upper 0.508) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.3925 | 0.417 (20/48, 95% upper 0.545) | 0.750 (9/12, 95% upper 0.928) | 0.350 (7/20, 95% upper 0.558) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.4252 | 0.417 (20/48, 95% upper 0.545) | 0.667 (8/12, 95% upper 0.877) | 0.450 (9/20, 95% upper 0.653) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.4410 | 0.438 (21/48, 95% upper 0.566) | 0.667 (8/12, 95% upper 0.877) | 0.450 (9/20, 95% upper 0.653) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.4451 | 0.458 (22/48, 95% upper 0.586) | 0.667 (8/12, 95% upper 0.877) | 0.450 (9/20, 95% upper 0.653) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.4613 | 0.479 (23/48, 95% upper 0.606) | 0.667 (8/12, 95% upper 0.877) | 0.500 (10/20, 95% upper 0.698) | 0.333 (1/3, 95% upper 0.865) |  |
| 0.4757 | 0.479 (23/48, 95% upper 0.606) | 0.583 (7/12, 95% upper 0.819) | 0.550 (11/20, 95% upper 0.741) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.4781 | 0.500 (24/48, 95% upper 0.626) | 0.583 (7/12, 95% upper 0.819) | 0.550 (11/20, 95% upper 0.741) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.4810 | 0.521 (25/48, 95% upper 0.646) | 0.583 (7/12, 95% upper 0.819) | 0.550 (11/20, 95% upper 0.741) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.4847 | 0.542 (26/48, 95% upper 0.666) | 0.583 (7/12, 95% upper 0.819) | 0.600 (12/20, 95% upper 0.783) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.4879 | 0.562 (27/48, 95% upper 0.685) | 0.583 (7/12, 95% upper 0.819) | 0.600 (12/20, 95% upper 0.783) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.4907 | 0.583 (28/48, 95% upper 0.704) | 0.583 (7/12, 95% upper 0.819) | 0.600 (12/20, 95% upper 0.783) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.4930 | 0.604 (29/48, 95% upper 0.723) | 0.583 (7/12, 95% upper 0.819) | 0.650 (13/20, 95% upper 0.823) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.4971 | 0.625 (30/48, 95% upper 0.742) | 0.583 (7/12, 95% upper 0.819) | 0.650 (13/20, 95% upper 0.823) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5017 | 0.646 (31/48, 95% upper 0.760) | 0.583 (7/12, 95% upper 0.819) | 0.650 (13/20, 95% upper 0.823) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5047 | 0.667 (32/48, 95% upper 0.778) | 0.583 (7/12, 95% upper 0.819) | 0.650 (13/20, 95% upper 0.823) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5069 | 0.688 (33/48, 95% upper 0.796) | 0.583 (7/12, 95% upper 0.819) | 0.700 (14/20, 95% upper 0.860) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5159 | 0.708 (34/48, 95% upper 0.814) | 0.583 (7/12, 95% upper 0.819) | 0.750 (15/20, 95% upper 0.896) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5281 | 0.708 (34/48, 95% upper 0.814) | 0.500 (6/12, 95% upper 0.755) | 0.750 (15/20, 95% upper 0.896) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5318 | 0.708 (34/48, 95% upper 0.814) | 0.417 (5/12, 95% upper 0.685) | 0.750 (15/20, 95% upper 0.896) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5354 | 0.729 (35/48, 95% upper 0.832) | 0.417 (5/12, 95% upper 0.685) | 0.750 (15/20, 95% upper 0.896) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5392 | 0.729 (35/48, 95% upper 0.832) | 0.333 (4/12, 95% upper 0.609) | 0.800 (16/20, 95% upper 0.929) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5478 | 0.750 (36/48, 95% upper 0.849) | 0.333 (4/12, 95% upper 0.609) | 0.800 (16/20, 95% upper 0.929) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5639 | 0.771 (37/48, 95% upper 0.866) | 0.333 (4/12, 95% upper 0.609) | 0.800 (16/20, 95% upper 0.929) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5836 | 0.792 (38/48, 95% upper 0.882) | 0.333 (4/12, 95% upper 0.609) | 0.800 (16/20, 95% upper 0.929) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.5988 | 0.812 (39/48, 95% upper 0.899) | 0.333 (4/12, 95% upper 0.609) | 0.800 (16/20, 95% upper 0.929) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.6104 | 0.833 (40/48, 95% upper 0.914) | 0.333 (4/12, 95% upper 0.609) | 0.800 (16/20, 95% upper 0.929) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.6270 | 0.833 (40/48, 95% upper 0.914) | 0.250 (3/12, 95% upper 0.527) | 0.800 (16/20, 95% upper 0.929) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.6365 | 0.833 (40/48, 95% upper 0.914) | 0.167 (2/12, 95% upper 0.438) | 0.800 (16/20, 95% upper 0.929) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.6377 | 0.875 (42/48, 95% upper 0.944) | 0.167 (2/12, 95% upper 0.438) | 0.800 (16/20, 95% upper 0.929) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.6816 | 0.875 (42/48, 95% upper 0.944) | 0.083 (1/12, 95% upper 0.339) | 0.900 (18/20, 95% upper 0.982) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.7281 | 0.875 (42/48, 95% upper 0.944) | 0.000 (0/12, 95% upper 0.221) | 0.950 (19/20, 95% upper 0.997) | 0.000 (0/3, 95% upper 0.632) | strict |
| 0.7352 | 0.896 (43/48, 95% upper 0.958) | 0.000 (0/12, 95% upper 0.221) | 1.000 (20/20, 95% upper 1.000) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.7427 | 0.917 (44/48, 95% upper 0.971) | 0.000 (0/12, 95% upper 0.221) | 1.000 (20/20, 95% upper 1.000) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.7591 | 0.938 (45/48, 95% upper 0.983) | 0.000 (0/12, 95% upper 0.221) | 1.000 (20/20, 95% upper 1.000) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.7779 | 0.958 (46/48, 95% upper 0.993) | 0.000 (0/12, 95% upper 0.221) | 1.000 (20/20, 95% upper 1.000) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.7956 | 0.979 (47/48, 95% upper 0.999) | 0.000 (0/12, 95% upper 0.221) | 1.000 (20/20, 95% upper 1.000) | 0.000 (0/3, 95% upper 0.632) |  |
| 0.8081 | 1.000 (48/48, 95% upper 1.000) | 0.000 (0/12, 95% upper 0.221) | 1.000 (20/20, 95% upper 1.000) | 0.000 (0/3, 95% upper 0.632) |  |

### cohere|fake-quality-v1|it|cross

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/4, 95% upper 0.527) | 1.000 (2/2, 95% upper 1.000) | - | - |  |
| 0.1730 | 0.250 (1/4, 95% upper 0.751) | 1.000 (2/2, 95% upper 1.000) | - | - |  |
| 0.2550 | 0.250 (1/4, 95% upper 0.751) | 0.500 (1/2, 95% upper 0.975) | - | - |  |
| 0.3318 | 0.500 (2/4, 95% upper 0.902) | 0.500 (1/2, 95% upper 0.975) | - | - |  |
| 0.4156 | 0.500 (2/4, 95% upper 0.902) | 0.000 (0/2, 95% upper 0.776) | - | - |  |
| 0.4502 | 0.750 (3/4, 95% upper 0.987) | 0.000 (0/2, 95% upper 0.776) | - | - |  |
| 0.4526 | 1.000 (4/4, 95% upper 1.000) | 0.000 (0/2, 95% upper 0.776) | - | - |  |

### cohere|fake-quality-v1|it|same

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/36, 95% upper 0.080) | 1.000 (9/9, 95% upper 1.000) | 0.000 (0/22, 95% upper 0.127) | 1.000 (4/4, 95% upper 1.000) |  |
| 0.1276 | 0.000 (0/36, 95% upper 0.080) | 0.889 (8/9, 95% upper 0.994) | 0.000 (0/22, 95% upper 0.127) | 0.750 (3/4, 95% upper 0.987) |  |
| 0.1540 | 0.000 (0/36, 95% upper 0.080) | 0.778 (7/9, 95% upper 0.959) | 0.091 (2/22, 95% upper 0.259) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.1564 | 0.000 (0/36, 95% upper 0.080) | 0.667 (6/9, 95% upper 0.902) | 0.091 (2/22, 95% upper 0.259) | 0.500 (2/4, 95% upper 0.902) | *, balanced, flexible |
| 0.1606 | 0.028 (1/36, 95% upper 0.125) | 0.667 (6/9, 95% upper 0.902) | 0.091 (2/22, 95% upper 0.259) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.1843 | 0.056 (2/36, 95% upper 0.165) | 0.667 (6/9, 95% upper 0.902) | 0.182 (4/22, 95% upper 0.369) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2201 | 0.083 (3/36, 95% upper 0.202) | 0.667 (6/9, 95% upper 0.902) | 0.182 (4/22, 95% upper 0.369) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2417 | 0.111 (4/36, 95% upper 0.236) | 0.667 (6/9, 95% upper 0.902) | 0.182 (4/22, 95% upper 0.369) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2620 | 0.139 (5/36, 95% upper 0.270) | 0.667 (6/9, 95% upper 0.902) | 0.227 (5/22, 95% upper 0.420) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2825 | 0.167 (6/36, 95% upper 0.303) | 0.667 (6/9, 95% upper 0.902) | 0.227 (5/22, 95% upper 0.420) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2904 | 0.194 (7/36, 95% upper 0.334) | 0.667 (6/9, 95% upper 0.902) | 0.227 (5/22, 95% upper 0.420) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2971 | 0.222 (8/36, 95% upper 0.365) | 0.667 (6/9, 95% upper 0.902) | 0.227 (5/22, 95% upper 0.420) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3069 | 0.250 (9/36, 95% upper 0.396) | 0.667 (6/9, 95% upper 0.902) | 0.227 (5/22, 95% upper 0.420) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3320 | 0.278 (10/36, 95% upper 0.425) | 0.667 (6/9, 95% upper 0.902) | 0.273 (6/22, 95% upper 0.468) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3525 | 0.306 (11/36, 95% upper 0.455) | 0.667 (6/9, 95% upper 0.902) | 0.273 (6/22, 95% upper 0.468) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3563 | 0.333 (12/36, 95% upper 0.483) | 0.667 (6/9, 95% upper 0.902) | 0.273 (6/22, 95% upper 0.468) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3636 | 0.333 (12/36, 95% upper 0.483) | 0.556 (5/9, 95% upper 0.831) | 0.273 (6/22, 95% upper 0.468) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3766 | 0.361 (13/36, 95% upper 0.512) | 0.556 (5/9, 95% upper 0.831) | 0.273 (6/22, 95% upper 0.468) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.3932 | 0.389 (14/36, 95% upper 0.540) | 0.556 (5/9, 95% upper 0.831) | 0.273 (6/22, 95% upper 0.468) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4051 | 0.417 (15/36, 95% upper 0.567) | 0.556 (5/9, 95% upper 0.831) | 0.273 (6/22, 95% upper 0.468) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4100 | 0.444 (16/36, 95% upper 0.594) | 0.556 (5/9, 95% upper 0.831) | 0.318 (7/22, 95% upper 0.515) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4182 | 0.472 (17/36, 95% upper 0.620) | 0.556 (5/9, 95% upper 0.831) | 0.364 (8/22, 95% upper 0.561) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4320 | 0.500 (18/36, 95% upper 0.647) | 0.556 (5/9, 95% upper 0.831) | 0.409 (9/22, 95% upper 0.605) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4388 | 0.528 (19/36, 95% upper 0.672) | 0.556 (5/9, 95% upper 0.831) | 0.409 (9/22, 95% upper 0.605) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4489 | 0.556 (20/36, 95% upper 0.698) | 0.556 (5/9, 95% upper 0.831) | 0.455 (10/22, 95% upper 0.647) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4627 | 0.583 (21/36, 95% upper 0.723) | 0.556 (5/9, 95% upper 0.831) | 0.455 (10/22, 95% upper 0.647) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4699 | 0.611 (22/36, 95% upper 0.747) | 0.556 (5/9, 95% upper 0.831) | 0.500 (11/22, 95% upper 0.689) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4776 | 0.639 (23/36, 95% upper 0.771) | 0.556 (5/9, 95% upper 0.831) | 0.500 (11/22, 95% upper 0.689) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4832 | 0.639 (23/36, 95% upper 0.771) | 0.444 (4/9, 95% upper 0.749) | 0.500 (11/22, 95% upper 0.689) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4841 | 0.667 (24/36, 95% upper 0.795) | 0.444 (4/9, 95% upper 0.749) | 0.500 (11/22, 95% upper 0.689) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4848 | 0.694 (25/36, 95% upper 0.818) | 0.444 (4/9, 95% upper 0.749) | 0.500 (11/22, 95% upper 0.689) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4901 | 0.694 (25/36, 95% upper 0.818) | 0.333 (3/9, 95% upper 0.655) | 0.500 (11/22, 95% upper 0.689) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4988 | 0.722 (26/36, 95% upper 0.841) | 0.333 (3/9, 95% upper 0.655) | 0.500 (11/22, 95% upper 0.689) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.5036 | 0.750 (27/36, 95% upper 0.863) | 0.333 (3/9, 95% upper 0.655) | 0.500 (11/22, 95% upper 0.689) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.5252 | 0.778 (28/36, 95% upper 0.884) | 0.333 (3/9, 95% upper 0.655) | 0.545 (12/22, 95% upper 0.729) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.5475 | 0.806 (29/36, 95% upper 0.905) | 0.333 (3/9, 95% upper 0.655) | 0.682 (15/22, 95% upper 0.840) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.5505 | 0.833 (30/36, 95% upper 0.925) | 0.333 (3/9, 95% upper 0.655) | 0.727 (16/22, 95% upper 0.874) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5581 | 0.861 (31/36, 95% upper 0.944) | 0.333 (3/9, 95% upper 0.655) | 0.773 (17/22, 95% upper 0.906) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5671 | 0.889 (32/36, 95% upper 0.961) | 0.333 (3/9, 95% upper 0.655) | 0.818 (18/22, 95% upper 0.935) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5763 | 0.889 (32/36, 95% upper 0.961) | 0.222 (2/9, 95% upper 0.550) | 0.818 (18/22, 95% upper 0.935) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5928 | 0.889 (32/36, 95% upper 0.961) | 0.111 (1/9, 95% upper 0.429) | 0.818 (18/22, 95% upper 0.935) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6165 | 0.917 (33/36, 95% upper 0.977) | 0.111 (1/9, 95% upper 0.429) | 0.818 (18/22, 95% upper 0.935) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6694 | 0.917 (33/36, 95% upper 0.977) | 0.000 (0/9, 95% upper 0.283) | 0.864 (19/22, 95% upper 0.962) | 0.000 (0/4, 95% upper 0.527) | strict |
| 0.7160 | 0.944 (34/36, 95% upper 0.990) | 0.000 (0/9, 95% upper 0.283) | 0.909 (20/22, 95% upper 0.984) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.7342 | 0.972 (35/36, 95% upper 0.999) | 0.000 (0/9, 95% upper 0.283) | 0.909 (20/22, 95% upper 0.984) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.7445 | 1.000 (36/36, 95% upper 1.000) | 0.000 (0/9, 95% upper 0.283) | 1.000 (22/22, 95% upper 1.000) | 0.000 (0/4, 95% upper 0.527) |  |

### cohere|fake-quality-v1|zh|cross

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/3, 95% upper 0.632) | 1.000 (4/4, 95% upper 1.000) | - | - |  |
| 0.0217 | 0.000 (0/3, 95% upper 0.632) | 0.750 (3/4, 95% upper 0.987) | - | - |  |
| 0.0472 | 0.000 (0/3, 95% upper 0.632) | 0.500 (2/4, 95% upper 0.902) | - | - |  |
| 0.1445 | 0.000 (0/3, 95% upper 0.632) | 0.250 (1/4, 95% upper 0.751) | - | - |  |
| 0.2989 | 0.000 (0/3, 95% upper 0.632) | 0.000 (0/4, 95% upper 0.527) | - | - |  |
| 0.3674 | 0.333 (1/3, 95% upper 0.865) | 0.000 (0/4, 95% upper 0.527) | - | - |  |
| 0.4091 | 0.667 (2/3, 95% upper 0.983) | 0.000 (0/4, 95% upper 0.527) | - | - |  |
| 0.4431 | 1.000 (3/3, 95% upper 1.000) | 0.000 (0/4, 95% upper 0.527) | - | - |  |

### cohere|fake-quality-v1|zh|same

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/47, 95% upper 0.062) | 1.000 (8/8, 95% upper 1.000) | 0.000 (0/24, 95% upper 0.117) | 1.000 (4/4, 95% upper 1.000) |  |
| 0.0745 | 0.000 (0/47, 95% upper 0.062) | 0.875 (7/8, 95% upper 0.994) | 0.042 (1/24, 95% upper 0.183) | 0.750 (3/4, 95% upper 0.987) | *, balanced, flexible |
| 0.1163 | 0.021 (1/47, 95% upper 0.097) | 0.875 (7/8, 95% upper 0.994) | 0.042 (1/24, 95% upper 0.183) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.1293 | 0.043 (2/47, 95% upper 0.128) | 0.875 (7/8, 95% upper 0.994) | 0.042 (1/24, 95% upper 0.183) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.1531 | 0.064 (3/47, 95% upper 0.157) | 0.875 (7/8, 95% upper 0.994) | 0.083 (2/24, 95% upper 0.240) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.1855 | 0.085 (4/47, 95% upper 0.184) | 0.875 (7/8, 95% upper 0.994) | 0.083 (2/24, 95% upper 0.240) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2063 | 0.106 (5/47, 95% upper 0.211) | 0.875 (7/8, 95% upper 0.994) | 0.125 (3/24, 95% upper 0.292) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2354 | 0.128 (6/47, 95% upper 0.236) | 0.875 (7/8, 95% upper 0.994) | 0.167 (4/24, 95% upper 0.342) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2573 | 0.149 (7/47, 95% upper 0.262) | 0.875 (7/8, 95% upper 0.994) | 0.167 (4/24, 95% upper 0.342) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2777 | 0.170 (8/47, 95% upper 0.286) | 0.875 (7/8, 95% upper 0.994) | 0.167 (4/24, 95% upper 0.342) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3004 | 0.191 (9/47, 95% upper 0.310) | 0.875 (7/8, 95% upper 0.994) | 0.167 (4/24, 95% upper 0.342) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3082 | 0.213 (10/47, 95% upper 0.334) | 0.875 (7/8, 95% upper 0.994) | 0.208 (5/24, 95% upper 0.389) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3146 | 0.234 (11/47, 95% upper 0.358) | 0.875 (7/8, 95% upper 0.994) | 0.250 (6/24, 95% upper 0.435) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3247 | 0.255 (12/47, 95% upper 0.381) | 0.875 (7/8, 95% upper 0.994) | 0.292 (7/24, 95% upper 0.479) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3357 | 0.277 (13/47, 95% upper 0.403) | 0.875 (7/8, 95% upper 0.994) | 0.292 (7/24, 95% upper 0.479) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.3444 | 0.298 (14/47, 95% upper 0.426) | 0.875 (7/8, 95% upper 0.994) | 0.333 (8/24, 95% upper 0.521) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.3487 | 0.319 (15/47, 95% upper 0.448) | 0.875 (7/8, 95% upper 0.994) | 0.417 (10/24, 95% upper 0.603) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.3553 | 0.340 (16/47, 95% upper 0.470) | 0.875 (7/8, 95% upper 0.994) | 0.417 (10/24, 95% upper 0.603) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.3678 | 0.362 (17/47, 95% upper 0.492) | 0.875 (7/8, 95% upper 0.994) | 0.458 (11/24, 95% upper 0.642) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.3842 | 0.383 (18/47, 95% upper 0.513) | 0.875 (7/8, 95% upper 0.994) | 0.542 (13/24, 95% upper 0.718) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4011 | 0.404 (19/47, 95% upper 0.535) | 0.875 (7/8, 95% upper 0.994) | 0.583 (14/24, 95% upper 0.754) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4103 | 0.426 (20/47, 95% upper 0.556) | 0.875 (7/8, 95% upper 0.994) | 0.583 (14/24, 95% upper 0.754) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4147 | 0.447 (21/47, 95% upper 0.577) | 0.875 (7/8, 95% upper 0.994) | 0.583 (14/24, 95% upper 0.754) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4186 | 0.468 (22/47, 95% upper 0.597) | 0.875 (7/8, 95% upper 0.994) | 0.583 (14/24, 95% upper 0.754) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4198 | 0.489 (23/47, 95% upper 0.618) | 0.875 (7/8, 95% upper 0.994) | 0.583 (14/24, 95% upper 0.754) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4247 | 0.511 (24/47, 95% upper 0.638) | 0.875 (7/8, 95% upper 0.994) | 0.583 (14/24, 95% upper 0.754) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4292 | 0.532 (25/47, 95% upper 0.658) | 0.875 (7/8, 95% upper 0.994) | 0.583 (14/24, 95% upper 0.754) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4326 | 0.553 (26/47, 95% upper 0.678) | 0.875 (7/8, 95% upper 0.994) | 0.583 (14/24, 95% upper 0.754) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4385 | 0.574 (27/47, 95% upper 0.697) | 0.875 (7/8, 95% upper 0.994) | 0.583 (14/24, 95% upper 0.754) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4552 | 0.596 (28/47, 95% upper 0.717) | 0.875 (7/8, 95% upper 0.994) | 0.667 (16/24, 95% upper 0.822) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4694 | 0.617 (29/47, 95% upper 0.736) | 0.875 (7/8, 95% upper 0.994) | 0.667 (16/24, 95% upper 0.822) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4701 | 0.638 (30/47, 95% upper 0.755) | 0.875 (7/8, 95% upper 0.994) | 0.667 (16/24, 95% upper 0.822) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4778 | 0.638 (30/47, 95% upper 0.755) | 0.750 (6/8, 95% upper 0.954) | 0.667 (16/24, 95% upper 0.822) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4868 | 0.660 (31/47, 95% upper 0.773) | 0.750 (6/8, 95% upper 0.954) | 0.667 (16/24, 95% upper 0.822) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4895 | 0.681 (32/47, 95% upper 0.792) | 0.750 (6/8, 95% upper 0.954) | 0.667 (16/24, 95% upper 0.822) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4980 | 0.681 (32/47, 95% upper 0.792) | 0.625 (5/8, 95% upper 0.889) | 0.708 (17/24, 95% upper 0.854) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5055 | 0.702 (33/47, 95% upper 0.810) | 0.625 (5/8, 95% upper 0.889) | 0.708 (17/24, 95% upper 0.854) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5096 | 0.723 (34/47, 95% upper 0.828) | 0.625 (5/8, 95% upper 0.889) | 0.708 (17/24, 95% upper 0.854) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5165 | 0.723 (34/47, 95% upper 0.828) | 0.500 (4/8, 95% upper 0.807) | 0.708 (17/24, 95% upper 0.854) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5291 | 0.723 (34/47, 95% upper 0.828) | 0.375 (3/8, 95% upper 0.711) | 0.792 (19/24, 95% upper 0.914) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5415 | 0.745 (35/47, 95% upper 0.846) | 0.375 (3/8, 95% upper 0.711) | 0.792 (19/24, 95% upper 0.914) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5516 | 0.745 (35/47, 95% upper 0.846) | 0.250 (2/8, 95% upper 0.600) | 0.792 (19/24, 95% upper 0.914) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5670 | 0.766 (36/47, 95% upper 0.863) | 0.250 (2/8, 95% upper 0.600) | 0.792 (19/24, 95% upper 0.914) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5818 | 0.787 (37/47, 95% upper 0.880) | 0.250 (2/8, 95% upper 0.600) | 0.792 (19/24, 95% upper 0.914) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5982 | 0.809 (38/47, 95% upper 0.896) | 0.250 (2/8, 95% upper 0.600) | 0.792 (19/24, 95% upper 0.914) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6098 | 0.830 (39/47, 95% upper 0.912) | 0.250 (2/8, 95% upper 0.600) | 0.792 (19/24, 95% upper 0.914) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6155 | 0.851 (40/47, 95% upper 0.928) | 0.250 (2/8, 95% upper 0.600) | 0.833 (20/24, 95% upper 0.941) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6240 | 0.872 (41/47, 95% upper 0.943) | 0.250 (2/8, 95% upper 0.600) | 0.833 (20/24, 95% upper 0.941) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6312 | 0.872 (41/47, 95% upper 0.943) | 0.125 (1/8, 95% upper 0.471) | 0.875 (21/24, 95% upper 0.965) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6481 | 0.894 (42/47, 95% upper 0.957) | 0.125 (1/8, 95% upper 0.471) | 0.875 (21/24, 95% upper 0.965) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6711 | 0.915 (43/47, 95% upper 0.970) | 0.125 (1/8, 95% upper 0.471) | 0.875 (21/24, 95% upper 0.965) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6937 | 0.936 (44/47, 95% upper 0.982) | 0.125 (1/8, 95% upper 0.471) | 0.917 (22/24, 95% upper 0.985) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.7112 | 0.957 (45/47, 95% upper 0.992) | 0.125 (1/8, 95% upper 0.471) | 0.917 (22/24, 95% upper 0.985) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.7185 | 0.957 (45/47, 95% upper 0.992) | 0.000 (0/8, 95% upper 0.312) | 0.917 (22/24, 95% upper 0.985) | 0.000 (0/4, 95% upper 0.527) | strict |
| 0.7329 | 0.979 (46/47, 95% upper 0.999) | 0.000 (0/8, 95% upper 0.312) | 0.917 (22/24, 95% upper 0.985) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.7438 | 1.000 (47/47, 95% upper 1.000) | 0.000 (0/8, 95% upper 0.312) | 0.917 (22/24, 95% upper 0.985) | 0.000 (0/4, 95% upper 0.527) |  |

## Excluded traces

- no_query_language: 14

## Stale cells

None.

## XLG-03: cross-lingual versus same-language cells

The noise band is 0.020 (noise.json floor; single run, no spread). The gap is cross minus same false-refusal rate on the holdout split when both cells were read, otherwise on dev.

| Query language | Basis | Same (n answerable) | Cross (n answerable) | Gap | Verdict |
| --- | --- | --- | --- | --- | --- |
| en (cohere / fake-quality-v1) | - | - | - | - | not comparable: a cell without a threshold has no false-refusal rate to compare |
| it (cohere / fake-quality-v1) | - | - | - | - | not comparable: a cell without a threshold has no false-refusal rate to compare |
| zh (cohere / fake-quality-v1) | - | - | - | - | not comparable: a cell without a threshold has no false-refusal rate to compare |

No query language has both a same and a cross cell with a threshold, so the comparison is open.

## Fixture similarity floor (D-30 fallback)

Fitted on the dev split only (the test split is not read) over every dev item's best dense similarity, at the same false-refusal target (0.050); an image chunk above the image floor counts as answered. It applies where the threshold gate is not_applied. Fixture floors are written for the eval harness only; the production legacy profile keeps its own score_calibration.

| Status | context_threshold | Dev answerable / no-answer | Dev false refusal (95% upper) | Dev correct refusal | Excluded (no similarity) |
| --- | --- | --- | --- | --- | --- |
| calibrated | 0.1411 | 150 / 38 | 0.020 (0.051) | 0.263 | 0 |
