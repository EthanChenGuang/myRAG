import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';

type Call = { table: string; op: string; payload?: unknown; filters: Record<string, unknown> };

const state = {
  user: null as { id: string } | null,
  calls: [] as Call[],
  connections: [] as Array<{ user_id: string; connection_id: string; provider: string }>,
};

function fakeAdmin() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let op = 'select';
      let payload: unknown;
      const run = () => {
        state.calls.push({ table, op, payload, filters: { ...filters } });
        const rows = state.connections.filter(
          (row) =>
            (filters.user_id === undefined || row.user_id === filters.user_id) &&
            (filters.connection_id === undefined || row.connection_id === filters.connection_id),
        );
        return { data: op === 'select' ? rows[0] ?? null : null, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (value: unknown) => {
          op = 'update';
          payload = value;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        single: () => Promise.resolve(run()),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  };
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/nango/client', () => ({
    isNangoEnabled: () => true,
    getNango: () => ({ triggerSync: async () => undefined }),
  }));
  vi.doMock('@/lib/nango/sync-manager', () => ({
    syncDocumentsForConnection: async () => ({ processed: 0 }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeAdmin() }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user }, error: null }) } }),
  }));
  return import('@/app/api/nango/sync/route');
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/nango/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.user = { id: USER_A };
  state.calls = [];
  state.connections = [
    { user_id: USER_A, connection_id: 'conn-a', provider: 'google-drive' },
    { user_id: USER_B, connection_id: 'conn-b', provider: 'google-drive' },
  ];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/nango/client');
  vi.doUnmock('@/lib/nango/sync-manager');
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
});

describe('POST /api/nango/sync', () => {
  it('scopes the last_sync_at update by the owning user as well as the connection', async () => {
    const { POST } = await load();
    const response = await POST(post({ connectionId: 'conn-a', provider: 'google-drive' }));
    expect(response.status).toBe(200);
    const updates = state.calls.filter((call) => call.op === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].filters).toEqual({ user_id: USER_A, connection_id: 'conn-a' });
  });

  it('answers 404 and writes nothing for a connection owned by another user', async () => {
    const { POST } = await load();
    const response = await POST(post({ connectionId: 'conn-b', provider: 'google-drive' }));
    expect(response.status).toBe(404);
    expect(state.calls.filter((call) => call.op === 'update')).toEqual([]);
  });

  it('answers 401 without a session', async () => {
    state.user = null;
    const { POST } = await load();
    expect((await POST(post({ connectionId: 'conn-a', provider: 'google-drive' }))).status).toBe(401);
  });
});
