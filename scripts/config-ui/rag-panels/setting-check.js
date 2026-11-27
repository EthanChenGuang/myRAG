/**
 * Phase 5.3 pre-save setting check (UI-SPEC 6.3): state machine, dialog and the save guard window.ragSettingCheck.
 */

const SETTING_CHECK_LABELS = { en: {}, zh: {}, it: {} };

function settingCheckState() {
  return { titleKey: '', buttons: [], reasonField: false, autoSave: false, noteKey: null, focus: '' };
}

function settingCheckLabel() {
  return '';
}

function settingCheckDialogView() {
  return { titleKey: '', title: '', lead: { key: '', text: '', segments: [] }, changed: { heading: '', rows: [], more: null }, layers: [], evidence: { visible: [], hidden: [] }, notCovered: null, untested: null, uncal: null, modeNote: null };
}

function settingCheckReason() {
  return { value: '', length: 0, valid: false, missing: 0, tooShort: null };
}

function settingCheckSaveBody() {
  return {};
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SETTING_CHECK_LABELS, settingCheckLabel, settingCheckState, settingCheckDialogView, settingCheckReason, settingCheckSaveBody };
}
