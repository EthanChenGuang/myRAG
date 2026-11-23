import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asAdmin,
  asPlainUser,
  makeEnvDir,
  mockAdminGuard,
  newGuardState,
  request,
  silenceConsole,
  type AdminGuardState,
} from '../helpers/admin-guard-fixture';

let state: AdminGuardState;

interface ReloadRoute {
  POST(req: Request): Promise<Response>;
  OPTIONS?: unknown;
}

async function load(): Promise<ReloadRoute> {
  vi.resetModules();
  mockAdminGuard(state);
  return (await import('@/app/api/config/reload/route')) as unknown as ReloadRoute;
}

beforeEach(() => {
  state = newGuardState();
  silenceConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase');
  delete process.env.NEXT_PUBLIC_RELOAD_PROBE;
});

describe('POST /api/config/reload', () => {
  it('answers 401 without a session and leaves process.env alone', async () => {
    makeEnvDir('NEXT_PUBLIC_RELOAD_PROBE=changed\n');
    const { POST } = await load();
    const response = await POST(request('/api/config/reload', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(process.env.NEXT_PUBLIC_RELOAD_PROBE).toBeUndefined();
  });

  it('answers 403 for a signed-in user who is not an admin', async () => {
    asPlainUser(state);
    makeEnvDir('NEXT_PUBLIC_RELOAD_PROBE=changed\n');
    const { POST } = await load();
    expect((await POST(request('/api/config/reload', { method: 'POST' }))).status).toBe(403);
    expect(process.env.NEXT_PUBLIC_RELOAD_PROBE).toBeUndefined();
  });

  it('answers 503 when the session lookup throws', async () => {
    state.authThrows = true;
    makeEnvDir('NEXT_PUBLIC_RELOAD_PROBE=changed\n');
    const { POST } = await load();
    expect((await POST(request('/api/config/reload', { method: 'POST' }))).status).toBe(503);
  });

  it('reloads for an admin and sets no wildcard CORS header', async () => {
    asAdmin(state);
    makeEnvDir('NEXT_PUBLIC_RELOAD_PROBE=changed\n');
    const { POST, OPTIONS } = await load();
    const response = await POST(request('/api/config/reload', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(process.env.NEXT_PUBLIC_RELOAD_PROBE).toBe('changed');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(OPTIONS).toBeUndefined();
  });
});

describe('Config UI proxy', () => {
  it('forwards the session cookie on the reload call', () => {
    const source = fs.readFileSync('scripts/config-server.js', 'utf8');
    const block = source.slice(source.indexOf("app.post('/api/config/reload'"));
    expect(block.slice(0, 700)).toContain("withAuthHeaders(req, {");
  });
});
