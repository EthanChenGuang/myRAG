---
quick_id: 261127-cuf
slug: config-ui-fixes
status: complete
date: 2026-11-28
branch: exec/quick-config-ui-fixes
base: origin/ci/merge-train-39
key-files:
  created:
    - .planning/quick/261127-cuf-config-ui-fixes/261127-cuf-PLAN.md
  modified:
    - scripts/config-ui/rag-panels/embedding-bindings.js
    - scripts/config-ui/rag-panels/languages.js
    - scripts/rag/language-settings-context.js
    - scripts/config-server.js
    - tests/ui/config-embedding-bindings-panel.test.ts
    - tests/ui/config-languages-panel.test.ts
    - tests/rag/lang-validate-entrypoints.test.ts
    - scripts/tests/config-server-languages.node-test.mjs
    - .planning/phases/03.1.1-domain-embedding-model-candidates-and-per-doc-type-model-sel/03.1.1-UI-SPEC.md
    - .planning/phases/03.1.1-domain-embedding-model-candidates-and-per-doc-type-model-sel/03.1.1-UI-REVIEW.md
    - .planning/phases/03.1.1-domain-embedding-model-candidates-and-per-doc-type-model-sel/screenshots/
    - .planning/phases/03.2-language-support-ingestion-hardening/03.2-UI-SPEC.md
---

# Quick 261127-cuf: Config UI fixes (embedding bindings panel, Languages panel)

Two groups only: the 03.1.1 UI-REVIEW findings on the Embedding bindings panel (BLOCKER 1, WARNINGs 2-15) and three
owner-walkthrough findings on the Languages panel. The audit commit 67564c85 (from `origin/verify/03.1.1-audits`) was
cherry-picked first (015a592f) so the review, screenshots and capture script sit in the phase directory this task updates.

## A. Embedding bindings panel (`scripts/config-ui/rag-panels/embedding-bindings.js`)

| # | Finding | Fix |
|---|---------|-----|
| 1 | BLOCKER: Profile column crushed at 390px | Below `md` rows stack: `thead` `sr-only md:not-sr-only`, row `flex flex-col … md:table-row`, cells `block md:table-cell`, a `md:hidden` column label per cell, Evidence shown at every width (the `md:hidden` duplicate in Status is gone), Scope `md:min-w-40` only. 390px capture: `scrollWidth` 390, every row and action reachable without in-table scroll |
| 2 | Generic "Cancel" | "Close form" in code and spec |
| 3 | Submit enabled without a scoped profile | `disabled` + `aria-describedby` the help line while `form.profile.none` applies |
| 4 | "recorded against None" | New `hint.staleNoBaseline` when `baseline_global_profile` is null |
| 5 | `form.profile.none` drift | Code now equals spec L429 ("…Scoped profiles are added by a database migration.") |
| 6 | Proxy error (app down) only a red status line | Every failed GET goes through the error alert with Try again (503 → `error.registry`, network → `error.network`, other → the proxy/server message verbatim); list dimmed, New binding disabled |
| 7 | No-profile sentence twice | Shown once: empty state when there is no binding, else in the state block |
| 8 | Loud switch-off alert | Quiet bordered note (`border-info/40 bg-base-100`, `text-info` icon, muted text) |
| 9 | Disabled Activate almost invisible | Gated Activate uses an outline with `disabled:border-base-content/40 disabled:text-base-content/70 disabled:bg-transparent` |
| 10 | Retire plain and wrapping | `btn-outline whitespace-nowrap`; button row `md:flex-nowrap` |
| 11 | Right-aligned CLI command | Hint is `text-left` (no `ml-auto`) |
| 12 | Warning icon detached | Icon flows inline with the first line of "n of m chunks missing" |
| 13 | `formOpen` survives a 401 | `showSignIn` drops the form state and resets `aria-expanded` |
| 14 | Two messages on 503 | When the reload after an unconfirmed change fails, the outcome becomes the first line of the one load alert and the status line is cleared (`reloadAfter`, also used by the form's 503 path) |
| 15 | Small type/spacing issues | Every mono id names its size; `break-words` instead of `break-all`; state block spaced by `flex flex-col gap-2` instead of stacked `mt-2`; profile id `md:whitespace-nowrap`, Profile `md:min-w-48`, Evidence `md:min-w-28` |

UI-SPEC 03.1.1 amended to match (layout below `md`, note style, action classes, gated Activate, hint, load-failure rows,
no-profile state, copy rows `form.cancel`, `hint.staleNoBaseline`), plus the checker's three consistency edits.

Copy locales: the bindings panel is English-only by its own contract (U-05; the UI-REVIEW lists zh/it as a follow-up), so
there was no zh/it copy to update for this group. Every new or changed Languages string is in en, zh and it.

## B. Languages panel

1. **Stale primary announcement.** `onPrimary` now announces `primary.moved` for the language just chosen; Reset selection
   clears the line. (Before: only the automatic move announced, so "中文 is now the primary language." stayed after choosing en.)
2. **"The embedding profile could not be read from the database…"** Root cause: neither the query nor permissions. The config
   server never queries the active-profile pointer at all; `validateForScript` hard-coded `verifiedAgainstActiveProfile: false`,
   and `describeLanguageSettings` did the same. With `RAG_EMBEDDING_PROFILES=off` (default) the app's active profile *is* the
   legacy profile (`getActiveProfile()` returns `LEGACY_PROFILE` without a database), so the check against the default
   declaration of that model is a check against the active profile. Code bug, fixed: `activeProfileCheck(context)` in
   `scripts/rag/language-settings-context.js` returns `null` (verified) in that case, else a `notVerifiedReason`:
   `profiles_on` (the pointer lives in the database, which the Config UI does not read), `default_not_active` (the
   declarations name another default model), `no_declarations` (nothing was checked). GET and POST `/api/config/languages`
   return `notVerifiedReason`; the panel picks `warn.notVerified.<reason>` (en/zh/it), and the generic `warn.notVerified` no
   longer claims a failed read. init-env gets the same result through the shared helper. Under the default settings and
   shipped declarations EVAL now sees `verifiedAgainstActiveProfile: true`.
3. **Groundedness warning twice.** The inline note under the table stays; `languagesWarningItems` drops a
   `groundedness_not_checked` warning for a language whose row already carries that note.

03.2-UI-SPEC updated (primary announcement, single groundedness warning, the four `warn.notVerified*` rows in en/zh/it).

## Review loop

- **gsd-ui-checker** on 03.1.1-UI-SPEC: APPROVED, no BLOCK (the "Cancel" BLOCK cleared). D1 FLAG on single-verb row labels,
  accepted because `aria.action` names action, profile, type and scope; D2 FLAG cleared by the checker's consistency edits.
  Sign-off boxes checked, frontmatter `status: approved`.
- **/gsd-ui-review 03.1.1** (gsd-ui-auditor re-run): 16/24 → **22/24**; BLOCKER and all 14 earlier warnings resolved. It
  raised three new desktop column-width warnings caused by the `break-words` change. W-1 and W-3 fixed afterwards (RED
  test first); a minimum width on Status pushed the actions out of view at 1440px and was reverted, so **W-2 stays open**
  (deferred: move long row hints into a full-width line). Recorded in the review's follow-up section.
- **Screenshots**: all 12 re-captured with Playwright into the original `screenshots/` directory with the committed
  `capture-bindings-panel.cjs` (Config UI on :3333, placeholder `.env.local` from `scripts/init-env.js`, synthetic GET data).

## Commits

| Commit | Kind |
|--------|------|
| 015a592f | docs: cherry-pick of the 03.1.1 UI audit (67564c85) |
| 9a7cc04f | docs: plan |
| d4aa45cf | test: RED Languages (8 vitest + 6 node assertions failing) |
| ec103624 | fix: Languages panel + config-server profile check |
| 0913bbb0 | test: RED bindings (13 assertions failing) |
| d359e96a | fix: bindings panel BLOCKER 1 + WARNINGs 2-15, UI-SPEC amended |
| 55f28dc9 | docs: screenshots re-captured |
| 1b9f282c | docs: 03.1.1 UI-SPEC signed off |
| 304124e9 | docs: UI re-audit (22/24); test: RED column widths |
| a79a01a6 | fix: column widths |
| 3de2e50f | fix: widths rebalanced (actions in view), inline icon, screenshots, review follow-up |

Tests that failed before the fixes: Languages 8 (tests/ui) + 6 (config-server node test); bindings 13; widths 1. All
failed on assertions.

## Gates run

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npm run typecheck:new`: no Phase 1 type errors
- `node scripts/check-config.mjs`: ok; `check-rag-boundary`, `check-language-literals`, `check-settings-classification`: ok
- `npx vitest run tests/ui tests/rag/lang-validate-entrypoints.test.ts`: 100 files, 2207 tests passed
- `node --test scripts/tests/config-server-*.node-test.mjs scripts/tests/init-env-languages.node-test.mjs`: 99/99
  (`config-server-rag-gate-e2e` failed until `uv sync --locked --all-extras` in eval/ per the brief; environment, not code)
- `node scripts/ci/check-frontend-design-summary.mjs .planning/quick/261127-cuf-config-ui-fixes`: pass

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | Direction for fixes on an existing surface: keep the panel's daisyUI tokens and type scale, no new colour or motion; below `md` each binding stacks into label/value lines with Status as the focal point; the switch-off state becomes quiet context (bordered base-100 note) instead of the loudest block; gated Activate keeps its outline | pass |
| Impeccable | Critique from `reference/harden.md` (launcher not run, no network download): long ids (UUIDs, tenant keys) wrap without `break-all`; error states forced (proxy 500, 503 after a mutation, 401 in the form) each give one message; checked the result in the 390px and 1440px captures and fixed the two regressions they showed (detached icon, actions pushed out of view) | pass |
| web-design-guidelines | `references/command.md` on every touched UI file (`embedding-bindings.js`, `languages.js`): status lines are `role=status aria-live=polite`, icons `aria-hidden`, ids `translate="no"`, numbers via `Intl`, no `innerHTML`, no `transition: all`. One deliberate exception: "submit stays enabled until the request starts" conflicts with the 03.1.1 contract, which disables Create binding when no profile can be chosen; the reason is visible and linked by `aria-describedby` | pass (all findings resolved or justified) |

## Deviations

- Quick workflow run inline per the executor brief (no planner/executor subagents); STATE.md not touched.
- Cherry-picked the audit commit from `origin/verify/03.1.1-audits` so the review and screenshots could be updated in place.
- Test-only edits after a RED commit: the bindings spec-parity test got a row-parsing fix (trailing `|`), and the Complete
  icon test changed from `items-start` to "inline, first child, no flex" when the fix moved from flex to inline flow;
  both still fail on the pre-fix code.
- `tests/rag/lang-validate-entrypoints.test.ts` now expects the script entry points to report `notVerifiedReason`, and
  `verifiedAgainstActiveProfile: true` when their default profile is the legacy model (profiles off).

## Deferred

- UI-REVIEW W-2 (Status column narrow on desktop, long hints): needs the hints in a full-width row line.
- Bindings panel zh/it copy (U-05, INFO in the review).
- Reading the real active-profile pointer from the Config UI when `RAG_EMBEDDING_PROFILES=on` (now reported honestly as
  `profiles_on`; the app still checks the active profile at startup).

## Operator actions

None. No env variable, migration or secret added.
