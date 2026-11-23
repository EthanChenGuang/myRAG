---
phase: 01-evaluation-harness-baseline
reviewed: 2026-11-23T11:26:40Z
depth: deep
diff_base: 36c1942
files_reviewed: 126
files_reviewed_list:
  - .github/workflows/nightly.yml
  - .github/workflows/pr-smoke.yml
  - .gitignore
  - eval/.gitignore
  - eval/config/draft.json
  - eval/config/judge.json
  - eval/config/noise.json
  - eval/config/rag-eval-env.json
  - eval/harness/corpus.mts
  - eval/harness/eval-env.mts
  - eval/harness/fake-edge.mts
  - eval/harness/fixture-embedder.mts
  - eval/harness/pglite-supabase.mts
  - eval/harness/run-eval.mts
  - eval/harness/run-nightly.mts
  - eval/harness/run-smoke.mts
  - eval/pyproject.toml
  - eval/src/rag_eval/__init__.py
  - eval/src/rag_eval/baseline.py
  - eval/src/rag_eval/corpus.py
  - eval/src/rag_eval/draft/__init__.py
  - eval/src/rag_eval/draft/__main__.py
  - eval/src/rag_eval/draft/claude_drafter.py
  - eval/src/rag_eval/draft/cli.py
  - eval/src/rag_eval/draft/config.py
  - eval/src/rag_eval/draft/ragas_drafter.py
  - eval/src/rag_eval/draft/sources.py
  - eval/src/rag_eval/draft/verify.py
  - eval/src/rag_eval/draft/writer.py
  - eval/src/rag_eval/gate.py
  - eval/src/rag_eval/golden_io.py
  - eval/src/rag_eval/judge/__init__.py
  - eval/src/rag_eval/judge/config.py
  - eval/src/rag_eval/judge/deepeval_judge.py
  - eval/src/rag_eval/judge/ragas_judge.py
  - eval/src/rag_eval/judge/run.py
  - eval/src/rag_eval/judge/telemetry.py
  - eval/src/rag_eval/matching.py
  - eval/src/rag_eval/metrics.py
  - eval/src/rag_eval/paths.py
  - eval/src/rag_eval/report.py
  - eval/src/rag_eval/runner.py
  - eval/src/rag_eval/split.py
  - eval/src/rag_eval/traces.py
  - eval/tests/judge_stubs.py
  - eval/tests/test_baseline.py
  - eval/tests/test_corpus.py
  - eval/tests/test_draft_cli.py
  - eval/tests/test_draft_sources.py
  - eval/tests/test_draft_writer.py
  - eval/tests/test_fixture_coverage.py
  - eval/tests/test_fixture_pii.py
  - eval/tests/test_fixture_quotes.py
  - eval/tests/test_gate.py
  - eval/tests/test_golden_io.py
  - eval/tests/test_judge_config.py
  - eval/tests/test_judge_offline.py
  - eval/tests/test_matching.py
  - eval/tests/test_metrics.py
  - eval/tests/test_report_runner.py
  - eval/tests/test_split.py
  - package.json
  - prompts/004-gsd-phase-rag-hardening.md
  - rag-sidecar/.dockerignore
  - rag-sidecar/.gitignore
  - rag-sidecar/Dockerfile
  - rag-sidecar/pyproject.toml
  - rag-sidecar/src/rag_sidecar/__init__.py
  - rag-sidecar/src/rag_sidecar/auth.py
  - rag-sidecar/src/rag_sidecar/contracts/__init__.py
  - rag-sidecar/src/rag_sidecar/contracts/baseline.py
  - rag-sidecar/src/rag_sidecar/contracts/eval_run.py
  - rag-sidecar/src/rag_sidecar/contracts/golden.py
  - rag-sidecar/src/rag_sidecar/contracts/judge.py
  - rag-sidecar/src/rag_sidecar/contracts/report.py
  - rag-sidecar/src/rag_sidecar/contracts/samples.py
  - rag-sidecar/src/rag_sidecar/contracts/sidecar.py
  - rag-sidecar/src/rag_sidecar/contracts/validate.py
  - rag-sidecar/src/rag_sidecar/export_schemas.py
  - rag-sidecar/src/rag_sidecar/main.py
  - rag-sidecar/src/rag_sidecar/settings.py
  - rag-sidecar/tests/test_auth.py
  - rag-sidecar/tests/test_boot.py
  - rag-sidecar/tests/test_contract_export.py
  - rag-sidecar/tests/test_contract_models.py
  - rag-sidecar/tests/test_golden_contract.py
  - rag-sidecar/tests/test_health.py
  - rag-sidecar/tests/test_image_boundary.py
  - scripts/check-config.mjs
  - scripts/check-config.test.mjs
  - scripts/ci/check-workflows.py
  - scripts/config-server.js
  - scripts/config-ui/index.html
  - scripts/gen-zod.mjs
  - scripts/init-env.js
  - scripts/rag/env-manifest.json
  - scripts/tests/gen-zod.node-test.mjs
  - scripts/typecheck-new.mjs
  - scripts/typecheck-new.test.mjs
  - src/app/api/internal/rag/run/route.ts
  - src/lib/env.ts
  - src/lib/rag-eval/answer.ts
  - src/lib/rag-eval/auth.ts
  - src/lib/rag-eval/contracts.generated.ts
  - src/lib/rag-eval/legacy-post-filter.ts
  - src/lib/rag-eval/trace.ts
  - tests/chat-messages-roundtrip.test.ts
  - tests/chat-source-images.test.ts
  - tests/chat-strict.test.ts
  - tests/chat-websearch.test.ts
  - tests/contracts.test.ts
  - tests/eval-answer-sentinel.test.ts
  - tests/eval-answer.test.mts
  - tests/eval-corpus.test.ts
  - tests/eval-env-pin.test.ts
  - tests/eval-harness.test.ts
  - tests/eval-route-auth.test.ts
  - tests/fixture-edge.test.mts
  - tests/helpers/chat-route-fakes.ts
  - tests/legacy-post-filter-sentinel.test.ts
  - tests/legacy-post-filter.test.ts
  - tests/prompt-context.test.mts
  - tests/schema-parity.test.ts
  - tests/setup-env.ts
  - tsconfig.typecheck-new.json
  - vitest.config.ts
findings:
  critical: 1
  warning: 13
  info: 11
  total: 25
  necessity: 1
  by_requested_severity:
    critical: 1
    high: 3
    medium: 10
    low: 11
status: issues_found
fix_status: partial
fixed_at: 2026-11-23T12:10:00Z
fix_summary:
  in_scope: 25
  fixed: 22
  skipped: 3
  requires_human_verification: [WR-03, WR-05, WR-12, WR-13]
---

# Phase 01: Code Review Report

**Reviewed:** 2026-11-23T11:26:40Z
**Depth:** deep (cross-file: route -> retrieval -> SQL RPC; harness -> runner -> gate; drafter -> Supabase REST)
**Files Reviewed:** 126 (scope: `git diff --name-only 36c1942 HEAD`, excluding `.planning`, lockfiles, fixtures, generated schemas, baselines)
**Status:** issues_found

Severity mapping. The caller asked for critical / high / medium / low. Downstream GSD tooling reads `critical / warning / info`, so the mapping is: **Critical = CR- (BLOCKER)**, **High and Medium = WR- (WARNING; the title says which)**, **Low = IN-**.

## Summary

**What holds up:**
- `checkEvalAccess` (`src/lib/rag-eval/auth.ts`) returns 404 in production unless `RAG_EVAL_ENDPOINT_ENABLED=true`. It returns 503 when the secret is shorter than 32 characters, and compares SHA-256 digests with `timingSafeEqual`, so neither timing nor length leaks.
- The sidecar `SharedSecretMiddleware` fails closed: `/health` is open, `/ready` returns 503 without a secret, every other path returns 401 or 503, and websockets are closed.
- Nothing logs a secret.
- CI has no `pull_request_target`. PR jobs never use `secrets.`, and `permissions: contents: read` is set in both workflows. Nightly secrets reach only step env.
- The private-path writer checks the resolved path, runs `git check-ignore`, and refuses to write if anything under `eval/golden/private/` is tracked.
- Production chat behaviour is untouched: `src/app/api/chat/route.ts` has no diff. The only `src/` changes are four `env.ts` keys, the new eval route and `src/lib/rag-eval/*`. Config mirroring in init-env, config-server and config-ui is consistent.

**What is wrong:**
- **Tenant isolation (critical).** The golden drafting tool's `--single-tenant` scope, pointed at a multi-tenant database, reads every user's personal documents with the service-role key and sends them to Anthropic and OpenRouter.
- **Eval endpoint scope (high).** The endpoint lets anyone holding the one shared secret pick any `organization_id` or `user_id`.
- **Measurement validity (high).** The negative-control CI job passes when the gate crashes. The harness scores draft and rejected items and mixes the held-out test split into the gated baseline.
- **Gate identity (medium).** The gate does not check that the report and baseline come from the same deployment mode, tenant scope or embedder source.
- **Medium robustness and security issues.** The eval secret is forwarded on redirects. A reviewer's question edit makes the next drafting run abort. DeepEval auto-loads `.env.local`.

## Fix Status

Fixes were applied on branch `claude/ecstatic-hamilton-86gtwv`, one commit per finding, all in the main checkout (no worktree). 22 of 25 findings were fixed and 3 skipped (IN-04, IN-06, IN-09). WR-03, WR-05, WR-12 and WR-13 change measurement or gating logic and need a human check.

| Finding | Status | Commit |
| --- | --- | --- |
| CR-01 | fixed | da7cbcb |
| WR-01 | fixed | f27eeda |
| WR-02 | fixed | 6405d31 |
| WR-03 | fixed, needs human check | a9f11ab |
| WR-04 | fixed | c5c49b0 |
| WR-05 | fixed, needs human check | 1a52f6a |
| WR-06 | fixed | d263c9e |
| WR-07 | fixed | e7fb836 |
| WR-08 | fixed | fa7cac6 |
| WR-09 | fixed | 1019da5 |
| WR-10 | fixed | cfd0cce |
| WR-11 | fixed | 6ef7e7f, 1f51201 |
| WR-12 | fixed, needs human check | 270afde |
| WR-13 | fixed, needs human check | fbf2bfb |
| IN-01 | fixed, partly | 0ad5171 |
| IN-02 | fixed | acad605 |
| IN-03 | fixed | d5119cd |
| IN-04 | skipped | - |
| IN-05 | fixed | 850ca82 |
| IN-06 | skipped | - |
| IN-07 | fixed | ef5c1d1 |
| IN-08 | fixed | eaeaf2b |
| IN-09 | skipped | - |
| IN-10 | fixed | d27e8ec |
| IN-11 | fixed | 9dc8685 |

New fixture baseline (`eval/baselines/fixture-baseline.json`, approved items, dev split: 56 of 72 items, 47 answerable and 9 no_answer; zero spread over 3 runs):

| Slice | Recall@5 | Recall@10 | MRR | Correct refusal | False refusal |
| --- | --- | --- | --- | --- | --- |
| overall | 0.574 | 0.574 | 0.596 | 0.333 | 0.319 |
| language:en | 0.472 | 0.472 | 0.500 | 0.333 | 0.389 |
| language:it | 0.615 | 0.615 | 0.615 | 0.333 | 0.231 |
| language:zh | 0.656 | 0.656 | 0.688 | 0.333 | 0.312 |

The previous baseline gated all 72 items (overall Recall@5 0.608, MRR 0.633, correct refusal 0.500, false refusal 0.300). The `--max-results 1` negative control still fails with exit 10 and 6 offenders, but the overall Recall@5 margin is thin: 0.5532 observed against a 0.5545 threshold.

## Critical Issues

### CR-01: `--single-tenant` drafting scope reads every tenant's personal documents (cross-tenant exfiltration to third-party LLMs)

**Fix status:** fixed (`da7cbcb`)

**Severity:** Critical (BLOCKER)
**File:** `eval/src/rag_eval/draft/sources.py:79-91` (with `eval/src/rag_eval/draft/cli.py:226-238`)
**Issue:** The `--single-tenant` scope maps to one PostgREST filter, `organization_id=is.null`, sent with the **service-role key**, which bypasses RLS.
- In the multi-tenant schema (`supabase/multi-tenant-setup.sql:151-154`), `organization_id IS NULL` marks a *personal workspace*, and every user has one.
- Nothing checks that the target database really is single-tenant: no deployment-mode check and no probe for distinct `user_id`s.

**Failure scenario:**
1. An operator runs `python -m rag_eval.draft --source supabase --single-tenant ...` with the production multi-tenant Supabase URL and service key. They might do this by mistake, or because they read "single-tenant" as "one knowledge base".
2. `documents()` returns every user's personal documents.
3. Those chunks are batched to Anthropic (`claude_drafter.py:123`) and to OpenRouter/OpenAI through Ragas (`ragas_drafter.py:154-165`).
4. Quotes from other tenants are written into one golden file.

Cross-tenant leakage is the project's stated most-severe failure. The `--user` path is correct because it adds `user_id=eq.<uuid>`.

**Fix:** Make `--single-tenant` prove the database is single-tenant before reading anything. Also accept `--single-tenant` only when `NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE == "single-tenant"`.
```python
# sources.py, in SupabaseWorkspaceSource.documents(), before the documents query
if self._single_tenant:
    owners = self._get("documents", {"select": "user_id", "user_id": "not.is.null", "limit": "2"})
    orgs = self._get("documents", {"select": "id", "organization_id": "not.is.null", "limit": "1"})
    if orgs or len({r.get("user_id") for r in owners}) > 1:
        raise RuntimeError("--single-tenant refused: this database holds several workspaces; use --org or --user")
```
`_get` paginates, so give the probe its own non-paginating request. Add a test that runs `--single-tenant` against a fake multi-user database and expects a refusal.

## Warnings

### WR-01 (High): Eval endpoint trusts caller-chosen `organization_id` / `user_id`, so one global secret reads every tenant

**Fix status:** fixed (`f27eeda`)

**File:** `src/app/api/internal/rag/run/route.ts:33-47`
**Issue:**
- `organizationId` and `userId` come straight from the request body (`options.organization_id`, `options.user_id`).
- They feed `match_documents_by_workspace`, which is `SECURITY DEFINER` and granted to `anon` (`supabase/multi-tenant-setup.sql:692-736`), and which trusts `p_org_id` / `p_user_id` as given.
- The response carries full chunk `content`, the assembled `context` and the `answer`.

**Failure scenario:** `RAG_EVAL_ENDPOINT_ENABLED=true` is set in a multi-tenant production deployment for one eval run. Anyone holding the single shared `RAG_EVAL_SECRET` can now read any organization's or user's knowledge base by trying UUIDs. The secret may sit in a CI variable, a developer's `.env.local` or harness logs of the command line. Nothing restricts which tenants are reachable.

**Fix:** Bind the endpoint to an allow-list, and mirror the new variable in all five config locations.
```ts
const allowed = (process.env.RAG_EVAL_ALLOWED_SCOPES ?? '').split(',').map(s => s.trim()).filter(Boolean);
const scope = organizationId ? `org:${organizationId}` : userId ? `user:${userId}` : null;
if (deploymentMode === 'multi-tenant' && (!scope || !allowed.includes(scope))) {
  return NextResponse.json({ error: 'scope not allowed' }, { status: 403 });
}
```

### WR-02 (High): The gate's "regression" exit code 1 is also Python's crash exit code, so the negative-control job passes on any crash

**Fix status:** fixed (`6405d31`)

**File:** `.github/workflows/pr-smoke.yml:133-139`, `eval/harness/run-smoke.mts:71-98`, `eval/src/rag_eval/gate.py:11-13,180-188`
**Issue:**
- `EXIT_REGRESSION = 1`, and the CI negative control asserts `test "$code" -eq 1`.
- An uncaught Python exception in `rag_eval.runner` or `rag_eval.gate` also exits 1. One example: `getattr(observed_metrics, metric)` at `gate.py:65` raises `AttributeError` when `noise.json` names a metric that does not exist.
- `run-smoke.mts` propagates whatever code the subprocess returns.

**Failure scenario:** A refactor breaks the gate so that it always throws. `eval-smoke` fails, but `gate-negative-control` goes green and reports that the gate rejects degraded runs, which is exactly the D-12 assurance it exists to give.

**Fix:**
- Make the negative control assert on the artifact as well as the exit code: `jq -e '.offenders | length > 0' eval/out/negative/gate.json`.
- Give regressions a dedicated non-1 code, for example 10, and wrap `main()` so unexpected exceptions return a distinct code such as 70.

### WR-03 (High): Golden lifecycle fields are ignored, so draft and rejected items are scored and the held-out test split is gated

**Fix status:** fixed: requires human verification (`a9f11ab`; gate population is now the approved dev split, fixture baseline re-recorded)

**File:** `eval/harness/run-eval.mts:151-169,270-295`, `eval/src/rag_eval/runner.py:172-190`, `eval/src/rag_eval/judge/run.py:218-229`
**Issue:**
- Neither the TS harness, the Python runner nor the judge reads `review_status` or `split`. Every line of the golden file is scored, including `review_status: "rejected"` and unreviewed `"draft"` items.
- `dev` and `test` items are combined into one `overall` and per-language slice, and the gate runs on that union.

**Failure scenario:**
- A private golden file from the drafter contains only `review_status: "draft"` items. Live baselines are recorded on LLM-written questions nobody has reviewed, and items a reviewer marked `rejected` still count.
- Phase 2 tunes retrieval against the gate. Because the gate includes the 30% `test` split, the held-out set D-14 exists to protect is tuned on directly. The fixture has 16 test items out of 72.

**Fix:**
- Filter to `review_status == "approved"` by default, behind a `--include-drafts` flag, in `readGolden` and in `load_golden` callers.
- Add `--split dev|test|all`, defaulting to `dev` for the gate.
- Record the applied filter in `RunManifest` and `EvalReport`, and check it in `gate._mismatches`.

### WR-04 (Medium): `conversation` is accepted but silently dropped, so multi_turn answers and judge scores do not reflect production

**Fix status:** fixed (`c5c49b0`)

**File:** `src/app/api/internal/rag/run/route.ts:30`, `src/lib/rag-eval/answer.ts:118-122`, `eval/harness/run-eval.mts:278`
**Issue:**
- The harness sends `item.conversation`, and `RagRunRequestSchema` accepts it.
- The route never destructures it, and `generateEvalAnswer` sends only `[{ role: 'user', content: query }]`.
- The chat route streams the full message history to the model.

**Failure scenario:** For the 9 `multi_turn` fixture items, and every drafted multi-turn item, the nightly answer is generated without the earlier turns. DeepEval and Ragas faithfulness and answer-relevance then score a different system from the one users run. Retrieval is unaffected, because the chat route also retrieves on the last user text.

**Fix:** Pass `conversation` through to `generateEvalAnswer` as prior `messages`, in the same order the chat route uses. Alternatively, reject non-empty `conversation` with a 400 until it is supported, so the gap is not silent.

### WR-05 (Medium): The gate does not compare deployment mode, tenant scope, tier or embedder source, so it compares unlike runs

**Fix status:** fixed: requires human verification (`1a52f6a`; new gate mismatch rules)

**File:** `eval/src/rag_eval/gate.py:25-38`, `eval/src/rag_eval/report.py:47-55`, `eval/harness/run-eval.mts:320-322`
**Issue:** `_mismatches` checks only `golden_sha256`, `corpus_sha256`, `embedder_id` and `embedder_version`. These never trigger a mismatch:
- `deployment_mode`
- `request_options.organization_id` / `user_id`
- `tier`
- `RunEmbedder.source_sha256`. It reaches `run_config_hash` but is dropped from `EvalReport`.

Live runs record `corpus_sha256 = None` and `embedder = None`, so for live gating only the golden hash is compared.

**Failure scenarios:**
1. `npm run test-rag -- --deployment-mode multi-tenant` is silently gated against the single-tenant fixture baseline.
2. A live baseline recorded for org A gates a run against org B or another deployment with no mismatch.
3. Someone edits `eval/harness/fixture-embedder.mts` without bumping `EMBEDDER_VERSION`. Every metric shifts and the change is reported as a RAG regression or improvement instead of "re-record the baseline".

**Fix:** Carry `deployment_mode`, `request_options` minus `max_results`, and `embedder_source_sha256` into `Baseline` and `EvalReport`, and add them to `_mismatches`. Then `--max-results 1` remains a legitimate degraded config rather than a mismatch. For live runs, also compare the server's `effective_config.deployment_mode`.

### WR-06 (Medium): The live tier cannot be scoped to a tenant, so multi-tenant live runs retrieve nothing

**Fix status:** fixed (`d263c9e`)

**File:** `eval/harness/run-smoke.mts:22-34,59-67`, `eval/src/rag_eval/baseline.py:346-349`
**Issue:**
- `run-smoke.mts` has no `--org` / `--user` options and forwards only `max_results`.
- In-process runs fill in the fixture user, but `--base-url` runs send `organization_id: null, user_id: null`.
- Against a multi-tenant server, the RPC predicate `d.user_id = p_user_id` with NULL is never true (`multi-tenant-setup.sql:724`).
- The manifest's `deployment_mode` comes from the local CLI flag, which defaults to `single-tenant`, not from the server.

**Failure scenario:**
1. `npm run eval:baseline -- --base-url https://prod...` against a multi-tenant deployment returns zero candidates for every item.
2. Every item is refused: false-refusal 1.0, correct-refusal 1.0.
3. The meaningless result is recorded as a deterministic baseline, labelled `single-tenant`.

**Fix:**
- Add `--org` / `--user` to `run-smoke.mts` and `baseline record`, forwarded into `requestOptions`.
- Refuse a `--base-url` run when the first trace's `effective_config.deployment_mode` is `multi-tenant` and neither flag is given.
- Take `deployment_mode` from the trace.

### WR-07 (Medium): The eval secret is forwarded on redirects and can be sent over plain HTTP

**Fix status:** fixed (`e7fb836`)

**File:** `eval/harness/run-eval.mts:238-246`
**Issue:**
- `fetch(url, { headers: { 'x-rag-eval-secret': ... } })` uses the default `redirect: 'follow'`.
- On a cross-origin redirect, undici strips only `authorization`, `cookie` and `proxy-authorization`. Custom headers such as `x-rag-eval-secret` are re-sent to the redirect target.
- `--base-url` is not checked for `https:`.

**Failure scenario:** The base URL points at a domain that 301/308-redirects elsewhere, such as an apex-to-www redirect, a Vercel alias or a hijacked old domain. Or it is mistyped as `http://`. The shared secret is then sent to the redirect host or in cleartext.

**Fix:**
```ts
const parsed = new URL(baseUrl);
if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
  throw new Error('[Eval Harness] --base-url must use https');
}
const res = await fetch(url, { method: 'POST', redirect: 'error', headers: {...}, body });
```

### WR-08 (Medium): After a reviewer edits a question, the next drafting run aborts on a duplicate id and discards the paid LLM output

**Fix status:** fixed (`fa7cac6`)

**File:** `eval/src/rag_eval/draft/writer.py:84-86,108-109,123-126,154`, `eval/src/rag_eval/split.py:308-309`
**Issue:**
- Item ids are `draft-<lang>-sha256(normalized question)[:10]`, computed once.
- Deduplication compares against the *current* text of existing items (`seen_questions`), not their ids.

**Failure scenario:**
1. A reviewer fixes a typo in an existing item's `question`. Its id still encodes the original wording.
2. On the next run, Claude or Ragas proposes the original wording again.
3. The proposal is not in `seen_questions`, so it gets the same id as the edited item.
4. `freeze_splits` raises `duplicate golden item id`, `cli.py:326-328` returns `EXIT_INPUT`, and every newly drafted item is lost after the Anthropic and OpenRouter calls have been paid for.

**Fix:** Seed `seen_ids = {item.id for item in existing}`. When a proposal's id is already taken, skip it and count it as a duplicate, or derive the id with a collision suffix.

### WR-09 (Medium): The raw exception message is returned to the caller

**Fix status:** fixed (`1019da5`)

**File:** `src/app/api/internal/rag/run/route.ts:151-155`
**Issue:** The catch-all returns `{ error: error.message }`. Messages from Supabase, PostgREST, OpenAI and pgvector can include SQL fragments, internal hostnames, or masked key fragments; OpenAI's "Incorrect API key provided: sk-...abcd" is one example. The generation branch at lines 95-100 already sanitizes to the error's `name` and HTTP status. The retrieval branch does not.

**Fix:** Mirror the generation branch: log `message` server-side and return `{ error: 'retrieval failed' }` plus the error's `name`.

### WR-10 (Medium): DeepEval auto-loads `.env` / `.env.local` from the current directory, which undercuts the `CONFIDENT_API_KEY` guard

**Fix status:** fixed (`cfd0cce`)

**File:** `eval/src/rag_eval/judge/telemetry.py:25-39`
**Issue:**
- `import deepeval` calls `autoload_dotenv()` (`deepeval/__init__.py:12`), which merges `.env`, `.env.{APP_ENV}` and `.env.local` from the current directory into `os.environ`.
- `check_no_results_upload()` runs *before* DeepEval is imported, so a `CONFIDENT_API_KEY` in a dotenv file is loaded only after the check has passed.
- The repo root `.env.local` holds every app secret, including the Supabase service role and Stripe keys.
- CI is safe, because `uv run --directory eval` makes `eval/` the current directory. A developer running `uv run --project eval python -m rag_eval.judge.run` from the repo root is not.
- Separately, `eval/.deepeval/` already exists on disk and is not gitignored.

**Fix:**
- Add `os.environ["DEEPEVAL_DISABLE_DOTENV"] = "1"` to `disable_telemetry()`, and run `check_no_results_upload()` again after the judge libraries are imported.
- Add `.deepeval/` to `.gitignore`.

### WR-11 (Medium): Actions are pinned to mutable tags, the uv version is unpinned, and the workflow checker is never run

**Fix status:** fixed (`6ef7e7f`; gen-zod self-test added to CI in `1f51201`)

**File:** `.github/workflows/pr-smoke.yml:25-30,108`, `.github/workflows/nightly.yml:213-225,253`, `scripts/ci/check-workflows.py:83`
**Issue:**
- `actions/checkout@v4`, `actions/setup-node@v4`, `astral-sh/setup-uv@v5` and `actions/upload-artifact@v4` are major-version tags that can be re-pointed.
- The nightly job runs these third-party actions in the same job that later receives `OPENROUTER_API_KEY` and `OPENAI_API_KEY`.
- `setup-uv` has no `version:`, so CI uses whatever uv is newest. The Dockerfile pins `uv:0.11.32`, and `pyproject` requires `uv_build<0.12`.
- `check-workflows.py` explicitly accepts tags and is not invoked by any workflow, so its assertions do not protect anything.

**Fix:** Pin each action to a 40-hex commit SHA with a version comment, set `version: "0.11.32"` on `setup-uv`, tighten `check-workflows.py` to require SHAs, and run it as a step in the `ts` job.

### WR-12 (Medium): The judge-family check relies on the model-id prefix, so routers and unprefixed ids bypass it

**Fix status:** fixed: requires human verification (`270afde`; explicit family map, unknown families refused)

**File:** `eval/src/rag_eval/judge/config.py:93-114`
**Issue:** `generator_family()` returns the text before `/`, or `anthropic` when the id contains "claude". Some generator ids name no provider family, or the wrong one:
- `openrouter/auto` (OpenRouter's router), which can serve an OpenAI model.
- `gpt-4o`, which has no prefix.
- Vendor or alias prefixes.

These yield families such as "openrouter" or "gpt-4o" that never equal `judge_family="openai"`. The generator model is caller-supplied (`--generator-model`, `options.generator_model`).

**Failure scenario:** `run-nightly.mts --generator-model openrouter/auto` is judged by `openai/gpt-5-mini`. When the router picks an OpenAI model, the judge grades its own family, which violates D-15, and the check passes.

**Fix:** Keep an explicit family map: `gpt-`/`o1`/`o3`/`o4`/`chatgpt` → openai, `gemini` → google, and so on. Refuse generators whose family cannot be determined, including `openrouter/auto` and `~`-aliases, rather than treating an unknown family as different.

### WR-13 (Medium): Ragas evidence lookup matches a short chunk inside a longer context and attributes the quote to the wrong document

**Fix status:** fixed: requires human verification (`fbf2bfb`; evidence matching rule changed)

**File:** `eval/src/rag_eval/draft/ragas_drafter.py:73-84`
**Issue:** The fallback in `_locate` accepts `norm in wanted`, meaning the workspace chunk is a substring of the Ragas context, and it scans documents in filename order. A short chunk in document A, such as a heading-only chunk, a price line or a table caption, is often a substring of a context taken from document B. The quote is then taken from A's chunk. `verify_proposal` passes, because the quote really is in A, so the item ships with gold evidence from the wrong document. That makes the recall metrics wrong for the item.

**Fix:** Prefer exact equality, then `wanted in norm`, meaning the context is contained in the chunk. Allow `norm in wanted` only when `len(norm) >= 0.8 * len(wanted)`, and pick the best-overlap candidate rather than the first.

## Info

### IN-01 (Low): Pydantic and Zod disagree beyond what the parity test catches

**Fix status:** fixed, partly (`0ad5171`; golden files are validated with Pydantic before the TS run; the `default_factory`/`.optional()` and code-point vs UTF-16 length differences are unchanged)

**File:** `src/lib/rag-eval/contracts.generated.ts:19,31,34`, `rag-sidecar/src/rag_sidecar/contracts/golden.py:37-52`, `baseline.py:122-123`
**Issue:**
- The `GoldenItem` cross-field rules (answerable ⇔ evidence and expected_answer, no_answer ⇔ !answerable, multi_turn ⇔ conversation, unique spans) do not exist in Zod. The TS harness accepts golden files that Python rejects, and fails only after a full retrieval pass.
- `default_factory` fields become `.optional()`, not `.default(...)`. In TS, `NoiseConfig.gated_slice_prefixes` and `metrics` are `undefined`, not the Python defaults.
- `min_length` / `max_length` count code points in Pydantic but UTF-16 units in Zod: `quote` min 2, `query` max 4000.

**Fix:** Validate golden files with Python before the TS run, as run-nightly does for traces. Emit `default` for `default_factory` fields in the JSON Schema with `json_schema_extra`, or document that TS consumers must not rely on them.

### IN-02 (Low): The `effective_config.rag_env` denylist is narrow

**Fix status:** fixed (`acad605`; `PASS` alone is not matched, to keep `RAG_MULTI_PASS` and `RAG_MAX_RETRIEVAL_PASSES` in the config identity)

**File:** `src/lib/rag-eval/trace.ts:6,21-29`
**Issue:** Every `RAG_*` value is echoed back unless the name matches `SECRET|KEY|TOKEN|PASSWORD`. A future `RAG_DB_PASS`, `RAG_*_CREDENTIALS`, `RAG_*_DSN` or a URL with embedded credentials would be returned to the caller and hashed into artifacts.
**Fix:** Switch to an allow-list taken from `scripts/rag/env-manifest.json` `managed` entries, or extend the pattern to `PASS|CRED|AUTH|DSN|PRIVATE`.

### IN-03 (Low): The `live` tier is never emitted

**Fix status:** fixed (`d5119cd`)

**File:** `eval/harness/run-smoke.mts:65`
**Issue:** `tier: 'smoke'` is hard-coded even for `--base-url` runs, so the contract's `live` value is unused and live reports are labelled as smoke.
**Fix:** `tier: baseUrl ? 'live' : 'smoke'`.

### IN-04 (Low): Recall and judge contexts include image-document chunks the generator never sees

**Fix status:** skipped: needs a trace-contract field (`in_context`), a change to the recall and judge-context definitions and another baseline re-record; a metric-definition decision, not a small fix

**File:** `eval/src/rag_eval/metrics.py:16`, `src/lib/rag-eval/legacy-post-filter.ts:151-152,206-219`, `eval/src/rag_eval/judge/run.py:173`
**Issue:** `kept` lists every chunk of a used document, but context assembly skips image documents. Recall@k and the judge's `contexts` can count evidence that was not in the prompt.
**Fix:** Mark kept chunks with `in_context` and score recall and faithfulness on those.

### IN-05 (Low): The post-filter sentinel only checks that literals are present

**Fix status:** fixed (`850ca82`)

**File:** `tests/legacy-post-filter-sentinel.test.ts:9-36`
**Issue:** The test does not notice if the chat route reorders the filters, adds a branch (for example, an explicit-reference keep path that changes `usedDocuments`), or changes `normalize()`, provided the literals survive somewhere in the 4500-line file.
**Fix:** Also pin the sha256 of the relevant line range, or extract the filter from `route.ts` into a shared module in a later phase.

### IN-06 (Low): `npm run test-rag` was repurposed

**Fix status:** skipped: the old target `scripts/test-rag-system.js` never existed and the project required "fix or remove `npm run test-rag`", so repurposing it was intended; the remaining fix is a CLAUDE.md/AGENTS.md doc edit, which needs the user's go-ahead

**File:** `package.json:16`
**Issue:** The script used to run `node scripts/test-rag-system.js`, the RAG health check documented in AGENTS.md and CLAUDE.md. It now runs the smoke harness, so the documented diagnostic silently changes meaning.
**Fix:** Keep `test-rag` and add `eval:smoke`, or update the docs.

### IN-07 (Low): Claude drafter robustness gaps

**Fix status:** fixed (`ef5c1d1`)

**File:** `eval/src/rag_eval/draft/claude_drafter.py:55,114,121-130`
**Issue:**
- `tool_choice: auto` lets the model skip the tool.
- A batch can be asked for up to 50 items under `max_tokens: 8000`, so output may be truncated mid-tool-call.
- `batches[:n]` silently drops workspace content beyond `n` batches.
- Filenames go unescaped into `<document name="...">`.

**Fix:** Use `tool_choice={"type": "tool", "name": TOOL_NAME}`, cap items per call (for example 15), handle `stop_reason == "max_tokens"`, and escape the attribute.

### IN-08 (Low): Sidecar base image is not pinned by digest

**Fix status:** fixed (`eaeaf2b`; digest resolved from Docker Hub and verified; not built locally because no Docker daemon is available)

**File:** `rag-sidecar/Dockerfile:1`
**Issue:** `python:3.12-slim` moves over time, so builds are not reproducible.
**Fix:** Pin `python:3.12-slim@sha256:<digest>`.

### IN-09 (Low): Generality without instantiation: `chunkUrlMetadata` duplicates `chunkMetadata`

**Fix status:** skipped: `tests/legacy-post-filter.test.ts` passes a populated `chunkMetadata` with an empty `chunkUrlMetadata`, so the second parameter is a used test seam (the finding's own keep condition)

**File:** `src/app/api/internal/rag/run/route.ts:81-82`, `src/lib/rag-eval/legacy-post-filter.ts:26-27`
**Category:** necessity
**Issue:** The one production call site passes the same map for both parameters, so the second parameter models a distinction that does not exist. The chat route reads chunk metadata once for both purposes. Rated Info: a test seam may justify it, and `tests/legacy-post-filter.test.ts` was not checked for separate use.
**Fix:** Collapse to one parameter unless the tests pass different maps.

### IN-10 (Low): Config UI says secrets need 32+ characters but does not enforce it

**Fix status:** fixed (`d27e8ec`; non-blocking warning in the config UI and config-server)

**File:** `scripts/config-ui/index.html:6355-6386`, `src/lib/rag-eval/auth.ts:180-182`
**Issue:** A shorter secret saves without complaint, and the endpoint then answers 503 "not configured" with no hint why.
**Fix:** Validate the length in the UI, or have `config-server.js` warn on save.

### IN-11 (Low): Pydantic validation in `run-nightly` depends on the current directory

**Fix status:** fixed (`9dc8685`)

**File:** `eval/harness/run-nightly.mts:114-121`
**Issue:** `uv run --project rag-sidecar` is resolved against the current directory, so running from anywhere but the repo root fails with exit 3. `run-smoke.mts` builds an absolute path from `REPO_ROOT` instead.
**Fix:** Use `path.join(REPO_ROOT, 'rag-sidecar')` and `cwd: REPO_ROOT`.

---

_Reviewed: 2026-11-23T11:26:40Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
