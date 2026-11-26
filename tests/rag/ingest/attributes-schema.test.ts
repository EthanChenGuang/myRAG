import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestDeps } from '@/lib/rag/ingest/deps';

const ACTOR = '00000000-0000-4000-8000-000000100341';
const ORG_A = '00000000-0000-4000-8000-000000100342';
const ORG_B = '00000000-0000-4000-8000-000000100343';
const USER_U = '00000000-0000-4000-8000-000000100344';
const KEY_A = `o:${ORG_A}`;
const SECRET = 'placeholder-secret-zq81';

type Row = Record<string, unknown>;
type Outcome = { data: unknown; error: { code?: string; message: string } | null } | Error;

const state = {
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, Outcome | ((args: Record<string, unknown>) => Outcome)>,
  now: 1_000_000,
  env: {} as Record<string, string>,
};

function fakeDb() {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      state.calls.push({ fn, args });
      const configured = state.outcomes[fn];
      const outcome = typeof configured === 'function' ? configured(args) : (configured ?? { data: [], error: null });
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          (outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

const DEFINITION_ROW = { key: 'alpha_code', type: 'code', filterable: true, in_header: false, in_identifier_index: true, soft: false };
const STORED_ROW = { ...DEFINITION_ROW, updated_at: '2026-11-26T10:00:00.000Z' };

async function load() {
  vi.resetModules();
  const deps = await import('@/lib/rag/ingest/deps');
  deps.setIngestDepsForTests({
    db: () => fakeDb() as never,
    now: () => state.now,
    ingestEnv: () => state.env as ReturnType<IngestDeps['ingestEnv']>,
  });
  const schema = await import('@/lib/rag/ingest/attributes/schema');
  const tenant = await import('@/lib/rag/tenant/scope');
  schema.resetAttributeSchemaCacheForTests();
  return { schema, tenant };
}

type Loaded = Awaited<ReturnType<typeof load>>;

const signal = () => new AbortController().signal;
const admin = (tenantKey = KEY_A) => ({ actorUserId: ACTOR, tenantKey, signal: signal() });
const forCalls = () => state.calls.filter((call) => call.fn === 'rag_attribute_definitions_for');

function loggedText(): string {
  return [console.log, console.info, console.debug, console.warn, console.error]
    .flatMap((spy) => vi.mocked(spy).mock.calls)
    .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    .join('\n');
}

beforeEach(() => {
  state.calls = [];
  state.outcomes = {};
  state.now = 1_000_000;
  state.env = { RAG_INGEST_PIPELINE: 'unified', RAG_DOC_ATTRIBUTES: 'true' };
  for (const name of ['log', 'info', 'debug', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation(() => undefined);
});

afterEach(() => {
  expect(loggedText()).not.toContain(SECRET);
  vi.restoreAllMocks();
});

describe('docAttributesEnabled', () => {
  it('is false by default and under the legacy pipeline, true only under unified with the switch on', async () => {
    const { schema } = await load();
    state.env = {};
    expect(schema.docAttributesEnabled()).toBe(false);
    state.env = { RAG_DOC_ATTRIBUTES: 'true' };
    expect(schema.docAttributesEnabled()).toBe(false);
    state.env = { RAG_DOC_ATTRIBUTES: 'true', RAG_INGEST_PIPELINE: 'legacy' };
    expect(schema.docAttributesEnabled()).toBe(false);
    state.env = { RAG_INGEST_PIPELINE: 'unified' };
    expect(schema.docAttributesEnabled()).toBe(false);
    state.env = { RAG_DOC_ATTRIBUTES: 'true', RAG_INGEST_PIPELINE: 'unified' };
    expect(schema.docAttributesEnabled()).toBe(true);
  });

  it('importing the modules makes no database call', async () => {
    await load();
    await import('@/lib/rag/ingest/attributes/validate');
    expect(state.calls).toEqual([]);
  });
});

describe('admin service', () => {
  let loaded: Loaded;
  beforeEach(async () => {
    loaded = await load();
  });

  it('lists the tenant definitions for the actor', async () => {
    state.outcomes.rag_attribute_definitions_list = { data: [STORED_ROW], error: null };
    const result = await loaded.schema.listAttributeDefinitions(admin());
    expect(result).toEqual({ ok: true, items: [{ ...DEFINITION_ROW, updatedAt: '2026-11-26T10:00:00.000Z' }] });
    expect(state.calls).toEqual([{ fn: 'rag_attribute_definitions_list', args: { p_actor: ACTOR, p_tenant_key: KEY_A } }]);
  });

  it('upserts with every flag and returns the stored row', async () => {
    state.outcomes.rag_attribute_definition_upsert = { data: [STORED_ROW], error: null };
    const result = await loaded.schema.upsertAttributeDefinition(admin(), { key: 'alpha_code', type: 'code', filterable: true, in_identifier_index: true });
    expect(result).toEqual({ ok: true, item: { ...DEFINITION_ROW, updatedAt: '2026-11-26T10:00:00.000Z' } });
    expect(state.calls[0]).toEqual({
      fn: 'rag_attribute_definition_upsert',
      args: {
        p_actor: ACTOR,
        p_tenant_key: KEY_A,
        p_key: 'alpha_code',
        p_type: 'code',
        p_filterable: true,
        p_in_header: false,
        p_in_identifier_index: true,
        p_soft: false,
      },
    });
  });

  it('checks key pattern, type and the code-only flag before any database call', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ key: 'Upper', type: 'text' }, 'invalid_argument'],
      [{ key: '1lead', type: 'text' }, 'invalid_argument'],
      [{ key: `k${'x'.repeat(40)}`, type: 'text' }, 'invalid_argument'],
      [{ key: 'ok_key', type: 'number' }, 'invalid_argument'],
      [{ key: 'ok_key', type: 'text', filterable: 'yes' }, 'invalid_argument'],
      [{ key: 'ok_key', type: 'text', in_identifier_index: true }, 'invalid_attribute_type'],
      [{ key: 'ok_key', type: 'text_list', in_identifier_index: true }, 'invalid_attribute_type'],
    ];
    for (const [input, reason] of cases) {
      expect(await loaded.schema.upsertAttributeDefinition(admin(), input as never)).toEqual({ ok: false, reason });
    }
    expect(await loaded.schema.deleteAttributeDefinition(admin(), 'Bad-Key')).toEqual({ ok: false, reason: 'invalid_argument' });
    expect(await loaded.schema.listAttributeDefinitions({ actorUserId: 'not-a-uuid', tenantKey: KEY_A, signal: signal() })).toEqual({
      ok: false,
      reason: 'invalid_argument',
    });
    expect(await loaded.schema.listAttributeDefinitions(admin('o:bad'))).toEqual({ ok: false, reason: 'invalid_argument' });
    expect(state.calls).toEqual([]);
  });

  it('maps the SQL words to typed failures and anything else to unavailable without leaking the message', async () => {
    for (const word of ['not_admin', 'not_found', 'limit_reached', 'invalid_attribute_type', 'unknown_placeholder', 'invalid_argument']) {
      state.outcomes.rag_attribute_definition_upsert = { data: null, error: { code: 'P0001', message: `${word}` } };
      expect(await loaded.schema.upsertAttributeDefinition(admin(), { key: 'alpha_code', type: 'code' })).toEqual({ ok: false, reason: word });
    }
    state.outcomes.rag_attribute_definition_upsert = { data: null, error: { code: 'XX000', message: `connection to ${SECRET} failed` } };
    const failed = await loaded.schema.upsertAttributeDefinition(admin(), { key: 'alpha_code', type: 'code' });
    expect(failed).toEqual({ ok: false, reason: 'unavailable' });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
    state.outcomes.rag_attribute_definition_delete = new Error(`thrown ${SECRET}`);
    expect(await loaded.schema.deleteAttributeDefinition(admin(), 'alpha_code')).toEqual({ ok: false, reason: 'unavailable' });
    state.outcomes.rag_attribute_definitions_list = { data: null, error: { message: `not_adminish ${SECRET}` } };
    expect(await loaded.schema.listAttributeDefinitions(admin())).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('deletes one key and answers its name', async () => {
    state.outcomes.rag_attribute_definition_delete = { data: 'alpha_code', error: null };
    expect(await loaded.schema.deleteAttributeDefinition(admin(), 'alpha_code')).toEqual({ ok: true, key: 'alpha_code' });
    expect(state.calls).toEqual([{ fn: 'rag_attribute_definition_delete', args: { p_actor: ACTOR, p_tenant_key: KEY_A, p_key: 'alpha_code' } }]);
  });
});

describe('loadAttributeSchema', () => {
  let loaded: Loaded;
  beforeEach(async () => {
    loaded = await load();
    state.outcomes.rag_attribute_definitions_for = (args) => ({
      data: args.p_tenant_key === KEY_A ? [DEFINITION_ROW] : [{ ...DEFINITION_ROW, key: 'other_key', in_identifier_index: false, type: 'text' }],
      error: null,
    });
  });

  const orgScope = (orgId: string) => loaded.tenant.mintScope('org', null, orgId);

  it('serves a second call within the time to live from the cache', async () => {
    const first = await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() });
    expect(first).toEqual({ ok: true, definitions: [DEFINITION_ROW] });
    state.now += 59_000;
    expect(await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() })).toEqual(first);
    expect(forCalls()).toEqual([{ fn: 'rag_attribute_definitions_for', args: { p_tenant_key: KEY_A } }]);
    state.now += 2_000;
    await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() });
    expect(forCalls()).toHaveLength(2);
  });

  it("never serves one tenant's entry to another, for org, personal and single keys", async () => {
    const a = await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() });
    const b = await loaded.schema.loadAttributeSchema(orgScope(ORG_B), { signal: signal() });
    const u = await loaded.schema.loadAttributeSchema(loaded.tenant.mintScope('personal', USER_U, null), { signal: signal() });
    const s = await loaded.schema.loadAttributeSchema(loaded.tenant.mintScope('single', null, null), { signal: signal() });
    expect(a.ok && a.definitions.map((d) => d.key)).toEqual(['alpha_code']);
    for (const other of [b, u, s]) expect(other.ok && other.definitions.map((d) => d.key)).toEqual(['other_key']);
    expect(forCalls().map((call) => call.args.p_tenant_key)).toEqual([KEY_A, `o:${ORG_B}`, `u:${USER_U}`, 's:default']);
  });

  it("an upsert or delete invalidates that tenant's entry only", async () => {
    await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() });
    await loaded.schema.loadAttributeSchema(orgScope(ORG_B), { signal: signal() });
    state.outcomes.rag_attribute_definition_upsert = { data: [STORED_ROW], error: null };
    await loaded.schema.upsertAttributeDefinition(admin(KEY_A), { key: 'alpha_code', type: 'code' });
    await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() });
    await loaded.schema.loadAttributeSchema(orgScope(ORG_B), { signal: signal() });
    expect(forCalls().map((call) => call.args.p_tenant_key)).toEqual([KEY_A, `o:${ORG_B}`, KEY_A]);
    state.outcomes.rag_attribute_definition_delete = { data: 'alpha_code', error: null };
    await loaded.schema.deleteAttributeDefinition(admin(`o:${ORG_B}`), 'alpha_code');
    await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() });
    await loaded.schema.loadAttributeSchema(orgScope(ORG_B), { signal: signal() });
    expect(forCalls().map((call) => call.args.p_tenant_key)).toEqual([KEY_A, `o:${ORG_B}`, KEY_A, `o:${ORG_B}`]);
  });

  it('a failed write does not invalidate', async () => {
    await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() });
    state.outcomes.rag_attribute_definition_upsert = { data: null, error: { message: 'not_admin' } };
    await loaded.schema.upsertAttributeDefinition(admin(KEY_A), { key: 'alpha_code', type: 'code' });
    await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() });
    expect(forCalls()).toHaveLength(1);
  });

  it('a failed load answers unavailable and is retried after a shorter time, without leaking the message', async () => {
    state.outcomes.rag_attribute_definitions_for = { data: null, error: { code: 'XX000', message: `boom ${SECRET}` } };
    const failed = await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() });
    expect(failed).toEqual({ ok: false, reason: 'unavailable' });
    expect(await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() })).toEqual(failed);
    expect(forCalls()).toHaveLength(1);
    state.outcomes.rag_attribute_definitions_for = { data: [DEFINITION_ROW], error: null };
    state.now += 6_000;
    expect(await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() })).toEqual({ ok: true, definitions: [DEFINITION_ROW] });
    expect(forCalls()).toHaveLength(2);
  });

  it('a malformed row answers unavailable', async () => {
    state.outcomes.rag_attribute_definitions_for = { data: [{ ...DEFINITION_ROW, type: 'number' }], error: null };
    expect(await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() })).toEqual({ ok: false, reason: 'unavailable' });
    state.outcomes.rag_attribute_definitions_for = new Error(SECRET);
    loaded.schema.resetAttributeSchemaCacheForTests();
    expect(await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() })).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('fresh bypasses the cache and reset clears it', async () => {
    await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() });
    await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal(), fresh: true });
    expect(forCalls()).toHaveLength(2);
    loaded.schema.resetAttributeSchemaCacheForTests();
    await loaded.schema.loadAttributeSchema(orgScope(ORG_A), { signal: signal() });
    expect(forCalls()).toHaveLength(3);
  });

  it('rejects an unminted scope', async () => {
    await expect(loaded.schema.loadAttributeSchema({ kind: 'org', userId: null, organizationId: ORG_A } as never, { signal: signal() })).rejects.toThrow();
    expect(state.calls).toEqual([]);
  });
});
