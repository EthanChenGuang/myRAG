import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { evaluateCalc } from '@/lib/rag/calc/evaluate';
import { calcLimits } from '@/lib/rag/calc/limits';

const CALC_DIR = fileURLToPath(new URL('../../../src/lib/rag/calc/', import.meta.url));
const ctx = { aliases: new Set(['S1', 'S2']) };

type Json = Record<string, unknown>;

/** A valid request touching every string field: names, value, values, units, conversion units, label, aliases, tool, key. */
function validRequest(): Json {
  return {
    operands: [
      { name: 'items', values: ['3', '7.5'], unit: 'u', source: { kind: 'chunk', alias: 'S1' } },
      { name: 'cap', value: '5', unit: 'u', source: { kind: 'chunk', alias: 'S2' } },
      { name: 'rate', value: '2', unit_from: 'u', unit_to: 'w', source: { kind: 'question' } },
      { name: 'start', value: '2024-01-01', source: { kind: 'question' } },
      { name: 'end', value: '2024-03-01', source: { kind: 'question' } },
    ],
    steps: [
      { id: 'capped', op: 'cap_each', args: ['items', 'cap'], label: 'capped items' },
      { id: 'total', op: 'sum', args: ['capped'] },
      { id: 'converted', op: 'multiply', args: ['total', 'rate'], rounding: { mode: 'half_even', places: 2 } },
      { id: 'span', op: 'date_diff', args: ['start', 'end'], date_unit: 'days', inclusive: false },
    ],
    result: 'converted',
  };
}

type Setter = (r: Json, s: string) => void;
const ops = (r: Json) => r.operands as Json[];
const steps = (r: Json) => r.steps as Json[];
const src = (r: Json, i: number) => ops(r)[i].source as Json;

/** Every string field, set in turn. Renaming a name keeps no reference to it, so the request can only be rejected. */
const FIELDS: Record<string, Setter> = {
  'operand.name': (r, s) => (ops(r)[1].name = s),
  'operand.value': (r, s) => (ops(r)[1].value = s),
  'operand.date_value': (r, s) => (ops(r)[3].value = s),
  'operand.values[]': (r, s) => ((ops(r)[0].values as string[])[1] = s),
  'operand.unit': (r, s) => (ops(r)[1].unit = s),
  'operand.unit_from': (r, s) => (ops(r)[2].unit_from = s),
  'operand.unit_to': (r, s) => (ops(r)[2].unit_to = s),
  'source.kind': (r, s) => (src(r, 3).kind = s),
  'source.alias': (r, s) => (src(r, 1).alias = s),
  'source.tool': (r, s) => (ops(r)[4].source = { kind: 'fact_tool', tool: s, key: 'k1' }),
  'source.key': (r, s) => (ops(r)[4].source = { kind: 'fact_tool', tool: 'facts', key: s }),
  'step.id': (r, s) => (steps(r)[0].id = s),
  'step.op': (r, s) => (steps(r)[1].op = s),
  'step.args[]': (r, s) => ((steps(r)[1].args as string[])[0] = s),
  'step.label': (r, s) => (steps(r)[0].label = s),
  'step.date_unit': (r, s) => (steps(r)[3].date_unit = s),
  'step.rounding.mode': (r, s) => ((steps(r)[2].rounding as Json).mode = s),
  result: (r, s) => (r.result = s),
};

const FRAGMENTS = [
  'f(x)',
  'alert(1)',
  '`${x}`',
  '${process.env}',
  '() => 1',
  'x => x',
  'a; b',
  '1; 2',
  "import('fs')",
  "import x from 'y'",
  "require('child_process')",
  '__proto__[x]',
  'constructor.constructor()',
  'Object.prototype.x=1',
  '`id`',
  '{}',
  '{ a: 1 }',
  '<script>',
  '<img src=x>',
  "' OR 1=1 --",
  "'; DROP TABLE t; --",
  '$(id)',
  '`ls`',
  'x | y',
  'eval("1")',
  'new Function("x")',
  '[1,2]',
  'a && b',
  '1 + 1;',
  'x\ny',
];
const AFFIXES = ['', '', 'a', 'x1', '1', '12', ' ', 'kg', 'S1', 'items', '0.5', '-'];

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

function cases(count: number): Array<{ field: string; value: string }> {
  const next = seeded(521007);
  const names = Object.keys(FIELDS);
  const out: Array<{ field: string; value: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const field = names[i % names.length];
    const fragment = FRAGMENTS[next() % FRAGMENTS.length];
    const value = AFFIXES[next() % AFFIXES.length] + fragment + AFFIXES[next() % AFFIXES.length];
    out.push({ field, value });
  }
  return out;
}

describe('code-like strings in every string field are rejected', () => {
  test('the base request is valid', () => {
    const res = evaluateCalc(validRequest(), ctx);
    expect(res.reject_reason).toBeNull();
    expect(res.value).toBe('16');
    expect(res.unit).toBe('w');
  });

  const generated = cases(720);

  test('at least 500 generated cases across every field', () => {
    expect(generated.length).toBeGreaterThanOrEqual(500);
    expect(new Set(generated.map((c) => c.field)).size).toBe(Object.keys(FIELDS).length);
  });

  test('every generated case is rejected and none throws', () => {
    const accepted: string[] = [];
    for (const { field, value } of generated) {
      const raw = validRequest();
      FIELDS[field](raw, value);
      let status: string;
      try {
        status = evaluateCalc(raw, ctx).status;
      } catch {
        status = 'threw';
      }
      if (status !== 'rejected') accepted.push(`${field}=${JSON.stringify(value)} -> ${status}`);
    }
    expect(accepted).toEqual([]);
  });

  test('every fragment alone in every field is rejected', () => {
    for (const field of Object.keys(FIELDS)) {
      for (const fragment of FRAGMENTS) {
        const raw = validRequest();
        FIELDS[field](raw, fragment);
        expect(evaluateCalc(raw, ctx).status, `${field}=${fragment}`).toBe('rejected');
      }
    }
  });

  test('an extra field "expression" is rejected', () => {
    expect(evaluateCalc({ ...validRequest(), expression: '1+1' }, ctx).reject_reason).toBe('invalid_request');
    const raw = validRequest();
    steps(raw)[0].expression = 'items + cap';
    expect(evaluateCalc(raw, ctx).reject_reason).toBe('invalid_request');
  });

  test('prototype keys are not resolved as names', () => {
    const raw = validRequest();
    (steps(raw)[1].args as string[])[0] = 'hasownproperty';
    expect(evaluateCalc(raw, ctx).status).toBe('rejected');
    const json = JSON.parse('{"operands":[{"name":"x","value":"1","source":{"kind":"question"}}],"steps":[{"id":"s","op":"add","args":["x","x"]}],"result":"s","__proto__":{"polluted":true}}');
    expect(evaluateCalc(json, ctx).reject_reason).toBe('invalid_request');
    expect(({} as Json).polluted).toBeUndefined();
  });
});

describe('targeted rejection reasons (D-69)', () => {
  test('unsourced operand', () => {
    const raw = validRequest();
    delete ops(raw)[1].source;
    expect(evaluateCalc(raw, ctx).reject_reason).toBe('unsourced_operand');
  });

  test('unknown alias', () => {
    const raw = validRequest();
    src(raw, 1).alias = 'S3';
    expect(evaluateCalc(raw, ctx).reject_reason).toBe('unknown_source');
  });

  test('fact tool source', () => {
    const raw = validRequest();
    ops(raw)[4].source = { kind: 'fact_tool', tool: 'facts', key: 'k1' };
    expect(evaluateCalc(raw, ctx).reject_reason).toBe('unsupported_source');
  });

  test('unknown argument', () => {
    const raw = validRequest();
    (steps(raw)[1].args as string[])[0] = 'missing';
    expect(evaluateCalc(raw, ctx).reject_reason).toBe('unknown_argument');
  });

  test('mixed units', () => {
    const raw = validRequest();
    ops(raw)[1].unit = 'v';
    expect(evaluateCalc(raw, ctx).reject_reason).toBe('mixed_units');
    const conv = validRequest();
    ops(conv)[2].unit_from = 'v';
    expect(evaluateCalc(conv, ctx).reject_reason).toBe('mixed_units');
    const percent = validRequest();
    steps(percent)[2].op = 'percentage';
    expect(evaluateCalc(percent, ctx).reject_reason).toBe('mixed_units');
  });

  test.each([
    ['max_operands', { max_operands: 4 }],
    ['max_list_items', { max_list_items: 1 }],
    ['max_steps', { max_steps: 3 }],
    ['max_depth', { max_depth: 2 }],
    ['max_digits', { max_digits: 1 }],
    ['max_round_places', { max_round_places: 1 }],
    ['max_bits', { max_bits: 64 }],
  ])('each limit: %s', (_name, override) => {
    const raw = validRequest();
    if ('max_bits' in override) ops(raw)[2].value = '18446744073709551617';
    const limits = { ...calcLimits(), ...override };
    expect(evaluateCalc(raw, { ...ctx, limits }).reject_reason).toBe('limit_exceeded');
    expect(evaluateCalc(raw, ctx).status).toBe('ok');
  });
});

describe('the calc directory executes no text', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : name.endsWith('.ts') ? [full] : [];
    });
  }

  test('no eval(, new Function or import( call', () => {
    const found: string[] = [];
    for (const file of files(CALC_DIR)) {
      const code = readFileSync(file, 'utf8');
      for (const re of [/(?<![\w$.])eval\s*\(/, /new\s+Function\b/, /(?<![\w$.])import\s*\(/, /(?<![\w$.])Function\s*\(/]) {
        if (re.test(code)) found.push(`${path.basename(file)}: ${re}`);
      }
    }
    expect(found).toEqual([]);
    expect(files(CALC_DIR).map((f) => path.basename(f))).toContain('evaluate.ts');
  });
});
