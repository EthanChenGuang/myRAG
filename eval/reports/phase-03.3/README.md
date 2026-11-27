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

## Requirement map (plan 03.3-25, hand-written)

Eval gates from gates.json above; test gates from the Task 3 full suite on exec/03.3-25 (every named test file ran and passed).

| Requirement | Eval gate | Test gates | Outcome |
|---|---|---|---|
| TPL-01 | variant: pass (1.000, 13/13) | rule-sections, section-hits, section-rules-ingest | pass |
| TPL-02 | boilerplate_share: pass (0.0026 vs control 0.2504) | boilerplate, page-lines, boilerplate-ingest | pass |
| TPL-03 | named_document: pass (recall 1.000, wrong@1 0.000, cited 1.000) | document-attributes, attributes-validate, upload-attributes, backfill-manifest-attributes | pass |
| TPL-04 | none | attributes-import, attributes-cli, attribute-identifier-feed | pass |
| TPL-05 | none | attribute-header (unit and db), attribute-header-route | pass |
| TPL-06 | named_document: pass | attribute-filter, attribute-resolve-stage, attribute-search | pass |
| TPL-07 | quantity: pass (1.000, 16/16) | lexical-quantity, relex-quantity, resolve-options-quantity | pass |
| TPL-08 | none | phase33-two-tenant, phase33-purge, phase33-schema, tenant-line-pattern, phase33-routes | pass |
| TPL-09 | off_identity: pass; no_other_slice_drop: FAIL in fixture mode | defaults-equal-phase3, test_fixture_templated | pass by off_identity and tests; no_other_slice_drop recorded as FAIL |

no_other_slice_drop: tpl-recommended-ingest category:cache_near_miss recall_at_5 0.8182 < 0.8891 (reference 0.9091), one item of 11
(it-cache-near-miss-005, fused rank 5 to 6, RRF 0.02914 vs 0.02921). Cause: the attribute header in the dense embedding text (D-26) under the
hashed n-gram fixture embedder. Orchestrator decision (b): D-26, the gates and the band unchanged; must-check in plan 03.3-26 (see
handoffs/03.3-25-requirement-TPL-09.md).

## Suite exit codes (Task 3)

| Job | Exit | Note |
|---|---|---|
| npx vitest run | 1 | 2 failed / 12954 passed: tests/rag/chunk-sentences.test.ts, tests/rag/table-header-repeat.test.ts (snapshots of 672 / 1344 entries vs 1608 / 3216 now); same failure on 2872cc98, before this plan's code changes (pre-existing) |
| node --test tests/*.test.mts | 0 | 177 pass |
| node --test tests/rag-db/*.test.mts | 0 | |
| node --test tests/rag-e2e/*.test.mts | 0 | |
| rag-sidecar pytest (chunking) | 0 | |
| eval pytest | 1 | 1 failed / 2476 passed: test_metrics.py::test_the_train_31_baselines_add_only_phase53_items_and_move_only_refusal_rates[fixture-ingest-baseline]; same failure on 2872cc98 (pre-existing: the ingest baseline also holds the 03.3-20 templated items) |
| check-config | 0 | 255 variables |
| check-settings-classification | 0 | 207 RAG_* variables |
| check-rag-boundary (+ node test) | 0 | |
| gen:schemas, no diff | 0 | |
| next typegen + tsc | 0 | |
| check-workflows.py | 0 | |
| npm run lint | 1 | 17650 errors repo-wide, pre-existing; the changed source files show the same findings as on 2872cc98 |
| check-frontend-design-summary | 0 | |
| explicit-legacy smoke, prechunked | 0 | paired.all_zero true |
| explicit-legacy smoke, ingest | 0 | paired.all_zero true |
| npm run test-rag (ingest) | 0 | absolute gate PASS |
| npm run test-rag (prechunked) | 11 | en false_refusal 0.3143 (legacy 0.65 keep rule), out of scope by orchestrator decision |
