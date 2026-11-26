---
phase: 06-query-layer-llamaindex-langchain
plan: 22
subsystem: dependencies
tags: [dependencies, supply-chain, langchain, zod, redisvl, ci, sidecar, tdd]

requires:
  - phase: 06-query-layer-llamaindex-langchain
    provides: zod-v4 and langchain boundary rules (06-18)
  - phase: 05-verified-citations-groundedness
    provides: last edit of package.json, package-lock.json, pyproject.toml, uv.lock and test_dependency_boundary.py (05-05)
  - phase: 03.1-tiered-parsing-incremental-queue-bulk-backfill
    provides: pr-smoke.yml, test_dependency_boundary.py, pyproject extras (03.1-04); last check-workflows.py edit (03.1-50)
provides:
  - "Exact pins @langchain/core 1.4.0, @langchain/classic 1.0.61, @langchain/openai 1.8.4 in package.json and package-lock.json"
  - "rag-sidecar optional extra cache = [redisvl==0.32.0, redis==8.1.0], locked with sha256 hashes"
  - "serverExternalPackages for @langchain/core, @langchain/classic, @langchain/openai, langsmith"
  - "scripts/ci/check-zod-isolation.mjs (exports checkZodIsolation) and its CI step in pr-smoke ts-checks"
affects: [06-26, 06-30, 06-35, 06-37, 06-46]

actuals:
  tokens: 60000
  tasks: 4
  commits: 5
plan_head_before: cce43e1c

tech-stack:
  added:
    - "@langchain/core 1.4.0"
    - "@langchain/classic 1.0.61"
    - "@langchain/openai 1.8.4"
    - "redisvl 0.32.0 (sidecar extra cache)"
    - "redis 8.1.0 (sidecar extra cache)"
  patterns:
    - "Per-package uv exclude-newer-package cutoffs for every newly added PyPI package"

key-files:
  created:
    - scripts/ci/check-zod-isolation.mjs
    - scripts/tests/check-zod-isolation.node-test.mjs
  modified:
    - package.json
    - package-lock.json
    - next.config.js
    - .github/workflows/pr-smoke.yml
    - scripts/ci/check-workflows.py
    - rag-sidecar/pyproject.toml
    - rag-sidecar/uv.lock
    - rag-sidecar/tests/test_dependency_boundary.py
    - tests/next-config-server-externals.test.ts

requirements-completed: []
requirements-progressed: [QRY-08, CACHE-01]
---

# Phase 6 Plan 22: LangChain and RedisVL install, zod 4 isolation

The LangChain packages and the optional sidecar RedisVL extra are now installed with exact pins and locked. Each LangChain package keeps its own nested zod 4.6.7. The app root still resolves zod 3.25.76 and openai 4.104.0, and a CI step fails if that changes. Next.js loads LangChain and langsmith as server externals instead of bundling them. A sidecar test proves RedisVL and redis are reachable only through the `cache` extra, with pins and hashes.

## Checkpoint outcomes (owner, 2026-11-26, via the orchestrator brief)

- **Task 1 (package legitimacy):** the owner approved the research's **fallback** set instead of the newest pins, so that no package is younger than 14 days today. The set is `@langchain/core@1.4.0`, `@langchain/classic@1.0.61` and `@langchain/openai@1.8.4`, plus the sidecar `cache` extra with `redisvl==0.32.0` and `redis==8.1.0`. The plan's own fallback named core 1.4.1; the brief set 1.4.0, and classic 1.0.61 needs `@langchain/core ^1.4.0`. RedisVL was approved, so the D-35 and CACHE-01 decisions are unchanged.
  - I re-checked the publish dates on 2026-11-26 before installing:

    | Package | Published | Age |
    |---------|-----------|-----|
    | core 1.4.0 | 2026-11-11T22:09Z | 15 d |
    | classic 1.0.61 | 2026-11-11T22:11Z | 15 d |
    | openai 1.8.4 | 2026-11-11T22:04Z | 15 d |
    | redisvl 0.32.0 | 2026-11-11T10:22Z | 15 d |
    | redis 8.1.0 | 2026-07-30 | — |

  - All three npm packages point to `github.com/langchain-ai/langchainjs`, none is deprecated, and none has an install script. Both PyPI packages are MIT-licensed, not yanked, and come from `redis/redis-vl-python` and `redis-py`.
  - classic 1.0.61 pins `@langchain/openai` to exactly 1.8.4. classic 1.0.60 or older was not used, because it would dedupe zod onto the root zod 3 (D-20).
- **Task 2 (normally orchestrator-only install and lock):** the orchestrator delegated it to this executor. It ran on 2026-11-26 with CUTOFF = `2026-11-19T00:00:00Z` (install date minus 7 days). The plan's "not before 2026-12-04" precondition was for the newer primary pins and is replaced by the owner's fallback decision.
  - **npm:** `npm install --save-exact --ignore-scripts --before=2026-11-19T00:00:00Z @langchain/core@1.4.0 @langchain/classic@1.0.61 @langchain/openai@1.8.4`, with no overrides and `.npmrc` unchanged. `--ignore-scripts` changes nothing in the lock.
    - 26 new lock entries, all with integrity hashes and none with `hasInstallScript`. No existing entry changed: the only changed entry is the root package's dependency list.
    - New entries: @cfworker/json-schema 4.1.6, @langchain/classic 1.0.61, @langchain/core 1.4.0, @langchain/openai 1.8.4, @langchain/textsplitters 1.0.2, eventemitter3 4.0.7, handlebars 4.7.10, js-tiktoken 1.0.21, jsonpointer 5.0.1, langsmith 0.13.0, mustache 4.2.0, neo-async 2.6.2, openapi-types 12.1.3, p-finally 1.0.0, p-queue 6.6.2, p-timeout 3.2.0, source-map 0.6.1, uglify-js 3.19.3, wordwrap 1.0.0, yaml 2.9.1.
    - Nested entries: argparse 3.0.4 (PSF-2.0) and js-yaml 5.5.0 under classic, zod 4.6.7 under each of the three, and openai 7.60.0 under @langchain/openai.
  - **PyPI:** added `cache = ["redisvl==0.32.0", "redis==8.1.0"]`, then ran `uv lock --directory rag-sidecar`.
    - `exclude-newer-package` entries set to CUTOFF for redisvl, redis, jsonpath-ng, ml-dtypes, python-ulid and tenacity live in `[tool.uv]` in pyproject.toml, not in a CLI flag, so `uv lock --check` stays reproducible.
    - Six new lock entries, all from pypi.org with sha256 hashes on every sdist and wheel, all uploaded on or before CUTOFF: jsonpath-ng 1.16.0, ml-dtypes 0.7.0, python-ulid 4.2.0, redis 8.1.0, redisvl 0.32.0, tenacity 9.2.1.
    - No existing version changed. pyyaml, numpy and pydantic were already locked. The only lines removed from uv.lock come from re-sorting the options table and the `provides-extras` list.
    - Local `uv sync --extra cache` was done so that plan 06-30 can use the extra.
  - **Lock commit:** `cdf8aa55`.
- **Note for later Phase 6 plans:** plans written against core 1.5.0, classic 1.0.62 and openai 1.8.5 must use these pins instead: core 1.4.0, classic 1.0.61, openai 1.8.4.

## Commits

| Task | Commits |
|------|---------|
| 1 Legitimacy check | no commit (checks recorded above) |
| 2 Install and lock | cdf8aa55 chore(06-22): lock LangChain fallback pins and the sidecar cache extra |
| 3 serverExternalPackages and zod isolation | 1b8f439d test(06-22): add failing tests for the zod isolation check; a72a02c7 feat(06-22): externalize LangChain and assert zod 4 isolation in CI |
| 4 Sidecar dependency boundary | 081448f4 test(06-22): pin the sidecar cache extra to the dependency boundary |

## What changed

- `next.config.js`: `serverExternalPackages` now lists `tiktoken`, `@langchain/core`, `@langchain/classic`, `@langchain/openai` and `langsmith`.
- `scripts/ci/check-zod-isolation.mjs` reads `npm ls zod openai --all --json`, or `--tree-file` in tests. It fails when:
  - the root zod is not 3.25.x
  - the root openai is not 4.x
  - a @langchain package has no nested zod, so it would resolve the root zod
  - a @langchain package's nested zod is not 4.x

  With no @langchain package installed, it passes and prints `::notice::skipped: LangChain not installed`.
- `pr-smoke.yml`: the ts-checks job gets a "Zod isolation check" step after `npm ci` that runs the script and its node self-test. `check-workflows.py` adds both paths to the ts-checks required list.
- `rag-sidecar/tests/test_dependency_boundary.py` gets five new cases:
  - The `cache` extra holds exactly the two pins, and no other extra or the default dependency list names them.
  - The exclude-newer cutoffs are in place.
  - The lock entries come from PyPI with sha256 hashes and upload times on or before the cutoff.
  - A no-extras `uv export --frozen` lists neither the extra's packages nor its transitives.
  - The `--extra cache` export lists both pins.

  The test never imports redisvl.
- `tests/next-config-server-externals.test.ts` asserts the four new externals. The plan did not list this file; it is a small guard added next to the existing tiktoken assertion.

## Real tree (npm ls)

- root: `zod@3.25.76`, `openai@4.104.0`
- `@langchain/core@1.4.0` → `zod@4.6.7`
- `@langchain/classic@1.0.61` → `zod@4.6.7`; langsmith 0.13.0 resolves the root openai 4.104.0 as its optional peer
- `@langchain/openai@1.8.4` → `zod@4.6.7`, `openai@7.60.0`

## Tests that failed before the change

- `scripts/tests/check-zod-isolation.node-test.mjs`: 10 of 11 failed against the stub (RED commit 1b8f439d). All 11 pass after a72a02c7.
- `tests/next-config-server-externals.test.ts`: the new case fails with the old next.config.js and passes with the new one.
- `test_dependency_boundary.py`: the lock commit came first, as the plan orders, so a RED commit of these tests was not possible. I ran a mutation check against the pre-lock pyproject.toml and uv.lock from cce43e1c: 4 of the 5 new cases fail. The no-extras export case passes there, correctly, because nothing is installed. All 15 pass on the new files.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx next build` with the CI placeholder env: passed
- `npx vitest run tests/next-config-server-externals.test.ts`: 4 passed. That is the only vitest file that reads a changed module; no shared `src/` code changed, so the full suite was not run.
- `node --test scripts/tests/check-zod-isolation.node-test.mjs`: 11 passed. `node scripts/ci/check-zod-isolation.mjs` on the real tree: ok.
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`: all exit 0
- `uv run --all-extras --frozen --directory eval python ../scripts/ci/check-workflows.py`: OK. The `test_check_workflows.py` unittest suite: 65 passed.
- `uv lock --directory rag-sidecar --check`: exit 0. `uv run --directory rag-sidecar --frozen --no-sync python -c "import redisvl, redis"`: exit 0.
- rag-sidecar pytest `tests/test_dependency_boundary.py tests/test_hidden_text_docx.py tests/test_boot.py`: 50 passed. The last two run uv lock and sync checks against the changed lock.

## Deviations

- The fallback pins and the install date replace the plan's primary pins and its 2026-12-04 precondition (owner decision above). Task 2 was run by the executor on delegation from the orchestrator.
- `--ignore-scripts` was added to the npm install. It changes nothing in the lock and runs no third-party scripts.
- The per-package cutoffs were written into pyproject.toml rather than passed as CLI flags.
- One test case was added to `tests/next-config-server-externals.test.ts` (outside files_modified).

## Decisions for STATE

- Phase 6 LangChain pins are core 1.4.0, classic 1.0.61 and openai 1.8.4, installed with CUTOFF 2026-11-19T00:00:00Z. Later plans that name 1.5.0, 1.0.62 or 1.8.5 use these pins instead.
- RedisVL was approved. The `cache` extra is locked, and the D-35 and CACHE-01 decisions are unchanged, so 06-30's precondition is met.

## Operator actions

- None. No live API checks were run.

## Deferred

- Nothing.
