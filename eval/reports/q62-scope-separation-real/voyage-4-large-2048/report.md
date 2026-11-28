# Scope separation with a real embedding profile (06.2-42)

- Embedder: `voyage:voyage-4-large`, embedding profile `voyage-4-large-2048`
- Items: 310 answerable (194 dev, non-cross-lingual), 6 out-of-domain, 46 near-miss, 34 cross-lingual
- Scoring: max cosine over the original question and its fixture translations (no HyDE) against the grouping centroids
- Threshold: 5th percentile (nearest rank, lower) of dev-split answerable, non-cross-lingual scores, per grouping
- Embedding calls: 11 (1078 texts)

| Grouping | Centroids | Threshold | Answerable below | Out-of-domain below (of 6) | Near-miss below (of 46) | Cross-lingual below (max / original only) |
|----------|-----------|-----------|------------------|------------------------|--------------------|--------------------------------------------|
| tenant | 1 | 0.092 | 14 | 0 | 3 | 0 / 1 |
| tenant_language | 3 | 0.107 | 16 | 0 | 3 | 0 / 1 |
| doc_type | 5 | 0.156 | 11 | 2 | 3 | 0 / 1 |
| doc_type_language | 10 | 0.166 | 9 | 1 | 3 | 0 / 1 |
| d34_all | 13 | 0.167 | 10 | 1 | 3 | 0 / 1 |

**Verdict: `d34_separates_at_least_as_well = false`** (out-of-domain below: doc_type_language 1, doc_type 2; answerable below: doc_type_language 9, doc_type 11).

Measurement on synthetic fixtures with a real embedding profile; it calibrates nothing and never changes the D-34 grouping.
