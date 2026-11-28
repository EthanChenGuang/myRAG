# Phase 04.2 gates

Verdict: **FAIL** over off_identity, diversity, identifier, table, versions, dictionary, stem_it, refusal_mode_cells. Noise band: max(3 x spread, 0.02).

| Gate | Decision | Verdict | Offenders |
| --- | --- | --- | --- |
| off_identity | D-37 | PASS | 0 |
| diversity | D-22 | FAIL | 1 |
| identifier | D-32 | PASS | 0 |
| table | ROADMAP-4.2-SC5 | PASS | 0 |
| versions | ROADMAP-4.2-SC3 | PASS | 0 |
| dictionary | D-09 | PASS | 0 |

## off_identity (D-37)

Runs: off-prechunked, off-ingest, v2-default-phase42-off, v2-default.

| Number | Value |
| --- | --- |
| off-ingest.nonzero_cells | 0 |
| off-prechunked.nonzero_cells | 0 |
| v2-default-phase42-off.nonzero_cells | 0 |

## diversity (D-22)

Runs: v2-diversity-collapse, v2-diversity-mmr, v2-default.

| Number | Value |
| --- | --- |
| redundancy_measure_version | 2 |
| v2-diversity-collapse.intent_coverage | 1.0000 |
| v2-diversity-collapse.items | 6 |
| v2-diversity-collapse.max_redundancy_over_limit | 0.0000 |
| v2-diversity-mmr.intent_coverage | 1.0000 |
| v2-diversity-mmr.items | 6 |
| v2-diversity-mmr.max_redundancy_over_limit | 0.0000 |

Offenders:
- v2-diversity-mmr: category:colloquial:mrr dropped beyond the noise band (0.3344 < 0.3352, v2-default 0.3552)

## identifier (D-32)

Runs: v2-identifier-on, v2-default.

| Number | Value |
| --- | --- |
| descriptive.mrr | 0.6189 |
| descriptive.mrr.reference | 0.6189 |
| descriptive.recall_at_10 | 0.7077 |
| descriptive.recall_at_10.reference | 0.7077 |
| descriptive.recall_at_5 | 0.6967 |
| descriptive.recall_at_5.reference | 0.6967 |
| descriptive_items | 220 |
| identifier_precision | 1.0000 |
| identifier_precision_n | 12 |
| items | 12 |
| near_miss_leakage | 0.0000 |
| near_miss_leakage_n | 12 |

## table (ROADMAP-4.2-SC5)

Runs: v2-table-lookup-on, v2-default.

| Number | Value |
| --- | --- |
| items | 3 |
| items_with_leg | 3 |

## versions (ROADMAP-4.2-SC3)

Runs: v2-version-scope-on, v2-default.

| Number | Value |
| --- | --- |
| items | 3 |
| superseded_kept | 3 |

## dictionary (D-09)

Runs: v2-lexical-dict-on, v2-default.

## Decisions

### stem_it (D-10): `keep_off`

| Number | Value |
| --- | --- |
| band | 0.0200 |
| dropped_slices | 0 |
| gain | -0.0061 |
| on | 0.7561 |
| reference | 0.7622 |

- language:it recall_at_10 gain -0.0061 does not exceed the noise band 0.0200
- below min_gate_n (reported, not gated): category:duplicate_flood:recall_at_5 below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.9167 vs threshold 0.9800, reference 1.0000, against v2-default
- below min_gate_n (reported, not gated): category:duplicate_flood:recall_at_10 below_min_n (n=6 < min_gate_n=10, reported, not gated): 0.9167 vs threshold 0.9800, reference 1.0000, against v2-default

### refusal_mode_cells (D-23, D-24): `keep`

| Number | Value |
| --- | --- |
| bases_skipped_insufficient_data | 1 |
| mode_cells_evaluated | 15 |

- cohere|fake-quality-v1|it|cross|balanced: not calibrated on dev (no_separation)
- cohere|fake-quality-v1|it|cross|flexible: not calibrated on dev (no_separation)
- cohere|fake-quality-v1|it|cross|strict: base cell has no threshold to compare
- cohere|fake-quality-v1|it|same|balanced: holdout check not passed (failed_holdout)
- cohere|fake-quality-v1|it|same|flexible: holdout check not passed (failed_holdout)
- cohere|fake-quality-v1|zh|same|balanced: not calibrated on dev (no_separation)
- cohere|fake-quality-v1|zh|same|flexible: not calibrated on dev (no_separation)
- cohere|fake-quality-v1|zh|same|strict: base cell has no threshold to compare


## Report-only

- ndcg_at_context_k: reported per run, never gated (D-07)
- ttft: reported per run by cache state, never gated (D-26)

## Runs

| Run | Mode | Recall@10 | MRR | Run config hash |
| --- | --- | --- | --- | --- |
| off-prechunked | prechunked | 0.6854 | 0.6497 | `de2f6d652ba6` |
| off-ingest | ingest | 0.7259 | 0.6523 | `51825c3f75a6` |
| v2-default | prechunked | 0.7271 | 0.6455 | `97b38e1e65ba` |
| v2-default-phase42-off | prechunked | 0.7271 | 0.6455 | `77bc577114c8` |
| v2-diversity-collapse | prechunked | 0.7271 | 0.6455 | `430384e34501` |
| v2-diversity-mmr | prechunked | 0.7271 | 0.6441 | `513a0a947a46` |
| v2-identifier-on | prechunked | 0.7979 | 0.7019 | `91fa083e546e` |
| v2-table-lookup-on | prechunked | 0.7271 | 0.6455 | `80142403b02b` |
| v2-version-scope-on | prechunked | 0.7333 | 0.6455 | `6647308da5c6` |
| v2-lexical-dict-on | prechunked | 0.7271 | 0.6477 | `64a57e572d05` |
| v2-lexical-stem-it-on | prechunked | 0.7250 | 0.6475 | `6a525a3401d9` |

> Fixture corpus only: every gate, threshold and rule here was committed before any gated run (D-37, pre-registration). Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare.
