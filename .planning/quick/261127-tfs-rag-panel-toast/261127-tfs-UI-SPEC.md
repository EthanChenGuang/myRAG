---
quick_id: 261127-tfs
type: ui-spec-amendment
amends:
  - .planning/phases/03.1.1-domain-embedding-model-candidates-and-per-doc-type-model-sel/03.1.1-UI-SPEC.md
  - .planning/phases/03.2-language-support-ingestion-hardening/03.2-UI-SPEC.md
  - .planning/phases/04-hybrid-retrieval-reranking-calibrated-refusal/04-UI-SPEC.md
  - .planning/phases/04.2-retrieval-tuning-additions/04.2-UI-SPEC.md
  - .planning/phases/05.3-evaluation-gates-and-online-monitoring/05.3-UI-SPEC.md
date: 2026-11-27
---

# UI-SPEC amendment: action results also shown as a toast (RAG administration panels)

## Why

Owner walkthrough: a panel's result ("Pattern … disabled.", "Defaults saved.", "Alert acknowledged.") is written only to the panel's
status region (`div.text-sm[role=status][aria-live=polite]`) at the bottom of the card, often off screen and far from the button that
was pressed. The owner did not see it and expected a toast. The earlier contract ("the result appears in the status region", e.g.
03.1.1 §"Action succeeded | status line", 04 and 04.2 and 05.3 "Status region" tables) is extended, not replaced.

## Rule

1. **Status region unchanged.** Every message still goes to the panel's status region with the same text, icon, `text-error` and
   focus behaviour. It stays the only live region, so each outcome is announced once.
2. **Completed action → also a toast.** When a write the admin started has finished and succeeded (saved, created, enabled, disabled,
   deleted, removed, added, acknowledged, resolved, activated, rolled back, rebuilt, run, imported, copied), the same sentence is also
   shown through the page's existing `showToast()` (`#toast`, DaisyUI `alert-success`, top end, about 3 seconds). The toast text is the
   status region's text after rendering, so the two never differ.
3. **Toast is `aria-hidden="true"`.** The toast is a visual echo only; screen readers already hear the status region. `showToast(message,
   type, { ariaHidden: true })` sets the attribute; any other `showToast` call removes it, so the page's other toasts behave as before.
4. **No toast for:** errors and refusals (unchanged: status region with `text-error`, alerts and notes as each panel's UI-SPEC says),
   loading lines, progress lines ("Building… 3 of 9"), list-loaded counts, dry-run or test results shown in the panel itself, an
   unconfirmed outcome (`error.unconfirmed`, `changeUnknown`) and a gate refusal returned with HTTP 200.
5. **No new copy.** The toast reuses the panel's existing localized sentence (en, zh, it); nothing new is translated.
6. **One helper.** `scripts/config-ui/rag-panels/panel-status.js` (`ragPanelSetStatus`), loaded right before `rag-fetch.js` (the rag-fetch, gates-ui, judge-calibration order stays as pinned); every RAG
   panel's `setStatus` goes through it. A panel loaded without it (unit harnesses) renders the status region only.

## Panels

chunking-profiles, doc-types, embedding-bindings, embedding-profiles, identifier-patterns, monitor, question-sources,
refusal-calibration, setting-check. embedding-profiles, refusal-calibration and setting-check write no success sentence today
(activation reloads the list; the others only load), so they are wired to the helper with no toast call site.

## Visual

No new component, colour or spacing: the existing `#toast` (`toast toast-top toast-end`, `z-index: 1100`, `alert alert-success`).
