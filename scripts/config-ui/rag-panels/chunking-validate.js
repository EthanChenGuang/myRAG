/**
 * Chunking profile rules for the Config UI: a plain-script copy of chunking_profile_findings (rag-sidecar contracts/retrieval.py) and
 * validateChunkingProfile (src/lib/rag/chunking/validate.ts), parity-tested against rag-sidecar/schemas/chunking-profile-cases.json.
 * A rule whose context value is missing is skipped, never guessed, exactly as in Pydantic; the panel passes no context, so the server's
 * validate route judges the two context rules.
 */

const CHUNKING_PRESETS = Object.freeze({
  '128/512': Object.freeze({ child_tokens: 128, parent_tokens: 512, parent_mode: 'structure' }),
  '256/1024': Object.freeze({ child_tokens: 256, parent_tokens: 1024, parent_mode: 'structure' }),
  '256/2048': Object.freeze({ child_tokens: 256, parent_tokens: 2048, parent_mode: 'structure' }),
});

const CHUNKING_PARENT_MODES = Object.freeze(['none', 'structure', 'fixed']);

function chunkingIsWholeSize(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function chunkingContextNumber(context, camelKey, snakeKey) {
  if (!context || typeof context !== 'object') return null;
  const value = context[camelKey] !== undefined ? context[camelKey] : context[snakeKey];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Hard errors and warnings for a chunking profile's sizes. Context: maxChildTokens, topK, contextBudget (the case table's snake_case
 * spelling is accepted too). Sizes that are not whole numbers of 1 or more, or an unknown parent mode, answer invalid_shape.
 */
function validateChunking(input, context) {
  const profile = input && typeof input === 'object' ? input : {};
  const child = profile.child_tokens;
  const parent = profile.parent_tokens === undefined ? null : profile.parent_tokens;
  const mode = profile.parent_mode;
  if (!chunkingIsWholeSize(child) || (parent !== null && !chunkingIsWholeSize(parent)) || !CHUNKING_PARENT_MODES.includes(mode)) {
    return { errors: ['invalid_shape'], warnings: [] };
  }

  const maxChild = chunkingContextNumber(context, 'maxChildTokens', 'max_child_tokens');
  const topK = chunkingContextNumber(context, 'topK', 'top_k');
  const budget = chunkingContextNumber(context, 'contextBudget', 'context_budget');
  const errors = [];
  const warnings = [];

  if (mode === 'fixed' && parent === null) errors.push('parent_tokens_required');
  if (maxChild !== null && child > maxChild) errors.push('child_exceeds_embedding_input');
  const parentTooSmall = parent !== null && parent < child * 2;
  if (parentTooSmall) errors.push('parent_below_twice_child');
  if (parent !== null && !parentTooSmall) {
    const ratio = parent / child;
    if (ratio < 4 || ratio > 8) warnings.push('ratio_outside_4_8');
  }
  if (parent !== null && topK !== null && budget !== null && topK * parent > budget) warnings.push('top_k_parent_over_budget');
  return { errors, warnings };
}

/** The sizes a preset fixes (structure parents), or the typed values for custom. */
function chunkingPresetSizes(preset, custom) {
  const fixed = Object.prototype.hasOwnProperty.call(CHUNKING_PRESETS, preset) ? CHUNKING_PRESETS[preset] : null;
  if (fixed) return { preset, child_tokens: fixed.child_tokens, parent_tokens: fixed.parent_tokens, parent_mode: fixed.parent_mode };
  const typed = custom && typeof custom === 'object' ? custom : {};
  return {
    preset: 'custom',
    child_tokens: typed.child_tokens === undefined ? null : typed.child_tokens,
    parent_tokens: typed.parent_tokens === undefined ? null : typed.parent_tokens,
    parent_mode: typed.parent_mode === undefined ? 'structure' : typed.parent_mode,
  };
}

if (typeof window !== 'undefined') {
  window.CHUNKING_PRESETS = CHUNKING_PRESETS;
  window.validateChunking = validateChunking;
  window.chunkingPresetSizes = chunkingPresetSizes;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CHUNKING_PRESETS, validateChunking, chunkingPresetSizes };
}
