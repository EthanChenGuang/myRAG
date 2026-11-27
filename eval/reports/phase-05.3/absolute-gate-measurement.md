# Absolute gate measurement

Would-be exit code: the absolute gate in enforce mode (0 pass, 11 ceiling or floor, 12 composition or stale share).
Gate exit: the exit code of the gate run itself (noise band; absolute gate in report mode). The wall time of each run is in seconds.
Mode (stage after): enforce when the would-be exit code is 0, report otherwise (O-1). A tier with report-only checks is enforce when the exit code without those checks is 0; its listed ceilings are reported, every other check gates.

| Tier | Stage | Mode | Out | False-answer rate | False-refusal rate | Composition | Would-be exit code | Gate exit | Wall time (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| negative | after | report | eval/out/negative | 0.0000 | 0.3200 | passed | 11 | 10 | 11.7 |
| negative | before | - | eval/out/negative | 0.3200 | 0.3357 | failed | 12 | 10 | 13.9 |
| negative-degrade | after | report | eval/out/negative-degrade | 0.0000 | 0.6333 | passed | 11 | 10 | 11.6 |
| negative-degrade | before | - | eval/out/negative-degrade | 0.2800 | 0.6364 | failed | 12 | 10 | 15.0 |
| nightly-live | after | report | - | n/a | n/a | - | - | - | - |
| smoke | after | enforce | eval/out/smoke | 0.0000 | 0.2373 | passed | 11 | 0 | 45.3 |
| smoke | before | - | eval/out/smoke | 0.3200 | 0.3357 | failed | 12 | 0 | 13.5 |
| smoke-ingest | after | enforce | eval/out/smoke-ingest | 0.0000 | 0.1848 | passed | 0 | 0 | 22.0 |
| smoke-ingest | before | - | eval/out/smoke-ingest | 0.4667 | 0.1921 | failed | 12 | 0 | 38.7 |
| smoke-legacy | after | enforce | eval/out/smoke-legacy | 0.0000 | 0.2373 | passed | 11 | 0 | 45.8 |
| smoke-legacy | before | - | eval/out/smoke-legacy | 0.3200 | 0.3357 | failed | 12 | 0 | 15.1 |
| smoke-legacy-ingest | after | enforce | eval/out/smoke-legacy-ingest | 0.0000 | 0.1848 | passed | 0 | 0 | 24.6 |
| smoke-legacy-ingest | before | - | eval/out/smoke-legacy-ingest | 0.4667 | 0.1921 | failed | 12 | 0 | 34.2 |
| smoke-sec | after | enforce | eval/out/smoke-sec | 0.0000 | 0.2373 | passed | 11 | 0 | 45.8 |
| smoke-sec | before | - | eval/out/smoke-sec | 0.3200 | 0.3357 | failed | 12 | 0 | 15.3 |

## Failed checks per tier

- negative (after): false_refusal_rate_exceeded
- negative (before): no_answer_share_below_min, false_answer_rate_exceeded, false_refusal_rate_exceeded
- negative-degrade (after): false_refusal_rate_exceeded
- negative-degrade (before): no_answer_share_below_min, false_answer_rate_exceeded, false_refusal_rate_exceeded
- nightly-live (after): none
- smoke (after): false_refusal_rate_exceeded
- smoke (before): no_answer_share_below_min, false_answer_rate_exceeded, false_refusal_rate_exceeded
- smoke-ingest (after): none
- smoke-ingest (before): no_answer_share_below_min, false_answer_rate_exceeded
- smoke-legacy (after): false_refusal_rate_exceeded
- smoke-legacy (before): no_answer_share_below_min, false_answer_rate_exceeded, false_refusal_rate_exceeded
- smoke-legacy-ingest (after): none
- smoke-legacy-ingest (before): no_answer_share_below_min, false_answer_rate_exceeded
- smoke-sec (after): false_refusal_rate_exceeded
- smoke-sec (before): no_answer_share_below_min, false_answer_rate_exceeded, false_refusal_rate_exceeded

## Tiers with report-only checks (stage after)

- smoke: enforce; report-only checks: false_refusal_rate (exit without them 0).
- smoke-legacy: enforce; report-only checks: false_refusal_rate (exit without them 0).
- smoke-sec: enforce; report-only checks: false_refusal_rate (exit without them 0).

## Report-only tiers (stage after)

- negative: report-only; failing: false_refusal_rate (overall, language:en, language:zh).
- negative-degrade: report-only; failing: false_refusal_rate (overall, language:en, language:it, language:zh).
- nightly-live: report-only; not measured (not_measured_no_keys).
