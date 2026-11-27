---
quick_id: 261127-cmt
slug: composer-comet-quieter
date: 2026-11-27
branch: exec/quick-composer-comet
base: origin/ci/merge-train-38
status: complete
key-files:
  modified:
    - src/components/ui/chat-input.tsx
    - src/app/chat-shell.css
---

# Quick 261127-cmt: quieter composer comet

The orange comet that travelled round the home composer ("Ask anything") was a 2.5px #FF6417 stroke with a
three-layer orange glow, two comets per lap. It is now one thin, cool trace that sits back behind the content.

## What changed (visual only)
- `src/components/ui/chat-input.tsx`: the comet SVG draws one comet as three stacked 1px dashes on the same path,
  a 180px trail, a 72px body and a 24px head at the leading end, so it fades from the head backwards. The
  secondary comet, the inline orange stroke and filter, and the duplicate inline `svg-travel` keyframes are gone.
  Lengths are module constants (`COMET_TRAIL_PX`, `COMET_BODY_PX`, `COMET_HEAD_PX`); the SVG is `aria-hidden`.
  Perimeter measurement, `NEXT_PUBLIC_BORDER_ENABLED` and all other logic are unchanged.
- `src/app/chat-shell.css`: token `--chat-comet-rgb` (light `84 102 128` slate, dark `178 210 238` ice blue);
  stroke opacities 0.14 / 0.2 / 0.4 (head composite ≈ 0.6); one soft `drop-shadow(0 0 2px … / .35)`;
  24s per lap (was 14s) via `@keyframes chat-comet-travel`.
- Focus: while the card has `:focus-within` the comet fades to 40% and pauses, so the existing orange
  `--chat-focus` border is the clear focus cue.
- `prefers-reduced-motion: reduce`: `.chat-composer-comet { display: none }`; the static hairline border remains
  (checked in Chromium with reduced motion emulated: computed `display: none`, light and dark).
- Phones (<640px) already hid the comet; unchanged.
- No store, streaming, chat or env change. No new env variable.

## Screenshots (this folder; Playwright Chromium, deviceScaleFactor 2, card clipped ±24px)
Before/after pairs, resting state (input blurred) unless named `-focus`:
- `before-light-360.png` / `after-light-360.png`, `before-dark-360.png` / `after-dark-360.png` (comet hidden on phones in both)
- `before-light-1280.png` / `after-light-1280.png`, `before-dark-1280.png` / `after-dark-1280.png`
- `before-light-1280-focus.png` / `after-light-1280-focus.png`, `before-dark-1280-focus.png` / `after-dark-1280-focus.png`
- `after-light-1280-reduced-motion.png`, `after-dark-1280-reduced-motion.png`
Local dev server only (`NEXT_PUBLIC_AUTH_ENABLED=false` and placeholder keys passed on the command line; no
Supabase or Vercel touched, nothing written to tracked env files).

## Design skills
| Skill | Outcome | Notes |
| --- | --- | --- |
| frontend-design | pass | Direction: one instrument-like trace, cool steel against the warm canvas, boldness kept in the focus border, not the decoration. |
| Impeccable | pass | Critique of the first build: a hard step between tail and head; fixed with a middle body segment so the trace fades smoothly. Focus and rest checked in both themes. |
| web-design-guidelines | pass, all findings resolved | Reviewed chat-input.tsx and chat-shell.css. Reduced motion: comet hidden. Long decorative loop: pauses and dims while the composer is in use, hidden under reduced motion. Decorative SVG: `aria-hidden`. Transition lists `opacity` only. Focus more prominent than rest: yes. Accepted by design: the animation runs on `stroke-dashoffset` (paint only, no layout) on one small SVG, as before; no compositor-only alternative draws a stroke along a rounded rect. |

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/ui/chat-composer-state.test.ts tests/ui/chat-input-organization.test.ts tests/ui/chat-send-tap.test.ts tests/ui/chat-shell-layout.test.ts tests/ui/chat-stream-state.test.ts`: 5 files, 27 tests passed
- `node scripts/ci/check-language-literals.mjs`, `check-rag-boundary.mjs`, `scripts/check-config.mjs`, `check-settings-classification.mjs`: exit 0
- `node scripts/ci/check-frontend-design-summary.mjs .planning/quick/261127-cmt-composer-comet-quieter`: PASS

## Deviations
- Dropped the secondary comet (owner asked for less attention; one trace is enough).
- The work was paused once on orchestrator request (WIP commit c7aa47ec with a continue-here note, removed here).
