import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { derivePinnedEvalEnv } from '../eval/harness/eval-env.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('pinned eval env', () => {
  test('rag-eval-env.json equals the RAG_* defaults derived from scripts/init-env.js', () => {
    const derived = derivePinnedEvalEnv(fs.readFileSync(path.join(REPO_ROOT, 'scripts/init-env.js'), 'utf8'));
    const pinned = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/config/rag-eval-env.json'), 'utf8'));
    expect(pinned).toEqual(derived);
  });

  test('eval-env --check exits 0', () => {
    const result = spawnSync('npx', ['tsx', 'eval/harness/eval-env.mts', '--check'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.status).toBe(0);
  }, 60_000);
});
