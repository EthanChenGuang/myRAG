---
phase: 01-evaluation-harness-baseline
fixed_at: 2026-11-23T12:10:00Z
review_path: .planning/phases/01-evaluation-harness-baseline/01-REVIEW.md
iteration: 1
findings_in_scope: 25
fixed: 22
skipped: 3
status: partial
---

# Phase 01: Code Review Fix Report

**Fixed at:** 2026-11-23T12:10:00Z
**Source review:** .planning/phases/01-evaluation-harness-baseline/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 25 (CR-01, WR-01 to WR-13, IN-01 to IN-11)
- Fixed: 22
- Skipped: 3

Fixes were committed one per finding on `claude/ecstatic-hamilton-86gtwv` in the main checkout (no worktree). Verification ran in the main checkout, so the results can be reproduced from this tree.

## Fixed Issues

### CR-01: `--single-tenant` drafting scope reads every tenant's personal documents
**Commit:** da7cbcb (from the interrupted earlier run)

### WR-01: Eval endpoint trusts caller-chosen organization_id / user_id
**Files modified:** `src/lib/rag-eval/auth.ts`, `src/app/api/internal/rag/run/route.ts`, `src/lib/env.ts`, `src/lib/rag-eval/trace.ts`, `scripts/init-env.js`, `scripts/config-server.js`, `scripts/config-ui/index.html`, `scripts/rag/env-manifest.json`, `eval/harness/run-eval.mts`, `tests/eval-route-auth.test.ts`
**Commit:** f27eeda
**Applied fix:** In multi-tenant mode, any request without a scope, or with a scope missing from `RAG_EVAL_ALLOWED_SCOPES`, gets a 403 (deny by default). The variable is mirrored in every config location. In-process harness runs allow the fixture user.

### WR-02: Gate regression exit code 1 collides with crash exit code
**Files modified:** `eval/src/rag_eval/gate.py`, `eval/tests/test_gate.py`, `.github/workflows/pr-smoke.yml`, `scripts/ci/check-workflows.py`
**Commit:** 6405d31
**Applied fix:** A regression now exits 10 and an internal error exits 70. The negative control checks for exit 10 and uses `jq` to confirm the offenders in gate.json. The checker requires both checks.

### WR-03: Draft/rejected items scored; held-out test split gated
**Files modified:** contracts (`eval_run.py`, `report.py`, `baseline.py`, samples, schemas, Zod), `eval/harness/*`, `eval/src/rag_eval/{runner,report,metrics,golden_io,baseline,gate}.py`, `judge/run.py`, tests, `eval/baselines/fixture-baseline.json`
**Commit:** a9f11ab
**Status:** fixed: requires human verification
**Applied fix:** Only approved items are scored. `--include-drafts` adds draft items; rejected items are never scored. The overall, language and category slices cover only the dev split. The test split is reported under `by_split` and never gates. The `GoldenFilter` is recorded in the manifest, report and baseline and is part of the gate's mismatch check. The baseline was re-recorded.

### WR-04: `conversation` dropped before answer generation
**Commit:** c5c49b0
**Applied fix:** The route passes `conversation` through. `generateEvalAnswer` sends the earlier turns before the current user turn.

### WR-05: Gate ignores deployment mode, tier, scope, embedder source
**Commit:** 1a52f6a
**Status:** fixed: requires human verification
**Applied fix:** The baseline now records tier, deployment_mode, request_options and embedder_source_sha256. The gate compares them, leaving out max_results.

### WR-06: Live tier cannot be scoped to a tenant
**Commit:** d263c9e
**Applied fix:** Adds `--org`/`--user` options to run-smoke and `baseline record`. For live runs, deployment_mode comes from the server. A live run against a multi-tenant server is refused unless it is scoped.

### WR-07: Eval secret forwarded on redirects / plain http
**Commit:** e7fb836
**Applied fix:** Requires https except on loopback, and sets `redirect: 'error'`.

### WR-08: Reviewer-edited question aborts the next drafting run
**Commit:** fa7cac6
**Applied fix:** A proposal whose id is already taken is counted as a duplicate.

### WR-09: Raw exception message returned to caller
**Commit:** 1019da5
**Applied fix:** The response carries only `retrieval failed: <ErrorName>`. The full message is logged on the server.

### WR-10: DeepEval auto-loads dotenv files
**Commit:** cfd0cce
**Applied fix:** Sets `DEEPEVAL_DISABLE_DOTENV=1`, re-checks for upload keys after the judge libraries are imported, and gitignores `eval/.deepeval/`.

### WR-11: Mutable action tags, unpinned uv, checker not run
**Commits:** 6ef7e7f, 1f51201
**Applied fix:** Each action is pinned to a commit SHA with a version comment, and uv is pinned to 0.11.32. check-workflows.py requires both. The ts job runs check-workflows.py and the gen-zod self-test.

### WR-12: Judge-family check bypassable
**Commit:** 270afde
**Status:** fixed: requires human verification
**Applied fix:** The model family comes from an explicit map. Routers, aliases and unknown ids are refused.

### WR-13: Ragas evidence attributed to the wrong document
**Commit:** fbf2bfb
**Status:** fixed: requires human verification
**Applied fix:** Evidence matching is tiered and picks the best overlap. A chunk that sits inside a context is accepted only if it covers at least 80% of it.

### IN-01 (partly), IN-02, IN-03, IN-05, IN-07, IN-08, IN-10, IN-11
**Commits:** 0ad5171, acad605, d5119cd, 850ca82, ef5c1d1, eaeaf2b, d27e8ec, 9dc8685. Details are in the Fix status lines in 01-REVIEW.md.

## Skipped Issues

### IN-04: Recall and judge contexts include image-document chunks
**File:** `eval/src/rag_eval/metrics.py:16`
**Reason:** The fix needs a new trace-contract field, a change to how recall and judge contexts are defined, and another baseline re-record. That is a metric-definition decision, not a small fix.

### IN-06: `npm run test-rag` was repurposed
**File:** `package.json:16`
**Reason:** The old target never existed, and the planning docs asked to fix or remove `test-rag`. The only remaining fix is a CLAUDE.md/AGENTS.md doc edit, which needs the user's approval.

### IN-09: `chunkUrlMetadata` duplicates `chunkMetadata`
**File:** `src/lib/rag-eval/legacy-post-filter.ts:26-27`
**Reason:** The tests pass different maps for the two parameters, which is the finding's own condition for keeping them.

---

_Fixed: 2026-11-23T12:10:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
