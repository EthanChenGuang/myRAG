/**
 * Source sync admin panel (Phase 6.3) — plain-text DOM only.
 */

const SOURCE_SYNC_LABELS = { en: {}, zh: {}, it: {} };

function buildSourceSyncRowView() {
  return {};
}

function buildPausedRunView() {
  return {};
}

function mapSourceSyncError() {
  return {};
}

function sourceSyncSortRows(rows) {
  return rows;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SOURCE_SYNC_LABELS, buildSourceSyncRowView, buildPausedRunView, mapSourceSyncError, sourceSyncSortRows };
}
