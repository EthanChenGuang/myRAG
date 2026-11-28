import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import { QUANTITY_TOKEN_PREFIX, type LexicalOptions } from '@/lib/rag/lexical/options';
import { buildQuantityUnits, quantityTokens } from '@/lib/rag/lexical/quantity';
import {
  LEXICAL_VERSION,
  MAX_ADDITIVE_QUERY_TOKENS,
  identifierLexicalLookupForms,
  lexicalRegistryRules,
  lexicalText,
  lexicalTokens,
  queryLexicalTokens,
} from '@/lib/rag/lexical/tokenize';
import { parseLanguageRegistry } from '@/lib/rag/lang/registry';

// D-31: pure matcher on normalised text. Synthetic numbers, general symbols and invented words only.
const BLOCK = {
  unit_symbols: ['kg', 'g', 'mg', 'l', 'ml', 'm', 'mm', 'min', '%', 'kwh', 'μm', '°c'],
  decimal_separators: ['.', ','],
  grouping_separators: ['.', ','],
};
const UNITS = buildQuantityUnits(BLOCK);

describe('quantity token prefix', () => {
  it('is _q_, distinct from the dictionary and stem prefixes', () => {
    expect(QUANTITY_TOKEN_PREFIX).toBe('_q_');
  });
});

describe('one quantity, many spellings (D-31)', () => {
  it.each([
    ['2.5 kg', ['_q_2.5kg']],
    ['2,5 kg', ['_q_2.5kg']],
    ['2.5kg', ['_q_2.5kg']],
    ['2,5kg', ['_q_2.5kg']],
    ['2,50 kg', ['_q_2.5kg']],
    ['2.50kg', ['_q_2.5kg']],
    ['1.250,5 ml', ['_q_1250.5ml']],
    ['1,250.5 ml', ['_q_1250.5ml']],
    ['10 %', ['_q_10%']],
    ['10%', ['_q_10%']],
    ['0,75 l', ['_q_0.75l']],
    ['007 g', ['_q_7g']],
    ['3.0 kg', ['_q_3kg']],
    ['0.0 g', ['_q_0g']],
    ['2.5 kg', ['_q_2.5kg']],
    ['5 min', ['_q_5min']],
    ['5 mm', ['_q_5mm']],
    ['12 kwh', ['_q_12kwh']],
    ['4 μm', ['_q_4μm']],
    ['21 °c', ['_q_21°c']],
  ])('%s', (text, expected) => {
    expect(quantityTokens(text, UNITS)).toEqual(expected);
  });

  it('emits one token per occurrence in order of appearance', () => {
    expect(quantityTokens('zento 3 kg, prisma 4,5 l and 3kg', UNITS)).toEqual(['_q_3kg', '_q_4.5l', '_q_3kg']);
  });

  it('accepts a unit at the end of the text and before punctuation or a digit', () => {
    expect(quantityTokens('9 g', UNITS)).toEqual(['_q_9g']);
    expect(quantityTokens('(9 g).', UNITS)).toEqual(['_q_9g']);
  });

  it('accepts a Han character on either side of a quantity', () => {
    expect(quantityTokens('星2.5kg蓝', UNITS)).toEqual(['_q_2.5kg']);
  });
});

describe('ambiguous separators (D-31)', () => {
  it.each([
    ['1.250 ml', ['_q_1.25ml', '_q_1250ml']],
    ['1,250 ml', ['_q_1.25ml', '_q_1250ml']],
    ['0,750 l', ['_q_0.75l']],
    ['1.250.000 g', ['_q_1250000g']],
    ['1,250,000 g', ['_q_1250000g']],
    ['1,2505 g', ['_q_1.2505g']],
  ])('%s', (text, expected) => {
    expect(quantityTokens(text, UNITS)).toEqual(expected);
  });

  it('rejects malformed grouping', () => {
    expect(quantityTokens('1.25.0 g', UNITS)).toEqual([]);
    expect(quantityTokens('1.250.5 g', UNITS)).toEqual([]);
    expect(quantityTokens('1.250,000.5 g', UNITS)).toEqual([]);
    expect(quantityTokens('1234.567,5 g', UNITS)).toEqual([]);
  });
});

describe('not matched', () => {
  it.each([
    ['a number without a unit', '42 zento'],
    ['a unit without a number', 'kg ml %'],
    ['a word that only starts with a unit symbol', '5 grano'],
    ['a longer word that starts with a unit symbol', '5 kgx'],
    ['digits that follow a letter directly', 'zento5 kg'],
    ['a symbol that is not in the table', '5 qx'],
    ['a trailing separator before the unit', '5. kg'],
  ])('%s', (_label, text) => {
    expect(quantityTokens(text, UNITS)).toEqual([]);
  });

  it('returns nothing with an empty table', () => {
    expect(quantityTokens('2.5 kg', buildQuantityUnits(null))).toEqual([]);
    expect(quantityTokens('2.5 kg', buildQuantityUnits(undefined))).toEqual([]);
  });
});

describe('tenant aliases are literals (D-32)', () => {
  it('maps number plus an alias word to the token of its symbol', () => {
    const units = buildQuantityUnits(BLOCK, { zentogram: 'g', 'Prisma Litro': 'l' });
    expect(quantityTokens('3 zentogram', units)).toEqual(['_q_3g']);
    expect(quantityTokens('0,5 prisma litro', units)).toEqual(['_q_0.5l']);
  });

  it('ignores an alias whose symbol is not in the table', () => {
    const units = buildQuantityUnits(BLOCK, { zentoqua: 'qx' });
    expect(quantityTokens('3 zentoqua', units)).toEqual([]);
  });

  it('treats regular-expression characters in an alias as plain text', () => {
    const units = buildQuantityUnits(BLOCK, { 'z.+': 'g' });
    expect(quantityTokens('3 z.+', units)).toEqual(['_q_3g']);
    expect(quantityTokens('3 zzz', units)).toEqual([]);
  });

  it('keeps the shipped symbol when an alias spells the same key', () => {
    const units = buildQuantityUnits(BLOCK, { kg: 'g' });
    expect(quantityTokens('3 kg', units)).toEqual(['_q_3kg']);
  });
});

describe('limits (T-03.3-901)', () => {
  it('skips a number longer than 24 characters', () => {
    expect(quantityTokens(`${'1'.repeat(25)} g`, UNITS)).toEqual([]);
    expect(quantityTokens(`${'1'.repeat(24)} g`, UNITS)).toEqual([`_q_${'1'.repeat(24)}g`]);
  });

  it('drops a token longer than 64 characters instead of cutting it', () => {
    const word = 'zentoprismalunghissimaparolainventatachenonfiniscemaiperdavvero';
    const units = buildQuantityUnits(BLOCK, { [word]: 'kwh' });
    expect(word.length).toBeGreaterThan(40);
    const tokens = quantityTokens(`${'9'.repeat(24)} ${word}`, units);
    expect(tokens.every((token) => token.length <= 64)).toBe(true);
    expect(quantityTokens(`${'9'.repeat(24)} kwh`, units)).toEqual([`_q_${'9'.repeat(24)}kwh`]);
  });

  it('scans a long run of digits and separators in linear time', () => {
    const run = '1.2,'.repeat(2500);
    const started = performance.now();
    expect(quantityTokens(`${run} kg ${run}5 kg`, UNITS)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('table rules', () => {
  it('compares symbols in NFKC lower-case form', () => {
    const units = buildQuantityUnits({ ...BLOCK, unit_symbols: ['KG', 'µm'] });
    expect(quantityTokens('3 kg', units)).toEqual(['_q_3kg']);
    expect(quantityTokens('3 μm', units)).toEqual(['_q_3μm']);
  });

  it.each([
    ['whitespace', 'k g'],
    ['a quote', 'k"'],
    ['an apostrophe', "k'"],
    ['a backslash', 'k\\'],
    ['a digit', 'k2'],
  ])('throws on a symbol with %s, naming the index only', (_label, symbol) => {
    let message = '';
    try {
      buildQuantityUnits({ ...BLOCK, unit_symbols: ['g', symbol] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/unit symbol 1\b/u);
    expect(message).not.toContain(symbol);
  });
});

// Tokenizer option (Task 3)
const ROOT = path.resolve(__dirname, '..', '..');
const ON: LexicalOptions = { quantity: true };

// RESEARCH "Tokenizer probe on trunk": today's output, pinned as literals.
const PROBE: Array<[string, string[], string[]]> = [
  ['2.5 kg', ['2.5', '25', '2.5', 'kg'], ['2.5', '25', 'kg']],
  ['2,5 kg', ['2', '5', 'kg'], ['2', '5', 'kg']],
  ['2.5kg', ['2.5kg', '25kg', '2.5kg'], ['2.5kg', '25kg']],
  ['2,5kg', ['2', '5kg'], ['2', '5kg']],
  ['1.250,5 ml', ['1.250', '1250', '1.250', '5', 'ml'], ['1.250', '1250', '5', 'ml']],
  ['1,250.5 ml', ['1', '250.5', '2505', '250.5', 'ml'], ['1', '250.5', '2505', 'ml']],
  ['10 %', ['10'], ['10']],
  ['10%', ['10'], ['10']],
  ['0,75 L', ['0', '75'], ['0', '75']],
];

const OFF_FORMS: Array<[string, LexicalOptions | undefined]> = [
  ['absent', undefined],
  ['undefined', { quantity: undefined }],
  ['null', { quantity: null }],
  ['false', { quantity: false }],
];

describe('tokenizer: off identity on the probe table (D-05)', () => {
  for (const [label, options] of OFF_FORMS) {
    it.each(PROBE)(`quantity ${label}: %s`, (text, index, query) => {
      expect(lexicalTokens(text, options)).toEqual(index);
      expect(queryLexicalTokens(text, options)).toEqual(query);
    });
  }

  it('keeps LEXICAL_VERSION at 2', () => {
    expect(LEXICAL_VERSION).toBe(2);
  });
});

describe('tokenizer: quantity on (D-31)', () => {
  it('appends the quantity token after every token produced without the option', () => {
    expect(lexicalTokens('2.5 kg', ON)).toEqual(['2.5', '25', '2.5', 'kg', '_q_2.5kg']);
    expect(lexicalTokens('10 %', ON)).toEqual(['10', '_q_10%']);
    expect(lexicalTokens('0,75 L', ON)).toEqual(['0', '75', '_q_0.75l']);
  });

  it.each(PROBE)('keeps every off token for %s', (text, index) => {
    const on = lexicalTokens(text, ON);
    expect(on.slice(0, index.length)).toEqual(index);
    expect(on.slice(index.length).every((token) => token.startsWith('_q_'))).toBe(true);
    expect(on.length).toBeGreaterThan(index.length);
  });

  it('gives the four spellings of one quantity one shared token on both sides', () => {
    for (const text of ['2.5 kg', '2,5 kg', '2.5kg', '2,5KG']) {
      expect(lexicalTokens(text, ON)).toContain('_q_2.5kg');
      expect(queryLexicalTokens(text, ON)).toContain('_q_2.5kg');
    }
    expect(lexicalTokens('1.250,5 ml', ON).at(-1)).toBe('_q_1250.5ml');
    expect(lexicalTokens('1,250.5 ML', ON).at(-1)).toBe('_q_1250.5ml');
  });

  it('emits both readings after an ambiguous number, decimal first', () => {
    expect(lexicalTokens('1.250 ml', ON).slice(-2)).toEqual(['_q_1.25ml', '_q_1250ml']);
  });

  it('index side: natural, then dictionary, then quantity tokens, one per occurrence', () => {
    const dictionary = { version: 's1.w1', match: () => [{ term: 'zento prisma' }] };
    const tokens = lexicalTokens('zento prisma 3 kg e 3 kg', { quantity: true, dictionary });
    expect(tokens).toEqual(['zento', 'prisma', '3', 'kg', '3', 'kg', '_t_zento_prisma', '_q_3kg', '_q_3kg']);
  });

  it('query side: dictionary, quantity, stem, deduplicated', () => {
    const dictionary = { version: 's1.w1', match: () => [{ term: 'zento prisma' }] };
    const tokens = queryLexicalTokens('zento prisma lunari 3 kg 3kg', {
      quantity: true,
      dictionary,
      language: 'it',
      stemIt: true,
    });
    const additive = tokens.filter((token) => token.startsWith('_'));
    expect(additive[0]).toBe('_t_zento_prisma');
    expect(additive[1]).toBe('_q_3kg');
    expect(additive.slice(2).every((token) => token.startsWith('_s_'))).toBe(true);
    expect(tokens.filter((token) => token === '_q_3kg')).toHaveLength(1);
    expect(tokens.indexOf('_q_3kg')).toBeLessThan(tokens.findIndex((token) => !token.startsWith('_')));
  });

  it('keeps a quantity inside the 16 additive slots of a long stemmed query (pitfall 17)', () => {
    const words = Array.from({ length: 20 }, (_, i) => `zentar${String.fromCharCode(97 + i)}ini`);
    const tokens = queryLexicalTokens(`${words.join(' ')} 7 kg`, { quantity: true, language: 'it', stemIt: true });
    expect(tokens.slice(0, MAX_ADDITIVE_QUERY_TOKENS)).toContain('_q_7kg');
    expect(tokens.filter((token) => token.startsWith('_s_')).length).toBe(MAX_ADDITIVE_QUERY_TOKENS - 1);
  });

  it('caps twenty quantities at 16 additive tokens, then natural tokens up to 64', () => {
    const text = Array.from({ length: 20 }, (_, i) => `${i + 1} kg`).join(' ');
    const tokens = queryLexicalTokens(text, ON);
    expect(tokens.filter((token) => token.startsWith('_q_'))).toHaveLength(MAX_ADDITIVE_QUERY_TOKENS);
    expect(tokens.slice(0, MAX_ADDITIVE_QUERY_TOKENS).every((token) => token.startsWith('_q_'))).toBe(true);
    expect(tokens.length).toBeLessThanOrEqual(64);
  });

  it('lexicalText and chunkLexicalText pass the option through', () => {
    expect(lexicalText(['zento'], '2,5 kg', ON)).toBe('zento 2 5 kg _q_2.5kg');
    expect(chunkLexicalText({ sectionPath: ['zento'], content: '2,5 kg' }, ON)).toBe('zento 2 5 kg _q_2.5kg');
    expect(chunkLexicalText({ sectionPath: ['zento'], content: '2,5 kg' })).toBe('zento 2 5 kg');
  });

  it('identifierLexicalLookupForms never returns a quantity token', () => {
    for (const raw of ['2.5kg', '10%', 'zx-2.5kg', '1.250 ml']) {
      expect(identifierLexicalLookupForms(raw, ON).some((token) => token.startsWith('_q_'))).toBe(false);
      expect(identifierLexicalLookupForms(raw, ON)).toEqual(identifierLexicalLookupForms(raw));
    }
  });

  it('maps an alias word to its symbol only with unitAliases', () => {
    const aliases: LexicalOptions = { quantity: { unitAliases: { zentogrammo: 'g' } } };
    expect(lexicalTokens('3 zentogrammo', aliases).at(-1)).toBe('_q_3g');
    expect(lexicalTokens('3 zentogrammo', ON).some((token) => token.startsWith('_q_'))).toBe(false);
    expect(queryLexicalTokens('3 zentogrammo', aliases)[0]).toBe('_q_3g');
  });
});

describe('registry unit block (D-32)', () => {
  const file = path.join(ROOT, 'config', 'rag', 'language-packs.json');
  const sidecar = path.join(ROOT, 'rag-sidecar', 'config', 'rag', 'language-packs.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const registry = parseLanguageRegistry(raw);

  it('parses with the generated schema and both copies are byte-identical', () => {
    expect(registry.quantity).toBeDefined();
    expect(fs.readFileSync(sidecar)).toEqual(fs.readFileSync(file));
  });

  it('keeps every pack_version at 1', () => {
    expect(registry.packs.map((pack) => pack.pack_version)).toEqual(registry.packs.map(() => 1));
  });

  it('holds unique NFKC lower-case symbols, none a stop word, none with whitespace, digit, quote or backslash', () => {
    const symbols = registry.quantity!.unit_symbols;
    const { stopwords, hanStopwords } = lexicalRegistryRules();
    expect(new Set(symbols).size).toBe(symbols.length);
    for (const symbol of symbols) {
      expect(symbol.normalize('NFKC').toLowerCase()).toBe(symbol);
      expect(stopwords.has(symbol) || hanStopwords.has(symbol)).toBe(false);
      expect(/[\s\d'"\\]/u.test(symbol)).toBe(false);
    }
    expect(symbols).toEqual(expect.arrayContaining(['kg', 'ml', '%', 'l']));
  });
});
