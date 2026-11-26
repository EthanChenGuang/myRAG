# Absolute gate measurement

Would-be exit code: the absolute gate in enforce mode (0 pass, 11 ceiling or floor, 12 composition or stale share).
Gate exit: the exit code of the gate run itself (noise band; absolute gate in report mode). The wall time of each run is in seconds.

| Tier | Stage | Out | False-answer rate | False-refusal rate | Composition | Would-be exit code | Gate exit | Wall time (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| negative | before | eval/out/negative | 0.3200 | 0.3357 | failed | 12 | 10 | 13.9 |
| negative-degrade | before | eval/out/negative-degrade | 0.2800 | 0.6364 | failed | 12 | 10 | 15.0 |
| smoke | before | eval/out/smoke | 0.3200 | 0.3357 | failed | 12 | 0 | 13.5 |
| smoke-ingest | before | eval/out/smoke-ingest | 0.4667 | 0.1921 | failed | 12 | 0 | 38.7 |
| smoke-legacy | before | eval/out/smoke-legacy | 0.3200 | 0.3357 | failed | 12 | 0 | 15.1 |
| smoke-legacy-ingest | before | eval/out/smoke-legacy-ingest | 0.4667 | 0.1921 | failed | 12 | 0 | 34.2 |
| smoke-sec | before | eval/out/smoke-sec | 0.3200 | 0.3357 | failed | 12 | 0 | 15.3 |

## Failed checks per tier

- negative (before): no_answer_share_below_min, false_answer_rate_exceeded, false_refusal_rate_exceeded
- negative-degrade (before): no_answer_share_below_min, false_answer_rate_exceeded, false_refusal_rate_exceeded
- smoke (before): no_answer_share_below_min, false_answer_rate_exceeded, false_refusal_rate_exceeded
- smoke-ingest (before): no_answer_share_below_min, false_answer_rate_exceeded
- smoke-legacy (before): no_answer_share_below_min, false_answer_rate_exceeded, false_refusal_rate_exceeded
- smoke-legacy-ingest (before): no_answer_share_below_min, false_answer_rate_exceeded
- smoke-sec (before): no_answer_share_below_min, false_answer_rate_exceeded, false_refusal_rate_exceeded
