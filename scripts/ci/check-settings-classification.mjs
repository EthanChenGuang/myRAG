import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Phase 3.2 D-09: every RAG_* variable of the env manifest is classified once as ingestion-side, query-side or both, and every
// ingestion-side entry names the mechanism that rebuilds stored documents. Mirrors the Pydantic SettingsClassification rules.

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const MANIFEST_FILE = 'scripts/rag/env-manifest.json';
export const CLASSIFICATION_FILE = 'config/rag/settings-classification.json';
export const SIDES = new Set(['ingestion', 'query', 'both']);
export const MECHANISMS = new Set(['reparse', 'rechunk', 'relex', 'reembed', 'recaption', 'retranslate', 'rescan']);
const NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/;

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

export function manifestRagNames(manifest) {
  if (!Array.isArray(manifest?.vars)) throw new Error(`${MANIFEST_FILE}: "vars" must be an array`);
  return manifest.vars.map((v) => v?.name).filter((name) => typeof name === 'string' && name.startsWith('RAG_'));
}

export function classificationProblems(classification, ragNames) {
  const problems = [];
  if (classification?.schema_version !== 1) problems.push('schema_version must be 1');
  const entries = Array.isArray(classification?.entries) ? classification.entries : null;
  if (!entries) return [...problems, '"entries" must be an array'];

  const seen = new Set();
  for (const [i, entry] of entries.entries()) {
    const name = typeof entry?.name === 'string' ? entry.name : null;
    const label = name ?? `entry ${i}`;
    if (name === null || !NAME_RE.test(name)) {
      problems.push(`${label}: name must be an upper-case variable name`);
      continue;
    }
    const extra = Object.keys(entry).filter((key) => !['name', 'side', 'mechanism'].includes(key));
    if (extra.length > 0) problems.push(`${label}: unknown field(s) ${extra.join(', ')}`);
    if (seen.has(name)) problems.push(`${label}: listed twice`);
    seen.add(name);
    if (!SIDES.has(entry.side)) {
      problems.push(`${label}: side must be ingestion, query or both`);
      continue;
    }
    const hasMechanism = Object.prototype.hasOwnProperty.call(entry, 'mechanism');
    if (entry.side === 'query') {
      if (hasMechanism) problems.push(`${label}: a query entry names no mechanism`);
    } else if (!hasMechanism) {
      problems.push(`${label}: an ${entry.side} entry needs a mechanism (${[...MECHANISMS].join(', ')})`);
    } else if (!MECHANISMS.has(entry.mechanism)) {
      problems.push(`${label}: mechanism must be one of ${[...MECHANISMS].join(', ')}`);
    }
  }

  const names = entries.map((entry) => entry?.name).filter((name) => typeof name === 'string');
  const sorted = [...names].sort();
  if (names.some((name, i) => name !== sorted[i])) problems.push('entries must be sorted by name');

  const manifest = new Set(ragNames);
  for (const name of [...manifest].sort()) {
    if (!seen.has(name)) problems.push(`${name}: no classification; add it to ${CLASSIFICATION_FILE} as ingestion (with a mechanism), query or both`);
  }
  for (const name of [...seen].sort()) {
    if (!manifest.has(name)) problems.push(`${name}: classified but not in ${MANIFEST_FILE}`);
  }
  return problems;
}

export function checkSettingsClassification(root = DEFAULT_ROOT) {
  const ragNames = manifestRagNames(readJson(root, MANIFEST_FILE));
  const problems = classificationProblems(readJson(root, CLASSIFICATION_FILE), ragNames);
  return { classified: ragNames.length, problems };
}

function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = path.resolve(argv[++i] ?? '');
  }
  return args;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = checkSettingsClassification(root);
  } catch (error) {
    console.error(`[check-settings-classification] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  for (const problem of result.problems) console.error(`${CLASSIFICATION_FILE}: ${problem}`);
  if (result.problems.length > 0) {
    console.error(`[check-settings-classification] ${result.problems.length} problem(s)`);
    return 1;
  }
  console.log(`[check-settings-classification] ok: ${result.classified} RAG_* variable(s) classified`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
