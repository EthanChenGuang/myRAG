import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(REPO_ROOT, 'eval/harness/templated-fixtures.mts');
const LANGUAGES = ['zh', 'en', 'it'] as const;
const TIMEOUT_MS = 120_000;

type Harness = typeof import('../eval/harness/templated-fixtures.mts');

async function harness(): Promise<Harness> {
  expect(fs.existsSync(HARNESS), 'eval/harness/templated-fixtures.mts is missing').toBe(true);
  return (await import('../eval/harness/templated-fixtures.mts')) as Harness;
}

function firstDifference(left: unknown, right: unknown, at = '$'): string | null {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') return `${at}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`;
  const keys = [...new Set([...Object.keys(left as object), ...Object.keys(right as object)])].sort();
  for (const key of keys) {
    const found = firstDifference((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${at}.${key}`);
    if (found) return found;
  }
  return null;
}

describe('templated collection fixtures (03.3-20)', () => {
  test('the loader returns 39 fixtures with config-upload source keys and the five data files', async () => {
    const { loadTemplatedFixtures } = await harness();
    const set = loadTemplatedFixtures(REPO_ROOT);
    const ids = LANGUAGES.flatMap((language) => [
      ...Array.from({ length: 12 }, (_, index) => `tpl-family-${language}-${String(index + 1).padStart(2, '0')}`),
      `tpl-variants-${language}`,
    ]);
    expect(set.fixtures.map((fixture) => fixture.id)).toEqual(ids);
    for (const fixture of set.fixtures) {
      expect(fixture.source_key).toBe(`root/${fixture.id}.pdf`);
      expect(fixture.doc_type).toBe('product_technical');
      expect(fixture.attributes).toEqual(fixture.templated.attributes);
      expect(fs.existsSync(path.join(REPO_ROOT, fixture.path))).toBe(true);
    }
    expect(Object.keys(set.data).sort()).toEqual(['attribute_schema', 'attributes', 'boilerplate_rules', 'header_template', 'section_rules']);
  });

  test(
    'the TypeScript and Python loaders return the same dump',
    async () => {
      const { dumpTemplatedFixtures } = await harness();
      const python = spawnSync('uv', ['run', '--directory', 'eval', 'python', '-m', 'rag_eval.templated_fixtures', 'dump'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(python.status, python.stderr).toBe(0);
      const left = JSON.parse(dumpTemplatedFixtures(REPO_ROOT)) as unknown;
      const right = JSON.parse(python.stdout) as unknown;
      expect(firstDifference(left, right)).toBeNull();
    },
    TIMEOUT_MS,
  );

  test('the loader module holds no regular expression call on fixture data', () => {
    expect(fs.existsSync(HARNESS), 'eval/harness/templated-fixtures.mts is missing').toBe(true);
    const source = fs.readFileSync(HARNESS, 'utf8');
    expect(source).not.toMatch(/new RegExp\(|\.(?:test|exec|match|matchAll|replace|split)\((?!\s*'\\n')/);
  });
});
