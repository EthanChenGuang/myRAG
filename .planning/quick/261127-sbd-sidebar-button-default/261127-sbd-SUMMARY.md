---
quick_id: 261127-sbd
status: complete
branch: exec/quick-sidebar-default
base: origin/ci/merge-train-38
---

# Summary: sidebar button falls back to its defaults when the server value is empty

The sidebar footer link showed a stale name from a long-gone build. `src/components/ui/sidebar.tsx` rendered
`localStorage.SIDEBAR_BUTTON_TEXT` / `SIDEBAR_BUTTON_URL` and overwrote them only when `/api/config/get-env` returned a non-empty
value. With `NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT` / `_URL` unset, the old cache was never replaced and the default `myRAG` never showed.
Fixed.

## What changed
- New `src/lib/sidebar-button-config.ts`: `SIDEBAR_BUTTON_DEFAULTS` (same as `src/lib/env.ts`: `myRAG`, `https://myrag.laoxiang.app/`),
  `SIDEBAR_BUTTON_STORAGE_KEYS`, `readCachedSidebarButtonConfig(storage)` and `syncSidebarButtonConfig(storage, fetch)`.
  For each field, text and URL separately:
  - the server answers a non-empty string: show it and store it (as before);
  - the server answers empty (`{ value: '' }`, missing or not a string): show the default and **remove** that key;
  - non-OK response, network error or bad JSON: keep the cached value (an unreachable server does not wipe the setting).
- `src/components/ui/sidebar.tsx`: the effect reads the cache first (quick first render, as before), then applies the synced result;
  it ignores the result after unmount. State starts from `SIDEBAR_BUTTON_DEFAULTS`. Same `useState`/`useEffect` pattern as the
  surrounding component; no store involved (the values were never in Zustand).
- `scripts/init-env.js`: `NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT=myRAG` and `NEXT_PUBLIC_SIDEBAR_BUTTON_URL=https://myrag.laoxiang.app/`
  added to the BRANDING block (the drift).
- Checked, no change needed: `scripts/config-server.js` writes both variables in all three templates with the same defaults; the
  Config UI has both inputs (Branding & UI → Sidebar Button) with the defaults as placeholders and binds them by id through the
  generic config loader. Neither variable is RAG-related, so `scripts/rag/env-manifest.json` does not list it, as with the other
  branding variables; check-config passes.

## Tests
- RED (87463b04): `tests/sidebar-button-config.test.ts` (vitest) against the extracted old logic: 2 failed on assertions
  (stale value in storage plus empty server value for both variables → expected the defaults and both keys removed; one empty field
  resets only that field), 3 passed (cache read, non-empty values unchanged, failure keeps the cache).
- GREEN: 5/5. Fixtures use neutral fake values (`Stale Label`, `https://stale.example.test/`); the old product name appears nowhere.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/sidebar-button-config.test.ts`: 5 passed (no other test file imports `sidebar.tsx` or the new module)
- `node scripts/check-config.mjs`: ok, 274 variables
- `node scripts/ci/check-language-literals.mjs`: ok
- `node scripts/ci/check-rag-boundary.mjs`: ok
- `node scripts/ci/check-settings-classification.mjs`: ok
- web-design-guidelines (`.claude/skills/web-design-guidelines/references/command.md`, no network) on the changed region of
  `src/components/ui/sidebar.tsx` (the effect and the footer link it drives)

## Design skills
- web-design-guidelines: ran on the footer link. Findings fixed: the decorative `ExternalLink` icon now has `aria-hidden="true"`; the link has a
  visible focus ring (`focus-visible:ring-2 focus-visible:ring-[#FF6417]/60`, the colour already used elsewhere in `src/components`)
  replacing no focus style; `transition-all` → `transition-colors`. Layout, colours and copy unchanged.
- frontend-design / impeccable / gsd-ui-review: not run. This is a logic bug fix with no new interface or layout change.
- The rest of `sidebar.tsx` (about 2,600 lines, untouched by this task) was not audited.

## Behaviour change
- Unset or empty sidebar variables now show `myRAG` and the default URL, and remove stale cache keys. Set variables behave as before.
  A short flash of the old cached value can still appear on the first load after upgrading; the next fetch replaces it.

## Deviations
- None from the brief. No new env variable, no migration, no dependency change.

## Operator actions
- None required. The owner already set the button text and URL in Config UI (writes `.env.local`); that keeps working.
