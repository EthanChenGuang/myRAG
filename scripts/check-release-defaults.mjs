import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RECORD_PATH = 'eval/config/release-defaults.json';
const DFLT_DECISION_PATH = 'eval/decisions/04.1-retrieval-defaults.json';
const FIXTURES_MD = 'eval/decisions/defaults-fixtures.md';
const MANIFEST_PATH = 'scripts/rag/env-manifest.json';
const INIT_ENV_PATH = 'scripts/init-env.js';
const ENV_TS_PATH = 'src/lib/env.ts';
const CONFIG_SERVER_PATH = 'scripts/config-server.js';
const EVAL_PIN_PATH = 'eval/config/rag-eval-env.json';
const RAG_CONFIG_PATH = 'src/lib/rag/config.ts';

/** 04.1 D-20: the five retrieval-default (DFLT) variables the Phase 4.1 decision owns. */
export const DFLT_NAMES = ['RAG_PIPELINE', 'RAG_LEXICAL_SEARCH', 'RAG_RERANKER', 'RAG_REFUSAL_THRESHOLD', 'RAG_REFUSAL_FLOOR'];
/** The Phase 4 values those five keep while the 04.1 decision is not_flipped (04.1-09 closed without a flip). */
export const PHASE4_RETRIEVAL_DEFAULTS = {
  RAG_PIPELINE: 'legacy',
  RAG_LEXICAL_SEARCH: 'false',
  RAG_RERANKER: 'none',
  RAG_REFUSAL_THRESHOLD: 'false',
  RAG_REFUSAL_FLOOR: 'similarity',
};
const TEMPLATE_LOCATIONS = ['init-env', 'config-server:create', 'config-server:standard', 'config-server:full', 'manifest', 'eval-pin'];
const ADM02_BLOCKS = ['cost', 'latency', 'per_language'];

/** The one-line `NAME=value` rule of derivePinnedEvalEnv (eval/harness/eval-env.mts). */
export function parseInitEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^(RAG_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim();
    if (value.includes('${')) continue;
    out[match[1]] = value;
  }
  return out;
}

function skipQuoted(text, i, quote) {
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === '\\') j += 1;
    else if (text[j] === quote) return j + 1;
  }
  return text.length;
}

function skipExpression(text, i) {
  let depth = 1;
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === "'" || c === '"') j = skipQuoted(text, j, c);
    else if (c === '`') j = templateEnd(text, j + 1) + 1;
    else if (c === '{') {
      depth += 1;
      j += 1;
    } else if (c === '}') {
      depth -= 1;
      j += 1;
      if (depth === 0) return j;
    } else j += 1;
  }
  return text.length;
}

/** Index of the closing backtick of a template literal whose body starts at `i`. */
function templateEnd(text, i) {
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') j += 2;
    else if (c === '`') return j;
    else if (c === '$' && text[j + 1] === '{') j = skipExpression(text, j + 2);
    else j += 1;
  }
  return text.length;
}

function templateAfter(text, anchor, opener) {
  const at = text.indexOf(anchor);
  if (at < 0) return null;
  const open = text.indexOf(opener, at);
  if (open < 0) return null;
  const start = open + opener.length;
  return text.slice(start, templateEnd(text, start));
}

/** D-18: the three .env.local templates of the Config UI server. */
function configServerTemplates(text) {
  return {
    'config-server:create': templateAfter(text, 'const newContent = `', 'const newContent = `'),
    'config-server:standard': templateAfter(text, 'function getStandardTemplate()', 'return `'),
    'config-server:full': templateAfter(text, 'function getFullTemplate()', 'return `'),
  };
}

function templateValue(segment, name) {
  if (segment === null) return null;
  const patterns = [
    new RegExp(`:\\s*'${name}=([^'\\n]*)'`),
    new RegExp(`(?<![A-Z0-9_])${name}=\\$\\{getEnvValue\\('${name}'\\)\\s*\\|\\|\\s*'([^'\\n]*)'\\}`),
    new RegExp(`(?<![A-Z0-9_])${name}=\\$\\{getEnvValue\\('${name}'\\)\\}()`),
  ];
  for (const re of patterns) {
    const match = segment.match(re);
    if (match) return match[1].trim();
  }
  const line = segment.match(new RegExp(`^${name}=(.*)$`, 'm'));
  if (line && !line[1].includes('${')) return line[1].trim();
  return null;
}

function envTsValue(text, name) {
  const match = text.match(new RegExp(`(?<![A-Z0-9_])${name}:\\s*process\\.env\\.${name}\\s*(?:\\|\\||\\?\\?)\\s*(['"])(.*?)\\1`));
  return match ? match[2] : null;
}

function readText(root, rel) {
  const full = path.join(root, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

function readJson(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return { missing: true };
  try {
    return { value: JSON.parse(fs.readFileSync(full, 'utf8')) };
  } catch (error) {
    return { invalid: error.message };
  }
}

/** The shipped default of each name in every D-18 location; null where a location does not carry the name. */
export function readShippedDefaults(root, names) {
  const initEnv = parseInitEnv(readText(root, INIT_ENV_PATH));
  const envTs = readText(root, ENV_TS_PATH);
  const templates = configServerTemplates(readText(root, CONFIG_SERVER_PATH));
  const manifest = readJson(root, MANIFEST_PATH).value;
  const byName = new Map((Array.isArray(manifest?.vars) ? manifest.vars : []).filter((v) => v && typeof v.name === 'string').map((v) => [v.name, v]));
  const pin = readJson(root, EVAL_PIN_PATH).value ?? {};
  const pipelineMatch = readText(root, RAG_CONFIG_PATH).match(/export const DEFAULT_PIPELINE\b[^=]*=\s*'([^']*)'/);
  const out = {};
  for (const name of names) {
    const entry = byName.get(name);
    const locations = {
      'config-server:create': templateValue(templates['config-server:create'], name),
      'config-server:full': templateValue(templates['config-server:full'], name),
      'config-server:standard': templateValue(templates['config-server:standard'], name),
      'env-ts': envTsValue(envTs, name),
      'eval-pin': typeof pin[name] === 'string' ? pin[name] : null,
      'init-env': name in initEnv ? initEnv[name] : null,
      manifest: entry && typeof entry.default === 'string' ? entry.default : null,
    };
    if (name === 'RAG_PIPELINE') locations['default-pipeline'] = pipelineMatch ? pipelineMatch[1] : null;
    out[name] = locations;
  }
  return out;
}

function isStringMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');
}

function loadDfltDecision(root, errors) {
  const read = readJson(root, DFLT_DECISION_PATH);
  if (read.missing) return void errors.push(`${DFLT_DECISION_PATH} is missing`);
  if (read.invalid) return void errors.push(`${DFLT_DECISION_PATH} is not valid JSON`);
  const d = read.value;
  if (d?.status !== 'flip' && d?.status !== 'not_flipped') return void errors.push(`${DFLT_DECISION_PATH}: status must be flip or not_flipped`);
  if (!isStringMap(d.defaults) || DFLT_NAMES.some((n) => typeof d.defaults[n] !== 'string')) {
    return void errors.push(`${DFLT_DECISION_PATH}: defaults must give ${DFLT_NAMES.join(', ')}`);
  }
  if (!Array.isArray(d.implicit_in_templates) || d.implicit_in_templates.some((n) => typeof n !== 'string')) {
    return void errors.push(`${DFLT_DECISION_PATH}: implicit_in_templates must be a list of names`);
  }
  return d;
}

function nullAmounts(node, where, out) {
  if (Array.isArray(node)) node.forEach((item, i) => nullAmounts(item, `${where}[${i}]`, out));
  else if (node && typeof node === 'object') {
    if ('usd' in node && node.usd === null && (typeof node.reason !== 'string' || node.reason === '')) out.push(where);
    for (const [key, value] of Object.entries(node)) if (key !== 'usd' && key !== 'reason') nullAmounts(value, `${where}.${key}`, out);
  }
}

/** ADM-02 revision 4: cost per 1,000 documents and queries, latency and per-language quality. */
function checkAdm02(record, provisional, errors, notices) {
  const absent = ADM02_BLOCKS.filter((block) => record[block] === undefined || record[block] === null);
  if (absent.length > 0) {
    if (provisional && absent.length === ADM02_BLOCKS.length) {
      notices.push(`provisional record carries no ${absent.join(', ')} block; the live decide (plan 07-33) writes them`);
    } else {
      for (const block of absent) errors.push(`record missing: ${block}`);
    }
  }
  const cost = record.cost;
  if (cost !== undefined && cost !== null) {
    for (const key of ['per_1000_documents', 'per_1000_queries']) {
      if (!Array.isArray(cost[key]) || cost[key].length === 0) errors.push(`record missing: cost.${key}`);
    }
    const nulls = [];
    nullAmounts(cost, 'cost', nulls);
    for (const where of nulls) errors.push(`record ${where}: a null amount needs its reason code`);
  }
  const latency = record.latency;
  if (latency !== undefined && latency !== null && (!Array.isArray(latency.entries) || latency.entries.length === 0)) {
    errors.push('record missing: latency.entries');
  }
  const perLanguage = record.per_language;
  if (perLanguage !== undefined && perLanguage !== null) {
    if (!Array.isArray(perLanguage)) errors.push('record per_language must be a list');
    else {
      perLanguage.forEach((entry, i) => {
        if (entry?.below_baseline === null && (typeof entry.reason !== 'string' || entry.reason === '')) {
          errors.push(`record per_language[${i}]: below_baseline null needs its reason code`);
        }
      });
    }
  }
}

function adoptsChallenger(record) {
  return Object.keys({ ...record.incumbent, ...record.defaults }).some((n) => record.incumbent[n] !== record.defaults[n]);
}

/** D-18: the shipped defaults equal the latest defaults decision; exit 0 pass, 1 mismatch, 2 malformed record. */
export function checkReleaseDefaults(root = DEFAULT_ROOT) {
  const errors = [];
  const notices = [];
  const result = (extra = {}) => ({ code: errors.length > 0 ? 2 : 0, errors, notices, violations: [], expected: {}, ...extra });

  const read = readJson(root, RECORD_PATH);
  if (read.missing || read.invalid) {
    errors.push(`${RECORD_PATH} is ${read.missing ? 'missing' : 'not valid JSON'}`);
    return result();
  }
  const record = read.value;
  if (!record || typeof record !== 'object' || !isStringMap(record.incumbent) || !isStringMap(record.defaults)) {
    errors.push('record must carry incumbent and defaults maps of string values');
    return result();
  }
  const provisional = record.provisional !== null && record.provisional !== undefined && record.provisional !== false;
  const dflt = loadDfltDecision(root, errors);

  const manifest = readJson(root, MANIFEST_PATH).value;
  const secrets = new Set((Array.isArray(manifest?.vars) ? manifest.vars : []).filter((v) => v?.type === 'secret').map((v) => v.name));
  for (const map of ['incumbent', 'defaults']) {
    for (const name of Object.keys(record[map]).sort()) {
      if (secrets.has(name)) errors.push(`record ${map} names ${name}, a secret-typed manifest variable`);
    }
  }

  if (provisional) {
    if (!fs.existsSync(path.join(root, FIXTURES_MD))) errors.push(`provisional record without ${FIXTURES_MD}`);
  } else {
    const day = typeof record.decided_at === 'string' ? record.decided_at.slice(0, 10) : '';
    const md = `eval/decisions/defaults-${day}.md`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) errors.push('non-provisional record without a decided_at date');
    else if (!fs.existsSync(path.join(root, md))) errors.push(`non-provisional record without its decision Markdown ${md}`);
  }

  if (record.incumbent_source?.path !== DFLT_DECISION_PATH) errors.push(`record incumbent_source must be ${DFLT_DECISION_PATH}`);
  if (dflt) {
    for (const name of DFLT_NAMES) {
      if (record.incumbent[name] !== dflt.defaults[name]) errors.push(`record incumbent ${name} differs from the Phase 4.1 decision`);
    }
  }

  checkAdm02(record, provisional, errors, notices);
  if (!provisional && Array.isArray(record.per_language) && adoptsChallenger(record)) {
    for (const entry of record.per_language) {
      if (entry?.below_baseline === true) errors.push(`record adopts a challenger while enabled language ${entry.language} is below its baseline (ADM-02)`);
    }
  }
  if (errors.length > 0) return result();

  const flipped = dflt.status === 'flip';
  const expected = provisional ? { ...record.incumbent } : { ...record.defaults };
  if (provisional) for (const name of DFLT_NAMES) expected[name] = flipped ? dflt.defaults[name] : PHASE4_RETRIEVAL_DEFAULTS[name];
  const implicit = new Set(flipped ? dflt.implicit_in_templates : []);

  const names = Object.keys(expected).sort();
  const shipped = readShippedDefaults(root, names);
  const violations = [];
  for (const name of names) {
    for (const [location, value] of Object.entries(shipped[name])) {
      const want = implicit.has(name) && TEMPLATE_LOCATIONS.includes(location) ? '' : expected[name];
      if (value === want) continue;
      const shown = value === null ? '(absent)' : JSON.stringify(value);
      violations.push({ name, location, expected: want, shipped: value, line: `${name} [${location}] expected ${JSON.stringify(want)}, shipped ${shown}` });
    }
  }
  violations.sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  return { code: violations.length > 0 ? 1 : 0, errors, notices, violations, expected };
}

function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--root');
  const root = at >= 0 ? path.resolve(argv[at + 1] ?? '') : DEFAULT_ROOT;
  const { code, errors, notices, violations, expected } = checkReleaseDefaults(root);
  for (const n of notices) console.log(`[check-release-defaults] note: ${n}`);
  for (const e of errors) console.error(`[check-release-defaults] malformed: ${e}`);
  for (const v of violations) console.error(v.line);
  if (code === 0) console.log(`[check-release-defaults] ok: ${Object.keys(expected).length} default(s) match the decision record`);
  else if (code === 1) console.error(`[check-release-defaults] ${violations.length} mismatch(es): a shipped default differs from the decision record (D-18)`);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
