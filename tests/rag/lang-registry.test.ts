import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPLETENESS_PARTS,
  completePacks,
  getLanguagePack,
  getLanguageRegistry,
  packMissingParts,
  parseLanguageRegistry,
  registryOrder,
  resetLanguageRegistryForTests,
  setLanguageRegistryForTests,
  type LanguagePack,
} from '@/lib/rag/lang/registry';

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'config', 'rag', 'language-packs.json');
const CASES_PATH = path.join(ROOT, 'tests', 'fixtures', 'rag', 'language-pack-completeness-cases.json');

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

type CompletenessCase = {
  name: string;
  base: string;
  change: { op: 'set' | 'delete'; path: string[]; value?: unknown };
  missing: string[];
};

const CASES = (JSON.parse(fs.readFileSync(CASES_PATH, 'utf8')) as { cases: CompletenessCase[] }).cases;

function applyChange(pack: RawPack, change: CompletenessCase['change']): RawPack {
  const parents = change.path.slice(0, -1);
  const leaf = change.path[change.path.length - 1]!;
  let target = pack as Record<string, unknown>;
  for (const key of parents) target = target[key] as Record<string, unknown>;
  if (change.op === 'delete') delete target[leaf];
  else target[leaf] = change.value;
  return pack;
}

describe('pack completeness (D-04), same cases as rag-sidecar/tests/test_language_registry.py', () => {
  it('every shipped pack is complete', () => {
    expect(completePacks().map((pack) => pack.code)).toEqual(['zh', 'en', 'it']);
  });

  it('the shared cases cover every part once', () => {
    expect(CASES.map((entry) => entry.missing[0]).sort()).toEqual([...COMPLETENESS_PARTS].sort());
    expect(CASES.every((entry) => entry.missing.length === 1)).toBe(true);
  });

  it.each(CASES.map((entry) => [entry.name, entry] as const))('%s is reported incomplete', (_name, entry) => {
    const registry = raw();
    registry.packs = [applyChange(rawPack(entry.base), entry.change)];
    const pack: LanguagePack = parseLanguageRegistry(registry).packs[0]!;
    expect(packMissingParts(pack)).toEqual(entry.missing);
  });
});
