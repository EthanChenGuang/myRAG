---
quick_id: 261127-tfs
slug: rag-panel-toast
status: planned
files_modified:
  - scripts/config-ui/rag-panels/panel-status.js
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
  - tests/ui/config-rag-panel-toast.test.ts
  - tests/ui/config-identifier-patterns-panel.test.ts
---

# Plan: RAG panel action results also shown as a toast

Owner walkthrough: results such as "Pattern … disabled" or "Defaults saved." appear only in the panel's status region at the
bottom of the card, far from the button; the owner expected a toast. Amendment: `261127-tfs-UI-SPEC.md` in this directory.

1. UI-SPEC amendment (this directory): a completed action's success sentence keeps the status region and is also shown in the page
   toast, `aria-hidden="true"`; errors, loading, progress and list-loaded lines are unchanged and never toast.
2. RED: `tests/ui/config-rag-panel-toast.test.ts` (helper, `showToast` aria-hidden option, script order, every panel delegates)
   and new cases in `tests/ui/config-identifier-patterns-panel.test.ts` (disable, delete: status and toast both carry the text;
   503 on toggle: status error, no toast).
3. GREEN: `scripts/config-ui/rag-panels/panel-status.js` (`ragPanelSetStatus(host, render, isError, options)`), loaded right after
   `rag-fetch.js`; `showToast(message, type, options)` takes `{ ariaHidden }`; each of the nine panels' `setStatus` delegates to the
   helper, and completed-action call sites pass `{ toast: true }`.
4. Design pipeline (frontend-design, Impeccable, web-design-guidelines on every touched file), gates, SUMMARY.
