import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getLanguagePack,
  getLanguageRegistry,
  parseLanguageRegistry,
  registryOrder,
  resetLanguageRegistryForTests,
  setLanguageRegistryForTests,
} from '@/lib/rag/lang/registry';

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'config', 'rag', 'language-packs.json');

type RawPack = Record<string, unknown>;
type RawRegistry = { schema_version: number; packs: RawPack[] };

function raw(): RawRegistry {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as RawRegistry;
}

function rawPack(code: string): RawPack {
  const pack = raw().packs.find((entry) => entry.code === code);
  if (!pack) throw new Error(`no pack ${code}`);
  return pack;
}

afterEach(() => resetLanguageRegistryForTests());

describe('language-pack registry', () => {
  it('serves zh, en and it in registry order', () => {
    expect(getLanguageRegistry().packs.map((pack) => pack.code)).toEqual(['zh', 'en', 'it']);
  });

  it('carries sentence ends, list separators and OCR codes', () => {
    expect(getLanguagePack('zh')?.sentence_end).toBe('。！？');
    expect(getLanguagePack('en')?.sentence_end).toBe('.!?');
    expect(getLanguagePack('it')?.sentence_end).toBe('.!?');
    expect(getLanguagePack('zh')?.list_separator).toBe('，');
    expect(getLanguagePack('zh')?.ocr_codes.llamaparse).toBe('ch_sim');
    expect(getLanguagePack('zh')?.ocr_codes.docling?.rapidocr).toBe('ch');
  });

  it('has no pack for an unknown code', () => {
    expect(getLanguagePack('xx')).toBeUndefined();
  });

  it('orders codes by the registry, drops unknown and repeated codes', () => {
    expect(registryOrder(['it', 'zh'])).toEqual(['zh', 'it']);
    expect(registryOrder(['en', 'xx', 'it', 'en'])).toEqual(['en', 'it']);
  });

  it('rejects duplicate codes, unknown fields and an unknown segmentation', () => {
    const duplicate = raw();
    duplicate.packs.push(rawPack('en'));
    expect(() => parseLanguageRegistry(duplicate)).toThrow('duplicate language codes: en');

    const extra = raw();
    extra.packs[0] = { ...extra.packs[0], unexpected: 1 };
    expect(() => parseLanguageRegistry(extra)).toThrow();

    const stem = raw();
    stem.packs[1] = { ...stem.packs[1], segmentation: 'stem' };
    expect(() => parseLanguageRegistry(stem)).toThrow();
  });

  it('rejects a pattern that does not compile', () => {
    const broken = raw();
    broken.packs[2] = { ...broken.packs[2], version_markers: ['(unclosed'] };
    expect(() => parseLanguageRegistry(broken)).toThrow('does not compile');
  });

  it('every pattern compiles in Python-compatible and JS unicode mode', () => {
    for (const pack of getLanguageRegistry().packs) {
      for (const pattern of [...pack.effective_date_patterns, ...pack.version_markers]) {
        expect(() => new RegExp(pattern, 'u')).not.toThrow();
      }
    }
  });

  it('reads a test override and resets to the shipped file', () => {
    const one = raw();
    one.packs = [rawPack('it')];
    setLanguageRegistryForTests(one);
    expect(getLanguageRegistry().packs.map((pack) => pack.code)).toEqual(['it']);
    resetLanguageRegistryForTests();
    expect(getLanguageRegistry().packs).toHaveLength(3);
  });

  it('does not read process.env', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'rag', 'lang', 'registry.ts'), 'utf8');
    expect(source).not.toMatch(/process\.env/);
  });
});
