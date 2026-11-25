/**
 * Chunking profiles admin panel (RED stub).
 */

const CHUNKING_LABELS = { en: {}, zh: {}, it: {} };
const CHUNKING_DOC_TYPE_ORDER = [];

function chunkingLabel(key) {
  return key;
}

function profilesByDocType() {
  return [];
}

function coverageWarning() {
  return null;
}

function chunkingRefusalMessage(reason) {
  return { key: reason, text: reason, segments: [] };
}

function reportRows() {
  return [];
}

function chunkingReportSlices() {
  return [];
}

function chunkingDecisionRows() {
  return [];
}

function chunkingFormFindings() {
  return { body: null, fieldErrors: {}, errors: [], warnings: [], blocking: false };
}

function chunkingSuggestedId() {
  return '';
}

function mapChunkingError() {
  return { key: '', text: '', segments: [] };
}

async function runChunkingBuild() {
  return { outcome: '', last: null };
}

class ChunkingProfilesPanel {
  constructor(root) {
    this.root = root;
  }

  async mount() {}

  selectTab() {}
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CHUNKING_LABELS,
    CHUNKING_DOC_TYPE_ORDER,
    chunkingLabel,
    profilesByDocType,
    coverageWarning,
    refusalMessage: chunkingRefusalMessage,
    reportRows,
    chunkingReportSlices,
    chunkingDecisionRows,
    chunkingFormFindings,
    chunkingSuggestedId,
    mapChunkingError,
    runChunkingBuild,
    ChunkingProfilesPanel,
  };
}
