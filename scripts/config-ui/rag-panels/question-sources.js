/**
 * Question sources panel (EVAL-27, EVAL-30, UI-SPEC 6.10). Stub: the implementation follows its tests.
 */

const QUESTION_SOURCES_LABELS = { en: {}, zh: {}, it: {} };

class QuestionSourcesPanel {
  constructor(root) {
    this.root = root;
  }

  async mount() {}
}

function initQuestionSourcesPanel() {}

function questionSourcesReadHeader() {
  return [];
}

function questionSourcesBatches() {
  return [];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { QUESTION_SOURCES_LABELS, QuestionSourcesPanel, initQuestionSourcesPanel, questionSourcesReadHeader, questionSourcesBatches };
}
