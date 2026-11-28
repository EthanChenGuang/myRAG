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
| cohere\|fake-quality-v1\|en\|same | calibrated | 0.1362 | 42 / 7 | 0.000 (0.069) | 0.429 | 17 / 2 | 0.059 (0.250) | 0.500 | 2 |
| cohere\|fake-quality-v1\|en\|same\|balanced | calibrated | 0.1362 | 42 / 7 | 0.000 (0.069) | 0.429 | 17 / 2 | 0.059 (0.250) | 0.500 | 1 |
| cohere\|fake-quality-v1\|en\|same\|flexible | calibrated | 0.1362 | 42 / 7 | 0.000 (0.069) | 0.429 | 17 / 2 | 0.059 (0.250) | 0.500 | 1 |
| cohere\|fake-quality-v1\|en\|same\|strict | calibrated | 0.5392 | 42 / 7 | 0.738 (0.846) | 1.000 | 17 / 2 | 0.765 (0.915) | 1.000 | 1 |
| cohere\|fake-quality-v1\|it\|cross | insufficient_data | - | 4 / 1 | 0.000 (0.527) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross\|balanced | insufficient_data | - | 4 / 1 | 0.000 (0.527) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross\|flexible | insufficient_data | - | 4 / 1 | 0.000 (0.527) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross\|strict | insufficient_data | - | 4 / 1 | 0.000 (0.527) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|it\|same | failed_holdout | 0.1592 | 33 / 5 | 0.000 (0.087) | 0.600 | 21 / 4 | 0.143 (0.329) | 0.500 | 2 |
| cohere\|fake-quality-v1\|it\|same\|balanced | failed_holdout | 0.1592 | 33 / 5 | 0.000 (0.087) | 0.600 | 21 / 4 | 0.143 (0.329) | 0.500 | 1 |
| cohere\|fake-quality-v1\|it\|same\|flexible | failed_holdout | 0.1592 | 33 / 5 | 0.000 (0.087) | 0.600 | 21 / 4 | 0.143 (0.329) | 0.500 | 1 |
| cohere\|fake-quality-v1\|it\|same\|strict | calibrated | 0.5005 | 33 / 5 | 0.727 (0.850) | 1.000 | 21 / 4 | 0.524 (0.714) | 0.750 | 1 |
| cohere\|fake-quality-v1\|zh\|cross | insufficient_data | - | 3 / 4 | 0.000 (0.632) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross\|balanced | insufficient_data | - | 3 / 4 | 0.000 (0.632) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross\|flexible | insufficient_data | - | 3 / 4 | 0.000 (0.632) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross\|strict | insufficient_data | - | 3 / 4 | 0.000 (0.632) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|same | calibrated | 0.0743 | 43 / 4 | 0.023 (0.106) | 0.250 | 19 / 4 | 0.053 (0.226) | 0.500 | 2 |
| cohere\|fake-quality-v1\|zh\|same\|balanced | calibrated | 0.0743 | 43 / 4 | 0.023 (0.106) | 0.250 | 19 / 4 | 0.053 (0.226) | 0.500 | 1 |
| cohere\|fake-quality-v1\|zh\|same\|flexible | calibrated | 0.0743 | 43 / 4 | 0.023 (0.106) | 0.250 | 19 / 4 | 0.053 (0.226) | 0.500 | 1 |
| cohere\|fake-quality-v1\|zh\|same\|strict | calibrated | 0.5544 | 43 / 4 | 0.744 (0.849) | 1.000 | 19 / 4 | 0.789 (0.925) | 1.000 | 1 |

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
| cohere\|fake-quality-v1\|en\|same | * | calibrated | 0.1362 | 0.571 (n=7, 95% upper 0.871) | 0.000 (n=42, 95% upper 0.069) | 0.500 (n=2, 95% upper 0.975) | 0.059 (n=17, 95% upper 0.250) | 2 |
| cohere\|fake-quality-v1\|en\|same | balanced | calibrated | 0.1362 | 0.571 (n=7, 95% upper 0.871) | 0.000 (n=42, 95% upper 0.069) | 0.500 (n=2, 95% upper 0.975) | 0.059 (n=17, 95% upper 0.250) | 1 |
| cohere\|fake-quality-v1\|en\|same | flexible | calibrated | 0.1362 | 0.571 (n=7, 95% upper 0.871) | 0.000 (n=42, 95% upper 0.069) | 0.500 (n=2, 95% upper 0.975) | 0.059 (n=17, 95% upper 0.250) | 1 |
| cohere\|fake-quality-v1\|en\|same | strict | calibrated | 0.5392 | 0.000 (n=7, 95% upper 0.348) | 0.738 (n=42, 95% upper 0.846) | 0.000 (n=2, 95% upper 0.776) | 0.765 (n=17, 95% upper 0.915) | 1 |
| cohere\|fake-quality-v1\|it\|cross | * | insufficient_data | - | 1.000 (n=1, 95% upper 1.000) | 0.000 (n=4, 95% upper 0.527) | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross | balanced | insufficient_data | - | 1.000 (n=1, 95% upper 1.000) | 0.000 (n=4, 95% upper 0.527) | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross | flexible | insufficient_data | - | 1.000 (n=1, 95% upper 1.000) | 0.000 (n=4, 95% upper 0.527) | - | - | 0 |
| cohere\|fake-quality-v1\|it\|cross | strict | insufficient_data | - | 1.000 (n=1, 95% upper 1.000) | 0.000 (n=4, 95% upper 0.527) | - | - | 0 |
| cohere\|fake-quality-v1\|it\|same | * | failed_holdout | 0.1592 | 0.400 (n=5, 95% upper 0.811) | 0.000 (n=33, 95% upper 0.087) | 0.500 (n=4, 95% upper 0.902) | 0.143 (n=21, 95% upper 0.329) | 2 |
| cohere\|fake-quality-v1\|it\|same | balanced | failed_holdout | 0.1592 | 0.400 (n=5, 95% upper 0.811) | 0.000 (n=33, 95% upper 0.087) | 0.500 (n=4, 95% upper 0.902) | 0.143 (n=21, 95% upper 0.329) | 1 |
| cohere\|fake-quality-v1\|it\|same | flexible | failed_holdout | 0.1592 | 0.400 (n=5, 95% upper 0.811) | 0.000 (n=33, 95% upper 0.087) | 0.500 (n=4, 95% upper 0.902) | 0.143 (n=21, 95% upper 0.329) | 1 |
| cohere\|fake-quality-v1\|it\|same | strict | calibrated | 0.5005 | 0.000 (n=5, 95% upper 0.451) | 0.727 (n=33, 95% upper 0.850) | 0.250 (n=4, 95% upper 0.751) | 0.524 (n=21, 95% upper 0.714) | 1 |
| cohere\|fake-quality-v1\|zh\|cross | * | insufficient_data | - | 1.000 (n=4, 95% upper 1.000) | 0.000 (n=3, 95% upper 0.632) | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross | balanced | insufficient_data | - | 1.000 (n=4, 95% upper 1.000) | 0.000 (n=3, 95% upper 0.632) | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross | flexible | insufficient_data | - | 1.000 (n=4, 95% upper 1.000) | 0.000 (n=3, 95% upper 0.632) | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|cross | strict | insufficient_data | - | 1.000 (n=4, 95% upper 1.000) | 0.000 (n=3, 95% upper 0.632) | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|same | * | calibrated | 0.0743 | 0.750 (n=4, 95% upper 0.987) | 0.023 (n=43, 95% upper 0.106) | 0.500 (n=4, 95% upper 0.902) | 0.053 (n=19, 95% upper 0.226) | 2 |
| cohere\|fake-quality-v1\|zh\|same | balanced | calibrated | 0.0743 | 0.750 (n=4, 95% upper 0.987) | 0.023 (n=43, 95% upper 0.106) | 0.500 (n=4, 95% upper 0.902) | 0.053 (n=19, 95% upper 0.226) | 1 |
| cohere\|fake-quality-v1\|zh\|same | flexible | calibrated | 0.0743 | 0.750 (n=4, 95% upper 0.987) | 0.023 (n=43, 95% upper 0.106) | 0.500 (n=4, 95% upper 0.902) | 0.053 (n=19, 95% upper 0.226) | 1 |
| cohere\|fake-quality-v1\|zh\|same | strict | calibrated | 0.5544 | 0.000 (n=4, 95% upper 0.527) | 0.744 (n=43, 95% upper 0.849) | 0.000 (n=4, 95% upper 0.527) | 0.789 (n=19, 95% upper 0.925) | 1 |

## Candidate sweep

Every candidate threshold of each cell: never refuse, each midpoint between neighbouring dev scores, and just above the top score. A false refusal is an answerable item refused; a false-answer is a no-answer item answered. Holdout columns are filled only for cells whose frozen test split was read (a cell with a threshold). `Chosen by` names the modes that picked the row (`*` is the shared cell).

### cohere|fake-quality-v1|en|cross

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/2, 95% upper 0.776) | 1.000 (1/1, 95% upper 1.000) | - | - |  |
| 0.1936 | 0.500 (1/2, 95% upper 0.975) | 1.000 (1/1, 95% upper 1.000) | - | - |  |
| 0.3941 | 0.500 (1/2, 95% upper 0.975) | 0.000 (0/1, 95% upper 0.950) | - | - |  |
| 0.5801 | 1.000 (2/2, 95% upper 1.000) | 0.000 (0/1, 95% upper 0.950) | - | - |  |

### cohere|fake-quality-v1|en|same

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/42, 95% upper 0.069) | 1.000 (7/7, 95% upper 1.000) | 0.000 (0/17, 95% upper 0.162) | 1.000 (2/2, 95% upper 1.000) |  |
| 0.0915 | 0.000 (0/42, 95% upper 0.069) | 0.857 (6/7, 95% upper 0.993) | 0.059 (1/17, 95% upper 0.250) | 0.500 (1/2, 95% upper 0.975) |  |
| 0.1074 | 0.000 (0/42, 95% upper 0.069) | 0.714 (5/7, 95% upper 0.947) | 0.059 (1/17, 95% upper 0.250) | 0.500 (1/2, 95% upper 0.975) |  |
| 0.1362 | 0.000 (0/42, 95% upper 0.069) | 0.571 (4/7, 95% upper 0.871) | 0.059 (1/17, 95% upper 0.250) | 0.500 (1/2, 95% upper 0.975) | *, balanced, flexible |
| 0.1678 | 0.024 (1/42, 95% upper 0.108) | 0.571 (4/7, 95% upper 0.871) | 0.118 (2/17, 95% upper 0.326) | 0.500 (1/2, 95% upper 0.975) |  |
| 0.1815 | 0.048 (2/42, 95% upper 0.142) | 0.571 (4/7, 95% upper 0.871) | 0.176 (3/17, 95% upper 0.396) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.1927 | 0.071 (3/42, 95% upper 0.174) | 0.571 (4/7, 95% upper 0.871) | 0.176 (3/17, 95% upper 0.396) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.1964 | 0.095 (4/42, 95% upper 0.205) | 0.571 (4/7, 95% upper 0.871) | 0.176 (3/17, 95% upper 0.396) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.2024 | 0.119 (5/42, 95% upper 0.234) | 0.571 (4/7, 95% upper 0.871) | 0.235 (4/17, 95% upper 0.461) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.2102 | 0.143 (6/42, 95% upper 0.263) | 0.571 (4/7, 95% upper 0.871) | 0.235 (4/17, 95% upper 0.461) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.2170 | 0.167 (7/42, 95% upper 0.290) | 0.571 (4/7, 95% upper 0.871) | 0.235 (4/17, 95% upper 0.461) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.2365 | 0.190 (8/42, 95% upper 0.318) | 0.571 (4/7, 95% upper 0.871) | 0.235 (4/17, 95% upper 0.461) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.2553 | 0.214 (9/42, 95% upper 0.344) | 0.571 (4/7, 95% upper 0.871) | 0.235 (4/17, 95% upper 0.461) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.2599 | 0.238 (10/42, 95% upper 0.370) | 0.571 (4/7, 95% upper 0.871) | 0.235 (4/17, 95% upper 0.461) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.2643 | 0.262 (11/42, 95% upper 0.396) | 0.571 (4/7, 95% upper 0.871) | 0.235 (4/17, 95% upper 0.461) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.2704 | 0.286 (12/42, 95% upper 0.421) | 0.571 (4/7, 95% upper 0.871) | 0.235 (4/17, 95% upper 0.461) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.2845 | 0.310 (13/42, 95% upper 0.446) | 0.571 (4/7, 95% upper 0.871) | 0.235 (4/17, 95% upper 0.461) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.2992 | 0.333 (14/42, 95% upper 0.471) | 0.571 (4/7, 95% upper 0.871) | 0.294 (5/17, 95% upper 0.522) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.3080 | 0.357 (15/42, 95% upper 0.495) | 0.571 (4/7, 95% upper 0.871) | 0.294 (5/17, 95% upper 0.522) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.3225 | 0.381 (16/42, 95% upper 0.520) | 0.571 (4/7, 95% upper 0.871) | 0.294 (5/17, 95% upper 0.522) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.3501 | 0.405 (17/42, 95% upper 0.543) | 0.571 (4/7, 95% upper 0.871) | 0.353 (6/17, 95% upper 0.580) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.3686 | 0.429 (18/42, 95% upper 0.567) | 0.571 (4/7, 95% upper 0.871) | 0.353 (6/17, 95% upper 0.580) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.3743 | 0.452 (19/42, 95% upper 0.590) | 0.571 (4/7, 95% upper 0.871) | 0.353 (6/17, 95% upper 0.580) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.3950 | 0.476 (20/42, 95% upper 0.613) | 0.571 (4/7, 95% upper 0.871) | 0.412 (7/17, 95% upper 0.636) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.4207 | 0.476 (20/42, 95% upper 0.613) | 0.429 (3/7, 95% upper 0.775) | 0.529 (9/17, 95% upper 0.740) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.4333 | 0.500 (21/42, 95% upper 0.635) | 0.429 (3/7, 95% upper 0.775) | 0.529 (9/17, 95% upper 0.740) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.4422 | 0.524 (22/42, 95% upper 0.658) | 0.429 (3/7, 95% upper 0.775) | 0.529 (9/17, 95% upper 0.740) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.4615 | 0.548 (23/42, 95% upper 0.680) | 0.429 (3/7, 95% upper 0.775) | 0.588 (10/17, 95% upper 0.788) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.4761 | 0.548 (23/42, 95% upper 0.680) | 0.286 (2/7, 95% upper 0.659) | 0.647 (11/17, 95% upper 0.834) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.4799 | 0.571 (24/42, 95% upper 0.702) | 0.286 (2/7, 95% upper 0.659) | 0.647 (11/17, 95% upper 0.834) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.4843 | 0.595 (25/42, 95% upper 0.723) | 0.286 (2/7, 95% upper 0.659) | 0.647 (11/17, 95% upper 0.834) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.4892 | 0.619 (26/42, 95% upper 0.744) | 0.286 (2/7, 95% upper 0.659) | 0.706 (12/17, 95% upper 0.876) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.4927 | 0.643 (27/42, 95% upper 0.765) | 0.286 (2/7, 95% upper 0.659) | 0.706 (12/17, 95% upper 0.876) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.4944 | 0.667 (28/42, 95% upper 0.786) | 0.286 (2/7, 95% upper 0.659) | 0.706 (12/17, 95% upper 0.876) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.5025 | 0.690 (29/42, 95% upper 0.806) | 0.286 (2/7, 95% upper 0.659) | 0.706 (12/17, 95% upper 0.876) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.5171 | 0.714 (30/42, 95% upper 0.826) | 0.286 (2/7, 95% upper 0.659) | 0.765 (13/17, 95% upper 0.915) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.5301 | 0.714 (30/42, 95% upper 0.826) | 0.143 (1/7, 95% upper 0.521) | 0.765 (13/17, 95% upper 0.915) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.5370 | 0.738 (31/42, 95% upper 0.846) | 0.143 (1/7, 95% upper 0.521) | 0.765 (13/17, 95% upper 0.915) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.5392 | 0.738 (31/42, 95% upper 0.846) | 0.000 (0/7, 95% upper 0.348) | 0.765 (13/17, 95% upper 0.915) | 0.000 (0/2, 95% upper 0.776) | strict |
| 0.5478 | 0.762 (32/42, 95% upper 0.865) | 0.000 (0/7, 95% upper 0.348) | 0.765 (13/17, 95% upper 0.915) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.5639 | 0.786 (33/42, 95% upper 0.883) | 0.000 (0/7, 95% upper 0.348) | 0.765 (13/17, 95% upper 0.915) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.5871 | 0.810 (34/42, 95% upper 0.902) | 0.000 (0/7, 95% upper 0.348) | 0.765 (13/17, 95% upper 0.915) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.6199 | 0.833 (35/42, 95% upper 0.919) | 0.000 (0/7, 95% upper 0.348) | 0.765 (13/17, 95% upper 0.915) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.6841 | 0.881 (37/42, 95% upper 0.952) | 0.000 (0/7, 95% upper 0.348) | 0.882 (15/17, 95% upper 0.979) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.7386 | 0.905 (38/42, 95% upper 0.967) | 0.000 (0/7, 95% upper 0.348) | 1.000 (17/17, 95% upper 1.000) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.7595 | 0.929 (39/42, 95% upper 0.980) | 0.000 (0/7, 95% upper 0.348) | 1.000 (17/17, 95% upper 1.000) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.7779 | 0.952 (40/42, 95% upper 0.991) | 0.000 (0/7, 95% upper 0.348) | 1.000 (17/17, 95% upper 1.000) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.7956 | 0.976 (41/42, 95% upper 0.999) | 0.000 (0/7, 95% upper 0.348) | 1.000 (17/17, 95% upper 1.000) | 0.000 (0/2, 95% upper 0.776) |  |
| 0.8081 | 1.000 (42/42, 95% upper 1.000) | 0.000 (0/7, 95% upper 0.348) | 1.000 (17/17, 95% upper 1.000) | 0.000 (0/2, 95% upper 0.776) |  |

### cohere|fake-quality-v1|it|cross

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/4, 95% upper 0.527) | 1.000 (1/1, 95% upper 1.000) | - | - |  |
| 0.1722 | 0.250 (1/4, 95% upper 0.751) | 1.000 (1/1, 95% upper 1.000) | - | - |  |
| 0.2543 | 0.250 (1/4, 95% upper 0.751) | 0.000 (0/1, 95% upper 0.950) | - | - |  |
| 0.3632 | 0.500 (2/4, 95% upper 0.902) | 0.000 (0/1, 95% upper 0.950) | - | - |  |
| 0.4498 | 0.750 (3/4, 95% upper 0.987) | 0.000 (0/1, 95% upper 0.950) | - | - |  |
| 0.4533 | 1.000 (4/4, 95% upper 1.000) | 0.000 (0/1, 95% upper 0.950) | - | - |  |

### cohere|fake-quality-v1|it|same

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/33, 95% upper 0.087) | 1.000 (5/5, 95% upper 1.000) | 0.000 (0/21, 95% upper 0.133) | 1.000 (4/4, 95% upper 1.000) |  |
| 0.1116 | 0.000 (0/33, 95% upper 0.087) | 0.800 (4/5, 95% upper 0.990) | 0.048 (1/21, 95% upper 0.207) | 1.000 (4/4, 95% upper 1.000) |  |
| 0.1554 | 0.000 (0/33, 95% upper 0.087) | 0.600 (3/5, 95% upper 0.924) | 0.143 (3/21, 95% upper 0.329) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.1592 | 0.000 (0/33, 95% upper 0.087) | 0.400 (2/5, 95% upper 0.811) | 0.143 (3/21, 95% upper 0.329) | 0.500 (2/4, 95% upper 0.902) | *, balanced, flexible |
| 0.1640 | 0.030 (1/33, 95% upper 0.136) | 0.400 (2/5, 95% upper 0.811) | 0.143 (3/21, 95% upper 0.329) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.1871 | 0.061 (2/33, 95% upper 0.179) | 0.400 (2/5, 95% upper 0.811) | 0.190 (4/21, 95% upper 0.384) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2225 | 0.091 (3/33, 95% upper 0.219) | 0.400 (2/5, 95% upper 0.811) | 0.190 (4/21, 95% upper 0.384) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2471 | 0.121 (4/33, 95% upper 0.256) | 0.400 (2/5, 95% upper 0.811) | 0.190 (4/21, 95% upper 0.384) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2652 | 0.152 (5/33, 95% upper 0.293) | 0.400 (2/5, 95% upper 0.811) | 0.238 (5/21, 95% upper 0.437) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2816 | 0.182 (6/33, 95% upper 0.328) | 0.400 (2/5, 95% upper 0.811) | 0.238 (5/21, 95% upper 0.437) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2897 | 0.212 (7/33, 95% upper 0.362) | 0.400 (2/5, 95% upper 0.811) | 0.238 (5/21, 95% upper 0.437) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.2919 | 0.242 (8/33, 95% upper 0.395) | 0.400 (2/5, 95% upper 0.811) | 0.238 (5/21, 95% upper 0.437) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3216 | 0.273 (9/33, 95% upper 0.428) | 0.400 (2/5, 95% upper 0.811) | 0.238 (5/21, 95% upper 0.437) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3514 | 0.303 (10/33, 95% upper 0.460) | 0.400 (2/5, 95% upper 0.811) | 0.286 (6/21, 95% upper 0.487) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3597 | 0.333 (11/33, 95% upper 0.491) | 0.400 (2/5, 95% upper 0.811) | 0.286 (6/21, 95% upper 0.487) | 0.500 (2/4, 95% upper 0.902) |  |
| 0.3766 | 0.364 (12/33, 95% upper 0.522) | 0.400 (2/5, 95% upper 0.811) | 0.286 (6/21, 95% upper 0.487) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.3933 | 0.394 (13/33, 95% upper 0.552) | 0.400 (2/5, 95% upper 0.811) | 0.286 (6/21, 95% upper 0.487) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4023 | 0.424 (14/33, 95% upper 0.581) | 0.400 (2/5, 95% upper 0.811) | 0.286 (6/21, 95% upper 0.487) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4052 | 0.455 (15/33, 95% upper 0.611) | 0.400 (2/5, 95% upper 0.811) | 0.286 (6/21, 95% upper 0.487) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4094 | 0.485 (16/33, 95% upper 0.639) | 0.400 (2/5, 95% upper 0.811) | 0.286 (6/21, 95% upper 0.487) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4249 | 0.515 (17/33, 95% upper 0.667) | 0.400 (2/5, 95% upper 0.811) | 0.429 (9/21, 95% upper 0.628) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4393 | 0.545 (18/33, 95% upper 0.695) | 0.400 (2/5, 95% upper 0.811) | 0.429 (9/21, 95% upper 0.628) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4532 | 0.576 (19/33, 95% upper 0.722) | 0.400 (2/5, 95% upper 0.811) | 0.476 (10/21, 95% upper 0.672) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4685 | 0.606 (20/33, 95% upper 0.749) | 0.400 (2/5, 95% upper 0.811) | 0.524 (11/21, 95% upper 0.714) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4719 | 0.636 (21/33, 95% upper 0.775) | 0.400 (2/5, 95% upper 0.811) | 0.524 (11/21, 95% upper 0.714) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4796 | 0.667 (22/33, 95% upper 0.801) | 0.400 (2/5, 95% upper 0.811) | 0.524 (11/21, 95% upper 0.714) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4869 | 0.697 (23/33, 95% upper 0.825) | 0.400 (2/5, 95% upper 0.811) | 0.524 (11/21, 95% upper 0.714) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4873 | 0.697 (23/33, 95% upper 0.825) | 0.200 (1/5, 95% upper 0.657) | 0.524 (11/21, 95% upper 0.714) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.4903 | 0.727 (24/33, 95% upper 0.850) | 0.200 (1/5, 95% upper 0.657) | 0.524 (11/21, 95% upper 0.714) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.5005 | 0.727 (24/33, 95% upper 0.850) | 0.000 (0/5, 95% upper 0.451) | 0.524 (11/21, 95% upper 0.714) | 0.250 (1/4, 95% upper 0.751) | strict |
| 0.5267 | 0.758 (25/33, 95% upper 0.873) | 0.000 (0/5, 95% upper 0.451) | 0.571 (12/21, 95% upper 0.755) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.5475 | 0.788 (26/33, 95% upper 0.896) | 0.000 (0/5, 95% upper 0.451) | 0.714 (15/21, 95% upper 0.868) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.5505 | 0.818 (27/33, 95% upper 0.918) | 0.000 (0/5, 95% upper 0.451) | 0.762 (16/21, 95% upper 0.901) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5581 | 0.848 (28/33, 95% upper 0.938) | 0.000 (0/5, 95% upper 0.451) | 0.762 (16/21, 95% upper 0.901) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5846 | 0.879 (29/33, 95% upper 0.958) | 0.000 (0/5, 95% upper 0.451) | 0.810 (17/21, 95% upper 0.932) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6554 | 0.909 (30/33, 95% upper 0.975) | 0.000 (0/5, 95% upper 0.451) | 0.857 (18/21, 95% upper 0.960) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.7141 | 0.939 (31/33, 95% upper 0.989) | 0.000 (0/5, 95% upper 0.451) | 0.905 (19/21, 95% upper 0.983) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.7332 | 0.970 (32/33, 95% upper 0.998) | 0.000 (0/5, 95% upper 0.451) | 0.905 (19/21, 95% upper 0.983) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.7445 | 1.000 (33/33, 95% upper 1.000) | 0.000 (0/5, 95% upper 0.451) | 1.000 (21/21, 95% upper 1.000) | 0.000 (0/4, 95% upper 0.527) |  |

### cohere|fake-quality-v1|zh|cross

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/3, 95% upper 0.632) | 1.000 (4/4, 95% upper 1.000) | - | - |  |
| 0.0217 | 0.000 (0/3, 95% upper 0.632) | 0.750 (3/4, 95% upper 0.987) | - | - |  |
| 0.0472 | 0.000 (0/3, 95% upper 0.632) | 0.500 (2/4, 95% upper 0.902) | - | - |  |
| 0.1445 | 0.000 (0/3, 95% upper 0.632) | 0.250 (1/4, 95% upper 0.751) | - | - |  |
| 0.2989 | 0.000 (0/3, 95% upper 0.632) | 0.000 (0/4, 95% upper 0.527) | - | - |  |
| 0.3680 | 0.333 (1/3, 95% upper 0.865) | 0.000 (0/4, 95% upper 0.527) | - | - |  |
| 0.4105 | 0.667 (2/3, 95% upper 0.983) | 0.000 (0/4, 95% upper 0.527) | - | - |  |
| 0.4448 | 1.000 (3/3, 95% upper 1.000) | 0.000 (0/4, 95% upper 0.527) | - | - |  |

### cohere|fake-quality-v1|zh|same

| Threshold | Dev false refusal (95% upper) | Dev false-answer (95% upper) | Holdout false refusal (95% upper) | Holdout false-answer (95% upper) | Chosen by |
| --- | --- | --- | --- | --- | --- |
| never refuse | 0.000 (0/43, 95% upper 0.067) | 1.000 (4/4, 95% upper 1.000) | 0.000 (0/19, 95% upper 0.146) | 1.000 (4/4, 95% upper 1.000) |  |
| 0.0451 | 0.023 (1/43, 95% upper 0.106) | 1.000 (4/4, 95% upper 1.000) | 0.000 (0/19, 95% upper 0.146) | 0.750 (3/4, 95% upper 0.987) |  |
| 0.0743 | 0.023 (1/43, 95% upper 0.106) | 0.750 (3/4, 95% upper 0.987) | 0.053 (1/19, 95% upper 0.226) | 0.500 (2/4, 95% upper 0.902) | *, balanced, flexible |
| 0.1165 | 0.047 (2/43, 95% upper 0.139) | 0.750 (3/4, 95% upper 0.987) | 0.053 (1/19, 95% upper 0.226) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.1559 | 0.070 (3/43, 95% upper 0.171) | 0.750 (3/4, 95% upper 0.987) | 0.105 (2/19, 95% upper 0.296) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.1883 | 0.093 (4/43, 95% upper 0.200) | 0.750 (3/4, 95% upper 0.987) | 0.158 (3/19, 95% upper 0.359) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.2057 | 0.116 (5/43, 95% upper 0.229) | 0.750 (3/4, 95% upper 0.987) | 0.158 (3/19, 95% upper 0.359) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.2359 | 0.140 (6/43, 95% upper 0.257) | 0.750 (3/4, 95% upper 0.987) | 0.211 (4/19, 95% upper 0.419) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.2577 | 0.163 (7/43, 95% upper 0.284) | 0.750 (3/4, 95% upper 0.987) | 0.211 (4/19, 95% upper 0.419) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.2770 | 0.186 (8/43, 95% upper 0.311) | 0.750 (3/4, 95% upper 0.987) | 0.211 (4/19, 95% upper 0.419) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.3002 | 0.209 (9/43, 95% upper 0.337) | 0.750 (3/4, 95% upper 0.987) | 0.211 (4/19, 95% upper 0.419) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.3087 | 0.233 (10/43, 95% upper 0.362) | 0.750 (3/4, 95% upper 0.987) | 0.263 (5/19, 95% upper 0.476) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.3157 | 0.256 (11/43, 95% upper 0.388) | 0.750 (3/4, 95% upper 0.987) | 0.316 (6/19, 95% upper 0.530) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.3251 | 0.279 (12/43, 95% upper 0.413) | 0.750 (3/4, 95% upper 0.987) | 0.316 (6/19, 95% upper 0.530) | 0.250 (1/4, 95% upper 0.751) |  |
| 0.3378 | 0.302 (13/43, 95% upper 0.437) | 0.750 (3/4, 95% upper 0.987) | 0.316 (6/19, 95% upper 0.530) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.3489 | 0.326 (14/43, 95% upper 0.461) | 0.750 (3/4, 95% upper 0.987) | 0.421 (8/19, 95% upper 0.632) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.3559 | 0.349 (15/43, 95% upper 0.485) | 0.750 (3/4, 95% upper 0.987) | 0.421 (8/19, 95% upper 0.632) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.3698 | 0.372 (16/43, 95% upper 0.509) | 0.750 (3/4, 95% upper 0.987) | 0.421 (8/19, 95% upper 0.632) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.3950 | 0.395 (17/43, 95% upper 0.532) | 0.750 (3/4, 95% upper 0.987) | 0.474 (9/19, 95% upper 0.680) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4109 | 0.419 (18/43, 95% upper 0.555) | 0.750 (3/4, 95% upper 0.987) | 0.526 (10/19, 95% upper 0.726) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4148 | 0.442 (19/43, 95% upper 0.578) | 0.750 (3/4, 95% upper 0.987) | 0.526 (10/19, 95% upper 0.726) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4195 | 0.465 (20/43, 95% upper 0.601) | 0.750 (3/4, 95% upper 0.987) | 0.526 (10/19, 95% upper 0.726) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4206 | 0.488 (21/43, 95% upper 0.623) | 0.750 (3/4, 95% upper 0.987) | 0.526 (10/19, 95% upper 0.726) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4251 | 0.512 (22/43, 95% upper 0.645) | 0.750 (3/4, 95% upper 0.987) | 0.526 (10/19, 95% upper 0.726) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4320 | 0.535 (23/43, 95% upper 0.667) | 0.750 (3/4, 95% upper 0.987) | 0.526 (10/19, 95% upper 0.726) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4412 | 0.558 (24/43, 95% upper 0.688) | 0.750 (3/4, 95% upper 0.987) | 0.526 (10/19, 95% upper 0.726) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4576 | 0.581 (25/43, 95% upper 0.709) | 0.750 (3/4, 95% upper 0.987) | 0.632 (12/19, 95% upper 0.812) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4689 | 0.605 (26/43, 95% upper 0.730) | 0.750 (3/4, 95% upper 0.987) | 0.632 (12/19, 95% upper 0.812) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4706 | 0.605 (26/43, 95% upper 0.730) | 0.500 (2/4, 95% upper 0.902) | 0.632 (12/19, 95% upper 0.812) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4781 | 0.628 (27/43, 95% upper 0.751) | 0.500 (2/4, 95% upper 0.902) | 0.632 (12/19, 95% upper 0.812) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4866 | 0.651 (28/43, 95% upper 0.771) | 0.500 (2/4, 95% upper 0.902) | 0.632 (12/19, 95% upper 0.812) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.4966 | 0.674 (29/43, 95% upper 0.791) | 0.500 (2/4, 95% upper 0.902) | 0.684 (13/19, 95% upper 0.853) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5055 | 0.698 (30/43, 95% upper 0.811) | 0.500 (2/4, 95% upper 0.902) | 0.684 (13/19, 95% upper 0.853) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5100 | 0.721 (31/43, 95% upper 0.830) | 0.500 (2/4, 95% upper 0.902) | 0.684 (13/19, 95% upper 0.853) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5261 | 0.721 (31/43, 95% upper 0.830) | 0.250 (1/4, 95% upper 0.751) | 0.789 (15/19, 95% upper 0.925) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5410 | 0.744 (32/43, 95% upper 0.849) | 0.250 (1/4, 95% upper 0.751) | 0.789 (15/19, 95% upper 0.925) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5544 | 0.744 (32/43, 95% upper 0.849) | 0.000 (0/4, 95% upper 0.527) | 0.789 (15/19, 95% upper 0.925) | 0.000 (0/4, 95% upper 0.527) | strict |
| 0.5699 | 0.767 (33/43, 95% upper 0.868) | 0.000 (0/4, 95% upper 0.527) | 0.789 (15/19, 95% upper 0.925) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5818 | 0.791 (34/43, 95% upper 0.886) | 0.000 (0/4, 95% upper 0.527) | 0.789 (15/19, 95% upper 0.925) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.5953 | 0.814 (35/43, 95% upper 0.904) | 0.000 (0/4, 95% upper 0.527) | 0.789 (15/19, 95% upper 0.925) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6072 | 0.837 (36/43, 95% upper 0.921) | 0.000 (0/4, 95% upper 0.527) | 0.789 (15/19, 95% upper 0.925) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6158 | 0.860 (37/43, 95% upper 0.937) | 0.000 (0/4, 95% upper 0.527) | 0.842 (16/19, 95% upper 0.956) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6268 | 0.884 (38/43, 95% upper 0.953) | 0.000 (0/4, 95% upper 0.527) | 0.842 (16/19, 95% upper 0.956) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6487 | 0.907 (39/43, 95% upper 0.968) | 0.000 (0/4, 95% upper 0.527) | 0.842 (16/19, 95% upper 0.956) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.6853 | 0.930 (40/43, 95% upper 0.981) | 0.000 (0/4, 95% upper 0.527) | 0.895 (17/19, 95% upper 0.981) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.7149 | 0.953 (41/43, 95% upper 0.992) | 0.000 (0/4, 95% upper 0.527) | 0.895 (17/19, 95% upper 0.981) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.7331 | 0.977 (42/43, 95% upper 0.999) | 0.000 (0/4, 95% upper 0.527) | 0.895 (17/19, 95% upper 0.981) | 0.000 (0/4, 95% upper 0.527) |  |
| 0.7440 | 1.000 (43/43, 95% upper 1.000) | 0.000 (0/4, 95% upper 0.527) | 0.895 (17/19, 95% upper 0.981) | 0.000 (0/4, 95% upper 0.527) |  |

## Excluded traces

- no_query_language: 9

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
| calibrated | 0.1306 | 132 / 24 | 0.030 (0.068) | 0.417 | 0 |
