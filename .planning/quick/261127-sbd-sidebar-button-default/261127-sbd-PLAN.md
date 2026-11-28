---
quick_id: 261127-sbd
status: complete
---

# Plan: sidebar button falls back to its defaults when the server value is empty

Owner walkthrough: the sidebar footer link shows a stale cached name. `src/components/ui/sidebar.tsx` renders
`localStorage.SIDEBAR_BUTTON_TEXT` / `SIDEBAR_BUTTON_URL` first and overwrites them only when `/api/config/get-env` answers a
non-empty value. With `NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT` / `_URL` unset, the old cache is never replaced and the defaults never show.
Config drift: `scripts/init-env.js` lacks both variables, while `src/lib/env.ts`, `scripts/config-server.js` and the Config UI have them.

1. RED: extract the current load/sync logic into `src/lib/sidebar-button-config.ts` unchanged and add
   `tests/sidebar-button-config.test.ts` (vitest): neutral stale values in storage, server answers `{ value: '' }` for both
   variables, expect the defaults and both keys removed. Fails on assertions.
2. GREEN: an empty server value resets that field to its default and removes its key; a non-empty value behaves as today;
   a failed request (non-OK, network error, bad JSON) keeps the cached value. The sidebar calls the helper.
3. Config drift: add both variables to the BRANDING block of `scripts/init-env.js` with the `env.ts` defaults; check
   `config-server.js` (three templates already carry them) and the Config UI (inputs with the same defaults as placeholders).
4. Gates: typegen + tsc, check-config, check-language-literals, check-rag-boundary, check-settings-classification, vitest on the
   new test, web-design-guidelines on the touched UI file.
