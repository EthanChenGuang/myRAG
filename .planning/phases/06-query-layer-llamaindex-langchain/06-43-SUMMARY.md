---
phase: 06-query-layer-llamaindex-langchain
plan: 43
subsystem: rag-eval
tags: [query-layer, langchain, llamaindex, framework-comparison, paired, semantic-cache, ci, d-40, d-42]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-37 both frameworks end to end; 06-38 golden items and fake table; 06-34 report sections; 06-41 cache pair run and calibrate cache --check; 06-22 last pr-smoke.yml and check-workflows.py edits"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-19 last Phase 5.1 edit of pr-smoke.yml and check-workflows.py"
provides:
  - "python -m rag_eval.compare frameworks (--fixtures | --llamaindex DIR --langchain DIR) --out DIR: FrameworkComparison JSON and Markdown"
  - "Paired langchain-minus-llamaindex differences per language, category and language pair (shared seed and resamples), per-transform field differences, fused-order tie/rank counts, problems list"
  - "eval/reports/frameworks-fixture/report.json and report.md (fixture comparison)"
  - "Fixture eval runs install the LangChain fake chat model next to the native fake (eval/harness/run-eval.mts)"
  - "pr-smoke eval-smoke: framework comparison step and the cache near-miss gate (fresh --cache-pairs run, then calibrate cache --check); check-workflows requires both"
affects: [06-44, 06-45, 06-46]

actuals:
  tokens: 120000
  tasks: 3
  commits: 9

key-files:
  created:
    - eval/src/rag_eval/compare/__init__.py
    - eval/src/rag_eval/compare/__main__.py
    - eval/src/rag_eval/compare/frameworks.py
    - eval/tests/test_compare_frameworks.py
    - eval/reports/frameworks-fixture/report.json
    - eval/reports/frameworks-fixture/report.md
  modified:
    - eval/harness/run-eval.mts
    - tests/rag-db/eval-query-layer-overlay.test.mts
    - .github/workflows/pr-smoke.yml
    - scripts/ci/check-workflows.py
    - scripts/tests/test_check_workflows.py

key-decisions:
  - "The comparison pairs every scored item of both runs (dev and test; 229 fixture items), not only the gate split: it is a report, not a gate against a baseline"
  - "An order difference counts as tie-only when both runs have the same fused-score groups and the orders differ only inside a group (the last group may be cut by top-k only when it has two or more members); fused scores missing, or a lone boundary chunk differing, count as rank differences"
  - "A run whose plans name another framework (the loadRagConfig fallback), lack a query plan, or skip a transform with reason error is a problem; problems still write the report and exit 2, so CI fails"
  - "Field-level transform differences only (standalone, date_range, sub_questions, variants[kind].count/text/language/sub_question_index/protected_ok, skipped, status); no query or variant text is written"

requirements-completed: [QRY-08]
---

# Phase 6 Plan 43: Framework comparison and the PR gates

**`python -m rag_eval.compare frameworks` runs the fixture golden set under LlamaIndex and LangChain and writes paired differences per language, category and language pair, per-transform field differences and tie-order counts; every PR now runs it and the cache near-miss wrong-hit gate.**

## Commits

| Task | Commit | Message |
|------|--------|---------|
| fix RED | `7ff3b72` | test(06-43): add failing test for the LangChain fake in fixture eval runs |
| fix GREEN | `4c7aa39` | fix(06-43): install the LangChain fake chat model in fixture eval runs |
| 1 RED | `81a6911` | test(06-43): add failing tests for the framework comparison |
| 1 GREEN | `62a15f1` | feat(06-43): add python -m rag_eval.compare frameworks (D-40) |
| 1 | `9555de7` | style(06-43): parenthesize implicit string concatenations in the report text |
| 2 | `3a34044` | docs(06-43): record the fixture framework comparison report |
| 3 RED | `31ca5d1` | test(06-43): add failing workflow checks for the framework comparison and cache gate |
| 3 GREEN | `b796fff` | feat(06-43): require the framework comparison and cache near-miss gate in pr-smoke |

## Behaviour

- **Fixture eval under LangChain (bug fix).** `prepareInProcessEval` installed the fake query LLM only in `RagDeps.queryLlm`, which the native path reads. Under `RAG_QUERY_FRAMEWORK=langchain` the LangChain transformer still built ChatOpenAI, so every LLM transform was skipped with `error` (and the run would have tried a live model if a key had been reachable). The harness now also sets `setLangChainChatModelFactoryForTests` to the LangChain fake reading the same `eval/fixtures/query-llm/transforms.json`, and `close()` restores both. Before the fix the fixture LangChain run skipped condense, expand and decompose on every routed item.
- **`rag_eval.compare frameworks`.** `--fixtures` runs `query-layer-llamaindex.json` and `query-layer-langchain.json` in-process (via the phase_compare harness runner, outputs under `--work`, default `eval/out/compare-frameworks`); `--llamaindex DIR --langchain DIR` compares existing runs (for the 06-46 live run). Paired difference is langchain minus llamaindex per item on recall_at_5, recall_at_10, mrr, correct_refusal_rate and false_refusal_rate, with `paired._slice_members` slices and `paired._stat` (seed 20261123, 10000 resamples), rounded to 6 digits. Exit 0 on a clean comparison; 2 on unreadable input, different item sets, or any problem (report still written).
- **Report notes.** The Markdown states that translate is compared as plumbing only (one shared prompt), that tie order is reported apart from rank, and, when both embedders are fixture embedders, that fixture numbers reflect the lexical fixture embedder and the scripted fake.
- **CI.** `eval-smoke` runs, after the SEC gate, `uv run --directory eval python -m rag_eval.compare frameworks --fixtures --out eval/out/frameworks` and a step that runs `npm run test-rag -- --run-config eval/config/runs/query-layer-llamaindex.json --cache-pairs --no-gate --out eval/out/cache-pairs` then `uv run --directory eval python -m rag_eval.calibrate cache --check --pairs eval/out/cache-pairs/cache-pairs.json`; both outputs are uploaded. `check_query_layer_gates` rejects a missing or soft (`|| true`, `continue-on-error`) step, a check without a `--cache-pairs` run before it in the same step, a check reading another file than that run's `cache-pairs.json`, and either step before `npm ci` / `uv sync`.

## Fixture result

229 items, both runs on `fixture-ngram`. All recall and refusal differences are zero in every slice. MRR differs on 2 items (overall mean -0.0033, interval [-0.0092, 0]); both are order effects. Fused order: 222 identical, 6 tie-only (five multi_turn items in en, it, zh and one more), 1 rank difference (`zh-cache-near-miss-015`). That item is also the one per-transform difference: decompose returned two sub-questions under LangChain and none natively. The table has no entry for it; the LangChain fake matches an entry when the rendered prompt contains its query as a substring, so it answered with the scripted entry of the compound item this near-miss is built from, while the native fake keys on the exact query and returned its default. It is a fake-matching difference, not a framework one. No problems.

## Deviations

1. **[Rule 1 bug] LangChain fake not installed in fixture runs** (`eval/harness/run-eval.mts`, `tests/rag-db/eval-query-layer-overlay.test.mts`, outside files_modified). Without it the comparison would have measured a framework whose transforms all failed. Test first (RED on the `skipped` assertion), then the fix.
2. **Dependency install.** `uv sync --locked --all-extras` in eval/ fails on this base: `eval/uv.lock` lacks the rag-sidecar `cache` extra metadata that 06-22 added (`redisvl`, `redis` requires-dist lines). Trunk already carries that lock metadata. I installed with `uv sync --frozen --all-extras` (lockfile only, no re-lock), ran eval commands with `UV_FROZEN=1`, and restored the lock each time the harness's own `uv run` rewrote it. The lock is not committed by this plan.
3. **Placement.** The two CI steps live in the existing `eval-smoke` job (it already has npm ci, both uv syncs and the tiktoken cache) rather than a new job, so `PR_JOBS` and the job-level checks need no change.

## Tests that failed before the change

- `tests/rag-db/eval-query-layer-overlay.test.mts` "query-layer-langchain condenses the multi_turn items through the LangChain fake, never a live chat model": failed on the `skipped` assertion (condense skipped with error).
- `eval/tests/test_compare_frameworks.py`: 8 failed on assertions against the stub.
- `scripts/tests/test_check_workflows.py` `FrameworkAndCacheGateTest`: 7 failed (the checker accepted workflows without the steps); the repository-workflow case passed.

## Gates

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/eval-corpus.test.ts tests/eval-harness.test.ts` (the vitest files importing eval/harness/run-eval.mts): 14 passed
- `node --import tsx --test` on every tsx file importing run-eval.mts (tests/eval-answer, rag-langfuse-export and 16 tests/rag-db files incl. eval-query-layer-overlay, query-layer-langchain, cache-pairs, in-process-eval-lifecycle): 142 passed
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: pass
- `uv run --all-extras --frozen --directory eval python ../scripts/ci/check-workflows.py`: OK
- eval pytest `tests/test_compare_frameworks.py tests/test_paired.py tests/test_phase_compare.py tests/test_calibrate_cache.py ../scripts/tests/test_check_workflows.py`: 169 passed
- `npm run test-rag -- --out eval/out/06-43`: gate PASS; `npm run test-rag -- --fixture-mode ingest --out eval/out/06-43-ingest`: gate PASS
- The two new CI commands locally: `rag_eval.compare frameworks --fixtures`: exit 0; fresh `--cache-pairs` run then `calibrate cache --check`: exit 0
- ruff on the new module and tests: clean (one pre-existing PIE810 in check-workflows.py line 127 untouched)
- Not run (not touched): gen:schemas (no contract change), UI design gate, full vitest (no shared src/lib/rag core, env.ts or setup change)

## Decisions for STATE

- Framework comparison: `python -m rag_eval.compare frameworks`; difference is langchain minus llamaindex; tie-only order differences are counted apart from rank differences; any framework fallback or transform error fails it (exit 2).
- PR CI fails on the fixture framework comparison and on any cache near-miss wrong hit of a fresh pair run (D-42 e).
- Fixture eval runs under LangChain use the LangChain fake chat model on the same table as the native fake (D-39).

## Operator actions

- Live comparison (06-46): run both run configs against the deployed app (`npm run test-rag -- --base-url <url> --run-config eval/config/runs/query-layer-llamaindex.json --no-gate --out <a>` and the same with `query-layer-langchain.json` to `<b>`), then `uv run --directory eval python -m rag_eval.compare frameworks --llamaindex <a> --langchain <b> --out <dir>`. Not run.

## Deferred

- The LangChain fake's substring match (`prompt.includes(entry.query)`) can answer for a query that only contains a scripted one; a stricter match belongs with the fake's owner plan, and would change the 06-37 parity expectations.
- `eval/uv.lock` drift on this base is fixed on trunk; nothing to do here.
- AGENTS.md mention of `rag_eval.compare frameworks` and the new CI steps is left to the phase doc update (06-45).

## Self-Check: PASSED
