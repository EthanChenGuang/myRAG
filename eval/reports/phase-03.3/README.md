# Phase 03.3 gates: FAIL

- Gates file: `eval/config/phase33-gates.json` (sha256 7b7784034cc5, last commit a55d8d7269c3, 1 commit(s))

## Requirements

| Requirement | Gates | Verdict |
|---|---|---|
| TPL-01 | variant | fail |
| TPL-02 | boilerplate_share | pass |
| TPL-03 | named_document | fail |
| TPL-06 | named_document | fail |
| TPL-07 | quantity | fail |
| TPL-09 | off_identity, named_document, no_other_slice_drop | fail |

## Gates

| Gate | Decisions | Verdict | Measures | Offenders |
|---|---|---|---|---|
| off_identity | D-36 | pass | - | - |
| boilerplate_share | D-13, D-15 | pass | share 0.0000; control_share 0.2504; chunks 12.0000; control_chunks 174.0000 | - |
| named_document | D-28, D-29, D-30 | fail (missing_data) | dev_items 18.0000; named_document_recall 0.0000; wrong_document_at_1 n/a; cited_asked_document 0.0000 | - |
| variant | D-19 | fail | dev_items 13.0000; defined 13.0000; variant_correct 0.0000 | ingest-tpl-variant-en-01, ingest-tpl-variant-en-02, ingest-tpl-variant-en-03, ingest-tpl-variant-en-04, ingest-tpl-variant-it-01, ingest-tpl-variant-it-03, ingest-tpl-variant-it-04, ingest-tpl-variant-it-05, ingest-tpl-variant-it-06, ingest-tpl-variant-zh-01, ingest-tpl-variant-zh-02, ingest-tpl-variant-zh-03, ingest-tpl-variant-zh-05 |
| quantity | D-31 | fail | dev_items 16.0000; defined 16.0000; quantity_matched 0.0000 | ingest-tpl-quantity-en-01, ingest-tpl-quantity-en-02, ingest-tpl-quantity-en-03, ingest-tpl-quantity-en-04, ingest-tpl-quantity-en-05, ingest-tpl-quantity-it-01, ingest-tpl-quantity-it-02, ingest-tpl-quantity-it-03, ingest-tpl-quantity-it-04, ingest-tpl-quantity-it-05, ingest-tpl-quantity-it-06, ingest-tpl-quantity-zh-01, ingest-tpl-quantity-zh-02, ingest-tpl-quantity-zh-03, ingest-tpl-quantity-zh-05, ingest-tpl-quantity-zh-06 |
| no_other_slice_drop | D-36 | pass | - | - |

## Alignment

- no_other_slice_drop: tpl-recommended-ingest: corpus_sha256 of tpl-v2-off-ingest aligned on the run's (9b22b6cdb5c7)

## Report-only

| Measure | Run | Reference | Values |
|---|---|---|---|
| attribute_filter_fallback_rate | tpl-recommended-ingest | - | attribute_filter_fallback_rate 0.0000; n 18.0000 |
| attribute_filter_fallback_rate | tpl-only-filter-hard-ingest | - | attribute_filter_fallback_rate 0.0000; n 18.0000 |
| attribute_filter_fallback_rate | tpl-only-filter-soft-ingest | - | attribute_filter_fallback_rate n/a; n 0.0000 |
| retrieval_unchanged | tpl-recommended-prechunked | tpl-v2-off-prechunked | unchanged 0.0000; moved_cells 4.0000 |
| retrieval_unchanged | tpl-recommended-ingest | tpl-v2-off-ingest | unchanged 1.0000; moved_cells 0.0000 |
| single_switch | tpl-only-boilerplate-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-boilerplate-ingest | tpl-v2-off-ingest | named_document_recall 0.0000; wrong_document_at_1 n/a; variant_accuracy 0.0000; quantity_match_rate 0.0000; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-section-rules-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-section-rules-ingest | tpl-v2-off-ingest | named_document_recall 0.0000; wrong_document_at_1 n/a; variant_accuracy 0.6154; quantity_match_rate 0.0000; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-attributes-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-attributes-ingest | tpl-v2-off-ingest | named_document_recall 0.0000; wrong_document_at_1 n/a; variant_accuracy 0.0000; quantity_match_rate 0.0000; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-header-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-header-ingest | tpl-v2-off-ingest | named_document_recall 0.0000; wrong_document_at_1 n/a; variant_accuracy 0.0000; quantity_match_rate 0.0000; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-filter-hard-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-filter-hard-ingest | tpl-v2-off-ingest | named_document_recall 0.0000; wrong_document_at_1 n/a; variant_accuracy 0.0000; quantity_match_rate 0.0000; attribute_filter_fallback_rate 0.0000 |
| single_switch | tpl-only-filter-soft-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-filter-soft-ingest | tpl-v2-off-ingest | named_document_recall 0.0000; wrong_document_at_1 n/a; variant_accuracy 0.0000; quantity_match_rate 0.0000; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-quantity-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-quantity-ingest | tpl-v2-off-ingest | named_document_recall 0.0000; wrong_document_at_1 n/a; variant_accuracy 0.0000; quantity_match_rate 0.0000; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-identifier-feed-prechunked | tpl-v2-off-prechunked | named_document_recall n/a; wrong_document_at_1 n/a; variant_accuracy n/a; quantity_match_rate n/a; attribute_filter_fallback_rate n/a |
| single_switch | tpl-only-identifier-feed-ingest | tpl-v2-off-ingest | named_document_recall 0.0000; wrong_document_at_1 n/a; variant_accuracy 0.0000; quantity_match_rate 0.0000; attribute_filter_fallback_rate n/a |
