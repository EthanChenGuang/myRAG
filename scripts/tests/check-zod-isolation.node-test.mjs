import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkZodIsolation } from '../ci/check-zod-isolation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'scripts', 'ci', 'check-zod-isolation.mjs');

function tree({ rootZod = '3.25.76', rootOpenai = '4.104.0', langchain = true, nestedZod = '4.6.7', omit = [] } = {}) {
  const dependencies = {};
  if (rootOpenai) dependencies.openai = { version: rootOpenai, dependencies: { zod: { version: rootZod } } };
  if (rootZod) dependencies.zod = { version: rootZod };
  if (langchain) {
    const nested = () => ({ version: nestedZod, resolved: `https://registry.npmjs.org/zod/-/zod-${nestedZod}.tgz` });
    dependencies['@langchain/core'] = { version: '1.4.0', dependencies: { zod: nested() } };
    dependencies['@langchain/classic'] = { version: '1.0.61', dependencies: { zod: nested() } };
    dependencies['@langchain/openai'] = {
      version: '1.8.4',
      dependencies: { openai: { version: '7.60.0' }, zod: nested() },
    };
    for (const name of omit) delete dependencies[name].dependencies.zod;
  }
  return { name: 'myrag', dependencies };
}

test('root zod 3.25 with zod 4 nested under each @langchain package passes', () => {
  const result = checkZodIsolation(tree());
  assert.equal(result.ok, true, result.reasons.join('; '));
  assert.equal(result.skipped, false);
});

test('root zod 4 fails', () => {
  const result = checkZodIsolation(tree({ rootZod: '4.6.7' }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => /root zod/i.test(r)), result.reasons.join('; '));
});

test('root zod other than 3.25.x fails', () => {
  for (const rootZod of ['3.24.2', '3.26.0', '']) {
    const result = checkZodIsolation(tree({ rootZod }));
    assert.equal(result.ok, false, rootZod);
  }
});

test('a @langchain package resolving the root zod 3 (deduped) fails', () => {
  const result = checkZodIsolation(tree({ nestedZod: '3.25.76' }));
  assert.equal(result.ok, false);
  for (const name of ['@langchain/core', '@langchain/classic', '@langchain/openai']) {
    assert.ok(result.reasons.some((r) => r.includes(name)), name);
  }
});

test('a @langchain package with no nested zod (hoisted to the root) fails', () => {
  const result = checkZodIsolation(tree({ omit: ['@langchain/openai'] }));
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('@langchain/openai')));
});

test('a missing @langchain tree passes with a skipped notice', () => {
  const result = checkZodIsolation(tree({ langchain: false }));
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.ok(result.notes.some((n) => /skipped: LangChain not installed/.test(n)));
});

test('root openai not 4.x fails', () => {
  for (const rootOpenai of ['5.23.2', '7.60.0', '3.3.0', null]) {
    const result = checkZodIsolation(tree({ rootOpenai }));
    assert.equal(result.ok, false, String(rootOpenai));
    assert.ok(result.reasons.some((r) => /openai/i.test(r)));
  }
});

test('root openai is still checked when LangChain is absent', () => {
  const result = checkZodIsolation(tree({ langchain: false, rootOpenai: '7.60.0' }));
  assert.equal(result.ok, false);
});

function runCli(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zod-iso-'));
  const file = path.join(dir, 'tree.json');
  fs.writeFileSync(file, JSON.stringify(data));
  try {
    return spawnSync(process.execPath, [CLI, '--tree-file', file], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI exits 0 on a good tree and 1 on a bad tree', () => {
  const good = runCli(tree());
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /\[check-zod-isolation\] ok/);
  const bad = runCli(tree({ nestedZod: '3.25.76' }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /\[check-zod-isolation\]/);
});

test('CLI prints a GitHub notice when LangChain is absent', () => {
  const result = runCli(tree({ langchain: false }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::notice::.*skipped: LangChain not installed/);
});

test('CLI fails on an unreadable tree file', () => {
  const result = spawnSync(process.execPath, [CLI, '--tree-file', path.join(os.tmpdir(), 'zod-iso-missing.json')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
});
