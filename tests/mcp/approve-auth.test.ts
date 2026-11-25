import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const TOOL_CALL_ID = 'call-approve-auth-1';
const TOOL_PARAMS = { query: 'placeholder query' };

const session = vi.hoisted(() => ({ user: null as { id: string } | null, throws: false }));

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getCachedTools: vi.fn(),
  getConnectionStatus: vi.fn(),
  stateService: {
    getByToolCallId: vi.fn(),
    getForUser: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock('@/lib/tool-execution-state', () => ({ ToolExecutionStateService: mocks.stateService }));
vi.mock('@/lib/supabase', async () => {
  const { createFakeAdminDb } = await import('./helpers/fake-admin-db');
  return { getSupabaseAdmin: () => createFakeAdminDb() };
});
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        if (session.throws) throw new Error('auth down');
        return { data: { user: session.user } };
      },
    },
  }),
}));
vi.mock('@/lib/mcp/production-router', () => ({
  productionMcpRouter: {
    getAvailableServers: vi.fn(async () => []),
    getCachedTools: mocks.getCachedTools,
  },
}));
vi.mock('@/lib/mcp/universal-client', () => ({
  UniversalMcpClient: {
    getInstance: () => ({ getConnectionStatus: mocks.getConnectionStatus }),
  },
}));
vi.mock('@/lib/dev-logger', () => ({
  devLog: { verbose: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from '@/app/api/chat/approve/route';
import { adminDb, adminIds } from './helpers/fake-admin-db';

interface ApprovalGlobals {
  toolApprovalState?: Record<string, unknown>;
  mcpToolsCache?: Map<string, unknown>;
}

function approveRequest(): NextRequest {
  return new NextRequest('http://localhost/api/chat/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toolCallId: TOOL_CALL_ID, action: 'approve', sessionId: 'session-1' }),
  });
}

function seedEntry(ownerUserId: string | null | undefined) {
  const entry: Record<string, unknown> = {
    approved: false,
    executed: false,
    toolCall: { name: 'fake_tool', params: TOOL_PARAMS, meta: { sessionId: 'session-1' } },
  };
  if (ownerUserId !== undefined) entry.ownerUserId = ownerUserId;
  (globalThis as unknown as ApprovalGlobals).toolApprovalState = { [TOOL_CALL_ID]: entry };
}

describe('chat/approve route authentication and ownership', () => {
  const globals = globalThis as unknown as ApprovalGlobals;

  beforeEach(() => {
    adminIds.clear();
    adminIds.add(USER_A);
    adminDb.failing = false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    session.user = null;
    session.throws = false;
    mocks.execute.mockReset().mockResolvedValue({});
    mocks.getConnectionStatus.mockReset().mockReturnValue([{ server: 'Fake Server', connected: true }]);
    mocks.getCachedTools.mockReset().mockResolvedValue([{ name: 'fake_tool', description: 'Fake', execute: mocks.execute }]);
    mocks.stateService.getByToolCallId.mockReset().mockResolvedValue(null);
    mocks.stateService.getForUser.mockReset().mockResolvedValue({
      tool_call_id: TOOL_CALL_ID,
      tool_params: TOOL_PARAMS,
      chat_id: 'chat-1',
    });
    for (const method of [mocks.stateService.create, mocks.stateService.update, mocks.stateService.upsert]) {
      method.mockReset().mockResolvedValue(null);
    }
    globals.mcpToolsCache?.clear();
    seedEntry(USER_A);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globals.toolApprovalState;
  });

  function expectNothingRan() {
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getCachedTools).not.toHaveBeenCalled();
    expect(mocks.stateService.upsert).not.toHaveBeenCalled();
    expect(mocks.stateService.create).not.toHaveBeenCalled();
    expect(mocks.stateService.update).not.toHaveBeenCalled();
    expect((globals.toolApprovalState?.[TOOL_CALL_ID] as { approved: boolean }).approved).toBe(false);
  }

  it('answers 401 with no session and runs nothing', async () => {
    const response = await POST(approveRequest());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expectNothingRan();
  });

  it('answers 503 when the session lookup throws and runs nothing', async () => {
    session.throws = true;
    const response = await POST(approveRequest());
    expect(response.status).toBe(503);
    expectNothingRan();
  });

  it('answers 404 when user B approves user A call and runs nothing', async () => {
    session.user = { id: USER_B };
    const response = await POST(approveRequest());
    expect(response.status).toBe(404);
    expectNothingRan();
  });

  it('answers 404 when the stored owner is null (anonymous chat) and runs nothing', async () => {
    seedEntry(null);
    session.user = { id: USER_A };
    const response = await POST(approveRequest());
    expect(response.status).toBe(404);
    expectNothingRan();
  });

  it('answers 404 when the stored entry has no owner field at all and runs nothing', async () => {
    seedEntry(undefined);
    session.user = { id: USER_A };
    const response = await POST(approveRequest());
    expect(response.status).toBe(404);
    expectNothingRan();
  });

  it('answers 403 when the owner of a planted state is not an admin and runs nothing', async () => {
    adminIds.clear();
    session.user = { id: USER_A };
    const response = await POST(approveRequest());
    expect(response.status).toBe(403);
    expectNothingRan();
  });

  it('answers 503 when the admin lookup fails and runs nothing', async () => {
    adminDb.failing = true;
    session.user = { id: USER_A };
    const response = await POST(approveRequest());
    expect(response.status).toBe(503);
    expectNothingRan();
  });

  it('lets the owner approve and run the tool', async () => {
    session.user = { id: USER_A };
    const response = await POST(approveRequest());
    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[0]?.[0]).toEqual(TOOL_PARAMS);
    expect(mocks.stateService.getForUser).toHaveBeenCalledWith(TOOL_CALL_ID, USER_A);
    expect(mocks.stateService.upsert.mock.calls.every(([arg]) => arg.user_id === USER_A)).toBe(true);
  });
});
