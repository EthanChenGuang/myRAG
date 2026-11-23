---
phase: 01-evaluation-harness-baseline
plan: 18
subsystem: testing
tags: [python, deepeval, ragas, llm-judge, telemetry, openrouter, pydantic, eval]

requires:
  - phase: 01-evaluation-harness-baseline
    provides: "01-13 load_golden, load_traces, load_manifest; 01-05 JudgeConfig, JudgeItemScore, JudgeReport, RagTrace contracts; 01-14 traces carrying answers and effective_config.generator_model; 01-16 runner cross-check and atomic report writing pattern"
provides:
  - "rag_eval.judge package: telemetry opt-out applied at import, before deepeval or ragas load"
  - "rag_eval.judge.config: load_judge_config, generator_family, assert_judge_family_differs, JudgeFamilyError, JudgeFatalError, JudgeCase, raise_if_fatal"
  - "rag_eval.judge.deepeval_judge: score_deepeval, OpenRouterDeepEvalLLM"
  - "rag_eval.judge.ragas_judge: score_ragas, build_ragas_live"
  - "rag_eval.judge.run: run_judge, write_judge_report, main (python -m rag_eval.judge.run --traces --golden --manifest --out [--config]) writing judge.json and judge.md"
  - "eval/config/judge.json pinning openai/gpt-5-mini via OpenRouter at temperature 0"
affects: [01-22, nightly workflow, live baseline]

plan_head_before: 49f2e36e1a0df5391e0c7a9100f3813fa35e3b5a
plan_head_after: 86da8127b298be676d9124d45e619df09712bec7

actuals:
  tokens: 12200
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Telemetry opt-out lives in the package __init__ so no submodule can import a judge library first"
    - "Judge failures split into per-item (recorded as skipped judge_error, run continues) and fatal (credentials or a provider rejecting temperature 0 / structured output: JudgeFatalError stops the run)"
    - "Offline judge tests use a generic Pydantic-model-filling stub for both libraries plus a socket spy that records and blocks connect, connect_ex and getaddrinfo"

key-files:
  created:
    - eval/src/rag_eval/judge/__init__.py
    - eval/src/rag_eval/judge/telemetry.py
    - eval/src/rag_eval/judge/config.py
    - eval/src/rag_eval/judge/deepeval_judge.py
    - eval/src/rag_eval/judge/ragas_judge.py
    - eval/src/rag_eval/judge/run.py
    - eval/config/judge.json
    - eval/tests/judge_stubs.py
    - eval/tests/test_judge_config.py
    - eval/tests/test_judge_offline.py
  modified: []

key-decisions:
  - "Exit codes: 0 ok, 2 invalid inputs or CONFIDENT_API_KEY set or traces without a single recorded generator_model, 3 judge key not configured, 4 provider rejected credentials or temperature 0 (added; the plan listed 0/2/3/5), 5 judge is Claude or from the generator's family"
  - "Family check runs before the key check, so a Claude judge config exits 5 without needing keys"
  - "Extra skip reason no_context (empty kept list) skips faithfulness and context recall for that item; answer relevance is still scored"
  - "Scoring runs through asyncio with a semaphore sized by JudgeConfig.max_concurrency; DeepEval metrics are built per task because they hold per-call state"
  - "build_ragas_live verifies the Ragas wrapper would send temperature 0 (its reasoning-model branch rewrites it to 1.0 for bare gpt-5 ids) and raises JudgeFatalError otherwise, so temperature is never dropped or changed silently"
  - "JudgeCase (Pydantic) lives in judge/config.py so both scorer modules share it without importing each other's library"
  - "run_judge takes keyword-only run_id and run_config_hash (taken from the manifest by the CLI) because JudgeReport requires them"

patterns-established:
  - "Judge-tier reports: judge.json with sorted keys and unrounded floats, judge.md with 3-decimal tables, both written via temp file plus os.replace"

requirements-completed: []

coverage:
  - id: D1
    description: "Importing rag_eval.judge sets DEEPEVAL_TELEMETRY_OPT_OUT=1, DEEPEVAL_UPDATE_WARNING_OPT_IN=0, an existing DEEPEVAL_HOME and RAGAS_DO_NOT_TRACK=true (overriding conflicting values) without loading deepeval or ragas; CONFIDENT_API_KEY makes the run refuse"
    requirement: EVAL-08
    verification:
      - kind: unit
        ref: "eval/tests/test_judge_config.py (subprocess import checks, override, kept DEEPEVAL_HOME, sys.modules check, check_no_results_upload); eval/tests/test_judge_offline.py::test_cli_refuses_when_traces_do_not_record_the_generator_or_confident_key_is_set"
        status: pass
    human_judgment: false
  - id: D2
    description: "judge.json pins openai/gpt-5-mini, family openai, openrouter, temperature 0 and validates as JudgeConfig; the family check refuses Claude ids, a same-family judge and a mislabeled family"
    requirement: EVAL-08
    verification:
      - kind: unit
        ref: "eval/tests/test_judge_config.py::test_load_judge_config_matches_pinned_judge, ::test_judge_family_check_refuses_same_family_and_claude, ::test_judge_family_check_passes_for_distinct_family"
        status: pass
      - kind: unit
        ref: "eval/tests/test_judge_offline.py::test_cli_refuses_a_claude_judge_config_with_exit_5, ::test_cli_refuses_a_judge_from_the_generator_family_with_exit_5"
        status: pass
    human_judgment: false
  - id: D3
    description: "run_judge scores deepeval and ragas faithfulness, answer_relevance and context_recall over zh/en/it traces, with overall, per-language and per-category aggregation; skipped items carry a reason and do not count toward n"
    requirement: EVAL-08
    verification:
      - kind: unit
        ref: "eval/tests/test_judge_offline.py::test_stub_run_scores_all_six_pairs_overall_per_language_and_category, ::test_skips_carry_reasons_and_do_not_count_toward_means, ::test_item_without_retrieved_context_skips_faithfulness_and_recall_but_not_relevance, ::test_a_failing_judge_call_marks_only_that_item_as_judge_error, ::test_judge_report_is_written_sorted_and_byte_stable"
        status: pass
    human_judgment: false
  - id: D4
    description: "A stub-judge run over zh/en/it traces opens no outbound connection (socket.connect, connect_ex and getaddrinfo spied); the live wrappers construct without a connection"
    requirement: EVAL-08
    verification:
      - kind: unit
        ref: "eval/tests/test_judge_offline.py (socket_spy asserted empty in the six-trace run, both live-builder tests and the missing-key CLI test)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The CLI exits 3 with 'judge key not configured' naming OPENROUTER_API_KEY or OPENAI_API_KEY and writes nothing when a key is missing"
    requirement: EVAL-08
    verification:
      - kind: unit
        ref: "eval/tests/test_judge_offline.py::test_cli_without_judge_or_embedding_key_exits_3_naming_the_variable"
        status: pass
    human_judgment: false
  - id: D6
    description: "Live run with real OpenRouter and OpenAI keys: judge.json validates, all six metrics have n above 0 per language, and 20 hand-checked items per language (zh, en, it) agree with the verdicts; the provider accepts temperature 0 for openai/gpt-5-mini with structured output"
    requirement: EVAL-08
    verification: []
    human_judgment: true
    rationale: "Needs live keys, and human judgement of zh/it judging quality with English-only Ragas prompts (research A2, A4); not run here because no key exists in this environment"
---

# Phase 1 Plan 18: Judge Tier Summary

**DeepEval and Ragas Faithfulness, Answer Relevance and Context Recall under a pinned non-Claude OpenRouter judge at temperature 0, family-checked, telemetry-off at import, with per-language and per-category results proven offline by stub judges and a socket spy**

## Performance

- **Tasks:** 2 (Task 1 as RED then GREEN commits; Task 2 as one commit, see Deviations)
- **Files modified:** 10 (all created)

## Accomplishments
- `import rag_eval.judge` disables telemetry before any judge library can load (DeepEval opt-out, update warning off, temp DEEPEVAL_HOME, `RAGAS_DO_NOT_TRACK=true`), and `check_no_results_upload()` refuses a set `CONFIDENT_API_KEY`.
- `eval/config/judge.json` pins `openai/gpt-5-mini` through OpenRouter at temperature 0; `assert_judge_family_differs` refuses any Claude id, a judge from the generator's family (generator read from the traces) and a family label that disagrees with the id prefix.
- `run_judge` produces a validated `JudgeReport` with the six keys `deepeval|ragas . faithfulness|answer_relevance|context_recall` overall, per language and per category; `python -m rag_eval.judge.run` writes `judge.json` (sorted keys, unrounded) and `judge.md`.
- Skips are explicit: `refused`, `no_answer_text`, `no_reference` (context recall on unanswerable items), `no_context`, `judge_error`; `n` counts only scored items.
- Offline proof: stub judges for both libraries (generic Pydantic filler) and a socket spy over `connect`, `connect_ex` and `getaddrinfo` record zero attempts, including while building the live Ragas and DeepEval wrappers with placeholder keys.
- Suites: `eval` pytest 107 passed (22 new: 9 config, 13 offline), `rag-sidecar` pytest 131 passed, `npm test` 67 passed, `npm run test-rag` valid.

## Task Commits

1. **Task 1: Judge configuration, family check and telemetry opt-out** - `bf113db` (test, RED), `2718cb4` (feat, GREEN)
2. **Task 2: DeepEval and Ragas scorers, run_judge, CLI, offline tests** - `86da812` (feat)

`commits: 4` in the frontmatter is the measured `rev-list` count since the plan began; one of the four (`940d899`, planning docs) was committed by another actor on the branch, so this plan's own commits are three.

## Files Created/Modified
- `eval/src/rag_eval/judge/__init__.py` - applies the telemetry opt-out first, exports only library-free names
- `eval/src/rag_eval/judge/telemetry.py` - `disable_telemetry`, `check_no_results_upload`
- `eval/src/rag_eval/judge/config.py` - config loading, family check, `JudgeCase`, fatal-error classification
- `eval/src/rag_eval/judge/deepeval_judge.py` - `score_deepeval`, `OpenRouterDeepEvalLLM` (OpenAI SDK, structured output via `parse`)
- `eval/src/rag_eval/judge/ragas_judge.py` - `score_ragas` on `ragas.metrics.collections`, `build_ragas_live`
- `eval/src/rag_eval/judge/run.py` - `run_judge`, report writers, CLI
- `eval/config/judge.json` - pinned judge config
- `eval/tests/judge_stubs.py`, `test_judge_config.py`, `test_judge_offline.py` - offline tests

## Decisions Made
See `key-decisions` above. The main ones: a fatal/per-item split for judge errors so a provider that rejects temperature 0 fails loudly rather than producing a report full of `judge_error`; and a guard in `build_ragas_live` because Ragas rewrites temperature to 1.0 for reasoning-model ids it recognizes.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Fatal provider errors must not be swallowed per item**
- **Found during:** Task 2
- **Issue:** The plan requires the live wrapper to fail loudly when the provider rejects temperature 0, but the required per-item `judge_error` handling would hide that as a report full of skipped items.
- **Fix:** `raise_if_fatal` converts 401/403 and 400/404/422 rejections mentioning temperature or structured output into `JudgeFatalError`, which both scorers re-raise; the CLI exits 4 (an exit code beyond the planned 0/2/3/5). Covered by `test_a_fatal_provider_error_stops_the_run_instead_of_skipping_every_item` and `test_raise_if_fatal_classifies_credentials_and_temperature_rejections`.
- **Files modified:** `eval/src/rag_eval/judge/config.py`, `deepeval_judge.py`, `ragas_judge.py`, `run.py`
- **Commit:** `86da812`

**2. [Rule 2 - Missing critical functionality] Ragas wrapper could silently change temperature**
- **Found during:** Task 2 (reading `ragas.llms.base.InstructorLLM._map_openai_params`)
- **Issue:** For OpenAI reasoning-model ids (`gpt-5`, o-series) Ragas forces temperature to 1.0. Through OpenRouter the id is `openai/gpt-5-mini`, which that check does not match today, but a future id change would break the temperature-0 pin without notice.
- **Fix:** `build_ragas_live` compares the temperature the wrapper will send with the config and raises `JudgeFatalError` on mismatch; tested offline.
- **Commit:** `86da812`

**3. [Plan shape] Task 2 had no separate RED commit**
- Tests and implementation for Task 2 were written together and committed once (all 13 offline tests passed on first run). Task 1 has the RED then GREEN pair. `config.py` was extended in Task 2's commit with the shared `JudgeCase` and fatal-error helpers.

**4. [Plan shape] Added `no_context` skip reason and keyword-only `run_id`/`run_config_hash` on `run_judge`**
- DeepEval and Ragas both raise on empty retrieval context, so an item with an answer but no kept chunks is skipped for faithfulness and context recall with `no_context` instead of becoming `judge_error`. `JudgeReport` requires `run_id` and `run_config_hash`, which the plan's `run_judge` signature did not carry.

## Issues Encountered
None blocking. Ruff (not configured in this repository) would reorder the `import rag_eval.judge` line in `judge_stubs.py` after the deepeval imports; it is intentionally first so telemetry is off before the libraries load.

## User Setup Required
Live judge runs need `OPENROUTER_API_KEY` (judge) and `OPENAI_API_KEY` (Ragas embeddings). Without them the CLI exits 3 with `judge key not configured`.

Manual check still open (coverage D6): run the nightly live harness, then `uv run --directory eval python -m rag_eval.judge.run --traces eval/out/nightly-live/traces.jsonl --golden eval/fixtures/golden.jsonl --manifest eval/out/nightly-live/run.json --out eval/out/nightly-live`, and hand-check 20 judged items per language (zh, en, it). If the provider rejects temperature 0 for `openai/gpt-5-mini` the run exits 4; pin another non-Claude judge in `eval/config/judge.json`.

## Next Phase Readiness
Plan 01-22 (nightly workflow) can call `python -m rag_eval.judge.run` and skip cleanly on exit 3. EVAL-08 stays Pending: 01-22 also declares it and the live hand-check has not run.

## Known Stubs
None. `eval/tests/judge_stubs.py` is a test double, not shipped behavior.

## Threat Flags
None. The only outbound surfaces are the pinned judge endpoint and the configured embedding endpoint, as in the plan's threat model.

## Self-Check: PASSED
