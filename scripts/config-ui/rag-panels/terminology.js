/** Terminology panel (stub for the failing tests). */
const TERMINOLOGY_LABELS = { en: {}, zh: {}, it: {} };
function buildEntryView() { return {}; }
function buildEntryForm() { return { fields: [] }; }
function buildIssueList() { return []; }
function buildImportReport() { return { counts: [], issues: [], blocking: false }; }
function buildCandidateView() { return {}; }
function candidateDraft() { return {}; }
function initTerminologyPanel() { return null; }
// enabled_languages
if (typeof window !== 'undefined') window.initTerminologyPanel = initTerminologyPanel;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TERMINOLOGY_LABELS, buildEntryView, buildEntryForm, buildIssueList, buildImportReport, buildCandidateView, candidateDraft, initTerminologyPanel };
}
