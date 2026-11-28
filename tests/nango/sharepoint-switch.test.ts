import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const NOW = '2026-01-01T00:00:00.000Z';

type Row = Record<string, unknown>;
type Filter = [string, unknown];

const state = {
  session: { id: USER_A } as { id: string; email?: string } | null,
  rows: [] as Row[],
  ops: [] as Array<{ table: string; op: string; payload?: Row; filters: Filter[] }>,
  nango: [] as Array<{ method: string; args: unknown[] }>,
  syncDocuments: vi.fn(),
};

function admin() {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      let op = 'select';
      let payload: Row | undefined;
      const hits = () => state.rows.filter((row) => filters.every(([column, value]) => row[column] === value));
      const run = () => {
        state.ops.push({ table, op, payload: payload ? JSON.parse(JSON.stringify(payload)) : undefined, filters: [...filters] });
        if (table !== 'nango_connections') return { data: null, error: null };
        if (op === 'upsert' && payload) {
          state.rows.push({ ...payload });
          return { data: payload, error: null };
        }
        if (op === 'update' && payload) {
          const matched = hits();
          matched.forEach((row) => Object.assign(row, payload));
          return { data: matched, error: null };
        }
        if (op === 'delete') {
          const matched = new Set(hits());
          state.rows = state.rows.filter((row) => !matched.has(row));
          return { data: null, error: null };
        }
        return { data: hits(), error: null };
      };
      const builder = {
        select: () => builder,
        order: () => builder,
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
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
          return Promise.resolve({ data: data ? JSON.parse(JSON.stringify(data)) : null, error: null });
        },
        maybeSingle() {
          return builder.single();
        },
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(run()).then((result) => JSON.parse(JSON.stringify(result))).then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
}

function nango() {
  const record = (method: string, result: unknown) => async (...args: unknown[]) => {
    state.nango.push({ method, args });
    return result;
  };
  return {
    createConnectSession: record('createConnectSession', { data: { token: 'connect-session-placeholder' } }),
    getConnection: async (...args: unknown[]) => {
      state.nango.push({ method: 'getConnection', args });
      return { connection_id: args[1], end_user: { id: USER_A } };
    },
    listConnections: async () => {
      state.nango.push({ method: 'listConnections', args: [] });
      return { connections: state.rows.map((row) => ({ connection_id: row.connection_id, end_user: { id: row.user_id } })) };
    },
    triggerSync: record('triggerSync', undefined),
    deleteConnection: record('deleteConnection', undefined),
  };
}

async function load<T>(path: 'session' | 'connections' | 'sync'): Promise<T> {
  vi.resetModules();
  vi.doMock('@/lib/nango/client', () => ({ isNangoEnabled: () => true, getNango: () => nango() }));
  vi.doMock('@/lib/nango/sync-manager', () => ({ syncDocumentsForConnection: state.syncDocuments }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session }, error: null }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin() }));
  if (path === 'session') return (await import('@/app/api/nango/session/route')) as T;
  if (path === 'connections') return (await import('@/app/api/nango/connections/route')) as T;
  return (await import('@/app/api/nango/sync/route')) as T;
}

type Handler = (request: NextRequest) => Promise<Response>;

function req(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/nango/${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function send(path: 'session' | 'connections' | 'sync', method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
  const route = await load<Record<string, Handler>>(path);
  const response = await route[method](req(path, method, body));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function seed() {
  state.rows = [
    { id: 'row-gd', user_id: USER_A, provider: 'google-drive', connection_id: 'conn-gd', status: 'connected', metadata: {}, created_at: NOW },
    {
      id: 'row-sp',
      user_id: USER_A,
      provider: 'sharepoint-online',
      connection_id: 'conn-sp',
      status: 'connected',
      metadata: { keep: 'value' },
      created_at: NOW,
    },
    { id: 'row-od', user_id: USER_A, provider: 'one-drive', connection_id: 'conn-od', status: 'connected', metadata: null, created_at: NOW },
  ];
}

function setSwitch(on: boolean) {
  if (on) process.env.NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED = 'true';
  else delete process.env.NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  setSwitch(false);
  delete process.env.NANGO_SHAREPOINT_INTEGRATION_KEY;
  delete process.env.NANGO_ONEDRIVE_INTEGRATION_KEY;
  state.session = { id: USER_A, email: 'a@example.test' };
  state.ops = [];
  state.nango = [];
  state.syncDocuments = vi.fn().mockResolvedValue({ processed: 0 });
  seed();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  setSwitch(false);
  delete process.env.NANGO_SHAREPOINT_INTEGRATION_KEY;
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/nango/client');
  vi.doUnmock('@/lib/nango/sync-manager');
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase');
});

const SCOPE = {
  sites: [{ id: 'site-a', name: 'Site A' }],
  drives: [{ id: 'drive-a', name: 'Library 1', parentId: 'site-a' }],
  folders: [{ id: 'item-folder-1', name: 'Folder 1', driveId: 'drive-b', parentId: 'drive-b' }],
};

describe('switch off: the two providers are refused before any work (D-24)', () => {
  for (const provider of ['sharepoint-online', 'one-drive']) {
    it(`session, connections and sync refuse ${provider}`, async () => {
      const connectionId = provider === 'one-drive' ? 'conn-od' : 'conn-sp';
      const answers = [
        await send('session', 'POST', { provider }),
        await send('connections', 'POST', { provider, connectionId }),
        await send('connections', 'PATCH', { provider, syncFolderId: 'item-folder-1' }),
        await send('connections', 'DELETE', { provider }),
        await send('sync', 'POST', { provider, connectionId }),
      ];
      for (const answer of answers) expect(answer).toEqual({ status: 404, body: { error: 'Not found' } });
      expect(state.nango).toEqual([]);
      expect(state.ops).toEqual([]);
      expect(state.syncDocuments).not.toHaveBeenCalled();
    });
  }

  it('sync refuses a SharePoint connection named under another provider', async () => {
    const answer = await send('sync', 'POST', { provider: 'google-drive', connectionId: 'conn-sp' });
    expect(answer).toEqual({ status: 404, body: { error: 'Not found' } });
    expect(state.syncDocuments).not.toHaveBeenCalled();
    expect(state.nango).toEqual([]);
  });

  it('syncAll and the connections list leave the two providers out', async () => {
    const all = await send('sync', 'POST', { syncAll: true });
    expect(all.status).toBe(200);
    expect((all.body.results as Array<{ provider: string }>).map((r) => r.provider)).toEqual(['google-drive']);
    expect(state.syncDocuments.mock.calls.map((c) => c[1])).toEqual(['google-drive']);

    const list = await send('connections', 'GET');
    expect((list.body.connections as Array<{ provider: string }>).map((c) => c.provider)).toEqual(['google-drive']);
  });
});

describe('other providers behave the same with the switch off and on', () => {
  async function transcript() {
    seed();
    state.ops = [];
    state.nango = [];
    state.syncDocuments.mockClear();
    const answers = [
      await send('session', 'POST', { provider: 'notion' }),
      await send('connections', 'POST', { provider: 'dropbox', connectionId: 'conn-dbx' }),
      await send('connections', 'PATCH', { provider: 'google-drive', syncFolderId: 'folder-1', syncFolderName: 'Folder 1' }),
      await send('sync', 'POST', { provider: 'google-drive', connectionId: 'conn-gd' }),
      await send('connections', 'DELETE', { provider: 'dropbox' }),
    ];
    return { answers, ops: state.ops, nango: state.nango.filter((call) => call.method !== 'listConnections'), sync: state.syncDocuments.mock.calls };
  }

  it('records identical responses, database calls and Nango calls', async () => {
    setSwitch(false);
    const off = await transcript();
    setSwitch(true);
    const on = await transcript();
    expect(on).toEqual(off);
    expect(off.answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200]);
    const session = off.nango.find((call) => call.method === 'createConnectSession');
    expect((session!.args[0] as { allowed_integrations: string[] }).allowed_integrations).toEqual(['notion']);
  });
});

describe('switch on (D-24, D-40, D-22)', () => {
  beforeEach(() => setSwitch(true));

  it('the session route allows the configured integration key', async () => {
    process.env.NANGO_SHAREPOINT_INTEGRATION_KEY = 'sp-integration-1';
    const sp = await send('session', 'POST', { provider: 'sharepoint-online' });
    expect(sp.status).toBe(200);
    const od = await send('session', 'POST', { provider: 'one-drive' });
    expect(od.status).toBe(200);
    const sessions = state.nango.filter((call) => call.method === 'createConnectSession');
    expect(sessions.map((call) => (call.args[0] as { allowed_integrations: string[] }).allowed_integrations)).toEqual([['sp-integration-1'], ['one-drive']]);
  });

  it('lists the two providers and stores a selection under metadata.source_scope, keeping other keys', async () => {
    const saved = await send('connections', 'PATCH', { provider: 'sharepoint-online', sourceScope: SCOPE });
    expect(saved.status).toBe(200);
    const row = state.rows.find((r) => r.provider === 'sharepoint-online')!;
    expect(row.metadata).toEqual({ keep: 'value', source_scope: SCOPE });
    expect(row.sync_folder_id).toBeUndefined();
    const update = state.ops.find((o) => o.op === 'update')!;
    expect(update.filters).toEqual(expect.arrayContaining([['user_id', USER_A], ['provider', 'sharepoint-online']]));

    const od = await send('connections', 'PATCH', { provider: 'one-drive', sourceScope: { sites: [], drives: [{ id: 'drive-o', name: 'Library 1' }], folders: [] } });
    expect(od.status).toBe(200);
    expect(state.rows.find((r) => r.provider === 'one-drive')!.metadata).toEqual({
      source_scope: { sites: [], drives: [{ id: 'drive-o', name: 'Library 1' }], folders: [] },
    });

    const list = await send('connections', 'GET');
    const connections = list.body.connections as Array<{ provider: string; metadata: { source_scope?: unknown } }>;
    expect(connections.map((c) => c.provider)).toEqual(['google-drive', 'sharepoint-online', 'one-drive']);
    expect(connections[1].metadata.source_scope).toEqual(SCOPE);
    expect(JSON.stringify(list.body).toLowerCase()).not.toContain('delta');
  });

  it('refuses a malformed, oversized or misplaced selection with 400 and writes nothing', async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ id: `drive-${i}`, name: `Library ${i}` }));
    const split = { sites: many.slice(0, 100), drives: many.slice(100, 201), folders: [] };
    const bad: Array<[string, unknown]> = [
      ['sharepoint-online', { sites: [], drives: many, folders: [] }],
      ['sharepoint-online', split],
      ['sharepoint-online', { sites: [{ name: 'Site A' }], drives: [], folders: [] }],
      ['sharepoint-online', { sites: [{ id: 'site-a', name: 'x'.repeat(513) }], drives: [], folders: [] }],
      ['sharepoint-online', { sites: [], drives: [], folders: [], extra: [] }],
      ['sharepoint-online', { sites: [{ id: 'site-a', name: 'Site A', url: 'x' }], drives: [], folders: [] }],
      ['sharepoint-online', { sites: [{ id: '../x', name: 'Site A' }], drives: [], folders: [] }],
      ['sharepoint-online', { sites: [], drives: [], folders: [{ id: 'item-folder-1', name: 'Folder 1' }] }],
      ['one-drive', { sites: [{ id: 'site-a', name: 'Site A' }], drives: [], folders: [] }],
      ['google-drive', { sites: [], drives: [], folders: [] }],
      ['sharepoint-online', 'not-an-object'],
    ];
    for (const [provider, sourceScope] of bad) {
      state.ops = [];
      const answer = await send('connections', 'PATCH', { provider, sourceScope });
      expect(answer.status, JSON.stringify(sourceScope).slice(0, 80)).toBe(400);
      expect(state.ops).toEqual([]);
    }
    expect(state.rows.find((r) => r.provider === 'sharepoint-online')!.metadata).toEqual({ keep: 'value' });
  });

  it('accepts exactly 200 entries', async () => {
    const drives = Array.from({ length: 200 }, (_, i) => ({ id: `drive-${i}`, name: `Library ${i}` }));
    const answer = await send('connections', 'PATCH', { provider: 'sharepoint-online', sourceScope: { sites: [], drives, folders: [] } });
    expect(answer.status).toBe(200);
  });

  it('sync runs for a SharePoint connection', async () => {
    const answer = await send('sync', 'POST', { provider: 'sharepoint-online', connectionId: 'conn-sp' });
    expect(answer.status).toBe(200);
    expect(state.syncDocuments).toHaveBeenCalledWith('conn-sp', 'sharepoint-online');
  });
});
