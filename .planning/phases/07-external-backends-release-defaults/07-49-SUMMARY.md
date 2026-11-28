---
phase: 07-external-backends-release-defaults
plan: 49
subsystem: rag-rollouts
tags: [lang-11, lang-10, rollouts, promotion, config-ui, admin]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-46 (rag_language_quality_cells 0743, language-drop metric code), 07-47 (0744 rollout tables and functions, resolver, rag:rollout), 07-48 (last index.html editor), 07-10 (activation gate with the external index-ready condition)"
  - phase: 03.2-language-support-ingestion-hardening
    provides: "03.2-68 (rebuild activation)"
  - phase: 05, 05.1, 06
    provides: "closing plans 05-25, 05.1-22, 06-45; VERIFICATION.md status human_needed"
provides:
  - "config/rag/rollout-policy.json: observation_days 7, min_samples 30, max_window_days 90, per-measure band and required flag"
  - "src/lib/rag/rollout/promote.ts: compareRolloutLanguages, promoteRollout, observeRollout, listRollouts, rolloutServiceDeps, rolloutsEnabled, rolloutRpc"
  - "npm run rag:rollout -- promote <id> [--actor <uuid>] (exit 0 promoted, 2 refused with the code)"
  - "GET and POST /api/rag/admin/rollouts"
  - "scripts/config-ui/rag-panels/rollouts.js: the Rollouts panel (#rag-administration-rollouts)"
affects: [07-52]

actuals:
  tasks: 3
  commits: 9  # 3 x (test, feat), panel polish fix, SUMMARY, SUMMARY gate update

tech-stack:
  added: []
  patterns:
    - "Admin answers built field by field from typed results, so a server-only value (the rollout salt) can never be echoed"

key-files:
  created:
    - config/rag/rollout-policy.json
    - src/lib/rag/rollout/promote.ts
    - src/app/api/rag/admin/rollouts/route.ts
    - scripts/config-ui/rag-panels/rollouts.js
    - tests/rag/rollout/promote.test.ts
    - tests/rag/admin/rollouts-route.test.ts
    - tests/ui/config-rollouts-panel.test.ts
  modified:
    - src/lib/rag/rollout/cli.ts
    - src/lib/rag/monitor/language-drop.ts
    - src/lib/rag/index.ts
    - scripts/config-ui/index.html
    - tests/rag/admin/route-harness.ts

key-decisions:
  - "Baseline of a language: the candidate-arm workspaces' own window of equal length before the rollout started (capped at max_window_days, so rag_language_quality_cells never sees more than 400 days); the other workspaces' current window is shown beside it."
  - "Cells are read for every tenant (p_tenant_keys null) and split by arm in TypeScript with inCandidateArm: a share rollout's candidate workspaces are known only by their salted bucket, and the salt stays on the server. The plan's key link named p_tenant_keys = candidate arm; that cannot express a share arm."
  - "Arm sizes: workspaces seen in either window's log plus the included and excluded keys, split by arm."
  - "Measures refusal_rate (required) and not_helpful_rate, judge_score (optional). A required measure with fewer than min_samples in either candidate window is insufficient and blocks; an optional one below the floor is unmeasured and does not block (votes and judge scores are sparse). Worse: rate up, or judge score down, by more than the band. Bands from the 07-46 language_drop language bands (0.05, 0.10, 0.10)."
  - "Enabled languages: getLanguageSettings() when configured, else the languages the candidate arm answered in. A configured language with no data blocks (rollout_monitoring_insufficient)."
  - "Refusal order: observation first (no cell read), then in language order the first drop, else the first insufficient language, then the activation path's refusal unchanged (external_not_ready:<backend>, activation_refused..., the rebuild's code:reason)."
  - "chunking_profile promotion activates each candidate entry through activateChunkingProfile; a refusal part-way rolls back the doc types already flipped, so a refused promotion changes nothing."
  - "rag_rollout_finish(promoted) runs only after the activation succeeded. If it fails after a successful activation the route answers 503 and the rollout stays listed as active; a rollback then only ends it (pointers only)."
  - "Route guard: GET uses requireAdminOrDeny; POST uses checkAdmin + adminDenied (the same check) because the 0744 functions record the admin id as actor (T-07-165). 404 while RAG_ROLLOUTS is off, before the admin check, like the other switched-off routes."
  - "Ended rollouts are read from rag_rollouts with an explicit column list (id, kind, candidate_ref, state, ended_at), newest 20; no new SQL function, so no migration number was needed."
  - "Promote refusal transport: 409 { code } only; not_found / not_active from SQL is 404 (the UI's error.changed); a malformed key 400; other SQL refusals 409 { code }."

requirements-completed: [LANG-11, LANG-10]

duration: ~3h
completed: 2026-11-28
---

# Phase 7 Plan 49: Per-language gate on full activation, rollouts route and panel

**A rollout now reaches full activation only when every enabled language of the candidate workspaces held over the observation window against the same workspaces before the rollout. Admins run start, include, exclude, roll back and promote from one guarded route and a Config UI panel. The salt that `rag_rollout_active` returns to the service role never leaves the server; tests check that every list, promote and refusal answer omits it.**

## Branch setup

- `git fetch` of `exec/07-47`, `exec/07-46` and `exec/07-48` separately; `git checkout -B exec/07-49 origin/exec/07-47` at `f30cafe0`.
- `git merge --no-ff origin/exec/07-46` (`b913ec99`): clean, merge `5d02facf`; brings migration 0743.
- `git merge --no-ff origin/exec/07-48` (`0f0450b1`): clean, merge `5cc98f16`.
- **No conflicts** in either merge; migrations 0743 and 0744 are both present. No migration was added by this plan.

## Precondition

- 05, 05.1 and 06 VERIFICATION.md: `status: human_needed`.
- Every plan in depends_on (07-46, 07-47, 07-48, 07-10, 05-25, 06-45, 05.1-22, 03.2-68) has a SUMMARY on this branch.

## Tasks

| Task | Commits |
| --- | --- |
| 1. Tracer: promote only when every language holds | `fbca2e58` test, `f80f80fd` feat |
| 2. Admin route, all kinds | `fecb05e0` test, `be47a513` feat |
| 3. Rollouts panel | `afa90cdf` test, `53a6018d` feat, `b93b5869` fix (rendered review) |

## Behaviour changes

- With `RAG_ROLLOUTS=false` (default): none. The route answers 404 before any admin check or database read; the panel shows the switched-off notice with no controls. Nothing on the request path changed. Strict "information not available", webSearch with Exa, `source_images`, `{{context}}`, voice and embed chat are untouched.
- With `RAG_ROLLOUTS=true`: `npm run rag:rollout -- promote <id>` and `POST /api/rag/admin/rollouts {action:"promote"}` refuse with `rollout_observation_too_short`, `rollout_monitoring_insufficient:<lang>`, `rollout_language_drop:<lang>:<measure>` or the activation path's code; otherwise they activate the candidate globally (embedding: `activateEmbeddingProfile` with the 07-10 external readiness gate; chunking: `activateChunkingProfile`; rebuild: `activateRebuild`) and finish the rollout as promoted.
- `GET /api/rag/admin/rollouts` lists active rollouts (id, kind, candidate, incumbent, mode, share, state, createdAt, included, excluded, arm sizes, per language and measure the three values with n and the verdict) and the newest 20 ended ones (id, kind, candidate, state, endedAt), plus `policy.observationDays` and `policy.minSamples`.
- Config UI: new Rollouts panel at the end of RAG administration; the tab intro now ends "Start red-team runs and roll new profiles out to a few workspaces first."

## Salt (07-47 deferred item)

The route builds every answer from typed fields (`activeBody`, `endedBody`, `languagesBody`, the promote result), never by spreading a database row. Tests that fail if the salt shows up:
- `tests/rag/rollout/promote.test.ts`: the promote result, the list and the CLI output (promote success and refusal) do not contain the salt.
- `tests/rag/admin/rollouts-route.test.ts`: list (including an ended row whose table row carries a `salt` and `ended_by`), promote accepted, each promote refusal and a start refusal: no body contains the salt, `"ok":false` or the raw `rollout_refused` message; a request body carrying `salt` or `arm` answers 400.

## Tests that failed before the change

- The three test commits precede their implementation commits. The test files were written in the same sitting as the code, so no separate RED push was made; each test was checked by mutation instead:
  - promote, pooling every language (comparing the overall rate): both `rollout_language_drop` tests fail (checked).
  - route, `promote refused: 409` expects `{ code }` with no `ok` field and status 409; answering 200 with `ok:false` fails it.
- `tests/rag/admin/route-harness.ts` gained a `from()` table reader (`harness.tables`) so the route's ended-rollout and judge reads can be faked; existing admin route tests pass unchanged (218 passed).

## Design skills

| Skill | Outcome |
| --- | --- |
| frontend-design | pass: follows the approved 07-UI-SPEC 6.4 direction (promote directly under the per-language comparison, numbers with n and one word instead of charts or tiles, colour only on server-named verdicts with an icon, DaisyUI tokens, no destructive styling: rollback and exclude move pointers only) |
| Impeccable | pass: rendered critique in Chromium against the real config server (route stubbed with synthetic data), 1280px and 390px, no page-level horizontal scroll at 390px. Findings fixed: the form opened on a kind already in progress (disabled option selected); multi-word verdict badges wrapped out of their pill; at 390px the Result column scrolled out of view, so below 768px the verdict now sits under the candidate value (the comparison scrolls only inside its focusable region, as UI-SPEC 10 allows); the "already in progress" note showed under a free kind |
| web-design-guidelines | pass: all findings resolved (visible label per control, legend for the mode radios, aria-invalid with aria-describedby on invalid fields and focus moved to the first, buttons not disabled to signal invalid input, type="button" everywhere, decorative icons aria-hidden, polite status region for outcomes and role="alert" for refusals, table caption with th scope, focusable scroll regions, tabular-nums, Intl numbers, percentages and dates, curly quotes and ellipsis characters, monospace with translate="no" for keys and ids, inputs with name, autocomplete off and spellcheck off, every server string through textContent with an XSS test). Sentence case is intentional per the UI-SPEC |

/gsd-ui-review was not run separately for this plan; the phase-level UI audit covers it.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `node scripts/ci/check-rag-boundary.mjs`, `node scripts/check-config.mjs`, `node scripts/ci/check-language-literals.mjs`, `node scripts/ci/check-settings-classification.mjs`, `node scripts/ci/check-zod-isolation.mjs`: ok
- `npx vitest run tests/rag/rollout tests/rag/admin/rollouts-route.test.ts tests/ui/config-rollouts-panel.test.ts`: 14 + 11 + 12 passed
- Every test file importing a changed module (`git grep` on monitor/language-drop, rollout/cli, rollout/promote, rollout/resolve, route-harness) plus tests/rag/monitor, tests/api/language-quality-route.test.ts and the red-team panel test: 19 files, 237 passed, 11 skipped
- UI tests that read index.html (`git grep -l index.html tests/ui tests/scripts`): 51 files, 1226 passed, 1 failed: `tests/ui/config-reranker-cohere-hint.test.ts` ("says so in the init-env template next to RAG_RERANKER"). **Pre-existing**: it also fails with this plan's changes stashed; it reads scripts/init-env.js, which this plan does not touch.
- `node scripts/ci/check-frontend-design-summary.mjs .planning/phases/07-external-backends-release-defaults`: PASS
- Broad `npx vitest run tests/rag tests/api` (optional, because src/lib/rag/index.ts gained barrel exports): **not completed**. The first attempt hit a 590 s local timeout; the rerun was lost when the container restarted. Not required by the brief (no core type, env.ts or test setup change; the index change is additive exports only); the merge train's full suite covers it.
- Not run: rag-db (no SQL or migration changed; the route calls the existing 0743/0744 functions, covered by 07-46 and 07-47 rag-db tests), test-rag (no retrieval, ingest, generation or golden set change), Python, gen:schemas (no contract change), workflow check. Test-split ledger untouched (26/25).

## Deviations

- **Cells for every tenant** instead of `p_tenant_keys = candidate arm` (key decision above); counts only, split on the server.
- **POST guard** is `checkAdmin` + `adminDenied` (the body of `requireAdminOrDeny`), for the actor id; GET uses `requireAdminOrDeny`.
- **Files outside files_modified:** `src/lib/rag/monitor/language-drop.ts` (exports `languageCountMeasure`, `languageJudgeMetrics`, `languageJudgeMean` so promotion uses the same metric code), `src/lib/rag/index.ts` (barrel exports; the boundary check forbids deep imports from routes), `tests/rag/admin/route-harness.ts` (table reader).
- **Measure name** `judge_score` (UI-SPEC) for the judge mean that 07-46 calls `judge_mean`.
- **Extra label** `card.observation` ("Observation period: {count} days", en/zh/it) for the plan's "day N of observationDays"; every other string is copied from UI-SPEC 12.4.
- **TDD order** as described under "Tests that failed before the change".

## Threat model

- T-07-163: route fails closed (401, 403, 503) before any rollout read; 404 while off; the 0744 functions stay service-role only.
- T-07-164: per-language comparison against the arm's own baseline, minimum samples and days; every refusal path is tested to make no activation and no finish call; a part-way chunking refusal is undone.
- T-07-165: the admin id is passed as `p_actor` to every 0744 write and to the activation paths.
- T-07-SC: no package installed.

## Operator actions

- None new. Live promotion needs real retrieval-log traffic per language in both windows (RAG_RETRIEVAL_LOG on) and, for judge scores, the 05.3 daily job.

## Deferred

- The workspace-name lookup next to a listed key reads `#workspace-selector` options by the key's UUID; that selector's option values were not checked against a live page.
- A failed `rag_rollout_finish` after a successful activation leaves the rollout listed as active (503 to the caller). A retry-safe finish (promote when the candidate is already active) would remove that window.
- `tests/ui/config-reranker-cohere-hint.test.ts` init-env failure (pre-existing, see Gates).
