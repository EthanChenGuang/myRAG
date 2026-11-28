import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkReleaseDefaults, readShippedDefaults, parseInitEnv } from '../check-release-defaults.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DFLT = ['RAG_PIPELINE', 'RAG_LEXICAL_SEARCH', 'RAG_RERANKER', 'RAG_REFUSAL_THRESHOLD', 'RAG_REFUSAL_FLOOR'];
const PHASE4 = { RAG_PIPELINE: 'legacy', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_REFUSAL_THRESHOLD: 'false', RAG_REFUSAL_FLOOR: 'similarity' };
const FLIPPED = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'auto', RAG_REFUSAL_THRESHOLD: 'true', RAG_REFUSAL_FLOOR: 'legacy_rule' };
const SHA = 'a'.repeat(64);

function amount(usd, reason = null) {
  return { usd, reason };
}

function blocks() {
  const zero = amount(0);
  return {
    cost: {
      per_1000_documents: [{ embedding_profile: 'p', backend: 'pgvector', documents: { parse: zero, embedding: zero, enrichment: amount(null, 'not_provided'), external_store: zero } }],
      per_1000_queries: [{ config_name: 'b.incumbent', queries: { query_embedding: amount(null, 'not_measured'), rerank: zero, generation: zero, external_store: zero } }],
      basis: { price_table_sha256: SHA, document_sample: 1, query_sample: 1, kind: 'estimated' },
    },
    latency: { budgets_sha256: SHA, entries: [{ config_name: 'b.incumbent', channel: 'chat', values: [{ stage: 'total', p50_ms: 1, p95_ms: 2, within_budget: true }] }] },
    per_language: [{ language: 'en', metric: 'recall_at_10', n: 10, value: 0.5, baseline: 0.5, difference: 0, band: 0.02, below_baseline: false }],
  };
}

/** One fixture tree: every D-18 location holds `values` for each name. */
function tree({ values, record, decision = { status: 'flip', defaults: { ...FLIPPED }, implicit_in_templates: [] }, overrides = {}, secrets = [], fixturesMd = true, decisionMd = null, defaultPipeline }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-defaults-'));
  const at = (location, name) => (overrides[location] && name in overrides[location] ? overrides[location][name] : values[name]);
  const names = Object.keys(values);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write('scripts/init-env.js', `const template = \`\n${names.map((n) => `${n}=${at('init-env', n)}`).join('\n')}\n\`;\n`);
  write('src/lib/env.ts', `export const env = {\n${names.map((n) => `  ${n}: process.env.${n} || '${at('env-ts', n)}',`).join('\n')}\n};\n`);
  const create = names.map((n) => `\${fullValues.${n} !== undefined ? \`${n}=\${fullValues.${n}}\` : '${n}=${at('config-server:create', n)}'}`).join('\n');
  const std = names.map((n) => `${n}=\${getEnvValue('${n}') || '${at('config-server:standard', n)}'}`).join('\n');
  const full = names.map((n) => `${n}=\${getEnvValue('${n}') || '${at('config-server:full', n)}'}`).join('\n');
  write(
    'scripts/config-server.js',
    `app.post('/x', () => {\n  const newContent = \`# head\n${create}\n\`;\n});\nfunction getStandardTemplate() {\n  return \`# std\n${std}\n\`;\n}\nfunction getFullTemplate() {\n  return \`# full\n${full}\n\`;\n}\n`,
  );
  const vars = names.map((n) => ({ name: n, status: 'managed', type: 'string', default: at('manifest', n) }));
  for (const s of secrets) vars.push({ name: s, status: 'managed', type: 'secret', default: '' });
  write('scripts/rag/env-manifest.json', JSON.stringify({ schemaVersion: 1, vars }));
  write('eval/config/rag-eval-env.json', JSON.stringify(Object.fromEntries(names.map((n) => [n, at('eval-pin', n)]))));
  const pipeline = defaultPipeline ?? values.RAG_PIPELINE ?? 'legacy';
  write('src/lib/rag/config.ts', `export const DEFAULT_PIPELINE: 'legacy' | 'v2' = '${pipeline}';\n`);
  if (decision !== null) write('eval/decisions/04.1-retrieval-defaults.json', typeof decision === 'string' ? decision : JSON.stringify(decision));
  write('eval/config/release-defaults.json', typeof record === 'string' ? record : JSON.stringify(record));
  if (fixturesMd) write('eval/decisions/defaults-fixtures.md', '# fixtures\n');
  if (decisionMd) write(`eval/decisions/${decisionMd}`, '# decision\n');
  return root;
}

function record({ provisional = 'fixtures', incumbent, defaults, withBlocks = true, decidedAt = '2026-12-01T00:00:00Z', source = 'eval/decisions/04.1-retrieval-defaults.json' }) {
  return {
    schema_version: 1,
    provisional,
    decided_at: decidedAt,
    incumbent_source: { path: source, sha256: SHA },
    incumbent,
    defaults,
    ...(withBlocks ? blocks() : {}),
  };
}

function run(root) {
  try {
    return checkReleaseDefaults(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const base = { ...FLIPPED, RAG_X: 'off' };

test('a provisional record whose incumbent matches every location passes', () => {
  const res = run(tree({ values: base, record: record({ incumbent: base, defaults: base }) }));
  assert.equal(res.code, 0, JSON.stringify(res));
});

test('a provisional record never moves a default: its defaults map is ignored', () => {
  const res = run(tree({ values: base, record: record({ incumbent: base, defaults: { ...base, RAG_X: 'on' } }) }));
  assert.equal(res.code, 0, JSON.stringify(res));
});

test('a non-provisional record moves the defaults: every location must follow it', () => {
  const rec = record({ provisional: null, incumbent: base, defaults: { ...base, RAG_X: 'on' } });
  const stale = run(tree({ values: base, record: rec, decisionMd: 'defaults-2026-12-01.md' }));
  assert.equal(stale.code, 1);
  const locations = stale.violations.filter((v) => v.name === 'RAG_X').map((v) => v.location);
  assert.deepEqual(locations, ['config-server:create', 'config-server:full', 'config-server:standard', 'env-ts', 'eval-pin', 'init-env', 'manifest']);
  assert.ok(stale.violations.every((v) => v.expected === 'on' && v.shipped === 'off'));
  const moved = run(tree({ values: { ...base, RAG_X: 'on' }, record: rec, decisionMd: 'defaults-2026-12-01.md' }));
  assert.equal(moved.code, 0, JSON.stringify(moved));
});

test('one config-server template disagreeing is reported for that template only', () => {
  const res = run(tree({ values: base, overrides: { 'config-server:standard': { RAG_X: 'on' } }, record: record({ incumbent: base, defaults: base }) }));
  assert.equal(res.code, 1);
  assert.deepEqual(res.violations.map((v) => `${v.name} ${v.location}`), ['RAG_X config-server:standard']);
});

test('a record map naming a secret-typed manifest variable exits 2', () => {
  const withSecret = { ...base, RAG_X_API_KEY: '' };
  const res = run(tree({ values: base, secrets: ['RAG_X_API_KEY'], record: record({ incumbent: withSecret, defaults: base }) }));
  assert.equal(res.code, 2);
  assert.match(res.errors.join('\n'), /RAG_X_API_KEY.*secret/);
});

test('a non-provisional record without its dated decision Markdown exits 2', () => {
  const res = run(tree({ values: base, record: record({ provisional: null, incumbent: base, defaults: base }) }));
  assert.equal(res.code, 2);
  assert.match(res.errors.join('\n'), /defaults-2026-12-01\.md/);
});

test('a provisional record without defaults-fixtures.md exits 2', () => {
  const res = run(tree({ values: base, fixturesMd: false, record: record({ incumbent: base, defaults: base }) }));
  assert.equal(res.code, 2);
  assert.match(res.errors.join('\n'), /defaults-fixtures\.md/);
});

test('a flipped 04.1 decision sets the expected value of the five DFLT names while the record is provisional', () => {
  const rec = record({ incumbent: base, defaults: base });
  assert.equal(run(tree({ values: base, record: rec })).code, 0);
  const legacy = run(tree({ values: { ...base, RAG_PIPELINE: 'legacy' }, record: rec }));
  assert.equal(legacy.code, 1);
  assert.ok(legacy.violations.every((v) => v.name === 'RAG_PIPELINE' && v.expected === 'v2'), JSON.stringify(legacy.violations));
});

test('a not_flipped 04.1 decision keeps the Phase 4 values for the five DFLT names', () => {
  const decision = { status: 'not_flipped', defaults: { ...FLIPPED }, implicit_in_templates: ['RAG_PIPELINE'] };
  const rec = record({ incumbent: base, defaults: base });
  const shipped = { ...base, ...PHASE4 };
  assert.equal(run(tree({ values: shipped, decision, record: rec })).code, 0);
  const flippedWithoutDecision = run(tree({ values: base, decision, record: rec }));
  assert.equal(flippedWithoutDecision.code, 1);
  assert.deepEqual([...new Set(flippedWithoutDecision.violations.map((v) => v.name))].sort(), [...DFLT].sort());
});

test('a missing or malformed 04.1 decision exits 2', () => {
  const rec = record({ incumbent: base, defaults: base });
  assert.equal(run(tree({ values: base, decision: null, record: rec })).code, 2);
  assert.equal(run(tree({ values: base, decision: '{not json', record: rec })).code, 2);
  assert.equal(run(tree({ values: base, decision: { status: 'flip', defaults: { RAG_PIPELINE: 'v2' }, implicit_in_templates: [] }, record: rec })).code, 2);
});

test('04.1 D-25: implicit-in-templates names ship empty templates; env.ts and DEFAULT_PIPELINE carry the value', () => {
  const decision = { status: 'flip', defaults: { ...FLIPPED }, implicit_in_templates: ['RAG_PIPELINE'] };
  const rec = record({ incumbent: base, defaults: base });
  const empty = Object.fromEntries(['init-env', 'config-server:create', 'config-server:standard', 'config-server:full', 'manifest', 'eval-pin'].map((l) => [l, { RAG_PIPELINE: '' }]));
  assert.equal(run(tree({ values: base, decision, overrides: empty, record: rec, defaultPipeline: 'v2' })).code, 0);
  const explicit = run(tree({ values: base, decision, overrides: { ...empty, 'init-env': { RAG_PIPELINE: 'v2' } }, record: rec, defaultPipeline: 'v2' }));
  assert.equal(explicit.code, 1);
  assert.deepEqual(explicit.violations.map((v) => `${v.name} ${v.location} ${v.expected}`), ['RAG_PIPELINE init-env ']);
  const legacyFallback = run(tree({ values: base, decision, overrides: { ...empty, 'env-ts': { RAG_PIPELINE: 'legacy' } }, record: rec, defaultPipeline: 'v2' }));
  assert.deepEqual(legacyFallback.violations.map((v) => `${v.name} ${v.location}`), ['RAG_PIPELINE env-ts']);
  const legacyConst = run(tree({ values: base, decision, overrides: empty, record: rec, defaultPipeline: 'legacy' }));
  assert.deepEqual(legacyConst.violations.map((v) => `${v.name} ${v.location}`), ['RAG_PIPELINE default-pipeline']);
});

test('the incumbent must be the 04.1 decision for the five DFLT names', () => {
  const wrongSource = run(tree({ values: base, record: record({ incumbent: base, defaults: base, source: 'eval/decisions/other.json' }) }));
  assert.equal(wrongSource.code, 2);
  const drifted = { ...base, RAG_RERANKER: 'none' };
  const wrongValue = run(tree({ values: base, record: record({ incumbent: drifted, defaults: drifted }) }));
  assert.equal(wrongValue.code, 2);
  assert.match(wrongValue.errors.join('\n'), /RAG_RERANKER/);
});

test('a non-provisional record without the cost, latency or per_language block exits 2 and names it', () => {
  for (const block of ['cost', 'latency', 'per_language']) {
    const rec = record({ provisional: null, incumbent: base, defaults: base });
    delete rec[block];
    const res = run(tree({ values: base, record: rec, decisionMd: 'defaults-2026-12-01.md' }));
    assert.equal(res.code, 2, block);
    assert.match(res.errors.join('\n'), new RegExp(`missing: ${block}`));
  }
  const noDocs = record({ provisional: null, incumbent: base, defaults: base });
  noDocs.cost.per_1000_documents = [];
  const res = run(tree({ values: base, record: noDocs, decisionMd: 'defaults-2026-12-01.md' }));
  assert.match(res.errors.join('\n'), /missing: cost\.per_1000_documents/);
});

test('a provisional record without the ADM-02 blocks passes with a notice; one carrying them passes silently', () => {
  const bare = run(tree({ values: base, record: record({ incumbent: base, defaults: base, withBlocks: false }) }));
  assert.equal(bare.code, 0, JSON.stringify(bare));
  assert.match(bare.notices.join('\n'), /cost, latency, per_language/);
  const full = run(tree({ values: base, record: record({ incumbent: base, defaults: base }) }));
  assert.equal(full.code, 0);
  assert.deepEqual(full.notices, []);
});

test('a null cost amount without its reason code exits 2, also on a provisional record', () => {
  const rec = record({ incumbent: base, defaults: base });
  rec.cost.per_1000_queries[0].queries.generation = { usd: null, reason: null };
  const res = run(tree({ values: base, record: rec }));
  assert.equal(res.code, 2);
  assert.match(res.errors.join('\n'), /per_1000_queries\[0\]\.queries\.generation/);
});

test('an adopting record with an enabled language below baseline exits 2; keeping every incumbent passes', () => {
  const below = (rec) => {
    rec.per_language[0] = { ...rec.per_language[0], below_baseline: true, difference: -0.1 };
    return rec;
  };
  const adopting = below(record({ provisional: null, incumbent: base, defaults: { ...base, RAG_X: 'on' } }));
  const res = run(tree({ values: { ...base, RAG_X: 'on' }, record: adopting, decisionMd: 'defaults-2026-12-01.md' }));
  assert.equal(res.code, 2);
  assert.match(res.errors.join('\n'), /en.*below its baseline/);
  const keeping = below(record({ provisional: null, incumbent: base, defaults: base }));
  assert.equal(run(tree({ values: base, record: keeping, decisionMd: 'defaults-2026-12-01.md' })).code, 0);
});

test('readShippedDefaults reads every D-18 location', () => {
  const root = tree({ values: { RAG_X: 'off' }, record: record({ incumbent: base, defaults: base }) });
  try {
    const shipped = readShippedDefaults(root, ['RAG_X', 'RAG_PIPELINE']);
    assert.deepEqual(shipped.RAG_X, {
      'config-server:create': 'off',
      'config-server:full': 'off',
      'config-server:standard': 'off',
      'env-ts': 'off',
      'eval-pin': 'off',
      'init-env': 'off',
      manifest: 'off',
    });
    assert.equal(shipped.RAG_PIPELINE['default-pipeline'], 'legacy');
    assert.equal(shipped.RAG_PIPELINE['init-env'], null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the init-env parser agrees with the committed eval pin (derivePinnedEvalEnv) on the real file', () => {
  const parsed = parseInitEnv(fs.readFileSync(path.join(REPO_ROOT, 'scripts/init-env.js'), 'utf8'));
  const pin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
  const overridden = new Set(['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE']);
  const compared = Object.keys(pin).filter((n) => n.startsWith('RAG_') && !overridden.has(n));
  assert.ok(compared.length > 50);
  for (const name of compared) assert.equal(parsed[name], pin[name], name);
});

test('output lines are sorted and carry names and default values only', () => {
  const root = tree({ values: base, overrides: { manifest: { RAG_X: 'on' }, 'init-env': { RAG_X: 'on' } }, record: record({ incumbent: base, defaults: base }) });
  try {
    const res = checkReleaseDefaults(root);
    const lines = res.violations.map((v) => v.line);
    assert.deepEqual(lines, [...lines].sort());
    assert.deepEqual(lines, ['RAG_X [init-env] expected "off", shipped "on"', 'RAG_X [manifest] expected "off", shipped "on"']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the repository passes on its committed record', () => {
  const res = checkReleaseDefaults(REPO_ROOT);
  assert.equal(res.code, 0, [...res.errors, ...res.violations.map((v) => v.line)].join('\n'));
});
