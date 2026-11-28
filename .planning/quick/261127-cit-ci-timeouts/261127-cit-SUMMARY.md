---
quick_id: 261127-cit
status: complete
---

# Summary: CI timeouts in pr-smoke (ts-db, ts-tsx, ts-vitest)

## Root cause
- **Imbalance, not volume, for ts-db.** `node --test --test-shard=k/N` splits by file index, so slow neighbouring files cluster. Run 46022738413 (main 00afa6d9) spent 6, 12, 21, 18, 13, 8, 10, 16, 8 and 4 min in the ten shards on the same file set. Run 46077840057 (PR #136, frontend only) had shard 3/10 at 24 min, cancelled by the 25 min cap. Total ts-db suite time is about 286 min, about 9.5 min per shard if balanced.
- **Two pathological files.** `activation-gate.test.mts` and `activation-gate-external.test.mts` insert a constant 1024-dim vector per chunk in every test and roll the transaction back. The dead rows stay in the halfvec HNSW indexes until a vacuum, so each insert walks a growing graph of identical points: the insert grew from 0.1 s to 58 s within one file. The two files took 6 min 54 s and 8 min 07 s alone; on CI one describe took 522 s.
- **ts-tsx was one unsharded job.** Its two steps, tsx (9 to 12 min) and rag-e2e (9 to 11 min), plus setup reached the 25 min cap on main (gap 6).
- **eval-corpus multi-tenant test.** It called `runEval` twice, and each call built a full multi-tenant fixture database. That is 122 s on CI, past its 120 s test timeout; the rest of the file and shard were fine (637 s shard, cap 25 min).
- Per-file times come from the pr-smoke TAP logs: each top-level suite is mapped to its file by title within that shard's file set. Local and CI suite times agree within a median ratio of 1.01 on the files measured both ways.

## Changes
- `tests/eval-corpus.test.ts`: one `prepareInProcessEval` session (also allowing the other user's scope) serves both tracer requests through `retainInProcess`; the assertions are unchanged. Locally 65.5 s → 33.1 s.
- `tests/rag-db/activation-gate.test.mts`, `activation-gate-external.test.mts`: `VACUUM chunk_embeddings` after each test's ROLLBACK. 6 min 54 s → 33 s and 8 min 07 s → 34 s; 22 tests each, all pass.
- `scripts/ci/test-shards.mjs` with `scripts/ci/test-durations.json`: duration-weighted sharding. Files go longest first to the lightest shard, and each shard lists its files longest first, since node starts them in the order given. An unrecorded file weighs the median, so new tests still run. A shard with no file is refused, so `node --test` never falls back to discovering the whole repo. `--plan=N` shows the split; `--measure=` refreshes the durations. The self-test is `scripts/tests/test-shards.node-test.mjs` (9 tests), and it runs in ts-checks.
- `.github/workflows/pr-smoke.yml`: ts-db goes to 12 planner shards (from 10 index shards). ts-tsx goes to 3 planner shards covering `tests/*.test.mts` and `tests/rag-e2e/*.test.mts` (from one job), with timeout 15. Each timeout carries a comment with its reasoning. The `pr-smoke` aggregate `needs` lists job names, which are unchanged, so it covers the new matrix entries as before.
- `scripts/ci/check-workflows.py`: ts-db and ts-tsx must pass `scripts/ci/test-shards.mjs --shard=${{ matrix.shard }}`, and globs given to the planner count as covered. The planner self-test is a required ts-checks command. There are 4 new tests in `scripts/tests/test_check_workflows.py`.
- No test was skipped, disabled, quarantined, removed from CI or reduced in coverage.

## Timeouts, with reasoning
| Job | Before: timeout / observed test step | After: timeout / estimated test step (+~1.5 min setup) | Headroom |
| --- | --- | --- | --- |
| ts-db | 25 / 4–24 min per shard, cancelled at 25 | 40 (train 38's value, kept verbatim) / ~7.7 min on 10 shards, ~10 min on one, 14.4 min on the shard holding `schema-migrations` (862 s, one file's suites run in series, the floor for any shard count) | 2.5x on the slowest shard, ~4x on the rest; run-to-run variance seen on the same commit is ~1.3x. 25 would already leave 1.5x |
| ts-tsx | 25 / 18.8–23 min, cancelled at 25 on main | 15 / ~5.2–5.5 min per shard (longest file `security-gaps-rls` 5.5 min) | 2x |
| ts-vitest | 25 / 7–14 min per shard; one test at 122 s > 120 s | 25 / 7–14 min, the eval-corpus multi-tenant test about half as long (≈60 s on CI) | 1.6x on the job; the test timeout becomes 240 s on train 38, about 4x the new ≈60 s |

The six 05.2.1-12 corpus documents on train 38 make fixture builds somewhat slower than the main-based durations used here. Files new on train 38 weigh the median until the durations file is refreshed.

Estimates simulate 3 workers (the runner's node:test concurrency) per shard over the recorded durations, with files in planner order. The lint caps TS job timeouts at 25 min.

## Local shard runs (as the CI step runs them)
- ts-tsx 2/3 (17 files): 233 s against an estimate of 5.2 min. With rag-sidecar not yet synced locally, 11 tests failed and 17 were cancelled in 6 suites, all on `Failed to download click==8.5.1`, a sidecar venv CI does sync. After `uv sync --directory rag-sidecar --locked --extra chunking --extra preflight`, those five files pass 48/48.
- ts-db 5/12 (22 files): 464 s (7.7 min, the estimate exactly), exit 0, 332 tests, 329 pass, 0 fail, 0 cancelled.

## Overlap with ci/merge-train-38 (859c2a95, d07b59ec)
- Train 38 raises the ts-db timeout to 40 and lets check-workflows allow it (`TS_TIMEOUT_MAX_BY_JOB`). It also raises vitest testTimeout/hookTimeout to 120 s / 180 s and the eval-corpus `TIMEOUT_MS` to 240 s.
- This branch takes the ts-db timeout lines and the lint cap byte for byte (3d75f693); the shard note sits on the matrix instead. It leaves vitest.config.ts and `TIMEOUT_MS` alone. A trial merge of this branch into origin/ci/merge-train-38 has no conflicts, and in the merged tree check-workflows and its unit tests pass.
- Train 38's comment "slowest shard needs up to ~35 minutes" describes the index-sharded suite before these fixes; with the planner the estimate is 14.4 min plus setup.

## Gates run
- `uv run --all-extras --frozen --directory eval python ../scripts/ci/check-workflows.py`: OK. `python -m unittest discover -s ../scripts/tests -p 'test_check_workflows.py'`: 202 tests OK.
- `node --test scripts/tests/test-shards.node-test.mjs`: 9 pass.
- `npx vitest run tests/eval-corpus.test.ts`: 6 passed.
- `node --import tsx --test tests/rag-db/activation-gate.test.mts tests/rag-db/activation-gate-external.test.mts`: 22 + 22 pass.
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.

## Follow-ups (not done here)
- The prechunked fixture build costs ~30 s (an empty database is 3 s; the rest is the corpus load). `schema-migrations` builds one per test. Snapshotting built fixtures with PGlite `dumpDataDir`/`loadDataDir`, keyed on options, env and content hashes, would cut ts-db time broadly but changes the shared harness.
- Refresh `scripts/ci/test-durations.json` when the suite grows a lot: `node scripts/ci/test-shards.mjs --measure=scripts/ci/test-durations.json tests/rag-db/*.test.mts tests/*.test.mts tests/rag-e2e/*.test.mts`.
