/**
 * Chunking profile rules for the Config UI (RED stub).
 */

const CHUNKING_PRESETS = {};

function validateChunking(_input, _context) {
  return { errors: [], warnings: [] };
}

function chunkingPresetSizes(_preset, _custom) {
  return null;
}

if (typeof window !== 'undefined') {
  window.validateChunking = validateChunking;
  window.chunkingPresetSizes = chunkingPresetSizes;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CHUNKING_PRESETS, validateChunking, chunkingPresetSizes };
}
