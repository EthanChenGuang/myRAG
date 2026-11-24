# Retrieval sweep

Mode: fixture (fixture numbers prove the tooling only; they never replace the committed params)

Scope: dev split only; the test split is never read (D-14).

Selection rule: Smallest candidate pool whose Recall@k and MRR are both within the noise band of the best cell; ties on pool size go to the lower mean context tokens, then the lower latency p95.

- run config: v2-recommended (sha256 a6c8b44ea3551b70c0d70856af6b8dbe24b6361521d50f990bfb2ef04e99e9d2)
- golden (dev items): sha256 35190de6a0102a6a803525512c2ef910a2a6758063afe9e85d6e8f53d57232de
- grid: pools [25, 50, 75, 100], top-k [5, 8, 10, 15, 20] (sha256 79f993d5a30b23bc54949bb2f903d89770ad60221782dd5e9b2deb6822abb418)
- noise band: 0.0200 = max(k 3.0 x spread 0.0000, floor 0.02)

| Pool | Cap | Top-k | Recall@k | MRR | Context tokens | Latency p95 (ms) | In band | Chosen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 25 | 50 | 5 | 0.7442 | 0.6471 | 533.1 | 54.0 | no |  |
| 25 | 50 | 8 | 0.7558 | 0.6490 | 805.1 | 55.0 | no |  |
| 25 | 50 | 10 | 0.7558 | 0.6490 | 989.4 | 71.0 | no |  |
| 25 | 50 | 15 | 0.7674 | 0.6501 | 1434.7 | 76.0 | no |  |
| 25 | 50 | 20 | 0.7791 | 0.6507 | 1857.5 | 64.0 | yes | chosen |
| 50 | 50 | 5 | 0.7442 | 0.6471 | 531.2 | 94.0 | no |  |
| 50 | 50 | 8 | 0.7558 | 0.6490 | 808.0 | 152.0 | no |  |
| 50 | 50 | 10 | 0.7558 | 0.6490 | 990.8 | 100.0 | no |  |
| 50 | 50 | 15 | 0.7674 | 0.6501 | 1437.9 | 98.0 | no |  |
| 50 | 50 | 20 | 0.7791 | 0.6507 | 1858.4 | 109.0 | yes |  |
| 75 | 75 | 5 | 0.7442 | 0.6471 | 537.0 | 148.0 | no |  |
| 75 | 75 | 8 | 0.7558 | 0.6490 | 818.9 | 129.0 | no |  |
| 75 | 75 | 10 | 0.7558 | 0.6490 | 1001.3 | 129.0 | no |  |
| 75 | 75 | 15 | 0.7791 | 0.6509 | 1453.0 | 145.0 | yes |  |
| 75 | 75 | 20 | 0.7907 | 0.6514 | 1876.8 | 144.0 | yes |  |
| 100 | 100 | 5 | 0.7442 | 0.6471 | 537.0 | 133.0 | no |  |
| 100 | 100 | 8 | 0.7558 | 0.6490 | 818.9 | 120.0 | no |  |
| 100 | 100 | 10 | 0.7558 | 0.6490 | 1001.3 | 140.0 | no |  |
| 100 | 100 | 15 | 0.7791 | 0.6509 | 1453.0 | 122.0 | yes |  |
| 100 | 100 | 20 | 0.7907 | 0.6514 | 1876.8 | 123.0 | yes |  |

Chosen: pool 25, rerank input cap 50, top-k 20 (best Recall@k 0.7907, best MRR 0.6514).

Params file: not written (needs --write-params and a live --base-url).

- Fixture run: the params file was not touched (D-12).
