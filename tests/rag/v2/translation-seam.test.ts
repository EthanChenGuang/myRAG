import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFixtureTranslator,
  getTranslator,
  resetTranslatorForTests,
  setTranslatorForTests,
  type TranslationTable,
} from '@/lib/rag/query/translate';
import { buildQueryVariants } from '@/lib/rag/query/variants';

const ROOT = path.resolve(__dirname, '../../..');
const TABLE_PATH = path.join(ROOT, 'eval/fixtures/translation-table.json');
const GOLDEN_PATH = path.join(ROOT, 'eval/fixtures/golden.jsonl');
const signal = new AbortController().signal;

interface GoldenRow {
  id: string;
  category: string;
  review_status: string;
  language: string;
  evidence_language: string;
  question: string;
}

function readTable(): TranslationTable {
  return JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as TranslationTable;
}

function crossLingualItems(): GoldenRow[] {
  return fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GoldenRow)
    .filter((row) => row.category === 'cross_lingual' && row.review_status === 'approved');
}

function norm(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim();
}

const CODE_RE = /[A-Z]+[_-][A-Z0-9_-]+|\b[A-Z]{2,}\d+\b/gu;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/gu;
const NUMBER_RE = /\d+(?:[.,]\d+)?\s?%|\b\d+\.\d+\b/gu;
const CAPS_RE = /\b[A-Z]{2,}(?: [A-Z]{2,})*\b/gu;
const TITLE_RE = /\b[A-Z][a-z]+(?: [A-Z][a-z]+){2,}\b/gu;
const HAN_RE = /\p{Script=Han}{4,}/gu;

function protectedTokens(question: string, language: string): string[] {
  const found = new Set<string>();
  for (const re of [CODE_RE, EMAIL_RE, NUMBER_RE, CAPS_RE, TITLE_RE]) {
    for (const match of question.matchAll(re)) found.add(match[0]);
  }
  if (language !== 'zh') for (const match of question.matchAll(HAN_RE)) found.add(match[0]);
  return [...found];
}

describe('buildQueryVariants', () => {
  it('puts the original first, then the translated variant', () => {
    const variants = buildQueryVariants('What is the warranty?', 'en', [{ text: 'Qual è la garanzia?', language: 'it' }]);
    expect(variants).toEqual([
      { text: 'What is the warranty?', language: 'en', kind: 'original' },
      { text: 'Qual è la garanzia?', language: 'it', kind: 'translated' },
    ]);
  });

  it('keeps the original, then provided variants, then translate-stage output', () => {
    const variants = buildQueryVariants(
      'What is the warranty?',
      'en',
      [{ text: 'Qual è la garanzia?', language: 'it' }],
      [{ text: '保修期是多久？', language: 'zh', kind: 'translated' }],
    );
    expect(variants.map((variant) => variant.text)).toEqual(['What is the warranty?', '保修期是多久？', 'Qual è la garanzia?']);
    expect(variants.map((variant) => variant.kind)).toEqual(['original', 'translated', 'translated']);
  });

  it('removes duplicates by text and never lets a provided variant replace the original', () => {
    const variants = buildQueryVariants(
      'What is the warranty?',
      'en',
      [
        { text: 'Qual è la garanzia?', language: 'it' },
        { text: '  qual è la garanzia?  ', language: 'it' },
        { text: 'what is the warranty?', language: 'en' },
      ],
      [{ text: 'Something else', language: 'en', kind: 'original' }],
    );
    expect(variants.map((variant) => variant.text)).toEqual(['What is the warranty?', 'Qual è la garanzia?']);
    expect(variants[0]?.kind).toBe('original');
  });

  it('cuts to three variants', () => {
    const variants = buildQueryVariants('q', 'en', [
      { text: 'a', language: 'it' },
      { text: 'b', language: 'zh' },
      { text: 'c', language: 'it' },
      { text: 'd', language: 'zh' },
    ]);
    expect(variants).toHaveLength(3);
    expect(variants.map((variant) => variant.text)).toEqual(['q', 'a', 'b']);
  });

  it('returns only the original with nothing to add', () => {
    expect(buildQueryVariants('q', null)).toEqual([{ text: 'q', language: null, kind: 'original' }]);
  });
});

describe('translator slot', () => {
  afterEach(() => resetTranslatorForTests());

  it('is the none translator by default and yields no translation', async () => {
    const translator = getTranslator();
    expect(translator.name).toBe('none');
    await expect(translator.translate('What is the warranty?', { signal, sourceLanguage: 'en' })).resolves.toEqual([]);
  });

  it('serves a registered translator until it is reset', async () => {
    const custom = { name: 'custom', translate: async () => [{ text: 'x', language: 'it' }] };
    setTranslatorForTests(custom);
    expect(getTranslator()).toBe(custom);
    resetTranslatorForTests();
    expect(getTranslator().name).toBe('none');
  });
});

describe('fixture translator', () => {
  const table: TranslationTable = {
    version: 1,
    entries: [{ question: 'What is the warranty for XR-2000?', translations: [{ language: 'it', text: 'Qual è la garanzia per XR-2000?' }] }],
  };

  it('returns the table translations for a normalised question and nothing for unknown text', async () => {
    const translator = createFixtureTranslator(table);
    expect(translator.name).toBe('fixture');
    await expect(translator.translate('  WHAT IS THE WARRANTY for XR-2000?  ', { signal, sourceLanguage: 'en' })).resolves.toEqual([
      { language: 'it', text: 'Qual è la garanzia per XR-2000?' },
    ]);
    await expect(translator.translate('An unknown question', { signal, sourceLanguage: 'en' })).resolves.toEqual([]);
  });

  it('rejects a malformed table', () => {
    expect(() => createFixtureTranslator({ version: 2, entries: [] } as unknown as TranslationTable)).toThrow(/translation table/i);
    expect(() =>
      createFixtureTranslator({ version: 1, entries: [{ question: 'q', translations: [{ language: 'it', text: '' }] }] }),
    ).toThrow(/translation table/i);
  });
});

describe('committed translation table', () => {
  it('covers every approved cross_lingual golden question with one translation into the evidence language', () => {
    const table = readTable();
    const byQuestion = new Map(table.entries.map((entry) => [norm(entry.question), entry]));
    const items = crossLingualItems();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const entry = byQuestion.get(norm(item.question));
      expect(entry, `table entry for ${item.id}`).toBeDefined();
      expect(entry?.translations.map((translation) => translation.language), item.id).toEqual([item.evidence_language]);
      expect(entry?.translations[0]?.text.trim().length, item.id).toBeGreaterThan(0);
      expect(norm(entry?.translations[0]?.text ?? ''), item.id).not.toBe(norm(item.question));
    }
  });

  it('has no entry that is not a golden question', () => {
    const questions = new Set(crossLingualItems().map((item) => norm(item.question)));
    for (const entry of readTable().entries) expect(questions.has(norm(entry.question)), entry.question).toBe(true);
  });

  it('keeps codes, emails, percentages, decimals, names and capitalised terms verbatim in every entry', () => {
    const items = crossLingualItems();
    for (const item of items) {
      const entry = readTable().entries.find((row) => norm(row.question) === norm(item.question));
      const text = entry?.translations[0]?.text ?? '';
      for (const token of protectedTokens(item.question, item.language)) {
        expect(text.includes(token), `${item.id} keeps ${token}`).toBe(true);
      }
    }
  });

  it('serves a translation for a golden question through the fixture translator', async () => {
    const translator = createFixtureTranslator(readTable());
    const item = crossLingualItems().find((row) => row.id === 'xl-en-it-03');
    const out = await translator.translate(item?.question ?? '', { signal, sourceLanguage: 'en' });
    expect(out).toHaveLength(1);
    expect(out[0]?.language).toBe('it');
  });
});
