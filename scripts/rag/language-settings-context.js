'use strict';

// Phase 3.2 D-07/D-08: the validation context shared by the two script entry points (scripts/init-env.js and
// scripts/config-server.js). The app builds the same context in src/lib/rag/lang/settings.ts;
// tests/rag/lang-validate-entrypoints.test.ts keeps the reranker table below equal to the app adapters.

const fs = require('fs');
const path = require('path');
const {
  normalizeLanguageSettings,
  parseLanguageList,
  validateLanguageSettings,
} = require('../../config/rag/validate-language-settings.cjs');

const LANGUAGE_VARIABLES = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'];
const PIPELINE_VARIABLES = ['RAG_PIPELINE', 'RAG_INGEST_PIPELINE'];

/** Which packs each reranker declares, as a registry rule (src/lib/rag/rerank/languages.ts). */
const RERANKER_DECLARATION_RULES = Object.freeze({
  cohere: 'golden_slices',
  voyage: 'golden_slices',
  local_bm25: 'segmentation',
});
const RERANK_PROVIDER_IDS = Object.freeze(Object.keys(RERANKER_DECLARATION_RULES));

/** The model of the legacy profile (src/lib/rag/embeddings/active-profile.ts LEGACY_PROFILE), used without a database. */
const DEFAULT_EMBEDDING_PROFILE = Object.freeze({
  id: 'openai-3-small-1536',
  provider: 'openai',
  model: 'text-embedding-3-small',
});

function registryPath(root) {
  return path.join(root, 'config', 'rag', 'language-packs.json');
}

function embeddingDeclarationsPath(root) {
  return path.join(root, 'config', 'rag', 'embedding-model-languages.json');
}

function readRegistry(root) {
  return JSON.parse(fs.readFileSync(registryPath(root), 'utf8'));
}

/** The RAG_RERANKER value as loadRagConfig reads it; null for none or an unsupported value. */
function parseRerankerId(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  return RERANK_PROVIDER_IDS.includes(value) ? value : null;
}

function declaredByRule(rule, registry) {
  const packs = Array.isArray(registry && registry.packs) ? registry.packs : [];
  if (rule === 'segmentation') return packs.filter((pack) => pack.segmentation != null).map((pack) => pack.code);
  return packs.filter((pack) => pack.fixtures && pack.fixtures.golden_slices === true).map((pack) => pack.code);
}

/** { id, supportedLanguages } for the reranker RAG_RERANKER selects, or null (no reranker rule). */
function rerankerDeclaration(raw, registry, overrides) {
  const id = parseRerankerId(raw);
  if (id === null) return null;
  const override = overrides && Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : null;
  return { id, supportedLanguages: override ? [...override] : declaredByRule(RERANKER_DECLARATION_RULES[id], registry) };
}

function entryLanguages(entry) {
  if (Array.isArray(entry)) return entry;
  if (!entry || typeof entry !== 'object') return null;
  for (const key of ['supported_languages', 'supportedLanguages', 'languages']) {
    if (Array.isArray(entry[key])) return entry[key];
  }
  return null;
}

function findModelLanguages(file, provider, model) {
  const models = file.models;
  if (Array.isArray(models)) {
    const entry = models.find((candidate) => candidate && candidate.provider === provider && candidate.model === model);
    return entry ? entryLanguages(entry) : null;
  }
  if (models && typeof models === 'object') {
    for (const key of [`${provider}/${model}`, `${provider}:${model}`]) {
      if (Object.prototype.hasOwnProperty.call(models, key)) return entryLanguages(models[key]);
    }
    const byProvider = models[provider];
    if (byProvider && typeof byProvider === 'object' && !Array.isArray(byProvider) && byProvider[model]) {
      return entryLanguages(byProvider[model]);
    }
  }
  return null;
}

/**
 * The default profile's declaration from config/rag/embedding-model-languages.json (Phase 3.2.1, plan 03.2.1-01),
 * or null while the file is absent. A profile whose model the file does not list declares no language.
 */
function defaultEmbeddingDeclaration(root) {
  const file = embeddingDeclarationsPath(root);
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const named = data && typeof data.default_profile === 'object' && data.default_profile ? data.default_profile : {};
  const profile = {
    id: typeof named.id === 'string' && named.id !== '' ? named.id : DEFAULT_EMBEDDING_PROFILE.id,
    provider: typeof named.provider === 'string' && named.provider !== '' ? named.provider : DEFAULT_EMBEDDING_PROFILE.provider,
    model: typeof named.model === 'string' && named.model !== '' ? named.model : DEFAULT_EMBEDDING_PROFILE.model,
  };
  const languages = entryLanguages(named) || findModelLanguages(data, profile.provider, profile.model) || [];
  return { id: profile.id, supportedLanguages: parseLanguageList(languages) };
}

/** Registry, active reranker and (when declared) the default embedding profile for one validation. */
function buildValidationContext({ root, env, rerankerOverrides, registry } = {}) {
  const values = env || {};
  const packs = registry || readRegistry(root);
  return {
    registry: packs,
    reranker: rerankerDeclaration(values.RAG_RERANKER, packs, rerankerOverrides),
    embeddingProfile: defaultEmbeddingDeclaration(root),
  };
}

/** Packs that pass the completeness rule, in registry order (D-08 lists only these). */
function completePacks(registry) {
  return registry.packs.filter((pack) => {
    const result = validateLanguageSettings({ supported: pack.code, primary: pack.code }, { registry });
    return !result.errors.some((error) => error.code === 'incomplete_pack');
  });
}

/** Why a complete pack cannot be chosen under this context: the reranker or the profile does not declare it. */
function packBlockingReasons(code, context) {
  const reasons = [];
  if (context.embeddingProfile && !parseLanguageList(context.embeddingProfile.supportedLanguages).includes(code)) {
    reasons.push({ code: 'embedding_profile_unsupported', id: String(context.embeddingProfile.id) });
  }
  if (context.reranker && !parseLanguageList(context.reranker.supportedLanguages).includes(code)) {
    reasons.push({ code: 'reranker_unsupported', id: String(context.reranker.id) });
  }
  return reasons;
}

/**
 * D-07 for a script entry point. Neither script reads the active profile pointer (init-env has no database, the config
 * server does not query it), so the embedding check, when it runs, is against the default profile and is never
 * reported as verified against the active profile.
 */
function validateForScript(candidate, context) {
  const result = validateLanguageSettings(candidate, context);
  return { ...result, verifiedAgainstActiveProfile: false };
}

function isSet(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function readEnvFileValues(envPath) {
  if (!fs.existsSync(envPath)) return {};
  return require('dotenv').parse(fs.readFileSync(envPath, 'utf8'));
}

const VARIABLE_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Writes the two language variables from a validated result, one line each, in registry order. The file is written to
 * a temp file and renamed over .env.local, so a reader never sees half a file and two saves never mix their values.
 */
function writeLanguageVariables(envPath, normalized) {
  if (!normalized || !Array.isArray(normalized.languages) || normalized.languages.length === 0) {
    throw new TypeError('writeLanguageVariables: a validated result is required');
  }
  const values = { RAG_SUPPORTED_LANGUAGES: normalized.languages.join(','), RAG_PRIMARY_LANGUAGE: normalized.primary };
  const exists = fs.existsSync(envPath);
  const content = exists ? fs.readFileSync(envPath, 'utf8') : '';
  const mode = exists ? fs.statSync(envPath).mode & 0o777 : 0o600;
  const lines = content === '' ? [] : content.split('\n');
  const written = new Set();
  const out = [];
  for (const line of lines) {
    const match = VARIABLE_LINE.exec(line);
    const name = match ? match[1] : null;
    if (name && LANGUAGE_VARIABLES.includes(name)) {
      if (!written.has(name)) {
        out.push(`${name}=${values[name]}`);
        written.add(name);
      }
      continue;
    }
    out.push(line);
  }
  const missing = LANGUAGE_VARIABLES.filter((name) => !written.has(name)).map((name) => `${name}=${values[name]}`);
  if (missing.length > 0) {
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    out.push(...missing, '');
  }
  const temp = path.join(path.dirname(envPath), `.env.local.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temp, out.join('\n'), { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, envPath);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // already gone
    }
    throw error;
  }
  return values;
}

module.exports = {
  DEFAULT_EMBEDDING_PROFILE,
  LANGUAGE_VARIABLES,
  PIPELINE_VARIABLES,
  RERANKER_DECLARATION_RULES,
  RERANK_PROVIDER_IDS,
  buildValidationContext,
  completePacks,
  defaultEmbeddingDeclaration,
  isSet,
  normalizeLanguageSettings,
  packBlockingReasons,
  parseRerankerId,
  readEnvFileValues,
  readRegistry,
  rerankerDeclaration,
  validateForScript,
  validateLanguageSettings,
  writeLanguageVariables,
};
