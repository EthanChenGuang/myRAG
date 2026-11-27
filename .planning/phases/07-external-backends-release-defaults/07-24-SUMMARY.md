---
phase: 07-external-backends-release-defaults
plan: 24
subsystem: rag-eval
tags: [regression, release-defaults, paired-bootstrap, holm, pre-registration, test-split-ledger, adm-02]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-17 release contracts: RegressionPlan, RegressionRunConfig, TestSplitUse, SwitchVerdict, BackendComparison, BackendResult, DefaultsDecision"
  - phase: 01-evaluation-harness-baseline
    provides: "01-20 paired bootstrap (seed 20261123, 10000 resamples) and the noise-band gate"
  - phase: 04-hybrid-retrieval-reranking-calibrated-refusal
    provides: "04-40 phase_compare (multi-config precedent); 04.1-09 eval/decisions/04.1-retrieval-defaults.json (incumbent)"
  - phase: 05-verified-citations-groundedness
    provides: "05-25 closing plan; RAG_CITATIONS, RAG_GROUNDEDNESS in the ablation list"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-22 closing plan; RAG_CONTEXT_TAGGING, RAG_INJECTION_CHECK and the recommended configuration"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-45 closing plan; RAG_QUERY_LAYER, RAG_QUERY_FRAMEWORK, RAG_QUERY_HYDE"
provides:
  - "eval/src/rag_eval/paired.py: paired_p_value and _resample_means, one resampling loop shared with _bootstrap_interval"
  - "eval/src/rag_eval/regression_rules.py: decide_switch, decide_backend, holm_adjust, apply_holm, gate_slices, primary_outcome, latency_ok, run_invalid_reason, RunSummary, RuleSettings"
  - "eval/src/rag_eval/regression.py: `python -m rag_eval.regression plan|run|decide`, the HarnessRunner protocol, SubprocessHarness, the test-split ledger, StageADecision, the DefaultsDecision and decision Markdown writers"
affects: [07-25, 07-30, 07-33, 07-43]

actuals:
  tokens: 28600
  tasks: 3
  commits: 8  # 3 RED, 3 GREEN, 1 perf, SUMMARY

tech-stack:
  added: []
  patterns:
    - "Ablation and confirmatory configs are registered relative to the stage-B winner and resolved deterministically by run and decide, so the plan hash pre-registers them before the winner is known"
    - "The harness runner is a protocol; tests inject a fake that writes report.json, traces.jsonl and run.json"

key-files:
  created:
    - eval/src/rag_eval/regression_rules.py
    - eval/src/rag_eval/regression.py
    - eval/tests/test_regression_rules.py
    - eval/tests/test_regression.py
  modified:
    - eval/src/rag_eval/paired.py
    - eval/tests/test_paired.py

key-decisions:
  - "paired_p_value is the one-sided share of resample means <= 0, read from the same generator as the interval; all-zero differences give 1.0, no differences give None"
  - "Primary metric: judge answer correctness (per-item mean of the judge's faithfulness and answer_relevance scores from judge.json) when both runs have judge scores; else Recall@10 and correct refusal as a pair (a gain beyond the band on one, no loss beyond the band on the other)"
  - "Holm-Bonferroni runs over every ablation verdict with a p-value; a gain adoption survives only with p_holm <= alpha; security adoptions under the tie rule are not touched by Holm but must hold every gate and show no primary loss beyond the band"
  - "An adoption needs a measured injection attack-success rate of exactly 0 (the SwitchVerdict contract requires it); an unmeasured rate keeps the incumbent (injection_not_measured)"
  - "Latency: chat and voice p95 from the report's pre_generation (chat falls back to retrieval_total) against latency-budgets.json pre_generation, else the profile total; a channel the run did not measure cannot fail"
  - "Only backend_not_ready, backend_error and backend_slow fallbacks invalidate a run (filter_unsupported does not); backend_impl fake invalidates only external-backend runs; backend_impl is read from run.json top level or one level down, since 07-25 adds that key"
  - "The slice gate compares the paired mean against the band (no bootstrap); slices with fewer than min_gate_n paired items are listed as too small and never decide"
  - "Incumbent: the five DFLT variables from the 04.1 decision defaults, today's shipped value (SHIPPED_DEFAULTS, from src/lib/env.ts) for every other variable; a missing or malformed 04.1 file stops plan, run and decide with exit 2"
  - "Stage A base env is the incumbent plus Phase 5.1's recommended security overlay (RAG_CONTEXT_TAGGING=true, RAG_INJECTION_CHECK=drop); a non-legacy embedding profile adds RAG_EMBEDDING_PROFILES=on and RAG_PIPELINE=v2"
  - "D-17 ablation list (17): RAG_PIPELINE, RAG_LEXICAL_SEARCH, RAG_REFUSAL_THRESHOLD, RAG_CONTEXT_EDGE_ORDER, RAG_CONTEXT_COMPRESSION, RAG_PARENT_CHILD, RAG_HNSW_ITERATIVE_SCAN (relaxed_order), RAG_LEXICAL_TRANSLATION (needs lexical), RAG_QUERY_LAYER, RAG_QUERY_FRAMEWORK and RAG_QUERY_HYDE (both need the layer), RAG_CITATIONS, RAG_GROUNDEDNESS, RAG_CONTEXT_TAGGING, RAG_INJECTION_CHECK (drop), RAG_INGEST_PIPELINE (unified), RAG_EMBEDDING_PROFILES. The query transforms that already default on (condense, expand, decompose, translate, date normalization) are not ablated"
  - "An ablation flips its switch on the winner; when the winner already holds the challenger value the run flips it back to the incumbent value; a dependent switch compares against the parent's ablation run; an ablation that would leave a non-legacy embedding profile without RAG_EMBEDDING_PROFILES=on and v2 is skipped (required_by_embedding_profile) and records no test-split use"
  - "Stage-B winner: the best stage-A combination on pgvector that beats the incumbent under the rule, else the incumbent; the backend comparison uses that combination (or the top one for reporting); an external win applies only with an adopted combination and never in a fixture record (fixture_record_keeps_pgvector)"
  - "Confirmatory run: the winner plus every adopted switch, checked against the incumbent for every gate and no primary loss; on failure every adopted switch reverts to the incumbent (reason confirmatory_failed)"
  - "Test-split ledger lines are TestSplitUse plus golden_set (fixtures or private) and split (test); a use is appended before the harness call, so a failed run still counts; re-running `run` reuses recorded outputs; --rerun of a used config and --extra-config are unregistered uses that need --reason (exit 2 otherwise)"
  - "Run-config layout: env holds every switch (the in-process overlay, or a redeploy for live runs confirmed per config with --interactive-env; a live run without it is refused); overrides hold backend, embedding_profile and rerank_model; SubprocessHarness passes backend and rerank_model as retrieval_overrides and the embedding profile as --embedding-profile"
  - "Reranker axis specs are provider[:model]; fixture defaults are none, local_bm25, auto and cohere:fake-quality-v1 (with the existing COHERE_API_KEY=fixture placeholder); the DefaultsDecision maps keep only incumbent variable names, so no key reaches the record"
  - "decide without --fixtures fails validation until plan 07-43 adds the cost, latency and per-language blocks; it exits 2 and writes nothing"

patterns-established:
  - "Pre-registered relative configs: a plan registers deltas against a winner chosen later by a deterministic rule"

requirements-completed: [ADM-02]

coverage:
  - id: D1
    description: "paired_p_value shares the bootstrap draws; existing intervals unchanged"
    requirement: ADM-02
    verification:
      - kind: unit
        ref: "eval/tests/test_paired.py"
        status: pass
  - id: D2
    description: "D-18 decision rule: band, gated slices with min_gate_n, latency, injection ASR 0, security ties, Holm, backend CI rule, invalid runs"
    requirement: ADM-02
    verification:
      - kind: unit
        ref: "eval/tests/test_regression_rules.py"
        status: pass
  - id: D3
    description: "plan, run and decide with pre-registration, test-split ledger, unregistered-run refusal and validated records"
    requirement: ADM-02
    verification:
      - kind: unit
        ref: "eval/tests/test_regression.py"
        status: pass
---

# Phase 7 Plan 24: Regression statistics and protocol Summary

The release regression's statistics and protocol now exist: a paired p-value from the shared bootstrap, the D-18 decision rule with Holm-Bonferroni and the min_gate_n slice rule, and a `plan | run | decide` CLI that pre-registers configs, counts every test-split use and writes a validated DefaultsDecision with its Markdown record.

## Commits

| Task | RED | GREEN |
| --- | --- | --- |
| 1 paired_p_value | 6447603e | 1c928c39 |
| 2 decision rule | 10c4f15d | edf684ac (perf follow-up b612fd43) |
| 3 plan, run, decide | 3842d6c5 | e93d7fc6 |

Each RED commit failed on assertions: the stubs returned placeholder values or a non-zero exit, so no test failed on an import.

## Accomplishments

- `paired_p_value(differences)` returns the share of the 10000 resample means (seed 20261123) that are at most 0, drawn by `_resample_means`, the generator `_bootstrap_interval` now uses as well. Recorded intervals for three vectors are unchanged.
- `regression_rules.py` holds pure functions over `RunSummary` values. They return the 07-17 contract types `SwitchVerdict` and `BackendComparison`.
- `regression.py`:
  - `plan --stage a` registers every embedding profile x reranker pair on pgvector on the dev split (budget 0).
  - `plan --stage b --stage-a-decision` registers the incumbent, the top two combinations on pgvector, weaviate and qdrant, one ablation per D-17 switch and one `confirm` config. Its budget equals the config count (25).
  - `run` executes the configs through the harness runner and writes `regression-run.json` with the config hashes.
  - `decide` writes the stage-A ranking, or the defaults record plus `defaults-fixtures.md` / `defaults-<date>.md`.

## Behaviour changes

None for the app, eval gates or shipped defaults. The only existing file whose code changed is `paired.py`, and its interval output is unchanged. Nothing writes `eval/config/release-defaults.json` or the ledger until an operator or plan 07-25 runs the CLI.

## Tests that failed before the change

- `tests/test_paired.py`: five p-value tests.
- `tests/test_regression_rules.py`: 23 of 25 tests.
- `tests/test_regression.py`: all 15 tests.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all ok.
- `uv run --directory eval pytest -q tests/test_paired.py tests/test_regression_rules.py tests/test_regression.py tests/test_gate.py`: 118 passed.
- The full eval suite, because `paired.py` is shared: `uv run --directory eval pytest -q tests`, 2437 passed.
- `ruff check` on the touched files: clean.
- Not run:
  - vitest: no TypeScript changed.
  - The rag-db, sidecar and workflow gates, and `gen:schemas`: no SQL, sidecar, workflow or contract changes.
  - `test-rag`: no retrieval, ingest, generation or golden-set change.
  - The UI gate: no UI.
- Acceptance greps:
  - `def paired_p_value` = 1
  - `SEED = 20261123` = 1
  - `def holm_adjust` = 1
  - `test-split-ledger.jsonl` = 2
- `-k too_small`: 2 passed. `-k unregistered`: 2 passed.

## Deviations

- The ledger needs two fields `TestSplitUse` lacks: golden set and split. Rather than editing the 07-17 contract, `LedgerLine` subclasses `TestSplitUse` and adds them. `LedgerLine.use()` gives the `TestSplitUse` that goes into the record.
- The stage-A ranking is a local `StageADecision` model (no contract existed). By default it is written next to the plan as `<plan>.decision.json`.
- Judge repeats are not implemented. Research recommendation 6 asks for 3 runs of the incumbent and the final challenger under a judge, but the band always uses spread 0 (so band = floor) unless a `RunSummary` carries a spread. Plan 07-33, the live judge run, has to add repeated runs before the judge band means anything.

## Operator actions

None now. Plan 07-25 runs the fixture regression and plan 07-33 the live one, with `--interactive-env` and `--backend-notes`.

## Deferred

- Plan 07-25 owns the harness hooks: `backend_impl` in run.json, and the D-17 switch names in the run-config env allow-list. `RAG_INGEST_PIPELINE` and `RAG_EMBEDDING_PROFILES` may not be on that list yet.
- Plan 07-43 owns the cost, latency and per-language blocks and the `annotate` subcommand.
- Judge repeat runs for the band are left to plan 07-33.
