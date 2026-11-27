import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';

// Phase 5.3 D-13 (plan 05.3-22): the live layer of the setting check runs the nightly harness under the proposed settings.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL_GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const TRACER_ITEM_ID = 'en-general-001';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-nightly-overlay-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const GOLDEN_PATH = path.join(tmp, 'tracer.jsonl');
fs.writeFileSync(
  GOLDEN_PATH,
  fs
    .readFileSync(FULL_GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && (JSON.parse(line) as { id: string }).id === TRACER_ITEM_ID)
    .map((line) => `${line}\n`)
    .join(''),
);

function writeOverlay(name: string, env: Record<string, string>): string {
  const file = path.join(tmp, `${name}.overlay.json`);
  fs.writeFileSync(file, JSON.stringify({ env }));
  return file;
}

function runNightly(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'eval/harness/run-nightly.mts', '--generator', 'stub', '--golden', GOLDEN_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, OPENROUTER_API_KEY: '' },
    timeout: 240_000,
  });
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('run-nightly --env-overlay (D-13)', () => {
  test('an overlay naming a secret exits 2 with the overlay message before any request', () => {
    const out = path.join(tmp, 'secret');
    const result = runNightly(['--env-overlay', writeOverlay('secret', { COHERE_API_KEY: 'placeholder' }), '--out', out]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/secrets cannot be set through an overlay/);
    expect(result.stderr).toMatch(/not allowed in --env-overlay: COHERE_API_KEY/);
    expect(fs.existsSync(path.join(out, 'traces.jsonl'))).toBe(false);
  });

  test('an overlay naming a variable outside the RAG-affecting list exits 2', () => {
    const out = path.join(tmp, 'outside');
    const result = runNightly(['--env-overlay', writeOverlay('outside', { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1' }), '--out', out]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/only RAG-affecting names can be overlaid/);
    expect(fs.existsSync(path.join(out, 'traces.jsonl'))).toBe(false);
  });

  test('an empty --env-overlay is refused', () => {
    const result = runNightly(['--env-overlay', ' ', '--out', path.join(tmp, 'empty')]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/--env-overlay must not be empty/);
  });

  test('without the flag no overlay report is written; with it the overlay enters the run and pins still win', () => {
    const plain = path.join(tmp, 'plain');
    const first = runNightly(['--out', plain]);
    expect(first.status, first.stderr).toBe(0);
    expect(fs.existsSync(path.join(plain, 'overlay-report.json'))).toBe(false);
    const plainManifest = readJson(path.join(plain, 'run.json'));

    const overlaid = path.join(tmp, 'overlaid');
    const overlay = writeOverlay('valid', { RAG_PRE_CONTEXT: 'Synthetic instruction text for an overlay test.', OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large' });
    const second = runNightly(['--env-overlay', overlay, '--out', overlaid]);
    expect(second.status, second.stderr).toBe(0);
    const report = readJson(path.join(overlaid, 'overlay-report.json'));
    expect(report.evaluated).toEqual(['RAG_PRE_CONTEXT']);
    expect(report.not_evaluated).toEqual([{ name: 'OPENAI_EMBEDDING_MODEL', reason: 'fixture_embedder' }]);
    expect(JSON.stringify(report)).not.toMatch(/Synthetic instruction text/);
    const overlaidManifest = readJson(path.join(overlaid, 'run.json'));
    expect(overlaidManifest.run_config_hash).not.toEqual(plainManifest.run_config_hash);
    expect(Object.keys(overlaidManifest).sort()).toEqual(Object.keys(plainManifest).sort());
    expect(JSON.stringify(overlaidManifest)).not.toMatch(/Synthetic instruction text/);
    expect(JSON.stringify(overlaidManifest)).not.toMatch(/text-embedding-3-large/);
  });
});
