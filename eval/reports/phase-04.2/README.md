# Phase 04.2 gates

Verdict: **FAIL** over off_identity, diversity, identifier, table, versions, dictionary, stem_it, refusal_mode_cells. Noise band: max(3 x spread, 0.02).

| Gate | Decision | Verdict | Offenders |
| --- | --- | --- | --- |
| off_identity | D-37 | PASS | 0 |
| diversity | D-22 | PASS | 0 |
| identifier | D-32 | FAIL | 11 |
| table | ROADMAP-4.2-SC3 | PASS | 0 |
| versions | ROADMAP-4.2-SC5 | FAIL | 6 |
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
| v2-diversity-collapse.intent_coverage | 1.0000 |
| v2-diversity-collapse.items | 6 |
| v2-diversity-collapse.max_redundancy_over_limit | 0.0000 |
| v2-diversity-mmr.intent_coverage | 1.0000 |
| v2-diversity-mmr.items | 6 |
| v2-diversity-mmr.max_redundancy_over_limit | 0.0000 |

## identifier (D-32)

Runs: v2-identifier-on, v2-default.

| Number | Value |
| --- | --- |
| descriptive.mrr | 0.6191 |
| descriptive.mrr.reference | 0.6191 |
| descriptive.recall_at_10 | 0.6976 |
| descriptive.recall_at_10.reference | 0.6976 |
| descriptive.recall_at_5 | 0.6815 |
| descriptive.recall_at_5.reference | 0.6815 |
| descriptive_items | 141 |
| identifier_precision | 0.7500 |
| identifier_precision_n | 4 |
| items | 12 |
| near_miss_leakage | 0.0000 |
| near_miss_leakage_n | 4 |

Offenders:
- category:identifier_near_miss identifier_precision measured on 4 of 12 item(s)
- category:identifier_near_miss near_miss_leakage measured on 4 of 12 item(s)
- category:cross_lingual:recall_at_5 dropped beyond the noise band (0.3810 < 0.4086, v2-default 0.4286)
- category:cross_lingual:recall_at_10 dropped beyond the noise band (0.3810 < 0.4086, v2-default 0.4286)
- category:cross_lingual:mrr dropped beyond the noise band (0.3810 < 0.4086, v2-default 0.4286)
- category:table:recall_at_5 dropped beyond the noise band (0.3636 < 0.4345, v2-default 0.4545)
- category:table:recall_at_10 dropped beyond the noise band (0.3636 < 0.4345, v2-default 0.4545)
- category:table:mrr dropped beyond the noise band (0.3182 < 0.3891, v2-default 0.4091)
- language:it:recall_at_5 dropped beyond the noise band (0.6864 < 0.7003, v2-default 0.7203)
- language:it:recall_at_10 dropped beyond the noise band (0.7034 < 0.7173, v2-default 0.7373)
- language:it:mrr dropped beyond the noise band (0.6136 < 0.6190, v2-default 0.6390)

## table (ROADMAP-4.2-SC3)

Runs: v2-table-lookup-on, v2-default.

| Number | Value |
| --- | --- |
| items | 3 |
| items_with_leg | 3 |

## versions (ROADMAP-4.2-SC5)

Runs: v2-version-scope-on, v2-default.

| Number | Value |
| --- | --- |
| items | 3 |
| superseded_kept | 0 |

Offenders:
- en-general-007: an evidence group has no kept chunk
- en-general-007: 0 superseded chunk(s) kept, fewer than 1
- zh-general-008: an evidence group has no kept chunk
- zh-general-008: 0 superseded chunk(s) kept, fewer than 1
- it-general-007: an evidence group has no kept chunk
- it-general-007: 0 superseded chunk(s) kept, fewer than 1

## dictionary (D-09)

Runs: v2-lexical-dict-on, v2-default.

## Decisions

### stem_it (D-10): `keep_off`

| Number | Value |
| --- | --- |
| band | 0.0200 |
| dropped_slices | 0 |
| gain | 0.0000 |
| on | 0.7373 |
| reference | 0.7373 |

- language:it recall_at_10 gain 0.0000 does not exceed the noise band 0.0200

### refusal_mode_cells (D-23, D-24): `commit`

| Number | Value |
| --- | --- |
| bases_skipped_insufficient_data | 3 |
| mode_cells_evaluated | 9 |

- every condition of the rule holds


## Report-only

- ndcg_at_context_k: reported per run, never gated (D-07)
- ttft: reported per run by cache state, never gated (D-26)

## Runs

| Run | Mode | Recall@10 | MRR | Run config hash |
| --- | --- | --- | --- | --- |
| off-prechunked | prechunked | 0.6214 | 0.6031 | `17350e6cd947` |
| off-ingest | ingest | 0.7512 | 0.6707 | `ac8f87d45153` |
| v2-default | prechunked | 0.6792 | 0.6085 | `bd2514e85db8` |
| v2-default-phase42-off | prechunked | 0.6792 | 0.6085 | `8dccac43f6fc` |
| v2-diversity-collapse | prechunked | 0.6792 | 0.6085 | `b581b683b475` |
| v2-diversity-mmr | prechunked | 0.6792 | 0.6064 | `46bb67866dcc` |
| v2-identifier-on | prechunked | 0.6676 | 0.5969 | `51c381e27231` |
| v2-table-lookup-on | prechunked | 0.6792 | 0.6085 | `4c542c55241a` |
| v2-version-scope-on | prechunked | 0.6792 | 0.6085 | `fab385fa4103` |
| v2-lexical-dict-on | prechunked | 0.6792 | 0.6117 | `5bafb006d90e` |
| v2-lexical-stem-it-on | prechunked | 0.6792 | 0.6085 | `20c3313beb97` |

> Fixture corpus only: every gate, threshold and rule here was committed before any gated run (D-37, pre-registration). Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare.
