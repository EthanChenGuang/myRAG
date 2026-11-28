'use strict';

// Phase 7 LANG-11: the rules for adding and removing a supported language, shared by `npm run rag:languages`
// (src/lib/rag/lang/change-plan.ts) and the config server's POST /api/config/languages. No file read here: the caller
// passes the registry, the declarations and a baseline check. The validator's ordered error list is kept as it is, and
// language_baseline_missing is appended after it.

const { parseLanguageList, validateLanguageSettings } = require('./validate-language-settings.cjs');

const BASELINE_DIR = 'eval/baselines/languages';
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

function baselineCommand(code) {
  return `npm run rag:languages -- baseline ${code}`;
}

/** The repository-relative path of a language's baseline record; null for a value that is not a language code. */
function baselineRelativePath(code) {
  return typeof code === 'string' && LANGUAGE_CODE.test(code) ? `${BASELINE_DIR}/${code}.json` : null;
}

function inRegistryOrder(codes, registry) {
  const set = new Set(codes);
  const known = registry.packs.map((pack) => pack.code).filter((code) => set.has(code));
  const unknown = codes.filter((code) => !known.includes(code));
  return [...known, ...unknown];
}

/**
 * LANG-11. input: { current, proposed, primary }. context: the validator context plus hasBaseline(code).
 * An addition needs a complete pack with a golden slice and a supporting profile (the validator's incomplete_pack and
 * embedding_profile_unsupported) and a recorded baseline (language_baseline_missing). A removal is query-side only:
 * nothing is rebuilt or deleted. Any refusal returns no step, so nothing is changed.
 */
function planLanguageChange(input, context) {
  const registry = context && context.registry;
  if (!registry || !Array.isArray(registry.packs)) throw new TypeError('planLanguageChange: context.registry with packs is required');
  const hasBaseline = context && typeof context.hasBaseline === 'function' ? context.hasBaseline : () => false;
  const current = parseLanguageList((input && input.current) || []);
  const proposed = parseLanguageList((input && input.proposed) || []);
  const primary = input && typeof input.primary === 'string' && input.primary.trim() !== '' ? input.primary : null;
  const added = inRegistryOrder(proposed.filter((code) => !current.includes(code)), registry);
  const removed = inRegistryOrder(current.filter((code) => !proposed.includes(code)), registry);

  const validation = validateLanguageSettings({ supported: proposed, primary }, context);
  const refusals = [...validation.errors];
  const knownCodes = new Set(registry.packs.map((pack) => pack.code));
  for (const language of added) {
    if (knownCodes.has(language) && !hasBaseline(language)) {
      refusals.push({ code: 'language_baseline_missing', language, command: baselineCommand(language) });
    }
  }

  const ok = refusals.length === 0;
  const steps = [];
  const notes = [];
  if (ok) {
    if (added.length > 0) steps.push({ kind: 'baseline', languages: added, state: 'recorded' });
    if (added.length > 0 || removed.length > 0) steps.push({ kind: 'save' });
    if (added.length > 0) steps.push({ kind: 'rebuild', selection: 'language_add', mechanism: 'reparse' });
    for (const language of removed) notes.push({ code: 'removed_documents_stay_searchable', language });
  }
  return {
    ok,
    added,
    removed,
    refusals,
    warnings: validation.warnings,
    normalized: ok ? validation.normalized : null,
    steps,
    notes,
    rebuild: ok && added.length > 0 ? { selection: 'language_add', mechanism: 'reparse' } : null,
  };
}

module.exports = { BASELINE_DIR, baselineCommand, baselineRelativePath, planLanguageChange };
