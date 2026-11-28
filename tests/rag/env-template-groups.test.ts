import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { groupLabel, orderedGroups } from '../../scripts/rag/gen-pipeline-doc.mjs';

const ROOT = path.resolve(__dirname, '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts/init-env.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/rag/env-manifest.json'), 'utf8')) as {
  vars: { name: string; status: string; group?: string; label?: string }[];
};

function templateLines(): string[] {
  const start = SOURCE.indexOf('return `# myRAG Configuration');
  const end = SOURCE.indexOf('\n`;\n', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end).split('\n');
}

const lines = templateLines();
const isRule = (line: string | undefined) => line !== undefined && line.startsWith('# ----');

/** The title of the nearest section banner (# ---- / # TITLE / # ----) above line i. */
function sectionTitle(i: number): string | null {
  for (let j = i - 1; j > 0; j -= 1) {
    if (isRule(lines[j - 1]) && isRule(lines[j + 1]) && lines[j].startsWith('# ') && !isRule(lines[j])) return lines[j].slice(2);
  }
  return null;
}

function lineOf(name: string): number {
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  expect(index, name).toBeGreaterThan(-1);
  return index;
}

const managed = MANIFEST.vars.filter((entry) => entry.status === 'managed');
const legacy = MANIFEST.vars.filter((entry) => entry.status === 'legacy');

describe('scripts/init-env.js RAG group banners', () => {
  test('at least one banner per manifest group, in the manifest group order', () => {
    const banners = lines.filter((line) => line.startsWith('# RAG: ')).map((line) => line.slice('# RAG: '.length));
    expect(banners).toEqual(orderedGroups(MANIFEST).map((id: string) => groupLabel(id)));
  });

  test.each(managed.map((entry) => [entry.name, entry] as const))('%s sits under its group banner with its label above it', (name, entry) => {
    const i = lineOf(name);
    expect(sectionTitle(i), name).toBe(`RAG: ${groupLabel(entry.group)}`);
    expect(lines[i - 1], name).toBe(`# ${entry.label}`);
  });

  test('legacy variables stay outside the RAG group banners', () => {
    for (const entry of legacy) {
      const index = lines.findIndex((line) => line.startsWith(`${entry.name}=`));
      if (index < 0) continue;
      expect(sectionTitle(index) ?? '', entry.name).not.toMatch(/^RAG: /);
    }
  });

  test('every template assignment appears once', () => {
    const names = lines.map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1]).filter((name): name is string => Boolean(name));
    expect(new Set(names).size).toBe(names.length);
  });
});
