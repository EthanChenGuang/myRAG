# Phase 4.1 — CI-equivalent run with the shipped defaults (not flipped)

The retrieval defaults were not flipped (`eval/decisions/04.1-retrieval-defaults.json` status `not_flipped`, owner decision 2026-11-26), so this run proves the shipped legacy default. It ran once, in order, with no retrieval variable set beyond the eval pin (`RAG_PIPELINE=legacy`, `RAG_SUPPORTED_LANGUAGES=zh,en,it`, `RAG_PRIMARY_LANGUAGE=en`). Every figure below is read from this run's `report.json` / `gate.json` under `eval/out/p41-postflip/`.

## Commands and exit codes

| # | Command | Exit code |
|---|---|---|
| 1 | `npm run test-rag -- --out eval/out/p41-postflip/smoke` | 0 |
| 2 | `npm run test-rag -- --fixture-mode ingest --out eval/out/p41-postflip/smoke-ingest` | 0 |
| 3 | `npm run test-rag -- --run-config eval/config/runs/legacy.json --baseline eval/baselines/fixture-baseline.json --out eval/out/p41-postflip/smoke-legacy && jq -e '.paired.all_zero == true' eval/out/p41-postflip/smoke-legacy/gate.json` | 0 |
| 4 | `npm run test-rag -- --run-config eval/config/runs/legacy.json --fixture-mode ingest --baseline eval/baselines/fixture-ingest-baseline.json --out eval/out/p41-postflip/smoke-legacy-ingest && jq -e '.paired.all_zero == true' eval/out/p41-postflip/smoke-legacy-ingest/gate.json` | 0 |
| 5 | `npm run test-rag -- --run-config eval/config/runs/sec-recommended.json --out eval/out/p41-postflip/smoke-sec` | 0 |
| 6 | `npm run test-rag -- --degrade drop_top_candidate --out eval/out/p41-postflip/negative-degrade; c=$?; test $c -eq 10 && jq -e '.passed == false and (.mismatches \| length == 0)' eval/out/p41-postflip/negative-degrade/gate.json && jq -e '[.offenders[] \| select(.slice == "overall" and .metric == "mrr") \| (.threshold - .observed)] \| (length == 1 and .[0] >= 0.05)' eval/out/p41-postflip/negative-degrade/gate.json` | 0 |
| 7 | `npm run test-rag -- --max-results 1 --out eval/out/p41-postflip/negative; c=$?; test $c -eq 10 && jq -e '.passed == false and (.offenders \| length > 0) and (.mismatches \| length == 0)' eval/out/p41-postflip/negative/gate.json` | 0 |
| 8 | `npx vitest run tests/rag/characterize-*.test.ts tests/rag/v2/readiness.test.ts tests/rag/v2/language-fallback.test.ts` | 0 |
| 9 | `node scripts/check-config.mjs` | 0 |
| 10 | `npx tsx eval/harness/eval-env.mts --check` | 0 |
| 11 | `npm run gen:schemas && git diff --exit-code -- rag-sidecar/schemas src/lib/rag-eval/contracts.generated.ts tests/fixtures/contracts/samples.json` | 0 |
| 12 | `npm run typecheck:new` | 0 |
| 13 | `node scripts/ci/check-rag-boundary.mjs` | 0 |
| 14 | `node --test scripts/check-config.test.mjs` | 0 |

The two negative checks are wrapped so that 0 means the gate rejected the degraded run with exit code 10 as designed.

## Legacy tiers

- `smoke-legacy` paired.all_zero: true
- `smoke-legacy-ingest` paired.all_zero: true

## Overall metrics

| Tier | Recall@10 | MRR | correct refusal | false refusal |
|---|---|---|---|---|
| smoke | 0.538 (n=132) | 0.519 (n=132) | 0.708 (n=24) | 0.364 (n=132) |
| smoke-legacy | 0.538 (n=132) | 0.519 (n=132) | 0.708 (n=24) | 0.364 (n=132) |
| smoke-ingest | 0.711 (n=166) | 0.606 (n=166) | 0.552 (n=29) | 0.205 (n=166) |
| smoke-legacy-ingest | 0.711 (n=166) | 0.606 (n=166) | 0.552 (n=29) | 0.205 (n=166) |

Default and legacy are identical in each fixture mode because the shipped default is legacy.

## Protected files

`git diff --exit-code eval/baselines eval/config/refusal-thresholds.json eval/config/defaults-gate.json eval/config/retrieval-params.json eval/decisions`: no change.
