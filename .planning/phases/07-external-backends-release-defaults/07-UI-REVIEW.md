# Phase 07 — UI Review

**Audited:** 2026-11-28
**Baseline:** 07-UI-SPEC.md (sections 6.3, 6.4, 6.5, 7.3–7.5, 9, 10, 12)
**Screenshots:** captured (real `scripts/config-ui/index.html`, Playwright Chromium, served statically on 127.0.0.1:8782, every `/api/**` mocked). Stored in `.planning/ui-reviews/07-20261128-075442/` (gitignored).
**Interaction captures:** off (`workflow.ui_interaction_capture` is false). The interactions below were driven with Playwright clicks in the static harness: start-run dialog, new-rollout form with an empty submit, promote dialog and refusal, language add and save, and a 400 baseline refusal.

---

## Rendering method and capture matrix

| Locale | 360 | 768 | 1024 |
|--------|-----|-----|------|
| en-US | rt / ro / la | rt / ro / la | rt / ro / la |
| zh-CN | rt / ro / la | rt / ro / la | rt / ro / la |
| it-IT | rt / ro / la | rt / ro / la | rt / ro / la |

Key: rt = Red-team runs, ro = Rollouts, la = Languages.

The section screenshots were taken at height 900 with `deviceScaleFactor` 1. On top of that matrix:

- **Extra states** (en and zh, at 1024 and 360):
  - Red-team: empty, running (40/96), failed (`app_unreachable`), 403, 500, expert review off.
  - Rollouts: switched off (404), empty, 503, 401.
- **Interactions** (en and it, at 1024 and 360):
  - The red-team start dialog.
  - The new-rollout form submitted empty.
  - The promote dialog, then a promote refused with `rollout_language_drop:it:refusal_rate`.
  - Adding Italian to the languages and saving.
  - A 400 `language_baseline_missing` (with the body shape from the test).
  - The baseline-missing pack row.

**Programmatic measurements** (metrics.json and metrics-main.json):

- **Page overflow:** `documentElement` has no sideways overflow in any of the 90 captures, and no element runs past its panel outside an `overflow-x-auto` region.
- **Table regions:** every table region has `tabindex=0`, `role=region` and a localized `aria-label`.
- **Touch targets:** only native checkboxes and radios are 20×20. They sit in the Languages table (Phase 3.2) and on the rollout-form radios, which are wrapped in labels.
- **Translation:** no untranslated product strings were found in zh or it. English technique labels carry `lang="en"` in zh and it.

**Note on screenshots:** the page's sticky header covers part of some element screenshots. This comes from capturing elements under a sticky bar, not from a panel layout fault (see L-1).

## Language-quality verdict

`GET /api/rag/admin/language-quality` exists as an API route only: `src/app/api/rag/admin/language-quality/route.ts`, plan 07-46, which answers 404 while `RAG_MONITOR` is off. Nothing under `scripts/config-ui/` references it (`grep -rn language-quality scripts/config-ui` finds nothing), and 07-46-SUMMARY states "Config UI panel for the language-quality route (no UI in this plan)".

07-UI-SPEC.md does not name language-quality anywhere, so the build is consistent with the contract: there is no UI surface and none was promised. This is recorded as an informational gap (L-6), not a defect.

The vector-sync and backend settings blocks (UI-SPEC 6.2.5) belong to the generated settings section of plan 07-20 and were outside the panels rendered here. They are not scored.

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 3/4 | Copy matches 12.3–12.5 in all three locales. An unmatched 400 shows a dangling "The request was not accepted:" with nothing after it |
| 2. Visuals | 3/4 | Clear anchors (Start, Promote). At 360 the rollout verdict is off-screen in a scroll region |
| 3. Color | 3/4 | Colour only on server verdicts and success counts, always with a word or icon. Invalid form fields are not tinted |
| 4. Typography | 4/4 | Four sizes, two weights, mono only for ids and codes, tabular numerals right-aligned |
| 5. Spacing | 3/4 | On scale. The baseline error alert centres its bullet text at 360, and the mono command breaks mid-token |
| 6. Experience Design | 2/4 | The add-language dialog throws away the preview counts and shows "could not be counted" whenever the impact route fails. The verdict is hidden at mobile. Field errors are not visually marked |

**Overall: 18/24**

---

## Top 3 Priority Fixes

1. **The add-language impact dialog ignores the counts the preview already returned.** If `/api/rag/admin/ingest-fingerprint/impact` fails or is slow, the admin sees "The affected documents could not be counted" and a generic env diff, not the three-group language form promised in 6.5. Fix: in `ingestImpactCreateGuard` (`ingest-impact.js:743+`), render `options.groups` and the total when they are given and skip `count()`.
2. **At 360 the per-language comparison overflows its region.** Language, Measure and Candidate now (with the verdict badge underneath) need 299px inside a 195px region, so neither "Candidate now" nor the verdict is visible without scrolling sideways. Fix: stack Measure under Language below `md` (`rollouts.js:965–992`), or show the badge in the Measure cell.
3. **Invalid rollout-form fields are not visually marked.** "Enter the candidate ID." renders as plain `text-sm` body text, with no `input-error` border and no `text-error`. Fix: add `input-error` / `textarea-error` and `text-error` to the field and its message while `aria-invalid="true"`.

---

## Detailed Findings

### Pillar 1: Copywriting (3/4)

- **MED M-4 — `languages.js` error rendering.** A 400 whose body lacks `details[]` renders "The request was not accepted:" followed by nothing, in the status region (`ix-en-1024-la-baseline-400.png`, first run). Evidence: a 400 with `{errors:[...]}` produced the dangling colon. UI-SPEC 7.1 requires the unknown-code state to be a full sentence. Fix: when no detail is parsed, fall back to `error.generic` with the status code, with no colon.
- **LOW L-2 — red-team start dialog.** The accessible text contains "Close without starting" twice, because the `form.modal-backdrop` button carries the same visible label (`dialog.innerText` metric). Fix: give the backdrop button `aria-hidden="true"` and `tabindex="-1"`, or an empty `sr-only` "close".
- **Pass.** All 12.3 and 12.4 strings rendered in en, zh and it. For example: 红队测试, 开始红队测试, "Not promoted. Italian got worse on this measure…", and Italian `Avviare un’esecuzione red team?`. No domain example strings were found and no emoji in the new markup.

### Pillar 2: Visuals (3/4)

- **MED M-2 — `rollouts.js:965–992`.** Below 768px the comparison keeps three columns plus a hidden Result column, and the scroll region is 195px against content of 299px (en) or 311px (it). Candidate now and the verdict badge are clipped (`en-360-ro.png`). UI-SPEC 10 promises Language, Measure, Candidate now and Result at that width without hiding the verdict. Fix as Top 3 #2.
- **LOW L-3 — `red-team.js:599–652`.** The mobile attack table orders its columns Technique, Attacks, Succeeded. UI-SPEC 10 says Technique, Succeeded, Attacks. Fix: swap the column order below `md`.
- **Pass.**
  - "Start red-team run" and "Promote rollout" are the only solid primary buttons in their blocks.
  - The running state shows a disabled Start with its reason inline, and a `progress` bar with "Replayed: 40 of 96".
  - The refused promote is a warning alert placed directly above the action buttons.

### Pillar 3: Color (3/4)

- **MED M-3 — `rollouts.js` form validation.** Fields marked `aria-invalid="true"` (`rollouts-form-candidate`, `rollouts-form-tenants`) get no error tint, and the message line is neutral body text (`ix-en-1024-ro-form-invalid.png`). The invalid state is invisible to sighted users apart from focus moving to the first field. Fix as Top 3 #3.
- **LOW L-4.** The refused promote is shown twice: once as a solid `alert-warning` in the card, and once as `text-error` red in the status region (`ix-en-1024-ro-promote-refused.png`). The same refusal gets two different tones. Fix: render the status-region repeat in neutral text, or in the warning tone.
- **Pass.**
  - Success rates are not coloured. A count above 0 succeeded is `text-error` with `bi-shield-exclamation`.
  - The verdict badges carry an icon and a word (Holds, Got worse, Not enough data).

### Pillar 4: Typography (4/4)

- **Sizes and weights.** Headings are `text-lg` and `text-base font-semibold`, body text is `text-sm`, meta lines are `text-xs`.
- **Monospace.** Ids and language codes are `font-mono text-xs` with `break-all`, and the candidate id in the card heading uses mono.
- **Numbers.** Number columns are right-aligned with tabular numerals (`en-1024-rt.png`).
- **No issues** found against section 5.

### Pillar 5: Spacing (3/4)

- **LOW L-5 — `languages.js` findings alert.** At 360 the DaisyUI `alert` falls back to its centred mobile layout. The bullet list is centred, and the inline `code.break-all` command splits as "np / m run rag:languages -- ba / seline it" (`ix-it-360-la-baseline-400.png`). Fix: add `text-left` and `justify-items-start` (or `sm:` grid overrides) to the alert, and use `break-words` instead of `break-all` for commands inside sentences.
- **LOW L-1 — page-level.** Panels use `scroll-mt-4` (16px), but the sticky page header is about 50px tall. "Open Review queue" and the jump-to-heading links land with the heading under the header (visible in several element captures). Fix: `scroll-mt-16` on the panels and headings that are targets.
- **Pass.**
  - Card padding, `gap-2`, `gap-4` and `gap-6` are used consistently.
  - No arbitrary px values in the new markup.
  - No page overflow at 360 in any locale.

### Pillar 6: Experience Design (2/4)

- **HIGH H-1 — `ingest-impact.js:743–800`, `languages.js:875–894`.**
  - What happens: `languagesAddDialogOptions` hands the guard `groups`, `totalLabel` and `note`, but the guard always calls `count()` against the impact route. When that route fails, the dialog says "could not be counted". It then lists `RAG_SUPPORTED_LANGUAGES` twice and omits the und / scanned / stale table (`ix-en-1024-la-add-dialog.png`, it as well), even though the preview POST returned `selection: {groups:{und:1,scanned:2,stale:3}, total:6}`.
  - Why it is HIGH: 6.5 and 7.5 ("Impact dialog in its language form with three groups and the total") are not met whenever the app-side impact route is unavailable. The preview counts the server already decided on are thrown away.
  - Fix: see Top 3 #1.
- **MED M-2 and M-3** are described above: the verdict is hidden at mobile, and the invalid state is not visible.
- **Pass.**
  - All 7.3 states rendered: empty, running with a disabled Start, failed, 403, 5xx, and review off with an info alert.
  - The 7.4 states rendered: off (`RAG_ROLLOUTS` in code, no form or table), empty, 401, 503, refused promote, and a busy kind disabled in the form (Chunking profile pre-selected).
  - The baseline-missing row has a disabled checkbox and the command in mono.
  - A 400 `language_baseline_missing` gives one sentence with the filled command, and the status region repeats it.
  - The start dialog focuses "Close without starting".
  - The empty form submit focuses the first invalid field and sends nothing.
- **Score reasoning.** The pass list is broad, but one HIGH defect on a contracted flow and two MED defects cap this pillar at 2.

### Findings index

| ID | Sev | Where | Summary |
|----|-----|-------|---------|
| H-1 | HIGH | ingest-impact.js:743+, languages.js:875 | Add-language dialog drops preview counts and shows "could not be counted" or a generic diff when the impact route fails |
| M-2 | MED | rollouts.js:965–992 | Comparison verdict and candidate value scroll off-screen at 360 |
| M-3 | MED | rollouts.js (form) | Invalid fields and messages have no error styling |
| M-4 | MED | languages.js (error render) | Unparsed 400 leaves "The request was not accepted:" dangling |
| L-1 | LOW | panels' scroll-mt-4 | Jump targets land under the sticky header |
| L-2 | LOW | red-team dialog | Duplicate "Close without starting" via the backdrop button |
| L-3 | LOW | red-team.js:599 | Mobile column order differs from UI-SPEC 10 |
| L-4 | LOW | rollouts status region | Refusal repeated in red while the card alert is warning |
| L-5 | LOW | languages findings alert | Centred list and mid-token command break at 360 |
| L-6 | LOW (info) | language-quality | API only, with no Config UI surface; consistent with the UI-SPEC, which promises none |

---

## Files Audited
- scripts/config-ui/index.html (panel skeletons at lines 9160, 10140, 10150; script tags at lines 83–112)
- scripts/config-ui/rag-panels/red-team.js, rollouts.js, languages.js, ingest-impact.js, rag-fetch.js
- tests/ui/config-red-team-panel.test.ts, config-rollouts-panel.test.ts, config-languages-baseline.test.ts, helpers/languages-harness.ts
- src/app/api/rag/admin/language-quality/route.ts (existence only)
- .planning/phases/07-external-backends-release-defaults/07-UI-SPEC.md, 07-46-SUMMARY.md
