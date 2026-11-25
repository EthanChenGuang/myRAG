import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));

interface NextConfigShape {
  serverExternalPackages?: string[];
  reactCompiler?: boolean;
  turbopack?: { root?: string };
}

function loadNextConfig(): NextConfigShape {
  const configPath = path.join(ROOT, 'next.config.js');
  delete require.cache[configPath];
  return require(configPath) as NextConfigShape;
}

function nextBuiltInExternals(): string[] {
  const listPath = path.join(ROOT, 'node_modules/next/dist/lib/server-external-packages.jsonc');
  const text = readFileSync(listPath, 'utf8')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
    .replace(/,(\s*])/g, '$1');
  return JSON.parse(text) as string[];
}

function binaryFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 4) return out;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) binaryFiles(full, depth + 1, out);
    else if (/\.(wasm|node)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function importsPackage(source: string, pkg: string): boolean {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const pattern = new RegExp(`(?:from\\s+|import\\(\\s*|require\\(\\s*)['"]${escaped}(?:/[^'"]*)?['"]`);
  return pattern.test(source);
}

describe('next.config.js server externals', () => {
  it('lists tiktoken in serverExternalPackages so its WASM binary loads from node_modules', () => {
    const config = loadNextConfig();
    expect(config.serverExternalPackages ?? []).toContain('tiktoken');
  });

  it('keeps the React Compiler and Turbopack root settings', () => {
    const config = loadNextConfig();
    expect(config.reactCompiler).toBe(true);
    expect(config.turbopack?.root).toBe(ROOT);
  });

  it('externalizes every dependency imported from src/ that ships a .wasm or native .node binary', () => {
    const config = loadNextConfig();
    const externals = new Set([...(config.serverExternalPackages ?? []), ...nextBuiltInExternals()]);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const sources = sourceFiles(path.join(ROOT, 'src')).map((file) => readFileSync(file, 'utf8'));

    const binaryDeps = Object.keys(pkg.dependencies ?? {}).filter((name) => {
      if (name === 'next') return false;
      const dir = path.join(ROOT, 'node_modules', name);
      return existsSync(dir) && binaryFiles(dir).length > 0;
    });
    expect(binaryDeps).toContain('tiktoken');

    const missing = binaryDeps.filter(
      (name) => !externals.has(name) && sources.some((source) => importsPackage(source, name)),
    );
    expect(missing).toEqual([]);
  });
});
