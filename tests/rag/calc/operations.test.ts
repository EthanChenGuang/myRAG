import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CalcError, display, parseDecimal, rational, type Rational } from '@/lib/rag/calc/rational';
import { parseIsoDate } from '@/lib/rag/calc/dates';
import {
  CALC_OPS,
  OPERATIONS,
  applyOperation,
  capEachOp,
  dateDiffOp,
  maxOp,
  minOp,
  percentageOp,
  roundOp,
  sumOp,
  type CalcValue,
} from '@/lib/rag/calc/operations';

interface Exact {
  n: string;
  d: string;
}
interface VectorCase {
  id: string;
  kind: string;
  op: string;
  args: string[];
  cap?: string;
  expected: Record<string, unknown>;
}

const CASES = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../fixtures/calc/vectors.json', import.meta.url)), 'utf8'),
  ) as { cases: VectorCase[] }
).cases;

const num = (text: string): CalcValue => ({ kind: 'number', value: parseDecimal(text) });
const list = (texts: string[]): CalcValue => ({ kind: 'list', values: texts.map(parseDecimal) });

function exactOf(r: Rational): Exact {
  return { n: r.n.toString(), d: r.d.toString() };
}

function shown(r: Rational): Record<string, unknown> {
  return { exact: exactOf(r), ...display(r) };
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

function numberOf(v: CalcValue): Rational {
  if (v.kind !== 'number') throw new Error(`expected a number, got ${v.kind}`);
  return v.value;
}

describe('closed operation set', () => {
  test('the table holds exactly the D-67 operations', () => {
    expect([...CALC_OPS].sort()).toEqual(
      ['add', 'cap_each', 'date_diff', 'divide', 'max', 'min', 'multiply', 'percentage', 'round', 'subtract', 'sum'].sort(),
    );
    expect(Object.keys(OPERATIONS).sort()).toEqual([...CALC_OPS].sort());
    expect(Object.isFrozen(OPERATIONS)).toBe(true);
  });

  test.each(['constructor', '__proto__', 'toString', 'eval', 'pow', 'ADD'])('unknown op %j is rejected', (op) => {
    expect(reasonOf(() => applyOperation(op, [num('1'), num('2')], {}))).toBe('invalid_request');
  });

  test('binary vectors through the table', () => {
    const binary = CASES.filter((c) => c.kind === 'binary');
    expect(binary.length).toBeGreaterThan(0);
    for (const c of binary) {
      const run = () => numberOf(applyOperation(c.op, c.args.map(num), {}));
      if ('error' in c.expected) expect(reasonOf(run), c.id).toBe(c.expected.error);
      else expect(shown(run()), c.id).toEqual(c.expected);
    }
  });

  test.each(CASES.filter((c) => c.kind === 'list').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const fn = { min: minOp, max: maxOp, sum: sumOp }[c.op as 'min' | 'max' | 'sum'];
    const run = () => numberOf(fn([list(c.args)]));
    if ('error' in c.expected) expect(reasonOf(run)).toBe(c.expected.error);
    else expect(shown(run())).toEqual(c.expected);
  });

  test.each(CASES.filter((c) => c.kind === 'cap_each').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const run = () => capEachOp([list(c.args), num(c.cap!)]);
    if ('error' in c.expected) {
      expect(reasonOf(run)).toBe(c.expected.error);
      return;
    }
    const out = run();
    expect(out.kind).toBe('list');
    if (out.kind !== 'list') return;
    expect(out.values.map(shown)).toEqual(c.expected.list);
  });

  test.each(CASES.filter((c) => c.kind === 'percentage').map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(shown(numberOf(percentageOp(c.args.map(num))))).toEqual(c.expected);
  });

  test('sum of an empty list is rejected; min and max of one value return it', () => {
    expect(reasonOf(() => sumOp([list([])]))).toBe('invalid_request');
    expect(reasonOf(() => sumOp([]))).toBe('invalid_request');
    expect(numberOf(minOp([num('4.5')]))).toEqual(parseDecimal('4.5'));
    expect(numberOf(maxOp([list(['-2'])]))).toEqual(parseDecimal('-2'));
  });

  test('min, max and sum accept numbers and lists together', () => {
    expect(numberOf(sumOp([num('1'), list(['2', '3'])]))).toEqual(parseDecimal('6'));
    expect(numberOf(maxOp([list(['1', '9']), num('4')]))).toEqual(parseDecimal('9'));
  });

  test('cap_each limits each item and keeps order', () => {
    const out = capEachOp([list(['120', '80', '100.5']), num('100')]);
    expect(out).toEqual({ kind: 'list', values: [parseDecimal('100'), parseDecimal('80'), parseDecimal('100')] });
  });

  test('percentage is value times percent over one hundred exactly', () => {
    expect(numberOf(percentageOp([num('0.1'), num('33.3')]))).toEqual(rational(BigInt(333), BigInt(10000)));
  });

  test('round takes places and mode, half-even by default', () => {
    expect(numberOf(roundOp([num('2.5')], { places: 0 }))).toEqual(parseDecimal('2'));
    expect(numberOf(roundOp([num('2.5')], { places: 0, mode: 'half_up' }))).toEqual(parseDecimal('3'));
    expect(reasonOf(() => roundOp([num('2.5')], {}))).toBe('invalid_request');
  });

  test('date_diff takes two dates, a unit and an explicit inclusive flag', () => {
    const a: CalcValue = { kind: 'date', value: parseIsoDate('2024-02-28') };
    const b: CalcValue = { kind: 'date', value: parseIsoDate('2024-03-01') };
    expect(numberOf(dateDiffOp([a, b], { unit: 'days', inclusive: false }))).toEqual(parseDecimal('2'));
    expect(numberOf(dateDiffOp([a, b], { unit: 'days', inclusive: true }))).toEqual(parseDecimal('3'));
    expect(reasonOf(() => dateDiffOp([a, b], { unit: 'days' }))).toBe('invalid_request');
    expect(reasonOf(() => dateDiffOp([a, num('1')], { unit: 'days', inclusive: false }))).toBe('invalid_request');
  });

  test('wrong argument kinds and counts are rejected', () => {
    expect(reasonOf(() => applyOperation('add', [num('1')], {}))).toBe('invalid_request');
    expect(reasonOf(() => applyOperation('add', [num('1'), list(['2'])], {}))).toBe('invalid_request');
    expect(reasonOf(() => applyOperation('divide', [num('1'), num('0')], {}))).toBe('division_by_zero');
    expect(reasonOf(() => capEachOp([num('1'), num('2')]))).toBe('invalid_request');
    expect(reasonOf(() => percentageOp([num('1')]))).toBe('invalid_request');
  });
});
