---
phase: "quick"
plan: "chat-ui-redesign"
subsystem: "web chat UI"
branch: "feat/mobile-chat-glass-layout"
key-files:
  created:
    - src/app/chat-shell.css
    - src/lib/hooks/use-chat-viewport.ts
    - tests/ui/chat-shell-layout.test.ts
  modified:
    - src/app/layout.tsx
    - src/app/client-layout.tsx
    - src/app/globals.css
    - src/app/page.tsx
    - src/components/ui/header.tsx
    - src/components/ui/chat-input.tsx
    - src/components/ui/mobile-toolbar-fixed.tsx
    - src/components/ui/user-menu.tsx
    - src/components/ui/sources-button.tsx
    - src/components/ui/sidebar.tsx
    - src/components/ui/unified-upload-button.tsx
    - src/components/ui/voice-end-button.tsx
completed: "2026-11-25"
---

# Chat UI redesign: summary

Contract: [chat-ui-redesign-UI-SPEC.md](chat-ui-redesign-UI-SPEC.md).

## What changed

- **Bottom-pinned composer on phones.** One `.chat-dock` owns the bottom inset once
  (`max(8px, env(safe-area-inset-bottom))`). Removed the stacked paddings that floated the composer: the WebKit
  `calc(env(safe-area-inset-bottom) + 25px)` and `min-height: calc(100px + …)` on `.chat-input-container`, `pb-safe` on both
  docks, the Android `position: fixed; bottom: 28px` on the container, and the second (opaque) phone disclaimer in `page.tsx`.
- **Keyboard-aware.** `viewport.interactiveWidget = 'resizes-content'` (Chrome on Android lifts the fixed dock itself);
  `useChatViewport()` writes `--chat-kb-inset` from `visualViewport` for iOS, where only the visual viewport shrinks, and the
  dock sits at `bottom: var(--chat-kb-inset)`. `--chat-dock-h` (ResizeObserver) pads the list so the last message clears the
  dock. The top bar follows a panned visual viewport (`--chat-vv-top`).
- **Root-cause fix.** Removed `* { transform: translateZ(0) }` for DPR ≥ 2 phones in `globals.css`; it made every element a
  containing block, so `position: fixed` stopped pinning to the viewport.
- **Glass bars.** Top bar: translucent canvas + `blur(20px) saturate(180%)` (`-webkit-` prefixed), hairline border,
  safe-area-top padding. Dock: gradient fade + masked `blur(16px)` so messages dissolve under it. `@supports` fallback to
  opaque canvas; `prefers-reduced-transparency: reduce` turns both opaque.
- **Pills.** Header icon buttons, model selector, avatar, composer controls, send/voice/stop, sources button, sidebar header
  buttons and assistant action buttons are capsules; lucide icons at 1.75 stroke.
- **Composer card.** Surface token, hairline border, soft shadow, 24px radius, focus-within accent border; compact one-line
  disclaimer under the card (ellipsis in long locales).
- **Type.** Instrument Sans (OFL, `next/font`) for chrome via `--font-chat-ui`; answers keep the reader-selected font.
- **Viewport meta.** One source (layout.tsx); zoom allowed again; `theme-color` matches the canvas in both themes.
- No chat, RAG, auth or API logic changed. `chat-message.tsx` (parallel follow-up-chips PR) is untouched: the user bubble
  and action pills are styled from `chat-shell.css` through existing class hooks.

## Revision 2 (2026-11-26)

Matched to the Claude iOS app screenshots (UI-SPEC "Revision 2"):

- Floating glass capsules in the header over a progressive blur; title capsule instead of the header model dropdown.
- Model picker in the composer tool row (`src/components/ui/composer-model-pill.tsx`), same model provider and list.
- Collapsed one-line composer capsule on phones, expanded card while in use (`src/lib/chat-composer-state.ts`,
  `data-composer` on `.chat-input-container`); `data-chat-input-form` on the form.
- Phone disclaimer only on the empty welcome screen at rest.
- Glass `ArrowDown` scroll-to-latest button above the dock (`scroll-indicator.tsx`).
- The orange arc was the animated comet border (`NEXT_PUBLIC_BORDER_ENABLED`, on by default) frozen mid-travel, not a
  focus ring; hidden on phones, desktop unchanged.
- Keyboard check (Playwright, iPhone 15, visualViewport height overridden by 336px and resize dispatched): expanded card
  bottom 8px above the keyboard top; tapping the collapsed capsule focuses the textarea; with the model menu open the
  textarea keeps focus.
- Tests: `tests/ui/chat-composer-state.test.ts`. Screenshots `ui-shots/v2-*` in the session scratchpad.

## Verification

- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npm run typecheck:new`: no Phase 1 type errors.
- `npx vitest run`: full suite (see PR body for counts); new `tests/ui/chat-shell-layout.test.ts` (10 tests).
- `node scripts/check-config.mjs`: ok.
- `npx next build` with the pr-smoke placeholder env.
- Playwright (Chromium) screenshots, iPhone 15 and 1280px, light and dark: empty, settings open, conversation top,
  scrolled under both bars, bottom. Keyboard behaviour cannot be emulated headless; the mechanism is unit-tested
  (`computeKeyboardInset`) and needs a device check.

## Design skills

| Skill | Role | Outcome |
|-------|------|---------|
| frontend-design | Direction and token plan in the UI-SPEC (palette, Instrument Sans, pill system, glass); plan reviewed against the calibration list (no generic cream, accent only on four elements) | pass |
| Impeccable | Critique and polish from `reference/craft-floor.md` and `reference/polish.md` (launcher not run, no network download): fixed dark-mode header tint override, settings sheet surface and focus, composer focus-within, contrast of placeholder and disclaimer (≥ 4.5:1), list end clearance measured at 24px | pass |
| web-design-guidelines | `references/command.md` applied to every touched file; findings below fixed | pass (all findings resolved) |

web-design-guidelines findings (all fixed):

- src/app/layout.tsx:8 — `maximum-scale=1` / `user-scalable=no` disable zoom — fixed (removed)
- src/app/client-layout.tsx:84 — second viewport meta with `maximum-scale=1.0` — fixed (removed)
- src/app/layout.tsx:11 — `theme-color` did not match the page background — fixed
- src/app/page.tsx:4575 — `<script>` rendered inside a React component (never runs on the client) — fixed (removed)
- src/app/page.tsx — "Send a private message..." uses `...` — fixed (`…`)
- src/components/ui/header.tsx:494 — hard-coded English sr-only label on the private-chat button — fixed (`t('useIncognitoChat')`)
- src/components/ui/header.tsx — decorative icons not hidden from assistive tech — fixed (`aria-hidden`)
- src/components/ui/user-menu.tsx:111 — avatar icon button without an accessible name — fixed (`aria-label`)
- src/components/ui/sidebar.tsx:176 — chat row is a `div` with `onClick` and no keyboard path — fixed (`role="button"`, `tabIndex`, Enter/Space)
- src/components/ui/sidebar.tsx:1999-2079 — six icon buttons without `aria-label`; `transition-all` — fixed
- src/components/ui/voice-end-button.tsx:44 — `transition-all` — fixed (listed properties)
- src/components/ui/chat-input.tsx — textarea `outline: none` without a replacement — fixed (card `:focus-within` border)
- src/components/ui/mobile-toolbar-fixed.tsx — menu items `outline: none` inline — fixed (`:focus-visible` outline in chat-shell.css)
- src/app/chat-shell.css — `color-scheme` not set for dark theme — fixed (`html.dark { color-scheme: dark }`)

## Pre-existing items outside the changed lines

Kept out of scope to avoid touching translations in 20 locales or unrelated logic: the `messagePlaceholder` copy has no
trailing `…`; the sources button labels ("Sources", "Show sources") are English-only; the mobile toolbar trigger's sr-only
text is English-only.

## 6-pillar self-audit (gsd-ui-review style)

| Pillar | Score (1-4) | Notes |
|--------|-------------|-------|
| Copywriting | 4 | No new copy; disclaimer kept, compact, single line |
| Visuals | 4 | Clear hierarchy: glass bar, centred heading, one card; pills consistent |
| Color | 3 | Tokens in light and dark; accent limited to send, focus, caret, voice. Legacy peach tints remain in untouched panels |
| Typography | 3 | Instrument Sans chrome, 16px composer floor; answers keep the reader font (serif answers deferred) |
| Spacing | 4 | 4px grid, 12px dock gutters, 24px list end clearance measured |
| Experience design | 3 | Keyboard path implemented and unit-tested; device check still needed on iOS Safari and iOS Chrome |
