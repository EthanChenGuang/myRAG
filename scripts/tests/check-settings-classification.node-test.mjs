import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'check-settings-classification.mjs');

function makeRoot({ vars, entries }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-classification-'));
  const files = {
    'scripts/rag/env-manifest.json': JSON.stringify({ schemaVersion: 1, vars: vars.map((name) => ({ name, status: 'managed', knownGaps: [] })) }),
    'config/rag/settings-classification.json': JSON.stringify({ schema_version: 1, entries }),
  };
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}

const run = (root) => spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });

const BASE_VARS = ['OPENAI_API_KEY', 'RAG_ALPHA', 'RAG_BETA'];
const BASE_ENTRIES = [
  { name: 'RAG_ALPHA', side: 'ingestion', mechanism: 'reparse' },
  { name: 'RAG_BETA', side: 'query' },
];

test('a consistent temp tree passes, and a non-RAG manifest variable needs no entry', () => {
  const result = run(makeRoot({ vars: BASE_VARS, entries: BASE_ENTRIES }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 RAG_\* variable\(s\) classified/);
});

test('a manifest variable without an entry fails and names it', () => {
  const result = run(makeRoot({ vars: [...BASE_VARS, 'RAG_NEW_THING'], entries: BASE_ENTRIES }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RAG_NEW_THING/);
  assert.match(result.stderr, /no classification/);
});

test('an entry for a name absent from the manifest fails', () => {
  const result = run(makeRoot({ vars: BASE_VARS, entries: [...BASE_ENTRIES, { name: 'RAG_GONE', side: 'query' }] }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RAG_GONE/);
  assert.match(result.stderr, /not in scripts\/rag\/env-manifest\.json/);
});

test('an ingestion or both entry without a mechanism fails', () => {
  for (const side of ['ingestion', 'both']) {
    const result = run(makeRoot({ vars: BASE_VARS, entries: [{ name: 'RAG_ALPHA', side }, BASE_ENTRIES[1]] }));
    assert.equal(result.status, 1, side);
    assert.match(result.stderr, /RAG_ALPHA: .* needs a mechanism/);
  }
});

test('a query entry with a mechanism fails', () => {
  const result = run(makeRoot({ vars: BASE_VARS, entries: [BASE_ENTRIES[0], { name: 'RAG_BETA', side: 'query', mechanism: 'reembed' }] }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RAG_BETA: a query entry names no mechanism/);
});

test('an unknown side or mechanism, a repeated name and unsorted entries fail', () => {
  const unknownSide = run(makeRoot({ vars: BASE_VARS, entries: [{ name: 'RAG_ALPHA', side: 'sometimes', mechanism: 'reparse' }, BASE_ENTRIES[1]] }));
  assert.equal(unknownSide.status, 1);
  assert.match(unknownSide.stderr, /RAG_ALPHA: side/);
  const unknownMechanism = run(makeRoot({ vars: BASE_VARS, entries: [{ name: 'RAG_ALPHA', side: 'ingestion', mechanism: 'rewrite' }, BASE_ENTRIES[1]] }));
  assert.equal(unknownMechanism.status, 1);
  assert.match(unknownMechanism.stderr, /RAG_ALPHA: mechanism/);
  const repeated = run(makeRoot({ vars: BASE_VARS, entries: [...BASE_ENTRIES, BASE_ENTRIES[1]] }));
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /RAG_BETA: listed twice/);
  const unsorted = run(makeRoot({ vars: BASE_VARS, entries: [BASE_ENTRIES[1], BASE_ENTRIES[0]] }));
  assert.equal(unsorted.status, 1);
  assert.match(unsorted.stderr, /sorted by name/);
});

test('the repository tree passes', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[check-settings-classification\] ok/);
});
