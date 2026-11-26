/**
 * Feedback loop admin card (Phase 5.1.1, UI-SPEC 6.7). Stub; the card is built in the next commit.
 */

const REVIEW_ADMIN_LABELS = { en: {}, zh: {}, it: {} };

function initReviewAdminPanel() {
  return Promise.resolve(null);
}

if (typeof window !== 'undefined') {
  window.initReviewAdminPanel = initReviewAdminPanel;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { REVIEW_ADMIN_LABELS, initReviewAdminPanel };
}
