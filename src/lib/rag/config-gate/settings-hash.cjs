'use strict';

// Phase 5.3 D-12: rag_settings_hash, shared by scripts/config-server.js and the app.
// Secrets enter as set or unset, the three prompt variables as their own sha256, so the
// hash input holds no secret value and no prompt text. Not the same as retrieval_config_hash.

const crypto = require('node:crypto');
const { isSecretName } = require('./secret-name.cjs');

const HASHED_TEXT_NAMES = new Set(['RAG_SYSTEM_PROMPT', 'RAG_PRE_CONTEXT', 'RAG_POST_CONTEXT']);

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function valueOf(values, name) {
  const value = values && Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
  return value === undefined || value === null ? '' : String(value);
}

function sortedNames(names) {
  return [...new Set(names)].sort();
}

function ragSettingsCanonical(values, names, isSecret = isSecretName) {
  const pairs = {};
  for (const name of sortedNames(names)) {
    const value = valueOf(values, name);
    if (isSecret(name)) pairs[name] = value === '' ? 'unset' : 'set';
    else if (HASHED_TEXT_NAMES.has(name)) pairs[name] = sha256(value);
    else pairs[name] = value;
  }
  return JSON.stringify(pairs);
}

function ragSettingsHash(values, names, isSecret = isSecretName) {
  return sha256(ragSettingsCanonical(values, names, isSecret));
}

function ragAffectingDiff(before, after, names) {
  return sortedNames(names).filter((name) => valueOf(before, name) !== valueOf(after, name));
}

module.exports = { HASHED_TEXT_NAMES, ragSettingsCanonical, ragSettingsHash, ragAffectingDiff };
