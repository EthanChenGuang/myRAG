# Phase 03.3 gates: FAIL

- Gates file: `eval/config/phase33-gates.json` (sha256 7b7784034cc5, last commit a55d8d7269c3, 1 commit(s))

## Requirements

| Requirement | Gates | Verdict |
|---|---|---|
| TPL-01 | variant | pass |
| TPL-02 | boilerplate_share | pass |
| TPL-03 | named_document | pass |
| TPL-06 | named_document | pass |
| TPL-07 | quantity | pass |
| TPL-09 | off_identity, named_document, no_other_slice_drop | fail |

## Gates

| Gate | Decisions | Verdict | Measures | Offenders |
|---|---|---|---|---|
| off_identity | D-36 | pass | - | - |
| boilerplate_share | D-13, D-15 | pass | share 0.0026; control_share 0.2504; chunks 238.0000; control_chunks 174.0000 | - |
| named_document | D-28, D-29, D-30 | pass | dev_items 18.0000; named_document_recall 1.0000; wrong_document_at_1 0.0000; cited_asked_document 1.0000 | - |
| variant | D-19 | pass | dev_items 13.0000; defined 13.0000; variant_correct 1.0000 | - |
| quantity | D-31 | pass | dev_items 16.0000; defined 16.0000; quantity_matched 1.0000 | - |
| no_other_slice_drop | D-36 | fail | - | tpl-recommended-ingest |

## Alignment

- no_other_slice_drop: tpl-recommended-ingest: corpus_sha256 of tpl-v2-off-ingest aligned on the run's (9b22b6cdb5c7)

## Report-only

| Measure | Run | Reference | Values |
|---|---|---|---|
| attribute_filter_fallback_rate | tpl-recommended-ingest | - | attribute_filter_fallback_rate 0.0000; n 18.0000 |
| attribute_filter_fallback_rate | tpl-only-filter-hard-ingest | - | attribute_filter_fallback_rate 0.0000; n 18.0000 |
| attribute_filter_fallback_rate | tpl-only-filter-soft-ingest | - | attribute_filter_fallback_rate n/a; n 0.0000 |
| retrieval_unchanged | tpl-recommended-prechunked | tpl-v2-off-prechunked | unchanged 0.0000; moved_cells 4.0000 |
| retrieval_unchanged | tpl-recommended-ingest | tpl-v2-off-ingest | unchanged 0.0000; moved_cells 4.0000 |
| single_switch | tpl-only-boilerplate-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-boilerplate-ingest | tpl-v2-off-ingest | named_document_recall 0.7778; wrong_document_at_1 0.2778; variant_accuracy 0.6154; quantity_match_rate 0.1250; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-section-rules-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-section-rules-ingest | tpl-v2-off-ingest | named_document_recall 0.7222; wrong_document_at_1 0.6111; variant_accuracy 0.6923; quantity_match_rate 0.1250; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-attributes-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-attributes-ingest | tpl-v2-off-ingest | named_document_recall 0.8333; wrong_document_at_1 0.5556; variant_accuracy 0.6154; quantity_match_rate 0.0625; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-header-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-header-ingest | tpl-v2-off-ingest | named_document_recall 1.0000; wrong_document_at_1 0.0000; variant_accuracy 0.6154; quantity_match_rate 0.0625; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-filter-hard-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-filter-hard-ingest | tpl-v2-off-ingest | named_document_recall 1.0000; wrong_document_at_1 0.0000; variant_accuracy 0.6154; quantity_match_rate 0.0625; attribute_filter_fallback_rate 0.0000 |
| single_switch | tpl-only-filter-soft-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-filter-soft-ingest | tpl-v2-off-ingest | named_document_recall 1.0000; wrong_document_at_1 0.0000; variant_accuracy 0.6154; quantity_match_rate 0.0625; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-quantity-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-quantity-ingest | tpl-v2-off-ingest | named_document_recall 0.8333; wrong_document_at_1 0.5556; variant_accuracy 0.6154; quantity_match_rate 1.0000; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-identifier-feed-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-identifier-feed-ingest | tpl-v2-off-ingest | named_document_recall 0.8333; wrong_document_at_1 0.5556; variant_accuracy 0.6154; quantity_match_rate 0.0625; attribute_filter_fallback_rate n/a |
