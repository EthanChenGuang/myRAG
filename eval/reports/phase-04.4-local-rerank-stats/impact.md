# RAG_RERANK_LOCAL_STATS=tenant: impact on every keyless v2 run (plan 04.4-22, D-58)

Runs classified: 172 (50 resolve to local_bm25 for at least one profile, 122 not affected); 24 effective configurations among the local_bm25 runs. Refusal cells that go stale: 0 (no cell is keyed to local_bm25, and local_bm25 scores are relative, so no cell applies in either mode).

Each row compares the tenant arm with the pool arm of the same run configuration (ids, counts and metric values only). "Beyond band" uses the noise floor with n at least 10, as the pinned Phase 4.4 slice rule; it is reported here, not gated.

| Group | Representative | Runs | Mode | Recall@10 pool → tenant | Slices changed | Beyond band | Top context changed | Refusal changed | All-zero rerank pool / tenant |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | `eval/config/runs/v2-default-hosted-fake-no-cells.json` | 1 | — | voice_profile_only: eval profile reranker cohere; only the voice profile resolves to local_bm25, measured by the gate's voice arm | | | | | |
| 1 | `eval/config/runs/v2-default-hosted-fake.json` | 1 | — | voice_profile_only: eval profile reranker cohere; only the voice profile resolves to local_bm25, measured by the gate's voice arm | | | | | |
| 2 | `eval/config/runs/v2-default-local-stats-tenant.json` | 1 | — | is_tenant_arm: the tenant arm of the gate itself (phase44-local-rerank-stats-comparison.json) | | | | | |
| 3 | `eval/config/runs/v2-default-no-cells.json` | 1 | prechunked | 0.7271 → 0.7396 | 19 | none | 129 of 454 | 0 | 22 / 23 of 454 |
| 3 | `eval/config/runs/v2-default-no-cells.json` | 1 | ingest | 0.7063 → 0.7274 | 26 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 219 of 602 | 0 | 28 / 41 of 602 |
| 4 | `eval/config/runs/v2-default-similarity-floor-hosted-fake-no-cells.json` | 1 | — | voice_profile_only: eval profile reranker cohere; only the voice profile resolves to local_bm25, measured by the gate's voice arm | | | | | |
| 5 | `eval/config/runs/v2-default-similarity-floor-hosted-fake.json` | 1 | — | voice_profile_only: eval profile reranker cohere; only the voice profile resolves to local_bm25, measured by the gate's voice arm | | | | | |
| 6 | `eval/config/runs/v2-default-similarity-floor-no-cells.json` | 1 | prechunked | 0.8854 → 0.9167 | 21 | none | 167 of 454 | 0 | 22 / 23 of 454 |
| 6 | `eval/config/runs/v2-default-similarity-floor-no-cells.json` | 1 | ingest | 0.8253 → 0.8630 | 27 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 268 of 602 | 0 | 28 / 41 of 602 |
| 7 | `eval/config/runs/v2-default-similarity-floor.json` | 1 | prechunked | 0.8854 → 0.9167 | 21 | none | 167 of 454 | 0 | 22 / 23 of 454 |
| 7 | `eval/config/runs/v2-default-similarity-floor.json` | 1 | ingest | 0.8253 → 0.8630 | 27 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 268 of 602 | 0 | 28 / 41 of 602 |
| 8 | `eval/config/runs/v2-default.json` | 10 | prechunked | 0.7271 → 0.7396 | 19 | none | 129 of 454 | 0 | 22 / 23 of 454 |
| 8 | `eval/config/runs/v2-default.json` | 10 | ingest | 0.7063 → 0.7274 | 26 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 219 of 602 | 0 | 28 / 41 of 602 |
| 9 | `eval/config/runs/v2-diversity-collapse.json` | 2 | prechunked | 0.7271 → 0.7396 | 19 | none | 124 of 454 | 0 | 22 / 23 of 454 |
| 9 | `eval/config/runs/v2-diversity-collapse.json` | 2 | ingest | 0.7078 → 0.7274 | 26 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 219 of 602 | 0 | 28 / 41 of 602 |
| 10 | `eval/config/runs/v2-diversity-mmr.json` | 2 | prechunked | 0.7271 → 0.7396 | 22 | none | 146 of 454 | 0 | 22 / 23 of 454 |
| 10 | `eval/config/runs/v2-diversity-mmr.json` | 2 | ingest | 0.7078 → 0.7259 | 27 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 234 of 602 | 0 | 28 / 41 of 602 |
| 11 | `eval/config/runs/v2-identifier-on.json` | 2 | prechunked | 0.7979 → 0.8104 | 22 | category:multi_turn:mrr 0.5313 -> 0.4896 (n 16) | 76 of 454 | 0 | 48 / 29 of 444 |
| 11 | `eval/config/runs/v2-identifier-on.json` | 2 | ingest | 0.4955 → 0.5196 | 23 | none | 145 of 602 | 0 | 28 / 41 of 441 |
| 12 | `eval/config/runs/v2-lexical-bm25-cluster-df-on.json` | 3 | prechunked | 0.7271 → 0.7396 | 20 | none | 123 of 454 | 0 | 22 / 23 of 454 |
| 12 | `eval/config/runs/v2-lexical-bm25-cluster-df-on.json` | 3 | ingest | 0.7078 → 0.7274 | 24 | none | 211 of 602 | 0 | 28 / 41 of 602 |
| 13 | `eval/config/runs/v2-lexical-bm25-on-local-stats-tenant.json` | 1 | — | is_tenant_arm: the tenant arm of the gate itself (phase44-local-rerank-stats-comparison.json) | | | | | |
| 14 | `eval/config/runs/v2-lexical-bm25-on.json` | 7 | prechunked | 0.7250 → 0.7396 | 21 | none | 125 of 454 | 0 | 22 / 23 of 454 |
| 14 | `eval/config/runs/v2-lexical-bm25-on.json` | 7 | ingest | 0.7063 → 0.7274 | 24 | none | 211 of 602 | 0 | 28 / 41 of 602 |
| 15 | `eval/config/runs/v2-lexical-dict-on.json` | 2 | prechunked | 0.7271 → 0.7396 | 19 | none | 129 of 454 | 0 | 22 / 23 of 454 |
| 15 | `eval/config/runs/v2-lexical-dict-on.json` | 2 | ingest | 0.7063 → 0.7274 | 26 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 219 of 602 | 0 | 28 / 41 of 602 |
| 16 | `eval/config/runs/v2-lexical-stem-it-on.json` | 2 | prechunked | 0.7250 → 0.7396 | 22 | none | 130 of 454 | 0 | 22 / 23 of 454 |
| 16 | `eval/config/runs/v2-lexical-stem-it-on.json` | 2 | ingest | 0.7063 → 0.7274 | 26 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 219 of 602 | 0 | 28 / 41 of 602 |
| 17 | `eval/config/runs/v2-table-lookup-on.json` | 2 | prechunked | 0.7271 → 0.7396 | 19 | none | 129 of 454 | 0 | 22 / 23 of 454 |
| 17 | `eval/config/runs/v2-table-lookup-on.json` | 2 | ingest | 0.7063 → 0.7274 | 26 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 219 of 602 | 0 | 28 / 41 of 602 |
| 18 | `eval/config/runs/v2-terminology-on.json` | 1 | prechunked | 0.7271 → 0.7396 | 19 | none | 129 of 454 | 0 | 22 / 23 of 454 |
| 18 | `eval/config/runs/v2-terminology-on.json` | 1 | ingest | 0.7063 → 0.7274 | 26 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 218 of 602 | 0 | 28 / 41 of 602 |
| 19 | `eval/config/runs/v2-version-scope-on.json` | 2 | prechunked | 0.7333 → 0.7458 | 19 | none | 129 of 454 | 0 | 22 / 23 of 454 |
| 19 | `eval/config/runs/v2-version-scope-on.json` | 2 | ingest | 0.7108 → 0.7319 | 26 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 219 of 602 | 0 | 28 / 41 of 602 |
| 20 | `eval/config/phase4-comparison.json#local-bm25` | 1 | prechunked | 0.8854 → 0.9167 | 21 | none | 167 of 454 | 0 | 22 / 23 of 454 |
| 20 | `eval/config/phase4-comparison.json#local-bm25` | 1 | ingest | 0.8253 → 0.8630 | 27 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 268 of 602 | 0 | 28 / 41 of 602 |
| 21 | `eval/config/phase4-comparison.json#translation-on` | 1 | prechunked | 0.9271 → 0.9583 | 22 | none | 174 of 454 | 0 | 18 / 17 of 454 |
| 21 | `eval/config/phase4-comparison.json#translation-on` | 1 | ingest | 0.8554 → 0.8931 | 29 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 272 of 602 | 0 | 24 / 35 of 602 |
| 22 | `eval/config/phase44-cluster-df-comparison.json#v2-default-prechunked` | 2 | prechunked | 0.7271 → 0.7396 | 19 | none | 129 of 454 | 0 | 22 / 23 of 454 |
| 22 | `eval/config/phase44-cluster-df-comparison.json#v2-default-prechunked` | 2 | ingest | 0.7063 → 0.7274 | 26 | category:scanned:recall_at_10 1.0000 -> 0.9286 (n 14) | 219 of 602 | 0 | 28 / 41 of 602 |
| 23 | `eval/config/phase44-local-rerank-stats-comparison.json#voice-pool-prechunked` | 2 | prechunked | 0.9146 → 0.9125 | 22 | none | 112 of 454 | 0 | 0 / 0 of 0 |

Not affected runs and the reason for each are listed in impact.json (`runs`, classification `not_affected`).
