import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';

type Row = Record<string, unknown>;

const state = {
  session: null as { id: string } | null,
  authThrows: false,
  rows: [] as Row[],
  proxy: vi.fn(),
  queries: [] as Array<Array<[string, unknown]>>,
};

function admin() {
  return {
    from() {
      const filters: Array<[string, unknown]> = [];
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
          state.queries.push([...filters]);
          const data = state.rows.filter((row) => filters.every(([column, value]) => row[column] === value));
          return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

const ROUTES = [
  { name: 'files', path: '/api/nango/files?provider=google-drive', provider: 'google-drive', module: '@/app/api/nango/files/route' },
  { name: 'folders', path: '/api/nango/folders?provider=google-drive', provider: 'google-drive', module: '@/app/api/nango/folders/route' },
  { name: 'notion/pages', path: '/api/nango/notion/pages?mode=root', provider: 'notion', module: '@/app/api/nango/notion/pages/route' },
] as const;

async function load(modulePath: string) {
  vi.resetModules();
  vi.doMock('@/lib/nango/client', () => ({
    isNangoEnabled: () => true,
    getNango: () => ({ proxy: state.proxy }),
  }));
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
  return import(/* @vite-ignore */ modulePath) as Promise<{ GET: (req: NextRequest) => Promise<Response> }>;
}

function get(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: 'GET', headers });
}

beforeEach(() => {
  state.session = null;
  state.authThrows = false;
  state.rows = [];
  state.queries = [];
  state.proxy = vi.fn().mockResolvedValue({ data: { files: [], entries: [], results: [] } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/nango/client');
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase');
});

describe.each(ROUTES)('nango/$name browse route', ({ path, provider, module }) => {
  it('returns 401 without a session, even with a bearer header, and never queries or calls the proxy', async () => {
    state.rows = [{ user_id: USER_B, provider, status: 'connected', connection_id: 'conn-b' }];
    const route = await load(module);
    const response = await route.GET(get(path, { authorization: 'Bearer x' }));
    expect(response.status).toBe(401);
    expect(state.queries).toEqual([]);
    expect(state.proxy).not.toHaveBeenCalled();
  });

  it('returns 503 when the session lookup throws', async () => {
    state.authThrows = true;
    const route = await load(module);
    const response = await route.GET(get(path));
    expect(response.status).toBe(503);
    expect(state.proxy).not.toHaveBeenCalled();
  });

  it('returns 404 for a user without a connection while another user has one, and skips the proxy', async () => {
    state.session = { id: USER_A };
    state.rows = [{ user_id: USER_B, provider, status: 'connected', connection_id: 'conn-b' }];
    const route = await load(module);
    const response = await route.GET(get(path));
    expect(response.status).toBe(404);
    expect(state.proxy).not.toHaveBeenCalled();
    expect(state.queries[0]).toContainEqual(['user_id', USER_A]);
  });

  it('proxies with the session user connection and never another user connection', async () => {
    state.session = { id: USER_A };
    state.rows = [
      { user_id: USER_B, provider, status: 'connected', connection_id: 'conn-b' },
      { user_id: USER_A, provider, status: 'connected', connection_id: 'conn-a' },
    ];
    const route = await load(module);
    const response = await route.GET(get(path));
    expect(response.status).toBe(200);
    expect(state.proxy).toHaveBeenCalled();
    for (const call of state.proxy.mock.calls) {
      expect(call[0]).toMatchObject({ connectionId: 'conn-a' });
    }
  });
});
