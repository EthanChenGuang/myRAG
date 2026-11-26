import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';
import { canonicalJson } from '@/lib/rag-eval/trace';

vi.mock('@/lib/rag/patterns/tenant-line-pattern', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/patterns/tenant-line-pattern')>();
  return { ...actual, checkTenantLinePattern: vi.fn(actual.checkTenantLinePattern), validateTenantLinePattern: vi.fn(actual.validateTenantLinePattern) };
});
vi.mock('@/lib/rag/ingest/current-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/ingest/current-config')>();
  return { ...actual, currentIngestConfig: vi.fn(actual.currentIngestConfig) };
});

const wrapper = await import('@/lib/rag/patterns/tenant-line-pattern');
const actualWrapper = await vi.importActual<typeof import('@/lib/rag/patterns/tenant-line-pattern')>('@/lib/rag/patterns/tenant-line-pattern');
const actualConfig = await vi.importActual<typeof import('@/lib/rag/ingest/current-config')>('@/lib/rag/ingest/current-config');
const currentConfig = await import('@/lib/rag/ingest/current-config');
const service = await import('@/lib/rag/ingest/rules/service');
const loader = await import('@/lib/rag/ingest/rules/load');

const ORG_A = '00000000-0000-4000-8000-0000000072c1';
const ORG_B = '00000000-0000-4000-8000-0000000072c2';
const ACTOR = '00000000-0000-4000-8000-0000000072F1';
const scopeA = mintScope('org', null, ORG_A);
const scopeB = mintScope('org', null, ORG_B);
const KEY_A = scopeKey(scopeA);
const KEY_B = scopeKey(scopeB);
const MARKER = 'Qzmarkerzq';

type Row = Record<string, unknown>;

interface Log {
  kind: 'rpc' | 'check';
  name: string;
  args?: Record<string, unknown>;
}

let log: Log[];
let now: number;
let answers: Map<string, (_args: Record<string, unknown>) => RpcResponse | Promise<RpcResponse>>;

function request(produce: () => RpcResponse | Promise<RpcResponse>): RpcRequest {
  const req: RpcRequest = {
    abortSignal: () => req,
    then: (resolve, reject) => Promise.resolve().then(produce).then(resolve, reject),
  };
  return req;
}

const client: RpcClient = {
  rpc(fn, args) {
    log.push({ kind: 'rpc', name: fn, args });
    const answer = answers.get(fn);
    return request(() => (answer ? answer(args) : { data: [], error: null }));
  },
};

const rpcCalls = (name?: string) => log.filter((entry) => entry.kind === 'rpc' && (name === undefined || entry.name === name));

function admin(tenantKey = KEY_A) {
  return { actorUserId: ACTOR, tenantKey, signal: new AbortController().signal };
}

function heading(pattern = '^\\d+\\. ', overrides: Row = {}): Row {
  return { pattern, name: 'Part', level: 1, ...overrides };
}

function storedSet(body: Row, id = randomUUID()): Row {
  const { name, doc_type, source, enabled, headings, ...rest } = body;
  return {
    id,
    name,
    doc_type: doc_type ?? null,
    source: source ?? null,
    enabled: enabled ?? true,
    rules: {
      headings: (headings as Row[]).map((h) => ({ flags: 'u', required: false, restart: false, ...h })),
      require_increasing_numbers: false,
      skip_toc: true,
      toc_min_run: 3,
      ...rest,
    },
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function storedRule(body: Row, id = randomUUID()): Row {
  return {
    id,
    name: body.name,
    kind: body.kind,
    pattern: body.pattern ?? null,
    flags: body.flags ?? null,
    max_length: body.max_length ?? null,
    min_page_share: body.min_page_share ?? null,
    doc_type: body.doc_type ?? null,
    source: body.source ?? null,
    enabled: body.enabled ?? true,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function rulesRows(tenantKey: string): Row[] {
  const marker = tenantKey === KEY_A ? 'a' : 'b';
  return [
    {
      entry: 'rule_set',
      id: tenantKey === KEY_A ? '00000000-0000-4000-8000-00000000a001' : '00000000-0000-4000-8000-00000000b001',
      name: `${MARKER} set ${marker}`,
      version: 2,
      doc_type: 'general',
      source: null,
      precedence: 2,
      rules: { headings: [{ pattern: `^${marker}\\d+ `, flags: 'u', name: `${MARKER} heading`, level: 1, required: false, restart: true }], require_increasing_numbers: true, skip_toc: true, toc_min_run: 4 },
      kind: null,
      pattern: null,
      flags: null,
      max_length: null,
      min_page_share: null,
    },
    {
      entry: 'boilerplate_rule',
      id: tenantKey === KEY_A ? '00000000-0000-4000-8000-00000000a002' : '00000000-0000-4000-8000-00000000b002',
      name: `${MARKER} line`,
      version: 1,
      doc_type: null,
      source: null,
      precedence: 4,
      rules: null,
      kind: 'line',
      pattern: `^${MARKER} \\d+$`,
      flags: 'iu',
      max_length: null,
      min_page_share: null,
    },
    {
      entry: 'boilerplate_rule',
      id: '00000000-0000-4000-8000-00000000a003',
      name: `${MARKER} fragment`,
      version: 3,
      doc_type: null,
      source: null,
      precedence: 4,
      rules: null,
      kind: 'fragment',
      pattern: null,
      flags: null,
      max_length: 30,
      min_page_share: 0.6,
    },
  ];
}

let consoleCalls: unknown[][];

beforeEach(() => {
  log = [];
  now = 1_000_000;
  answers = new Map();
  answers.set('rag_tenant_rules_for', (args) => ({ data: rulesRows(args.p_tenant_key as string), error: null }));
  consoleCalls = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
  vi.mocked(wrapper.checkTenantLinePattern).mockReset();
  vi.mocked(wrapper.checkTenantLinePattern).mockImplementation(async (kind, pattern, flags, options) => {
    log.push({ kind: 'check', name: kind });
    return actualWrapper.checkTenantLinePattern(kind, pattern, flags, options);
  });
  vi.mocked(currentConfig.currentIngestConfig).mockReset();
  vi.mocked(currentConfig.currentIngestConfig).mockImplementation(actualConfig.currentIngestConfig);
  setIngestDepsForTests({ db: () => client, now: () => now });
  loader.resetTenantRuleCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetIngestDepsForTests();
  loader.resetTenantRuleCacheForTests();
});

function assertNoMarkerLogged(): void {
  const text = JSON.stringify(consoleCalls);
  expect(text).not.toContain(MARKER);
  expect(text).not.toContain('Part');
}

describe('saveSectionRuleSet', () => {
  test('parses, checks every heading pattern as a heading, then calls the upsert rpc once with the actor and tenant', async () => {
    answers.set('rag_section_rule_set_upsert', (args) => ({ data: [storedSet(args.p_rule_set as Row)], error: null }));
    const result = await service.saveSectionRuleSet(admin(), { name: `${MARKER} set`, headings: [heading(), heading('^[A-Z]\\) ', { level: 2 })] });
    expect(result.ok).toBe(true);
    expect(log.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(['check:heading', 'check:heading', 'rpc:rag_section_rule_set_upsert']);
    const args = rpcCalls()[0]!.args!;
    expect(args.p_actor).toBe(ACTOR.toLowerCase());
    expect(args.p_tenant_key).toBe(KEY_A);
    expect(args.p_id).toBeNull();
    expect(args.p_rule_set).toEqual({
      name: `${MARKER} set`,
      enabled: true,
      headings: [
        { pattern: '^\\d+\\. ', flags: 'u', name: 'Part', level: 1, required: false, restart: false },
        { pattern: '^[A-Z]\\) ', flags: 'u', name: 'Part', level: 2, required: false, restart: false },
      ],
      require_increasing_numbers: false,
      skip_toc: true,
      toc_min_run: 3,
    });
    if (result.ok) {
      expect(result.item.version).toBe(1);
      expect(result.item.ruleSet.headings).toHaveLength(2);
    }
    assertNoMarkerLogged();
  });

  test('one refused pattern makes no rpc and answers its index and finding codes only', async () => {
    const result = await service.saveSectionRuleSet(admin(), { name: 'Set', headings: [heading(), heading(`${MARKER}\\d+`)] });
    expect(result).toEqual({ ok: false, reason: 'invalid_tenant_pattern', patternIndex: 1, findings: ['heading_not_anchored'] });
    expect(rpcCalls()).toHaveLength(0);
    assertNoMarkerLogged();
  });

  test('a catastrophic pattern is refused by the probe and makes no rpc', async () => {
    const result = await service.saveSectionRuleSet(admin(), { name: 'Set', headings: [heading('^(a+)+$')] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_tenant_pattern');
    expect(rpcCalls()).toHaveLength(0);
  });

  test('61 heading patterns: limit_reached heading_patterns before any check', async () => {
    const headings = Array.from({ length: 61 }, (_, index) => heading(`^${index}\\. `));
    expect(await service.saveSectionRuleSet(admin(), { name: 'Set', headings })).toEqual({ ok: false, reason: 'limit_reached', limit: 'heading_patterns' });
    expect(log).toHaveLength(0);
  });

  test('shape, limits and binding values are refused as invalid_argument before any check or rpc', async () => {
    const bad: unknown[] = [
      { name: 'n'.repeat(81), headings: [heading()] },
      { name: 'Set', headings: [heading(`^${'a'.repeat(200)}`)] },
      { name: 'Set', headings: [heading(undefined, { flags: 'g' })] },
      { name: 'Set', headings: [heading(undefined, { level: 7 })] },
      { name: 'Set', headings: [] },
      { name: 'Set', headings: [heading()], extra: true },
      { name: 'Set', headings: [heading()], doc_type: 'not_a_type' },
      { name: 'Set', headings: [heading()], source: 'upload' },
      [],
      null,
    ];
    for (const body of bad) expect(await service.saveSectionRuleSet(admin(), body)).toEqual({ ok: false, reason: 'invalid_argument' });
    expect(await service.saveSectionRuleSet({ ...admin(), actorUserId: 'not-a-uuid' }, { name: 'Set', headings: [heading()] })).toEqual({ ok: false, reason: 'invalid_argument' });
    expect(await service.saveSectionRuleSet({ ...admin(), tenantKey: 'o:not-a-key' }, { name: 'Set', headings: [heading()] })).toEqual({ ok: false, reason: 'invalid_argument' });
    expect(await service.saveSectionRuleSet(admin(), { name: 'Set', headings: [heading()] }, 'bad-id')).toEqual({ ok: false, reason: 'invalid_argument' });
    expect(log).toHaveLength(0);
  });

  test('a known source binding is accepted and an id replaces that row', async () => {
    const id = randomUUID();
    answers.set('rag_section_rule_set_upsert', (args) => ({ data: [{ ...storedSet(args.p_rule_set as Row, id), version: 2 }], error: null }));
    const result = await service.saveSectionRuleSet(admin(), { name: 'Set', headings: [heading()], source: 'config_upload', doc_type: 'general' }, id.toUpperCase());
    expect(result.ok && result.item.version).toBe(2);
    expect(rpcCalls()[0]!.args!.p_id).toBe(id);
  });
});

describe('boilerplate rules', () => {
  test('a line rule is checked as a boilerplate line before the rpc; a fragment rule makes no check', async () => {
    answers.set('rag_boilerplate_rule_upsert', (args) => ({ data: [storedRule(args.p_rule as Row)], error: null }));
    const line = await service.saveBoilerplateRule(admin(), { name: 'Line', kind: 'line', pattern: '^-+$', flags: 'u' });
    expect(line.ok).toBe(true);
    expect(log.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(['check:boilerplate_line', 'rpc:rag_boilerplate_rule_upsert']);
    log = [];
    const fragment = await service.saveBoilerplateRule(admin(), { name: 'Fragment', kind: 'fragment', max_length: 30, min_page_share: 0.5 });
    expect(fragment.ok && fragment.item.rule).toEqual({ name: 'Fragment', kind: 'fragment', max_length: 30, min_page_share: 0.5, enabled: true });
    expect(log.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(['rpc:rag_boilerplate_rule_upsert']);
  });

  test('a refused line pattern makes no rpc; mixed shapes are invalid_argument', async () => {
    expect(await service.saveBoilerplateRule(admin(), { name: 'Line', kind: 'line', pattern: '(a)\\1', flags: 'u' })).toMatchObject({
      ok: false,
      reason: 'invalid_tenant_pattern',
      patternIndex: 0,
    });
    for (const body of [
      { name: 'Line', kind: 'line', pattern: '^x$' },
      { name: 'Line', kind: 'line', pattern: '^x$', flags: 'u', max_length: 3 },
      { name: 'Fragment', kind: 'fragment', max_length: 3 },
      { name: 'Fragment', kind: 'fragment', max_length: 3, min_page_share: 0.5, pattern: '^x$' },
      { name: 'Fragment', kind: 'fragment', max_length: 3, min_page_share: 0.5, source: 'upload' },
    ]) {
      expect(await service.saveBoilerplateRule(admin(), body)).toEqual({ ok: false, reason: 'invalid_argument' });
    }
    expect(rpcCalls()).toHaveLength(0);
  });

  test('list and delete pass the actor and map rows', async () => {
    const rows = [storedRule({ name: 'A', kind: 'line', pattern: '^a$', flags: 'u' }), storedRule({ name: 'B', kind: 'fragment', max_length: 5, min_page_share: 1 })];
    answers.set('rag_boilerplate_rules_list', () => ({ data: rows, error: null }));
    answers.set('rag_boilerplate_rule_delete', (args) => ({ data: args.p_id, error: null }));
    const listed = await service.listBoilerplateRules(admin());
    expect(listed.ok && listed.items.map((item) => item.rule.name)).toEqual(['A', 'B']);
    const id = String(rows[0]!.id);
    expect(await service.deleteBoilerplateRule(admin(), id)).toEqual({ ok: true, id });
    expect(rpcCalls('rag_boilerplate_rule_delete')[0]!.args).toEqual({ p_actor: ACTOR.toLowerCase(), p_tenant_key: KEY_A, p_id: id });
  });
});

describe('failure mapping', () => {
  test('SQL code words, 22023 and anything else map to the fixed reasons; no database message reaches the result or a log', async () => {
    const cases: [RpcResponse['error'] & { details?: string }, unknown][] = [
      [{ message: 'not_admin', code: '42501' }, { ok: false, reason: 'not_admin' }],
      [{ message: 'not_found', code: 'P0002' }, { ok: false, reason: 'not_found' }],
      [{ message: 'name_exists', code: '23505' }, { ok: false, reason: 'name_exists' }],
      [{ message: 'limit_reached', code: '54000', details: 'rule_sets' }, { ok: false, reason: 'limit_reached', limit: 'rule_sets' }],
      [{ message: 'limit_reached', code: '54000', details: 'binding' }, { ok: false, reason: 'limit_reached', limit: 'binding' }],
      [{ message: `invalid_argument ${MARKER}`, code: '22023' }, { ok: false, reason: 'invalid_argument' }],
      [{ message: `${MARKER} relation exploded`, code: 'XX000' }, { ok: false, reason: 'unavailable' }],
    ];
    for (const [error, expected] of cases) {
      answers.set('rag_section_rule_set_upsert', () => ({ data: null, error }));
      const result = await service.saveSectionRuleSet(admin(), { name: 'Set', headings: [heading()] });
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain(MARKER);
    }
    answers.set('rag_section_rule_sets_list', () => {
      throw new Error(MARKER);
    });
    expect(await service.listSectionRuleSets(admin())).toEqual({ ok: false, reason: 'unavailable' });
    setIngestDepsForTests({ db: () => null });
    expect(await service.deleteSectionRuleSet(admin(), randomUUID())).toEqual({ ok: false, reason: 'unavailable' });
    assertNoMarkerLogged();
  });

  test('a malformed row from the database is unavailable', async () => {
    answers.set('rag_section_rule_sets_list', () => ({ data: [{ id: randomUUID(), name: 'x', rules: 'nope', version: 1 }], error: null }));
    expect(await service.listSectionRuleSets(admin())).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('switches', () => {
  test('both are false with the variables unset', () => {
    expect(service.sectionRulesEnabled()).toBe(false);
    expect(service.pageBoilerplateEnabled()).toBe(false);
  });

  test('they follow the effective configuration and need the unified pipeline', () => {
    const base = currentConfig.currentIngestConfig();
    const mocked = vi.mocked(currentConfig.currentIngestConfig);
    mocked.mockReturnValue({ ...base, pipeline: 'unified', sectionRules: 'on', pageBoilerplate: 'rules' } as typeof base);
    expect(service.sectionRulesEnabled()).toBe(true);
    expect(service.pageBoilerplateEnabled()).toBe(true);
    mocked.mockReturnValue({ ...base, pipeline: 'unified', sectionRules: 'off', pageBoilerplate: 'off' } as typeof base);
    expect(service.sectionRulesEnabled()).toBe(false);
    expect(service.pageBoilerplateEnabled()).toBe(false);
    mocked.mockReturnValue({ ...base, pipeline: 'legacy', sectionRules: 'on', pageBoilerplate: 'detect' } as typeof base);
    expect(service.sectionRulesEnabled()).toBe(false);
    expect(service.pageBoilerplateEnabled()).toBe(false);
  });
});

describe('loadTenantRules', () => {
  const binding = { docType: 'general', source: 'config_upload' };

  test('returns the chosen rule set and the rules as plain data, with ids, versions and a SHA-256 fingerprint', async () => {
    const rules = await loader.loadTenantRules(scopeA, binding);
    expect(rpcCalls()[0]!.args).toEqual({ p_tenant_key: KEY_A, p_doc_type: 'general', p_source: 'config_upload' });
    expect(rules.loadFailed).toBe(false);
    expect(rules.skipped).toBe(0);
    expect(rules.ruleSet).toEqual({
      id: '00000000-0000-4000-8000-00000000a001',
      version: 2,
      docType: 'general',
      source: null,
      headings: [{ pattern: '^a\\d+ ', flags: 'u', name: `${MARKER} heading`, level: 1, required: false, restart: true }],
      requireIncreasingNumbers: true,
      skipToc: true,
      tocMinRun: 4,
    });
    expect(rules.boilerplateRules.map((rule) => [rule.kind, rule.pattern, rule.flags, rule.maxLength, rule.minPageShare])).toEqual([
      ['line', `^${MARKER} \\d+$`, 'iu', null, null],
      ['fragment', null, null, 30, 0.6],
    ]);
    expect(rules.ruleIds).toEqual([
      { kind: 'rule_set', id: '00000000-0000-4000-8000-00000000a001', version: 2 },
      { kind: 'boilerplate_rule', id: '00000000-0000-4000-8000-00000000a002', version: 1 },
      { kind: 'boilerplate_rule', id: '00000000-0000-4000-8000-00000000a003', version: 3 },
    ]);
    const expected = createHash('sha256').update(canonicalJson({ ruleSet: rules.ruleSet, boilerplateRules: rules.boilerplateRules })).digest('hex');
    expect(rules.fingerprint).toBe(expected);
    expect(JSON.parse(JSON.stringify(rules))).toEqual(rules);
    const walk = (value: unknown): void => {
      expect(value instanceof RegExp).toBe(false);
      if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(rules);
    assertNoMarkerLogged();
  });

  test('a second call within the time to live makes no rpc; after it the loader reloads', async () => {
    await loader.loadTenantRules(scopeA, binding);
    now += 59_999;
    await loader.loadTenantRules(scopeA, binding);
    expect(rpcCalls()).toHaveLength(1);
    now += 2;
    await loader.loadTenantRules(scopeA, binding);
    expect(rpcCalls()).toHaveLength(2);
  });

  test("tenant A's entry is never served to tenant B with the same binding", async () => {
    const a = await loader.loadTenantRules(scopeA, binding);
    const b = await loader.loadTenantRules(scopeB, binding);
    expect(rpcCalls().map((entry) => entry.args!.p_tenant_key)).toEqual([KEY_A, KEY_B]);
    expect(a.ruleSet?.id).toBe('00000000-0000-4000-8000-00000000a001');
    expect(b.ruleSet?.id).toBe('00000000-0000-4000-8000-00000000b001');
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect((await loader.loadTenantRules(scopeB, binding)).ruleSet?.id).toBe('00000000-0000-4000-8000-00000000b001');
    expect(rpcCalls()).toHaveLength(2);
  });

  test('each binding is cached on its own', async () => {
    await loader.loadTenantRules(scopeA, binding);
    await loader.loadTenantRules(scopeA, { docType: 'general', source: null });
    await loader.loadTenantRules(scopeA, { docType: null, source: null });
    await loader.loadTenantRules(scopeA, binding);
    expect(rpcCalls()).toHaveLength(3);
  });

  test("a save or delete invalidates the writer's tenant only", async () => {
    answers.set('rag_section_rule_set_upsert', (args) => ({ data: [storedSet(args.p_rule_set as Row)], error: null }));
    answers.set('rag_boilerplate_rule_delete', (args) => ({ data: args.p_id, error: null }));
    await loader.loadTenantRules(scopeA, binding);
    await loader.loadTenantRules(scopeB, binding);
    expect((await service.saveSectionRuleSet(admin(KEY_A), { name: 'Set', headings: [heading()] })).ok).toBe(true);
    log = [];
    await loader.loadTenantRules(scopeA, binding);
    await loader.loadTenantRules(scopeB, binding);
    expect(rpcCalls('rag_tenant_rules_for').map((entry) => entry.args!.p_tenant_key)).toEqual([KEY_A]);
    expect((await service.deleteBoilerplateRule(admin(KEY_B), randomUUID())).ok).toBe(true);
    log = [];
    await loader.loadTenantRules(scopeA, binding);
    await loader.loadTenantRules(scopeB, binding);
    expect(rpcCalls('rag_tenant_rules_for').map((entry) => entry.args!.p_tenant_key)).toEqual([KEY_B]);
  });

  test('a failed write does not invalidate', async () => {
    answers.set('rag_section_rule_set_upsert', () => ({ data: null, error: { message: 'not_admin', code: '42501' } }));
    await loader.loadTenantRules(scopeA, binding);
    await service.saveSectionRuleSet(admin(KEY_A), { name: 'Set', headings: [heading()] });
    log = [];
    await loader.loadTenantRules(scopeA, binding);
    expect(rpcCalls()).toHaveLength(0);
  });

  test('a write that lands during a load is not overwritten by that load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    answers.set('rag_tenant_rules_for', async (args) => {
      await gate;
      return { data: rulesRows(args.p_tenant_key as string), error: null };
    });
    const pending = loader.loadTenantRules(scopeA, binding);
    await Promise.resolve();
    loader.invalidateTenantRules(KEY_A);
    release();
    await pending;
    answers.set('rag_tenant_rules_for', (args) => ({ data: rulesRows(args.p_tenant_key as string), error: null }));
    await loader.loadTenantRules(scopeA, binding);
    expect(rpcCalls()).toHaveLength(2);
  });

  test('a load failure answers no rules with loadFailed, kept for 5 seconds only', async () => {
    answers.set('rag_tenant_rules_for', () => ({ data: null, error: { message: `${MARKER} gone`, code: 'XX000' } }));
    const failed = await loader.loadTenantRules(scopeA, binding);
    expect(failed).toMatchObject({ ruleSet: null, boilerplateRules: [], ruleIds: [], loadFailed: true, skipped: 0 });
    now += 4_999;
    await loader.loadTenantRules(scopeA, binding);
    expect(rpcCalls()).toHaveLength(1);
    now += 2;
    answers.set('rag_tenant_rules_for', (args) => ({ data: rulesRows(args.p_tenant_key as string), error: null }));
    expect((await loader.loadTenantRules(scopeA, binding)).loadFailed).toBe(false);
    assertNoMarkerLogged();
  });

  test('no client, a throwing rpc and a malformed row are load failures', async () => {
    setIngestDepsForTests({ db: () => null });
    expect((await loader.loadTenantRules(scopeA, binding)).loadFailed).toBe(true);
    setIngestDepsForTests({ db: () => client });
    loader.resetTenantRuleCacheForTests();
    answers.set('rag_tenant_rules_for', () => {
      throw new Error(MARKER);
    });
    expect((await loader.loadTenantRules(scopeA, binding)).loadFailed).toBe(true);
    loader.resetTenantRuleCacheForTests();
    answers.set('rag_tenant_rules_for', () => ({ data: [{ entry: 'rule_set', id: randomUUID(), version: 1, rules: { headings: 'x' } }], error: null }));
    expect((await loader.loadTenantRules(scopeA, binding)).loadFailed).toBe(true);
    loader.resetTenantRuleCacheForTests();
    answers.set('rag_tenant_rules_for', () => ({ data: [{ entry: 'other', id: randomUUID() }], error: null }));
    expect((await loader.loadTenantRules(scopeA, binding)).loadFailed).toBe(true);
    assertNoMarkerLogged();
  });

  test('an aborted signal rethrows', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(loader.loadTenantRules(scopeA, binding, { signal: controller.signal })).rejects.toThrow('stop');
    const late = new AbortController();
    answers.set('rag_tenant_rules_for', () => {
      late.abort(new Error('late'));
      return { data: null, error: { message: 'canceled', code: '57014' } };
    });
    await expect(loader.loadTenantRules(scopeA, binding, { signal: late.signal })).rejects.toThrow('late');
  });

  test('a stored pattern that fails the static check is left out and counted', async () => {
    answers.set('rag_tenant_rules_for', (args) => {
      const rows = rulesRows(args.p_tenant_key as string);
      (rows[0]!.rules as Row).headings = [{ pattern: `${MARKER}\\d+`, flags: 'u', name: 'H', level: 1 }];
      rows[1]!.pattern = '(a)\\1';
      return { data: rows, error: null };
    });
    const rules = await loader.loadTenantRules(scopeA, binding);
    expect(rules.ruleSet).toBeNull();
    expect(rules.boilerplateRules.map((rule) => rule.kind)).toEqual(['fragment']);
    expect(rules.skipped).toBe(2);
    expect(rules.loadFailed).toBe(false);
    assertNoMarkerLogged();
  });

  test('an unminted scope throws; a malformed binding answers no rules without an rpc', async () => {
    await expect(loader.loadTenantRules({ kind: 'org', userId: null, organizationId: ORG_A } as never, binding)).rejects.toThrow();
    expect((await loader.loadTenantRules(scopeA, { docType: 'Bad Type', source: null })).loadFailed).toBe(true);
    expect(rpcCalls()).toHaveLength(0);
  });

  test('at most 256 tenants and 64 bindings per tenant are kept, oldest first out', async () => {
    const scopes = Array.from({ length: 257 }, () => mintScope('personal', randomUUID(), null));
    for (const scope of scopes) await loader.loadTenantRules(scope, binding);
    expect(rpcCalls()).toHaveLength(257);
    await loader.loadTenantRules(scopes[256]!, binding);
    expect(rpcCalls()).toHaveLength(257);
    await loader.loadTenantRules(scopes[0]!, binding);
    expect(rpcCalls()).toHaveLength(258);

    loader.resetTenantRuleCacheForTests();
    log = [];
    const bindings = Array.from({ length: 65 }, (_, index) => ({ docType: `t${index}`, source: null }));
    for (const entry of bindings) await loader.loadTenantRules(scopeA, entry);
    await loader.loadTenantRules(scopeA, bindings[64]!);
    expect(rpcCalls()).toHaveLength(65);
    await loader.loadTenantRules(scopeA, bindings[0]!);
    expect(rpcCalls()).toHaveLength(66);
  });
});
