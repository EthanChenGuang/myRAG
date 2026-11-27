# TPL-09 header A/B check: reopen_d26

- Decision: D-26; requirement TPL-09; population fixture
- Reasons: target_slice_drop
- Excluded categories: templated_collection; noise floor 0.0200
- Tiers: on smoke, off smoke; gate population: on all, off all

| Slice | Metric | Header on | Header off | n on | n off | Threshold | Dropped | Paired mean | 95% interval | Worsened | Improved |
|---|---|---|---|---|---|---|---|---|---|---|---|
| category:cache_near_miss | recall_at_5 | 0.8182 | 0.9091 | 11 | 11 | 0.8891 | True | -0.0909 | -0.2727 to 0.0000 | 1 | 0 |

## Other slice drops

- none

Rule: holds keeps D-26 (header in the dense embedding text). reopen_d26 reopens D-26: the header becomes lexical-only, and the
phase gate is re-run. missing_data closes nothing.
