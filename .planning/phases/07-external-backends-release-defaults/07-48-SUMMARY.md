---
phase: 07-external-backends-release-defaults
plan: 48
subsystem: config-ui-red-team
tags: [sec-11, red-team, config-ui, admin]

requires:
  - phase: 07-external-backends-release-defaults
    provides: "07-42 (runner `eval/harness/run-red-team.mts`, RedTeamReport, config/rag/red-team-techniques.json), 07-45 (last config-server.js editor before this plan), 07-20 (index.html and panel pattern)"
  - phase: 05.1.1-feedback-loop
    provides: "05.1.1-22 (review panels, RAG_DOMAIN_EXPERT_REVIEW)"
  - phase: 05-verified-citations-groundedness
    provides: "05-25"
  - phase: 05.1-prompt-injection-defense
    provides: "05.1-22"
  - phase: 06-query-layer-llamaindex-langchain
    provides: "06-45"
provides:
  - "GET /api/rag/admin/red-team/authorize: checkAdmin only, { ok, adminId }, 401/403/503, Cache-Control no-store, no CORS header, no OPTIONS"
  - "scripts/config-server-red-team.js: createRedTeamRunner (startRun, runStatus, latestRun, listRunConfigs) and registerRedTeamRoutes"
  - "Config server routes GET/POST /api/red-team/runs and GET /api/red-team/runs/:id, behind the existing loopback and CSRF middleware"
  - "scripts/config-ui/rag-panels/red-team.js: the Red-team runs panel (#rag-administration-red-team)"
affects: [07-49, 07-50]

actuals:
  tasks: 3
  commits: 6  # tracer, tests, panel, script-order fix, guard refactor, SUMMARY

tech-stack:
  added: []
  patterns:
    - "Config-server child processes: execFile with a fixed argument array, shell false, after a server-side admin check; refusals write nothing"

key-files:
  created:
    - src/app/api/rag/admin/red-team/authorize/route.ts
    - scripts/config-server-red-team.js
    - scripts/config-ui/rag-panels/red-team.js
    - tests/rag/admin/red-team-authorize-route.test.ts
    - tests/scripts/config-server-red-team.test.ts
    - tests/ui/config-red-team-panel.test.ts
  modified:
    - scripts/config-server.js
    - scripts/config-ui/index.html

key-decisions:
  - "Run id and directory: the config server mints the run id and passes `--out eval/out/red-team/<run_id>`; the 07-42 runner then writes report.json one level below (its own run id). The server reads report.json directly in the run directory (CLI runs) or one UUID directory below (Config UI runs). It writes status.json (id, state, times, error code only) so a failed or interrupted run still shows after a restart"
  - "Runner settings: the red-team workspace comes from the optional, gitignored operator file eval/golden/private/red-team-runner.json (tenant, baseUrl, markerDocument, deploymentMode, organizationId, userId, generator, generatorModel; strict keys, validated values). Without it the run is the in-process synthetic run on s:default. The browser cannot send a tenant: any body key other than runConfig is a 400"
  - "Command: execFile(process.execPath, ['--import', 'tsx', 'eval/harness/run-red-team.mts', 'run', ...]). This is what `npm run rag:red-team -- run` runs, without npm's shell wrapper (npm.cmd cannot be started without a shell on Windows)"
  - "Request order for a start: body validation (400), admin check (401/403/503), single-run check (409 { code: run_active, runningRunId }), runner settings (400), then mkdir and spawn. A non-admin cannot learn whether a run is active"
  - "A base-url runner configuration with a named run configuration answers 400 run_config_not_applicable (the runner refuses --run-config for deployed apps)"
  - "Error codes of a failed run: runner_refused (exit 2), runner_crashed (3), runner_skipped (4), runner_failed (other), runner_stopped (killed or timeout, 2 h), spawn_failed, report_missing, interrupted (status.json says running but this server holds no child)"
  - "Progress: the runner prints no per-item line, so progress is { done: null, total: null } and the panel shows the spinner. The server already parses `[Red Team] progress <done>/<total>` should the runner print it later"
  - "Technique labels: config/rag/red-team-techniques.json has no label field, so every cell falls back to its id (plan rule). The panel then shows the id once in font-mono instead of twice"
  - "Script order: red-team.js loads directly before retrieval-tuning-switches.js, which an existing Phase 4.2 test requires to be the last rag-panels script; it is after every other panel script"

requirements-completed: [SEC-11]

duration: one session
completed: 2026-11-28
---

# Phase 7 Plan 48: Red-team runs from the Config UI

**An operator admin can start a red-team run from the Config UI. The config server asks the app whether the caller is an admin, starts the plan 07-42 runner on the operator's machine, and the panel shows the attacks that got through per technique and language, with the number of review cases opened.**

## Tasks

| Task | Commits |
| --- | --- |
| 1. Tracer: route, config-server module and mount, panel, index.html | `86de88f6` feat |
| 2. Admin gate, refusal paths, single-run rule | `3cfecfd0` test; `45e088e2` refactor (guard grep) |
| 3. Panel states, accessibility, design pipeline | `f053ddbb` feat; `3e5f06ff` fix (script order) |

## Precondition

- 05, 05.1 and 06 VERIFICATION.md all read `status: human_needed`.
- All 461 transitive depends_on plans have a SUMMARY on this branch (base `d2645421`).

## Behaviour changes

- New admin-only app route `GET /api/rag/admin/red-team/authorize`, with no side effect. New config-server routes under `/api/red-team/`. New panel at the end of RAG administration. The tab intro gains "Start red-team runs." (07-49 completes that sentence).
- Chat, embed, voice, retrieval, strict refusal, webSearch, `source_images` and `{{context}}` are untouched. No new env variable and no migration.

## TDD notes

- Task 1 was the tracer, and Task 2's tests landed after it. I checked by mutation that they guard what they claim. Spawning before the authorize answer arrives fails 2 tests (`-t "non-admin"`). Answering 404 when no run exists fails 1 test (`-t "latest"`). Removing the focus restore after a poll re-render fails "keeps focus".
- Bug found during the design review (test fails on the earlier code): every poll rebuilt the controls, so the run-configuration select lost keyboard focus every 5 seconds. Fixed by restoring focus by id after a render.

## Design skills

| Skill | Outcome |
| --- | --- |
| frontend-design | pass: follows the approved 07-UI-SPEC 6.3 direction (start control above the last run's result, a table with counts beside rates instead of stat tiles, DaisyUI tokens only, colour only on a succeeded count above 0 with an icon) |
| Impeccable | pass: critique on the rendered panel (Chromium via the real config server, 1280px and 390px, no page scroll at 390px). Finding fixed: an unlabelled technique showed its id twice. Polish: phone layout hides the language and rate columns and puts them as second lines, per UI-SPEC 10 |
| web-design-guidelines | pass: all findings resolved (visible label per control, select name and autocomplete off, aria-describedby on the help line and on the disabled start button's reason, type="button" everywhere, decorative icons aria-hidden, polite status region that announces start and end only, table caption and th scope, focusable scroll region, tabular-nums, Intl dates and numbers, ellipsis characters, balanced headings, focus kept across re-renders). Sentence case is intentional per the UI-SPEC |

/gsd-ui-review was not run separately for this plan; the phase-level UI audit covers it.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run` on the three new test files plus every test file that imports config-server.js or reads config-ui/index.html (57 files): 1420 passed after the script-order fix (`tests/ui/config-phase42-switches.test.ts` failed before it, see Deviations)
- New tests: authorize route 6/6, config-server 29/29, panel 19/19
- `check-rag-boundary`, `check-config`, `check-language-literals`, `check-settings-classification`: ok
- Acceptance greps: execFile 3, exec/shell 0, `red-team.js` in index.html 1, Access-Control in the route 0
- Not run: rag-db (no SQL or RPC), test-rag (no retrieval, ingest, generation or golden change), gen:schemas (no contract change), workflows, Python
- `node scripts/ci/check-frontend-design-summary.mjs .planning/phases/07-external-backends-release-defaults`: PASS

## Deviations

- The runner is started as `node --import tsx eval/harness/run-red-team.mts run …` rather than through `npm run rag:red-team --`. Both run the same script, and this avoids a shell on every platform.
- Run directories nest the runner's own report one level below the server's run id (see key decisions), because the 07-42 runner takes no run-id flag and this plan does not edit the runner.
- `red-team.js` is the second-to-last panel script, not the last (Phase 4.2 test rule).
- Pre-existing on this line, not touched: the zh refusal snapshot drift in `tests/rag/characterize-chat`, already fixed on main.

## Requirement IDs and decisions for STATE

- SEC-11 (Config UI start): complete.
- Decision: red-team runner settings live in `eval/golden/private/red-team-runner.json` (operator file, gitignored); default in-process synthetic run on `s:default`.

## Operator actions

- To run against a deployed eval app, write `eval/golden/private/red-team-runner.json` with `tenant`, `baseUrl`, `markerDocument` (and `deploymentMode`, `organizationId` or `userId` in multi-tenant mode), and set `RAG_EVAL_SECRET` in `.env.local` or the config server's environment. Never point it at production.
- Live check (07-50): start a run from the panel as an admin and as a non-admin, then confirm the non-admin gets the admin-only notice and no run directory appears.

## Deferred

- Add a `label` field to `config/rag/red-team-techniques.json` (07-42's file and contract) so the panel can show readable technique names. It currently falls back to ids.
- A per-item progress line in the runner (`[Red Team] progress <done>/<total>`) would let the panel show the progress bar. The server already parses it.
- Run directories are never pruned. Deleting a run is outside this surface (UI-SPEC 11.9).
