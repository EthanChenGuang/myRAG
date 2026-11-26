import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/rag/identifiers/probe-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/identifiers/probe-worker')>();
  return { ...actual, runPatternInWorker: vi.fn(actual.runPatternInWorker) };
});

const worker = await import('@/lib/rag/identifiers/probe-worker');
const { checkIdentifierPattern } = await import('@/lib/rag/identifiers/patterns');
const { IDENTIFIER_PATTERN_FINDING_CODES } = await import('@/lib/rag/identifiers/validate');
const {
  TENANT_LINE_FINDING_CODES,
  TENANT_LINE_PATTERN_KINDS,
  TENANT_LINE_PATTERN_LIMITS,
  checkTenantLinePattern,
  validateTenantLinePattern,
} = await import('@/lib/rag/patterns/tenant-line-pattern');

type Kind = (typeof TENANT_LINE_PATTERN_KINDS)[number];

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function codes(kind: Kind, pattern: string, flags = 'u'): string[] {
  const result = validateTenantLinePattern(kind, pattern, flags);
  return result.ok ? [] : result.findings.map((finding) => finding.code);
}

const consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method));

afterEach(() => {
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockClear();
  }
  vi.mocked(worker.runPatternInWorker).mockClear();
});

describe('tenant line pattern constants (D-11)', () => {
  test('kinds, limits and finding codes', () => {
    expect([...TENANT_LINE_PATTERN_KINDS]).toEqual(['heading', 'boilerplate_line']);
    expect(TENANT_LINE_PATTERN_LIMITS.maxPatternLength).toBe(200);
    const expected = IDENTIFIER_PATTERN_FINDING_CODES.filter((code) => code !== 'no_alphanumeric') as string[];
    expected.splice(expected.indexOf('probe_too_slow'), 0, 'heading_not_anchored');
    expect([...TENANT_LINE_FINDING_CODES]).toEqual(expected);
    expect(TENANT_LINE_FINDING_CODES).not.toContain('no_alphanumeric');
  });
});

describe('validateTenantLinePattern static rules (D-11, TPL-08)', () => {
  test('an anchored heading is accepted with the validator flags', () => {
    const result = validateTenantLinePattern('heading', '^\\d+\\.\\sqorvane', 'u');
    expect(result).toEqual({ ok: true, storedFlags: 'u', compiledFlags: 'gu' });
    expect(validateTenantLinePattern('heading', '^qorvane\\b', 'iu')).toEqual({ ok: true, storedFlags: 'iu', compiledFlags: 'giu' });
  });

  test('too_long: 200 characters pass, 201 do not', () => {
    const at = `^q${'z'.repeat(TENANT_LINE_PATTERN_LIMITS.maxPatternLength - 2)}`;
    expect(at).toHaveLength(200);
    expect(codes('boilerplate_line', at)).toEqual([]);
    expect(codes('boilerplate_line', `${at}z`)).toEqual(['too_long']);
  });

  test.each([
    ['u', true],
    ['iu', true],
    ['', false],
    ['g', false],
    ['m', false],
    ['su', false],
    ['ui', false],
  ])('flags %j accepted: %s', (flags, accepted) => {
    expect(codes('boilerplate_line', '^qorvane', flags).includes('invalid_flags')).toBe(!accepted);
  });

  test('validator codes, one accepting and one rejecting case each', () => {
    expect(codes('boilerplate_line', '^(q)\\1')).toContain('backreference');
    expect(codes('boilerplate_line', '^(q)z')).toEqual([]);
    expect(codes('boilerplate_line', '(?<=q)z')).toContain('lookbehind');
    expect(codes('boilerplate_line', '(?=q)qz')).toEqual([]);
    expect(codes('boilerplate_line', '^(?:q+z)+')).toContain('nested_unbounded_quantifier');
    expect(codes('boilerplate_line', '^(?:qz)?z')).toEqual([]);
    expect(codes('boilerplate_line', '^z*')).toContain('matches_empty');
    expect(codes('boilerplate_line', '^z+')).toEqual([]);
    expect(codes('boilerplate_line', '^[q')).toContain('invalid_regex');
    expect(codes('boilerplate_line', '^[q]')).toEqual([]);
  });

  test.each(['^\\d+\\.', '^(?:alpha|beta)\\b', '^x|^y', '^[|]x', '^(?:a|b)'])('heading %j is anchored', (pattern) => {
    expect(codes('heading', pattern)).toEqual([]);
  });

  test.each(['\\d+\\.', '^x|y', '(?:^x)', '\\^x', 'x|^y'])('heading %j is not anchored, boilerplate line is accepted', (pattern) => {
    expect(codes('heading', pattern)).toEqual(['heading_not_anchored']);
    expect(codes('boilerplate_line', pattern)).toEqual([]);
  });

  test('findings are returned together in the code order', () => {
    expect(codes('heading', '(?<=q)z')).toEqual(['lookbehind', 'heading_not_anchored']);
    expect(codes('heading', 'z*', 'g')).toEqual(['invalid_flags', 'matches_empty', 'heading_not_anchored']);
  });

  test('importing and validating make no worker call', () => {
    validateTenantLinePattern('heading', '^qorvane', 'u');
    validateTenantLinePattern('boilerplate_line', 'qorvane', 'u');
    expect(worker.runPatternInWorker).not.toHaveBeenCalled();
  });
});

describe('checkTenantLinePattern save-time check (D-11, TPL-08)', () => {
  test('a static refusal makes no worker call', async () => {
    expect(await checkTenantLinePattern('heading', 'qorvane', 'u')).toEqual({ ok: false, findings: [{ code: 'heading_not_anchored' }] });
    expect(await checkTenantLinePattern('boilerplate_line', '^(q)\\1', 'u')).toEqual({ ok: false, findings: [{ code: 'backreference' }] });
    expect(worker.runPatternInWorker).not.toHaveBeenCalled();
  });

  test('an accepted heading is probed once and returns the validator flags', async () => {
    expect(await checkTenantLinePattern('heading', '^\\d+\\.\\sqorvane', 'iu')).toEqual({ ok: true, storedFlags: 'iu', compiledFlags: 'giu' });
    expect(worker.runPatternInWorker).toHaveBeenCalledTimes(1);
  });

  test.each(['^-{3,}$', '^\\*{4,}$', '^={4,}$'])('punctuation-only boilerplate line %j is accepted although the shared check refuses it', async (pattern) => {
    expect(await checkIdentifierPattern(pattern, 'u')).toEqual({ ok: false, findings: [{ code: 'no_alphanumeric' }] });
    expect(await checkTenantLinePattern('boilerplate_line', pattern, 'u')).toEqual({ ok: true, storedFlags: 'u', compiledFlags: 'gu' });
  });

  test('probe_too_slow and invalid_regex from the probe are refusals', async () => {
    vi.mocked(worker.runPatternInWorker).mockResolvedValueOnce({ kind: 'ok', elapsedMs: 51, spans: [], counts: { probe: 1 }, alphanumeric: { probe: true } });
    expect(await checkTenantLinePattern('heading', '^qorvane', 'u')).toEqual({ ok: false, findings: [{ code: 'probe_too_slow' }] });
    vi.mocked(worker.runPatternInWorker).mockResolvedValueOnce({ kind: 'error', error: 'invalid_regex' });
    expect(await checkTenantLinePattern('heading', '^qorvane', 'u')).toEqual({ ok: false, findings: [{ code: 'invalid_regex' }] });
  });

  test('a catastrophic heading passes the static checks and is refused by the probe in bounded time', async () => {
    expect(validateTenantLinePattern('heading', '^(?:x|x)*y', 'u').ok).toBe(true);
    const started = Date.now();
    expect(await checkTenantLinePattern('heading', '^(?:x|x)*y', 'u')).toEqual({ ok: false, findings: [{ code: 'probe_too_slow' }] });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  test('an aborted signal rejects with the abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('stop qorvane');
    controller.abort(reason);
    await expect(checkTenantLinePattern('heading', '^qorvane', 'u', { signal: controller.signal })).rejects.toBe(reason);
  });
});
