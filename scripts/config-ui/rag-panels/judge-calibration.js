/** Judge calibration panel (stub, filled in by the next commit). */
const JUDGE_CAL_LABELS = { en: {}, zh: {}, it: {} };
class JudgeCalPanel {
  async mount() {}
  async load() {}
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { JUDGE_CAL_LABELS, judgeCalLabel: () => '', judgeCalRows: () => [], judgeCalWarningView: () => ({}), JudgeCalPanel, initJudgeCalPanel: () => {} };
}
