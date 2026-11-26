import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TPL-08 (D-24, D-34): `rag:rules import|export`. All-or-nothing validation of a rule file kept outside the repository, the report that
 * always comes first, the apply pass through the rule service and the export, against an in-memory fake of the 1002 functions. MARKER is a
 * rule name, a heading name and part of a pattern; it must never reach output or a log.
 */

const MARKER = 'QZXMARKERWORD';
const ACTOR = '00000000-0000-4000-8000-0000000014a1';
const ORG_A = '00000000-0000-4000-8000-0000000014c1';
const ORG_B = '00000000-0000-4000-8000-0000000014c2';
const ON = {
  RAG_INGEST_PIPELINE: 'unified',
  RAG_SECTION_RULES: 'on',
  RAG_PAGE_BOILERPLATE: 'rules',
  RAG_SUPPORTED_LANGUAGES: 'en',
  RAG_PRIMARY_LANGUAGE: 'en',
};

type Row = Record<string, unknown>;
type Call = { fn: string; args: Row };

let logs: string[] = [];
let dir = '';

beforeEach(async () => {
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation(capture);
  dir = await mkdtemp(path.join(os.tmpdir(), 'rules-cli-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(dir, { recursive: true, force: true });
});

const heading = (name: string, pattern: string) => ({ pattern, flags: 'u', name, level: 1, required: false, restart: false });
const ruleSet = (name: string, extra: Row = {}) => ({
  name,
  enabled: true,
  headings: [heading(`${name} level`, '^\\d+\\.')],
  require_increasing_numbers: false,
  skip_toc: true,
  toc_min_run: 3,
  ...extra,
});
const lineRule = (name: string, extra: Row = {}) => ({ name, kind: 'line', pattern: '^-{3,}$', flags: 'u', enabled: true, ...extra });

/** An in-memory model of the 1002 list, upsert and delete functions, keyed by tenant. */
function fakeStore() {
  const tenants = new Map<string, { sets: Row[]; rules: Row[] }>();
  const calls: Call[] = [];
  let next = 1;
  let failUpsertAt: number | null = null;
  let upserts = 0;
  let notAdmin = false;
  const bucket = (key: string) => {
    let entry = tenants.get(key);
    if (!entry) tenants.set(key, (entry = { sets: [], rules: [] }));
    return entry;
  };
  const answer = (fn: string, args: Row): { data: unknown; error: Row | null } => {
    const tenant = bucket(String(args.p_tenant_key));
    if (fn === 'rag_section_rule_sets_list') return { data: tenant.sets.map((row) => ({ ...row })), error: null };
    if (fn === 'rag_boilerplate_rules_list') return { data: tenant.rules.map((row) => ({ ...row })), error: null };
    if (fn.endsWith('_upsert')) {
      upserts += 1;
      if (notAdmin) return { data: null, error: { code: '42501', message: 'not_admin' } };
      if (failUpsertAt !== null && upserts === failUpsertAt) return { data: null, error: { code: 'XX000', message: 'connection lost' } };
      const isSet = fn === 'rag_section_rule_set_upsert';
      const list = isSet ? tenant.sets : tenant.rules;
      const body = (isSet ? args.p_rule_set : args.p_rule) as Row;
      const columns = isSet
        ? { name: body.name, doc_type: body.doc_type ?? null, source: body.source ?? null, enabled: body.enabled, rules: { headings: body.headings, require_increasing_numbers: body.require_increasing_numbers, skip_toc: body.skip_toc, toc_min_run: body.toc_min_run } }
        : { name: body.name, kind: body.kind, pattern: body.pattern ?? null, flags: body.flags ?? null, max_length: body.max_length ?? null, min_page_share: body.min_page_share ?? null, doc_type: body.doc_type ?? null, source: body.source ?? null, enabled: body.enabled };
      const time = '2026-11-26T10:00:00.000Z';
      if (args.p_id) {
        const row = list.find((item) => item.id === args.p_id);
        if (!row) return { data: null, error: { code: 'P0002', message: 'not_found' } };
        Object.assign(row, columns, { version: (row.version as number) + 1, updated_at: time });
        return { data: [{ ...row }], error: null };
      }
      if (list.some((item) => item.name === body.name)) return { data: null, error: { code: '23505', message: 'name_exists' } };
      const row = { id: `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`, ...columns, version: 1, created_at: time, updated_at: time };
      list.push(row);
      return { data: [{ ...row }], error: null };
    }
    return { data: [], error: null };
  };
  const db = {
    rpc(fn: string, args?: Row) {
      calls.push({ fn, args: args ?? {} });
      const response = answer(fn, args ?? {});
      const request = {
        abortSignal: () => request,
        then: (ok: (value: unknown) => unknown, ko?: (reason: unknown) => unknown) => Promise.resolve(response).then(ok, ko),
      };
      return request;
    },
  };
  return {
    db,
    calls,
    tenants,
    failAt: (index: number) => void (failUpsertAt = index),
    refuseActor: () => void (notAdmin = true),
    reset: () => {
      calls.length = 0;
      upserts = 0;
      failUpsertAt = null;
    },
  };
}

type Store = ReturnType<typeof fakeStore>;

interface RunOptions {
  env?: Record<string, string>;
  scope?: 'ok' | 'refused' | 'unavailable';
  org?: string;
  cwd?: string;
  abort?: boolean;
}

async function run(store: Store, argv: string[], options: RunOptions = {}) {
  vi.resetModules();
  const deps = await import('@/lib/rag/ingest/deps');
  const config = await import('@/lib/rag/ingest/current-config');
  (config as { resetIngestConfigForTests?: () => void }).resetIngestConfigForTests?.();
  deps.setIngestDepsForTests({ db: () => store.db as never, ingestEnv: () => ({ ...(options.env ?? ON) }) as never });
  const out: string[] = [];
  const err: string[] = [];
  const scopeCalls: string[] = [];
  const controller = new AbortController();
  if (options.abort) controller.abort(new Error('interrupted'));
  try {
    const { mintScope } = await import('@/lib/rag/tenant/scope');
    const cli = await import('@/lib/rag/ingest/rules/cli');
    const code = await cli.main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, controller.signal, {
      resolveScope: async (key: string) => {
        scopeCalls.push(key);
        if (options.scope === 'refused') return { ok: false, reason: 'invalid_tenant' };
        if (options.scope === 'unavailable') return { ok: false, reason: 'unavailable' };
        return { ok: true, scope: mintScope('org', null, options.org ?? ORG_A) };
      },
      cwd: options.cwd ?? path.join(dir, 'workspace'),
    });
    return { code, out, err, scopeCalls, all: [...out, ...err, ...logs].join('\n') };
  } finally {
    deps.resetIngestDepsForTests();
  }
}

async function rulesFile(name: string, content: unknown): Promise<string> {
  const target = path.join(dir, name);
  await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content));
  return target;
}

const writes = (store: Store) => store.calls.filter((call) => /_(upsert|delete)$/.test(call.fn));
const importArgs = (file: string, ...rest: string[]) => ['import', '--tenant', `o:${ORG_A}`, '--actor', ACTOR, '--file', file, ...rest];

describe('parseRulesArgs', () => {
  it('accepts the two subcommands and refuses every malformed form with usage', async () => {
    const { parseRulesArgs, USAGE } = await import('@/lib/rag/ingest/rules/cli');
    expect(parseRulesArgs(['import', '--tenant', 's:default', '--actor', ACTOR, '--file', 'f.json'])).toEqual({
      ok: true,
      command: 'import',
      tenantKey: 's:default',
      actorUserId: ACTOR,
      file: 'f.json',
      apply: false,
    });
    expect(parseRulesArgs(['import', '--tenant', 's:default', '--actor', ACTOR, '--file', 'f.json', '--apply'])).toMatchObject({ ok: true, apply: true });
    expect(parseRulesArgs(['export', '--tenant', 's:default', '--actor', ACTOR, '--out', 'o.json'])).toEqual({
      ok: true,
      command: 'export',
      tenantKey: 's:default',
      actorUserId: ACTOR,
      out: 'o.json',
    });
    const bad = [
      [],
      ['--tenant', 's:default'],
      ['import', '--actor', ACTOR, '--file', 'f'],
      ['import', '--tenant', 's:default', '--file', 'f'],
      ['import', '--tenant', 's:default', '--actor', ACTOR],
      ['import', '--tenant', 's:default', '--actor', 'not-a-uuid', '--file', 'f'],
      ['import', '--tenant', 's:default', '--actor', ACTOR, '--file', 'f', '--dry-run', '--apply'],
      ['export', '--tenant', 's:default', '--actor', ACTOR, '--out', 'o', '--apply'],
      ['export', '--tenant', 's:default', '--actor', ACTOR, '--out', 'o', '--file', 'f'],
      ['import', '--tenant', 's:default', '--tenant', 's:default', '--actor', ACTOR, '--file', 'f'],
      ['import', '--tenant', '--actor', ACTOR, '--file', 'f'],
      ['import', '--tenant', 's:default', '--actor', ACTOR, '--file', 'f', '--bogus'],
    ];
    for (const argv of bad) expect(parseRulesArgs(argv).ok, argv.join(' ')).toBe(false);
    for (const word of ['0 done', '1 failed', '2 report only', '3 file refused', '64 usage']) expect(USAGE).toContain(word);
  });
});

describe('rag:rules switches', () => {
  it('exits 64 with one fixed line before any tenant check, file read or rpc while both switches are off', async () => {
    const store = fakeStore();
    const result = await run(store, importArgs(path.join(dir, 'missing.json')), { env: { RAG_INGEST_PIPELINE: 'unified' } });
    expect(result.code).toBe(64);
    expect(result.err.filter((line) => line.includes('RAG_SECTION_RULES') && line.includes('RAG_PAGE_BOILERPLATE') && line.includes('RAG_INGEST_PIPELINE=unified'))).toHaveLength(1);
    expect(result.scopeCalls).toEqual([]);
    expect(store.calls).toEqual([]);
    const legacy = await run(store, importArgs(path.join(dir, 'missing.json')), { env: { ...ON, RAG_INGEST_PIPELINE: 'legacy' } });
    expect(legacy.code).toBe(64);
    expect(store.calls).toEqual([]);
  });

  it('exits 64 naming the variable when the file carries a list whose switch is off', async () => {
    const store = fakeStore();
    const file = await rulesFile('rules.json', { schema_version: 1, boilerplate_rules: [lineRule('rule-a')] });
    const result = await run(store, importArgs(file), { env: { ...ON, RAG_PAGE_BOILERPLATE: 'off' } });
    expect(result.code).toBe(64);
    expect(result.err.join('\n')).toContain('RAG_PAGE_BOILERPLATE');
    expect(store.calls).toEqual([]);
  });
});

describe('rag:rules import', () => {
  it('refuses a refused tenant with 64 and an unavailable check with 1', async () => {
    const store = fakeStore();
    const file = await rulesFile('rules.json', { section_rule_sets: [ruleSet('set-a')] });
    expect((await run(store, importArgs(file), { scope: 'refused' })).code).toBe(64);
    expect((await run(store, importArgs(file), { scope: 'unavailable' })).code).toBe(1);
    expect(store.calls).toEqual([]);
  });

  it.each([
    ['not JSON', '{'],
    ['a tenant field', { tenant_key: `o:${ORG_B}`, section_rule_sets: [] }],
    ['a rule set with an unknown field', { section_rule_sets: [{ ...ruleSet('set-a'), actor: ACTOR }] }],
    ['a line rule without a pattern', { boilerplate_rules: [{ name: 'rule-a', kind: 'line', enabled: true }] }],
    ['two rule sets of one name', { section_rule_sets: [ruleSet('set-a'), ruleSet('set-a', { doc_type: 'general' })] }],
  ])('refuses %s with exit 3, issue paths and codes, and no rpc', async (_label, content) => {
    const store = fakeStore();
    const file = await rulesFile('rules.json', content);
    const result = await run(store, importArgs(file, '--apply'));
    expect(result.code).toBe(3);
    expect(result.err.join('\n')).toContain('file refused');
    expect(store.calls).toEqual([]);
  });

  it('refuses a file over 2 MB with exit 3', async () => {
    const store = fakeStore();
    const file = await rulesFile('big.json', `{"section_rule_sets":[],"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`);
    const result = await run(store, importArgs(file));
    expect(result.code).toBe(3);
    expect(store.calls).toEqual([]);
  });

  it('refuses the whole file when one pattern fails the save-time check, listing its place and codes, never the pattern', async () => {
    const store = fakeStore();
    const sets = [ruleSet('set-a'), ruleSet(`set-${MARKER}`, { headings: [heading('ok', '^\\d+'), heading(MARKER, `${MARKER}\\d+`)] })];
    const file = await rulesFile('rules.json', { section_rule_sets: sets, boilerplate_rules: [lineRule('rule-a', { pattern: `(${MARKER}` })] });
    const result = await run(store, importArgs(file, '--apply'));
    expect(result.code).toBe(3);
    const text = result.err.join('\n');
    expect(text).toContain('section_rule_sets[1].headings[1]: heading_not_anchored');
    expect(text).toMatch(/boilerplate_rules\[0\]: [a-z_]+/);
    expect(result.all).not.toContain(MARKER);
    expect(store.calls.filter((call) => !call.fn.endsWith('_list'))).toEqual([]);
  });

  it('refuses projected limits with exit 3 limit_reached and the limit name', async () => {
    const store = fakeStore();
    const eleven = Array.from({ length: 11 }, (_, i) => ruleSet(`set-${i}`, { enabled: false }));
    const file = await rulesFile('rules.json', { section_rule_sets: eleven.slice(0, 10) });
    store.tenants.set(`o:${ORG_A}`, { sets: [], rules: [] });
    expect((await run(store, importArgs(file, '--apply'))).code).toBe(0);
    store.reset();
    const extra = await rulesFile('extra.json', { section_rule_sets: [eleven[10]] });
    const result = await run(store, importArgs(extra, '--apply'));
    expect(result.code).toBe(3);
    expect(result.err.join('\n')).toContain('limit_reached: rule_sets');
    expect(writes(store)).toEqual([]);

    const binding = await rulesFile('binding.json', { section_rule_sets: [ruleSet('set-x'), ruleSet('set-y')] });
    const fresh = fakeStore();
    const bound = await run(fresh, importArgs(binding));
    expect(bound.code).toBe(3);
    expect(bound.err.join('\n')).toContain('limit_reached: binding');
  });

  it('reports first and exits 2 without --apply or with --dry-run, with no write rpc', async () => {
    const store = fakeStore();
    const file = await rulesFile('rules.json', { section_rule_sets: [ruleSet('set-a')], boilerplate_rules: [lineRule('rule-a')] });
    for (const extra of [[], ['--dry-run']]) {
      const result = await run(store, importArgs(file, ...extra));
      expect(result.code).toBe(2);
      expect(result.out.join('\n')).toContain('section rule sets: create 1, replace 0, unchanged 0, kept 0');
      expect(result.out.join('\n')).toContain('boilerplate rules: create 1, replace 0, unchanged 0, kept 0');
      expect(writes(store)).toEqual([]);
    }
  });

  it('applies with --apply through the service, then a second identical run is all unchanged with zero writes', async () => {
    const store = fakeStore();
    const file = await rulesFile('rules.json', { section_rule_sets: [ruleSet('set-a')], boilerplate_rules: [lineRule('rule-a')] });
    const first = await run(store, importArgs(file, '--apply'));
    expect(first.code).toBe(0);
    expect(writes(store).map((call) => [call.fn, call.args.p_tenant_key, call.args.p_actor])).toEqual([
      ['rag_section_rule_set_upsert', `o:${ORG_A}`, ACTOR],
      ['rag_boilerplate_rule_upsert', `o:${ORG_A}`, ACTOR],
    ]);
    expect(first.out.every((line) => line.startsWith('[RAG Rules]'))).toBe(true);
    store.reset();
    const second = await run(store, importArgs(file, '--apply'));
    expect(second.code).toBe(0);
    expect(second.out.join('\n')).toContain('section rule sets: create 0, replace 0, unchanged 1, kept 0');
    expect(writes(store)).toEqual([]);
  });

  it('replaces changed rows, keeps rows the file does not name and writes a disabled result before an enabled one', async () => {
    const store = fakeStore();
    const seed = await rulesFile('seed.json', { section_rule_sets: [ruleSet('set-a'), ruleSet('set-z', { doc_type: 'general' })] });
    expect((await run(store, importArgs(seed, '--apply'))).code).toBe(0);
    store.reset();
    const moved = await rulesFile('moved.json', { section_rule_sets: [ruleSet('set-b'), ruleSet('set-a', { enabled: false })] });
    const result = await run(store, importArgs(moved, '--apply'));
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toContain('section rule sets: create 1, replace 1, unchanged 0, kept 1');
    const order = writes(store).map((call) => [(call.args.p_rule_set as Row).enabled, call.args.p_id === null ? 'create' : 'replace']);
    expect(order).toEqual([
      [false, 'replace'],
      [true, 'create'],
    ]);
    expect(writes(store).some((call) => call.fn.endsWith('_delete'))).toBe(false);
  });

  it('exits 1 on a refusal midway, says how many writes landed, and a rerun completes', async () => {
    const store = fakeStore();
    const file = await rulesFile('rules.json', { section_rule_sets: [ruleSet('set-a')], boilerplate_rules: [lineRule('rule-a'), lineRule('rule-b')] });
    store.failAt(2);
    const failed = await run(store, importArgs(file, '--apply'));
    expect(failed.code).toBe(1);
    expect(failed.err.join('\n')).toContain('1 of 3 writes applied');
    expect(failed.all).not.toContain('connection lost');
    store.reset();
    const rerun = await run(store, importArgs(file, '--apply'));
    expect(rerun.code).toBe(0);
    expect(rerun.out.join('\n')).toContain('section rule sets: create 0, replace 0, unchanged 1, kept 0');
    expect(store.tenants.get(`o:${ORG_A}`)?.rules).toHaveLength(2);
  });

  it('exits 64 with actor refused when the actor is not an admin, and 1 when interrupted', async () => {
    const store = fakeStore();
    store.refuseActor();
    const file = await rulesFile('rules.json', { section_rule_sets: [ruleSet('set-a')] });
    const refused = await run(store, importArgs(file, '--apply'));
    expect(refused.code).toBe(64);
    expect(refused.err.join('\n')).toContain('actor refused');
    const aborted = await run(fakeStore(), importArgs(file, '--apply'), { abort: true });
    expect(aborted.code).toBe(1);
  });
});

describe('rag:rules export', () => {
  const exportArgs = (out: string, org = ORG_A) => ['export', '--tenant', `o:${org}`, '--actor', ACTOR, '--out', out];

  it('writes a new 0600 file in the contract shape; import into another tenant creates every row and its export is byte-equal', async () => {
    const store = fakeStore();
    const seed = await rulesFile('seed.json', {
      section_rule_sets: [ruleSet(`set-${MARKER}`, { enabled: false }), ruleSet('set-a')],
      boilerplate_rules: [lineRule('rule-a'), { name: 'rule-f', kind: 'fragment', max_length: 40, min_page_share: 0.5, enabled: true }],
    });
    expect((await run(store, importArgs(seed, '--apply'))).code).toBe(0);
    const outA = path.join(dir, 'export-a.json');
    const exported = await run(store, exportArgs(outA));
    expect(exported.code).toBe(0);
    expect(exported.all).not.toContain(MARKER);
    expect((await stat(outA)).mode & 0o777).toBe(0o600);
    const textA = await readFile(outA, 'utf8');
    for (const banned of ['tenant_key', '"id"', 'version', 'updated_at', ACTOR]) expect(textA).not.toContain(banned);

    store.reset();
    const intoB = await run(store, ['import', '--tenant', `o:${ORG_B}`, '--actor', ACTOR, '--file', outA, '--apply'], { org: ORG_B });
    expect(intoB.code).toBe(0);
    expect(intoB.out.join('\n')).toContain('section rule sets: create 2, replace 0, unchanged 0, kept 0');
    expect(writes(store).every((call) => call.args.p_tenant_key === `o:${ORG_B}`)).toBe(true);
    const outB = path.join(dir, 'export-b.json');
    expect((await run(store, exportArgs(outB, ORG_B), { org: ORG_B })).code).toBe(0);
    expect(await readFile(outB, 'utf8')).toBe(textA);
  });

  it('refuses an existing path and a path inside the working tree, and writes no file for zero rows', async () => {
    const store = fakeStore();
    const existing = await rulesFile('exists.json', '{}');
    expect((await run(store, exportArgs(existing))).code).toBe(64);
    const inside = path.join(dir, 'workspace', 'out.json');
    expect((await run(store, exportArgs(inside), { cwd: path.join(dir, 'workspace') })).code).toBe(64);
    expect(store.calls).toEqual([]);
    const empty = path.join(dir, 'empty.json');
    expect((await run(store, exportArgs(empty))).code).toBe(0);
    await expect(stat(empty)).rejects.toThrow();
  });

  it('writes only the lists whose switch is on', async () => {
    const store = fakeStore();
    const seed = await rulesFile('seed.json', { section_rule_sets: [ruleSet('set-a')], boilerplate_rules: [lineRule('rule-a')] });
    expect((await run(store, importArgs(seed, '--apply'))).code).toBe(0);
    const out = path.join(dir, 'only-sets.json');
    expect((await run(store, exportArgs(out), { env: { ...ON, RAG_PAGE_BOILERPLATE: 'off' } })).code).toBe(0);
    const parsed = JSON.parse(await readFile(out, 'utf8'));
    expect(Object.keys(parsed).sort()).toEqual(['schema_version', 'section_rule_sets']);
  });
});
