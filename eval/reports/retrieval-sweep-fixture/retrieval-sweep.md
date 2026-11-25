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
| 25 | 50 | 5 | 0.8605 | 0.7634 | 611.7 | 95.0 | no |  |
| 25 | 50 | 8 | 0.8837 | 0.7672 | 929.3 | 72.0 | no |  |
| 25 | 50 | 10 | 0.8837 | 0.7672 | 1145.1 | 69.0 | no |  |
| 25 | 50 | 15 | 0.8953 | 0.7683 | 1669.4 | 74.0 | no |  |
| 25 | 50 | 20 | 0.9070 | 0.7689 | 2172.5 | 66.0 | yes | chosen |
| 50 | 50 | 5 | 0.8605 | 0.7634 | 610.0 | 98.0 | no |  |
| 50 | 50 | 8 | 0.8837 | 0.7672 | 932.5 | 95.0 | no |  |
| 50 | 50 | 10 | 0.8837 | 0.7672 | 1145.9 | 93.0 | no |  |
| 50 | 50 | 15 | 0.8953 | 0.7683 | 1674.0 | 106.0 | no |  |
| 50 | 50 | 20 | 0.9070 | 0.7689 | 2175.1 | 105.0 | yes |  |
| 75 | 75 | 5 | 0.8605 | 0.7634 | 615.8 | 135.0 | no |  |
| 75 | 75 | 8 | 0.8837 | 0.7672 | 942.7 | 133.0 | no |  |
| 75 | 75 | 10 | 0.8837 | 0.7672 | 1157.1 | 141.0 | no |  |
| 75 | 75 | 15 | 0.9070 | 0.7691 | 1689.1 | 127.0 | yes |  |
| 75 | 75 | 20 | 0.9186 | 0.7697 | 2192.1 | 128.0 | yes |  |
| 100 | 100 | 5 | 0.8605 | 0.7634 | 615.8 | 136.0 | no |  |
| 100 | 100 | 8 | 0.8837 | 0.7672 | 942.7 | 134.0 | no |  |
| 100 | 100 | 10 | 0.8837 | 0.7672 | 1157.1 | 128.0 | no |  |
| 100 | 100 | 15 | 0.9070 | 0.7691 | 1689.1 | 113.0 | yes |  |
| 100 | 100 | 20 | 0.9186 | 0.7697 | 2192.1 | 138.0 | yes |  |

Chosen: pool 25, rerank input cap 50, top-k 20 (best Recall@k 0.9186, best MRR 0.7697).

Params file: not written (needs --write-params and a live --base-url).

- Fixture run: the params file was not touched (D-12).
