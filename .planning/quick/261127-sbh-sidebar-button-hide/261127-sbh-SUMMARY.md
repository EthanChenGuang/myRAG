---
quick_id: 261127-sbh
status: complete
branch: exec/quick-sidebar-hide
base: origin/exec/quick-sidebar-default (e8ec5e2f)
key-files:
  modified:
    - src/lib/sidebar-button-config.ts
    - src/components/ui/sidebar.tsx
    - src/lib/env.ts
    - scripts/init-env.js
    - scripts/config-server.js
    - scripts/config-ui/index.html
    - tests/sidebar-button-config.test.ts
---

# Summary: the sidebar footer button hides unless both values are set

Owner decision, replacing 261127-sbd: when `NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT` or `NEXT_PUBLIC_SIDEBAR_BUTTON_URL` is empty, the footer
button is not rendered at all. Nothing falls back to a default, a cached value or an older value. The defaults are now empty, so the
button is hidden out of the box. Setting both values brings it back (the owner plans `Docs` plus the docs site URL later).

## What changed
- `src/lib/sidebar-button-config.ts`: `syncSidebarButtonConfig(storage, fetch)` now returns `SidebarButtonConfig | null`.
  - It returns `{ text, url }` only when **this page load's** server answers give both a non-blank text and a safe URL
    (`https:`/`http:` absolute, or a same-site path starting with a single `/`). Any other result returns `null`, which hides the button.
  - Values are trimmed, and a whitespace-only value counts as empty.
  - The two requests run in parallel.
  - localStorage is no longer read or written. The two legacy keys (`SIDEBAR_BUTTON_TEXT`, `SIDEBAR_BUTTON_URL`) are removed on every
    sync, whatever the outcome. A storage error (private mode) is swallowed.
  - Removed: `SIDEBAR_BUTTON_DEFAULTS` and `readCachedSidebarButtonConfig`.
- `src/components/ui/sidebar.tsx`: a single `sidebarButton` state, `null` (hidden) until the sync resolves. The footer
  (`border-t`, `p-4`, iOS Safari padding) renders only when there is a config. The label truncates (`min-w-0 truncate`, icon `shrink-0`).
- Defaults set to empty in `src/lib/env.ts`, `scripts/init-env.js` (both variables, empty) and all three `scripts/config-server.js`
  templates.
- Config UI (Branding & UI → Sidebar Button): the card says the button shows only when both are set, and each field says "Leave empty to
  hide the button". The URL hint asks for a full https:// address. Placeholders are neutral (`Docs`, `https://docs.example.com/`); the old
  product URL no longer appears in either file.

## Failure decision
Hide on failure, and trust only values the server confirmed in this session (page load). A non-OK response, a network error or bad
JSON on **either** request hides the button and clears the legacy keys.

Why: once localStorage stops being a source, a failed request has no trustworthy value left to show. A cached value is exactly the
stale state the owner wants gone, and it could point at a URL the operator has since removed. Flicker is not a cost either: the button
starts hidden and appears only after confirmation, so a failure can never show and then remove it. The worst case is a missing link
until the next load. Not writing the cache at all avoids a second source of truth that can go stale.

## Layout check (hidden state)
- The footer is the only child after the scroll area. With it removed, the `flex-1` chat list grows to the bottom of the sidebar:
  no empty band, no orphan `border-t`, no collapse. Measured at 1280×760, the list grows from 627 px to 696 px and ends at 760 px.
- iOS Safari branch (around lines 2552-2577): the shown footer keeps its 20 px top and `24px + safe-area + 40px` bottom padding. When
  hidden, a background-coloured spacer with no border (`aria-hidden`) keeps the end of the list clear of the Safari toolbar, height
  `env(safe-area-inset-bottom) + 40px` (40 px in Chromium, which reports a safe area of 0). Other browsers render nothing.
- Screenshots (Playwright, deviceScaleFactor 2, dark theme), `screenshots/`: `360-hidden`, `360-shown`, `360-stale-cache`,
  `1280-hidden`, `1280-shown`, `1280-stale-cache`, `360-hidden-ios`, `360-shown-ios`. The stale-cache shots preload both legacy keys:
  the button stays hidden and both keys are gone afterwards. The shown shots answer `Docs` and `https://docs.example.com/` through a
  route intercept.
  - Setup: real `Sidebar` mounted at a temporary local route (deleted, never committed); local dev server with placeholder env and
    `NEXT_PUBLIC_AUTH_ENABLED=false` for that process only.
  - `next dev` rewrote AGENTS.md on startup. That change was reverted and is not committed.

## Tests
- RED (d4604064): `tests/sidebar-button-config.test.ts` rewritten. 13 of 14 failed on assertions against the 261127-sbd code (defaults
  or cached values returned instead of `null`, and storage written when both values are set). Cases:
  - both values empty; text only; URL only; whitespace-only text;
  - both values set (shown, nothing stored); same-site path;
  - unsafe URLs: `javascript:`, protocol-relative, invalid, `ftp:`;
  - non-OK response, network error, bad JSON;
  - a failure on one of the two requests.

  The cases with stale storage also assert that both legacy keys are removed.
- GREEN: 14/14.

## Gates run
- `npx next typegen && npx tsc --noEmit -p tsconfig.json`: 0 errors
- `npx vitest run tests/sidebar-button-config.test.ts`: 14 passed
- Full `npx vitest run` (because `src/lib/env.ts` changed): 839 files passed, 3 skipped; 15943 tests passed, 90 skipped; exit 0
- `node scripts/check-config.mjs`: ok, 274 variables
- `node scripts/ci/check-language-literals.mjs`: ok
- `node scripts/ci/check-rag-boundary.mjs`: ok
- `node scripts/ci/check-settings-classification.mjs`: ok
- `node scripts/ci/check-frontend-design-summary.mjs .planning/quick/261127-sbh-sidebar-button-hide`: PASS
- Playwright screenshots at 360 px and 1280 px, hidden and shown (above)

## Design skills
| Skill | Outcome |
| --- | --- |
| frontend-design | n/a: no new interface. The footer row keeps its existing look; the change is show versus hide. |
| Impeccable | n/a: no visual redesign. The hidden and shown layouts were checked by screenshot; there is no empty band and no orphan border. |
| web-design-guidelines | pass, all findings resolved: ran `.claude/skills/web-design-guidelines/references/command.md` (no network) on the changed region of `src/components/ui/sidebar.tsx` and the Sidebar Button card of `scripts/config-ui/index.html`. Fixed: the long label now truncates (`min-w-0 truncate`, icon `shrink-0`). The empty state renders no broken UI (hidden instead of an empty link). The safe area is handled in the hidden iOS state. Already fine from 261127-sbd: focus ring, `aria-hidden` icon, hover state, real `<a>` with `rel="noopener noreferrer"`. Config UI: labelled inputs, `type="url"`. |

`/gsd-ui-review` was not run (quick task). The other ~2,600 lines of `sidebar.tsx` were not audited.

## Behaviour change
- Defaults: the button is hidden. Before, it fell back to `myRAG` and the default URL.
- Exactly one of the two values set: hidden. Both set: shown, with no caching.
- A failed load hides the button. Before, it showed the cached value.
- A URL that is not http(s) or a same-site path hides the button (new safety check against `javascript:` links).
- The legacy localStorage keys are removed from every browser on its next load.

## Deviations
- Added the URL safety check (not requested). It only hides the button for unsafe values and never shows anything new.
- Committed the eight screenshots under `screenshots/` as evidence of the layout check.
- No new env variable, no migration, no dependency change. `scripts/rag/env-manifest.json` is unchanged (branding variables are not
  listed there).

## Operator notes
- Production Vercel environment variables were not touched. If production sets both `NEXT_PUBLIC_SIDEBAR_BUTTON_TEXT` and
  `NEXT_PUBLIC_SIDEBAR_BUTTON_URL`, the button keeps showing there. Hiding it in production is the owner's call: clear either variable
  and redeploy.
- An existing `.env.local` that carries `myRAG` and the old URL (written by the previous defaults) also keeps the button. Clear the fields
  in Config UI to hide it.
- To show it later: set both, for example text `Docs` and the docs site URL (a full https:// address).
