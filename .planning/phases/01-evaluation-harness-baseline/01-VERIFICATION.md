---
phase: 01-evaluation-harness-baseline
verified: 2026-11-23T11:26:24Z
status: gaps_found
score: 4/5 must-haves verified
covered_files: [".github/workflows/nightly.yml",".github/workflows/pr-smoke.yml",".gitignore",".planning/phases/01-evaluation-harness-baseline/01-01-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-01-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-02-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-02-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-03-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-03-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-04-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-04-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-05-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-05-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-06-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-06-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-07-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-07-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-08-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-08-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-09-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-09-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-10-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-10-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-11-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-11-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-12-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-12-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-13-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-13-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-14-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-14-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-15-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-15-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-16-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-16-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-17-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-17-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-18-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-18-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-19-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-19-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-20-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-20-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-21-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-21-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-22-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-22-SUMMARY.md","eval/.gitignore","eval/baselines/fixture-baseline.json","eval/config/draft.json","eval/config/judge.json","eval/config/noise.json","eval/config/rag-eval-env.json","eval/fixtures/golden.jsonl","eval/fixtures/split-manifest.json","eval/harness/corpus.mts","eval/harness/eval-env.mts","eval/harness/fake-edge.mts","eval/harness/fixture-embedder.mts","eval/harness/pglite-supabase.mts","eval/harness/run-eval.mts","eval/harness/run-nightly.mts","eval/harness/run-smoke.mts","eval/pyproject.toml","eval/src/rag_eval/__init__.py","eval/src/rag_eval/baseline.py","eval/src/rag_eval/corpus.py","eval/src/rag_eval/draft/__init__.py","eval/src/rag_eval/draft/__main__.py","eval/src/rag_eval/draft/claude_drafter.py","eval/src/rag_eval/draft/cli.py","eval/src/rag_eval/draft/config.py","eval/src/rag_eval/draft/ragas_drafter.py","eval/src/rag_eval/draft/sources.py","eval/src/rag_eval/draft/verify.py","eval/src/rag_eval/draft/writer.py","eval/src/rag_eval/gate.py","eval/src/rag_eval/golden_io.py","eval/src/rag_eval/judge/__init__.py","eval/src/rag_eval/judge/config.py","eval/src/rag_eval/judge/deepeval_judge.py","eval/src/rag_eval/judge/ragas_judge.py","eval/src/rag_eval/judge/run.py","eval/src/rag_eval/judge/telemetry.py","eval/src/rag_eval/matching.py","eval/src/rag_eval/metrics.py","eval/src/rag_eval/paths.py","eval/src/rag_eval/report.py","eval/src/rag_eval/runner.py","eval/src/rag_eval/split.py","eval/src/rag_eval/traces.py","eval/tests/judge_stubs.py","eval/tests/test_baseline.py","eval/tests/test_corpus.py","eval/tests/test_draft_cli.py","eval/tests/test_draft_sources.py","eval/tests/test_draft_writer.py","eval/tests/test_fixture_coverage.py","eval/tests/test_fixture_pii.py","eval/tests/test_fixture_quotes.py","eval/tests/test_gate.py","eval/tests/test_golden_io.py","eval/tests/test_judge_config.py","eval/tests/test_judge_offline.py","eval/tests/test_matching.py","eval/tests/test_metrics.py","eval/tests/test_report_runner.py","eval/tests/test_split.py","eval/uv.lock","package-lock.json","package.json","rag-sidecar/.dockerignore","rag-sidecar/.gitignore","rag-sidecar/Dockerfile","rag-sidecar/pyproject.toml","rag-sidecar/src/rag_sidecar/__init__.py","rag-sidecar/src/rag_sidecar/auth.py","rag-sidecar/src/rag_sidecar/contracts/__init__.py","rag-sidecar/src/rag_sidecar/contracts/baseline.py","rag-sidecar/src/rag_sidecar/contracts/eval_run.py","rag-sidecar/src/rag_sidecar/contracts/golden.py","rag-sidecar/src/rag_sidecar/contracts/judge.py","rag-sidecar/src/rag_sidecar/contracts/report.py","rag-sidecar/src/rag_sidecar/contracts/samples.py","rag-sidecar/src/rag_sidecar/contracts/sidecar.py","rag-sidecar/src/rag_sidecar/contracts/validate.py","rag-sidecar/src/rag_sidecar/export_schemas.py","rag-sidecar/src/rag_sidecar/main.py","rag-sidecar/src/rag_sidecar/settings.py","rag-sidecar/tests/test_auth.py","rag-sidecar/tests/test_boot.py","rag-sidecar/tests/test_contract_export.py","rag-sidecar/tests/test_contract_models.py","rag-sidecar/tests/test_golden_contract.py","rag-sidecar/tests/test_health.py","rag-sidecar/tests/test_image_boundary.py","rag-sidecar/uv.lock","scripts/check-config.mjs","scripts/check-config.test.mjs","scripts/ci/check-workflows.py","scripts/config-server.js","scripts/config-ui/index.html","scripts/gen-zod.mjs","scripts/init-env.js","scripts/rag/env-manifest.json","scripts/tests/gen-zod.node-test.mjs","scripts/typecheck-new.mjs","scripts/typecheck-new.test.mjs","src/app/api/internal/rag/run/route.ts","src/lib/env.ts","src/lib/rag-eval/answer.ts","src/lib/rag-eval/auth.ts","src/lib/rag-eval/contracts.generated.ts","src/lib/rag-eval/legacy-post-filter.ts","src/lib/rag-eval/trace.ts","tests/chat-messages-roundtrip.test.ts","tests/chat-source-images.test.ts","tests/chat-strict.test.ts","tests/chat-websearch.test.ts","tests/contracts.test.ts","tests/eval-answer-sentinel.test.ts","tests/eval-answer.test.mts","tests/eval-corpus.test.ts","tests/eval-env-pin.test.ts","tests/eval-harness.test.ts","tests/eval-route-auth.test.ts","tests/fixture-edge.test.mts","tests/fixtures/contracts/samples.json","tests/helpers/chat-route-fakes.ts","tests/legacy-post-filter-sentinel.test.ts","tests/legacy-post-filter.test.ts","tests/prompt-context.test.mts","tests/schema-parity.test.ts","tests/setup-env.ts","tsconfig.typecheck-new.json","vitest.config.ts"]
covered_digest: "v4:sha256:63121ab5c9ef39911502670319f8ac9cf4d2c4888913562b8e2c4f65649356d3"
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "The rag-sidecar/ service builds from its Dockerfile and answers health and readiness checks"
    status: failed
    reason: "The image's CMD is `uv run --no-sync uvicorn ...` executed as USER 10001, created with `useradd --system --no-create-home` (HOME=/home/sidecar, which does not exist; /home is root-owned). The Dockerfile sets no UV_CACHE_DIR / UV_NO_CACHE. uv 0.11.32 (the exact version the Dockerfile copies) refuses to start `uv run --no-sync` when it cannot create $HOME/.cache/uv: reproduced locally with capabilities dropped and an unwritable home parent -> `error: Failed to initialize cache at .../sidecar/.cache/uv ... Permission denied (os error 13)`, exit 2; the same command with a writable UV_CACHE_DIR prints ok. The container will therefore exit at start and never answer /health or /ready. test_boot.py does not catch this because it launches the venv python directly as root, and test_image_boundary.py only asserts Dockerfile text."
    artifacts:
      - path: "rag-sidecar/Dockerfile"
        issue: "CMD `uv run --no-sync ...` as non-root user with no writable cache directory; container start fails"
      - path: "rag-sidecar/tests/test_image_boundary.py"
        issue: "Static Dockerfile assertions only; nothing exercises the CMD as the image user"
    missing:
      - "Make the runtime command independent of a uv cache: e.g. `ENV UV_CACHE_DIR=/tmp/uv-cache` (or UV_NO_CACHE=1), or run `/app/.venv/bin/uvicorn rag_sidecar.main:app ...` directly (with PATH=/app/.venv/bin:$PATH)"
      - "Add a boot test that runs the exact CMD with a non-writable HOME (or as a non-root uid) so the regression is caught without Docker"
      - "Confirm with `docker build` + `docker run` (or the pr-smoke docker-build job): /health 200, /ready 503 without secret and 200 with it, /v1/info 401/200"
human_verification:
  - test: "Docker image build and run (after the gap above is fixed): `docker build -t rag-sidecar:local rag-sidecar`; `docker run --rm -p 8000:8000 rag-sidecar:local`; curl /health and /ready; repeat with -e RAG_SIDECAR_SECRET=<48 random chars> and curl -H 'x-sidecar-secret: <same>' /v1/info; `docker inspect` for non-root user and healthy status"
    expected: "build succeeds; /health 200; /ready 503 without the secret, 200 with it; /v1/info 401 without the header, 200 with it; healthy, non-root"
    why_human: "No Docker daemon in this environment"
  - test: "First real CI run: push a branch, open a PR, confirm every pr-smoke job is green (ts, schema-parity, python, eval-smoke, gate-negative-control, docker-build); then trigger nightly via workflow_dispatch before and after adding OPENROUTER_API_KEY and OPENAI_API_KEY secrets"
    expected: "All pr-smoke jobs green; gate-negative-control passes because the degraded run exits 1; nightly prints the skip notice without secrets and uploads eval/out/nightly with judge.json covering zh/en/it with secrets"
    why_human: "No GitHub Actions runner here; workflows were only validated structurally (scripts/ci/check-workflows.py OK)"
  - test: "Live judge tier: with real OPENROUTER_API_KEY and OPENAI_API_KEY run `npx tsx eval/harness/run-nightly.mts --generator live --out eval/out/nightly-live` then `uv run --directory eval python -m rag_eval.judge.run --traces eval/out/nightly-live/traces.jsonl --golden eval/fixtures/golden.jsonl --manifest eval/out/nightly-live/run.json --out eval/out/nightly-live`; hand-check about 20 judged items per language"
    expected: "judge.json validates; all six metric pairs have n > 0 per language; hand-checked verdicts agree with scores for most items; if openai/gpt-5-mini rejects temperature 0 the run fails loudly (JudgeFatalError) and another non-Claude judge is pinned"
    why_human: "Needs live keys and human judgement of zh/it judging quality"
  - test: "Real-knowledge-base golden drafting and review: with ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY and a real Supabase workspace run `uv run --directory eval python -m rag_eval.draft --source supabase --org <org-uuid> --out eval/golden/private/golden-v1.jsonl --n 120`, then review every item and set review_status"
    expected: "50-200 items across zh/en/it and all seven categories; rejected-quote count reported; git status shows nothing under eval/golden/private; the user reviewed every item; the Claude model id in eval/config/draft.json (claude-sonnet-5-5) and the Ragas wiring work or are corrected"
    why_human: "Needs live keys, a real knowledge base and the user's review of every item"
  - test: "Live baseline: with RAG_EVAL_ENDPOINT_ENABLED=true and RAG_EVAL_SECRET on a deployment and the reviewed real golden set, run `RAG_EVAL_SECRET=<secret> uv run --directory eval python -m rag_eval.baseline record --runs 3 --base-url <url> --golden eval/golden/private/golden-v1.jsonl --allow-spread --out eval/golden/private/live-baseline.json`; set per-metric improvement targets"
    expected: "Three live runs with config hashes, mean and spread per metric per language and category; the user records improvement targets; nothing under eval/golden/private is tracked"
    why_human: "Needs the real knowledge base, the OpenAI embedding key and the reviewed real golden set; targets are a user decision"
  - test: "Prohibition review (01-02/01-04): 'MUST NOT edit today's retrieval or generation code ... byte-identical to commit 325a2c9'"
    expected: "Human confirms acceptance. Directly observed satisfied now (`git diff --stat 325a2c9 HEAD` over src/app/api/chat/route.ts, src/lib/enhanced-rag-retrieval.ts, src/lib/document-processor.ts, src/lib/supabase.ts, src/lib/thinking-rag-enhancer.ts, supabase/ is empty), but the declared test-tier enforcement is not wired: no test pins these files to 325a2c9 (the legacy-post-filter sentinel only checks route literals)"
    why_human: "unverified-prohibition — human review recommended (test-tier prohibition with no wired enforcement fails closed to flagged)"
---

# Phase 1: Evaluation Harness & Baseline Verification Report

**Phase Goal:** The quality of today's RAG system is measured reproducibly, per language and per question category, and CI blocks any change that makes it worse
**Verified:** 2026-11-23T11:26:24Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Commands run by the verifier

| Command | Result |
| --- | --- |
| `npm test` (vitest) | 13 files, 117 tests passed, exit 0 |
| `node --import tsx --test tests/fixture-edge.test.mts tests/prompt-context.test.mts tests/eval-answer.test.mts` (CI ts job; not part of `npm test`) | 37 passed, 0 failed |
| `node --test scripts/check-config.test.mjs scripts/typecheck-new.test.mjs` | 21 passed |
| `node --test scripts/tests/gen-zod.node-test.mjs` (not run by CI) | 7 passed |
| `node scripts/check-config.mjs` | `ok: 64 variable(s) match the manifest`, exit 0 |
| `npm run typecheck:new` | no Phase 1 type errors (103 legacy diagnostics ignored), exit 0 |
| `npm run test-rag` | 72 traces, report written, `gate: PASS (0 skipped)`, exit 0 |
| `npm run test-rag -- --max-results 1 --out eval/out/degraded` | `gate: FAIL, 8 metric(s) beyond the noise band`, exit 1 (as required) |
| `uv run --directory rag-sidecar pytest -q` | 137 passed |
| `uv sync --directory eval --all-extras && uv run --directory eval pytest -q` | 185 passed |
| `python3 scripts/ci/check-workflows.py` | `check-workflows: OK`, exit 0 |
| Schema parity, done out of tree: `export_all()` into scratch + `gen-zod.mjs` on it, diffed with committed `rag-sidecar/schemas`, `tests/fixtures/contracts/samples.json`, `src/lib/rag-eval/contracts.generated.ts` | all identical |
| `rag_eval.baseline record --runs 3` into scratch, compared with committed `eval/baselines/fixture-baseline.json` | slices and run_config_hash identical (reproducible) |
| `run-nightly.mts --generator stub` into scratch, then `run_judge` with the test stub judge on those real fixture traces | 72 valid traces (48 answered); all six DeepEval/Ragas metrics computed overall, per language (zh/en/it) and per category (7) |
| `uv run --no-sync` (uv 0.11.32) with an unwritable HOME cache dir, capabilities dropped | `Failed to initialize cache ... Permission denied`, exit 2 (see gap) |

`git status` was clean after every command; nothing under source control was modified.

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `rag-sidecar/` builds from its Dockerfile and answers health and readiness checks; tests show missing/wrong secret rejected and every request refused when the secret is unset | ✗ FAILED (partial) | Auth half VERIFIED: `auth.py` SHA-256 digests + `hmac.compare_digest`, 32-char minimum, 503 for every non-probe path when unset; tests cover missing/wrong/near-miss/non-ASCII headers, docs/openapi, unknown paths, 20 concurrent requests, and a real uvicorn boot without the secret (/health 200, /ready 503, /v1/info 503). /health and /ready stay open per D-21. Docker half FAILED: the CMD `uv run --no-sync` runs as uid 10001 with no creatable cache directory; reproduced uv 0.11.32 exiting 2 under the same condition, so the container cannot answer probes. |
| 2 | `npm run test-rag` runs the smoke tier on the zh/en/it fixture corpus through the authenticated `POST /api/internal/rag/run` (off in production unless enabled) and reports Recall@k, MRR, correct- and false-refusal per language and per category, with no customer data, no live keys and no judge | ✓ VERIFIED | `run-smoke.mts` -> `runEval` builds a `NextRequest` with `x-rag-eval-secret` and calls the real route `POST` in-process; the route runs unmodified `enhancedRetrieveChunks` against PGlite+pgvector through 127.0.0.1 fakes; `checkEvalAccess` returns 404 in production unless `RAG_EVAL_ENDPOINT_ENABLED=true`, 503 without a 32+ char secret, 401 on a bad header (tests in `tests/eval-route-auth.test.ts`). The run produced report.md with overall, per-language, per-category and language x category tables. |
| 3 | A three-run baseline with a config hash per run and mean/spread is committed, and a PR dropping a deterministic metric beyond the noise band fails the PR smoke workflow (shown with a degraded config) | ✓ VERIFIED (first CI run is human) | `eval/baselines/fixture-baseline.json` has 3 runs, each with run_config_hash, plus mean/spread/n per metric per slice; re-recording reproduces it exactly. Gate = mean minus max(3 x stdev, 0.02) on overall and language slices, with a data-mismatch exit 2. The degraded run exits 1 locally. `pr-smoke.yml` has `eval-smoke` (gate against the committed baseline) and `gate-negative-control` (asserts exit 1). |
| 4 | CI fails on a Pydantic change without regenerated Zod, on an RAG env var missing from any of the five config locations, or on a broken characterization test; those tests pass today for strict "information not available", webSearch+strict with Exa, `source_images` streaming and persistence, and `{{context}}` substitution | ✓ VERIFIED (with WARNING) | The `schema-parity` job regenerates and runs `git diff --exit-code`; parity holds today (checked out of tree). `check-config` runs in the `ts` job, and its self-tests show it fails on injected drift. The characterization tests import the real `src/app/api/chat/route.ts` with mocked edges, and all pass. WARNING: 44 legacy variables are tolerated as `knownGaps` (see Warnings). |
| 5 | Drafting tool writes span-labelled golden items (document, section, quote, language, category, review status; never chunk IDs) to a gitignored location with a frozen split; the nightly tier computes Faithfulness, Answer Relevance, Context Recall with a pinned different-family judge and telemetry disabled (stub judge, fixture workspace) | ✓ VERIFIED (live runs are human) | `GoldenItem`/`GoldSpan` hold no chunk-ID field (`extra="forbid"`). `assert_private_path` requires the path under `eval/golden/private/`, git-ignored and untracked (checked with `git check-ignore`). The split uses a frozen sha256 rule plus a manifest. Supabase source tests require exactly one scope. Ragas personas, styles and the `ragas_generated` provenance are covered. Judge: `openai/gpt-5-mini` at temperature 0, family check refuses Claude or same-family judges, telemetry env opt-outs, refusal when `CONFIDENT_API_KEY` is set, socket-spy test proves no outbound traffic. The verifier's own stub-judge run on real fixture traces returned all six metrics. |

**Score:** 4/5 truths verified (0 present, behavior-unverified)

Plan-level must-haves: `verify.artifacts` and `verify.key-links` pass for all 22 plans (every artifact and every key link verified). The one `verification: backstop` truth (01-21, atomic gen:schemas writes) has explicit passing evidence: `test_interrupted_write_leaves_existing_files_and_no_temp_file` (Python) and the gen-zod "leaves no temp file and no partial output" test.

### Required Artifacts (key ones)

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `rag-sidecar/src/rag_sidecar/{main,auth,settings}.py` | FastAPI probes + fail-closed auth | ✓ VERIFIED | substantive, tested, booted via uvicorn in test_boot |
| `rag-sidecar/Dockerfile` | buildable, runnable image | ✗ defective | CMD fails at start as non-root (uv cache) |
| `rag-sidecar/src/rag_sidecar/contracts/*` + `schemas/` + `src/lib/rag-eval/contracts.generated.ts` | single-source contracts, generated Zod | ✓ VERIFIED | regeneration identical |
| `src/app/api/internal/rag/run/route.ts`, `src/lib/rag-eval/*` | authenticated eval endpoint + trace | ✓ VERIFIED | wired to real retrieval and the legacy post-filter replica (sentinel-guarded) |
| `eval/harness/*.mts` | in-process and HTTP harness, PGlite, fakes | ✓ VERIFIED | 72 traces, zero edge errors |
| `eval/src/rag_eval/{metrics,report,runner,gate,baseline}.py` | deterministic scoring, gate, baseline | ✓ VERIFIED | exercised by test-rag and the degraded run |
| `eval/src/rag_eval/judge/*`, `eval/src/rag_eval/draft/*` | judge tier, drafting tool | ✓ VERIFIED (offline) | stubs only; live is human |
| `eval/fixtures/{corpus,golden.jsonl,split-manifest.json}` | zh/en/it fixture corpus + 72-item golden | ✓ VERIFIED | 24 per language, all 7 categories, PII and quote tests |
| `eval/baselines/fixture-baseline.json`, `eval/config/noise.json` | baseline + noise band | ✓ VERIFIED | reproducible |
| `scripts/check-config.mjs`, `scripts/rag/env-manifest.json` | five-location drift check | ✓ VERIFIED (ratchet) | 4 managed, 60 legacy (44 with knownGaps) |
| `.github/workflows/pr-smoke.yml`, `nightly.yml` | PR smoke + nightly tiers | ✓ present, structurally checked | never run on GitHub (human) |

### Key Link Verification

| From | To | Via | Status |
| --- | --- | --- | --- |
| `npm run test-rag` | eval route `POST` | in-process `NextRequest` with secret header | WIRED |
| eval route | `enhancedRetrieveChunks` -> PGlite `match_*` RPC | fake PostgREST + fake embeddings on 127.0.0.1 | WIRED (zero edge errors) |
| traces | `rag_eval.runner score` -> `rag_eval.gate` | spawned `uv run` | WIRED (exit codes propagate: degraded run exits 1) |
| Pydantic models | Zod | `export_schemas` -> `gen-zod.mjs` -> CI `git diff --exit-code` | WIRED |
| pr-smoke jobs | test-rag, check-config, typecheck:new, vitest, pytest, docker | workflow steps | WIRED (structure only) |
| nightly | `run-nightly.mts --generator live` -> `rag_eval.judge.run` | workflow steps, key-presence skip | WIRED (structure only) |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
| --- | --- | --- | --- | --- |
| report.json/report.md | per-slice metrics | traces from the real retrieval code over the PGlite fixture DB | yes (deterministic fixture embedder) | ✓ FLOWING |
| gate.json | offenders | report vs committed baseline | yes | ✓ FLOWING |
| judge report | six judge metrics | answered traces + golden | stub judge only here | ✓ FLOWING (offline) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Smoke tier passes on today's code | `npm run test-rag` | exit 0, gate PASS | ✓ PASS |
| Degraded config fails the gate | `npm run test-rag -- --max-results 1 --out eval/out/degraded` | exit 1, 8 offenders (overall and every language, recall@5/@10) | ✓ PASS |
| Baseline is reproducible | `rag_eval.baseline record --runs 3 --out <scratch>` | identical slices and hash | ✓ PASS |
| Schema parity | out-of-tree regeneration + diff | identical | ✓ PASS |
| Nightly stub pipeline + stub judge | `run-nightly.mts --generator stub` + `run_judge` with stubs | six metrics per language and category | ✓ PASS |
| Container start command | `uv run --no-sync ...` with an unwritable HOME cache | exit 2, cache init error | ✗ FAIL |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes are declared or present. Step 7c: not applicable.

### Requirements Coverage

| Requirement | Description (short) | Status | Evidence |
| --- | --- | --- | --- |
| EVAL-01 | Sidecar: FastAPI, 3.12, pydantic>=2.14.4, probes, Dockerfile, constant-time fail-closed auth | ✗ BLOCKED (Dockerfile runtime) | Code and auth satisfied; image CMD cannot start (gap) |
| EVAL-02 | Pydantic single source, generated Zod, CI fails on stale Zod | ✓ SATISFIED | parity job + tests; regeneration identical |
| EVAL-03 | Span-based gold evidence, language, category, review status, no chunk IDs | ✓ SATISFIED | `golden.py` contract + tests |
| EVAL-04 | Synthetic zh/en/it fixture corpus + golden set committed | ✓ SATISFIED | 72 items, PII/quote/coverage tests |
| EVAL-05 | Drafting tool (Claude + Ragas), private storage, frozen split, styles/personas, `ragas_generated` | ✓ SATISFIED offline / ? NEEDS HUMAN live | stub-verified; real-workspace drafting and review pending |
| EVAL-06 | Authenticated internal endpoint returning a trace | ✓ SATISFIED | route + auth tests; `query_transforms` and `citations` are empty by design (today's system has neither) |
| EVAL-07 | Deterministic Recall@k, MRR by gold span, separate refusal rates | ✓ SATISFIED | `metrics.py`, report |
| EVAL-08 | Judge metrics via DeepEval + Ragas, pinned different-family judge, telemetry off, per language/category | ✓ SATISFIED offline / ? NEEDS HUMAN live | stub-verified |
| EVAL-09 | 3-run baseline, config hash per run, mean/spread; later phases compare by paired differences | ✓ SATISFIED (see WARNING) | per-item ItemResults are in every report, but there is no paired-difference tool and the baseline stores no per-item rows; ROADMAP Phase 2 SC5 has "the fixture eval records paired differences against baseline" |
| EVAL-10 | CI PR smoke + nightly tiers; PR fails beyond noise band | ✓ SATISFIED in code / ? NEEDS HUMAN | workflows present; first GitHub run pending; docker-build job will fail until the gap is fixed |
| EVAL-11 | `npm run test-rag` runs the smoke tier | ✓ SATISFIED | ran, exit 0 |
| EVAL-12 | Characterization tests lock four behaviors | ✓ SATISFIED | real chat route under mocks; all pass |
| EVAL-13 | Config manifest + check-config fails on any missing location | ✓ SATISFIED with deviation (WARNING) | knownGaps ratchet |

No orphaned requirements: EVAL-01..13 all map to Phase 1 and every one is claimed by a plan. EVAL-14..17 map to later phases.

### Prohibitions

| Prohibition | Tier | Enforcement | Disposition |
| --- | --- | --- | --- |
| Retrieval and generation code byte-identical to 325a2c9 (01-02, 01-04) | test | No wired test. Directly observed: `git diff 325a2c9 HEAD` on the six paths is empty | ⚠️ flagged: unverified-prohibition, human review recommended (satisfied today) |
| No real-looking PII in fixtures (01-07, 01-08, 01-15) | test | `eval/tests/test_fixture_pii.py` | ✓ enforced |
| No telemetry or results upload from the judge (01-18) | test | telemetry/config tests, socket spy, `CONFIDENT_API_KEY` refusal | ✓ enforced |
| No customer-derived items committed (01-19) | test | writer tests: ignored, untracked, git-failure refusal | ✓ enforced |
| No reads outside the named workspace (01-19) | test | `test_draft_sources.py` scope and foreign-chunk tests | ✓ enforced |
| Gate and CI never rewrite the baseline or noise band (01-20) | test | `test_gate_leaves_baseline_unchanged` | ✓ enforced |

### Decision Coverage

All trackable CONTEXT.md decisions are honored by shipped artifacts (25/25; `check.decision-coverage-verify`).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `rag-sidecar/Dockerfile` | CMD / USER | `uv run` as a non-root user with no writable cache dir | 🛑 Blocker | Container cannot start (gap) |
| `rag-sidecar/tests/test_boot.py` | - | boots with the venv python as root, not the image CMD/user | ⚠️ Warning | Missed the Docker start failure |
| `scripts/tests/gen-zod.node-test.mjs` | - | not run by `npm test` or any CI job | ℹ️ Info | Dead test file (passes when run by hand; schema-parity.test.ts covers similar ground) |
| `scripts/ci/check-workflows.py` | - | not run in CI | ℹ️ Info | Structural check is manual only |
| `tests/*.test.mts` | - | excluded from `npm test` (vitest `include: tests/**/*.test.ts`); only the CI `ts` job runs them | ℹ️ Info | Local `npm test` is not the full TS suite |

No TBD/FIXME/XXX/TODO/HACK markers in the files this phase modified (the `PLACEHOLDER` hits in `tests/prompt-context.test.mts` name the `{{context}}` constant).

### Warnings (not gaps, human decision requested)

1. **EVAL-13 / SC4 ratchet.** `check-config` fails on any new or regressed gap, but 44 of 60 legacy variables are allowed to be missing from one or more locations through `knownGaps`, by explicit plan decision (01-11: "Do not fix legacy gaps in this phase (no behavior change)"). The literal requirement says it "fails when any of the five config locations is missing an entry". `.env.local` is checked only when present, so in CI it is never checked. If this is accepted, add an override:
   ```yaml
   overrides:
     - must_have: "check-config fails when any of the five config locations is missing an entry"
       reason: "Legacy drift for 44 pre-existing variables is frozen as a knownGaps ratchet (list can only shrink); all Phase 1 and later variables are managed with no gaps"
       accepted_by: "{name}"
       accepted_at: "{ISO timestamp}"
   ```
2. **Gate scope vs the milestone criterion.** The ROADMAP milestone rule says no metric "(overall, per language, per category)" may drop beyond the noise band. The gate covers only overall and language slices. Category slices are report-only (D-20, a recorded user decision). A category regression that is offset elsewhere in the same language would not fail CI.
3. **Paired differences (EVAL-09).** There is no paired-difference statistic, and the committed baseline holds slice aggregates only, with no per-item rows. Per-item results exist in each report.json and the fixture run is deterministic, so they can be rebuilt. The tooling falls to Phase 2 SC5.
4. **Fixture sensitivity.** With the fixture embedder, retrieval returns at most 4 candidates, and 23 of 72 items return none. Recall@5 always equals Recall@10, and false refusal is 0.30. The fixture baseline measures today's code, but it cannot tell apart changes in ranks 5 to 10. The real-KB baseline (human item) is the one that informs targets.
5. **Draft model id.** `eval/config/draft.json` pins `claude_model: "claude-sonnet-5-5"`. It is unverified offline; the live drafting run must confirm it.

### Human Verification Required

Listed in frontmatter `human_verification` (6 items): Docker build/run (after the fix), first real pr-smoke + nightly GitHub run, live judge hand-check, real-KB golden drafting + full user review, live three-run baseline + improvement targets, and acceptance of the unwired retrieval-code-frozen prohibition.

### Gaps Summary

One blocking gap. The sidecar image will not start. `rag-sidecar/Dockerfile` runs `uv run --no-sync uvicorn ...` as uid 10001, which has no home directory and no `UV_CACHE_DIR`. uv 0.11.32 aborts when it cannot create its cache: reproduced locally under the same permission conditions with `Permission denied (os error 13)`, exit 2. So SC1's "builds from its Dockerfile and answers health and readiness checks" is not met, EVAL-01 stays open, and the `docker-build` job in pr-smoke would fail on the first real CI run. The fix is small: set `UV_CACHE_DIR`/`UV_NO_CACHE`, or call `/app/.venv/bin/uvicorn` directly. Add a boot test that runs the real CMD as non-root, then do the Docker human check.

Everything else in the phase goal works in this environment. Today's system is measured reproducibly on the zh/en/it fixture corpus, per language and per category, through the authenticated endpoint and the unmodified retrieval code. The three-run baseline reproduces exactly. The noise-band gate passes today's code and rejects a degraded config with exit 1. Schema parity, config drift and characterization tests are wired into CI. The drafting and judge tiers work offline with stubs. The remaining items need Docker, GitHub Actions, live keys or the real knowledge base and are listed above as human verification.

---

_Verified: 2026-11-23T11:26:24Z_
_Verifier: Claude (gsd-verifier)_
