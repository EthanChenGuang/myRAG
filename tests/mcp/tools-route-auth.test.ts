import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asAdmin,
  asPlainUser,
  mockAdminGuard,
  newGuardState,
  request,
  silenceConsole,
  type AdminGuardState,
} from '../helpers/admin-guard-fixture';

let state: AdminGuardState;
const discoverAllTools = vi.fn();
const clearUniversalCache = vi.fn();

interface ToolsRoute {
  GET(req: Request): Promise<Response>;
  POST(req: Request): Promise<Response>;
}

async function load(): Promise<ToolsRoute> {
  vi.resetModules();
  mockAdminGuard(state);
  vi.doMock('@/lib/mcp/universal-client', () => ({ discoverAllTools, clearUniversalCache }));
  return (await import('@/app/api/mcp/tools/route')) as unknown as ToolsRoute;
}

beforeEach(() => {
  state = newGuardState();
  discoverAllTools.mockReset().mockResolvedValue([
    { name: 'search', description: 'Search', server: 'demo', inputSchema: {} },
  ]);
  clearUniversalCache.mockReset();
  silenceConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/mcp/universal-client');
});

describe('GET /api/mcp/tools', () => {
  it('answers 401 without a session and discovers nothing', async () => {
    const { GET } = await load();
    expect((await GET(request('/api/mcp/tools'))).status).toBe(401);
    expect(discoverAllTools).not.toHaveBeenCalled();
  });

  it('answers 503 when the session lookup throws', async () => {
    state.authThrows = true;
    const { GET } = await load();
    expect((await GET(request('/api/mcp/tools'))).status).toBe(503);
    expect(discoverAllTools).not.toHaveBeenCalled();
  });

  it('lets an ordinary signed-in user list tools', async () => {
    asPlainUser(state);
    const { GET } = await load();
    const response = await GET(request('/api/mcp/tools'));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { toolsByServer: Record<string, unknown[]> }).toolsByServer.demo).toHaveLength(1);
  });
});

describe('POST /api/mcp/tools (cache refresh)', () => {
  it('answers 401 without a session', async () => {
    const { POST } = await load();
    expect((await POST(request('/api/mcp/tools', { method: 'POST' }))).status).toBe(401);
    expect(clearUniversalCache).not.toHaveBeenCalled();
  });

  it('answers 403 for a signed-in user who is not an admin', async () => {
    asPlainUser(state);
    const { POST } = await load();
    expect((await POST(request('/api/mcp/tools', { method: 'POST' }))).status).toBe(403);
    expect(clearUniversalCache).not.toHaveBeenCalled();
  });

  it('refreshes the cache for an admin', async () => {
    asAdmin(state);
    const { POST } = await load();
    expect((await POST(request('/api/mcp/tools', { method: 'POST' }))).status).toBe(200);
    expect(clearUniversalCache).toHaveBeenCalledTimes(1);
  });
});
