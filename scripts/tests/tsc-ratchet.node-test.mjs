import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countDiagnostics, compareToBaseline } from '../ci/tsc-ratchet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RATCHET = path.join(ROOT, 'scripts', 'ci', 'tsc-ratchet.mjs');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-ratchet-'));
}

function diag(file, line = 1, col = 1, code = 2322) {
  return `${file}(${line},${col}): error TS${code}: Type 'string' is not assignable to type 'number'.`;
}

function run(args, cwd = ROOT) {
  return spawnSync(process.execPath, [RATCHET, ...args], { cwd, encoding: 'utf8' });
}

function setup(outputLines, baseline) {
  const dir = tmp();
  const input = path.join(dir, 'tsc.txt');
  const baselineFile = path.join(dir, 'baseline.json');
  fs.writeFileSync(input, `${outputLines.join('\n')}\n`);
  if (baseline !== undefined) fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
  return { dir, input, baselineFile };
}

test('countDiagnostics groups errors per normalised file and separates file-less diagnostics', () => {
  const text = [
    diag('src/a.ts', 1),
    '  Type detail line that is not a diagnostic',
    diag('src\\b.tsx', 2),
    diag('./src/a.ts', 3),
    'error TS6053: File not found.',
  ].join('\n');
  const result = countDiagnostics(text);
  assert.deepEqual(result.files, { 'src/a.ts': 2, 'src/b.tsx': 1 });
  assert.equal(result.fileless, 1);
  assert.equal(result.total, 4);
});

test('compareToBaseline fails when a file gains an error', () => {
  const result = compareToBaseline(countDiagnostics(diag('src/a.ts') + '\n' + diag('src/a.ts', 2)), { files: { 'src/a.ts': 1 } });
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0], /src\/a\.ts/);
});

test('compareToBaseline fails when a file absent from the baseline has errors', () => {
  const result = compareToBaseline(countDiagnostics(diag('src/new.ts')), { files: { 'src/a.ts': 1 } });
  assert.equal(result.ok, false);
  assert.match(result.violations.join('\n'), /src\/new\.ts/);
});

test('compareToBaseline fails on any file-less diagnostic', () => {
  const result = compareToBaseline(countDiagnostics('error TS18003: No inputs were found in config file.'), { files: {} });
  assert.equal(result.ok, false);
  assert.match(result.violations.join('\n'), /file-less/i);
});

test('compareToBaseline passes when counts drop and lists the improved files', () => {
  const baseline = { files: { 'src/a.ts': 3, 'src/b.ts': 1 } };
  const result = compareToBaseline(countDiagnostics(diag('src/a.ts')), baseline);
  assert.equal(result.ok, true);
  assert.deepEqual(result.improved.sort(), ['src/a.ts', 'src/b.ts']);
});

test('CLI exits 0 on equal counts and prints the ok line', () => {
  const { input, baselineFile } = setup([diag('src/a.ts')], { schemaVersion: 1, project: 'tsconfig.json', total: 1, files: { 'src/a.ts': 1 } });
  const result = run(['--input', input, '--baseline', baselineFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[tsc-ratchet\] ok: 1 error\(s\), 0 file\(s\) improved/);
});

test('CLI exits 1 naming the file on a regression and leaves the baseline untouched', () => {
  const baseline = { schemaVersion: 1, project: 'tsconfig.json', total: 1, files: { 'src/a.ts': 1 } };
  const { input, baselineFile } = setup([diag('src/a.ts'), diag('src/a.ts', 2)], baseline);
  const before = fs.readFileSync(baselineFile, 'utf8');
  const result = run(['--input', input, '--baseline', baselineFile]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/a\.ts/);
  assert.equal(fs.readFileSync(baselineFile, 'utf8'), before);
});

test('CLI exits 70 when tsc fails without any parseable diagnostic', () => {
  const { input, baselineFile } = setup(['Segmentation fault'], { schemaVersion: 1, project: 'tsconfig.json', total: 0, files: {} });
  const result = run(['--input', input, '--input-status', '1', '--baseline', baselineFile]);
  assert.equal(result.status, 70);
  assert.match(result.stderr, /crash/i);
});

test('--write stores schemaVersion, project, total and sorted files with a trailing newline', () => {
  const { input, baselineFile } = setup([diag('src/z.ts'), diag('src/a.ts'), diag('src/a.ts', 2)]);
  const result = run(['--input', input, '--baseline', baselineFile, '--project', 'tsconfig.json', '--write']);
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(baselineFile, 'utf8');
  assert.ok(text.endsWith('}\n'));
  const parsed = JSON.parse(text);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.project, 'tsconfig.json');
  assert.equal(parsed.total, 3);
  assert.deepEqual(Object.keys(parsed.files), ['src/a.ts', 'src/z.ts']);
  assert.deepEqual(parsed.files, { 'src/a.ts': 2, 'src/z.ts': 1 });
});

test('--write refuses to record a file-less diagnostic', () => {
  const { input, baselineFile } = setup(['error TS18003: No inputs were found in config file.']);
  const result = run(['--input', input, '--baseline', baselineFile, '--write']);
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(baselineFile), false);
});

test('--key stores and checks one project per key without disturbing the others', () => {
  const { dir, input, baselineFile } = setup([diag('src/a.ts')]);
  fs.writeFileSync(
    baselineFile,
    `${JSON.stringify({ schemaVersion: 1, packages: { other: { project: 'tsconfig.json', total: 2, files: { 'x.ts': 2 } } } }, null, 2)}\n`,
  );
  const written = run(['--input', input, '--baseline', baselineFile, '--key', 'voice-agent', '--write']);
  assert.equal(written.status, 0, written.stderr);
  const parsed = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  assert.deepEqual(Object.keys(parsed.packages), ['other', 'voice-agent']);
  assert.equal(parsed.packages.other.total, 2);
  assert.deepEqual(parsed.packages['voice-agent'].files, { 'src/a.ts': 1 });

  const worse = path.join(dir, 'worse.txt');
  fs.writeFileSync(worse, `${diag('src/a.ts')}\n${diag('src/b.ts')}\n`);
  const checked = run(['--input', worse, '--baseline', baselineFile, '--key', 'voice-agent']);
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /src\/b\.ts/);

  const missing = run(['--input', input, '--baseline', baselineFile, '--key', 'unknown']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /unknown/);
});
