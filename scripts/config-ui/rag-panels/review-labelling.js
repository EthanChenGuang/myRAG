/**
 * Review queue panel (Phase 5.1.1, UI-SPEC 6.6). Placeholder until the panel is built.
 */

const REVIEW_LABELLING_LABELS = { en: {}, zh: {}, it: {} };

async function initReviewLabellingPanel() {
  return null;
}

if (typeof window !== 'undefined') {
  window.initReviewLabellingPanel = initReviewLabellingPanel;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { REVIEW_LABELLING_LABELS, initReviewLabellingPanel };
}
