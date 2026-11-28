# Scope separation with a real embedding profile (06.2-42)

- Embedder: `bge-m3:BAAI/bge-m3`, embedding profile `bge-m3-1024`
- Items: 310 answerable (194 dev, non-cross-lingual), 6 out-of-domain, 46 near-miss, 34 cross-lingual
- Scoring: max cosine over the original question and its fixture translations (no HyDE) against the grouping centroids
- Threshold: 5th percentile (nearest rank, lower) of dev-split answerable, non-cross-lingual scores, per grouping
- Embedding calls: 11 (1078 texts)

| Grouping | Centroids | Threshold | Answerable below | Out-of-domain below (of 6) | Near-miss below (of 46) | Cross-lingual below (max / original only) |
|----------|-----------|-----------|------------------|------------------------|--------------------|--------------------------------------------|
| tenant | 1 | 0.398 | 13 | 6 | 7 | 0 / 2 |
| tenant_language | 3 | 0.4 | 12 | 6 | 6 | 0 / 3 |
| doc_type | 5 | 0.404 | 11 | 6 | 6 | 0 / 0 |
| doc_type_language | 10 | 0.413 | 15 | 6 | 6 | 0 / 0 |
| d34_all | 13 | 0.416 | 13 | 6 | 6 | 0 / 0 |

**Verdict: `d34_separates_at_least_as_well = false`** (out-of-domain below: doc_type_language 6, doc_type 6; answerable below: doc_type_language 15, doc_type 11).

Measurement on synthetic fixtures with a real embedding profile; it calibrates nothing and never changes the D-34 grouping.
