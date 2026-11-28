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

// D-04 completeness parts, in the order src/lib/rag/lang/registry.ts COMPLETENESS_PARTS lists them.
function packIsComplete(pack) {
  const ocr = pack.ocr_codes || {};
  const texts = pack.texts || {};
  const fixtures = pack.fixtures || {};
  return (
    pack.segmentation != null &&
    ocr.docling != null &&
    ocr.llamaparse != null &&
    pack.rewrite_gate_lexicon != null &&
    texts.strict_refusal != null &&
    fixtures.corpus === true &&
    fixtures.golden_slices === true
  );
}

function registryPacks(registry) {
  if (!registry || !Array.isArray(registry.packs)) {
    throw new TypeError('validate-language-settings: context.registry with packs is required');
  }
  return registry.packs;
}

function declaredSet(declaration) {
  return new Set(parseLanguageList(Array.isArray(declaration.supportedLanguages) ? declaration.supportedLanguages : []));
}

function compareCodePoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * D-07. Refuses with reasons and never repairs the choice: nothing is dropped, replaced or mapped.
 * Errors come in a fixed kind order, and inside one kind in registry order (unknown codes by code point).
 */
function validateLanguageSettings(candidate, context) {
  const packs = registryPacks(context && context.registry);
  const byCode = new Map(packs.map((pack) => [pack.code, pack]));
  const input = candidate || {};
  const chosen = parseLanguageList(input.supported);
  const primary = normalizeCode(input.primary);
  const languages = packs.map((pack) => pack.code).filter((code) => chosen.includes(code));
  const unknown = chosen.filter((code) => !byCode.has(code)).sort(compareCodePoints);
  const reranker = (context && context.reranker) || null;
  const embeddingProfile = (context && context.embeddingProfile) || null;

  const errors = [];
  if (chosen.length === 0) errors.push({ code: 'empty_set' });
  for (const language of unknown) errors.push({ code: 'unknown_language', language });
  if (primary === '') errors.push({ code: 'primary_not_in_set' });
  else if (!chosen.includes(primary)) errors.push({ code: 'primary_not_in_set', language: primary });
  for (const language of languages) {
    if (!packIsComplete(byCode.get(language))) errors.push({ code: 'incomplete_pack', language });
  }
  if (embeddingProfile) {
    const declared = declaredSet(embeddingProfile);
    for (const language of languages) {
      if (!declared.has(language)) {
        errors.push({ code: 'embedding_profile_unsupported', language, id: String(embeddingProfile.id) });
      }
    }
  }
  if (reranker) {
    const declared = declaredSet(reranker);
    for (const language of languages) {
      if (!declared.has(language)) errors.push({ code: 'reranker_unsupported', language, id: String(reranker.id) });
    }
  }

  const warnings = languages
    .filter((code) => byCode.get(code).groundedness === 'none')
    .map((language) => ({ code: 'groundedness_not_checked', language }));

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    verifiedAgainstActiveProfile: embeddingProfile !== null,
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
