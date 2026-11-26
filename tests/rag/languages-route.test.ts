import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000052a1';
const MEMBER_ID = '00000000-0000-4000-8000-0000000052b1';
const ORG_ADMIN_ID = '00000000-0000-4000-8000-0000000052b2';
const ORG_O = '00000000-0000-4000-8000-0000000052c1';

type Row = Record<string, unknown>;
type RpcOutcome = { data: Row[] | null; error: { code?: string; message: string } | null };

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcome: { data: [], error: null } as RpcOutcome,
  throws: false,
};

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  const run = () => ({ data: (state.tables[table] ?? []).filter((row) => filters.every((filter) => filter(row))), error: null });
  const builder = {
    select: () => builder,
    abortSignal: () => builder,
    order: () => builder,
    limit: () => builder,
    eq(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    maybeSingle: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(run()).then(onFulfilled, onRejected),
  };
  return builder;
}

function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from: (table: string) => query(table),
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      if (state.throws) throw new Error('connection reset');
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcOutcome) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(state.outcome).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

async function load() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = state.mode;
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeClient(), getSupabase: () => ({}) }));
  const deps = await import('@/lib/rag/ingest/deps');
  deps.setIngestDepsForTests({ db: () => fakeClient() as never });
  return import('@/app/api/rag/admin/languages/route');
}

const get = async (org: string | null = null) => (await load()).GET(new Request(`http://localhost/api/rag/admin/languages${org ? `?organizationId=${org}` : ''}`));
const countCalls = () => state.rpcCalls.filter((call) => call.fn === 'rag_language_document_counts');

describe('GET /api/rag/admin/languages', () => {
  let logged: string[];

  beforeEach(() => {
    state.mode = 'single-tenant';
    state.session = null;
    state.throws = false;
    state.rpcCalls = [];
    state.tables = { admin_users: [{ id: ADMIN_ID }], organization_members: [{ organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'owner' }] };
    state.outcome = {
      data: [
        { language: 'en', documents: 12 },
        { language: 'it', documents: '3' },
        { language: 'xx', documents: 9 },
        { language: 'und', documents: 4 },
        { language: 'zh', documents: 5 },
      ],
      error: null,
    };
    logged = [];
    for (const method of ['warn', 'error', 'log', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
  });

  it('fails closed: 401 without a session and 403 to a non-admin, with no count call', async () => {
    const anonymous = await get();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
    state.session = { id: MEMBER_ID };
    const denied = await get();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ success: false, error: 'Admin access required' });
    expect(countCalls()).toEqual([]);
  });

  it('is deployment-wide: an organization admin who is not a deployment admin is denied, even naming the organization', async () => {
    state.mode = 'multi-tenant';
    state.session = { id: ORG_ADMIN_ID };
    expect((await get()).status).toBe(403);
    expect((await get(ORG_O)).status).toBe(403);
    expect(countCalls()).toEqual([]);
  });

  it('returns the count of each registry language in registry order, with no code outside the registry and nothing but counts', async () => {
    state.session = { id: ADMIN_ID };
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      success: true,
      counts: [
        { language: 'zh', documents: 5 },
        { language: 'en', documents: 12 },
        { language: 'it', documents: 3 },
      ],
    });
    expect(countCalls()).toEqual([{ fn: 'rag_language_document_counts', args: {} }]);
  });

  it('lists a registry language with no documents as zero, and sums duplicate rows', async () => {
    state.session = { id: ADMIN_ID };
    state.outcome = {
      data: [
        { language: 'en', documents: 2 },
        { language: 'en', documents: 1 },
        { language: null, documents: 7 },
      ],
      error: null,
    };
    expect((await (await get()).json()).counts).toEqual([
      { language: 'zh', documents: 0 },
      { language: 'en', documents: 3 },
      { language: 'it', documents: 0 },
    ]);
  });

  it('answers 503 with the standard body and no database message when the count call fails or throws', async () => {
    state.session = { id: ADMIN_ID };
    state.outcome = { data: null, error: { code: 'XX000', message: 'secret database detail' } };
    const failed = await get();
    expect(failed.status).toBe(503);
    expect(failed.headers.get('cache-control')).toBe('no-store');
    const text = await failed.text();
    expect(text).not.toContain('secret database detail');
    expect(JSON.parse(text)).toEqual({ success: false, error: 'Language counts are unavailable' });
    state.throws = true;
    expect((await get()).status).toBe(503);
    expect(logged.join('\n')).not.toContain('secret database detail');
  });
});
