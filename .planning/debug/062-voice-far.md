---
status: resolved
trigger: "both q62 voice eval arms exit 11: absolute gate false_answer_rate 0.8431 > 0.05 (en 0.85, it 0.875, zh 0.80); 06.2-41 recorded exit 0"
found_by: 06.2-30 executor
root_cause_commit: c0ff2374 (quick-53 gap 3), reached the trains through 4f6d19c7
classification: gate config mismatch (not a voice regression, not fixture or baseline drift)
fix_applied: false (the fix is a gate-mode decision; D-37)
---

# Debug: q62 voice arms fail the absolute gate (exit 11)

## Symptom
`npm run test-rag -- --run-config eval/config/runs/q62-voice-no-translate.json` (and `q62-voice-translate.json`) exit 11 at
afba6b2a (exec/06.2-30) and e8ddc297. The relative gate against `eval/baselines/fixture-voice-baseline.json` passes ("Offenders: None").
The absolute gate fails on `false_answer_rate` only.

## Evidence
Same fixture run, prechunked, both commits:

| commit | overall metrics | absolute gate line | exit |
| --- | --- | --- | --- |
| 0df877f5 (06.2-41 tip) | recall@5 0.881, mrr 0.792, correct_refusal 0.157 (n=51), false_refusal 0.008 | `absolute gate mode report` ... `FAIL (mode report, report only: exit code unchanged)`, false_answer_rate 0.8431 | 0 |
| afba6b2a (exec/06.2-30) | identical | `absolute gate mode enforce with report-only false_refusal_rate` ... `FAIL (mode enforce)`, false_answer_rate 0.8431 | 11 |

- The metrics are identical to four decimals. The committed voice baseline also holds `correct_refusal_rate` 0.1568627 (n=51)
  both at f8b5467e (06.2-41 re-record) and at HEAD. Voice retrieval has not changed.
- `false_answer_rate` was already 0.8431 at 06.2-41. It was printed then, but the gate ran in `report` mode, so the exit code stayed 0.
- For a retrieval-only report, `absolute_gate._ceiling_metric` derives `false_answer_rate` as `1 - correct_refusal_rate`. The voice
  profile refuses 8 of 51 no-answer items; that is the voice similarity-floor behaviour 06.2-41 already flagged for 06.2-30.

## Root cause
`resolveGatesMode` (`eval/harness/gate-mode.mts`) maps every in-process prechunked run to the measured tier `smoke`, with no check of
the entry profile. A voice entry run (`entry_profile: voice`) therefore takes the `smoke` tier's mode. That tier is measured on the
text-chat answer path; no voice tier is measured in `eval/reports/phase-05.3/absolute-gate-measurement.json`.

quick-53 gap 3 (`c0ff2374`, "false_answer_rate gates the prechunked tiers, false_refusal_rate stays report-only") re-measured `smoke`,
`smoke-legacy` and `smoke-sec` from `report` to `enforce` with `report_only_checks: ["false_refusal_rate"]`. From then on the voice
arms inherit `enforce`, and the text answer-level `false_answer_rate` ceiling (0.05) gates a retrieval-only voice report. The commit
reached the trains through the parentless merge `4f6d19c7` (train-41), which is why a plain bisect from 06.2-41 does not find it; the
original commit is on `origin/exec/quick-53-gate-monitor`.

The previous executor's hypothesis is confirmed: the voice entry measures retrieval only, and the text absolute threshold is applied to it.
CI is not affected: pr-smoke runs no voice entry arm.

## Recommended fix (owner or orchestrator decision; not applied)
Any fix changes which gate mode applies to the voice entry, so it is a gate definition under D-37. Options:
1. Make `resolveGatesMode` return no measured tier for `entryProfile === 'voice'` and have the voice arms run with
   `--gates-mode report` (restores the 06.2-41 behaviour; voice stays gated by the relative noise band against its own baseline).
   Preferred: confined to `eval/harness/run-smoke.mts` / `gate-mode.mts`, changes no threshold and no metric.
2. Measure a separate `smoke-voice` tier with `absolute_gate measure` and record the mode it earns (it would record `report`, or
   `enforce` with `false_answer_rate` report-only).
3. Keep enforce and treat 0.84 as a real voice finding for 06.2-30 (the voice similarity floor), to be fixed in retrieval, not in the gate.

Meanwhile 06.2-30 can run both voice arms with `--gates-mode report` explicitly, which is what 06.2-41 effectively ran.
