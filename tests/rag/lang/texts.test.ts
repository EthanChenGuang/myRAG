import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getLanguageRegistry, resetLanguageRegistryForTests, setLanguageRegistryForTests, TEXT_KEYS } from '@/lib/rag/lang/registry';
import { LanguagePackSchema } from '@/lib/rag-eval/contracts.generated';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { FIXED_TEXTS } from '@/lib/rag/lang/texts.generated';
import { fixedText, MissingTextParameterError, registryPackVersion, type TextKey } from '@/lib/rag/lang/texts';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'config', 'rag', 'language-packs.json');
const raw = (): { packs: Array<Record<string, any>> } => JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const shippedText = (code: string, key: string): string => {
  const [group, name] = key.split('.');
  return raw().packs.find((pack) => pack.code === code)!.texts[group][name];
};

const savedPrimary = process.env.RAG_PRIMARY_LANGUAGE;
const savedSupported = process.env.RAG_SUPPORTED_LANGUAGES;

function setLanguages(supported: string | undefined, primary: string | undefined): void {
  if (supported === undefined) delete process.env.RAG_SUPPORTED_LANGUAGES;
  else process.env.RAG_SUPPORTED_LANGUAGES = supported;
  if (primary === undefined) delete process.env.RAG_PRIMARY_LANGUAGE;
  else process.env.RAG_PRIMARY_LANGUAGE = primary;
  resetLanguageSettingsForTests();
}

afterEach(() => {
  setLanguages(savedSupported, savedPrimary);
  resetLanguageRegistryForTests();
});

describe('fixedText (D-08)', () => {
  it('returns the pack value for the language', () => {
    expect(fixedText('notices.link_removed', 'zh')).toBe('（链接已移除）');
    expect(fixedText('notices.link_removed', 'en')).toBe('(link removed)');
    expect(fixedText('labels.from_web', 'it')).toBe('Dal web');
  });

  it('substitutes named placeholders', () => {
    expect(fixedText('labels.version', 'it', { version: '3' })).toBe('Versione 3');
    expect(fixedText('labels.effective_from', 'en', { date: '2026-01-01' })).toBe('Effective from 2026-01-01');
    expect(fixedText('notices.calc_corrected', 'zh', { value: 'X' })).toBe('计算已复核：正确结果为 X。');
    expect(fixedText('instructions.web_separation', 'en', { from_documents: 'D', from_web: 'W' })).toContain('**D**');
  });

  it('substitutes a parameter value literally, never as a replacement pattern', () => {
    expect(fixedText('labels.version', 'en', { version: '$&$1' })).toBe('Version $&$1');
  });

  it('throws MissingTextParameterError on a missing parameter', () => {
    expect(() => fixedText('labels.version', 'en')).toThrow(MissingTextParameterError);
    expect(() => fixedText('instructions.partial_answer', 'en', { sentinel: 'S' })).toThrow(MissingTextParameterError);
  });

  it('rejects an unknown key at runtime', () => {
    expect(() => fixedText('notices.unknown' as TextKey, 'en')).toThrow(/unknown text key/);
    expect(() => fixedText('constructor' as TextKey, 'en')).toThrow(/unknown text key/);
    expect(() => fixedText('notices.__proto__' as TextKey, 'en')).toThrow(/unknown text key/);
  });

  it.each(['es', '__proto__', 'constructor', 'toString', ''])('falls back to the primary language for %j', (code) => {
    setLanguages('zh,en,it', 'it');
    expect(fixedText('notices.uncited', code)).toBe('Nessuna fonte citata');
  });

  it('falls back to English while the languages are not configured', () => {
    setLanguages(undefined, undefined);
    expect(fixedText('notices.uncited', '__proto__')).toBe('No source cited');
  });

  it('falls back to the primary language when the pack lacks the key', () => {
    const registry = raw();
    delete registry.packs.find((pack) => pack.code === 'zh')!.texts.notices.uncited;
    setLanguageRegistryForTests(registry);
    setLanguages('zh,en,it', 'en');
    expect(fixedText('notices.uncited', 'zh')).toBe('No source cited');
  });

  it('serves every key in every shipped language', () => {
    const keys = Object.entries(raw().packs[0].texts).flatMap(([group, texts]) =>
      Object.keys(texts as Record<string, string>).map((name) => `${group}.${name}`),
    );
    expect(keys).toHaveLength(38);
    const params = { value: 'V', version: 'N', date: 'D', sentinel: 'S', not_covered: 'C', general_knowledge: 'G', from_documents: 'FD', from_web: 'FW' };
    for (const pack of getLanguageRegistry().packs) {
      for (const key of keys) {
        const text = fixedText(key as TextKey, pack.code, params);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/\{[A-Za-z_]+\}/);
        if (!/\{/.test(shippedText(pack.code, key))) expect(text).toBe(shippedText(pack.code, key));
      }
    }
  });

  it('every key has the same placeholders in every language', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z_]+)\}/g)].map((m) => m[1]).sort();
    const [first, ...rest] = raw().packs;
    for (const [group, texts] of Object.entries(first.texts as Record<string, Record<string, string>>)) {
      for (const [name, text] of Object.entries(texts)) {
        for (const pack of rest) expect(placeholders(pack.texts[group][name]), `${pack.code} ${group}.${name}`).toEqual(placeholders(text));
      }
    }
  });

  it('TEXT_KEYS lists exactly the keys of the generated contract', () => {
    const groups = LanguagePackSchema.shape.texts.shape;
    const fromSchema = Object.entries(groups).flatMap(([group, schema]) => Object.keys(schema.shape).map((name) => `${group}.${name}`));
    expect([...TEXT_KEYS].sort()).toEqual(fromSchema.sort());
  });

  it('registryPackVersion joins each pack version in registry order', () => {
    expect(registryPackVersion()).toBe('zh:1,en:1,it:1');
  });

  it('holds no per-language table and does not read process.env', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'rag', 'lang', 'texts.ts'), 'utf8');
    expect(source).not.toMatch(/process\.env/);
    expect(source).toMatch(/getLanguagePack/);
  });
});

describe('FIXED_TEXTS client subset (D-12)', () => {
  it('holds the notices and labels of every shipped language and no instructions', () => {
    expect(Object.keys(FIXED_TEXTS)).toEqual(['zh', 'en', 'it']);
    for (const entry of Object.values(FIXED_TEXTS)) {
      expect(Object.keys(entry).sort()).toEqual(['labels', 'notices']);
      expect(entry).not.toHaveProperty('instructions');
    }
    const source = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'rag', 'lang', 'texts.generated.ts'), 'utf8');
    expect(source).not.toMatch(/instructions|webSearch|calculate tool/);
  });

  it('every value equals fixedText for the same key and language', () => {
    const keys = TEXT_KEYS.filter((key) => !key.startsWith('instructions.'));
    expect(keys).toHaveLength(26);
    for (const [code, entry] of Object.entries(FIXED_TEXTS)) {
      for (const key of keys) {
        const [group, name] = key.split('.') as ['notices' | 'labels', string];
        expect(entry[group][name], `${code} ${key}`).toBe(shippedText(code, key));
      }
    }
    expect(FIXED_TEXTS.zh.notices.link_removed).toBe(fixedText('notices.link_removed', 'zh'));
    expect(FIXED_TEXTS.it.labels.badge_verified).toBe(fixedText('labels.badge_verified', 'it'));
  });
});
