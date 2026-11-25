import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = process.cwd();
const PROVIDER = '@ai-sdk/anthropic';
const PROVIDER_VERSION = '3.0.143';
const AI_VERSION = '6.0.3';

interface PackageJson {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface LockEntry {
  version?: string;
  integrity?: string;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as T;
}

describe('Anthropic provider pin (D-09)', () => {
  test('package.json pins the provider exactly, with no range', () => {
    const pkg = readJson<PackageJson>('package.json');
    expect(pkg.dependencies?.[PROVIDER]).toBe(PROVIDER_VERSION);
  });

  test('package-lock.json resolves the pinned version with an integrity hash', () => {
    const lock = readJson<{ packages: Record<string, LockEntry> }>('package-lock.json');
    const entry = lock.packages[`node_modules/${PROVIDER}`];
    expect(entry?.version).toBe(PROVIDER_VERSION);
    expect(entry?.integrity).toMatch(/^sha512-/);
    expect(lock.packages['']).toBeDefined();
  });

  test('ai stays on 6.0.3', () => {
    const installed = readJson<PackageJson>('node_modules/ai/package.json');
    expect(installed.version).toBe(AI_VERSION);
    const lock = readJson<{ packages: Record<string, LockEntry> }>('package-lock.json');
    expect(lock.packages['node_modules/ai']?.version).toBe(AI_VERSION);
  });

  test('the direct Anthropic SDK is not a dependency', () => {
    const pkg = readJson<PackageJson>('package.json');
    expect(pkg.dependencies?.['@anthropic-ai/sdk']).toBeUndefined();
    expect(pkg.devDependencies?.['@anthropic-ai/sdk']).toBeUndefined();
  });

  test('createAnthropic builds a v3 language model', async () => {
    let mod: { createAnthropic?: (opts: { apiKey: string; baseURL: string }) => (id: string) => { specificationVersion: string } } = {};
    try {
      mod = await import(/* @vite-ignore */ PROVIDER);
    } catch {
      mod = {};
    }
    expect(typeof mod.createAnthropic).toBe('function');
    const provider = mod.createAnthropic!({ apiKey: 'test-key', baseURL: 'http://127.0.0.1:9/v1' });
    expect(provider('claude-test').specificationVersion).toBe('v3');
  });
});
