import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  add,
  bitLength,
  CalcError,
  compare,
  display,
  divide,
  multiply,
  negate,
  parseDecimal,
  rational,
  roundTo,
  subtract,
  toDecimalString,
  toExactString,
  type Rational,
  type RoundingMode,
} from '@/lib/rag/calc/rational';
import { dateDiff, dayNumber, parseIsoDate, type DateUnit } from '@/lib/rag/calc/dates';

interface Exact {
  n: string;
  d: string;
}
interface VectorCase {
  id: string;
  kind: string;
  op: string;
  args?: string[];
  value?: Exact;
  places?: number;
  mode?: RoundingMode;
  unit?: DateUnit;
  inclusive?: boolean;
  cap?: string;
  expected: Record<string, unknown>;
}

const VECTORS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/calc/vectors.json', import.meta.url)), 'utf8'),
) as { cases: VectorCase[] };

export function casesOf(kind: string): VectorCase[] {
  return VECTORS.cases.filter((c) => c.kind === kind);
}

function fromExact(e: Exact): Rational {
  return rational(BigInt(e.n), BigInt(e.d));
}

function exactOf(r: Rational): Exact {
  return { n: r.n.toString(), d: r.d.toString() };
}

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof CalcError) return err.reason;
    throw err;
  }
  return undefined;
}

function expectOk(actual: Rational, expected: Record<string, unknown>): void {
  expect(exactOf(actual)).toEqual(expected.exact);
  if ('display' in expected) {
    expect(display(actual)).toEqual({ display: expected.display, display_rounded: expected.display_rounded });
  }
}

const BINARY = { add, subtract, multiply, divide } as const;

describe('vectors', () => {
  test('the file covers every kind', () => {
    expect(VECTORS.cases.length).toBeGreaterThanOrEqual(500);
    for (const kind of ['parse', 'binary', 'round', 'display', 'date_diff']) expect(casesOf(kind).length).toBeGreaterThan(0);
  });

  test.each(casesOf('parse').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const text = c.args![0];
    if ('error' in c.expected) expect(reasonOf(() => parseDecimal(text))).toBe(c.expected.error);
    else expect(exactOf(parseDecimal(text))).toEqual(c.expected.exact);
  });

  test.each(casesOf('binary').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const fn = BINARY[c.op as keyof typeof BINARY];
    const [a, b] = c.args!.map(parseDecimal);
    if ('error' in c.expected) expect(reasonOf(() => fn(a, b))).toBe(c.expected.error);
    else expectOk(fn(a, b), c.expected);
  });

  test.each(casesOf('round').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const value = fromExact(c.value!);
    expect(toDecimalString(value, c.places!, c.mode!)).toBe(c.expected.string);
    expect(compare(roundTo(value, c.places!, c.mode!), parseDecimal(c.expected.string as string))).toBe(0);
  });

  test.each(casesOf('display').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(display(fromExact(c.value!))).toEqual(c.expected);
  });

  test.each(casesOf('date_diff').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const run = () => dateDiff(parseIsoDate(c.args![0]), parseIsoDate(c.args![1]), c.unit!, c.inclusive!);
    if ('error' in c.expected) expect(reasonOf(run)).toBe(c.expected.error);
    else expectOk(run(), c.expected);
  });
});

describe('rational', () => {
  test('0.1 + 0.2 equals 0.3 exactly', () => {
    expect(add(parseDecimal('0.1'), parseDecimal('0.2'))).toEqual(parseDecimal('0.3'));
    expect(toExactString(add(parseDecimal('0.1'), parseDecimal('0.2')))).toBe('3/10');
  });

  test.each(['1e3', '1,000', 'NaN', 'Infinity', '+1', '.5', '1.', '', ' 1', '0x10', '１'])('rejects %j', (text) => {
    expect(reasonOf(() => parseDecimal(text))).toBe('invalid_value');
  });

  test('rejects non-string input', () => {
    expect(reasonOf(() => parseDecimal(3 as unknown as string))).toBe('invalid_value');
    expect(reasonOf(() => parseDecimal(null))).toBe('invalid_value');
  });

  test('values stay reduced with a positive denominator', () => {
    const r = divide(parseDecimal('-4'), parseDecimal('-6'));
    expect(exactOf(r)).toEqual({ n: '2', d: '3' });
    expect(exactOf(rational(BigInt(6), BigInt(-4)))).toEqual({ n: '-3', d: '2' });
    expect(exactOf(negate(parseDecimal('0')))).toEqual({ n: '0', d: '1' });
  });

  test('division by zero is a typed error', () => {
    const err = (() => {
      try {
        divide(parseDecimal('1'), parseDecimal('0.000'));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CalcError);
    expect((err as CalcError).reason).toBe('division_by_zero');
  });

  test('round rejects bad places and modes', () => {
    const v = parseDecimal('1.5');
    expect(reasonOf(() => roundTo(v, -1, 'half_even'))).toBe('invalid_request');
    expect(reasonOf(() => roundTo(v, 1.5, 'half_even'))).toBe('invalid_request');
    expect(reasonOf(() => roundTo(v, 0, 'ceiling' as RoundingMode))).toBe('invalid_request');
  });

  test('bitLength', () => {
    expect(bitLength(BigInt(0))).toBe(0);
    expect(bitLength(BigInt(-255))).toBe(8);
    expect(bitLength(rational(BigInt(1), BigInt(1024)))).toBe(11);
  });
});

describe('dates', () => {
  test.each(['2024-02-30', '2023-13-01', '2023-02-29', '1900-02-29', '0000-01-01', '2024-1-01', '20240101'])(
    'rejects %s',
    (text) => {
      expect(reasonOf(() => parseIsoDate(text))).toBe('invalid_date');
    },
  );

  test('day numbers around the epoch and before it', () => {
    expect(dayNumber(parseIsoDate('1970-01-01'))).toBe(0);
    expect(dayNumber(parseIsoDate('1969-12-31'))).toBe(-1);
    expect(dayNumber(parseIsoDate('2000-03-01'))).toBe(11017);
    expect(dayNumber(parseIsoDate('0001-01-01'))).toBe(-719162);
  });

  test('inclusive counts both ends for days only', () => {
    const a = parseIsoDate('2024-01-31');
    const b = parseIsoDate('2024-03-31');
    expect(exactOf(dateDiff(a, b, 'days', true))).toEqual({ n: '61', d: '1' });
    expect(exactOf(dateDiff(a, b, 'months', true))).toEqual({ n: '2', d: '1' });
  });
});
