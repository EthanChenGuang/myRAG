---
phase: 02-unified-retrieval-pipeline-tenant-scope
plan: 28
subsystem: evaluation
tags: [langfuse, online-judge, deepeval, pydantic, github-actions, judge-family]
status: complete

requires:
  - phase: 02-unified-retrieval-pipeline-tenant-scope
    provides: LangfuseApi (observations paging, scores array with 202/207), fake Langfuse twin and the review-queue item mapper (02-27); Phase 1 judge config, family guard and DeepEval scoring
provides:
  - OnlineJudgeConfig and an optional online_judge block on JudgeConfig, with JSON Schema, sample and generated Zod
  - python -m rag_eval.online_judge (select_sample, judge_traces, main)
  - nightly online-judge job and workflow-checker assertions
affects: []

requirements-completed: [EVAL-15]

actuals:
  tokens: 10500
  tasks: 3
  commits: 4
plan_head_before: ba2fcc8
plan_head_after: 1d56f5c1724f846322d8649daf849b5226d606fc

tech-stack:
  added: []
  patterns:
    - "Judge chosen per trace: the pinned judge, or the online judge when the generator shares the pinned judge's family, always validated with assert_judge_family_differs"
    - "Injectable judge factory (stub in tests, OpenRouter DeepEval model live), no live key needed for tests"
    - "Score ids are sha256 of trace id, metric and judge model; timestamps are the trace's own captured time, so re-runs post identical bodies"

key-files:
  created:
    - eval/src/rag_eval/online_judge.py
    - eval/tests/test_online_judge.py
  modified:
    - rag-sidecar/src/rag_sidecar/contracts/judge.py
    - rag-sidecar/src/rag_sidecar/contracts/__init__.py
    - rag-sidecar/src/rag_sidecar/contracts/samples.py
    - rag-sidecar/schemas/JudgeConfig.schema.json
    - rag-sidecar/tests/test_contract_models.py
    - src/lib/rag-eval/contracts.generated.ts
    - tests/fixtures/contracts/samples.json
    - eval/config/judge.json
    - eval/tests/test_judge_config.py
    - .github/workflows/nightly.yml
    - scripts/ci/check-workflows.py

key-decisions:
  - "Online judge scoring uses DeepEval only (faithfulness and answer relevance, one value per metric per trace). Ragas answer relevance needs an OpenAI embedding key the nightly job does not have, and one library keeps the four-entries-per-pair shape the plan specifies"
  - "The online judge is used whenever the generator family equals the pinned judge's family (today that is exactly the openai/* case); a refusal from assert_judge_family_differs, including an undeterminable family, skips the trace as same_family"
  - "A trace needs query, answer and context to be judged; any missing piece skips it as missing_content (faithfulness cannot be scored without context). A sampled trace whose observation has no content also counts as missing_content"
  - "Per-metric judge failures are counted under an extra skipped key, judge_error, and produce no score; a fatal provider error (bad credentials) exits 4 without posting"
  - "sample_rate and seed come only from the online_judge block; when the block is absent the CLI prints a ::notice:: and exits 0"
  - "Online judge model chosen from the live OpenRouter list: the plan command printed google/gemini-3.8-flash, used with judge_family google, sample_rate 0.2, seed 20261123"
  - "Nightly job reads LANGFUSE_BASE_URL from repository variables (not a secret); an unset variable falls back to the default cloud URL"

patterns-established:
  - "CLI summary is one JSON line on stdout: candidates, sampled, scored, skipped {same_family, missing_content, judge_error}, post_status, accepted, rejected"

coverage:
  - id: D1
    description: "online_judge block in the JudgeConfig contract and judge.json with a non-OpenAI, non-Claude judge"
    requirement: EVAL-15
    verification:
      - kind: unit
        ref: "eval/tests/test_judge_config.py (4 new tests), rag-sidecar/tests/test_contract_models.py; sidecar suite 184 passed"
        status: pass
  - id: D2
    description: "Online judge CLI: deterministic sampling, per-trace judge choice, same_family skip, one scores array, 207 never retried, skip notices"
    requirement: EVAL-15
    verification:
      - kind: unit
        ref: "eval/tests/test_online_judge.py (16 tests against the fake Langfuse and the stub judge); eval suite 314 passed"
        status: pass
  - id: D3
    description: "Nightly online-judge job gated on keys, secrets only in step env, checker asserts it"
    requirement: EVAL-15
    verification:
      - kind: unit
        ref: "python3 -I scripts/ci/check-workflows.py prints OK; mutations (missing job, missing step env, secret in run, ungated step) each produce an error"
        status: pass
  - id: D4
    description: "Scores reach real Langfuse traces from a nightly run with real keys"
    requirement: EVAL-15
    verification:
      - kind: manual
        ref: "Live item: run the nightly job once with real keys and a non-zero LANGFUSE_REVIEW_SAMPLE_RATE, confirm scores on the traces"
        status: pending
---

# Phase 2 Plan 28: Online Judge Summary

Faithfulness and answer-relevance scores for a seeded sample of review-candidate production traces are posted to Langfuse nightly, with a non-OpenAI judge for OpenAI-generated traces and a per-trace judge-family guard.

## Tasks and commits

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | online_judge in the JudgeConfig contract and judge.json (restores the earlier RED and GREEN work in one commit) | e0a20d8 |
| 2 | Online judge CLI, RED tests then GREEN | 512c946 (RED), 4034d34 (GREEN) |
| 3 | Nightly online-judge job and workflow assertions | 1d56f5c |

Task 1 arrived as staged, uncommitted changes from a stopped executor (its RED test commit and GREEN contract commit). They were reviewed, re-verified (eval config tests, sidecar suite, `npm run gen:schemas` produced no further diff) and committed together; the tests there were not re-run as a failing RED state. Task 2 has a true RED commit: a signature-only module so every test fails on its assertions.

## Model selection record

`curl -s https://openrouter.ai/api/v1/models | jq -r '.data[].id' | grep -E '^google/gemini-[0-9.]+-flash$' | sort -V | tail -1` printed `google/gemini-3.8-flash`, which is the value in `eval/config/judge.json`. Whether this id accepts temperature 0 with structured output through the DeepEval wrapper was not exercised (no live key); it is part of the live item.

## Verification

- `uv run --all-extras --frozen pytest -q` in eval: 314 passed (first run before `uv sync --all-extras` showed one pre-existing environment failure, a missing deepeval module; resolved by syncing the extras).
- `uv run --frozen pytest -q` in rag-sidecar: 184 passed.
- `npx vitest run`: 900 passed (79 files); `tests/rag/langfuse-pins.test.ts` ran without an ENOENT here.
- `node --import tsx --test tests/*.test.mts`: 86 passed.
- `npx next typegen && node scripts/ci/tsc-ratchet.mjs`: 0 errors.
- `node scripts/ci/check-rag-boundary.mjs`: ok.
- `python3 -I scripts/ci/check-workflows.py`: OK. Schema parity: `npm run gen:schemas` leaves the tree clean.

## Deviations from Plan

- **[Plan note] Session trailer:** the plan text names a different session id in its commit rule; commits use the trailer given by the dispatching instructions.
- **[Rule 2 - Missing critical functionality] Judge-error accounting:** the plan lists skipped keys same_family and missing_content; a third key, judge_error, was added so failed judge calls are visible rather than silently absent.
- No other deviations.

## Known Stubs

None.

## Threat Flags

None. The CLI only reads observations through the existing Langfuse client and posts scores; text passes through the existing PII mask before reaching the judge.

## Live verification item

Run the nightly job once with real Langfuse and OpenRouter keys and a non-zero `LANGFUSE_REVIEW_SAMPLE_RATE`; confirm faithfulness and answer_relevance scores appear on the sampled traces and that the chosen online judge honours temperature 0.

## Self-Check: PASSED

- Files present: eval/src/rag_eval/online_judge.py, eval/tests/test_online_judge.py, eval/config/judge.json, .github/workflows/nightly.yml, scripts/ci/check-workflows.py.
- Commits present on the branch: e0a20d8, 512c946, 4034d34, 1d56f5c.
