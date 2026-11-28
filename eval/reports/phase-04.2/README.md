# Phase 04.2 gates

Verdict: **FAIL** over off_identity, diversity, identifier, table, versions, dictionary, stem_it, refusal_mode_cells. Noise band: max(3 x spread, 0.02).

| Gate | Decision | Verdict | Offenders |
| --- | --- | --- | --- |
| off_identity | D-37 | PASS | 0 |
| diversity | D-22 | FAIL | 2 |
| identifier | D-32 | FAIL | 2 |
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
- v2-diversity-mmr: category:scanned:recall_at_10 dropped beyond the noise band (0.7500 < 0.9800, v2-default 1.0000)
- v2-diversity-mmr: category:scanned:mrr dropped beyond the noise band (0.7500 < 0.7657, v2-default 0.7857)

## identifier (D-32)

Runs: v2-identifier-on, v2-default.

| Number | Value |
| --- | --- |
| descriptive.mrr | 0.6293 |
| descriptive.mrr.reference | 0.6293 |
| descriptive.recall_at_10 | 0.7194 |
| descriptive.recall_at_10.reference | 0.7194 |
| descriptive.recall_at_5 | 0.7083 |
| descriptive.recall_at_5.reference | 0.7083 |
| descriptive_items | 217 |
| identifier_precision | 1.0000 |
| identifier_precision_n | 12 |
| items | 12 |
| near_miss_leakage | 0.0000 |
| near_miss_leakage_n | 12 |

Offenders:
- category:scanned:recall_at_10 dropped beyond the noise band (0.7500 < 0.9800, v2-default 1.0000)
- category:scanned:mrr dropped beyond the noise band (0.7500 < 0.7657, v2-default 0.7857)

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
| dropped_slices | 2 |
| gain | -0.0061 |
| on | 0.7561 |
| reference | 0.7622 |

- category:duplicate_flood:recall_at_5 dropped beyond the noise band (0.9167 < 0.9800, v2-default 1.0000)
- category:duplicate_flood:recall_at_10 dropped beyond the noise band (0.9167 < 0.9800, v2-default 1.0000)
- language:it recall_at_10 gain -0.0061 does not exceed the noise band 0.0200

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
| off-prechunked | prechunked | 0.6883 | 0.6524 | `a70ec4aba61f` |
| off-ingest | ingest | 0.7281 | 0.6543 | `804eb98ece30` |
| v2-default | prechunked | 0.7301 | 0.6482 | `99aef56d7db3` |
| v2-default-phase42-off | prechunked | 0.7301 | 0.6482 | `7831c4c93f7d` |
| v2-diversity-collapse | prechunked | 0.7301 | 0.6482 | `939b03c160a6` |
| v2-diversity-mmr | prechunked | 0.7259 | 0.6464 | `92c5806ebbec` |
| v2-identifier-on | prechunked | 0.7929 | 0.7089 | `4fe8b71568fd` |
| v2-table-lookup-on | prechunked | 0.7301 | 0.6482 | `221f31e62c64` |
| v2-version-scope-on | prechunked | 0.7364 | 0.6482 | `e23403b19742` |
| v2-lexical-dict-on | prechunked | 0.7301 | 0.6505 | `49f78697d19c` |
| v2-lexical-stem-it-on | prechunked | 0.7280 | 0.6502 | `233d067c0d98` |

> Fixture corpus only: every gate, threshold and rule here was committed before any gated run (D-37, pre-registration). Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare.
