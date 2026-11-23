---
phase: 01-evaluation-harness-baseline
verified: 2026-11-23T12:13:06Z
status: human_needed
score: 5/5 must-haves verified
covered_files: [".github/workflows/nightly.yml",".github/workflows/pr-smoke.yml",".gitignore",".planning/phases/01-evaluation-harness-baseline/01-01-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-01-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-02-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-02-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-03-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-03-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-04-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-04-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-05-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-05-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-06-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-06-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-07-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-07-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-08-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-08-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-09-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-09-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-10-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-10-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-11-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-11-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-12-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-12-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-13-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-13-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-14-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-14-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-15-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-15-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-16-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-16-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-17-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-17-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-18-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-18-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-19-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-19-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-20-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-20-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-21-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-21-SUMMARY.md",".planning/phases/01-evaluation-harness-baseline/01-22-PLAN.md",".planning/phases/01-evaluation-harness-baseline/01-22-SUMMARY.md","eval/.gitignore","eval/baselines/fixture-baseline.json","eval/config/draft.json","eval/config/judge.json","eval/config/noise.json","eval/config/rag-eval-env.json","eval/fixtures/golden.jsonl","eval/fixtures/split-manifest.json","eval/harness/corpus.mts","eval/harness/eval-env.mts","eval/harness/fake-edge.mts","eval/harness/fixture-embedder.mts","eval/harness/pglite-supabase.mts","eval/harness/run-eval.mts","eval/harness/run-nightly.mts","eval/harness/run-smoke.mts","eval/pyproject.toml","eval/src/rag_eval/__init__.py","eval/src/rag_eval/baseline.py","eval/src/rag_eval/corpus.py","eval/src/rag_eval/draft/__init__.py","eval/src/rag_eval/draft/__main__.py","eval/src/rag_eval/draft/claude_drafter.py","eval/src/rag_eval/draft/cli.py","eval/src/rag_eval/draft/config.py","eval/src/rag_eval/draft/ragas_drafter.py","eval/src/rag_eval/draft/sources.py","eval/src/rag_eval/draft/verify.py","eval/src/rag_eval/draft/writer.py","eval/src/rag_eval/gate.py","eval/src/rag_eval/golden_io.py","eval/src/rag_eval/judge/__init__.py","eval/src/rag_eval/judge/config.py","eval/src/rag_eval/judge/deepeval_judge.py","eval/src/rag_eval/judge/ragas_judge.py","eval/src/rag_eval/judge/run.py","eval/src/rag_eval/judge/telemetry.py","eval/src/rag_eval/matching.py","eval/src/rag_eval/metrics.py","eval/src/rag_eval/paths.py","eval/src/rag_eval/report.py","eval/src/rag_eval/runner.py","eval/src/rag_eval/split.py","eval/src/rag_eval/traces.py","eval/tests/judge_stubs.py","eval/tests/test_baseline.py","eval/tests/test_corpus.py","eval/tests/test_draft_cli.py","eval/tests/test_draft_sources.py","eval/tests/test_draft_writer.py","eval/tests/test_fixture_coverage.py","eval/tests/test_fixture_pii.py","eval/tests/test_fixture_quotes.py","eval/tests/test_gate.py","eval/tests/test_golden_io.py","eval/tests/test_judge_config.py","eval/tests/test_judge_offline.py","eval/tests/test_matching.py","eval/tests/test_metrics.py","eval/tests/test_report_runner.py","eval/tests/test_split.py","eval/uv.lock","package-lock.json","package.json","rag-sidecar/.dockerignore","rag-sidecar/.gitignore","rag-sidecar/Dockerfile","rag-sidecar/pyproject.toml","rag-sidecar/schemas/Baseline.schema.json","rag-sidecar/schemas/ConversationTurn.schema.json","rag-sidecar/schemas/DraftedItemBatch.schema.json","rag-sidecar/schemas/EvalReport.schema.json","rag-sidecar/schemas/GateResult.schema.json","rag-sidecar/schemas/GoldenItem.schema.json","rag-sidecar/schemas/GoldenSplitManifest.schema.json","rag-sidecar/schemas/JudgeConfig.schema.json","rag-sidecar/schemas/JudgeReport.schema.json","rag-sidecar/schemas/NoiseConfig.schema.json","rag-sidecar/schemas/RagRunRequest.schema.json","rag-sidecar/schemas/RagTrace.schema.json","rag-sidecar/schemas/RunManifest.schema.json","rag-sidecar/schemas/SidecarError.schema.json","rag-sidecar/schemas/SidecarHealth.schema.json","rag-sidecar/schemas/SidecarInfo.schema.json","rag-sidecar/schemas/SidecarReady.schema.json","rag-sidecar/src/rag_sidecar/__init__.py","rag-sidecar/src/rag_sidecar/auth.py","rag-sidecar/src/rag_sidecar/contracts/__init__.py","rag-sidecar/src/rag_sidecar/contracts/baseline.py","rag-sidecar/src/rag_sidecar/contracts/eval_run.py","rag-sidecar/src/rag_sidecar/contracts/golden.py","rag-sidecar/src/rag_sidecar/contracts/judge.py","rag-sidecar/src/rag_sidecar/contracts/report.py","rag-sidecar/src/rag_sidecar/contracts/samples.py","rag-sidecar/src/rag_sidecar/contracts/sidecar.py","rag-sidecar/src/rag_sidecar/contracts/validate.py","rag-sidecar/src/rag_sidecar/export_schemas.py","rag-sidecar/src/rag_sidecar/main.py","rag-sidecar/src/rag_sidecar/settings.py","rag-sidecar/tests/test_auth.py","rag-sidecar/tests/test_boot.py","rag-sidecar/tests/test_contract_export.py","rag-sidecar/tests/test_contract_models.py","rag-sidecar/tests/test_golden_contract.py","rag-sidecar/tests/test_health.py","rag-sidecar/tests/test_image_boundary.py","rag-sidecar/uv.lock","scripts/check-config.mjs","scripts/check-config.test.mjs","scripts/ci/check-workflows.py","scripts/config-server.js","scripts/config-ui/index.html","scripts/gen-zod.mjs","scripts/init-env.js","scripts/rag/env-manifest.json","scripts/tests/gen-zod.node-test.mjs","scripts/typecheck-new.mjs","scripts/typecheck-new.test.mjs","src/app/api/internal/rag/run/route.ts","src/lib/env.ts","src/lib/rag-eval/answer.ts","src/lib/rag-eval/auth.ts","src/lib/rag-eval/contracts.generated.ts","src/lib/rag-eval/legacy-post-filter.ts","src/lib/rag-eval/trace.ts","tests/chat-messages-roundtrip.test.ts","tests/chat-source-images.test.ts","tests/chat-strict.test.ts","tests/chat-websearch.test.ts","tests/contracts.test.ts","tests/eval-answer-sentinel.test.ts","tests/eval-answer.test.mts","tests/eval-corpus.test.ts","tests/eval-env-pin.test.ts","tests/eval-harness.test.ts","tests/eval-route-auth.test.ts","tests/eval-trace-config.test.ts","tests/fixture-edge.test.mts","tests/fixtures/contracts/samples.json","tests/helpers/chat-route-fakes.ts","tests/legacy-post-filter-sentinel.test.ts","tests/legacy-post-filter.test.ts","tests/prompt-context.test.mts","tests/schema-parity.test.ts","tests/setup-env.ts","tsconfig.typecheck-new.json","vitest.config.ts"]
covered_digest: "v4:sha256:e05c8d115648d0eb52fd98cb31424d94667d17197ed5fae056fb952fcefb8a89"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "The rag-sidecar/ service builds from its Dockerfile and answers health and readiness checks (CMD now runs /app/.venv/bin/uvicorn directly, no uv at runtime; image build itself still needs the Docker human check)"
  gaps_remaining: []
  regressions: []
advisory:
  - finding: "Running the nightly harness with --generator stub and no --generator-model writes generator_model 'stub/extractive-v1', and since WR-12 the judge refuses it (JudgeFamilyError: cannot determine the model family). The offline stub-generator to judge path only works with an explicit --generator-model."
    category: other
    reason: "Fail-closed by design (WR-12). The nightly workflow uses --generator live, whose fallback model anthropic/claude-sonnet-4.5 resolves to the anthropic family. Reproduced here; workaround run passed (see report). Resolve by mapping the stub id to a family, or document --generator-model for offline judge runs."
    evidence_status: "reproduced, but no must-have depends on the default stub id reaching the judge"
  - finding: "No boot test runs the image CMD as a non-root user; the regression guard is the static test test_cmd_runs_venv_uvicorn_without_uv_at_runtime"
    category: other
    reason: "The previous gap asked for a non-root boot test. The static guard blocks a return to `uv run`, and the verifier ran the CMD equivalent with all capabilities dropped and an unwritable HOME (probes answered). The docker-build CI job covers the real image."
    evidence_status: "none provided (no failing behavior)"
human_verification:
  - test: "Docker image build and run: `docker build -t rag-sidecar:local rag-sidecar`; `docker run --rm -p 8000:8000 rag-sidecar:local`; curl /health and /ready; repeat with -e RAG_SIDECAR_SECRET=<48 random chars> and curl -H 'x-sidecar-secret: <same>' /v1/info; `docker inspect` for user 10001 and healthy status (or let the pr-smoke docker-build job do it)"
    expected: "build succeeds (digest-pinned python:3.12-slim, BuildKit cache mounts); /health 200; /ready 503 without the secret and 200 with it; /v1/info 401 without the header and 200 with it; runs as uid 10001; HEALTHCHECK healthy"
    why_human: "No Docker daemon in this environment. The CMD was exercised outside Docker only"
  - test: "First real CI run: push a branch, open a PR, confirm every pr-smoke job is green (ts, schema-parity, python, eval-smoke, gate-negative-control, docker-build); then trigger nightly via workflow_dispatch before and after adding OPENROUTER_API_KEY and OPENAI_API_KEY secrets"
    expected: "All pr-smoke jobs green; gate-negative-control passes because the degraded run exits 10 and gate.json lists offenders with no mismatches; nightly prints '::notice::judge key not configured, skipping' without secrets and uploads eval/out/nightly with judge.json covering zh/en/it with secrets"
    why_human: "No GitHub Actions runner here. The workflows were only checked structurally (check-workflows OK; all action SHAs match their upstream tags per git ls-remote)"
  - test: "Live judge tier: with real OPENROUTER_API_KEY and OPENAI_API_KEY run `npx tsx eval/harness/run-nightly.mts --generator live --out eval/out/nightly-live` then `uv run --directory eval python -m rag_eval.judge.run --traces eval/out/nightly-live/traces.jsonl --golden eval/fixtures/golden.jsonl --manifest eval/out/nightly-live/run.json --out eval/out/nightly-live`; hand-check about 20 judged items per language"
    expected: "judge.json validates; all six metric pairs have n > 0 per language; hand-checked verdicts agree with the scores for most items; if openai/gpt-5-mini rejects temperature 0 the run fails loudly and another non-Claude judge is pinned"
    why_human: "Needs live keys and a person to judge zh/it judging quality (WR-12 and WR-13 are marked 'requires human verification' in 01-REVIEW.md)"
  - test: "Real-knowledge-base golden drafting and review: with ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY and a real Supabase workspace run `uv run --directory eval python -m rag_eval.draft --source supabase --org <org-uuid> --out eval/golden/private/golden-v1.jsonl --n 120`, then review every item and set review_status"
    expected: "50-200 items across zh/en/it and all seven categories; rejected-quote count reported; git status shows nothing under eval/golden/private; every item reviewed by the user (only approved items are scored since WR-03); the Claude model id in eval/config/draft.json (claude-sonnet-5-5) and the Ragas evidence matching (WR-13) work or are corrected"
    why_human: "Needs live keys, a real knowledge base and the user's review of every item"
  - test: "Live baseline: with RAG_EVAL_ENDPOINT_ENABLED=true, RAG_EVAL_SECRET and RAG_EVAL_ALLOWED_SCOPES on a deployment and the reviewed real golden set, run `RAG_EVAL_SECRET=<secret> uv run --directory eval python -m rag_eval.baseline record --runs 3 --base-url <https url> --org <org-uuid> --golden eval/golden/private/golden-v1.jsonl --allow-spread --out eval/golden/private/live-baseline.json`; set per-metric improvement targets"
    expected: "Three live runs with config hashes, deployment_mode taken from the server, mean and spread per metric per language and category on the dev split; the user records improvement targets; nothing under eval/golden/private is tracked"
    why_human: "Needs the real knowledge base, the OpenAI embedding key and the reviewed real golden set; the targets are the user's decision"
  - test: "Prohibition review (01-02/01-04): 'MUST NOT edit today's retrieval or generation code ... byte-identical to commit 325a2c9'"
    expected: "Human accepts. Observed satisfied now: `git diff --stat 325a2c9 HEAD` over src/app/api/chat/route.ts, src/lib/enhanced-rag-retrieval.ts, src/lib/document-processor.ts, src/lib/supabase.ts, src/lib/thinking-rag-enhancer.ts and supabase/ is empty. Enforcement is still partial: since IN-05, tests/legacy-post-filter-sentinel.test.ts pins sha256 digests of the two replicated chat-route regions, but nothing pins the other files"
    why_human: "unverified-prohibition, human review recommended (test-tier prohibition with incomplete wired enforcement fails closed to flagged)"
---

# Phase 1: Evaluation Harness & Baseline Verification Report

**Phase Goal:** The quality of today's RAG system is measured reproducibly, per language and per question category, and CI blocks any change that makes it worse
**Verified:** 2026-11-23T12:13:06Z
**Status:** human_needed
**Re-verification:** Yes. Follows the gaps_found pass at 2026-11-23T11:26:24Z, the Dockerfile fix 45beb69 and 22 of 25 code-review fixes (01-REVIEW-FIX.md)

## Commands run by the verifier (this pass)

| Command | Result |
| --- | --- |
| `npm test` (vitest) | 14 files, 130 tests passed, exit 0 |
| `node --import tsx --test tests/*.test.mts` (eval-answer, fixture-edge, prompt-context; the same three the CI `ts` job lists) | 39 passed, 0 failed |
| `node --test scripts/check-config.test.mjs scripts/typecheck-new.test.mjs scripts/tests/gen-zod.node-test.mjs` | 28 passed |
| `node scripts/check-config.mjs` | `ok: 65 variable(s) match the manifest`, exit 0 |
| `npm run typecheck:new` | no Phase 1 type errors (103 legacy diagnostics ignored), exit 0 |
| `npm run test-rag` | 72 traces, 56 gated dev items, `gate: PASS (0 skipped)`, exit 0 |
| `npm run test-rag -- --max-results 1 --out eval/out/degraded` | `gate: FAIL, 6 metric(s) beyond the noise band` (overall, en, it; recall@5 and @10), **exit 10** |
| `uv run --directory rag-sidecar pytest -q` | 138 passed |
| `uv sync --directory eval --all-extras && uv run --directory eval pytest -q` | 219 passed |
| `python3 scripts/ci/check-workflows.py`, and as CI runs it (`uv run --directory eval python ../scripts/ci/check-workflows.py`) | `check-workflows: OK`, exit 0 both ways |
| `git ls-remote` for actions/checkout v4.4.0, actions/setup-node v4.4.0, astral-sh/setup-uv v5.4.2, actions/upload-artifact v4.6.2 | every SHA pinned in the workflows matches its upstream tag |
| `rag_eval.baseline record --runs 3` into scratch, compared with committed `eval/baselines/fixture-baseline.json` | every top-level field identical: slices, golden_filter `{gate_split: dev, review_statuses: [approved]}`, tier, deployment_mode, request_options, embedder_source_sha256, all three run_config_hash values |
| Out-of-tree schema parity: `export_all()` into scratch, then `gen-zod.mjs --schemas-dir/--out` into scratch, diffed with `rag-sidecar/schemas`, `tests/fixtures/contracts/samples.json`, `src/lib/rag-eval/contracts.generated.ts` | all identical (17 schemas) |
| Image CMD outside Docker: Dockerfile-equivalent venv (`uv sync --locked --no-dev`, UV_COMPILE_BYTECODE=1, python 3.12) in scratch, then `<venv>/bin/uvicorn rag_sidecar.main:app` under `setpriv --inh-caps=-all --bounding-set=-all --no-new-privs`, `env -i`, HOME inside a mode-555 directory (CapEff 0) | without secret: /health 200, /ready 503, /v1/info 503; with a 48-char secret: /ready 200, /v1/info 401 without the header and 200 with it |
| `run-nightly.mts --generator stub` into scratch | 72 valid traces, 48 answered, valid RunManifest |
| `run_judge` with the test stub judge on those traces | refused: `JudgeFamilyError: cannot determine the model family of 'stub/extractive-v1'` (see Advisory 1) |
| `run-nightly.mts --generator stub --generator-model anthropic/claude-sonnet-4.5`, then `run_judge` with stubs | judge openai/gpt-5-mini (openai) vs generator anthropic; all six DeepEval/Ragas metrics computed, n > 0 for zh, en and it, 7 categories |

`git status` was clean after every command; no tracked file changed.

## Previous gap: re-check

| Gap | Now | Evidence |
| --- | --- | --- |
| Sidecar image CMD `uv run --no-sync` cannot start as uid 10001 (no writable uv cache) | ✓ CLOSED in code; image build is a human item | `rag-sidecar/Dockerfile` CMD is `["/app/.venv/bin/uvicorn", "rag_sidecar.main:app", "--host", "0.0.0.0", "--port", "8000"]`, `PATH` puts `/app/.venv/bin` first, and nothing calls uv at runtime. HEALTHCHECK `python` resolves to the venv python. `test_cmd_runs_venv_uvicorn_without_uv_at_runtime` fails if `uv`/`uvx` returns to the CMD. The verifier ran the equivalent command with no capabilities and an unwritable HOME, and it answered every probe as specified. Base image is now digest-pinned (IN-08). Not done: the suggested non-root boot test (Advisory 2) and a real `docker build` (no daemon) |

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `rag-sidecar/` builds from its Dockerfile and answers health and readiness checks; tests show missing/wrong secret rejected and every request refused when the secret is unset | ✓ VERIFIED (image build is human) | Auth: `auth.py` with SHA-256 digests plus `hmac.compare_digest`, a 32-char minimum (shorter secrets now also warn, IN-10), 503 on every non-probe path when unset. 138 sidecar tests cover missing, wrong, near-miss and non-ASCII headers, docs/openapi, unknown paths and concurrency, plus a real uvicorn boot without the secret. Runtime: the gap is closed (above). The `docker build` itself is only checked by the docker-build CI job and the human item |
| 2 | `npm run test-rag` runs the smoke tier on the zh/en/it fixture corpus through the authenticated `POST /api/internal/rag/run` (off in production unless enabled) and reports Recall@k, MRR, correct- and false-refusal per language and per category, with no customer data, no live keys and no judge | ✓ VERIFIED | Ran: 72 traces through the real route `POST` (in-process `NextRequest` with `x-rag-eval-secret`), unmodified `enhancedRetrieveChunks` on PGlite and pgvector behind 127.0.0.1 fakes. report.md has overall, per-language, per-category and per-split tables. Auth matrix in `tests/eval-route-auth.test.ts`: 404 in production unless enabled, 503 without a 32+ char secret, 401 on a bad header, and 403 in multi-tenant mode for a missing scope or one outside `RAG_EVAL_ALLOWED_SCOPES` (WR-01). Errors return only `retrieval failed: <ErrorName>` (WR-09). Since WR-03 only approved items are scored and the gate uses the dev split (56 of 72 items) |
| 3 | A three-run baseline with a config hash per run and mean/spread is committed, and a PR dropping a deterministic metric beyond the noise band fails the PR smoke workflow (shown with a degraded config) | ✓ VERIFIED (first CI run is human) | The re-recorded baseline has 3 runs with run_config_hash, mean, spread and n per metric per slice, and now also tier, deployment_mode, request_options, golden_filter and embedder_source_sha256. Re-recording it here reproduced it exactly. The gate flags any metric below mean minus max(3 x stdev, 0.02) on the overall and language slices. It exits 2 on a data mismatch (now including the golden filter, tier, mode, scope and embedder source), 10 on a regression and 70 on an internal error (WR-02). The degraded run exits 10 locally. The `gate-negative-control` job asserts `test "$code" -eq 10` and checks gate.json with `jq` for offenders and no mismatches |
| 4 | CI fails on a Pydantic change without regenerated Zod, on an RAG env var missing from any of the five config locations, or on a broken characterization test; those tests pass today for strict "information not available", webSearch+strict with Exa, `source_images` streaming and persistence, and `{{context}}` substitution | ✓ VERIFIED (with WARNING) | The `schema-parity` job regenerates and runs `git diff --exit-code`, and parity holds today (checked out of tree). The `ts` job runs check-config, its self-tests, the gen-zod self-test, typecheck:new and check-workflows. The characterization tests import the real `src/app/api/chat/route.ts` and pass. The legacy-post-filter sentinel now pins sha256 digests of the replicated route regions (IN-05). WARNING: 44 legacy variables are still tolerated through `knownGaps` |
| 5 | Drafting tool writes span-labelled golden items (document, section, quote, language, category, review status; never chunk IDs) to a gitignored location with a frozen split; the nightly tier computes Faithfulness, Answer Relevance, Context Recall with a pinned different-family judge and telemetry disabled (stub judge, fixture workspace) | ✓ VERIFIED (live runs are human) | Contracts: `GoldenItem` and `GoldSpan` have no chunk-ID field (`extra="forbid"`). `assert_private_path` requires an ignored, untracked path under `eval/golden/private/`. The split is frozen. `--single-tenant` drafting is refused on a multi-tenant database (CR-01). A drafted id that already exists counts as a duplicate (WR-08). Judge: `openai/gpt-5-mini` at temperature 0. The explicit family map refuses Claude, same-family, router and unknown ids (WR-12). Telemetry opt-outs, `DEEPEVAL_DISABLE_DOTENV=1` (WR-10), `CONFIDENT_API_KEY` refusal and the socket-spy test all hold. The verifier ran the fixture nightly traces through `run_judge` with stub judges: six metrics per language and category (it needs `--generator-model`, see Advisory 1) |

**Score:** 5/5 truths verified (0 present, behavior-unverified). SC1's image build and SC3's first CI run are confirmed only by the human items below.

Plan-level must-haves: `verify.artifacts` and `verify.key-links` pass for all 22 plans (exit 0 every time; all artifacts and key links verified). One plan truth was deliberately superseded: 01-22's "negative control that requires the degraded run to exit exactly 1" is now exit 10 (WR-02), and the workflow and checker were updated to match. The `verification: backstop` truth (01-21, atomic gen:schemas writes) keeps its passing evidence (the gen-zod self-test is now in CI).

### Advisory (New Scope, Unevidenced)

| # | Finding | Category | Why Advisory |
| --- | --- | --- | --- |
| 1 | `--generator stub` traces carry `stub/extractive-v1`, which the WR-12 family check refuses, so the default offline stub-to-judge path fails unless `--generator-model` is passed | other | Reproduced, but this is fail-closed behavior and no must-have depends on it: the nightly workflow uses `--generator live`, and the verified offline run with `--generator-model` passes |
| 2 | No non-root boot test of the image CMD (asked for by the previous gap) | other | No failing behavior. A static guard exists, and the verifier's caps-dropped run of the CMD passed |

### Required Artifacts (key ones)

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `rag-sidecar/src/rag_sidecar/{main,auth,settings}.py` | FastAPI probes + fail-closed auth | ✓ VERIFIED | tested; booted by test_boot and by the verifier's caps-dropped run |
| `rag-sidecar/Dockerfile` | buildable, runnable image | ✓ fixed (build is human) | venv uvicorn CMD, digest-pinned base, non-root user 10001 |
| `rag-sidecar/src/rag_sidecar/contracts/*` + `schemas/` + `src/lib/rag-eval/contracts.generated.ts` | single-source contracts, generated Zod | ✓ VERIFIED | regeneration identical after the contract changes in WR-03 and WR-05 |
| `src/app/api/internal/rag/run/route.ts`, `src/lib/rag-eval/*` | authenticated, scope-restricted eval endpoint + trace | ✓ VERIFIED | wired to real retrieval; conversation passed to answer generation (WR-04) |
| `eval/harness/*.mts` | in-process and HTTP harness | ✓ VERIFIED | 72 traces, golden file validated with Pydantic first (IN-01); HTTP transport refuses plain http off loopback and redirects (WR-07) |
| `eval/src/rag_eval/{metrics,report,runner,gate,baseline}.py` | deterministic scoring, gate, baseline | ✓ VERIFIED | exercised by test-rag, the degraded run and the re-record |
| `eval/src/rag_eval/judge/*`, `eval/src/rag_eval/draft/*` | judge tier, drafting tool | ✓ VERIFIED (offline) | stubs only; live is human |
| `eval/fixtures/{corpus,golden.jsonl,split-manifest.json}` | zh/en/it fixture corpus + golden | ✓ VERIFIED | 72 approved items, 24 per language; dev 56 (en 21, zh 19, it 16), test 16 |
| `eval/baselines/fixture-baseline.json`, `eval/config/noise.json` | baseline + noise band | ✓ VERIFIED | reproducible |
| `scripts/check-config.mjs`, `scripts/rag/env-manifest.json` | five-location drift check | ✓ VERIFIED (ratchet) | 5 managed (adds RAG_EVAL_ALLOWED_SCOPES), 60 legacy (44 with knownGaps) |
| `.github/workflows/pr-smoke.yml`, `nightly.yml` | PR smoke + nightly tiers | ✓ present, structurally checked | SHA-pinned actions match upstream tags; uv pinned to 0.11.32; never run on GitHub (human) |

### Key Link Verification

| From | To | Via | Status |
| --- | --- | --- | --- |
| `npm run test-rag` | eval route `POST` | in-process `NextRequest` with secret header | WIRED |
| eval route | `enhancedRetrieveChunks` -> PGlite `match_*` RPC | fake PostgREST + fake embeddings on 127.0.0.1 | WIRED |
| traces | `rag_eval.runner score` -> `rag_eval.gate` | spawned `uv run` | WIRED (degraded run's exit 10 reaches npm) |
| Pydantic models | Zod | `export_schemas` -> `gen-zod.mjs` -> CI `git diff --exit-code` | WIRED |
| pr-smoke jobs | vitest, tsx tests, check-config, typecheck:new, check-workflows, pytest, test-rag, negative control, docker | workflow steps | WIRED (structure only) |
| nightly | `run-nightly.mts --generator live` -> `rag_eval.judge.run` | workflow steps, key-presence skip | WIRED (structure only) |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
| --- | --- | --- | --- | --- |
| report.json/report.md | per-slice metrics (dev split gated, test split under `by_split`) | traces from the real retrieval code over the PGlite fixture DB | yes (deterministic fixture embedder) | ✓ FLOWING |
| gate.json | offenders / mismatches | report vs committed baseline | yes | ✓ FLOWING |
| judge report | six judge metrics | answered fixture traces + golden | stub judge only here | ✓ FLOWING (offline) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Smoke tier passes on today's code | `npm run test-rag` | exit 0, gate PASS | ✓ PASS |
| Degraded config fails the gate with the regression code | `npm run test-rag -- --max-results 1 --out eval/out/degraded` | exit 10, 6 offenders | ✓ PASS |
| Baseline is reproducible | `rag_eval.baseline record --runs 3 --out <scratch>` | identical | ✓ PASS |
| Schema parity | out-of-tree regeneration + diff | identical | ✓ PASS |
| Image CMD starts unprivileged with no writable HOME | caps-dropped venv uvicorn | probes and auth as specified | ✓ PASS |
| Nightly stub + stub judge on fixture traces | `run-nightly.mts --generator stub --generator-model anthropic/claude-sonnet-4.5` + `run_judge` | six metrics per language and category | ✓ PASS |
| Same, default stub generator id | `run-nightly.mts --generator stub` + `run_judge` | JudgeFamilyError | ⚠️ advisory |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes are declared or present. Step 7c: not applicable.

### Requirements Coverage

| Requirement | Description (short) | Status | Evidence |
| --- | --- | --- | --- |
| EVAL-01 | Sidecar: FastAPI, 3.12, pydantic>=2.14.4, probes, Dockerfile, constant-time fail-closed auth | ✓ SATISFIED (Docker build: human) | gap closed; CMD exercised unprivileged |
| EVAL-02 | Pydantic single source, generated Zod, CI fails on stale Zod | ✓ SATISFIED | parity job + tests; regeneration identical |
| EVAL-03 | Span-based gold evidence, language, category, review status, no chunk IDs | ✓ SATISFIED | `golden.py` contract + tests |
| EVAL-04 | Synthetic zh/en/it fixture corpus + golden set committed | ✓ SATISFIED | 72 items, PII/quote/coverage tests |
| EVAL-05 | Drafting tool (Claude + Ragas), private storage, frozen split, styles/personas, `ragas_generated` | ✓ SATISFIED offline / ? NEEDS HUMAN live | CR-01, WR-08 and WR-13 fixes tested; live drafting and review pending |
| EVAL-06 | Authenticated internal endpoint returning a trace | ✓ SATISFIED | route + auth tests incl. tenant-scope allow-list |
| EVAL-07 | Deterministic Recall@k, MRR by gold span, separate refusal rates | ✓ SATISFIED | `metrics.py`, report |
| EVAL-08 | Judge metrics via DeepEval + Ragas, pinned different-family judge, telemetry off, per language/category | ✓ SATISFIED offline / ? NEEDS HUMAN live | stub run on fixture traces |
| EVAL-09 | 3-run baseline, config hash per run, mean/spread; later phases compare by paired differences | ✓ SATISFIED (WARNING) | no paired-difference tool yet and no per-item rows in the baseline (Phase 2 SC5) |
| EVAL-10 | CI PR smoke + nightly tiers; PR fails beyond noise band | ✓ SATISFIED in code / ? NEEDS HUMAN | first GitHub run pending |
| EVAL-11 | `npm run test-rag` runs the smoke tier | ✓ SATISFIED | ran, exit 0 |
| EVAL-12 | Characterization tests lock four behaviors | ✓ SATISFIED | real chat route under mocks; all pass |
| EVAL-13 | Config manifest + check-config fails on any missing location | ✓ SATISFIED with deviation (WARNING) | knownGaps ratchet |

No orphaned requirements: EVAL-01..13 all map to Phase 1 and every plan's `requirements` field claims at least one of them.

### Prohibitions

| Prohibition | Tier | Enforcement | Disposition |
| --- | --- | --- | --- |
| Retrieval and generation code byte-identical to 325a2c9 (01-02, 01-04) | test | Partial: sentinel pins sha256 of the two replicated chat-route regions (IN-05). Directly observed: `git diff 325a2c9 HEAD` on the six paths is empty | ⚠️ flagged: unverified-prohibition, human review recommended (satisfied today) |
| No real-looking PII in fixtures (01-07, 01-08, 01-15) | test | `eval/tests/test_fixture_pii.py` | ✓ enforced |
| No telemetry or results upload from the judge (01-18) | test | telemetry/config tests, socket spy, `CONFIDENT_API_KEY` refusal, dotenv auto-load disabled | ✓ enforced |
| No customer-derived items committed (01-19) | test | writer tests: ignored, untracked, git-failure refusal | ✓ enforced |
| No reads outside the named workspace (01-19) | test | `test_draft_sources.py` scope tests, CR-01 multi-tenant refusal | ✓ enforced |
| Gate and CI never rewrite the baseline or noise band (01-20) | test | `test_gate_leaves_baseline_unchanged` | ✓ enforced |

### Decision Coverage

All trackable CONTEXT.md decisions are honored by shipped artifacts (25/25; `check.decision-coverage-verify`).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `eval/harness/run-eval.mts` / `eval/src/rag_eval/judge/config.py` | 28 / 92 | stub generator id has no family, judge refuses it | 📋 Advisory | default offline stub-to-judge path needs `--generator-model` |
| `rag-sidecar/tests/test_boot.py` | - | boots the venv python as root, not the image CMD as uid 10001 | ℹ️ Info | covered by the static CMD guard and the docker-build job |

No TBD/FIXME/XXX/TODO/HACK markers in the 58 non-planning files changed since the previous pass. The earlier Info items are resolved: the gen-zod self-test and check-workflows now run in the CI `ts` job.

### Warnings (not gaps, human decision requested)

1. **EVAL-13 / SC4 ratchet.** 44 of 60 legacy variables are still allowed to be missing from one or more locations through `knownGaps`, per plan decision 01-11. `.env.local` is checked only when present, so CI never checks it. If you accept this, add an override:
   ```yaml
   overrides:
     - must_have: "check-config fails when any of the five config locations is missing an entry"
       reason: "Legacy drift for 44 pre-existing variables is frozen as a knownGaps ratchet (list can only shrink); all Phase 1 and later variables are managed with no gaps"
       accepted_by: "{name}"
       accepted_at: "{ISO timestamp}"
   ```
2. **Gate scope.** The gate covers the overall and language slices of the dev split only. Category slices are report-only (D-20), and the 16 test-split items never gate (WR-03, by design). The ROADMAP milestone rule names category slices too.
3. **Negative-control margin.** The degraded run fails by small, deterministic margins: overall recall@5 is 0.5532 against a threshold of 0.5545, about one dev item. It reproduces exactly because the fixture is deterministic. But fixture retrieval returns at most about 4 candidates (Recall@5 equals Recall@10), so the fixture gate is coarse. The real-KB baseline (human item) is the one that informs targets.
4. **Paired differences (EVAL-09).** There is still no paired-difference statistic, and the baseline holds no per-item rows. That tooling falls to Phase 2 SC5.
5. **Skipped review findings.** IN-04 (image-document chunks count in recall and judge contexts) and IN-06 (test-rag repurposed; AGENTS.md/CLAUDE.md still describe the old script) are open by decision. IN-09 was kept on its own condition. WR-03, WR-05, WR-12 and WR-13 are marked "requires human verification" in 01-REVIEW.md and fall under the live human items.
6. **Draft model id.** `eval/config/draft.json` pins `claude_model: "claude-sonnet-5-5"`, which can't be checked offline.

### Human Verification Required

The frontmatter `human_verification` lists 6 items: Docker build and run, the first real pr-smoke and nightly GitHub run, a hand-check of the live judge, real-KB golden drafting with a full user review, the live three-run baseline with improvement targets, and acceptance of the retrieval-code-frozen prohibition, which is enforced only in part.

### Gaps Summary

No blocking gaps remain. The previous gap is closed in code. The sidecar CMD now runs the venv's uvicorn directly, with no uv at runtime. Run without capabilities and with an unwritable HOME, the same command answered /health, /ready and /v1/info exactly as the success criterion requires. Only the real `docker build` is still unconfirmed, because there is no Docker daemon here.

The review fixes did not break the phase goal. The gate now scores only approved dev-split items (56 of 72). The re-recorded fixture baseline reproduces exactly, today's code passes, and the degraded config is rejected with the new regression exit code 10, which the CI negative control asserts. Schema parity, config drift, the characterization tests and every test suite pass. The status is human_needed, not passed, for two reasons. First, Docker, GitHub Actions, live keys and the real knowledge base can't be exercised here. Second, one test-tier prohibition has only partial enforcement and stays flagged for human review.

---

_Verified: 2026-11-23T12:13:06Z_
_Verifier: Claude (gsd-verifier)_
