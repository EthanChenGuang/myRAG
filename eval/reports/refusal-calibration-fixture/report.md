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
| cohere\|fake-quality-v1\|en\|same | calibrated | 0.1497 | 27 / 7 | 0.000 (0.105) | 0.429 | 7 / 1 | 0.143 (0.521) | 0.000 | 1 |
| cohere\|fake-quality-v1\|it\|cross | insufficient_data | - | 4 / 1 | 0.000 (0.527) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|it\|same | calibrated | 0.0785 | 18 / 5 | 0.000 (0.153) | 0.200 | 10 / 4 | 0.100 (0.394) | 0.000 | 1 |
| cohere\|fake-quality-v1\|zh\|cross | insufficient_data | - | 3 / 3 | 0.000 (0.632) | 0.000 | - | - | - | 0 |
| cohere\|fake-quality-v1\|zh\|same | calibrated | 0.0446 | 28 / 4 | 0.000 (0.101) | 0.250 | 9 / 3 | 0.000 (0.283) | 0.333 | 1 |

A point estimate at or below target is not evidence until its 95% upper bound is. Only `calibrated` cells are applied; every other status never refuses.

## Excluded traces

- no_query_language: 5

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
