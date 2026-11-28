import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadRunConfig, parseRunConfig, RunConfigError } from '../eval/harness/run-config.mts';

const RUNS_DIR = path.join(__dirname, '..', 'eval', 'config', 'runs');

const SWITCHES_OFF = {
  RAG_SECTION_RULES: 'off',
  RAG_PAGE_BOILERPLATE: 'off',
  RAG_DOC_ATTRIBUTES: 'false',
  RAG_ATTRIBUTE_HEADER: 'false',
  RAG_ATTRIBUTE_FILTER: 'off',
  RAG_LEXICAL_QUANTITY: 'false',
};
const V2_OFF = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_EXACT_SCAN_CUTOFF: '5000', ...SWITCHES_OFF };

const EXPECTED: Record<string, Record<string, string>> = {
  'tpl-all-off': SWITCHES_OFF,
  'tpl-v2-off': V2_OFF,
  'tpl-recommended': {
    ...V2_OFF,
    RAG_SECTION_RULES: 'on',
    RAG_PAGE_BOILERPLATE: 'both',
    RAG_DOC_ATTRIBUTES: 'true',
    RAG_ATTRIBUTE_HEADER: 'true',
    RAG_ATTRIBUTE_FILTER: 'hard',
    RAG_LEXICAL_QUANTITY: 'true',
  },
  'tpl-only-boilerplate': { ...V2_OFF, RAG_PAGE_BOILERPLATE: 'both' },
  'tpl-only-section-rules': { ...V2_OFF, RAG_SECTION_RULES: 'on' },
  'tpl-only-attributes': { ...V2_OFF, RAG_DOC_ATTRIBUTES: 'true' },
  'tpl-only-header': { ...V2_OFF, RAG_DOC_ATTRIBUTES: 'true', RAG_ATTRIBUTE_HEADER: 'true' },
  'tpl-only-filter-hard': { ...V2_OFF, RAG_DOC_ATTRIBUTES: 'true', RAG_ATTRIBUTE_FILTER: 'hard' },
  'tpl-only-filter-soft': { ...V2_OFF, RAG_DOC_ATTRIBUTES: 'true', RAG_ATTRIBUTE_FILTER: 'soft' },
  'tpl-only-quantity': { ...V2_OFF, RAG_LEXICAL_QUANTITY: 'true' },
  'tpl-only-identifier-feed': { ...V2_OFF, RAG_DOC_ATTRIBUTES: 'true', RAG_IDENTIFIER_INDEX: 'true' },
};

describe('Phase 3.3 run configs (plan 03.3-22, D-03, D-30, D-36)', () => {
  test('exactly the eleven tpl configs exist', () => {
    const found = fs.readdirSync(RUNS_DIR).filter((name) => name.startsWith('tpl-') && name.endsWith('.json'));
    expect(found.sort()).toEqual(Object.keys(EXPECTED).map((name) => `${name}.json`).sort());
  });

  for (const [name, env] of Object.entries(EXPECTED)) {
    test(`${name} sets exactly its switches`, () => {
      const file = path.join(RUNS_DIR, `${name}.json`);
      expect(fs.existsSync(file), `${name}.json is missing`).toBe(true);
      if (!fs.existsSync(file)) return;
      const config = loadRunConfig(file);
      expect(config.name).toBe(name);
      expect(config.env).toEqual(env);
      expect(config.overrides).toBeNull();
    });
  }

  test('a name outside the allowlist is rejected', () => {
    expect(() =>
      parseRunConfig({ name: 'tpl-extra', env: { ...V2_OFF, RAG_TEMPLATED_UNKNOWN: 'on' }, overrides: null }, 'inline'),
    ).toThrow(RunConfigError);
  });
});
