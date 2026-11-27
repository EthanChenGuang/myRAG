import { describe, expect, test } from 'vitest';
import { numberFormatFor } from '@/lib/rag/lang/registry-fields';
import { findNumbers, formatNumber, type NumberMatch, type ScanStats } from '@/lib/rag/calc/numbers';
import { parseDecimal, rational, toExactString } from '@/lib/rag/calc/rational';

const en = numberFormatFor('en');
const it = numberFormatFor('it');
const zh = numberFormatFor('zh');

function values(matches: NumberMatch[]): string[] {
  return matches.map((m) => toExactString(m.value));
}

function exact(text: string): string {
  return toExactString(parseDecimal(text));
}

describe('findNumbers', () => {
  test('en grouping and decimal mark', () => {
    const found = findNumbers('The amount is 1,250.50 in total.', en);
    expect(values(found)).toEqual([exact('1250.5')]);
    expect(found[0]).toMatchObject({ start: 14, end: 22, raw: '1,250.50', percent: false, places: 2, power: 0 });
  });

  test('it grouping and decimal mark', () => {
    expect(values(findNumbers("L'importo è 1.250,50 in totale.", it))).toEqual([exact('1250.5')]);
  });

  test('zh full-width digits', () => {
    expect(values(findNumbers('合计１２５０。', zh))).toEqual([exact('1250')]);
  });

  test('full-width digits are not read in a format that does not declare them', () => {
    expect(findNumbers('total １２５０', en)).toEqual([]);
  });

  test('zh magnitude word without a space', () => {
    const found = findNumbers('预算为3万。', zh);
    expect(values(found)).toEqual([exact('30000')]);
    expect(found[0]).toMatchObject({ raw: '3万', power: 4 });
  });

  test('en magnitude word after a space, case-folded, with a decimal', () => {
    expect(values(findNumbers('about 2 million units', en))).toEqual([exact('2000000')]);
    expect(values(findNumbers('about 1.5 Million units', en))).toEqual([exact('1500000')]);
  });

  test('a magnitude word must be a whole word in a spaced script', () => {
    expect(values(findNumbers('2 millionth', en))).toEqual([exact('2')]);
  });

  test('it picks the longest magnitude word', () => {
    expect(values(findNumbers('circa 2,5 milioni', it))).toEqual([exact('2500000')]);
  });

  test('a value is never found inside a longer number', () => {
    expect(values(findNumbers('code 3125 here', en))).toEqual([exact('3125')]);
    expect(findNumbers('code 3125 here', en).some((m) => m.raw === '12')).toBe(false);
  });

  test('a citation marker and a URL are skipped', () => {
    const text = 'See [S12] and 【S3】 and https://example.test/a/12?x=45 for 7.';
    expect(values(findNumbers(text, en))).toEqual([exact('7')]);
  });

  test('digits right after a cased letter are an identifier, not a number', () => {
    expect(findNumbers('version v2 and S12', en)).toEqual([]);
    expect(values(findNumbers('共3项', zh))).toEqual([exact('3')]);
  });

  test('a number written in words is not found', () => {
    expect(findNumbers('twelve items', en)).toEqual([]);
  });

  test('a percent sign is a flag on the match', () => {
    const found = findNumbers('a rate of 12% and 7 % and 3', en);
    expect(found.map((m) => m.percent)).toEqual([true, true, false]);
    expect(values(found)).toEqual([exact('12'), exact('7'), exact('3')]);
  });

  test('a malformed grouping is skipped as a whole', () => {
    expect(findNumbers('values 1,25 and 1250,000', en)).toEqual([]);
    expect(findNumbers('valore 3.5', it)).toEqual([]);
  });

  test('a sentence-final period is not a decimal mark', () => {
    expect(values(findNumbers('Total: 140.', en))).toEqual([exact('140')]);
  });

  test('a leading minus counts only as a sign, never as subtraction', () => {
    expect(values(findNumbers('balance: -5', en))).toEqual([exact('-5')]);
    expect(values(findNumbers('10 - 5 = 5', en))).toEqual([exact('10'), exact('5'), exact('5')]);
    expect(values(findNumbers('pages 10-12', en))).toEqual([exact('10'), exact('12')]);
  });

  test('a space groups digits where the format lists it', () => {
    expect(values(findNumbers('total 1 250 items', en))).toEqual([exact('1250')]);
    expect(values(findNumbers('items 12 and 45 50', en))).toEqual([exact('12'), exact('45'), exact('50')]);
  });

  test('offsets are UTF-16 code units', () => {
    const text = '😀 costs 45';
    const [m] = findNumbers(text, en);
    expect(text.slice(m.start, m.end)).toBe('45');
  });

  test('a 100 KB text is scanned in linear steps', () => {
    for (const unit of ['1,', '1 ', '1.', 'a1', '[S1', '12345678 ', '1 million ']) {
      const text = unit.repeat(Math.ceil(100_000 / unit.length));
      const stats: ScanStats = { steps: 0 };
      const started = performance.now();
      findNumbers(text, en, stats);
      expect(stats.steps).toBeGreaterThan(0);
      expect(stats.steps).toBeLessThanOrEqual(4 * text.length);
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});

describe('formatNumber', () => {
  test('it grouping and decimal mark, then the unit', () => {
    expect(formatNumber(parseDecimal('1250.5'), 2, it, 'EUR')).toBe('1.250,50 EUR');
  });

  test('en grouping, rounding half-even at the places', () => {
    expect(formatNumber(rational(BigInt(100), BigInt(3)), 2, en)).toBe('33.33');
    expect(formatNumber(parseDecimal('1234567.125'), 2, en, null)).toBe('1,234,567.12');
  });

  test('zero places, a negative value and a percent unit', () => {
    expect(formatNumber(parseDecimal('-1250'), 0, zh)).toBe('-1,250');
    expect(formatNumber(parseDecimal('12.5'), 1, en, '%')).toBe('12.5%');
  });
});
