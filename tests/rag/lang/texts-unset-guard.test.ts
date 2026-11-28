import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEXT_KEYS } from '@/lib/rag/lang/registry';
import { fallbackLanguages, fixedText, type TextKey } from '@/lib/rag/lang/texts';
import { resetLanguageSettingsForTests, setLanguageSettingsTrapForTests } from '@/lib/rag/lang/settings';

// Phase 3.2 integration warning: with RAG_SUPPORTED_LANGUAGES and RAG_PRIMARY_LANGUAGE both unset the text lookup falls back to English
// without reading the language settings (D-02 unset rule).

afterEach(() => {
  setLanguageSettingsTrapForTests(null);
  vi.unstubAllEnvs();
  resetLanguageSettingsForTests();
});

describe('fixedText with the language variables unset', () => {
  it('falls back to English and never reads the language settings', () => {
    vi.stubEnv('RAG_SUPPORTED_LANGUAGES', '');
    vi.stubEnv('RAG_PRIMARY_LANGUAGE', '');
    resetLanguageSettingsForTests();
    setLanguageSettingsTrapForTests(() => {
      throw new Error('language settings read while unset');
    });
    expect(fallbackLanguages('xx')).toEqual(['xx', 'en', 'en']);
    expect(() => fixedText(TEXT_KEYS[0] as TextKey, 'xx', new Proxy({}, { get: () => 'v', has: () => true }) as never)).not.toThrow();
  });

  it('reads the primary language once the variables are set', () => {
    vi.stubEnv('RAG_SUPPORTED_LANGUAGES', 'en,it');
    vi.stubEnv('RAG_PRIMARY_LANGUAGE', 'it');
    resetLanguageSettingsForTests();
    expect(fallbackLanguages(null)).toEqual([null, 'it', 'en']);
  });
});
