# Scope separation with a real embedding profile (06.2-42)

- Embedder: `openai:text-embedding-3-small`, embedding profile `openai-3-small-1536`
- Items: 310 answerable (194 dev, non-cross-lingual), 6 out-of-domain, 46 near-miss, 34 cross-lingual
- Scoring: max cosine over the original question and its fixture translations (no HyDE) against the grouping centroids
- Threshold: 5th percentile (nearest rank, lower) of dev-split answerable, non-cross-lingual scores, per grouping
- Embedding calls: 11 (1078 texts)

| Grouping | Centroids | Threshold | Answerable below | Out-of-domain below (of 6) | Near-miss below (of 46) | Cross-lingual below (max / original only) |
|----------|-----------|-----------|------------------|------------------------|--------------------|--------------------------------------------|
| tenant | 1 | 0.163 | 9 | 5 | 1 | 0 / 2 |
| tenant_language | 3 | 0.199 | 9 | 6 | 3 | 0 / 3 |
| doc_type | 5 | 0.258 | 14 | 6 | 3 | 0 / 2 |
| doc_type_language | 10 | 0.252 | 14 | 6 | 3 | 0 / 2 |
| d34_all | 13 | 0.257 | 14 | 6 | 3 | 0 / 2 |

**Verdict: `d34_separates_at_least_as_well = true`** (out-of-domain below: doc_type_language 6, doc_type 6; answerable below: doc_type_language 14, doc_type 14).

Measurement on synthetic fixtures with a real embedding profile; it calibrates nothing and never changes the D-34 grouping.
