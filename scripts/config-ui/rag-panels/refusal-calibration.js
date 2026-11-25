/**
 * Refusal calibration status panel (RED stub).
 */

const REFUSAL_LABELS = { en: {}, zh: {}, it: {} };

function refusalLabel(key) {
  return key;
}

function cellRows() {
  return [];
}

function refusalWarningView(warning) {
  return { key: '', code: String(warning && warning.code), tone: '', icon: '', text: '', segments: [], missing: [] };
}

function refusalSummary() {
  return { notes: [], models: null, items: [] };
}

function mapRefusalError() {
  return { key: '', text: '', segments: [] };
}

class RefusalCalibrationPanel {
  constructor(root) {
    this.root = root;
  }

  async mount() {}
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { REFUSAL_LABELS, refusalLabel, cellRows, refusalWarningView, refusalSummary, mapRefusalError, RefusalCalibrationPanel };
}
