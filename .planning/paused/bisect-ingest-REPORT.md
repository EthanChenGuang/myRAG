# Bisect ingest fixture eval regression

## Symptom

Ingest smoke (`npm run test-rag -- --fixture-mode ingest`) at trunk `6b8c854` reported overall **recall@10 = 0.523** vs committed baseline **0.6395** (`eval/baselines/fixture-ingest-baseline.json`). Prechunked smoke remained within noise (recall@10 ~0.519).

## Bisect

- **Good:** `7050bdd7` (merge plan 03-44 ingest baseline) — recall@10 0.640, gate PASS
- **Bad:** `6b8c854` — recall@10 0.523, gate FAIL
- **First bad commit:** `5d5c55f` — `feat(04-19): wire v2 retrieval dispatch and eval tracer`

Harness script: `/tmp/bisect-ingest-test.sh` (threshold recall@10 ≥ 0.60).

## Mechanism

`5d5c55f` changed `ragEnv()` in `src/lib/rag/deps.ts` to prefer **live `process.env`** over the frozen `@/lib/env` snapshot (`readRagEnvInput`), so eval harness pinned env is honored for v2 overlays.

Ingest fixture **build** sets `RAG_EXACT_ID_LOOKUP=true` (`eval/harness/ingest-mode.mts` harnessEnv). Before `5d5c55f`, the eval **retrieval** route still saw `exactIdLookup` as true because `@/lib/env` was frozen at ingest-build import time. After `5d5c55f`, the second `applyFixtureProcessEnv` in `prepareInProcessEval` reset retrieval to pinned smoke env (`RAG_EXACT_ID_LOOKUP=false`), disabling the `exact_id_lookup` stage.

Trace evidence on `en-compound-002`: good parent has `exact_id_lookup` in `stage_status`; first bad commit omits it and returns 0 candidates / refused.

The ingest baseline was recorded with exact-id lookup active at retrieval time; disabling it is not an intended product change.

## Fix

- Export `ingestModeRetrievalEnv()` from `eval/harness/ingest-mode.mts` (`RAG_EXACT_ID_LOOKUP: 'true'`).
- Merge into `prepareInProcessEval` when `fixtureMode === 'ingest'`.
- Regression test: `tests/rag-db/ingest-eval-retrieval-env.test.mts`.

## Verification (post-fix, trunk + fix)

| Mode | recall@10 (before) | recall@10 (after) | gate |
|------|-------------------|-------------------|------|
| ingest | 0.523 | 0.640 | PASS |
| prechunked | 0.519 | 0.519 | PASS |

Commands:

```bash
npm run test-rag -- --fixture-mode ingest --out eval/out/bisect-fixed
npm run test-rag -- --out eval/out/bisect-prechunked
node --import tsx --test tests/rag-db/ingest-eval-retrieval-env.test.mts
```