import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const TOOL_CALL_ID = 'call-gmail-approve-1';

const mocks = vi.hoisted(() => ({
  executeAnyTool: vi.fn(),
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
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER_A } } }) } }),
}));
vi.mock('@/lib/mcp/production-router', () => ({
  productionMcpRouter: {
    getAvailableServers: vi.fn(async () => []),
    getCachedTools: mocks.getCachedTools,
  },
}));
vi.mock('@/lib/mcp/universal-client', () => ({
  UniversalMcpClient: {
    getInstance: () => ({
      getConnectionStatus: mocks.getConnectionStatus,
      executeAnyTool: mocks.executeAnyTool,
    }),
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
  gmailCache?: unknown;
}

const APPROVED_PARAMS = {
  to: 'approved-recipient@example.test',
  thread_id: 'thread-approved-1',
  subject: 'Re: approved subject',
  body: '<p>approved body</p>',
  instructions: 'approved instructions',
};

const OTHER_USERS_EMAIL = {
  id: 'msg-other-user',
  threadId: 'thread-other-user',
  from: 'Other User Contact <other-contact@example.test>',
  subject: 'Other user private subject',
};

function approveRequest(): NextRequest {
  return new NextRequest('http://localhost/api/chat/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toolCallId: TOOL_CALL_ID, action: 'approve', sessionId: 'session-1' }),
  });
}

function seedApproval(name: string, params: Record<string, unknown>) {
  (globalThis as unknown as ApprovalGlobals).toolApprovalState = {
    [TOOL_CALL_ID]: {
      approved: false,
      executed: false,
      ownerUserId: USER_A,
      toolCall: { name, params, meta: { sessionId: 'session-1' } },
    },
  };
}

function seedForeignGmailCache() {
  const text = JSON.stringify({
    execution: { result: [OTHER_USERS_EMAIL] },
    results: [OTHER_USERS_EMAIL],
  });
  (globalThis as unknown as ApprovalGlobals).gmailCache = {
    lastFoundEmail: { content: [{ text }], thread_id: OTHER_USERS_EMAIL.threadId, from: 'other-contact@example.test', subject: OTHER_USERS_EMAIL.subject },
    recentEmails: [{ ...OTHER_USERS_EMAIL, from: 'other-contact@example.test', fromName: 'Approved Recipient', timestamp: Date.now() }],
    timestamp: Date.now(),
    MAX_CACHED_EMAILS: 10,
  };
}

describe('approve route executes exactly the approved Gmail parameters', () => {
  const globals = globalThis as unknown as ApprovalGlobals;

  beforeEach(() => {
    adminIds.clear();
    adminIds.add(USER_A);
    adminDb.failing = false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.executeAnyTool.mockReset().mockResolvedValue({ success: true, data: { status: 'ok', id: 'result-1' } });
    mocks.getConnectionStatus.mockReset().mockReturnValue([{ server: 'Fake Server', connected: true }]);
    mocks.getCachedTools.mockReset().mockImplementation(async () =>
      ['gmail_reply_to_email', 'gmail_create_draft_reply', 'gmail_find_email'].map(name => ({
        name,
        description: 'Fake',
        execute: vi.fn(),
      })),
    );
    mocks.stateService.getByToolCallId.mockReset().mockResolvedValue(null);
    mocks.stateService.getForUser.mockReset().mockResolvedValue(null);
    for (const method of [mocks.stateService.create, mocks.stateService.update, mocks.stateService.upsert]) {
      method.mockReset().mockResolvedValue(null);
    }
    globals.mcpToolsCache?.clear();
    seedForeignGmailCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globals.toolApprovalState;
    delete globals.gmailCache;
  });

  for (const toolName of ['gmail_reply_to_email', 'gmail_create_draft_reply']) {
    it(`${toolName} runs with the approved to/thread_id/subject/body although another user's email sits in the process cache`, async () => {
      seedApproval(toolName, { ...APPROVED_PARAMS });

      const response = await POST(approveRequest());

      expect(response.status).toBe(200);
      expect(mocks.executeAnyTool).toHaveBeenCalledTimes(1);
      const [calledName, executed] = mocks.executeAnyTool.mock.calls[0] as [string, Record<string, unknown>];
      expect(calledName).toBe(toolName);
      expect(executed.to).toBe(APPROVED_PARAMS.to);
      expect(executed.thread_id).toBe(APPROVED_PARAMS.thread_id);
      expect(executed.subject).toBe(APPROVED_PARAMS.subject);
      expect(executed.body).toBe(APPROVED_PARAMS.body);
      expect(JSON.stringify(executed)).not.toContain('other-contact');
      expect(JSON.stringify(executed)).not.toContain('thread-other-user');
      expect(JSON.stringify(executed)).not.toContain('Other user private subject');
    });
  }

  it('does not add a recipient, thread or subject to a reply that omitted them', async () => {
    seedApproval('gmail_reply_to_email', { body: '<p>only a body</p>', instructions: 'reply' });

    await POST(approveRequest());

    const executed = mocks.executeAnyTool.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(executed).toBeDefined();
    expect(executed).not.toHaveProperty('to');
    expect(executed).not.toHaveProperty('thread_id');
    expect(executed).not.toHaveProperty('subject');
  });

  it('legacy input-string replies take recipient, thread and subject from the approved params, never the cache', async () => {
    seedApproval('gmail_reply_to_email', {
      input: 'Body line without headers',
      to: APPROVED_PARAMS.to,
      thread_id: APPROVED_PARAMS.thread_id,
      subject: APPROVED_PARAMS.subject,
    });

    await POST(approveRequest());

    const executed = mocks.executeAnyTool.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(executed.to).toBe(APPROVED_PARAMS.to);
    expect(executed.thread_id).toBe(APPROVED_PARAMS.thread_id);
    expect(executed.subject).toBe(APPROVED_PARAMS.subject);
    expect(JSON.stringify(executed)).not.toContain('other-contact');
  });

  it('a find_email result is never stored in a process-wide cache', async () => {
    mocks.executeAnyTool.mockResolvedValue({
      success: true,
      data: { results: [OTHER_USERS_EMAIL] },
    });
    delete globals.gmailCache;
    seedApproval('gmail_find_email', { instructions: 'find recent emails' });

    await POST(approveRequest());

    expect(globals.gmailCache).toBeUndefined();
  });
});

describe('approve route after the in-memory approval state is gone', () => {
  const globals = globalThis as unknown as ApprovalGlobals;

  beforeEach(() => {
    adminIds.clear();
    adminIds.add(USER_A);
    adminDb.failing = false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.executeAnyTool.mockReset();
    mocks.getCachedTools.mockReset().mockResolvedValue([]);
    mocks.stateService.getByToolCallId.mockReset().mockResolvedValue(null);
    mocks.stateService.getForUser.mockReset().mockResolvedValue({
      tool_call_id: TOOL_CALL_ID,
      tool_name: 'gmail_reply_to_email',
      tool_params: { ...APPROVED_PARAMS },
      status: 'pending',
      chat_id: 'chat-1',
    });
    for (const method of [mocks.stateService.create, mocks.stateService.update, mocks.stateService.upsert]) {
      method.mockReset().mockResolvedValue(null);
    }
    globals.toolApprovalState = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globals.toolApprovalState;
  });

  it('answers a structured 409 instead of 500 and executes nothing', async () => {
    const response = await POST(approveRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Approval expired, ask again', code: 'approval_expired' });
    expect(mocks.executeAnyTool).not.toHaveBeenCalled();
    expect(mocks.getCachedTools).not.toHaveBeenCalled();
    expect(mocks.stateService.upsert).not.toHaveBeenCalled();
  });

  it('lets the owner cancel a persisted pending call', async () => {
    const request = new NextRequest('http://localhost/api/chat/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: TOOL_CALL_ID, action: 'cancel', sessionId: 'session-1' }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.stateService.upsert).toHaveBeenCalledWith(expect.objectContaining({ user_id: USER_A, status: 'cancelled' }));
    expect(mocks.executeAnyTool).not.toHaveBeenCalled();
  });
});
