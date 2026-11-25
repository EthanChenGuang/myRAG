import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeLanguageSettings,
  parseLanguageList,
  validateLanguageSettings,
} from '../../config/rag/validate-language-settings.cjs';
import { resetLanguageRegistryForTests, setLanguageRegistryForTests } from '@/lib/rag/lang/registry';
import { getLanguageSettings, resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { expectedResult, loadLangCases, registryForCase } from './helpers/lang-cases';

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

describe('parseLanguageList', () => {
  it('splits, trims, lower-cases ASCII only, drops empties and repeats', () => {
    expect(parseLanguageList(' ZH , en,zh,,')).toEqual(['zh', 'en']);
    expect(parseLanguageList(undefined)).toEqual([]);
    expect(parseLanguageList(['EN', ' it '])).toEqual(['en', 'it']);
  });
});
