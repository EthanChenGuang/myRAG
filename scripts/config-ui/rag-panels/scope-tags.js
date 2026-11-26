/** Document tags panel (UI-SPEC 6.7, 6.11). Stub: filled in by the GREEN commit. */
const SCOPE_TAGS_LABELS = { en: {}, zh: {}, it: {} };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCOPE_TAGS_LABELS,
    scopeTagsSlugFromLabel: () => '',
    scopeTagsValueValid: () => false,
    scopeTagsAliases: () => [],
    scopeTagsVocabularyView: () => ({ total: 0, dimensions: [] }),
    scopeTagsDocumentsView: () => ({ total: 0, suggestedTotal: 0, rows: [] }),
    scopeTagsSettingsWarnings: () => [],
    scopeTagsUploadOptions: () => ({ tags: { enabled: false, dimensions: [] }, replaces: { enabled: false, confirmedAtOnce: false } }),
    scopeTagsAppendUploadFields: () => {},
    scopeTagsUploadErrorText: () => null,
  };
}

if (typeof window !== 'undefined') {
  window.initScopeTagsPanel = async () => null;
  window.scopeTagsMountQueueControls = () => {};
}
