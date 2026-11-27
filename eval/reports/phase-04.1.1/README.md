# Phase 4.1.1 terminology dictionary: on/off comparison

`comparison.json` holds one entry per run pair in `pairs`, built by `compare_terminology.py` from four fixture runs (prechunked, in-process, `--no-gate`):

| Pair | Off run config | On run config |
|------|----------------|---------------|
| `v2-default` | `eval/config/runs/v2-terminology-off.json` | `eval/config/runs/v2-terminology-on.json` |
| `v2-lexical` | `eval/config/runs/v2-lexical-terminology-off.json` | `eval/config/runs/v2-lexical-terminology-on.json` |

Each pair differs only in `RAG_TERMINOLOGY`. Bounds come from `eval/config/noise.json` and `eval/config/latency-budgets.json` as committed when the comparison ran (their sha256 is in `sources`). Verdict: `passed: true` for both pairs.

## Results

Colloquial-term slice (15 answerable `*-colloquial-term-*` items, both splits, report-only per EVAL-14):

| Pair | Recall@5 off → on | Recall@10 off → on | MRR off → on | MRR paired 95% CI |
|------|-------------------|--------------------|--------------|-------------------|
| `v2-default` | 1.000 → 1.000 | 1.000 → 1.000 | 0.509 → 0.579 | [0.000, 0.170] |
| `v2-lexical` | 1.000 → 1.000 | 1.000 → 1.000 | 0.538 → 0.739 | [0.086, 0.329] |

- Every other slice (overall, each language, each category of the 202 gated non-term items): paired difference zero on every noise metric, well inside the noise floor. No non-term item moved in any split.
- `no_answer` term items (3): refused at the same rate on and off (every item refused in both runs).
- `retrievalConfigHash`: the off and on runs share no hash in either pair, so the switch is part of the retrieval configuration.

Latency (on run, chat budgets):

| Pair | terminology p95 (budget) | search p95 (budget) | pre-generation total p50 / p95 (budget) |
|------|--------------------------|---------------------|------------------------------------------|
| `v2-default` | 1 ms (5) | 33 ms (400), off 31 | 44 / 63 ms (1000 / 2000), off 43 / 62 |
| `v2-lexical` | 1 ms (5) | 30 ms (400), off 32 | 31 / 41 ms (1000 / 2000), off 31 / 44 |

Fixture timings are in-process PGlite figures; live latency is an operator check (plan 15).

## What the fixture cannot show

The fixture corpus is smaller than the candidate pool, so every gold chunk is already among the candidates without the dictionary (Recall@k is 1.0 off and on). This comparison shows the ranking boost of `term:0`, not reach beyond the pool; reach is proven by plan 18's full-list tests (D-29, D-34). The items are synthetic placeholder terms only.

## Decision

The terminology dictionary stays off: `RAG_TERMINOLOGY`, `RAG_TERMINOLOGY_DENSE` and `RAG_TERMINOLOGY_MINING` remain `false` (D-30). Synthetic items only, report-only per EVAL-14; propose on after Phase 5.1.1 real colloquial items pass.

## Reproduce

```bash
for c in v2-terminology-off v2-terminology-on v2-lexical-terminology-off v2-lexical-terminology-on; do
  npm run test-rag -- --run-config eval/config/runs/$c.json --no-gate --out eval/out/p4110-14-$c
done
uv run --directory eval python ../eval/reports/phase-04.1.1/compare_terminology.py \
  --pair v2-default eval/out/p4110-14-v2-terminology-off eval/out/p4110-14-v2-terminology-on \
  --pair v2-lexical eval/out/p4110-14-v2-lexical-terminology-off eval/out/p4110-14-v2-lexical-terminology-on \
  --out eval/reports/phase-04.1.1/comparison.json
```
