---
quick_id: 261127-sbh
status: in_progress
files_modified:
  - src/lib/sidebar-button-config.ts
  - src/components/ui/sidebar.tsx
  - src/lib/env.ts
  - scripts/init-env.js
  - scripts/config-server.js
  - scripts/config-ui/index.html
  - tests/sidebar-button-config.test.ts
---

# Plan: hide the sidebar footer button unless both values are set

Owner decision (replaces 261127-sbd): when `NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT` or `NEXT_PUBLIC_SIDEBAR_BUTTON_URL` is empty the
sidebar footer button is not shown at all. No fallback to a default, a cached or an older value. Defaults become empty (hidden).

1. RED: rewrite `tests/sidebar-button-config.test.ts` against `syncSidebarButtonConfig` with the new contract (returns `null`
   when hidden): both empty, one empty, stale cache, non-OK, network error, bad JSON, whitespace-only, non-http URL → `null`
   and both legacy keys removed; both set → shown, nothing written to storage. Fails on assertions.
2. GREEN: `syncSidebarButtonConfig` returns the config only when this page load's server answers confirm both values; any
   failure hides. localStorage is no longer read or written; the two legacy keys are removed on every sync.
   `src/components/ui/sidebar.tsx` starts hidden and renders the footer only when the sync returns a config.
3. Layout: hidden state on desktop and on mobile; iOS Safari branch keeps a background-coloured safe-area spacer (no border,
   no button) so the last chat stays above the toolbar. Playwright screenshots at 360px and 1280px, hidden and shown.
4. Defaults empty in `src/lib/env.ts`, `scripts/init-env.js`, the three `scripts/config-server.js` templates; Config UI help
   text says "leave empty to hide" and the placeholders become neutral.
5. Gates: typegen + tsc, vitest, check-config, check-language-literals, check-rag-boundary, check-settings-classification,
   web-design-guidelines on the touched UI, check-frontend-design-summary on this directory.
