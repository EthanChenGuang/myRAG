'use strict';

// Phase 3.2 D-01/D-07: the one validator for a supported-language set, shared by the app,
// scripts/init-env.js and scripts/config-server.js. No dependency, no file read: the caller
// passes the registry. Lives outside scripts/ because .vercelignore drops scripts/.

const ASCII_UPPER = /[A-Z]/g;

function normalizeCode(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(ASCII_UPPER, (ch) => ch.toLowerCase());
}

function parseLanguageList(raw) {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const seen = [];
  for (const part of parts) {
    const code = normalizeCode(part);
    if (code !== '' && !seen.includes(code)) seen.push(code);
  }
  return seen;
}

function registryCodes(registry) {
  if (!registry || !Array.isArray(registry.packs)) {
    throw new TypeError('validate-language-settings: context.registry with packs is required');
  }
  return registry.packs.map((pack) => pack.code);
}

function validateLanguageSettings(candidate, context) {
  const codes = registryCodes(context && context.registry);
  const input = candidate || {};
  const chosen = parseLanguageList(input.supported);
  const primary = normalizeCode(input.primary);
  const languages = codes.filter((code) => chosen.includes(code));

  const errors = [];
  if (chosen.length === 0) errors.push({ code: 'empty_set' });
  if (primary === '') errors.push({ code: 'primary_not_in_set' });
  else if (!chosen.includes(primary)) errors.push({ code: 'primary_not_in_set', language: primary });

  const packs = new Map(context.registry.packs.map((pack) => [pack.code, pack]));
  const warnings = languages
    .filter((code) => packs.get(code).groundedness === 'none')
    .map((language) => ({ code: 'groundedness_not_checked', language }));

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    verifiedAgainstActiveProfile: false,
    normalized: ok ? { languages, primary, supported: languages.join(',') } : null,
  };
}

function normalizeLanguageSettings(rawSupported, rawPrimary, registry) {
  const result = validateLanguageSettings({ supported: rawSupported, primary: rawPrimary }, { registry });
  if (!result.normalized) return { configured: false, languages: [], primary: null, monolingual: false };
  const { languages, primary } = result.normalized;
  return { configured: true, languages, primary, monolingual: languages.length === 1 };
}

module.exports = { parseLanguageList, normalizeLanguageSettings, validateLanguageSettings };
