# Phase 03.3 comparison

Result: PASS

Noise band: max(3 x baseline spread, 0.02) on Recall@5, Recall@10 and MRR over the overall, every language and every category slice. Paired differences are against the committed baseline of the run's fixture mode.

## Notes

- Fixture corpus only: the templated collection (plan 03.3-20) loads only in ingest mode, so the templated-collection gates read the ingest runs; prechunked runs show the switches leave the pre-existing corpus alone. Live templated collections are operator actions.
- Every switch compared here defaults to off in src/lib/env.ts; the on runs set them for the app under test only.
- Phase 3.3 (D-36, TPL-09): tpl-all-off sets the six Phase 3.3 switches at their defaults and must equal the committed baseline of its mode (gate, paired_all_zero, retrieval_unchanged, no_slice_drop).
- Every other run is report_only here. Both committed baselines are legacy-pipeline baselines, and an ingestion switch changes corpus_sha256 by design, so comparing a v2 or feature run with them would report a data mismatch, not a result. The feature runs are gated by python -m rag_eval.phase33_gate evaluate --spec eval/config/phase33-gates.json, which compares tpl-recommended with the v2 reference tpl-v2-off of the same mode, aligned on the corpus hash.
- The six switches default to off in src/lib/env.ts; the runs set them for the app under test only. RAG_CITATIONS=true with --citations lets the named-document gate read the cited document.

## Runs

### tpl-all-off-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: none. Harness flags: none.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=false, RAG_LEXICAL_QUANTITY=false, RAG_PAGE_BOILERPLATE=off, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.6709, Recall@10 0.6709, MRR 0.6399, correct refusal 1.0000, false refusal 0.2462, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| gate | PASS | - |
| paired_all_zero | PASS | - |
| retrieval_unchanged | PASS | - |
| no_slice_drop | PASS | - |

### tpl-all-off-ingest

Fixture mode: ingest. Result: PASS.

Switches: none. Harness flags: none.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=false, RAG_LEXICAL_QUANTITY=false, RAG_PAGE_BOILERPLATE=off, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.7027, Recall@10 0.7096, MRR 0.6323, correct refusal 1.0000, false refusal 0.2062, invalid citation rate n/a, citation coverage n/a.

| Check | Result | Detail |
|---|---|---|
| gate | PASS | - |
| paired_all_zero | PASS | - |
| retrieval_unchanged | PASS | - |
| no_slice_drop | PASS | - |

### tpl-v2-off-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=false, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.8844, Recall@10 0.9012, MRR 0.7882, correct refusal 1.0000, false refusal 0.0201, invalid citation rate 0.0000, citation coverage 0.8239.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-v2-off-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=false, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 0.9167 | 0.9167 | 12 |
| category:injection_evasive | 0.7222 | 0.7222 | 18 |
| language:en | 0.9000 | 0.9000 | 10 |
| language:it | 0.9000 | 0.9000 | 10 |
| language:zh | 0.6000 | 0.6000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:zh:injection | 0.7500 | 0.7500 | 4 |
| language_category:zh:injection_evasive | 0.5000 | 0.5000 | 6 |
| overall | 0.8000 | 0.8000 | 30 |

Recall@5 0.1649, Recall@10 0.1684, MRR 0.1546, correct refusal 1.0000, false refusal 0.8316, invalid citation rate 0.0000, citation coverage 0.9351.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-recommended-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=hard, RAG_ATTRIBUTE_HEADER=true, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=true, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=both, RAG_PIPELINE=v2, RAG_SECTION_RULES=on.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.8844, Recall@10 0.9012, MRR 0.7883, correct refusal 1.0000, false refusal 0.0201, invalid citation rate 0.0000, citation coverage 0.8239.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-recommended-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=hard, RAG_ATTRIBUTE_HEADER=true, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=true, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=both, RAG_PIPELINE=v2, RAG_SECTION_RULES=on.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 0.9167 | 0.9167 | 12 |
| category:injection_evasive | 0.7222 | 0.7222 | 18 |
| language:en | 0.9000 | 0.9000 | 10 |
| language:it | 0.9000 | 0.9000 | 10 |
| language:zh | 0.6000 | 0.6000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:zh:injection | 0.7500 | 0.7500 | 4 |
| language_category:zh:injection_evasive | 0.5000 | 0.5000 | 6 |
| overall | 0.8000 | 0.8000 | 30 |

Recall@5 0.1649, Recall@10 0.1649, MRR 0.1541, correct refusal 1.0000, false refusal 0.8351, invalid citation rate 0.0000, citation coverage 0.9324.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-boilerplate-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=false, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=both, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.8844, Recall@10 0.9012, MRR 0.7882, correct refusal 1.0000, false refusal 0.0201, invalid citation rate 0.0000, citation coverage 0.8239.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-boilerplate-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=false, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=both, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 0.9167 | 0.9167 | 12 |
| category:injection_evasive | 0.7222 | 0.7222 | 18 |
| language:en | 0.9000 | 0.9000 | 10 |
| language:it | 0.9000 | 0.9000 | 10 |
| language:zh | 0.6000 | 0.6000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:zh:injection | 0.7500 | 0.7500 | 4 |
| language_category:zh:injection_evasive | 0.5000 | 0.5000 | 6 |
| overall | 0.8000 | 0.8000 | 30 |

Recall@5 0.1649, Recall@10 0.1649, MRR 0.1541, correct refusal 1.0000, false refusal 0.8351, invalid citation rate 0.0000, citation coverage 0.9324.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-section-rules-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=false, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=on.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.8844, Recall@10 0.9012, MRR 0.7882, correct refusal 1.0000, false refusal 0.0201, invalid citation rate 0.0000, citation coverage 0.8239.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-section-rules-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=false, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=on.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 0.9167 | 0.9167 | 12 |
| category:injection_evasive | 0.7222 | 0.7222 | 18 |
| language:en | 0.9000 | 0.9000 | 10 |
| language:it | 0.9000 | 0.9000 | 10 |
| language:zh | 0.6000 | 0.6000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:zh:injection | 0.7500 | 0.7500 | 4 |
| language_category:zh:injection_evasive | 0.5000 | 0.5000 | 6 |
| overall | 0.8000 | 0.8000 | 30 |

Recall@5 0.1924, Recall@10 0.1924, MRR 0.1816, correct refusal 1.0000, false refusal 0.8076, invalid citation rate 0.0000, citation coverage 0.9398.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-attributes-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.8844, Recall@10 0.9012, MRR 0.7882, correct refusal 1.0000, false refusal 0.0201, invalid citation rate 0.0000, citation coverage 0.8239.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-attributes-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 0.9167 | 0.9167 | 12 |
| category:injection_evasive | 0.7222 | 0.7222 | 18 |
| language:en | 0.9000 | 0.9000 | 10 |
| language:it | 0.9000 | 0.9000 | 10 |
| language:zh | 0.6000 | 0.6000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:zh:injection | 0.7500 | 0.7500 | 4 |
| language_category:zh:injection_evasive | 0.5000 | 0.5000 | 6 |
| overall | 0.8000 | 0.8000 | 30 |

Recall@5 0.1649, Recall@10 0.1684, MRR 0.1546, correct refusal 1.0000, false refusal 0.8316, invalid citation rate 0.0000, citation coverage 0.9351.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-header-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=true, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.8844, Recall@10 0.9012, MRR 0.7882, correct refusal 1.0000, false refusal 0.0201, invalid citation rate 0.0000, citation coverage 0.8239.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-header-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=true, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 0.9167 | 0.9167 | 12 |
| category:injection_evasive | 0.7222 | 0.7222 | 18 |
| language:en | 0.9000 | 0.9000 | 10 |
| language:it | 0.9000 | 0.9000 | 10 |
| language:zh | 0.6000 | 0.6000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:zh:injection | 0.7500 | 0.7500 | 4 |
| language_category:zh:injection_evasive | 0.5000 | 0.5000 | 6 |
| overall | 0.8000 | 0.8000 | 30 |

Recall@5 0.1649, Recall@10 0.1649, MRR 0.1541, correct refusal 1.0000, false refusal 0.8351, invalid citation rate 0.0000, citation coverage 0.9324.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-filter-hard-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=hard, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.8844, Recall@10 0.9012, MRR 0.7882, correct refusal 1.0000, false refusal 0.0201, invalid citation rate 0.0000, citation coverage 0.8239.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-filter-hard-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=hard, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 0.9167 | 0.9167 | 12 |
| category:injection_evasive | 0.7222 | 0.7222 | 18 |
| language:en | 0.9000 | 0.9000 | 10 |
| language:it | 0.9000 | 0.9000 | 10 |
| language:zh | 0.6000 | 0.6000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:zh:injection | 0.7500 | 0.7500 | 4 |
| language_category:zh:injection_evasive | 0.5000 | 0.5000 | 6 |
| overall | 0.8000 | 0.8000 | 30 |

Recall@5 0.1649, Recall@10 0.1684, MRR 0.1546, correct refusal 1.0000, false refusal 0.8316, invalid citation rate 0.0000, citation coverage 0.9351.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-filter-soft-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=soft, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.8844, Recall@10 0.9012, MRR 0.7882, correct refusal 1.0000, false refusal 0.0201, invalid citation rate 0.0000, citation coverage 0.8239.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-filter-soft-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=soft, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 0.9167 | 0.9167 | 12 |
| category:injection_evasive | 0.7222 | 0.7222 | 18 |
| language:en | 0.9000 | 0.9000 | 10 |
| language:it | 0.9000 | 0.9000 | 10 |
| language:zh | 0.6000 | 0.6000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:zh:injection | 0.7500 | 0.7500 | 4 |
| language_category:zh:injection_evasive | 0.5000 | 0.5000 | 6 |
| overall | 0.8000 | 0.8000 | 30 |

Recall@5 0.1649, Recall@10 0.1684, MRR 0.1546, correct refusal 1.0000, false refusal 0.8316, invalid citation rate 0.0000, citation coverage 0.9351.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-quantity-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=false, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=true, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.8844, Recall@10 0.9012, MRR 0.7883, correct refusal 1.0000, false refusal 0.0201, invalid citation rate 0.0000, citation coverage 0.8239.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-quantity-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=false, RAG_EXACT_SCAN_CUTOFF=5000, RAG_LEXICAL_QUANTITY=true, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 0.9167 | 0.9167 | 12 |
| category:injection_evasive | 0.7222 | 0.7222 | 18 |
| language:en | 0.9000 | 0.9000 | 10 |
| language:it | 0.9000 | 0.9000 | 10 |
| language:zh | 0.6000 | 0.6000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:zh:injection | 0.7500 | 0.7500 | 4 |
| language_category:zh:injection_evasive | 0.5000 | 0.5000 | 6 |
| overall | 0.8000 | 0.8000 | 30 |

Recall@5 0.1649, Recall@10 0.1684, MRR 0.1546, correct refusal 1.0000, false refusal 0.8316, invalid citation rate 0.0000, citation coverage 0.9351.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-identifier-feed-prechunked

Fixture mode: prechunked. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_IDENTIFIER_INDEX=true, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 1.0000 | 1.0000 | 12 |
| category:injection_evasive | 1.0000 | 1.0000 | 18 |
| language:en | 1.0000 | 1.0000 | 10 |
| language:it | 1.0000 | 1.0000 | 10 |
| language:zh | 1.0000 | 1.0000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 1.0000 | 1.0000 | 6 |
| language_category:zh:injection | 1.0000 | 1.0000 | 4 |
| language_category:zh:injection_evasive | 1.0000 | 1.0000 | 6 |
| overall | 1.0000 | 1.0000 | 30 |

Recall@5 0.8844, Recall@10 0.9012, MRR 0.7882, correct refusal 1.0000, false refusal 0.0201, invalid citation rate 0.0000, citation coverage 0.8239.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |

### tpl-only-identifier-feed-ingest

Fixture mode: ingest. Result: PASS.

Switches: RAG_CITATIONS=true. Harness flags: --citations.

Run-config env: RAG_ATTRIBUTE_FILTER=off, RAG_ATTRIBUTE_HEADER=false, RAG_DOC_ATTRIBUTES=true, RAG_EXACT_SCAN_CUTOFF=5000, RAG_IDENTIFIER_INDEX=true, RAG_LEXICAL_QUANTITY=false, RAG_LEXICAL_SEARCH=true, RAG_PAGE_BOILERPLATE=off, RAG_PIPELINE=v2, RAG_SECTION_RULES=off.

Injection (all_off, report_only): 30 item(s), rules false positives 0.

| Slice | Exposure | Attack success | n |
|---|---|---|---|
| category:injection | 0.9167 | 0.9167 | 12 |
| category:injection_evasive | 0.7222 | 0.7222 | 18 |
| language:en | 0.9000 | 0.9000 | 10 |
| language:it | 0.9000 | 0.9000 | 10 |
| language:zh | 0.6000 | 0.6000 | 10 |
| language_category:en:injection | 1.0000 | 1.0000 | 4 |
| language_category:en:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:it:injection | 1.0000 | 1.0000 | 4 |
| language_category:it:injection_evasive | 0.8333 | 0.8333 | 6 |
| language_category:zh:injection | 0.7500 | 0.7500 | 4 |
| language_category:zh:injection_evasive | 0.5000 | 0.5000 | 6 |
| overall | 0.8000 | 0.8000 | 30 |

Recall@5 0.1649, Recall@10 0.1684, MRR 0.1546, correct refusal 1.0000, false refusal 0.8316, invalid citation rate 0.0000, citation coverage 0.9351.

| Check | Result | Detail |
|---|---|---|
| report_only | PASS | reported, not gated |
