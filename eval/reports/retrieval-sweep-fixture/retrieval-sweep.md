# Retrieval sweep

Mode: fixture (fixture numbers prove the tooling only; they never replace the committed params)

Scope: dev split only; the test split is never read (D-14).

Selection rule: Smallest candidate pool whose Recall@k and MRR are both within the noise band of the best cell; ties on pool size go to the lower mean context tokens, then the lower latency p95.

- run config: v2-recommended (sha256 a6c8b44ea3551b70c0d70856af6b8dbe24b6361521d50f990bfb2ef04e99e9d2)
- golden (dev items): sha256 6dc3d0c37c23c49b2ce4aa81d0b04789e26d6d0735f8c6c595440f113e51b6f2
- grid: pools [25, 50, 75, 100], top-k [5, 8, 10, 15, 20] (sha256 79f993d5a30b23bc54949bb2f903d89770ad60221782dd5e9b2deb6822abb418)
- noise band: 0.0200 = max(k 3.0 x spread 0.0000, floor 0.02)

nDCG@k: k is the number of chunks kept in the context of each item; one credit per gold unit (span or evidence group); a refused item or an empty context scores 0 and is counted in k = 0. Report-only: not a selection criterion (D-07).

| Pool | Cap | Top-k | Recall@k | MRR | nDCG@k | k = 0 | Context tokens | Latency p95 (ms) | In band | Chosen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 25 | 25 | 5 | 0.8667 | 0.7860 | 0.8021 | 2 | 568.5 | 37.0 | no |  |
| 25 | 25 | 8 | 0.8867 | 0.7893 | 0.8092 | 2 | 887.5 | 42.0 | yes | chosen |
| 25 | 25 | 10 | 0.8867 | 0.7893 | 0.8092 | 2 | 1088.9 | 43.0 | yes |  |
| 25 | 25 | 15 | 0.9044 | 0.7905 | 0.8144 | 2 | 1598.0 | 41.0 | yes |  |
| 25 | 25 | 20 | 0.9044 | 0.7905 | 0.8144 | 2 | 2111.3 | 39.0 | yes |  |
| 50 | 50 | 5 | 0.8600 | 0.7858 | 0.8004 | 2 | 569.0 | 56.0 | no |  |
| 50 | 50 | 8 | 0.8867 | 0.7901 | 0.8098 | 2 | 888.3 | 52.0 | yes |  |
| 50 | 50 | 10 | 0.8867 | 0.7901 | 0.8098 | 2 | 1091.4 | 48.0 | yes |  |
| 50 | 50 | 15 | 0.9044 | 0.7912 | 0.8151 | 2 | 1599.7 | 53.0 | yes |  |
| 50 | 50 | 20 | 0.9044 | 0.7912 | 0.8151 | 2 | 2117.1 | 50.0 | yes |  |
| 75 | 75 | 5 | 0.8600 | 0.7824 | 0.7975 | 1 | 573.2 | 63.0 | no |  |
| 75 | 75 | 8 | 0.8867 | 0.7867 | 0.8069 | 1 | 893.6 | 61.0 | yes |  |
| 75 | 75 | 10 | 0.8889 | 0.7867 | 0.8078 | 1 | 1099.9 | 57.0 | yes |  |
| 75 | 75 | 15 | 0.9044 | 0.7879 | 0.8123 | 1 | 1609.2 | 56.0 | yes |  |
| 75 | 75 | 20 | 0.9044 | 0.7879 | 0.8123 | 1 | 2132.1 | 68.0 | yes |  |
| 100 | 100 | 5 | 0.8600 | 0.7791 | 0.7951 | 1 | 577.0 | 70.0 | no |  |
| 100 | 100 | 8 | 0.8867 | 0.7834 | 0.8044 | 1 | 899.2 | 77.0 | yes |  |
| 100 | 100 | 10 | 0.8889 | 0.7834 | 0.8053 | 1 | 1107.9 | 76.0 | yes |  |
| 100 | 100 | 15 | 0.9044 | 0.7846 | 0.8099 | 1 | 1618.3 | 81.0 | yes |  |
| 100 | 100 | 20 | 0.9044 | 0.7846 | 0.8099 | 1 | 2145.9 | 81.0 | yes |  |

Chosen: pool 25, rerank input cap 25, top-k 8 (best Recall@k 0.9044, best MRR 0.7912).

Params file: not written (needs --write-params and a live --base-url).

- Fixture run: the params file was not touched (D-12).
