import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';

type Row = Record<string, unknown>;
type Filter = [string, unknown];

const state = {
  session: null as { id: string } | null,
  authThrows: false,
  rows: [] as Row[],
  nangoOwners: new Map<string, string | null>(),
  ops: [] as Array<{ op: string; payload?: Row; filters: Filter[] }>,
  listUsers: vi.fn(),
  deleteConnection: vi.fn(),
  getConnection: vi.fn(),
  listConnections: vi.fn(),
  syncDocuments: vi.fn(),
  triggerSync: vi.fn(),
};

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(([column, value]) => row[column] === value);
}

function admin() {
  return {
    auth: { admin: { listUsers: state.listUsers } },
    from() {
      const filters: Filter[] = [];
      let op = 'select';
      let payload: Row | undefined;
      const run = () => {
        state.ops.push({ op, payload, filters: [...filters] });
        if (op === 'upsert' && payload) {
          state.rows.push(payload);
          return { data: payload, error: null };
        }
        if (op === 'update' && payload) {
          const hit = state.rows.filter((row) => matches(row, filters));
          hit.forEach((row) => Object.assign(row, payload));
          return { data: hit[0] ?? null, error: null };
        }
        if (op === 'delete') {
          state.rows = state.rows.filter((row) => !matches(row, filters));
          return { data: null, error: null };
        }
        return { data: state.rows.filter((row) => matches(row, filters)), error: null };
      };
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        order: () => builder,
        upsert(next: Row) {
          op = 'upsert';
          payload = next;
          return builder;
        },
        update(next: Row) {
          op = 'update';
          payload = next;
          return builder;
        },
        delete() {
          op = 'delete';
          return builder;
        },
        single() {
          const result = run();
          const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
          return Promise.resolve({ data, error: null });
        },
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(run()).then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
}

function request(method: string, headers: Record<string, string>, body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/nango/connections', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/nango/client', () => ({
    isNangoEnabled: () => true,
    getNango: () => ({
      getConnection: state.getConnection,
      deleteConnection: state.deleteConnection,
      listConnections: state.listConnections,
      triggerSync: state.triggerSync,
    }),
  }));
  vi.doMock('@/lib/nango/sync-manager', () => ({ syncDocumentsForConnection: state.syncDocuments }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (state.authThrows) throw new Error('auth down');
          return { data: { user: state.session }, error: null };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin() }));
  return import('@/app/api/nango/connections/route');
}

beforeEach(() => {
  state.session = null;
  state.authThrows = false;
  state.rows = [];
  state.nangoOwners = new Map();
  state.ops = [];
  state.listUsers = vi.fn().mockResolvedValue({ data: { users: [{ id: USER_B }] } });
  state.deleteConnection = vi.fn().mockResolvedValue(undefined);
  state.listConnections = vi.fn().mockResolvedValue({ connections: [] });
  state.syncDocuments = vi.fn().mockResolvedValue({});
  state.triggerSync = vi.fn().mockResolvedValue(undefined);
  state.getConnection = vi.fn(async (_integration: string, connectionId: string) => {
    if (!state.nangoOwners.has(connectionId)) throw new Error('not found');
    const owner = state.nangoOwners.get(connectionId);
    return { connection_id: connectionId, end_user: owner ? { id: owner } : null };
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/nango/client');
  vi.doUnmock('@/lib/nango/sync-manager');
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase');
});

describe('nango/connections authentication', () => {
  it('returns 401 for a bearer header with no session on every method and never lists users', async () => {
    const route = await load();
    const bearer = { authorization: 'Bearer x' };
    const responses = await Promise.all([
      route.GET(request('GET', bearer)),
      route.POST(request('POST', bearer, { provider: 'notion', connectionId: 'conn-b' })),
      route.PATCH(request('PATCH', bearer, { provider: 'notion', syncFolderId: 'f1' })),
      route.DELETE(request('DELETE', bearer, { provider: 'notion' })),
    ]);
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect(state.listUsers).not.toHaveBeenCalled();
    expect(state.ops).toEqual([]);
  });

  it('returns 503 when the session lookup throws', async () => {
    state.authThrows = true;
    const route = await load();
    const response = await route.GET(request('GET', {}));
    expect(response.status).toBe(503);
    expect(state.ops).toEqual([]);
  });

  it('ignores a bearer header when a session exists and scopes to the session user', async () => {
    state.session = { id: USER_A };
    state.rows = [
      { user_id: USER_A, provider: 'notion', connection_id: 'conn-a' },
      { user_id: USER_B, provider: 'notion', connection_id: 'conn-b' },
    ];
    const route = await load();
    const response = await route.GET(request('GET', { authorization: 'Bearer x' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connections: Row[] };
    expect(body.connections.map((c) => c.connection_id)).toEqual(['conn-a']);
    expect(state.listUsers).not.toHaveBeenCalled();
  });
});

describe('nango/connections POST ownership', () => {
  it('returns 403 and writes nothing for a connection owned by another user', async () => {
    state.session = { id: USER_A };
    state.nangoOwners.set('conn-b', USER_B);
    const route = await load();
    const response = await route.POST(request('POST', {}, { provider: 'notion', connectionId: 'conn-b' }));
    expect(response.status).toBe(403);
    expect(state.ops.filter((o) => o.op === 'upsert')).toEqual([]);
    expect(state.rows).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns 403 for a Nango connection with no end user', async () => {
    state.session = { id: USER_A };
    state.nangoOwners.set('conn-orphan', null);
    const route = await load();
    const response = await route.POST(request('POST', {}, { provider: 'notion', connectionId: 'conn-orphan' }));
    expect(response.status).toBe(403);
    expect(state.ops.filter((o) => o.op === 'upsert')).toEqual([]);
  });

  it('returns 404 and writes nothing for an unknown connection', async () => {
    state.session = { id: USER_A };
    const route = await load();
    const response = await route.POST(request('POST', {}, { provider: 'notion', connectionId: 'missing' }));
    expect(response.status).toBe(404);
    expect(state.ops.filter((o) => o.op === 'upsert')).toEqual([]);
  });

  it('upserts a connection the caller owns, keyed to the session user', async () => {
    state.session = { id: USER_A };
    state.nangoOwners.set('conn-a', USER_A);
    const route = await load();
    const response = await route.POST(request('POST', {}, { provider: 'notion', connectionId: 'conn-a' }));
    expect(response.status).toBe(200);
    const upserts = state.ops.filter((o) => o.op === 'upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toMatchObject({ user_id: USER_A, connection_id: 'conn-a', provider: 'notion' });
  });
});

describe('ME-01: the caller cookies never leave this process', () => {
  it('POST never sends the Cookie header to any URL, whatever NEXT_PUBLIC_SITE_URL says', async () => {
    const previous = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://attacker.example.test';
    try {
      state.session = { id: USER_A };
      state.nangoOwners.set('conn-a', USER_A);
      const route = await load();

      const response = await route.POST(
        request('POST', { cookie: 'sb-session=placeholder-session; admin_session=placeholder-admin' }, { provider: 'notion', connectionId: 'conn-a' }),
      );
      await vi.waitFor(() => expect(state.syncDocuments).toHaveBeenCalledWith('conn-a', 'notion'));

      expect(response.status).toBe(200);
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain('placeholder-session');
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = previous;
    }
  });

  it('a failing background sync does not fail the registration', async () => {
    state.session = { id: USER_A };
    state.nangoOwners.set('conn-a', USER_A);
    state.syncDocuments = vi.fn().mockRejectedValue(new Error('sync down'));
    const route = await load();

    const response = await route.POST(request('POST', {}, { provider: 'notion', connectionId: 'conn-a' }));

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(state.syncDocuments).toHaveBeenCalled());
  });
});

describe('nango/connections DELETE and PATCH ownership', () => {
  it('does not call deleteConnection for an unauthenticated bearer DELETE', async () => {
    state.rows = [{ user_id: USER_B, provider: 'notion', connection_id: 'conn-b' }];
    const route = await load();
    const response = await route.DELETE(request('DELETE', { authorization: 'Bearer x' }, { provider: 'notion' }));
    expect(response.status).toBe(401);
    expect(state.deleteConnection).not.toHaveBeenCalled();
    expect(state.rows).toHaveLength(1);
  });

  it('deletes only the caller row and never touches another user connection', async () => {
    state.session = { id: USER_A };
    state.rows = [
      { user_id: USER_A, provider: 'notion', connection_id: 'conn-a' },
      { user_id: USER_B, provider: 'notion', connection_id: 'conn-b' },
    ];
    const route = await load();
    const response = await route.DELETE(request('DELETE', {}, { provider: 'notion' }));
    expect(response.status).toBe(200);
    expect(state.deleteConnection).toHaveBeenCalledTimes(1);
    expect(state.deleteConnection).toHaveBeenCalledWith('notion', 'conn-a');
    expect(state.rows.map((r) => r.user_id)).toEqual([USER_B]);
  });

  it('patches only the caller row', async () => {
    state.session = { id: USER_A };
    state.rows = [
      { user_id: USER_A, provider: 'notion', connection_id: 'conn-a' },
      { user_id: USER_B, provider: 'notion', connection_id: 'conn-b' },
    ];
    const route = await load();
    const response = await route.PATCH(request('PATCH', {}, { provider: 'notion', syncFolderId: 'f1' }));
    expect(response.status).toBe(200);
    expect(state.rows.find((r) => r.user_id === USER_A)?.sync_folder_id).toBe('f1');
    expect(state.rows.find((r) => r.user_id === USER_B)?.sync_folder_id).toBeUndefined();
  });
});
