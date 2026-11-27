# Phase 4.4 live record (plan 04.4-15)

Eval project only: project ref sha256 prefix `e95399923d23`. Never the production project.
Raw reports with real ids stay under the git-ignored `eval/reports/phase-04.4-live/inputs/` (`.gitignore`: `eval/reports/*/inputs/`).
This file holds metrics, counts, plan text and hashes only. Tenant keys are recorded as sha256 prefixes.

## Task 1: readiness gate — PASS (2026-11-27)

| Check | Result |
| --- | --- |
| `04.4-14-SUMMARY.md` present | yes |
| decision record status `not_flipped` | yes |
| `uv run --directory eval python -m rag_eval.lexical_compare --help` | exit 0 |
| `eval/harness/lexical-leg-run.mts`, `scripts/rag/bench-lexical-bm25.mts` present | yes |
| `inputs/` git-ignored | yes |

### Read-only catalog pre-check by the executor (not the task 2 verification)

Run with catalog queries only on the eval project, 2026-11-27. Nothing was applied or written.

| Object | anon EXECUTE/SELECT | authenticated | service_role | `search_path` | Note |
| --- | --- | --- | --- | --- | --- |
| `rag_bm25_search_chunks` | no | no | yes | `""` | carries `p_access_keys` (0932 body is live) |
| `rag_lexical_dl` | no | no | yes | `""` | |
| `rag_lexstats_check`, `_chunks_delete`, `_chunks_insert`, `_chunks_update`, `_compact`, `_compact_all`, `_compact_tenant`, `_disable`, `_enable`, `_rebuild`, `_status` | no | no | yes | `""` | |
| `rag_purge_hook_lexical_stats` | no | no | yes | `""` | |
| `rag_lexical_stats_state` | no | no | — | — | RLS on, 0 rows |
| `rag_lexical_stats_pending` | no | no | — | — | RLS on, 0 rows |
| `rag_lexical_df` | no | no | — | — | RLS on, 0 rows |
| `rag_lexical_corpus` | no | no | — | — | RLS on, 0 rows |

The 0900–0904 objects already exist on the eval project, and 0932 has redefined `rag_bm25_search_chunks`.
So the task 2 re-apply must run 0904 and then 0932 again (LIVE-RUNBOOK block H re-apply rule). Otherwise the access filter is lost.

## Checklist

- [ ] Task 2 (human-action): apply/re-apply 0900–0904 (+0932), anon and authenticated REST refusals, empty tables → line `migrations verified`
- [ ] Task 3 (human-verify): statistics built, `check` clean; four-arm comparison with the k1/b grid → line `comparison recorded`
- [ ] Task 4 (human-verify): real-Postgres benchmark at 30000, 300000, 1000000 chunks, plans, search-stage latency, cleanup counts → line `benchmark recorded`
- [ ] Task 5 (human-verify): owner decision in `eval/decisions/04.4-lexical-scoring.md` → line `decision recorded`

Exact steps are in `.planning/phases/04.4-true-bm25-lexical-scoring/04.4-15-CHECKPOINT.md`.

## Questions the live step must answer (from the decision record)

1. What are the real-set paired 95% intervals for `lexical_ts_rank_cd`, `rrf_ts_rank_cd`, `lexical_bm25` and `rrf_bm25`? They cover Recall@10, Recall@50, MRR and doc@1, overall and per language. Does the fixture's `duplicate_flood` coverage loss show up on real near-duplicates?
2. How does the k1 ∈ {0.9, 1.2, 1.5} × b ∈ {0.5, 0.75} grid compare? Does the best point beat the default beyond its interval?
3. What are the real-Postgres timings at 30000, 300000 and 1000000 chunks against the `search` budgets (chat and embed 400 ms, voice 300 ms)? This matters most for the shapes that hit the candidate cap.
4. How often does the cap change the top 10 on real queries? Are `common_only`-like queries frequent enough to justify the cap lever or D-27 pruning?

## Task 2: migrations and grants

_pending owner_

## Task 3: statistics and comparison

_pending owner_

## Task 4: benchmark, plans, latency

_pending owner_

## Task 5: decision

_pending owner_
