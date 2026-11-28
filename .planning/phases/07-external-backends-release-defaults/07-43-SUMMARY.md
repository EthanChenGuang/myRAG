---
phase: 07-external-backends-release-defaults
plan: 43
subsystem: rag-eval
status: partial
blocked_by: "test-split budget (ledger 26/25): the plan 07-25 stage-B run outputs are not on this branch, so the fixture record cannot be annotated without new test-split runs"
tags: [release-defaults, adm-02, cost, latency, per-language, regression]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-17 CostSummary/LatencySummary/LanguageQuality contracts; 07-24 regression CLI and rules; 07-25 fixture record and stage-B plan"
  - phase: 04.1-hybrid-retrieval-and-rerank-on-by-default-proven-by-eval
    provides: "04.1-09 eval/decisions/04.1-retrieval-defaults.json (incumbent)"
provides:
  - "eval/src/rag_eval/release_costs.py: load_price_table, ingest_cost_per_1000, query_cost_per_1000, latency_summary, language_quality, annotate_record"
  - "config/rag/price-table.json: versioned unit prices with as_of; null means not provided"
  - "rag_eval.regression annotate [--check]; decide writes the cost, latency and per_language blocks itself"
  - "decide: language_below_baseline rule; an incumbent run that is not the Phase 4.1 decision exits 2"
affects: [07-30, 07-33]

actuals:
  tokens: 60000
  tasks: 3  # Tasks 2 and 3 complete; Task 1 code complete, record annotation blocked
  commits: 3

key-files:
  created:
    - config/rag/price-table.json
    - eval/src/rag_eval/release_costs.py
    - eval/tests/test_release_costs.py
  modified:
    - eval/src/rag_eval/regression.py
    - eval/tests/test_regression.py
  not-modified-blocked:
    - eval/config/release-defaults.json
    - eval/decisions/defaults-fixtures.md

requirements-completed: []
requirements-partial: [ADM-02]
---

# Phase 7 Plan 43: Cost, latency and per-language blocks of the defaults record (partial)

The code is done: the cost, latency and per-language computation, the price table, the `annotate` subcommand, and the decide hook with the language rule. The fixture record itself is **not annotated**.

The record has to be computed from the plan 07-25 stage-B run outputs (`eval/out/regression/regression-plan-fixtures-b/`). `eval/out/` is gitignored, so those outputs never reached this branch, and the 07-25 container is gone. Producing them again would mean re-running stage B on the test split. The test-split ledger is already at 26 uses against a budget of 25, and the orchestrator said not to add any. I stopped there.

The real command `uv run --directory eval python -m rag_eval.regression annotate --record eval/config/release-defaults.json --plan eval/decisions/regression-plan-fixtures-b.json --check` exits 2 with "no run outputs for this plan … annotate needs the stage-B runs". It writes nothing.

## Commits

| Task | Commit |
| --- | --- |
| 2 cost and latency rules, price table (with Task 1's module) | 0e5378cb |
| 1 `annotate` subcommand, 3 language rule and decide hook | 7a3cc966 |
| SUMMARY | this commit |

I committed the tests together with the code rather than as a separate RED commit. Instead, I ran the plan's two mutation guards, and each makes its test fail:
- Treating a null price as 0 fails `-k not_provided`.
- Removing the language rule from `decide` fails `-k language_below_baseline`.

## Behaviour

- **Price table** (`config/rag/price-table.json`):
  - Embedding prices are copied from `src/lib/rag/embeddings/catalog.ts`, the list prices that `prices.ts` reads.
  - Parse tier prices per page are copied from `config/rag/parse-routing.json`.
  - Everything else is `null`: enrichment, rerank (cohere, voyage), generation input and output, and external store per point and per request.
  - A test fails when an entry differs from its in-repo source, or when an entry with no source is not null.
- **Amount rules:**
  - A quantity that was not recorded gives `not_measured`, and this check comes first.
  - A measured quantity without a price gives `not_provided`.
  - A zero quantity costs 0.
  - pgvector has no external-store cost (0.0).
  - The rerankers `none` and `local_bm25` make no paid call. `auto` resolves to cohere only when the run env has `COHERE_API_KEY`.
  - Negative, NaN and non-numeric inputs raise.
- **Ingest cost**, per (embedding profile, backend) over the executed runs:
  - Parse cost is the sum of the attempts' `est_cost` when the run kept `ingest-ledger.json`. Otherwise it is pages × the tier price, and the basis says `estimated`.
  - Embedding, enrichment and stored-point counts come from `ingest-usage.json` when a run recorded it.
- **Query cost**, per decided configuration (the incumbent and the adopted run), from the traces:
  - rerank calls;
  - `usage` tokens;
  - external-store requests not served by a fallback.
  - Query-embedding tokens are not in the trace, so that part is `not_measured`.
- **Basis:** price-table sha256, document and query sample sizes, and `measured` or `estimated`.
- **Latency:**
  - Chat: the total (pre-generation, else `retrieval_total`) and every stage of `report.latency`.
  - Voice: the total from pre-generation.
  - Each value sits next to its budget from `latency-budgets.json` (total p50 from the profile, total p95 from pre-generation, stage budgets as p95) with `within_budget`.
  - Query-group stages are `report_only`.
- **Per-language quality:**
  - Covers each enabled language: `RAG_SUPPORTED_LANGUAGES` of the incumbent run when set, else the languages the run scored.
  - For each one: the adopted run's primary metric against `b.incumbent` on the paired items, plus the band from `noise.json`.
  - A language with fewer than `min_gate_n` items gives `below_baseline` None with reason `too_small`.
- **decide:**
  - The language rule runs after the ablation verdicts and before the confirmatory check. An adopted switch whose run leaves an enabled language below the incumbent becomes `keep_incumbent` with reason `language_below_baseline`.
  - `run` applies the same rule when it builds the confirmatory config, so `confirm` stays consistent with `decide`.
  - An incumbent run whose DFLT variables differ from the Phase 4.1 decision exits 2.
  - A final adopted configuration with any language below baseline exits 2, and no record is written.
  - decide now writes the three blocks itself, so a live decide no longer fails for lack of them.
  - The Markdown gains a "Cost, latency and per-language quality" section.
- **annotate:**
  - Recomputes the blocks from the run index and rewrites the record and that Markdown section.
  - With `--check` it exits 1 when either one differs, and writes nothing.
  - With no run outputs it exits 2.

## Tests that failed before the change

- `tests/test_release_costs.py` (22 tests) is new; the module did not exist.
- `tests/test_regression.py::test_a_live_decide_without_the_adm02_blocks_writes_nothing` asserted the old behaviour (a live decide exits 2 without the blocks). I replaced it with `test_a_live_decide_writes_the_adm02_blocks_itself` and `test_a_live_decide_with_an_unreadable_price_table_writes_nothing`.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `check-rag-boundary`, `check-config`, `check-language-literals`, `check-settings-classification`: all ok.
- `uv run --directory eval pytest -q tests/test_release_costs.py tests/test_regression.py tests/test_regression_rules.py`: 63 passed.
- `ruff check` on the changed files: clean.
- Mutation guards: both turn red, as listed above.
- The plan verification `annotate … --check`: **not passable** here. It exits 2 because the stage-B outputs are missing (see the top).
- Not run, because no TS, SQL, contract, workflow or retrieval code changed: vitest, rag-db, `gen:schemas`, `test-rag`.

## Deviations

1. **Task 1's record annotation was not done.** `eval/config/release-defaults.json` and `defaults-fixtures.md` are unchanged. Task 1's acceptance (the `jq` check and the "per 1,000 documents" grep in the decision Markdown) is therefore open.
2. **Signature split.** `annotate_record(record, plan, runs_dir, price_table, budgets_path, noise_path)` keeps the plan's signature. The pure part is `annotate_blocks`, and the regression CLI calls it through `annotate_decision`.
3. **Live-decide test replaced** (see above). It encoded the behaviour this plan is meant to change.
4. **`run` applies the language rule too**, so the registered confirmatory config matches what `decide` expects. This is a small extension in `run_stage_b_tail`.

## Operator actions

- Pick one of these to finish Task 1:
  - (a) Approve one more stage-B fixture pass on the test split. That is about 25 test-split uses, over the budget, recorded in the ledger with `--reason`. Then run `annotate`, which writes the record and the Markdown, and commit both.
  - (b) Accept that the fixture record stays without the blocks, and let the live run of plan 07-33 produce them through `decide`. The record is provisional, and DefaultsDecision allows the blocks to be missing on a provisional record.

  I recommend (b): fixture numbers only prove the computation, and the tests already prove that.
- Live run (07-33): fill the null prices in `config/rag/price-table.json` before `decide`.

## Deferred

- The eval harness does not write `ingest-usage.json` (embedding, enrichment and stored-point counts) or query-embedding token counts. Until it does, those parts read `not_measured`. A harness plan should record them.
- In prechunked runs the routing ledger (`ingest-ledger.json`) is written only with `--routing`. Ingest parse cost is therefore `not_measured` for prechunked stage-B runs.

## Decisions for STATE

- ADM-02 (07-43): the computation and the decide rule are shipped. The fixture record annotation is blocked by the test-split budget, and the owner chooses (a) or (b) above.
- The language rule (`language_below_baseline`) is part of `decide` and `run`, not only of the 07-30 CI check.
