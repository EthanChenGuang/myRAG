import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttributeDefinition } from '@/lib/rag-eval/contracts.generated';
import { ATTRIBUTE_KEY_PATTERN, ATTRIBUTE_LIMITS, validateAttributes, type AttributeError } from '@/lib/rag/ingest/attributes/validate';

const MARKER = 'markerqx';

function definition(key: string, type: AttributeDefinition['type']): AttributeDefinition {
  return { key, type, filterable: false, in_header: false, in_identifier_index: false, soft: false };
}

const DEFINITIONS: AttributeDefinition[] = [definition('alpha_code', 'code'), definition('beta_list', 'text_list'), definition('gamma_text', 'text')];

function errorsOf(raw: unknown): AttributeError[] {
  const result = validateAttributes(DEFINITIONS, raw);
  if (result.ok) return expect.fail('expected a rejection');
  return result.errors;
}

function valuesOf(raw: unknown): Record<string, string | string[]> {
  const result = validateAttributes(DEFINITIONS, raw);
  if (!result.ok) return expect.fail(`expected acceptance, got ${result.errors.map((e) => `${e.key}:${e.code}`).join(',')}`);
  return result.values;
}

function loggedText(): string {
  return [console.log, console.info, console.debug, console.warn, console.error]
    .flatMap((spy) => vi.mocked(spy).mock.calls)
    .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    .join('\n');
}

beforeEach(() => {
  for (const name of ['log', 'info', 'debug', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation(() => undefined);
});

afterEach(() => {
  expect(loggedText()).toBe('');
  vi.restoreAllMocks();
});

const long = (n: number) => `${MARKER}${'x'.repeat(n - MARKER.length)}`;

describe('validateAttributes: limits and key pattern', () => {
  it('exports the D-12 limits and the key pattern', () => {
    expect(ATTRIBUTE_LIMITS).toEqual({ maxDefinitions: 30, maxValueLength: 200, maxListValues: 50 });
    expect(ATTRIBUTE_KEY_PATTERN.test('alpha_code')).toBe(true);
    for (const bad of ['Alpha', '1alpha', `k${'x'.repeat(40)}`, '', 'with-dash']) expect(ATTRIBUTE_KEY_PATTERN.test(bad)).toBe(false);
    expect(ATTRIBUTE_KEY_PATTERN.test(`k${'x'.repeat(39)}`)).toBe(true);
  });
});

describe('validateAttributes: text and code', () => {
  it('keeps a string of 1 to 200 characters, trimmed', () => {
    expect(valuesOf({ alpha_code: '  A-1  ', gamma_text: 'plain value' })).toEqual({ alpha_code: 'A-1', gamma_text: 'plain value' });
    expect(valuesOf({ gamma_text: 'x'.repeat(200) })).toEqual({ gamma_text: 'x'.repeat(200) });
    expect(valuesOf({ gamma_text: ` ${'y'.repeat(200)} ` })).toEqual({ gamma_text: 'y'.repeat(200) });
  });

  it('rejects numbers, booleans, objects, empty strings and lists as invalid_attribute_type', () => {
    for (const value of [7, true, { [MARKER]: 1 }, '', '   ', [MARKER], null]) {
      expect(errorsOf({ alpha_code: value })).toEqual([{ key: 'alpha_code', code: 'invalid_attribute_type' }]);
      expect(errorsOf({ gamma_text: value })).toEqual([{ key: 'gamma_text', code: 'invalid_attribute_type' }]);
    }
  });

  it('rejects 201 characters as value_too_long', () => {
    expect(errorsOf({ gamma_text: long(201) })).toEqual([{ key: 'gamma_text', code: 'value_too_long' }]);
    expect(errorsOf({ alpha_code: long(201) })).toEqual([{ key: 'alpha_code', code: 'value_too_long' }]);
  });

  it('counts code points: 200 characters outside the basic plane are accepted, 201 are not', () => {
    const astral = '\u{1F600}';
    expect(valuesOf({ gamma_text: astral.repeat(200) })).toEqual({ gamma_text: astral.repeat(200) });
    expect(errorsOf({ gamma_text: astral.repeat(201) })).toEqual([{ key: 'gamma_text', code: 'value_too_long' }]);
  });
});

describe('validateAttributes: text_list', () => {
  it('keeps a list of 1 to 50 distinct strings in order', () => {
    expect(valuesOf({ beta_list: ['v3', 'v1', 'v2'] })).toEqual({ beta_list: ['v3', 'v1', 'v2'] });
    const fifty = Array.from({ length: 50 }, (_, index) => `item${index}`);
    expect(valuesOf({ beta_list: fifty })).toEqual({ beta_list: fifty });
  });

  it('rejects a single string, an empty list and a repeated value (with its index)', () => {
    expect(errorsOf({ beta_list: MARKER })).toEqual([{ key: 'beta_list', code: 'invalid_attribute_type' }]);
    expect(errorsOf({ beta_list: [] })).toEqual([{ key: 'beta_list', code: 'invalid_attribute_type' }]);
    expect(errorsOf({ beta_list: [MARKER, 'other', MARKER] })).toEqual([{ key: 'beta_list', code: 'invalid_attribute_type', index: 2 }]);
    expect(errorsOf({ beta_list: ['ok', 5, ''] })).toEqual([
      { key: 'beta_list', code: 'invalid_attribute_type', index: 1 },
      { key: 'beta_list', code: 'invalid_attribute_type', index: 2 },
    ]);
  });

  it('rejects 51 values as too_many_values and an item of 201 characters as value_too_long with its index', () => {
    const fiftyOne = Array.from({ length: 51 }, (_, index) => `${MARKER}${index}`);
    expect(errorsOf({ beta_list: fiftyOne })).toEqual([{ key: 'beta_list', code: 'too_many_values' }]);
    expect(errorsOf({ beta_list: ['short', long(201)] })).toEqual([{ key: 'beta_list', code: 'value_too_long', index: 1 }]);
  });
});

describe('validateAttributes: keys, shape and ordering', () => {
  it('reports an unknown key as unknown_attribute', () => {
    expect(errorsOf({ delta_text: MARKER })).toEqual([{ key: 'delta_text', code: 'unknown_attribute' }]);
    expect(errorsOf({ __proto__x: MARKER })).toEqual([{ key: '__proto__x', code: 'unknown_attribute' }]);
  });

  it('answers a non-object input with one error with an empty key', () => {
    for (const raw of [[MARKER], MARKER, null, undefined, 3, new Map([[MARKER, MARKER]])]) {
      expect(errorsOf(raw)).toEqual([{ key: '', code: 'invalid_attribute_type' }]);
    }
  });

  it('an empty object is valid', () => {
    expect(valuesOf({})).toEqual({});
  });

  it('returns every error in input key order, then index; no key or value is dropped silently', () => {
    expect(
      errorsOf({ gamma_text: 1, unknown_one: MARKER, beta_list: ['a', long(201), 'a'], alpha_code: long(201) }),
    ).toEqual([
      { key: 'gamma_text', code: 'invalid_attribute_type' },
      { key: 'unknown_one', code: 'unknown_attribute' },
      { key: 'beta_list', code: 'value_too_long', index: 1 },
      { key: 'beta_list', code: 'invalid_attribute_type', index: 2 },
      { key: 'alpha_code', code: 'value_too_long' },
    ]);
  });

  it('sorts the accepted keys so equal inputs serialize to equal JSON', () => {
    const one = valuesOf({ gamma_text: 'g', alpha_code: 'a', beta_list: ['b'] });
    const two = valuesOf({ beta_list: ['b'], alpha_code: 'a', gamma_text: 'g' });
    expect(Object.keys(one)).toEqual(['alpha_code', 'beta_list', 'gamma_text']);
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });

  it('no error object carries a value', () => {
    const errors = errorsOf({
      alpha_code: { [MARKER]: MARKER },
      beta_list: [MARKER, MARKER, long(201)],
      gamma_text: long(201),
      [`${MARKER}_key`]: MARKER,
    });
    const text = JSON.stringify(errors.filter((error) => !error.key.startsWith(MARKER)));
    expect(text).not.toContain(MARKER);
    for (const error of errors) expect(Object.keys(error).every((name) => ['key', 'code', 'index'].includes(name))).toBe(true);
  });

  it('does not mutate the input', () => {
    const raw = { beta_list: [' a ', 'b'], gamma_text: ' g ' };
    const copy = JSON.parse(JSON.stringify(raw));
    valuesOf(raw);
    expect(raw).toEqual(copy);
  });
});
