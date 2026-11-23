import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const TOOL_CALL_ID = 'call-caller-scope-1';
const CHAT_ID = 'session-1';
const A_IMAGE = 'https://storage.example.test/chat-images/user-a.png';
const B_IMAGE = 'https://storage.example.test/chat-images/user-b-private.png';

const session = vi.hoisted(() => ({ userId: '' }));

const mocks = vi.hoisted(() => ({
  executeAnyTool: vi.fn(),
  getCachedTools: vi.fn(),
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
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: session.userId } } }) } }),
}));
vi.mock('@/lib/mcp/production-router', () => ({
  productionMcpRouter: {
    getAvailableServers: vi.fn(async () => []),
    getCachedTools: mocks.getCachedTools,
  },
}));
vi.mock('@/lib/mcp/universal-client', () => ({
  UniversalMcpClient: {
    getInstance: () => ({ getConnectionStatus: () => [], executeAnyTool: mocks.executeAnyTool }),
  },
}));
vi.mock('@/lib/dev-logger', () => ({
  devLog: { verbose: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from '@/app/api/chat/approve/route';
import { writeImageContext } from '@/lib/mcp/caller-scope';
import { adminIds } from './helpers/fake-admin-db';

interface Globals {
  toolApprovalState?: Record<string, unknown>;
  mcpToolsCache?: Map<string, { tools: unknown[]; timestamp: number }>;
  mcpImageContext?: Record<string, unknown>;
}

const APPROVED = { to: 'approved@example.test', subject: 'Approved', body: '<p>approved</p>', instructions: 'send' };

function approveRequest(): NextRequest {
  return new NextRequest('http://localhost/api/chat/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toolCallId: TOOL_CALL_ID, action: 'approve', sessionId: CHAT_ID }),
  });
}

function seedApproval(owner: string) {
  (globalThis as unknown as Globals).toolApprovalState = {
    [TOOL_CALL_ID]: {
      approved: false,
      executed: false,
      ownerUserId: owner,
      toolCall: { name: 'gmail_send_email', params: { ...APPROVED }, meta: { sessionId: CHAT_ID } },
    },
  };
}

function executedParams(): Record<string, unknown> {
  return mocks.executeAnyTool.mock.calls[0]?.[1] as Record<string, unknown>;
}

describe('approve route keeps image context and tool cache per verified caller and chat', () => {
  const globals = globalThis as unknown as Globals;

  beforeEach(() => {
    adminIds.clear();
    adminIds.add(USER_A).add(USER_B);
    session.userId = USER_A;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.executeAnyTool.mockReset().mockResolvedValue({ success: true, data: { status: 'ok' } });
    mocks.getCachedTools
      .mockReset()
      .mockImplementation(async () => [{ name: 'gmail_send_email', description: 'Fake', execute: vi.fn() }]);
    mocks.stateService.getByToolCallId.mockReset().mockResolvedValue(null);
    mocks.stateService.getForUser.mockReset().mockResolvedValue(null);
    for (const method of [mocks.stateService.create, mocks.stateService.update, mocks.stateService.upsert]) {
      method.mockReset().mockResolvedValue(null);
    }
    globals.mcpToolsCache?.clear();
    delete globals.mcpImageContext;
    seedApproval(USER_A);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globals.toolApprovalState;
    delete globals.mcpImageContext;
  });

  it("never injects another user's image context for the same chat id", async () => {
    writeImageContext(USER_B, CHAT_ID, { imageUrl: B_IMAGE, downloadableUrls: [B_IMAGE] });

    const response = await POST(approveRequest());

    expect(response.status).toBe(200);
    expect(mocks.executeAnyTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(executedParams())).not.toContain('user-b-private');
    expect(executedParams()).not.toHaveProperty('file');
    expect(executedParams()).not.toHaveProperty('attachment_url');
  });

  it('ignores unscoped legacy entries keyed by chat id or by image url (no any-session fallback)', async () => {
    globals.mcpImageContext = {
      [CHAT_ID]: { imageUrl: B_IMAGE, downloadableUrls: [B_IMAGE] },
      [B_IMAGE]: { imageUrl: B_IMAGE, downloadableUrls: [B_IMAGE] },
      'other-chat': { imageUrl: B_IMAGE, downloadableUrls: [B_IMAGE] },
    };

    await POST(approveRequest());

    expect(JSON.stringify(executedParams())).not.toContain('user-b-private');
    expect(executedParams()).not.toHaveProperty('file');
  });

  it("does not use another chat's context of the same user", async () => {
    writeImageContext(USER_A, 'other-chat', { imageUrl: A_IMAGE, downloadableUrls: [A_IMAGE] });

    await POST(approveRequest());

    expect(executedParams()).not.toHaveProperty('file');
  });

  it("still attaches the caller's own image for the same chat", async () => {
    writeImageContext(USER_A, CHAT_ID, { imageUrl: A_IMAGE, downloadableUrls: [A_IMAGE] });
    writeImageContext(USER_B, CHAT_ID, { imageUrl: B_IMAGE, downloadableUrls: [B_IMAGE] });

    await POST(approveRequest());

    expect(executedParams().file).toBe(A_IMAGE);
    expect(JSON.stringify(executedParams())).not.toContain('user-b-private');
  });

  it("looks the tool cache up by verified user and chat, never by chat id alone or another user's key", async () => {
    globals.mcpToolsCache?.set(CHAT_ID, { tools: [{ name: 'planted_tool', execute: vi.fn() }], timestamp: Date.now() });
    globals.mcpToolsCache?.set(`${USER_B}::${CHAT_ID}`, {
      tools: [{ name: 'planted_tool', execute: vi.fn() }],
      timestamp: Date.now(),
    });

    await POST(approveRequest());

    expect(mocks.getCachedTools).toHaveBeenCalledTimes(1);
    expect(mocks.getCachedTools.mock.calls[0]?.[1]).toBe(`${USER_A}::${CHAT_ID}`);
  });

  it("uses the caller's own cached tools when present", async () => {
    globals.mcpToolsCache?.set(`${USER_A}::${CHAT_ID}`, {
      tools: [{ name: 'gmail_send_email', execute: vi.fn() }],
      timestamp: Date.now(),
    });

    await POST(approveRequest());

    expect(mocks.getCachedTools).not.toHaveBeenCalled();
    expect(mocks.executeAnyTool).toHaveBeenCalledTimes(1);
  });
});
