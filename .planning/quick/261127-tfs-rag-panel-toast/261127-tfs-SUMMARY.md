---
quick_id: 261127-tfs
slug: rag-panel-toast
status: complete
date: 2026-11-27
branch: exec/quick-rag-panel-toast
base: origin/ci/merge-train-38
key-files:
  created:
    - scripts/config-ui/rag-panels/panel-status.js
    - tests/ui/config-rag-panel-toast.test.ts
    - .planning/quick/261127-tfs-rag-panel-toast/261127-tfs-UI-SPEC.md
  modified:
    - scripts/config-ui/index.html
    - scripts/config-ui/rag-panels/chunking-profiles.js
    - scripts/config-ui/rag-panels/doc-types.js
    - scripts/config-ui/rag-panels/embedding-bindings.js
    - scripts/config-ui/rag-panels/embedding-profiles.js
    - scripts/config-ui/rag-panels/identifier-patterns.js
    - scripts/config-ui/rag-panels/monitor.js
    - scripts/config-ui/rag-panels/question-sources.js
    - scripts/config-ui/rag-panels/refusal-calibration.js
    - scripts/config-ui/rag-panels/setting-check.js
    - tests/ui/config-identifier-patterns-panel.test.ts
---

# Quick 261127-tfs: RAG panel action results also shown as a toast

Owner walkthrough: results like "Pattern … disabled." showed only in the card's bottom status region, far from the button.
Now a completed action's sentence also appears in the page toast; the status region is unchanged.

## What changed

- **UI-SPEC amendment** `261127-tfs-UI-SPEC.md` (amends 03.1.1, 03.2, 04, 04.2, 05.3): the status region stays the only live region;
  completed actions are also echoed in the toast, `aria-hidden="true"`; errors, refusals, unconfirmed outcomes, loading, progress,
  list-loaded and dry-run/test lines never toast; no new copy.
- **Shared helper** `scripts/config-ui/rag-panels/panel-status.js`: `ragPanelSetStatus(host, render, isError, options)` renders the
  status region through the panel's own renderer, then, for `{ toast: true }` and not an error, calls
  `showToast(<status region text>, 'success', { ariaHidden: true })`. The toast text is read back from the rendered region, so the
  two always match (also for segment messages). Loaded in `index.html` right before `rag-fetch.js` (the pinned rag-fetch → gates-ui →
  judge-calibration order is kept). A panel loaded without it (unit harnesses) renders the status region only.
- **All nine panels** (grep `setStatus` under `scripts/config-ui/`): chunking-profiles, doc-types, embedding-bindings,
  embedding-profiles, identifier-patterns, monitor, question-sources, refusal-calibration, setting-check. Each `setStatus` now
  delegates to the helper. Toast call sites: chunking (profile created, build completed, activate/rollback succeeded), doc-types
  (defaults saved), embedding-bindings (action succeeded — once, after the reload; binding created/exists), identifier-patterns
  (enabled/disabled, deleted incl. 404-as-done, saved), monitor (acknowledged, resolved, run done, copied, webhook removed),
  question-sources (sample run done, pilot added/removed/gone, import done). embedding-profiles, refusal-calibration and
  setting-check write no success sentence today, so they are wired with no toast call site (adding one would need new copy).
- **`showToast(message, type, options)`** in `index.html`: `{ ariaHidden: true }` sets `aria-hidden="true"` on `#toast`; any other call
  removes it, so the page's other toasts behave as before.
- **Two toast fixes found in review** (each with a RED test first): a newer toast restarts the 3 s hide timer (the previous timer used
  to hide it early); the alert wraps inside the viewport (`whitespace-normal break-words max-w-[min(28rem,calc(100vw-2rem))]`),
  since DaisyUI's `.toast` is nowrap. Checked in Chromium at 360px and 1280px: the toast stays within the viewport and on top.
- Error handling unchanged: same text, `text-error`, icon, alerts and focus.

## Commits

| Commit | Kind |
|--------|------|
| 03022fdd | docs: plan + UI-SPEC amendment |
| 36e67060 | test: RED (helper, showToast option, script order, panel wiring, identifier-patterns disable/delete toast, error path) |
| ce01ec9f | feat: helper, showToast option, nine panels |
| 17601c25 | test: RED second toast hidden early |
| 2c76b3b5 | fix: hide timer restarts |
| 21fbc32d | test: RED toast overflow on narrow screens |
| 9e5cc4a0 | fix: toast wraps |

Tests that failed before the fix: 13 in the first RED (all assertions; a do-nothing helper stub kept them off module-not-found),
then 1 per fix RED.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `node scripts/check-config.mjs`: ok
- `node scripts/ci/check-language-literals.mjs`: ok (no new copy; toast reuses each panel's existing en/zh/it sentence)
- `node scripts/ci/check-rag-boundary.mjs`: ok; `node scripts/ci/check-settings-classification.mjs`: ok
- `npx vitest run tests/ui`: 99 files, 2084 tests passed
- `npx eslint` on touched files: no new errors (2 pre-existing errors in monitor.js `monitorCountItem` unused and question-sources.js
  duplicate `onWorkspaceChange`, both present on the base)
- `node scripts/ci/check-frontend-design-summary.mjs .planning/quick/261127-tfs-rag-panel-toast`: pass

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | Direction: an admin dashboard echo, not a new surface — reuse the page's existing `#toast` (DaisyUI `alert-success`, top end) with no new colour, type or motion; the toast text is the status sentence verbatim | pass |
| Impeccable | Critique from `reference/harden.md`/`craft-floor.md` (launcher not run, no network download): found and fixed nowrap overflow at 360px and the stacked-toast early hide; checked contrast of the success alert and that the toast is topmost over the sticky header | pass |
| web-design-guidelines | `references/command.md` applied to every touched file: "async updates need aria-live" is met by each panel's `role=status aria-live=polite` region (the toast is a deliberate aria-hidden echo, so one announcement); no innerHTML, no new interactive element, no `transition: all` | pass (all findings resolved) |

## Deviations

- Ran the quick workflow inline (no planner/executor subagents) and did not touch STATE.md, per the executor brief.
- Script tag sits before `rag-fetch.js`, not after it: existing tests pin rag-fetch → gates-ui → judge-calibration adjacency.

## Operator actions

None. No env variable, migration or copy added.
