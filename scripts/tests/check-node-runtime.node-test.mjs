import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNodeRuntime } from '../ci/check-node-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'scripts', 'ci', 'check-node-runtime.mjs');

test('runtime 22 with engines ^22.12.0 passes', () => {
  const result = checkNodeRuntime({ version: '22.23.5', engines: '^22.12.0' });
  assert.equal(result.ok, true);
});

test('runtime majors other than 22 fail', () => {
  for (const version of ['20.18.0', '24.1.0', '26.0.0', '21.7.3']) {
    const result = checkNodeRuntime({ version, engines: '^22.12.0' });
    assert.equal(result.ok, false, version);
    assert.match(result.reason, /runtime/i);
  }
});

test('missing engines fails', () => {
  for (const engines of [undefined, null, '', '   ']) {
    const result = checkNodeRuntime({ version: '22.23.5', engines });
    assert.equal(result.ok, false);
    assert.match(result.reason, /engines/i);
  }
});

test('ranges that admit a major other than 22 fail', () => {
  for (const engines of ['>=22.12.0', '>=22', '22 || 24', '*', '>=20.9.0', '^22.12.0 || ^24.0.0', '>=22.0.0 <25', '^20.0.0']) {
    const result = checkNodeRuntime({ version: '22.23.5', engines });
    assert.equal(result.ok, false, engines);
    assert.match(result.reason, /22/);
  }
});

test('ranges confined to major 22 pass', () => {
  for (const engines of ['^22.12.0', '22.x', '~22.12.0', '22', '>=22.12.0 <23']) {
    const result = checkNodeRuntime({ version: '22.23.5', engines });
    assert.equal(result.ok, true, engines);
  }
});

test('non-string engines value fails instead of throwing', () => {
  const result = checkNodeRuntime({ version: '22.23.5', engines: { node: '^22.12.0' } });
  assert.equal(result.ok, false);
});

function runCli(root, nodeVersion) {
  const args = [CLI, '--root', root];
  if (nodeVersion) args.push('--node-version', nodeVersion);
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

function tmpRoot(pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-'));
  if (pkg !== undefined) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

test('CLI exits 0 for a valid package.json and runtime', () => {
  const result = runCli(tmpRoot({ engines: { node: '^22.12.0' } }), '22.1.0');
  assert.equal(result.status, 0, result.stderr);
});

test('CLI exits 1 with a one-line reason for an open range', () => {
  const result = runCli(tmpRoot({ engines: { node: '>=22.12.0' } }), '22.1.0');
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim().split('\n').length, 1);
});

test('CLI exits 1 when engines is missing or package.json is absent', () => {
  assert.equal(runCli(tmpRoot({ name: 'x' }), '22.1.0').status, 1);
  assert.equal(runCli(tmpRoot(undefined), '22.1.0').status, 1);
});

test('CLI exits 1 on a wrong runtime major', () => {
  const result = runCli(tmpRoot({ engines: { node: '^22.12.0' } }), '24.0.0');
  assert.equal(result.status, 1);
});

test('the repository itself passes on the local runtime', () => {
  const result = spawnSync(process.execPath, [CLI], { cwd: ROOT, encoding: 'utf8' });
  if (process.versions.node.split('.')[0] === '22') assert.equal(result.status, 0, result.stderr);
  else assert.equal(result.status, 1);
});
