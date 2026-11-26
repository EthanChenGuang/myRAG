/** Shared helpers of the Phase 5.3 Config UI panels (stub, filled in by the next commit). */
const GATES_UI_LABELS = { en: {}, zh: {}, it: {} };
const GATES_UI_STUB_NAMES = ['gatesUiLocale', 'gatesUiLabel', 'gatesUiMessage', 'gatesUiPercent', 'gatesUiRate', 'gatesUiScore', 'gatesUiDate', 'gatesUiVerdictView', 'gatesUiVerdict', 'gatesUiEvidenceRows', 'gatesUiEvidenceTable', 'gatesUiShareBar', 'gatesUiSubTabs', 'gatesUiConfirm', 'gatesUiMapError', 'gatesUiFetch', 'gatesUiMessageEl', 'gatesUiSetBusy'];
if (typeof module !== 'undefined' && module.exports) {
  const stub = { GATES_UI_LABELS };
  for (const name of GATES_UI_STUB_NAMES) stub[name] = () => ({ key: '', classes: '', icon: '', known: false, text: '', segments: [], kind: '', visible: [], hidden: [], root: { getAttribute: () => null, dispatch: () => {} }, tabs: [], panels: [], querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null, firstElementChild: { style: {} }, childNodes: [] });
  module.exports = stub;
}
