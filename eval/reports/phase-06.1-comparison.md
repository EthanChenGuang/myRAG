# Phase 06.1 comparison

Result: PASS

With `RAG_FINETUNE=off` (the default) the fixture eval equals the committed baseline of each fixture mode on every item: every paired difference is zero on Recall@5, Recall@10, MRR, correct and false refusal over the overall, language, pair and category slices.

## Notes

- Fixture runs prove wiring only. The real retrieval gain of a fine-tuned model is a live item (06.1-19: real data, real endpoint, real golden items).
- Baseline: the committed fixture baselines (eval/baselines/fixture-baseline.json, fixture-ingest-baseline.json), last re-recorded on the merged train after the Phase 6 items (06-38, 06-39) and 04.1.1-10. Phase 6 is not formally closed on this base (06-44, 06-45 open), so this is the latest Phase 6 baseline.
- Latency is fixture wall-clock time, not deterministic; budgets in eval/config/latency-budgets.json are report-only.
- Skipped checks are slices with no refusal items (n = 0).
- No chunk or query text: ids, counts, hashes and metrics only.

## Parity with the baseline

### prechunked

Baseline `eval/baselines/fixture-baseline.json` (sha256 `4eaca815dc4b`). Result: PASS.

Items 143. Recall@5 0.5664, Recall@10 0.5664, MRR 0.5396, correct refusal 0.6800, false refusal 0.3357.

| Check | Result |
|---|---|
| paired differences all zero (11 slices, 0 nonzero cells) | PASS |
| mismatches | 0 |
| offenders | 0 |
| skipped (empty slices) | 7 |

| Stage | p50 ms | p95 ms | chat budget ms |
|---|---|---|---|
| analyze | 0.0 | 1.0 | - |
| assemble | 0.0 | 0.0 | 100 |
| embed | 1.0 | 4.0 | 200 |
| generation | 1.0 | 4.0 | - |
| legacy_rank | 0.0 | 0.0 | - |
| post_filter | 3.0 | 4.0 | - |
| retrieval_total | 10.0 | 15.0 | - |
| search | 6.0 | 8.0 | 400 |

### ingest

Baseline `eval/baselines/fixture-ingest-baseline.json` (sha256 `f132b6386ce3`). Result: PASS.

Items 177. Recall@5 0.7119, Recall@10 0.7232, MRR 0.6177, correct refusal 0.5333, false refusal 0.1921.

| Check | Result |
|---|---|
| paired differences all zero (12 slices, 0 nonzero cells) | PASS |
| mismatches | 0 |
| offenders | 0 |
| skipped (empty slices) | 8 |

| Stage | p50 ms | p95 ms | chat budget ms |
|---|---|---|---|
| analyze | 0.0 | 1.0 | - |
| assemble | 0.0 | 0.0 | 100 |
| embed | 1.0 | 4.0 | 200 |
| exact_id_lookup | 0.0 | 5.0 | - |
| generation | 1.0 | 9.0 | - |
| legacy_rank | 0.0 | 0.0 | - |
| post_filter | 2.0 | 4.0 | - |
| retrieval_total | 9.0 | 18.0 | - |
| search | 5.0 | 7.0 | 400 |

## Fixture pipeline (06.1-16, marked fixture)

Run `ft-fixture-s42`, seed 42, trainer `fake`, 2 tenants. Every step exited 0: export, generate, filter, import-mined, vectors, mine, kit, train, evaluate, card.

Synthetic queries: 577 kept; dropped golden_overlap 22, language 5, low_confidence 0, near_duplicate 0, not_answerable 0, shape 0, unknown_chunk_ref 0, verbatim_copy 32.

Mined import: 49 of 61 kept, 12 held out; dropped golden_overlap 9, invalid_row 0, language 0, near_duplicate 0, shape 0, tenant_not_in_bundle 0, unknown_chunk 0, verbatim_copy 3.

Mining: 122 pairs (120 with full negatives, 2 pairs only), mean negatives 4.9508. False-negative audit: 0 answerable of 50 sampled, upper 95% 0.0582 (limit 0.15), passed.

| Model | Recall@10 | MRR@10 | nDCG@10 | n |
|---|---|---|---|---|
| base | 0.494 | 0.2965 | 0.3434 | 504 |
| production | 0.5516 | 0.3331 | 0.3851 | 504 |
| finetuned | 0.4603 | 0.2969 | 0.3352 | 504 |

Offline gate: refused (below_production_overall, language_slice_below_production, below_base); card status `rejected_offline`. Fake trainer; the offline gate refuses the candidate (rejected_offline), which is the expected wiring result, not a model quality statement.

## Lifecycle (06.1-17, 06.1-20) with 0654

- `tests/rag-db/finetune-lifecycle.test.mts`, `tests/rag-db/finetune-two-tenant.test.mts`, `tests/rag-db/finetune-binding.test.mts`, `tests/rag-db/finetune-revoke-prune.test.mts`: 55 pass, 0 fail, 2 skipped (single-tenant tenant-B cases (one tenant only), as in 06.1-20).
- Switch-off parity reference: frozen pre-Phase-3 setup plus every migration except 0651-0654.
- Revoke to prune: ft-consent revoke --prune-root ran the printed prune command; the revoked tenant's own and shared bundles lost 10 text-bearing files each, manifests and reports stayed, the other tenant's bundle was untouched.
- `FINETUNE_TRAIN_REQUIRED=1 pytest -m finetune_train`: 7 passed, 0 skipped.

## Live items

- 06.1-19: real export and training, endpoint binding, re-embed, profile comparison on real items, EMB-05 activation
