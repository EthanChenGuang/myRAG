# Config UI fixes (2026-11-25)

Branch `exec/fix-config-ui-bugs`. Each fix has a test that failed on the old code (RED commit) before the fix (GREEN commit).

## Fixes

| # | Bug | RED | GREEN |
|---|-----|-----|-------|
| 1 | `renderModels` XSS | 40a7006 | b1d0fe7 |
| 1 | Other index.html sinks (19) | 33a5a90 | 944dd80 |
| 1 | Document processor `logActivity` | 224b858 | 304e3df |
| 1 | document-manager, status-monitor, connectors, MCP config | 3e5074e | 424a257 |
| 2 | Ingestion panel never starts | 3957610 | 8bc6e8a |
| 3 | Ingestion sign-in shows `{appUrl}` | 3957610 | 86e6151 |
| 4 | Doc types / Embedding profiles ignore mobile link | 3957610 | 8840e9c |
| 5 | Unlabelled status icons | 40a7006 | 35da416 |
| 6 | Remove model acts at once | 40a7006 | 6e5a59f |
| 7 | No keyboard reorder | 40a7006 | cca1602 |

Test support: `tests/ui/helpers/html-fake-dom.ts` is a fake DOM whose `innerHTML` setter parses markup, so injected `<img src=x onerror=…>` becomes an element and the tests fail on assertions, not on crashes. New shared helpers: `scripts/config-ui/utils/safe-dom.js` (`cuiEl`, `cuiFillSlots`).

## innerHTML sinks

Fixed (data now goes in through `textContent`, DOM properties or escaping; inline handlers that carried data became listeners):

- index.html: model list; KB image picker, grid, lightbox, notification, upload count; favicon previews (config load and upload); suggestion groups; welcome messages; workspace selector; custom templates; share modal; shared-prompt import from a `?sharedPrompt=` link; translated prompt preview; admin status indicator, users list, action and setup results; processing activity log; document processor activity log; model auto-fetch; OpenRouter test; embed suggestions.
- document-manager.js: row action buttons (HTML-escaped values inside `onclick` were decoded back before the JS ran, so a file name could break out), delete dialog, toast.
- status-monitor.js: queue list, file status error, RAG config display, batch result.
- connectors-config.js: provider cards (Drive/Notion folder names, labels, stats), provider keys in ids and handlers, connections table, notification, confirmation dialog.
- mcp-config.js: server cards, add/edit dialog values and credentials, auth fields, notification, built-in dialog.

Reviewed and left as they are:

- rag-panels/*.js: no `innerHTML` use.
- index.html queue and result cards (`createQueueItemHTML`, `createResultHTML`, `createIngestResultHTML`) and scraper status: already escaped.
- `formatMessageWithLinks` (index.html) and `formatMarkdown` (floating-chat-widget.js): escape before linkifying.
- floating-chat-widget.js: messages escaped; `primaryColor` is a constant default and the widget is not instantiated by index.html.
- pickers/*.js: values escaped; provider keys come from connectors-config (now sanitized).
- utils/modal.js: takes HTML by design; its callers pass the pickers' escaped markup.
- Border animation preview: values come from `type=color` and `type=range` inputs.
- Constant-only markup (spinners, fixed SVGs, button label restores).
- document-processing/rag-config-manager.js: not loaded by index.html (no `<script>` tag); not changed.

## Deferred / noted

- Pickers call `this.showError(...)`, which none of the picker classes define (pre-existing; an error path would throw). Not an XSS sink; not changed.
- The KB image lightbox opens from a click on a `div` tile and has no Escape handler; out of scope here.
- Suggestion-group and embed-suggestion inline handlers still use numeric indexes in `onchange`/`onclick` (no data in them).

## Design skills

- **frontend-design**: no new interface. The remove-model dialog reuses the 04-36 native `<dialog>` pattern (focus on Cancel, Remove in `btn-error`); the up/down buttons reuse daisyUI `btn-ghost btn-square`. No new visual direction.
- **impeccable**: no separate pass. Critique by hand on the changed rows: the up/down pair sits before Set Default/Remove so the destructive button stays last; disabled ends make the boundaries visible; toasts keep their copy.
- **web-design-guidelines** (bundled `references/command.md`, on the touched code). Findings and fixes:
  - drag handle `☰` decorative → `aria-hidden="true"` (fixed)
  - status icons unlabelled → `role="img"` + `aria-label` + `<title>` (bug 5, fixed)
  - drag-only reorder → Move up/down buttons with `aria-label` (bug 7, fixed)
  - destructive Remove without confirmation → `<dialog>` (bug 6, fixed)
  - icon-only buttons (image delete, lightbox close, notification dismiss, template delete) missing `aria-label` → added
  - suggestion and share inputs without labels → `aria-label` added
  - toasts/notifications not announced → `role="status"` / `role="alert"`
  - thumbnails and favicon previews without dimensions → `width`/`height` set
  - model name/id overflow in flex row → `min-w-0 break-words`
  - new dialogs: `overscroll-contain`
  - `...` → `…`, straight quotes → curly quotes in touched copy
  - Not fixed (outside the touched code): `Loading admin users...` and other existing loading copy, native `<select>` dark-mode colours, `Intl` formatting of existing dates.

## Gates

See the final report for results.
