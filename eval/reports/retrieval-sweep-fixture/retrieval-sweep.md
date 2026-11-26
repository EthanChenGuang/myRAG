# Retrieval sweep

Mode: fixture (fixture numbers prove the tooling only; they never replace the committed params)

Scope: dev split only; the test split is never read (D-14).

Selection rule: Smallest candidate pool whose Recall@k and MRR are both within the noise band of the best cell; ties on pool size go to the lower mean context tokens, then the lower latency p95.

- run config: v2-recommended (sha256 a6c8b44ea3551b70c0d70856af6b8dbe24b6361521d50f990bfb2ef04e99e9d2)
- golden (dev items): sha256 36b1de436619f02168f50400f14628fe6e5aef78643f607b7107cabed4a0e30b
- grid: pools [25, 50, 75, 100], top-k [5, 8, 10, 15, 20] (sha256 79f993d5a30b23bc54949bb2f903d89770ad60221782dd5e9b2deb6822abb418)
- noise band: 0.0200 = max(k 3.0 x spread 0.0000, floor 0.02)

nDCG@k: k is the number of chunks kept in the context of each item; one credit per gold unit (span or evidence group); a refused item or an empty context scores 0 and is counted in k = 0. Report-only: not a selection criterion (D-07).

| Pool | Cap | Top-k | Recall@k | MRR | nDCG@k | k = 0 | Context tokens | Latency p95 (ms) | In band | Chosen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 25 | 25 | 5 | 0.8636 | 0.7773 | 0.7942 | 2 | 618.6 | 50.0 | no |  |
| 25 | 25 | 8 | 0.8737 | 0.7785 | 0.7981 | 2 | 951.6 | 49.0 | no |  |
| 25 | 25 | 10 | 0.8813 | 0.7793 | 0.8003 | 2 | 1161.1 | 49.0 | yes | chosen |
| 25 | 25 | 15 | 0.8914 | 0.7799 | 0.8033 | 2 | 1694.6 | 58.0 | yes |  |
| 25 | 25 | 20 | 0.8990 | 0.7803 | 0.8050 | 2 | 2223.7 | 43.0 | yes |  |
| 50 | 50 | 5 | 0.8561 | 0.7764 | 0.7913 | 2 | 618.1 | 78.0 | no |  |
| 50 | 50 | 8 | 0.8737 | 0.7787 | 0.7977 | 2 | 953.5 | 76.0 | no |  |
| 50 | 50 | 10 | 0.8838 | 0.7795 | 0.8010 | 2 | 1164.9 | 73.0 | yes |  |
| 50 | 50 | 15 | 0.8914 | 0.7801 | 0.8030 | 2 | 1697.9 | 76.0 | yes |  |
| 50 | 50 | 20 | 0.8990 | 0.7805 | 0.8048 | 2 | 2228.1 | 77.0 | yes |  |
| 75 | 75 | 5 | 0.8561 | 0.7764 | 0.7913 | 1 | 626.4 | 101.0 | no |  |
| 75 | 75 | 8 | 0.8737 | 0.7787 | 0.7977 | 1 | 968.7 | 94.0 | no |  |
| 75 | 75 | 10 | 0.8838 | 0.7795 | 0.8010 | 1 | 1182.1 | 90.0 | yes |  |
| 75 | 75 | 15 | 0.8914 | 0.7801 | 0.8030 | 1 | 1722.4 | 92.0 | yes |  |
| 75 | 75 | 20 | 0.8990 | 0.7805 | 0.8048 | 1 | 2262.7 | 82.0 | yes |  |
| 100 | 100 | 5 | 0.8561 | 0.7764 | 0.7913 | 1 | 627.0 | 108.0 | no |  |
| 100 | 100 | 8 | 0.8737 | 0.7787 | 0.7977 | 1 | 967.9 | 91.0 | no |  |
| 100 | 100 | 10 | 0.8838 | 0.7795 | 0.8010 | 1 | 1182.5 | 105.0 | yes |  |
| 100 | 100 | 15 | 0.8914 | 0.7801 | 0.8030 | 1 | 1722.4 | 98.0 | yes |  |
| 100 | 100 | 20 | 0.8990 | 0.7805 | 0.8048 | 1 | 2263.0 | 113.0 | yes |  |

Chosen: pool 25, rerank input cap 25, top-k 10 (best Recall@k 0.8990, best MRR 0.7805).

Params file: not written (needs --write-params and a live --base-url).

- Fixture run: the params file was not touched (D-12).
