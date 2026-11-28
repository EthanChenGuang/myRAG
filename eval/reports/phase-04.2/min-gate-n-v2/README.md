# Phase 04.2 gates

Verdict: **PASS** over off_identity, diversity, identifier, table, versions, dictionary, stem_it, refusal_mode_cells. Noise band: max(3 x spread, 0.02).

| Gate | Decision | Verdict | Offenders |
| --- | --- | --- | --- |
| off_identity | D-37 | PASS | 0 |
| diversity | D-22 | PASS | 0 |
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

Below min_gate_n (reported, not gated):
- v2-diversity-mmr: category:scanned:recall_at_10 below_min_n (n=4 < min_gate_n=10, reported, not gated): 0.7500 vs threshold 0.9800, reference 1.0000, against v2-default
- v2-diversity-mmr: category:scanned:mrr below_min_n (n=4 < min_gate_n=10, reported, not gated): 0.7500 vs threshold 0.7657, reference 0.7857, against v2-default

## identifier (D-32)

Runs: v2-identifier-on, v2-default.

| Number | Value |
| --- | --- |
| descriptive.mrr | 0.6251 |
| descriptive.mrr.reference | 0.6251 |
| descriptive.recall_at_10 | 0.7206 |
| descriptive.recall_at_10.reference | 0.7206 |
| descriptive.recall_at_5 | 0.7088 |
| descriptive.recall_at_5.reference | 0.7088 |
| descriptive_items | 196 |
| identifier_precision | 1.0000 |
| identifier_precision_n | 12 |
| items | 12 |
| near_miss_leakage | 0.0000 |
| near_miss_leakage_n | 12 |

Below min_gate_n (reported, not gated):
- category:scanned:recall_at_10 below_min_n (n=4 < min_gate_n=10, reported, not gated): 0.7500 vs threshold 0.9800, reference 1.0000, against v2-default
- category:scanned:mrr below_min_n (n=4 < min_gate_n=10, reported, not gated): 0.7500 vs threshold 0.7657, reference 0.7857, against v2-default

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
| off-prechunked | prechunked | 0.6843 | 0.6480 | `3722c7d46e50` |
| off-ingest | ingest | 0.7256 | 0.6512 | `4ba58c7502f7` |
| v2-default | prechunked | 0.7267 | 0.6437 | `8746ef079468` |
| v2-default-phase42-off | prechunked | 0.7267 | 0.6437 | `37ef6abd0da7` |
| v2-diversity-collapse | prechunked | 0.7267 | 0.6437 | `37f814a6f69b` |
| v2-diversity-mmr | prechunked | 0.7225 | 0.6419 | `b68e74e8ddb8` |
| v2-identifier-on | prechunked | 0.7903 | 0.7052 | `d9900fc015c7` |
| v2-table-lookup-on | prechunked | 0.7267 | 0.6437 | `c8fddd2498ba` |
| v2-version-scope-on | prechunked | 0.7331 | 0.6437 | `e8240f6cf70b` |
| v2-lexical-dict-on | prechunked | 0.7267 | 0.6460 | `26551114516d` |
| v2-lexical-stem-it-on | prechunked | 0.7246 | 0.6458 | `a24313602d56` |

> Fixture corpus only: every gate, threshold and rule here was committed before any gated run (D-37, pre-registration). Reference runs are single fixture runs, so the noise band against a reference is the noise floor (spread 0), as in phase_compare.
