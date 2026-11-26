import { describe, expect, it } from 'vitest';
import { QUANTITY_TOKEN_PREFIX } from '@/lib/rag/lexical/options';
import { buildQuantityUnits, quantityTokens } from '@/lib/rag/lexical/quantity';

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
