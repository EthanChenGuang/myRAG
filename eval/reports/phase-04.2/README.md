# Phase 04.2 gates

Verdict: **FAIL** over off_identity, diversity, identifier, table, versions, dictionary, stem_it, refusal_mode_cells. Noise band: max(3 x spread, 0.02).

| Gate | Decision | Verdict | Offenders |
| --- | --- | --- | --- |
| off_identity | D-37 | PASS | 0 |
| diversity | D-22 | FAIL | 6 |
| identifier | D-32 | PASS | 0 |
| table | ROADMAP-4.2-SC3 | PASS | 0 |
| versions | ROADMAP-4.2-SC5 | PASS | 0 |
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

Offenders:
- v2-diversity-collapse: category:stale_version:recall_at_5 dropped beyond the noise band (0.8000 < 0.9800, v2-default 1.0000)
- v2-diversity-collapse: category:stale_version:recall_at_10 dropped beyond the noise band (0.8000 < 0.9800, v2-default 1.0000)
- v2-diversity-collapse: category:stale_version:mrr dropped beyond the noise band (0.4500 < 0.5300, v2-default 0.5500)
- v2-diversity-mmr: category:stale_version:recall_at_5 dropped beyond the noise band (0.8000 < 0.9800, v2-default 1.0000)
- v2-diversity-mmr: category:stale_version:recall_at_10 dropped beyond the noise band (0.8000 < 0.9800, v2-default 1.0000)
- v2-diversity-mmr: category:stale_version:mrr dropped beyond the noise band (0.4500 < 0.5300, v2-default 0.5500)

## identifier (D-32)

Runs: v2-identifier-on, v2-default.

| Number | Value |
| --- | --- |
| descriptive.mrr | 0.6110 |
| descriptive.mrr.reference | 0.6110 |
| descriptive.recall_at_10 | 0.7180 |
| descriptive.recall_at_10.reference | 0.7180 |
| descriptive.recall_at_5 | 0.7030 |
| descriptive.recall_at_5.reference | 0.7030 |
| descriptive_items | 159 |
| identifier_precision | 1.0000 |
| identifier_precision_n | 12 |
| items | 12 |
| near_miss_leakage | 0.0000 |
| near_miss_leakage_n | 12 |

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
| superseded_kept | 3 |

## dictionary (D-09)

Runs: v2-lexical-dict-on, v2-default.

## Decisions

### stem_it (D-10): `keep_off`

| Number | Value |
| --- | --- |
| band | 0.0200 |
| dropped_slices | 0 |
| gain | 0.0000 |
| on | 0.7721 |
| reference | 0.7721 |

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
| off-prechunked | prechunked | 0.6709 | 0.6399 | `44165cead4b3` |
| off-ingest | ingest | 0.7790 | 0.6924 | `a48430c9ab66` |
| v2-default | prechunked | 0.7211 | 0.6370 | `5db73f8fe8d5` |
| v2-default-phase42-off | prechunked | 0.7211 | 0.6370 | `d3c0e87071dd` |
| v2-diversity-collapse | prechunked | 0.7111 | 0.6320 | `2903b4e3b17f` |
| v2-diversity-mmr | prechunked | 0.7161 | 0.6308 | `9e2ad503708b` |
| v2-identifier-on | prechunked | 0.8015 | 0.7107 | `687faee57136` |
| v2-table-lookup-on | prechunked | 0.7211 | 0.6370 | `c24c3113c85e` |
| v2-version-scope-on | prechunked | 0.7286 | 0.6370 | `c864ed9e5b74` |
| v2-lexical-dict-on | prechunked | 0.7211 | 0.6398 | `e4a92e5ec75c` |
| v2-lexical-stem-it-on | prechunked | 0.7211 | 0.6395 | `045679f1f4d9` |

> Fixture corpus only: every gate, threshold and rule here was committed before any gated run (D-37, pre-registration). Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare.
