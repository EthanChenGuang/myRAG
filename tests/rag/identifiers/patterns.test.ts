import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { mintScope } from '@/lib/rag/tenant/scope';

vi.mock('@/lib/rag/identifiers/probe-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/identifiers/probe-worker')>();
  return { ...actual, runPatternInWorker: vi.fn(actual.runPatternInWorker) };
});

const worker = await import('@/lib/rag/identifiers/probe-worker');
const {
  IdentifierPatternError,
  checkIdentifierPattern,
  createIdentifierPattern,
  deleteIdentifierPattern,
  listIdentifierPatterns,
  loadTenantIdentifierPatterns,
  resetIdentifierPatternCacheForTests,
  testIdentifierPatterns,
  updateIdentifierPattern,
} = await import('@/lib/rag/identifiers/patterns');

const USER_A = '00000000-0000-4000-8000-0000000014a1';
const USER_B = '00000000-0000-4000-8000-0000000014b2';
const scopeA = mintScope('personal', USER_A, null);
const scopeB = mintScope('personal', USER_B, null);
const signal = new AbortController().signal;
const options = { signal };

interface StoredRow {
  id: string;
  tenant_key: string;
  name: string;
  pattern: string;
  flags: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function fakeDb(initial: StoredRow[] = []) {
  const rows = [...initial];
  const calls: Call[] = [];
  const failures = new Map<string, { message: string; code: string }>();
  let seq = 0;
  const visible = (row: StoredRow) => {
    const { tenant_key: _tenant, ...rest } = row;
    return rest;
  };
  const answer = (fn: string, args: Record<string, unknown>): RpcResponse => {
    calls.push({ fn, args });
    const failure = failures.get(fn);
    if (failure) return { data: null, error: failure };
    const tenant = args.p_tenant_key as string;
    switch (fn) {
      case 'rag_identifier_patterns_list':
        return { data: rows.filter((row) => row.tenant_key === tenant).map(visible), error: null };
      case 'rag_identifier_pattern_create': {
        seq += 1;
        const row: StoredRow = {
          id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
          tenant_key: tenant,
          name: args.p_name as string,
          pattern: args.p_pattern as string,
          flags: args.p_flags as string,
          enabled: args.p_enabled as boolean,
          created_at: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
          updated_at: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
        };
        rows.push(row);
        return { data: [visible(row)], error: null };
      }
      case 'rag_identifier_pattern_update': {
        const row = rows.find((r) => r.tenant_key === tenant && r.id === args.p_id);
        if (!row) return { data: null, error: { message: 'pattern_not_found', code: 'P0002' } };
        if (args.p_name !== null) row.name = args.p_name as string;
        if (args.p_pattern !== null) row.pattern = args.p_pattern as string;
        if (args.p_flags !== null) row.flags = args.p_flags as string;
        if (args.p_enabled !== null) row.enabled = args.p_enabled as boolean;
        return { data: [visible(row)], error: null };
      }
      case 'rag_identifier_pattern_delete': {
        const index = rows.findIndex((r) => r.tenant_key === tenant && r.id === args.p_id);
        if (index === -1) return { data: null, error: { message: 'pattern_not_found', code: 'P0002' } };
        rows.splice(index, 1);
        return { data: args.p_id, error: null };
      }
      default:
        return { data: null, error: { message: 'unknown function', code: '42883' } };
    }
  };
  const client: RpcClient = {
    rpc: (fn, args) => {
      const request = {
        abortSignal: () => request,
        then: <A, B>(resolve?: (value: RpcResponse) => A, reject?: (reason: unknown) => B) => Promise.resolve(answer(fn, args)).then(resolve, reject),
      };
      return request as never;
    },
  };
  return { client, rows, calls, failures, count: (fn: string) => calls.filter((call) => call.fn === fn).length };
}

function stored(tenantKey: string, id: string, name: string, pattern: string, flags = 'u', enabled = true): StoredRow {
  return { id, tenant_key: tenantKey, name, pattern, flags, enabled, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
}

const ID_1 = '00000000-0000-4000-8000-0000000000a1';
const ID_2 = '00000000-0000-4000-8000-0000000000a2';
const ID_3 = '00000000-0000-4000-8000-0000000000a3';

let clock = 1_000_000;

beforeEach(() => {
  clock = 1_000_000;
  resetIdentifierPatternCacheForTests();
  vi.mocked(worker.runPatternInWorker).mockClear();
});

afterEach(() => {
  resetIngestDepsForTests();
  vi.restoreAllMocks();
});

function install(db: ReturnType<typeof fakeDb>) {
  setIngestDepsForTests({ db: () => db.client, now: () => clock });
}

async function refusal(promise: Promise<unknown>): Promise<InstanceType<typeof IdentifierPatternError>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(IdentifierPatternError);
    return error as InstanceType<typeof IdentifierPatternError>;
  }
  throw new Error('expected a refusal');
}

describe('probe in the worker (D-52)', () => {
  test('an ordinary shape passes the probe', async () => {
    expect(await checkIdentifierPattern('[A-Z]{2}-[0-9]{4}', 'u')).toMatchObject({ ok: true, compiledFlags: 'gu', storedFlags: 'u' });
    expect(vi.mocked(worker.runPatternInWorker)).toHaveBeenCalledTimes(1);
  });

  test('a catastrophic pattern that passes the static checks is terminated at the deadline and gives probe_too_slow', async () => {
    const started = Date.now();
    expect(await checkIdentifierPattern('(?:x|x)*y', 'u')).toEqual({ ok: false, findings: [{ code: 'probe_too_slow' }] });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  test('a probe set measured over 50 ms inside the worker gives probe_too_slow', async () => {
    vi.mocked(worker.runPatternInWorker).mockResolvedValueOnce({ kind: 'ok', elapsedMs: 51, spans: [], counts: { probe: 3 }, alphanumeric: { probe: true } });
    expect(await checkIdentifierPattern('[A-Z]{2}[0-9]{2}', 'u')).toEqual({ ok: false, findings: [{ code: 'probe_too_slow' }] });
    vi.mocked(worker.runPatternInWorker).mockResolvedValueOnce({ kind: 'ok', elapsedMs: 49, spans: [], counts: { probe: 3 }, alphanumeric: { probe: true } });
    expect(await checkIdentifierPattern('[A-Z]{2}[0-9]{2}', 'u')).toMatchObject({ ok: true });
  });

  test('a pattern that matches no letter or digit in any probe gives no_alphanumeric', async () => {
    expect(await checkIdentifierPattern('[-./]{3}', 'u')).toEqual({ ok: false, findings: [{ code: 'no_alphanumeric' }] });
  });

  test('the probe runs class runs of 10000 characters and a mixed run, all in the worker', async () => {
    await checkIdentifierPattern('Q[0-9]{3}', 'u');
    const request = vi.mocked(worker.runPatternInWorker).mock.calls[0]?.[0];
    expect(request?.patterns).toEqual([{ id: 'probe', source: 'Q[0-9]{3}', flags: 'gu' }]);
    expect(request?.inputs.some((input) => input === 'Q'.repeat(10_000))).toBe(true);
    expect(request?.inputs.some((input) => input === '0'.repeat(10_000))).toBe(true);
    expect(request?.inputs.some((input) => input.length === 10_000 && input.includes('Q000 '))).toBe(true);
  });
});

describe('pattern service', () => {
  test('create and update validate and probe before any database call', async () => {
    const db = fakeDb();
    install(db);
    const created = await refusal(createIdentifierPattern(scopeA, { name: 'shape', pattern: '(?<=Q)[0-9]{3}', flags: 'u' }, options));
    expect(created.code).toBe('invalid_identifier_pattern');
    expect(created.findings).toEqual([{ code: 'lookbehind' }]);
    const slow = await refusal(createIdentifierPattern(scopeA, { name: 'shape', pattern: '(?:x|x)*y', flags: 'u' }, options));
    expect(slow.findings).toEqual([{ code: 'probe_too_slow' }]);
    const updated = await refusal(updateIdentifierPattern(scopeA, ID_1, { pattern: '[0-9]*', flags: 'u' }, options));
    expect(updated.findings).toEqual([{ code: 'matches_empty' }]);
    expect(db.calls).toEqual([]);
  }, 10_000);

  test('create stores the normalized flags and the tenant key from the scope only', async () => {
    const db = fakeDb();
    install(db);
    const row = await createIdentifierPattern(scopeA, { name: '  shape  ', pattern: '[a-z]{2}[0-9]{4}', flags: 'iu', createdBy: USER_A }, options);
    expect(row).toMatchObject({ name: 'shape', pattern: '[a-z]{2}[0-9]{4}', flags: 'iu', enabled: true });
    expect(db.calls[0]).toEqual({
      fn: 'rag_identifier_pattern_create',
      args: { p_tenant_key: `u:${USER_A}`, p_name: 'shape', p_pattern: '[a-z]{2}[0-9]{4}', p_flags: 'iu', p_enabled: true, p_created_by: USER_A },
    });
  });

  test.each([
    ['limit_reached', '54000'],
    ['name_exists', '23505'],
    ['pattern_not_found', 'P0002'],
  ])('the SQL code word %s maps to a typed error', async (word, sqlState) => {
    const db = fakeDb([stored(`u:${USER_A}`, ID_1, 'one', '[A-Z]{3}')]);
    db.failures.set('rag_identifier_pattern_create', { message: `${word} for this tenant`, code: sqlState });
    db.failures.set('rag_identifier_pattern_update', { message: word, code: sqlState });
    install(db);
    const onCreate = await refusal(createIdentifierPattern(scopeA, { name: 'two', pattern: '[0-9]{5}', flags: 'u' }, options));
    expect([onCreate.code, onCreate.rpc, onCreate.sqlState]).toEqual([word, 'rag_identifier_pattern_create', sqlState]);
    const onUpdate = await refusal(updateIdentifierPattern(scopeA, ID_1, { name: 'renamed' }, options));
    expect(onUpdate.code).toBe(word);
  });

  test('a flags-only update is validated against the stored pattern; an unknown id is pattern_not_found', async () => {
    const db = fakeDb([stored(`u:${USER_A}`, ID_1, 'one', '[A-Z]{3}[0-9]')]);
    install(db);
    const row = await updateIdentifierPattern(scopeA, ID_1, { flags: 'iu' }, options);
    expect(row.flags).toBe('iu');
    const call = db.calls.find((c) => c.fn === 'rag_identifier_pattern_update');
    expect(call?.args).toEqual({ p_tenant_key: `u:${USER_A}`, p_id: ID_1, p_name: null, p_pattern: null, p_flags: 'iu', p_enabled: null });
    expect((await refusal(updateIdentifierPattern(scopeA, ID_2, { flags: 'u' }, options))).code).toBe('pattern_not_found');
    expect((await refusal(deleteIdentifierPattern(scopeA, 'not-an-id', options))).code).toBe('pattern_not_found');
  });

  test('another tenant cannot change or delete a pattern: the fake answers pattern_not_found and the row stays', async () => {
    const db = fakeDb([stored(`u:${USER_B}`, ID_1, 'foreign', '[A-Z]{3}[0-9]')]);
    install(db);
    expect((await refusal(updateIdentifierPattern(scopeA, ID_1, { enabled: false }, options))).code).toBe('pattern_not_found');
    expect((await refusal(deleteIdentifierPattern(scopeA, ID_1, options))).code).toBe('pattern_not_found');
    expect(db.rows).toHaveLength(1);
    expect(await listIdentifierPatterns(scopeA, options)).toEqual([]);
  });
});

describe('loadTenantIdentifierPatterns: per-tenant compiled cache', () => {
  test('a second call within the time to live makes no database call; after it, the list is read again', async () => {
    const db = fakeDb([stored(`u:${USER_A}`, ID_1, 'one', '[A-Z]{3}[0-9]'), stored(`u:${USER_A}`, ID_2, 'off', '[0-9]{6}', 'u', false)]);
    install(db);
    const first = await loadTenantIdentifierPatterns(scopeA);
    expect(first.loadFailed).toBe(false);
    expect(first.patternIds).toEqual([ID_1]);
    expect(first.expressions.map((re) => [re.source, re.flags])).toEqual([['[A-Z]{3}[0-9]', 'gu']]);
    const second = await loadTenantIdentifierPatterns(scopeA);
    expect(second).toBe(first);
    expect(db.count('rag_identifier_patterns_list')).toBe(1);
    clock += 60_001;
    await loadTenantIdentifierPatterns(scopeA);
    expect(db.count('rag_identifier_patterns_list')).toBe(2);
  });

  test("tenant A's entry is never returned for tenant B", async () => {
    const db = fakeDb([stored(`u:${USER_A}`, ID_1, 'one', '[A-Z]{3}[0-9]'), stored(`u:${USER_B}`, ID_2, 'two', '[0-9]{3}[A-Z]')]);
    install(db);
    const a = await loadTenantIdentifierPatterns(scopeA);
    const b = await loadTenantIdentifierPatterns(scopeB);
    expect(a.patternIds).toEqual([ID_1]);
    expect(b.patternIds).toEqual([ID_2]);
    expect(db.calls.map((call) => call.args.p_tenant_key)).toEqual([`u:${USER_A}`, `u:${USER_B}`]);
    expect((await loadTenantIdentifierPatterns(scopeA)).patternIds).toEqual([ID_1]);
    expect((await loadTenantIdentifierPatterns(scopeB)).patternIds).toEqual([ID_2]);
  });

  test('create, update and delete invalidate only the changed tenant', async () => {
    const db = fakeDb([stored(`u:${USER_A}`, ID_1, 'one', '[A-Z]{3}[0-9]'), stored(`u:${USER_B}`, ID_2, 'two', '[0-9]{3}[A-Z]')]);
    install(db);
    await loadTenantIdentifierPatterns(scopeA);
    await loadTenantIdentifierPatterns(scopeB);
    const created = await createIdentifierPattern(scopeA, { name: 'new', pattern: 'K[0-9]{4}', flags: 'u' }, options);
    expect((await loadTenantIdentifierPatterns(scopeA)).patternIds).toEqual([ID_1, created.id]);
    await updateIdentifierPattern(scopeA, ID_1, { enabled: false }, options);
    expect((await loadTenantIdentifierPatterns(scopeA)).patternIds).toEqual([created.id]);
    await deleteIdentifierPattern(scopeA, created.id, options);
    expect((await loadTenantIdentifierPatterns(scopeA)).patternIds).toEqual([]);
    expect(db.calls.filter((call) => call.fn === 'rag_identifier_patterns_list' && call.args.p_tenant_key === `u:${USER_B}`)).toHaveLength(1);
  });

  test('a load failure answers an empty list with loadFailed; a stored row failing the static checks is skipped', async () => {
    const db = fakeDb([stored(`u:${USER_A}`, ID_1, 'bad', '(?<=Q)[0-9]'), stored(`u:${USER_A}`, ID_2, 'good', '[0-9]{3}[A-Z]')]);
    install(db);
    expect((await loadTenantIdentifierPatterns(scopeA)).patternIds).toEqual([ID_2]);
    resetIdentifierPatternCacheForTests();
    db.failures.set('rag_identifier_patterns_list', { message: 'canceling statement', code: '57014' });
    expect(await loadTenantIdentifierPatterns(scopeA)).toEqual({ expressions: [], patternIds: [], loadFailed: true });
    setIngestDepsForTests({ db: () => null });
    resetIdentifierPatternCacheForTests();
    expect((await loadTenantIdentifierPatterns(scopeA)).loadFailed).toBe(true);
  });

  test('resetIdentifierPatternCacheForTests clears the cache', async () => {
    const db = fakeDb([stored(`u:${USER_A}`, ID_1, 'one', '[A-Z]{3}[0-9]')]);
    install(db);
    await loadTenantIdentifierPatterns(scopeA);
    resetIdentifierPatternCacheForTests();
    await loadTenantIdentifierPatterns(scopeA);
    expect(db.count('rag_identifier_patterns_list')).toBe(2);
  });
});

describe('testIdentifierPatterns', () => {
  const tenantPatterns = () => [
    stored(`u:${USER_A}`, ID_1, 'saved', 'QZ[0-9]{3}'),
    stored(`u:${USER_A}`, ID_2, 'disabled', 'WV[0-9]{3}', 'u', false),
    stored(`u:${USER_A}`, ID_3, 'letters', 'K-[A-Z]{3}'),
  ];

  test('a sample over 10000 characters is refused; a draft is refused with the same findings as save', async () => {
    install(fakeDb(tenantPatterns()));
    expect((await refusal(testIdentifierPatterns(scopeA, 'x'.repeat(10_001), null, options))).code).toBe('sample_too_long');
    const draft = await refusal(testIdentifierPatterns(scopeA, 'QZ123', { pattern: '(?:[A-Z]+)+', flags: 'u' }, options));
    expect(draft.code).toBe('invalid_identifier_pattern');
    expect(draft.findings).toEqual([{ code: 'nested_unbounded_quantifier' }]);
  });

  test('matches come from the built-in rule, enabled saved patterns and the draft, with sources and UTF-16 offsets into the sample', async () => {
    install(fakeDb(tenantPatterns()));
    const sample = 'Ref: QZ123 and K-ABC, then WV555, ab-77 and ＴＴ９9 and LM-ÄÖ end 😀 MN4';
    const result = await testIdentifierPatterns(scopeA, sample, { pattern: 'MN[0-9]', flags: 'u' }, options);
    for (const match of result.matches) expect(sample.slice(match.start, match.end)).toBe(match.raw);
    const bySource = result.matches.map((match) => [match.raw, match.source, match.normalized]);
    expect(bySource).toContainEqual(['K-ABC', ID_3, 'kabc']);
    expect(bySource).toContainEqual(['MN4', 'built_in', 'mn4']);
    expect(bySource).toContainEqual(['ab-77', 'built_in', 'ab77']);
    expect(bySource).toContainEqual(['QZ123', 'built_in', 'qz123']);
    expect(bySource.find(([raw]) => raw === 'WV555')?.[1]).toBe('built_in');
    expect(result.tested.patternIds).toEqual([ID_1, ID_3]);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(result.matches.length);
    const call = vi.mocked(worker.runPatternInWorker).mock.calls.at(-1)?.[0];
    expect(call?.patterns.map((p) => p.id)).toEqual([ID_1, ID_3, 'draft']);
    expect(call?.inputs).toEqual([sample]);
  });

  test('leftmost-longest merge: the longer tenant match wins, a tie goes to the built-in rule, a draft with an id replaces its saved version', async () => {
    install(fakeDb(tenantPatterns()));
    const sample = 'see QZ123-X9 now';
    const longer = await testIdentifierPatterns(scopeA, sample, { pattern: 'QZ[0-9]{3}-X[0-9] now', flags: 'u' }, options);
    expect(longer.matches).toEqual([{ raw: 'QZ123-X9 now', normalized: 'qz123x9now', source: 'draft', start: 4, end: 16 }]);
    const tie = await testIdentifierPatterns(scopeA, sample, { pattern: 'QZ[0-9]{3}-X9', flags: 'u' }, options);
    expect(tie.matches).toEqual([{ raw: 'QZ123-X9', normalized: 'qz123x9', source: 'built_in', start: 4, end: 12 }]);
    const replaced = await testIdentifierPatterns(scopeA, 'K-ABC', { id: ID_3, pattern: 'K-[A-Z]{2}', flags: 'u' }, options);
    expect(replaced.matches).toEqual([{ raw: 'K-AB', normalized: 'kab', source: 'draft', start: 0, end: 4 }]);
    expect(replaced.tested.patternIds).toEqual([ID_1]);
  });

  test('at most 500 matches are returned with truncated and the total', async () => {
    install(fakeDb([]));
    const sample = Array.from({ length: 700 }, (_, i) => `A${i}`).join(' ');
    const result = await testIdentifierPatterns(scopeA, sample, null, options);
    expect(result.matches).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(700);
  });

  test('the test operation reads only the sample and the tenant pattern list', async () => {
    const db = fakeDb(tenantPatterns());
    install(db);
    await testIdentifierPatterns(scopeA, 'QZ123', null, options);
    expect(db.calls.map((call) => call.fn)).toEqual(['rag_identifier_patterns_list']);
  });
});

describe('logs carry ids, counts and error names only', () => {
  test('no log line contains a pattern, a sample or a match', async () => {
    const spies = (['log', 'info', 'debug', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    const db = fakeDb([stored(`u:${USER_A}`, ID_1, 'bad', '(?<=SECRETPAT)[0-9]')]);
    install(db);
    await loadTenantIdentifierPatterns(scopeA);
    const created = await createIdentifierPattern(scopeA, { name: 'SECRETNAME', pattern: 'SECRETPAT[0-9]{2}', flags: 'u' }, options);
    await updateIdentifierPattern(scopeA, created.id, { pattern: 'SECRETPAT[0-9]{3}' }, options);
    await testIdentifierPatterns(scopeA, 'SECRETSAMPLE SECRETPAT123 XY99', { pattern: 'XY[0-9]{2}', flags: 'u' }, options);
    await deleteIdentifierPattern(scopeA, created.id, options);
    db.failures.set('rag_identifier_patterns_list', { message: 'SECRETPAT in message', code: '57014' });
    resetIdentifierPatternCacheForTests();
    await loadTenantIdentifierPatterns(scopeA);
    const logged = spies
      .flatMap((spy) => spy.mock.calls)
      .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
      .join('\n');
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of ['SECRETPAT', 'SECRETSAMPLE', 'SECRETNAME', 'XY99', '123']) expect(logged).not.toContain(secret);
  });
});
