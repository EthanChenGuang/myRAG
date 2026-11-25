import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const OWNER_ID = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');

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
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: OWNER_ID } } }) } }),
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

const TOOL_CALL_ID = 'call-approve-params-1';
const TOOL_PARAMS = { query: 'placeholder query' };

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

function errorLogText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .map(call => call.map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    .join('\n');
}

describe('approve route parameter handling', () => {
  const globals = globalThis as unknown as ApprovalGlobals;

  beforeEach(() => {
    adminIds.clear();
    adminIds.add(OWNER_ID);
    adminDb.failing = false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.execute.mockReset().mockResolvedValue({});
    mocks.getConnectionStatus.mockReset().mockReturnValue([{ server: 'Fake Server', connected: true }]);
    mocks.getCachedTools.mockReset().mockResolvedValue([{ name: 'fake_tool', description: 'Fake', execute: mocks.execute }]);
    mocks.stateService.getForUser.mockReset().mockResolvedValue({
      tool_call_id: TOOL_CALL_ID,
      tool_params: TOOL_PARAMS,
      chat_id: 'chat-1',
    });
    for (const method of [mocks.stateService.create, mocks.stateService.update, mocks.stateService.upsert]) {
      method.mockReset().mockResolvedValue(null);
    }
    globals.mcpToolsCache?.clear();
    globals.toolApprovalState = {
      [TOOL_CALL_ID]: {
        approved: false,
        executed: false,
        ownerUserId: OWNER_ID,
        toolCall: { name: 'fake_tool', params: TOOL_PARAMS, meta: { sessionId: 'session-1' } },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globals.toolApprovalState;
  });

  it('logs the parameters sent when a tool returns an empty result instead of throwing a ReferenceError', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(approveRequest());
    const body = (await response.json()) as { error?: string; message?: string; success?: boolean };

    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.execute.mock.calls[0]?.[0]).toEqual(TOOL_PARAMS);
    expect(JSON.stringify(body)).not.toContain('paramsToUse is not defined');
    expect(errorLogText(errorSpy)).toContain('Parameters sent:');
    expect(errorLogText(errorSpy)).toContain('placeholder query');
    expect(errorLogText(errorSpy)).not.toContain('paramsToUse is not defined');
  });

  it('reads tool results through the content array text parts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.execute.mockResolvedValue({ content: [{ type: 'text', text: 'tool output text' }], isError: false });

    const response = await POST(approveRequest());
    const body = await response.json();

    expect(JSON.stringify(body)).toContain('tool output text');
  });

  it('reports client status through the public connection getters when the tool fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.execute.mockRejectedValue(new Error('tool exploded'));

    const response = await POST(approveRequest());
    const body = (await response.json()) as { debugInfo?: { activeClientEndpoint?: string } };

    expect(mocks.getConnectionStatus).toHaveBeenCalled();
    expect(JSON.stringify(body)).toContain('tool exploded');
    expect(errorLogText(errorSpy)).not.toContain('is not a function');
  });
});
