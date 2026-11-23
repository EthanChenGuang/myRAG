---
phase: 01-evaluation-harness-baseline
plan: 10
subsystem: testing
tags: [rag-eval, pinned-env, run-manifest, pydantic, reproducibility, uv]

requires:
  - phase: 01-04
    provides: "runEval / prepareInProcessEval, canonicalJson / configHash, RagTrace traces, npm run test-rag"
  - phase: 01-02
    provides: "Fixture embedder id/version/source hash, corpus and SQL hashes from createFixtureDatabase"
provides:
  - "eval/config/rag-eval-env.json: 36 pinned RAG_* / deployment / embedding values derived from scripts/init-env.js, drift-checked by eval-env.mts --check"
  - "derivePinnedEvalEnv / loadPinnedEvalEnv and the eval-env.mts --write / --check CLI"
  - "run.json written by every runEval as a RunManifest (RunManifestSchema-validated) with effective_config_hash and run_config_hash"
  - "python -m rag_sidecar.contracts.validate: Pydantic validation CLI for JSONL and JSON files (exit 0 valid, 1 first failing line, 2 unknown model)"
  - "npm run test-rag validates traces.jsonl and run.json with the Pydantic models and exits with the validator's code"
affects: [01-11, 01-14, 01-20, 01-21, baseline runs, reproducibility checks]

plan_head_before: 7e3f6589782ef2a16ab8072e1244325debf82fe1
plan_head_after: 80124d0dbdae613ae1e6be07308f8898d5d3dfb3

actuals:
  tokens: 7500
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Pinned env is applied after inherited RAG_* are removed and before fixtureProcessEnv and the route import; the deployment-mode option and the embedding model are re-set afterwards so the option still wins"
    - "run_config_hash = SHA-256 of canonicalJson over effective_config_hash, embedder, corpus_sha256, golden_sha256, sql_sha256, normalized request_options and deployment_mode (created_at, git_sha, run_id and golden_path excluded)"
    - "TS-to-Python exchange is a subprocess: spawnSync('uv', ['run','--project','rag-sidecar','python','-m',...]) with an argument array"

key-files:
  created:
    - eval/harness/eval-env.mts
    - eval/config/rag-eval-env.json
    - rag-sidecar/src/rag_sidecar/contracts/validate.py
  modified:
    - eval/harness/run-eval.mts
    - eval/harness/run-smoke.mts

key-decisions:
  - "request_options are normalized to {max_results, organization_id, user_id} with nulls before hashing and before writing the manifest, so omitted and explicit-null options hash identically"
  - "For --base-url runs the manifest has embedder null, corpus_sha256 null and sql_sha256 {} because those facts belong to the remote deployment; the run_config_hash then covers golden, options, mode and the remote's effective_config"
  - "golden_path is stored relative to the cwd and left out of the hash, so moving the checkout does not change run_config_hash"
  - "Pinned values include RAG_FINAL_RESULT_COUNT=25 from init-env.js, so in-process runs now see it in effective_config.rag_env (it was undefined before pinning, as noted in the 01-04 summary)"

patterns-established:
  - "run-smoke exit codes: 0 success, 3 harness error, otherwise the validator's code"

requirements-completed: []

coverage:
  - id: D1
    description: "eval-env --check exits 0 when the pinned JSON matches init-env.js and the file has no RAG_EVAL_*, RAG_SIDECAR_* or prompt variables, and includes OPENAI_EMBEDDING_MODEL"
    requirement: EVAL-06
    verification:
      - kind: integration
        ref: "npx tsx eval/harness/eval-env.mts --check exit 0; grep -c RAG_EVAL_ eval/config/rag-eval-env.json == 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "In-process runs apply the pinned values: the tracer trace carries RAG_FINAL_RESULT_COUNT=25 in effective_config.rag_env and still keeps refund-policy.en.md"
    requirement: EVAL-06
    verification:
      - kind: integration
        ref: "npm run test-rag -- --out eval/out/pinned, then inspect trace; npm test 10 passed"
        status: pass
    human_judgment: false
  - id: D3
    description: "run.json validates with RunManifestSchema and the Pydantic RunManifest, edge_errors 0, item_count equal to the golden line count"
    requirement: EVAL-11
    verification:
      - kind: integration
        ref: "test-rag repro-a/repro-b; validate --model RunManifest --json exit 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "Two consecutive runs give identical run_config_hash and identical traces apart from stage_latency_ms; changing --max-results changes the hash"
    requirement: EVAL-11
    verification:
      - kind: integration
        ref: "repro-a vs repro-b run_config_hash equal, traces equal after dropping stage_latency_ms; repro-c (--max-results 5) hash differs"
        status: pass
    human_judgment: false
  - id: D5
    description: "The validator exits 1 naming the first failing line for a corrupted JSONL line, 2 for an unknown model, 0 for valid files; run-smoke exits with the validator's code"
    requirement: EVAL-02
    verification:
      - kind: integration
        ref: "bad.jsonl exit 1 with extra_forbidden message; Nope model exit 2; run-smoke with a temporarily failing validator exits 1 (file restored)"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-11-23
status: complete
---

# Phase 1 Plan 10: Pinned Eval Env, RunManifest and Pydantic Validation Summary

**In-process eval runs use a committed, drift-checked RAG_* configuration taken from `scripts/init-env.js`, write a hashed `run.json` RunManifest, and have every trace and the manifest validated by the Pydantic models after the Zod check**

## Performance

- **Duration:** about 15 min (start time was not captured at launch; estimate)
- **Completed:** 2026-11-23
- **Tasks:** 2
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments
- `eval/config/rag-eval-env.json` pins 36 literal values; `${...}` values, `RAG_EVAL_*`, `RAG_SIDECAR_*` and the three prompt variables are excluded, so no secret or prompt text is committed. `--check` exits 1 on drift and is meant for CI.
- `run.json` is written for every run with the config hashes the baseline compares. Two consecutive runs gave the same `run_config_hash` and traces that are equal apart from `stage_latency_ms`; `--max-results 5` changed the hash. The multi-tenant mode also validates.
- `npm run test-rag` now also runs `uv run --project rag-sidecar python -m rag_sidecar.contracts.validate` over `traces.jsonl` (RagTrace) and `run.json` (RunManifest). The validator exits 1 naming the corrupted line, 2 for an unknown model.

## Task Commits

1. **Task 1: Pinned eval env derived from scripts/init-env.js** - `7fe6473` (feat)
2. **Task 2: RunManifest with config hashes and Pydantic validation** - `80124d0` (feat)

**Plan metadata:** committed separately (docs: complete plan)

## Decisions Made
See `key-decisions` above.

## Deviations from Plan

None - plan executed exactly as written. Small additions inside scope: `runEval`'s result now also returns `runPath` and `manifest`, and `InProcessEval` exposes `corpusSha256` and `sqlSha256` (needed to build the manifest). The new validator was formatted and linted with ruff.

## Issues Encountered
- Pinning changes what the in-process runs see: `RAG_FINAL_RESULT_COUNT=25` (and the other init-env defaults) are now present in `effective_config.rag_env`. The tracer item still keeps both `refund-policy.en.md` chunks and `npm test` stays green (10 tests).
- `uv` prints a `UV_NATIVE_TLS` deprecation warning on every validator call; it is environment noise, not a failure.
- `npx tsc --noEmit` reports TS5097 for `.ts`/`.mts` import suffixes across `eval/harness/`; this is the existing convention from earlier plans (tsx runs them), not new.

## Known Stubs
None.

## Threat Flags
None beyond the plan's register. T-01-42 is mitigated by the derive filter (checked with `grep -c "RAG_EVAL_"` == 0), T-01-43 by the Pydantic `extra="forbid"` validation after the Zod check.

## User Setup Required
None. When plan 01-11 adds `RAG_EVAL_*` defaults to `init-env.js`, `eval-env.mts --check` stays green because those names are excluded.

## Next Phase Readiness
- Plan 01-20 (baseline) can compare `run_config_hash` between runs and rely on `run.json` being present next to `traces.jsonl`.
- EVAL-06, EVAL-11 and EVAL-02 stay Pending in REQUIREMENTS.md: plans 01-14, 01-20 and 01-21 also deliver parts of them.

## Self-Check: PASSED

All 3 created files exist, commits `7fe6473` and `80124d0` are ancestors of HEAD, `eval-env.mts --check` exits 0, and the two-run reproducibility and corrupted-line checks pass.

---
*Phase: 01-evaluation-harness-baseline*
*Completed: 2026-11-23*
