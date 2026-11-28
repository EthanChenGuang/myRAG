# Phase 6.2 query additions: decision report

Source: fixture. Noise floor 0.02 (k 3). Written by `python -m rag_eval.compare query-additions`.

## Switches

| Switch | Arm vs reference | Eligible | Improved slices | Regressions | Notes |
|---|---|---|---|---|---|
| `RAG_QUERY_DECOMPOSE` | decompose vs single-pass | no | - | - | targets measured: category:scoped_compound |
| `RAG_QUERY_DECOMPOSE_COMPLETENESS` | completeness vs decompose | no | - | - | targets measured: category:scoped_compound |
| `RAG_QUERY_SUBQ_FILTERS` | subq-filters vs completeness | no | - | - | targets measured: category:scoped_compound |
| `RAG_TRANSLATION_GLOSSARY` | glossary vs single-pass | yes | - | - | tests passed: tests/rag/query/glossary-translate.test.ts, tests/rag/query/glossary-rewrite.test.ts, tests/rag/ingest-translate-glossary.test.ts |
| `RAG_SPECULATIVE_RETRIEVAL` | speculative vs single-pass | yes | - | - | all-turns pre-retrieval p95 36 ms vs 37 ms |
| `RAG_MODEL_ROUTING` | routing vs single-pass | no | - | - | generation p95 162 ms vs 162 ms against the fixed quality model; answer correctness is a live judge run |
| `RAG_SCOPE_GATE` | scope-gate vs single-pass | no | - | category:context_overflow:false_refusal_rate, category:cross_lingual:false_refusal_rate, category:multi_turn:false_refusal_rate, category:typo:false_refusal_rate, language:en:false_refusal_rate, language:zh:false_refusal_rate, overall:false_refusal_rate, pair:en->zh:false_refusal_rate, pair:zh->en:false_refusal_rate | correct refusals 0.962963 vs 0.962963; off equal to baseline: 30-defaults: gate passed=True, paired all_zero=True; 30-defaults-ingest: gate passed=True, paired all_zero=True |
| `RAG_QUERY_VOICE_TRANSFORMS:translate` | voice-translate vs voice-no-translate | no | - | - | query-stage voice p95 1 ms (budget 300 ms) |

## D-31 checklist

| Letter | Passed | Evidence |
|---|---|---|
| a | yes | 30-defaults: gate passed=True, paired all_zero=True; 30-defaults-ingest: gate passed=True, paired all_zero=True |
| b | no | completeness vs single-pass: improved none, regressions none; targets measured: category:scoped_compound |
| c | yes | glossary entry eligible=True; tests passed: tests/rag/query/glossary-translate.test.ts, tests/rag/query/glossary-rewrite.test.ts, tests/rag/ingest-translate-glossary.test.ts |
| d | yes | 30 detection cases (sha256 46a98551c0cf); tests passed: tests/rag/lang/detect-cases.test.ts, tests/rag/lang/resolve-query-language.test.ts |
| e | yes | pairs pair:en->it, pair:en->zh, pair:it->en, pair:it->zh, pair:zh->en, pair:zh->it; voice gates passed=True; query-stage voice p95 1 ms (budget 300 ms) |
| f | yes | speculative traced on 448 turns, model_route on 454; eligibility recorded; tests passed: tests/rag/query/speculative.test.ts, tests/rag/model-router.test.ts |
| g | yes | WhatsApp report passed=True; tests passed: tests/rag/query/history-fallback.test.ts, tests/whatsapp/history.test.ts |
| h | no | 8 unanswerable items refused out_of_scope; scope gate p95 0.269618 ms (budget 5 ms); false-refusal regressions ['category:context_overflow:false_refusal_rate', 'category:cross_lingual:false_refusal_rate', 'category:multi_turn:false_refusal_rate', 'category:typo:false_refusal_rate', 'language:en:false_refusal_rate', 'language:zh:false_refusal_rate', 'overall:false_refusal_rate', 'pair:en->zh:false_refusal_rate', 'pair:zh->en:false_refusal_rate']; off equal True; tests passed: tests/rag/scope/stage.test.ts |
| i | yes | written by rag_eval.compare query-additions from 12 arm runs |

## Pre-retrieval latency (D-37)

| Arm | All turns p50/p95 (n) | New variant p95 (n) | No new variant p95 (n) |
|---|---|---|---|
| 30-defaults | n/a | n/a | n/a |
| 30-defaults-ingest | n/a | n/a | n/a |
| completeness | 19/36 (448) | 68 (38) | 29 (410) |
| decompose | 20/40 (448) | 86 (38) | 30 (410) |
| glossary | 19/37 (448) | 61 (28) | 26 (420) |
| routing | 23/37 (448) | 49 (28) | 32 (420) |
| scope-gate | 19/33 (430) | 44 (28) | 28 (402) |
| single-pass | 22/37 (448) | 48 (28) | 33 (420) |
| speculative | 19/36 (448) | 46 (28) | 25 (420) |
| subq-filters | 20/37 (448) | 77 (38) | 29 (410) |
| voice-no-translate | 19/30 (448) | 44 (22) | 25 (426) |
| voice-translate | 20/33 (448) | 45 (28) | 26 (420) |

## Voice cross_lingual per pair

| Pair | Recall@5 off -> on | MRR off -> on |
|---|---|---|
| pair:en->it | 0.333333 -> 0.333333 | 0.333333 -> 0.333333 |
| pair:en->zh | 0.2 -> 0.2 | 0.2 -> 0.2 |
| pair:it->en | 0.666667 -> 0.666667 | 0.666667 -> 0.666667 |
| pair:it->zh | 0.333333 -> 0.333333 | 0.25 -> 0.25 |
| pair:zh->en | 0.666667 -> 0.666667 | 0.666667 -> 0.666667 |
| pair:zh->it | 0.5 -> 0.5 | 0.5 -> 0.5 |

## Language resolved by the LANG-08 chain (P-21, report-only)

| Arm | Slice | Items | Recall@5 | False refusal |
|---|---|---|---|---|
| completeness | language_source:primary | 62 | 0.843137 | 0.019608 |
| decompose | language_source:primary | 62 | 0.843137 | 0.019608 |
| glossary | language_source:primary | 62 | 0.843137 | 0.019608 |
| routing | language_source:primary | 62 | 0.843137 | 0.019608 |
| scope-gate | language_source:primary | 62 | 0.823529 | 0.039216 |
| single-pass | language_source:primary | 62 | 0.843137 | 0.019608 |
| speculative | language_source:primary | 62 | 0.843137 | 0.019608 |
| subq-filters | language_source:primary | 62 | 0.843137 | 0.019608 |
| voice-no-translate | language_source:primary | 62 | 0.843137 | 0 |
| voice-translate | language_source:primary | 62 | 0.843137 | 0 |

Ignored run directories: q62-30-defaults-ingest.log, q62-30-defaults.log, q62-30-tests, q62-completeness.log, q62-decompose.log, q62-glossary.log, q62-routing.log, q62-scope-gate.log, q62-single-pass.log, q62-speculative.log, q62-subq-filters.log, q62-voice-no-translate.log, q62-voice-translate.log, q62-whatsapp.log

## Notes

- Noise band per slice and metric: max(k * spread, floor) with a single-run reference arm, so the band is the floor.
- Improvement: a slice metric strictly better than the reference arm; regression: worse beyond the band.
- Pre-retrieval time (D-37): request start to the end of fuse, the parallel transform group counted by its slowest member, minus the traced speculative overlap; eligibility uses the all-turns p95, the new-variant split is report-only.
- language_source:<source> slices (P-21) list items whose language the LANG-08 chain resolved past the confident detector; report-only.
- Fixture numbers prove the wiring and the rules; the live comparison is an operator run.
