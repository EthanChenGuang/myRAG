import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';

const state = {
  session: null as { id: string; email?: string; user_metadata?: Record<string, unknown> } | null,
  authThrows: false,
  createConnectSession: vi.fn(),
};

function post(headers: Record<string, string>, body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/nango/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/nango/client', () => ({
    isNangoEnabled: () => true,
    getNango: () => ({ createConnectSession: state.createConnectSession }),
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
  return import('@/app/api/nango/session/route');
}

beforeEach(() => {
  state.session = null;
  state.authThrows = false;
  state.createConnectSession = vi.fn().mockResolvedValue({ data: { token: 'connect-token' } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/nango/client');
  vi.doUnmock('@/lib/supabase/server');
});

describe('nango/session POST', () => {
  it('returns 401 for a bearer header with no session and creates no connect session', async () => {
    const route = await load();
    const response = await route.POST(post({ authorization: 'Bearer x' }, { provider: 'notion' }));
    expect(response.status).toBe(401);
    expect(state.createConnectSession).not.toHaveBeenCalled();
  });

  it('returns 503 when the session lookup throws', async () => {
    state.authThrows = true;
    const route = await load();
    const response = await route.POST(post({}, { provider: 'notion' }));
    expect(response.status).toBe(503);
    expect(state.createConnectSession).not.toHaveBeenCalled();
  });

  it('binds the connect session to the session user, not to any bearer identity', async () => {
    state.session = { id: USER_A, email: 'a@example.test', user_metadata: { full_name: 'User A' } };
    const route = await load();
    const response = await route.POST(post({ authorization: 'Bearer x' }, { provider: 'notion' }));
    expect(response.status).toBe(200);
    expect(state.createConnectSession).toHaveBeenCalledTimes(1);
    expect(state.createConnectSession.mock.calls[0][0]).toMatchObject({
      end_user: { id: USER_A, email: 'a@example.test', display_name: 'User A' },
      allowed_integrations: ['notion'],
    });
  });
});
