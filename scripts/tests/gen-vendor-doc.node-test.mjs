import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEN = path.join(ROOT, 'scripts', 'rag', 'gen-vendor-doc.mjs');
const INVENTORY = path.join(ROOT, 'config', 'rag', 'vendor-data-flow.json');
const DOC = path.join(ROOT, 'docs', 'vendor-data-flow.md');

const REQUIRED_VENDORS = [
  'vectara',
  'cohere',
  'voyage',
  'deepinfra',
  'openrouter',
  'openai',
  'weaviate',
  'qdrant',
  'anthropic',
  'llamacloud',
  'langfuse',
  'lakera',
  'exa',
  'judge',
  'prompt_guard',
];

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gen-vendor-doc-'));
}

function run(args) {
  return spawnSync(process.execPath, [GEN, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function entry(overrides = {}) {
  return {
    vendor: 'example-reranker',
    name: 'Example reranker',
    hosts: ['api.example.com'],
    content: ['query', 'chunk_text'],
    switch: 'RAG_EXAMPLE_SWITCH',
    opt_in: true,
    multi_tenant: 'allowed',
    retention: 'to_verify',
    training: 'to_verify',
    providers: ['example'],
    ...overrides,
  };
}

function writeInventory(dir, vendors) {
  const file = path.join(dir, 'inventory.json');
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: 1, vendors }, null, 2)}\n`);
  return file;
}

test('the committed inventory names every D-20 vendor, each with at least one host', () => {
  const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  const have = new Map(inventory.vendors.map((v) => [v.vendor, v]));
  for (const vendor of REQUIRED_VENDORS) {
    assert.ok(have.has(vendor), `missing vendor ${vendor}`);
    assert.ok(have.get(vendor).hosts.length >= 1, `${vendor} has no host`);
  }
});

test('Weaviate and Qdrant list vectors and lexical_text as content (A-11)', () => {
  const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  for (const vendor of ['weaviate', 'qdrant']) {
    const found = inventory.vendors.find((v) => v.vendor === vendor);
    assert.ok(found, `missing vendor ${vendor}`);
    assert.ok(found.content.includes('vectors'), `${vendor} vectors`);
    assert.ok(found.content.includes('lexical_text'), `${vendor} lexical_text`);
  }
});

test('--check exits 0 on the committed inventory and document', () => {
  const result = run(['--check']);
  assert.equal(result.status, 0, result.stderr);
});

test('--check exits 1 after the inventory changes without regenerating', () => {
  const dir = tmp();
  const inventory = JSON.parse(fs.readFileSync(INVENTORY, 'utf8'));
  const file = writeInventory(dir, [...inventory.vendors, entry({ vendor: 'added-vendor', hosts: ['added.example.com'] })]);
  const result = run(['--check', '--inventory', file, '--out', DOC]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /out of date/);
});

test('rendering is deterministic, sorted by vendor, one row per vendor and host', () => {
  const dir = tmp();
  const file = writeInventory(dir, [
    entry({ vendor: 'zeta', name: 'Zeta', hosts: ['z1.example.com', 'z2.example.com'] }),
    entry({ vendor: 'alpha', name: 'Alpha', hosts: ['a.example.com'], content: ['vectors', 'lexical_text'] }),
  ]);
  const out = path.join(dir, 'doc.md');
  assert.equal(run(['--inventory', file, '--out', out]).status, 0);
  const first = fs.readFileSync(out, 'utf8');
  assert.equal(run(['--inventory', file, '--out', out]).status, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), first);
  const rows = first.split('\n').filter((line) => /^\| `[a-z]/.test(line));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^\| `alpha` .*`a\.example\.com`.*`vectors`, `lexical_text`/);
  assert.match(rows[1], /^\| `zeta` .*`z1\.example\.com`/);
  assert.match(rows[2], /^\| `zeta` .*`z2\.example\.com`/);
  assert.match(first, /generated from config\/rag\/vendor-data-flow\.json/i);
  assert.match(first, /`alpha`: retention, training/);
  assert.equal(run(['--check', '--inventory', file, '--out', out]).status, 0);
});

for (const [label, bad] of [
  ['an unknown content kind', entry({ content: ['query', 'passwords'] })],
  ['missing hosts', (() => { const e = entry(); delete e.hosts; return e; })()],
  ['an empty host list', entry({ hosts: [] })],
  ['a host with a scheme', entry({ hosts: ['https://api.example.com'] })],
  ['an unknown field', entry({ notes: 'x' })],
  ['requires_ack without ack_switch', entry({ multi_tenant: 'requires_ack' })],
  ['ack_switch without requires_ack', entry({ ack_switch: 'RAG_EXAMPLE_ACK' })],
  ['a repeated content kind', entry({ content: ['query', 'query'] })],
]) {
  test(`an entry with ${label} makes the generator exit 2 and write nothing`, () => {
    const dir = tmp();
    const file = writeInventory(dir, [bad]);
    const out = path.join(dir, 'doc.md');
    const result = run(['--inventory', file, '--out', out]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /invalid/i);
    assert.equal(fs.existsSync(out), false);
  });
}

test('a repeated vendor id makes the generator exit 2', () => {
  const dir = tmp();
  const file = writeInventory(dir, [entry(), entry({ hosts: ['other.example.com'] })]);
  const result = run(['--check', '--inventory', file, '--out', DOC]);
  assert.equal(result.status, 2);
});
