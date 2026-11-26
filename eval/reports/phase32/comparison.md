# Phase 03.2 per-switch comparison

> wiring proof: fixture corpus, fixture embedder and fakes; the numbers prove each comparison runs end to end, not that a switch helps or hurts, so no recommendation is given

Result: PASS

## Notes

- Paired difference is the on-run minus the off-run, item by item; the band is the noise floor (0.02).
- Real observations come from the live checks of plan 03.2-53; a fixture comparison is never a reason to flip a default.
- No BGE-M3 arm: comparing that profile belongs to Phase 3.2.1 (plan 03.2.1-03), which runs after this phase.
- Ingestion-side arms rebuild the fixture tenant for each run, so the off and on runs differ only in the switch; the retrieval settings are the eval pin.
- The caption arm runs with the recorded fixture captioner, which returns the same caption in every language, so its fixture runs can only prove wiring.

## Arms

### language_aware_ingest

Switch: `RAG_LANGUAGE_AWARE_INGEST` off (off) against on (on); ingestion-side, fixture mode ingest. Result: PASS.

Judged on: language:.

Wiring proof only: no recommendation.

| Slice | Metric | n | Off | On | Paired diff | 95% CI | Beyond band | Direction |
|---|---|---:|---:|---:|---:|---|---|---|
| language:en | recall_at_5 | 96 | 0.7205 | 0.7205 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:en | recall_at_10 | 96 | 0.7205 | 0.7205 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:en | mrr | 96 | 0.6323 | 0.6323 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:en | correct_refusal_rate | 14 | 0.5714 | 0.5714 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:en | false_refusal_rate | 96 | 0.1875 | 0.1875 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:it | recall_at_5 | 77 | 0.6840 | 0.6840 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:it | recall_at_10 | 77 | 0.6840 | 0.6840 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:it | mrr | 77 | 0.5628 | 0.5628 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:it | correct_refusal_rate | 14 | 0.6429 | 0.6429 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:it | false_refusal_rate | 77 | 0.2208 | 0.2208 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:zh | recall_at_5 | 75 | 0.6756 | 0.6756 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:zh | recall_at_10 | 75 | 0.7289 | 0.7289 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:zh | mrr | 75 | 0.6338 | 0.6338 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:zh | correct_refusal_rate | 14 | 0.5714 | 0.5714 | 0.0000 | [0.0000, 0.0000] | no | none |
| language:zh | false_refusal_rate | 75 | 0.2267 | 0.2267 | 0.0000 | [0.0000, 0.0000] | no | none |

No gated slice dropped beyond the band.


### table_header_repeat

Switch: `RAG_TABLE_HEADER_REPEAT` profile (off) against always (on); ingestion-side, fixture mode ingest. Result: PASS.

Judged on: category:table, category:table_split.

Wiring proof only: no recommendation.

| Slice | Metric | n | Off | On | Paired diff | 95% CI | Beyond band | Direction |
|---|---|---:|---:|---:|---:|---|---|---|
| category:table | recall_at_5 | 17 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| category:table | recall_at_10 | 17 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| category:table | mrr | 17 | 0.8824 | 0.8824 | 0.0000 | [0.0000, 0.0000] | no | none |
| category:table | false_refusal_rate | 17 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| category:table_split | recall_at_5 | 15 | 0.9667 | 1.0000 | 0.0333 | [0.0000, 0.1000] | yes | up |
| category:table_split | recall_at_10 | 15 | 0.9667 | 1.0000 | 0.0333 | [0.0000, 0.1000] | yes | up |
| category:table_split | mrr | 15 | 0.8556 | 1.0000 | 0.1444 | [0.0333, 0.2778] | yes | up |
| category:table_split | false_refusal_rate | 15 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |

No gated slice dropped beyond the band.


### table_row_serialization

Switch: `RAG_TABLE_ROW_SERIALIZATION` false (off) against true (on); ingestion-side, fixture mode ingest. Result: PASS.

Judged on: category:table, category:table_split.

Wiring proof only: no recommendation.

| Slice | Metric | n | Off | On | Paired diff | 95% CI | Beyond band | Direction |
|---|---|---:|---:|---:|---:|---|---|---|
| category:table | recall_at_5 | 17 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| category:table | recall_at_10 | 17 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| category:table | mrr | 17 | 0.8824 | 0.8824 | 0.0000 | [0.0000, 0.0000] | no | none |
| category:table | false_refusal_rate | 17 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| category:table_split | recall_at_5 | 15 | 0.9667 | 0.9333 | -0.0333 | [-0.1000, 0.0000] | yes | down |
| category:table_split | recall_at_10 | 15 | 0.9667 | 0.9333 | -0.0333 | [-0.1000, 0.0000] | yes | down |
| category:table_split | mrr | 15 | 0.8556 | 0.9667 | 0.1111 | [0.0222, 0.2111] | yes | up |
| category:table_split | false_refusal_rate | 15 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |

No gated slice dropped beyond the band.


### caption_language

Switch: `RAG_CAPTION_LANGUAGE` en (off) against document (on); ingestion-side, fixture mode ingest. Result: PASS.

Judged on: image:.

Wiring proof only: no recommendation.

| Slice | Metric | n | Off | On | Paired diff | 95% CI | Beyond band | Direction |
|---|---|---:|---:|---:|---:|---|---|---|
| image:en | recall_at_5 | 1 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| image:en | recall_at_10 | 1 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| image:en | mrr | 1 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| image:en | false_refusal_rate | 1 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |

No gated slice dropped beyond the band.


### doc_translation

Switch: `RAG_DOC_TRANSLATION` off (off) against on (on); ingestion-side, fixture mode ingest, optional. Result: PASS.

Judged on: category:cross_lingual, pair:.

Wiring proof only: no recommendation.

| Slice | Metric | n | Off | On | Paired diff | 95% CI | Beyond band | Direction |
|---|---|---:|---:|---:|---:|---|---|---|
| category:cross_lingual | recall_at_5 | 36 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| category:cross_lingual | recall_at_10 | 36 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| category:cross_lingual | mrr | 36 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| category:cross_lingual | false_refusal_rate | 36 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:en->it | recall_at_5 | 5 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:en->it | recall_at_10 | 5 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:en->it | mrr | 5 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:en->it | false_refusal_rate | 5 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:en->zh | recall_at_5 | 9 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:en->zh | recall_at_10 | 9 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:en->zh | mrr | 9 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:en->zh | false_refusal_rate | 9 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:it->en | recall_at_5 | 5 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:it->en | recall_at_10 | 5 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:it->en | mrr | 5 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:it->en | false_refusal_rate | 5 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:it->zh | recall_at_5 | 9 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:it->zh | recall_at_10 | 9 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:it->zh | mrr | 9 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:it->zh | false_refusal_rate | 9 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:zh->en | recall_at_5 | 4 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:zh->en | recall_at_10 | 4 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:zh->en | mrr | 4 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:zh->en | false_refusal_rate | 4 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:zh->it | recall_at_5 | 4 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:zh->it | recall_at_10 | 4 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:zh->it | mrr | 4 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] | no | none |
| pair:zh->it | false_refusal_rate | 4 | 1.0000 | 1.0000 | 0.0000 | [0.0000, 0.0000] | no | none |

No gated slice dropped beyond the band.
