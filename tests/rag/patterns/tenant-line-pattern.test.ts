import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/rag/identifiers/probe-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/identifiers/probe-worker')>();
  return { ...actual, runPatternInWorker: vi.fn(actual.runPatternInWorker) };
});

const worker = await import('@/lib/rag/identifiers/probe-worker');
const { checkIdentifierPattern } = await import('@/lib/rag/identifiers/patterns');
const { IDENTIFIER_PATTERN_FINDING_CODES } = await import('@/lib/rag/identifiers/validate');
const { validateIdentifierPattern } = await import('@/lib/rag/identifiers/validate');
const {
  TENANT_LINE_DEFAULT_DEADLINE_MS,
  TENANT_LINE_FINDING_CODES,
  TENANT_LINE_MATCH_WINDOW,
  TENANT_LINE_PATTERN_KINDS,
  TENANT_LINE_PATTERN_LIMITS,
  checkTenantLinePattern,
  matchTenantLinePatterns,
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

describe('matchTenantLinePatterns run-time match (D-11, TPL-08)', () => {
  const lines = ['1. qorvane alpha', 'plain qorvane body', '---', '2. qorvane beta'];

  test('constants', () => {
    expect(TENANT_LINE_MATCH_WINDOW).toBe(200);
    expect(TENANT_LINE_DEFAULT_DEADLINE_MS).toBe(3000);
  });

  test('one worker call per document with every valid entry, the validator flags, window-cut lines and maxSpans 1', async () => {
    const long = `${'q'.repeat(199)}\u{1F600}tail qorvane`;
    const verdict = await matchTenantLinePatterns({
      patterns: [
        { id: 'h1', kind: 'heading', pattern: '^\\d+\\.\\sqorvane', flags: 'u' },
        { id: 'b1', kind: 'boilerplate_line', pattern: '^-{3,}$', flags: 'u' },
        { id: 'h2', kind: 'heading', pattern: '^QORVANE', flags: 'iu' },
      ],
      lines: [...lines, long, 'qorvane x'],
    });
    expect(worker.runPatternInWorker).toHaveBeenCalledTimes(1);
    const [request, options] = vi.mocked(worker.runPatternInWorker).mock.calls[0]!;
    const uFlags = validateIdentifierPattern('^\\d+\\.\\sqorvane', 'u');
    const iuFlags = validateIdentifierPattern('^QORVANE', 'iu');
    expect(request.patterns).toEqual([
      { id: 'h1', source: '^\\d+\\.\\sqorvane', flags: uFlags.ok && uFlags.flags },
      { id: 'b1', source: '^-{3,}$', flags: uFlags.ok && uFlags.flags },
      { id: 'h2', source: '^QORVANE', flags: iuFlags.ok && iuFlags.flags },
    ]);
    expect(request.maxSpans).toBe(1);
    expect(request.inputs.slice(0, 4)).toEqual(lines);
    expect(request.inputs[4]).toHaveLength(199);
    expect(request.inputs[5]).toBe('qorvane x');
    expect(options?.deadlineMs).toBe(3000);
    expect(verdict).toEqual({
      kind: 'ok',
      hits: [
        { inputIndex: 0, patternId: 'h1', start: 0, end: 10 },
        { inputIndex: 2, patternId: 'b1', start: 0, end: 3 },
        { inputIndex: 3, patternId: 'h1', start: 0, end: 10 },
        { inputIndex: 5, patternId: 'h2', start: 0, end: 7 },
      ],
      skipped: [],
    });
  });

  test('a cut at exactly 200 keeps 200 code units when no pair is split', async () => {
    await matchTenantLinePatterns({ patterns: [{ id: 'b', kind: 'boilerplate_line', pattern: 'qorvane', flags: 'u' }], lines: ['z'.repeat(250)] });
    const [request] = vi.mocked(worker.runPatternInWorker).mock.calls[0]!;
    expect(request.inputs[0]).toHaveLength(200);
  });

  test('a match only after the 200th character gives no hit; the first match in the window gives one hit', async () => {
    const verdict = await matchTenantLinePatterns({
      patterns: [{ id: 'b', kind: 'boilerplate_line', pattern: 'qorvane', flags: 'u' }],
      lines: [`${'z'.repeat(200)}qorvane`, 'qorvane qorvane'],
    });
    expect(verdict).toEqual({ kind: 'ok', hits: [{ inputIndex: 1, patternId: 'b', start: 0, end: 7 }], skipped: [] });
  });

  test('entries that fail the static re-check are skipped by id and never sent', async () => {
    const verdict = await matchTenantLinePatterns({
      patterns: [
        { id: 'loose', kind: 'heading', pattern: 'qorvane', flags: 'u' },
        { id: 'ref', kind: 'boilerplate_line', pattern: '^(q)\\1', flags: 'u' },
        { id: 'good', kind: 'heading', pattern: '^plain', flags: 'u' },
      ],
      lines,
    });
    const [request] = vi.mocked(worker.runPatternInWorker).mock.calls[0]!;
    expect(request.patterns.map((p) => p.id)).toEqual(['good']);
    expect(verdict).toEqual({ kind: 'ok', hits: [{ inputIndex: 1, patternId: 'good', start: 0, end: 5 }], skipped: ['loose', 'ref'] });
  });

  test('nothing to run gives ok with no worker call', async () => {
    expect(await matchTenantLinePatterns({ patterns: [{ id: 'loose', kind: 'heading', pattern: 'qorvane', flags: 'u' }], lines })).toEqual({
      kind: 'ok',
      hits: [],
      skipped: ['loose'],
    });
    expect(await matchTenantLinePatterns({ patterns: [{ id: 'b', kind: 'boilerplate_line', pattern: 'qorvane', flags: 'u' }], lines: [] })).toEqual({
      kind: 'ok',
      hits: [],
      skipped: [],
    });
    expect(await matchTenantLinePatterns({ patterns: [], lines })).toEqual({ kind: 'ok', hits: [], skipped: [] });
    expect(worker.runPatternInWorker).not.toHaveBeenCalled();
  });

  test('request limits are checked before any worker call', async () => {
    const entry = (id: string) => ({ id, kind: 'boilerplate_line' as const, pattern: 'qorvane', flags: 'u' });
    const many = Array.from({ length: 101 }, (_, i) => entry(`p${i}`));
    expect(await matchTenantLinePatterns({ patterns: many, lines })).toEqual({ kind: 'error', error: 'too_many_patterns' });
    expect(await matchTenantLinePatterns({ patterns: [entry('a')], lines: Array.from({ length: 20_001 }, () => 'qorvane') })).toEqual({
      kind: 'error',
      error: 'too_many_lines',
    });
    for (const patterns of [[entry('')], [entry('x'.repeat(65))], [entry('a'), entry('a')]]) {
      expect(await matchTenantLinePatterns({ patterns, lines })).toEqual({ kind: 'error', error: 'invalid_pattern_id' });
    }
    expect(worker.runPatternInWorker).not.toHaveBeenCalled();
    const hundred = Array.from({ length: 100 }, (_, i) => entry(`p${i}`));
    expect((await matchTenantLinePatterns({ patterns: hundred, lines: ['qorvane'] })).kind).toBe('ok');
  });

  test('the deadline is clamped to 100..30000', async () => {
    const patterns = [{ id: 'b', kind: 'boilerplate_line' as const, pattern: 'qorvane', flags: 'u' }];
    for (const [given, used] of [[1, 100], [50_000, 30_000], [500, 500]] as const) {
      vi.mocked(worker.runPatternInWorker).mockResolvedValueOnce({ kind: 'ok', elapsedMs: 0, spans: [], counts: {}, alphanumeric: {} });
      await matchTenantLinePatterns({ patterns, lines }, { deadlineMs: given });
      expect(vi.mocked(worker.runPatternInWorker).mock.calls.at(-1)?.[1]?.deadlineMs).toBe(used);
    }
  });

  test('a catastrophic pattern times out at the deadline and the next call still runs', async () => {
    const started = Date.now();
    const verdict = await matchTenantLinePatterns(
      { patterns: [{ id: 'cat', kind: 'heading', pattern: '^(?:x|x)*y', flags: 'u' }], lines: ['x'.repeat(40)] },
      { deadlineMs: 200 },
    );
    expect(verdict).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await matchTenantLinePatterns({ patterns: [{ id: 'ok', kind: 'heading', pattern: '^plain', flags: 'u' }], lines })).toMatchObject({ kind: 'ok' });
  }, 10_000);

  test('worker errors map one to one', async () => {
    const patterns = [{ id: 'b', kind: 'boilerplate_line' as const, pattern: 'qorvane', flags: 'u' }];
    vi.mocked(worker.runPatternInWorker).mockResolvedValueOnce({ kind: 'error', error: 'worker_failed' });
    expect(await matchTenantLinePatterns({ patterns, lines })).toEqual({ kind: 'error', error: 'worker_failed' });
    vi.mocked(worker.runPatternInWorker).mockResolvedValueOnce({ kind: 'error', error: 'invalid_regex' });
    expect(await matchTenantLinePatterns({ patterns, lines })).toEqual({ kind: 'error', error: 'invalid_regex' });
  });

  test('an aborted signal rejects with the abort reason, before or during the call', async () => {
    const patterns = [{ id: 'cat', kind: 'heading' as const, pattern: '^(?:x|x)*y', flags: 'u' }];
    const before = new AbortController();
    const reasonBefore = new Error('stop qorvane before');
    before.abort(reasonBefore);
    await expect(matchTenantLinePatterns({ patterns, lines: ['x'.repeat(40)] }, { signal: before.signal })).rejects.toBe(reasonBefore);
    const during = new AbortController();
    const reasonDuring = new Error('stop qorvane during');
    const pending = matchTenantLinePatterns({ patterns, lines: ['x'.repeat(40)] }, { signal: during.signal, deadlineMs: 5_000 });
    setTimeout(() => during.abort(reasonDuring), 100);
    const started = Date.now();
    await expect(pending).rejects.toBe(reasonDuring);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 10_000);

  test('two callers get only their own indexes and ids', async () => {
    const [first, second] = await Promise.all([
      matchTenantLinePatterns({ patterns: [{ id: 'one', kind: 'heading', pattern: '^qorvane', flags: 'u' }], lines: ['qorvane a'] }),
      matchTenantLinePatterns({ patterns: [{ id: 'two', kind: 'heading', pattern: '^zelmar', flags: 'u' }], lines: ['x', 'y', 'zelmar b'] }),
    ]);
    expect(first).toEqual({ kind: 'ok', hits: [{ inputIndex: 0, patternId: 'one', start: 0, end: 7 }], skipped: [] });
    expect(second).toEqual({ kind: 'ok', hits: [{ inputIndex: 2, patternId: 'two', start: 0, end: 6 }], skipped: [] });
  });

  test('no match with a tenant pattern runs on the calling thread', async () => {
    const tenantSources = new Set(['^qorvane\\b', '^-{3,}$']);
    const offending: string[] = [];
    const isTenant = (value: unknown) => value instanceof RegExp && tenantSources.has(value.source);
    type Methods = Record<string, (..._args: unknown[]) => unknown>;
    const watch = (target: object, method: string, pick: (_self: unknown, _args: unknown[]) => unknown) => {
      const original = (target as Methods)[method]!;
      return vi.spyOn(target as Methods, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (isTenant(pick(this, args))) offending.push(method);
        return Reflect.apply(original, this, args);
      });
    };
    const onSelf = (self: unknown) => self;
    const onFirst = (_self: unknown, args: unknown[]) => args[0];
    const spies = [
      watch(RegExp.prototype, 'exec', onSelf),
      watch(RegExp.prototype, 'test', onSelf),
      watch(String.prototype, 'match', onFirst),
      watch(String.prototype, 'matchAll', onFirst),
      watch(String.prototype, 'replace', onFirst),
      watch(String.prototype, 'search', onFirst),
      watch(String.prototype, 'split', onFirst),
    ];
    try {
      const verdict = await matchTenantLinePatterns({
        patterns: [
          { id: 'h', kind: 'heading', pattern: '^qorvane\\b', flags: 'u' },
          { id: 'b', kind: 'boilerplate_line', pattern: '^-{3,}$', flags: 'u' },
        ],
        lines: ['qorvane one', '---'],
      });
      expect(verdict).toMatchObject({ kind: 'ok' });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(offending).toEqual([]);
  });
});
