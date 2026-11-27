import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { CalcResultSchema } from '@/lib/rag-eval/contracts.generated';
import { evaluateCalc, type CalcContext } from '@/lib/rag/calc/evaluate';
import { calcLimits, calcLimitsVersion, parseCalcLimits } from '@/lib/rag/calc/limits';
import { normalizeUnit, sameUnit } from '@/lib/rag/calc/units';

const ALIASES = new Set(['S1', 'S2']);
const ctx = { aliases: ALIASES };

type Json = Record<string, unknown>;

function q(name: string, value: string, extra: Json = {}): Json {
  return { name, value, source: { kind: 'question' }, ...extra };
}

function chunk(name: string, value: string, alias = 'S1', extra: Json = {}): Json {
  return { name, value, source: { kind: 'chunk', alias }, ...extra };
}

function step(id: string, op: string, args: string[], extra: Json = {}): Json {
  return { id, op, args, ...extra };
}

function req(operands: Json[], steps: Json[], result?: string): Json {
  return { operands, steps, result: result ?? (steps[steps.length - 1].id as string) };
}

function ok(raw: unknown) {
  const res = evaluateCalc(raw, ctx);
  expect(res.reject_reason).toBeNull();
  expect(res.status).toBe('ok');
  expect(CalcResultSchema.safeParse(res).success).toBe(true);
  return res;
}

function reason(raw: unknown, c: CalcContext = ctx) {
  const res = evaluateCalc(raw, c);
  expect(res.status).toBe('rejected');
  expect(res.value).toBeNull();
  expect(CalcResultSchema.safeParse(res).success).toBe(true);
  return res.reject_reason;
}

describe('limits', () => {
  test('calcLimits returns the file values', () => {
    const file = JSON.parse(readFileSync('config/rag/calc-limits.json', 'utf8'));
    expect(calcLimits()).toEqual(file);
    expect(calcLimits()).toMatchObject({
      max_operands: 50,
      max_list_items: 200,
      max_steps: 30,
      max_depth: 6,
      max_digits: 30,
      max_round_places: 20,
      max_bits: 4096,
    });
  });

  test('a limits object failing the schema throws (configuration error)', () => {
    expect(() => parseCalcLimits({ ...calcLimits(), max_operands: 51 })).toThrow(/calc-limits/);
    expect(() => parseCalcLimits({ ...calcLimits(), extra: 1 })).toThrow();
    expect(() => parseCalcLimits({ version: 1 })).toThrow();
  });

  test('calcLimitsVersion is a sha256 hex digest', () => {
    expect(calcLimitsVersion()).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('unit comparison', () => {
  test('case folding', () => {
    expect(sameUnit('KG', 'kg')).toBe(true);
  });
  test('full-width and ASCII forms of one unit are the same', () => {
    expect(sameUnit('Ｋｇ', 'kg')).toBe(true);
    expect(sameUnit('％', '%')).toBe(true);
  });
  test('different units differ', () => {
    expect(sameUnit('a', 'b')).toBe(false);
  });
  test('two absent units are the same (unitless)', () => {
    expect(sameUnit(undefined, undefined)).toBe(true);
    expect(sameUnit(null, '')).toBe(true);
    expect(normalizeUnit('  ')).toBe('');
  });
  test('trimmed', () => {
    expect(normalizeUnit(' Kg ')).toBe('kg');
  });
});

describe('evaluateCalc', () => {
  test('per-item cap over five values then a sum', () => {
    const res = ok(
      req(
        [
          { name: 'items', values: ['120', '80', '150', '99.5', '200'], unit: 'u', source: { kind: 'chunk', alias: 'S1' } },
          chunk('cap', '100', 'S2', { unit: 'u' }),
        ],
        [step('capped', 'cap_each', ['items', 'cap']), step('total', 'sum', ['capped'])],
      ),
    );
    expect(res.value).toBe('479.5');
    expect(res.unit).toBe('u');
    expect(res.steps).toHaveLength(2);
    expect(res.steps?.[0]).toMatchObject({ id: 'capped', op: 'cap_each', exact: '959/2', display: '479.5' });
    expect(res.steps?.[0].inputs).toEqual(['120/1', '80/1', '150/1', '199/2', '200/1', '100/1']);
    expect(res.steps?.[1]).toMatchObject({ id: 'total', op: 'sum', exact: '959/2', display: '479.5', display_rounded: false });
  });

  test('percentage of 1250 by 8 is 100; a "%" percent operand is unitless', () => {
    const res = ok(req([chunk('base', '1250', 'S1', { unit: 'u' }), q('rate', '8', { unit: '%' })], [step('p', 'percentage', ['base', 'rate'])]));
    expect(res.value).toBe('100');
    expect(res.unit).toBe('u');
  });

  test('date_diff in months and in inclusive days', () => {
    const dates = [q('a', '2024-01-31'), q('b', '2024-02-29')];
    const months = ok(req(dates, [step('m', 'date_diff', ['a', 'b'], { date_unit: 'months', inclusive: false })]));
    expect(months.value).toBe('0');
    const days = ok(req(dates, [step('d', 'date_diff', ['a', 'b'], { date_unit: 'days', inclusive: true })]));
    expect(days.value).toBe('30');
    expect(days.unit).toBeNull();
    expect(days.steps?.[0].inputs).toEqual(['2024-01-31', '2024-02-29']);
  });

  test('multiply by a sourced conversion operand converts the unit', () => {
    const res = ok(
      req(
        [chunk('amount', '12.5', 'S1', { unit: 'A' }), chunk('rate', '4', 'S2', { unit_from: 'a', unit_to: 'B' })],
        [step('converted', 'multiply', ['amount', 'rate'])],
      ),
    );
    expect(res.value).toBe('50');
    expect(res.unit).toBe('B');
  });

  test('divide by a conversion operand converts back', () => {
    const res = ok(
      req(
        [chunk('amount', '50', 'S1', { unit: 'B' }), chunk('rate', '4', 'S2', { unit_from: 'A', unit_to: 'B' })],
        [step('back', 'divide', ['amount', 'rate'])],
      ),
    );
    expect(res.value).toBe('12.5');
    expect(res.unit).toBe('A');
  });

  test('multiply of A by B without a conversion operand is mixed_units', () => {
    expect(reason(req([chunk('x', '2', 'S1', { unit: 'A' }), chunk('y', '3', 'S2', { unit: 'B' })], [step('p', 'multiply', ['x', 'y'])]))).toBe(
      'mixed_units',
    );
  });

  test('multiply by a count keeps the unit', () => {
    const res = ok(req([chunk('x', '2.5', 'S1', { unit: 'A' }), q('n', '3')], [step('p', 'multiply', ['n', 'x'])]));
    expect(res.value).toBe('7.5');
    expect(res.unit).toBe('A');
  });

  test('divide of A by A is unitless', () => {
    const res = ok(req([chunk('x', '9', 'S1', { unit: 'A' }), chunk('y', '3', 'S2', { unit: 'a' })], [step('r', 'divide', ['x', 'y'])]));
    expect(res.value).toBe('3');
    expect(res.unit).toBeNull();
  });

  test('divide by a zero operand is division_by_zero', () => {
    expect(reason(req([q('x', '9'), q('z', '0.00')], [step('r', 'divide', ['x', 'z'])]))).toBe('division_by_zero');
  });

  test('a non-terminating result is displayed rounded and flagged', () => {
    const res = ok(req([q('x', '1'), q('y', '3')], [step('r', 'divide', ['x', 'y'])]));
    expect(res.value).toBe('0.3333333333');
    expect(res.steps?.[0]).toMatchObject({ exact: '1/3', display_rounded: true });
  });

  test('a round step and step-level rounding', () => {
    const res = ok(
      req(
        [q('x', '2.345'), q('y', '1')],
        [step('a', 'add', ['x', 'y'], { rounding: { places: 2, mode: 'half_up' } }), step('r', 'round', ['a'], { rounding: { places: 0 } })],
      ),
    );
    expect(res.steps?.[0].display).toBe('3.35');
    expect(res.value).toBe('3');
  });

  test('add requires identical units after normalization', () => {
    expect(ok(req([chunk('x', '1', 'S1', { unit: '\u0133' }), chunk('y', '2', 'S2', { unit: ' IJ' })], [step('s', 'add', ['x', 'y'])])).value).toBe('3');
    expect(reason(req([chunk('x', '1', 'S1', { unit: 'kg' }), q('y', '2')], [step('s', 'add', ['x', 'y'])]))).toBe('mixed_units');
  });

  test('an argument referring to a later step is unknown_argument', () => {
    expect(reason(req([q('x', '1'), q('y', '2')], [step('a', 'add', ['x', 'b']), step('b', 'add', ['x', 'y'])], 'a'))).toBe(
      'unknown_argument',
    );
  });

  test('a chain deeper than max_depth is limit_exceeded', () => {
    const steps = [step('s1', 'add', ['x', 'y'])];
    for (let i = 2; i <= 7; i += 1) steps.push(step(`s${i}`, 'add', [`s${i - 1}`, 'y']));
    expect(reason(req([q('x', '1'), q('y', '1')], steps))).toBe('limit_exceeded');
    expect(ok(req([q('x', '1'), q('y', '1')], steps.slice(0, 6))).value).toBe('7');
  });

  test('an operand of 31 digits is limit_exceeded; 30 digits is accepted', () => {
    const d31 = '1234567890123456789012345.123456';
    const d30 = '1234567890123456789012345.12345';
    expect(reason(req([q('x', d31), q('y', '1')], [step('s', 'add', ['x', 'y'])]))).toBe('limit_exceeded');
    expect(ok(req([q('x', d30), q('y', '0')], [step('s', 'add', ['x', 'y'])])).value).toBe('1234567890123456789012345.12345');
  });

  test('a chunk operand whose alias is not in the context is unknown_source', () => {
    expect(reason(req([chunk('x', '1', 'S9'), q('y', '1')], [step('s', 'add', ['x', 'y'])]))).toBe('unknown_source');
  });

  test('the alias set is the one passed in, not a global one', () => {
    const raw = req([chunk('x', '1', 'S1'), q('y', '1')], [step('s', 'add', ['x', 'y'])]);
    expect(evaluateCalc(raw, { aliases: new Set(['S1']) }).status).toBe('ok');
    expect(reason(raw, { aliases: new Set() })).toBe('unknown_source');
  });

  test('a fact_tool source is unsupported_source', () => {
    const op = { name: 'x', value: '1', source: { kind: 'fact_tool', tool: 'facts', key: 'k1' } };
    expect(reason(req([op, q('y', '1')], [step('s', 'add', ['x', 'y'])]))).toBe('unsupported_source');
  });

  test('an operand without a source is unsourced_operand', () => {
    expect(reason(req([{ name: 'x', value: '1' }, q('y', '1')], [step('s', 'add', ['x', 'y'])]))).toBe('unsourced_operand');
    expect(reason(req([{ name: 'x', value: '1', source: { kind: 'chunk' } }, q('y', '1')], [step('s', 'add', ['x', 'y'])]))).toBe(
      'unsourced_operand',
    );
  });

  test('an invalid date is invalid_date; values and value together are invalid_request', () => {
    expect(reason(req([q('a', '2023-02-29'), q('b', '2024-01-01')], [step('d', 'date_diff', ['a', 'b'], { date_unit: 'days', inclusive: false })]))).toBe(
      'invalid_date',
    );
    expect(reason(req([{ ...q('x', '1'), values: ['1'] }, q('y', '1')], [step('s', 'add', ['x', 'y'])]))).toBe('invalid_request');
  });

  test('counts above the limits are limit_exceeded', () => {
    const many = Array.from({ length: 51 }, (_, i) => q(`o${i}`, '1'));
    expect(reason(req(many, [step('s', 'add', ['o0', 'o1'])]))).toBe('limit_exceeded');
    const list = { name: 'l', values: Array.from({ length: 201 }, () => '1'), source: { kind: 'question' } };
    expect(reason(req([list], [step('s', 'sum', ['l'])]))).toBe('limit_exceeded');
    const steps = Array.from({ length: 31 }, (_, i) => step(`s${i}`, 'add', ['x', 'x']));
    expect(reason(req([q('x', '1')], steps))).toBe('limit_exceeded');
    expect(reason(req([q('x', '1')], [step('r', 'round', ['x'], { rounding: { places: 20 } })]), { aliases: ALIASES, limits: { ...calcLimits(), max_round_places: 10 } })).toBe(
      'limit_exceeded',
    );
  });

  test('a result whose numerator exceeds max_bits is limit_exceeded', () => {
    const tiny = `0.${'0'.repeat(28)}7`;
    const operands = [q('x', tiny)];
    const steps = [step('s1', 'multiply', ['x', 'x'])];
    for (let i = 2; i <= 6; i += 1) steps.push(step(`s${i}`, 'multiply', [`s${i - 1}`, `s${i - 1}`]));
    expect(reason(req(operands, steps))).toBe('limit_exceeded');
    expect(ok(req(operands, steps.slice(0, 5))).value).toBe('0');
  });

  test('a result with more than 30 integer digits is limit_exceeded', () => {
    expect(reason(req([q('x', '9'.repeat(30))], [step('s', 'multiply', ['x', 'x'])]))).toBe('limit_exceeded');
  });

  test('never throws on arbitrary input', () => {
    for (const raw of [undefined, null, 0, 'x', [], {}, { operands: 'x' }, { operands: [null], steps: [], result: 'a' }]) {
      expect(() => evaluateCalc(raw, ctx)).not.toThrow();
      expect(evaluateCalc(raw, ctx).status).toBe('rejected');
    }
  });
});
