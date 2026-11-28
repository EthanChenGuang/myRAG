/**
 * Purge dialog, purge receipt and Purge records panel (Phase 6.3) — stub until 06.3-22 lands.
 */

const PURGE_LABELS = { en: {}, zh: {}, it: {} };

function buildPurgeReceiptView() {
  return { rows: [] };
}

function buildPurgeRecordView() {
  return {};
}

function mapPurgeError() {
  return { message: '' };
}

function openPurgeDialog() {}

function initPurgePanel() {}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PURGE_LABELS, buildPurgeReceiptView, buildPurgeRecordView, mapPurgeError, openPurgeDialog, initPurgePanel };
}
