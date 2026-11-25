import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeLanguageSettings,
  parseLanguageList,
  validateLanguageSettings,
} from '../../config/rag/validate-language-settings.cjs';
import {
  completePacks,
  packMissingParts,
  parseLanguageRegistry,
  resetLanguageRegistryForTests,
  setLanguageRegistryForTests,
  type LanguagePack,
} from '@/lib/rag/lang/registry';
import { getLanguageSettings, resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { expectedResult, loadLangCases, registryForCase, shippedRegistry } from './helpers/lang-cases';

const COMPLETENESS_CASES = path.resolve(__dirname, '..', 'fixtures', 'rag', 'language-pack-completeness-cases.json');

const VARS = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'] as const;
const saved: Partial<Record<(typeof VARS)[number], string | undefined>> = {};

function setRaw(supported: string | null | undefined, primary: string | null | undefined): void {
  if (supported === null || supported === undefined) delete process.env.RAG_SUPPORTED_LANGUAGES;
  else process.env.RAG_SUPPORTED_LANGUAGES = supported;
  if (primary === null || primary === undefined) delete process.env.RAG_PRIMARY_LANGUAGE;
  else process.env.RAG_PRIMARY_LANGUAGE = primary;
  resetLanguageSettingsForTests();
}

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetLanguageSettingsForTests();
  resetLanguageRegistryForTests();
});

describe('validate-language-settings.cjs cases', () => {
  for (const entry of loadLangCases()) {
    it(`validator: ${entry.name}`, () => {
      const registry = registryForCase(entry);
      const result = validateLanguageSettings(
        { supported: entry.supported, primary: entry.primary },
        { registry, reranker: entry.context.reranker, embeddingProfile: entry.context.embeddingProfile },
      );
      expect(result).toEqual(expectedResult(entry));
      if (result.normalized) {
        const again = validateLanguageSettings(
          { supported: result.normalized.supported, primary: result.normalized.primary },
          { registry, reranker: entry.context.reranker, embeddingProfile: entry.context.embeddingProfile },
        );
        expect(again).toEqual(result);
      }
    });

    if (entry.expect.settings) {
      const settings = entry.expect.settings;
      it(`settings reader: ${entry.name}`, () => {
        if (entry.context.registryChange) setLanguageRegistryForTests(registryForCase(entry));
        setRaw(entry.supported, entry.primary);
        expect(getLanguageSettings()).toEqual(settings);
        expect(normalizeLanguageSettings(entry.supported, entry.primary, registryForCase(entry))).toEqual(settings);
      });
    }
  }
});

describe('getLanguageSettings', () => {
  it('reads the raw variables and caches until reset', () => {
    setRaw('en', 'en');
    expect(getLanguageSettings()).toEqual({ configured: true, languages: ['en'], primary: 'en', monolingual: true });
    process.env.RAG_SUPPORTED_LANGUAGES = 'zh,en';
    expect(getLanguageSettings().languages).toEqual(['en']);
    resetLanguageSettingsForTests();
    expect(getLanguageSettings().languages).toEqual(['zh', 'en']);
  });

  it('never throws on a value it cannot use', () => {
    setRaw('%%%,', '\u0000');
    expect(() => getLanguageSettings()).not.toThrow();
    expect(getLanguageSettings().configured).toBe(false);
  });
});

describe('pack completeness agrees with registry.ts', () => {
  const completeness = JSON.parse(fs.readFileSync(COMPLETENESS_CASES, 'utf8')) as {
    cases: Array<{ name: string; base: string; change: { op: 'set' | 'delete'; path: string[]; value?: unknown } }>;
  };
  for (const entry of completeness.cases) {
    it(`incomplete_pack for ${entry.name}`, () => {
      const registry = registryForCase({
        name: entry.name,
        supported: null,
        primary: null,
        context: { reranker: null, embeddingProfile: null, registryChange: { base: entry.base, ...entry.change } },
        expect: { ok: false, errors: [], warnings: [], verifiedAgainstActiveProfile: false, normalized: null },
      });
      const pack = parseLanguageRegistry(registry).packs.find((candidate) => candidate.code === entry.base) as LanguagePack;
      expect(packMissingParts(pack).length).toBeGreaterThan(0);
      const result = validateLanguageSettings({ supported: entry.base, primary: entry.base }, { registry });
      expect(result.errors).toEqual([{ code: 'incomplete_pack', language: entry.base }]);
    });
  }

  it('the shipped packs are complete for both', () => {
    const result = validateLanguageSettings({ supported: 'zh,en,it', primary: 'zh' }, { registry: shippedRegistry() });
    expect(result.ok).toBe(true);
    expect(completePacks().map((pack) => pack.code)).toEqual(['zh', 'en', 'it']);
  });
});

describe('the validator never repairs a choice', () => {
  it('leaves the candidate untouched and returns no normalized value on refusal', () => {
    const candidate = { supported: ' IT,zh-CN ', primary: 'zh' };
    const before = JSON.stringify(candidate);
    const result = validateLanguageSettings(candidate, { registry: shippedRegistry() });
    expect(JSON.stringify(candidate)).toBe(before);
    expect(result.ok).toBe(false);
    expect(result.normalized).toBeNull();
  });
});

describe('parseLanguageList', () => {
  it('splits, trims, lower-cases ASCII only, drops empties and repeats', () => {
    expect(parseLanguageList(' ZH , en,zh,,')).toEqual(['zh', 'en']);
    expect(parseLanguageList(undefined)).toEqual([]);
    expect(parseLanguageList(['EN', ' it '])).toEqual(['en', 'it']);
  });
});
