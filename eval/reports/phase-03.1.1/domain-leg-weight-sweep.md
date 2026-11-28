# Domain leg weight sweep (fixture, quick-311)

Fixture embedder, fixture database and synthetic items only (quick-311 gap 6). Report-only: no default changes, and no verdict about real data.

Command: `VOYAGE_API_KEY= npx tsx eval/harness/run-binding-compare.mts --doc-type <doc_type> --leg-weight-domain <w> --out eval/out/quick-311-sweep2/<doc_type>/w<w>`

| Doc type | leg_weights.domain | Candidate | Δ recall@10 vs baseline | Δ MRR vs baseline | Δ recall@10 vs control | Other-slice regressions | Recommended |
|---|---|---|---|---|---|---|---|
| contract_legal | 0.25 | voyage-4-large-1024-domain | +0.0600 | -0.1679 | +0.0000 | overall, doc_type:financial_report, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en | no |
| contract_legal | 0.25 | voyage-law-2-1024 | +0.0600 | -0.1679 | +0.0000 | overall, doc_type:financial_report, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en | no |
| contract_legal | 0.5 | voyage-4-large-1024-domain | -0.1400 | -0.2059 | +0.0000 | overall, doc_type:financial_report, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en | no |
| contract_legal | 0.5 | voyage-law-2-1024 | -0.1400 | -0.2059 | +0.0000 | overall, doc_type:financial_report, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en | no |
| contract_legal | 0.75 | voyage-4-large-1024-domain | -0.2200 | -0.2196 | +0.0000 | overall, doc_type:financial_report, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en | no |
| contract_legal | 0.75 | voyage-law-2-1024 | -0.2200 | -0.2196 | +0.0000 | overall, doc_type:financial_report, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en | no |
| contract_legal | 1.0 | voyage-4-large-1024-domain | -0.2200 | -0.2376 | +0.0000 | overall, doc_type:financial_report, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it | no |
| contract_legal | 1.0 | voyage-law-2-1024 | -0.2200 | -0.2376 | +0.0000 | overall, doc_type:financial_report, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it | no |
| financial_report | 0.25 | voyage-4-large-1024-domain | +0.0000 | +0.0000 | +0.0000 | overall, doc_type:contract_legal, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->zh, pair:it->zh, pair:zh->it | no |
| financial_report | 0.25 | voyage-finance-2-1024 | +0.0000 | +0.0000 | +0.0000 | overall, doc_type:contract_legal, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->zh, pair:it->zh, pair:zh->it | no |
| financial_report | 0.5 | voyage-4-large-1024-domain | +0.0000 | +0.0000 | +0.0000 | overall, doc_type:contract_legal, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->zh, pair:zh->it | no |
| financial_report | 0.5 | voyage-finance-2-1024 | +0.0000 | +0.0000 | +0.0000 | overall, doc_type:contract_legal, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->zh, pair:zh->it | no |
| financial_report | 0.75 | voyage-4-large-1024-domain | +0.0000 | +0.0000 | +0.0000 | overall, doc_type:contract_legal, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->zh, pair:zh->it | no |
| financial_report | 0.75 | voyage-finance-2-1024 | +0.0000 | +0.0000 | +0.0000 | overall, doc_type:contract_legal, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->zh, pair:zh->it | no |
| financial_report | 1.0 | voyage-4-large-1024-domain | +0.0000 | +0.0000 | +0.0000 | overall, doc_type:contract_legal, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->zh, pair:zh->it | no |
| financial_report | 1.0 | voyage-finance-2-1024 | +0.0000 | +0.0000 | +0.0000 | overall, doc_type:contract_legal, doc_type:general, doc_type:invoice_receipt, doc_type:product_technical, doc_type:scanned_image, language:en, language:it, language:zh, pair:en->it, pair:en->zh, pair:it->zh, pair:zh->it | no |

## Reading (fixture only)

The weight takes effect only since quick-311 fixed the eval override plumbing: the route, `evalRetrievalOverrides` and `applyEvalOverrides` each used to drop `leg_weights.domain`. The `--leg-weight-domain` flag then had no effect, and an earlier run of this sweep gave the same results at every weight.

- **contract_legal:** recall@10 against baseline goes from −0.22 at 1.0 and 0.75 to −0.14 at 0.5 and +0.06 at 0.25. Other-slice regressions fall from 15 at 1.0 to 13 at 0.25. MRR still drops at every weight.
- **financial_report:** the doc-type slice (12 synthetic items) does not change at any weight. Other-slice regressions fall from 13 to 12 at 0.25.
- **Gate:** no weight and no candidate passes. No candidate beats the control, and other slices regress at every weight, so the fixture comparison gives no candidate verdict.

**Recommendation:** start a live sweep at `leg_weights.domain = 0.25`, and also try weights below it (for example 0.1), because the trend is still improving at the lowest weight tested. Keep the shipped default (unset, which means 1.0) until a real-population comparison supports a change. This report changes no default.
