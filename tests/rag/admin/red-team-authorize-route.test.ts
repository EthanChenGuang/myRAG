import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, harness, headersFor, loadRoute, resetHarness } from './route-harness';

/** SEC-11: the admin check the Config UI server asks before it starts a red-team run. No side effect; fails closed. */

type RouteModule = typeof import('@/app/api/rag/admin/red-team/authorize/route');

const URL = 'http://localhost:3000/api/rag/admin/red-team/authorize';

async function load(): Promise<RouteModule> {
  return loadRoute(() => import('@/app/api/rag/admin/red-team/authorize/route'));
}

function request(auth: 'admin' | 'user' | 'none' | 'forged', extra: Record<string, string> = {}): Request {
  return new Request(URL, { method: 'GET', headers: { ...headersFor(auth), ...extra } });
}

function expectNoCors(response: Response): void {
  for (const [name] of response.headers.entries()) expect(name.toLowerCase().startsWith('access-control-')).toBe(false);
  expect(response.headers.get('cache-control')).toBe('no-store');
}

describe('GET /api/rag/admin/red-team/authorize', () => {
  beforeEach(() => resetHarness());

  it('answers 200 with the admin id for an operator admin', async () => {
    const route = await load();
    const response = await route.GET(request('admin'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, adminId: ADMIN_ID });
    expectNoCors(response);
  });

  it('no session: 401 without an admin id', async () => {
    const route = await load();
    const response = await route.GET(request('none'));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.adminId).toBeUndefined();
    expectNoCors(response);
  });

  it('non-admin: 403 without an admin id, also for a forged admin cookie', async () => {
    const route = await load();
    const user = await route.GET(request('user'));
    expect(user.status).toBe(403);
    expect((await user.json()).adminId).toBeUndefined();
    expectNoCors(user);
    const forged = await route.GET(request('forged'));
    expect([401, 403]).toContain(forged.status);
    expect((await forged.json()).adminId).toBeUndefined();
  });

  it('unreachable lookup: 503 when the admin check cannot run', async () => {
    harness.guardAvailable = false;
    const route = await load();
    const response = await route.GET(request('admin'));
    expect(response.status).toBe(503);
    expect((await response.json()).adminId).toBeUndefined();
    expectNoCors(response);
  });

  it('no Access-Control header on any status, including with a foreign Origin, and no OPTIONS handler', async () => {
    const route = await load();
    for (const auth of ['admin', 'user', 'none'] as const) {
      const response = await route.GET(request(auth, { origin: 'https://attacker.example.org' }));
      expectNoCors(response);
    }
    expect((route as Record<string, unknown>).OPTIONS).toBeUndefined();
    expect((route as Record<string, unknown>).POST).toBeUndefined();
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });

  it('has no side effect: no RPC call on any path', async () => {
    const route = await load();
    await route.GET(request('admin'));
    await route.GET(request('user'));
    expect(harness.rpcCalls).toEqual([]);
  });
});
