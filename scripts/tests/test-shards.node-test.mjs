import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShard, planShards } from '../ci/test-shards.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ci/test-shards.mjs');
const files = (n) => Array.from({ length: n }, (_, i) => `tests/x/f${String(i).padStart(2, '0')}.test.mts`);

test('every file lands in exactly one shard', () => {
  const all = files(23);
  const durations = Object.fromEntries(all.map((file, i) => [file, (i * 37) % 11]));
  const shards = planShards(all, 5, durations);
  const seen = shards.flatMap((shard) => shard.files);
  assert.equal(seen.length, all.length);
  assert.deepEqual([...seen].sort(), [...all].sort());
});

test('heavy files are spread instead of clustering by index', () => {
  const all = files(8);
  // Node's index split (i % 2) would put both 100 s files in shard 1.
  const durations = { [all[0]]: 100, [all[2]]: 100 };
  for (const file of all) durations[file] ??= 1;
  const [a, b] = planShards(all, 2, durations);
  assert.ok(Math.abs(a.seconds - b.seconds) <= 1, `${a.seconds} vs ${b.seconds}`);
  assert.ok(a.files.includes(all[0]) !== a.files.includes(all[2]));
});

test('each shard lists its longest file first', () => {
  const all = files(6);
  const durations = Object.fromEntries(all.map((file, i) => [file, i + 1]));
  for (const shard of planShards(all, 2, durations)) {
    const weights = shard.files.map((file) => durations[file]);
    assert.deepEqual(weights, [...weights].sort((a, b) => b - a));
  }
});

test('a file without a recorded duration weighs the median and is still run', () => {
  const all = files(4);
  const durations = { [all[0]]: 10, [all[1]]: 20, [all[2]]: 30 };
  const shards = planShards(all, 2, durations);
  assert.ok(shards.some((shard) => shard.files.includes(all[3])));
  assert.equal(shards.reduce((sum, shard) => sum + shard.seconds, 0), 80);
});

test('the plan is deterministic whatever the input order', () => {
  const all = files(12);
  const durations = Object.fromEntries(all.map((file) => [file, 5]));
  assert.deepEqual(planShards(all, 3, durations), planShards([...all].reverse(), 3, durations));
});

test('a shard that would run no file is refused', () => {
  assert.throws(() => planShards(files(2), 3, {}), /a shard would run no file/);
  assert.throws(() => planShards([], 1, {}), /no test files/);
});

test('shard specs are validated', () => {
  assert.deepEqual(parseShard('3/12'), { index: 3, total: 12 });
  for (const bad of ['0/3', '4/3', '3', 'a/b', '']) assert.throws(() => parseShard(bad));
});

test('the CLI prints one shard, and the union of all shards is the input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-shards-'));
  try {
    const durationsFile = path.join(dir, 'd.json');
    const all = files(7);
    fs.writeFileSync(durationsFile, JSON.stringify({ seconds: Object.fromEntries(all.map((file, i) => [file, i + 1])) }));
    const union = [];
    for (let k = 1; k <= 3; k++) {
      const run = spawnSync(process.execPath, [SCRIPT, `--shard=${k}/3`, `--durations=${durationsFile}`, ...all], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      union.push(...run.stdout.split('\n').filter(Boolean));
    }
    assert.deepEqual(union.sort(), [...all].sort());
    const empty = spawnSync(process.execPath, [SCRIPT, '--shard=1/9', `--durations=${durationsFile}`, ...all], { encoding: 'utf8' });
    assert.equal(empty.status, 1);
    assert.equal(empty.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed durations file holds a non-negative number per file', () => {
  const root = path.resolve(path.dirname(SCRIPT), '../..');
  const { seconds } = JSON.parse(fs.readFileSync(path.join(root, 'scripts/ci/test-durations.json'), 'utf8'));
  assert.ok(Object.keys(seconds).length > 0);
  for (const [file, value] of Object.entries(seconds)) assert.ok(typeof value === 'number' && value >= 0, file);
});
