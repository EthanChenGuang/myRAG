import { describe, expect, test } from 'vitest';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { effectiveIngestSettings, type EffectiveIngestSettingsInput } from '@/lib/rag/ingest/routing/effective-settings';

const DOC_TYPES = ['general', 'financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image'] as const;
const DEFAULTS: EffectiveIngestSettingsInput['ingestConfig'] = { languageAwareIngest: 'off', tableHeaderRepeat: 'profile', tableRowSerialization: false };
const UNSET = { configured: false, languages: [], primary: null } as const;

const configured = (languages: string[], primary: string) => ({ configured: true, languages, primary });

function settings(overrides: Partial<EffectiveIngestSettingsInput> = {}) {
  return effectiveIngestSettings({ ingestConfig: DEFAULTS, profile: getProcessingProfile('general'), languageSettings: UNSET, ...overrides });
}

describe('effectiveIngestSettings: OCR languages (D-17)', () => {
  test('languages unset: the profile list, no LlamaParse languages, every switch at its default', () => {
    expect(settings()).toEqual({
      ocrLanguages: ['zh', 'en', 'it'],
      ocrPrimaryLanguage: null,
      llamaparseLanguages: [],
      languageAware: false,
      languages: [],
      primaryLanguage: null,
      repeatTableHeader: false,
      repeatTableHeaderForced: false,
      carryTableHeader: false,
      rowSerialization: false,
    });
  });

  test('configured zh,it with primary it: registry order for Docling, primary first with LlamaParse codes', () => {
    const effective = settings({ languageSettings: configured(['zh', 'it'], 'it') });
    expect(effective.ocrLanguages).toEqual(['zh', 'it']);
    expect(effective.ocrPrimaryLanguage).toBe('it');
    expect(effective.llamaparseLanguages).toEqual(['it', 'ch_sim']);
  });

  test('it,zh and zh,it give the same ocrLanguages (registry order, never the typed order)', () => {
    const typed = settings({ languageSettings: configured(['it', 'zh'], 'zh') });
    const other = settings({ languageSettings: configured(['zh', 'it'], 'zh') });
    expect(typed.ocrLanguages).toEqual(['zh', 'it']);
    expect(other.ocrLanguages).toEqual(typed.ocrLanguages);
    expect(typed.llamaparseLanguages).toEqual(['ch_sim', 'it']);
  });

  test('the primary goes first in the LlamaParse list and the rest keep registry order', () => {
    expect(settings({ languageSettings: configured(['it', 'en', 'zh'], 'it') }).llamaparseLanguages).toEqual(['it', 'ch_sim', 'en']);
    expect(settings({ languageSettings: configured(['zh', 'en', 'it'], 'en') }).llamaparseLanguages).toEqual(['en', 'ch_sim', 'it']);
  });

  test('a supported set equal to the profile list gives the same Docling list as the fallback', () => {
    expect(settings({ languageSettings: configured(['it', 'en', 'zh'], 'en') }).ocrLanguages).toEqual(settings().ocrLanguages);
  });

  test('one supported language gives a one-element list', () => {
    const effective = settings({ languageSettings: configured(['it'], 'it') });
    expect(effective.ocrLanguages).toEqual(['it']);
    expect(effective.llamaparseLanguages).toEqual(['it']);
  });

  test('the profile list is never edited', () => {
    const profile = getProcessingProfile('general');
    const before = [...profile.parser.ocr_languages];
    const effective = settings({ profile, languageSettings: configured(['it'], 'it') });
    effective.ocrLanguages.push('zh');
    expect(profile.parser.ocr_languages).toEqual(before);
  });

  test('a configured flag with no usable language falls back to the profile and sends no LlamaParse languages', () => {
    const effective = settings({ languageSettings: { configured: true, languages: ['xx'], primary: 'xx' } });
    expect(effective.ocrLanguages).toEqual(['zh', 'en', 'it']);
    expect(effective.ocrPrimaryLanguage).toBeNull();
    expect(effective.llamaparseLanguages).toEqual([]);
  });
});

describe('effectiveIngestSettings: table and language-aware switches (D-19, D-22)', () => {
  test.each(DOC_TYPES)('profile mode keeps the profile flag for %s', (docType) => {
    const profile = getProcessingProfile(docType);
    const effective = settings({ profile });
    expect(effective.repeatTableHeader).toBe(profile.chunker.repeat_table_header);
    expect(effective.repeatTableHeaderForced).toBe(false);
    expect(effective.carryTableHeader).toBe(false);
  });

  test.each(DOC_TYPES)('always repeats and carries the header for %s', (docType) => {
    const effective = settings({ profile: getProcessingProfile(docType), ingestConfig: { ...DEFAULTS, tableHeaderRepeat: 'always' } });
    expect(effective.repeatTableHeader).toBe(true);
    expect(effective.repeatTableHeaderForced).toBe(true);
    expect(effective.carryTableHeader).toBe(true);
  });

  test('language-aware on carries the configured languages in registry order and the primary', () => {
    const effective = settings({ ingestConfig: { ...DEFAULTS, languageAwareIngest: 'on' }, languageSettings: configured(['it', 'zh'], 'it') });
    expect(effective.languageAware).toBe(true);
    expect(effective.languages).toEqual(['zh', 'it']);
    expect(effective.primaryLanguage).toBe('it');
  });

  test('language-aware off carries no languages even when they are configured', () => {
    const effective = settings({ languageSettings: configured(['zh', 'it'], 'it') });
    expect(effective.languageAware).toBe(false);
    expect(effective.languages).toEqual([]);
    expect(effective.primaryLanguage).toBeNull();
  });

  test('row serialization follows its switch', () => {
    expect(settings({ ingestConfig: { ...DEFAULTS, tableRowSerialization: true } }).rowSerialization).toBe(true);
  });
});
