import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const TOOL_CALL_ID = 'call-gmail-summary-1';

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
}

/** Synthetic email; the summary the fake model writes repeats a non-allowlisted link and an allowlisted one. */
const EMAILS = [
  {
    id: 'msg-1',
    threadId: 'thread-1',
    from: 'Sample Sender <sender@example.test>',
    subject: 'Your status report is ready',
    date: '2026-01-05',
    body_plain: 'Report 42 is attached.',
  },
];
const SUMMARY = 'Your status report is ready. Details at https://other.test/report and https://allowed.test/ok today.';

function approveRequest(): NextRequest {
  return new NextRequest('http://localhost/api/chat/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toolCallId: TOOL_CALL_ID, action: 'approve', sessionId: 'session-1' }),
  });
}

function seedApproval(params: Record<string, unknown>) {
  (globalThis as unknown as ApprovalGlobals).toolApprovalState = {
    [TOOL_CALL_ID]: {
      approved: false,
      executed: false,
      ownerUserId: USER_A,
      toolCall: { name: 'gmail_find_email', params, meta: { sessionId: 'session-1' } },
    },
  };
}

const GUARD_ENV = ['RAG_OUTPUT_GUARD', 'RAG_OUTPUT_LINK_ALLOWLIST'] as const;

describe('approve route summary through the whole-text output guard (05.2-13, D-35)', () => {
  const globals = globalThis as unknown as ApprovalGlobals;
  const fetchMock = vi.fn();

  beforeEach(() => {
    adminIds.clear();
    adminIds.add(USER_A);
    adminDb.failing = false;
    for (const name of GUARD_ENV) delete process.env[name];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.executeAnyTool.mockReset().mockResolvedValue({ success: true, data: { results: EMAILS } });
    mocks.getConnectionStatus.mockReset().mockReturnValue([{ server: 'Fake Server', connected: true }]);
    mocks.getCachedTools.mockReset().mockImplementation(async () => [{ name: 'gmail_find_email', description: 'Fake', execute: vi.fn() }]);
    mocks.stateService.getByToolCallId.mockReset().mockResolvedValue(null);
    mocks.stateService.getForUser.mockReset().mockResolvedValue(null);
    for (const method of [mocks.stateService.create, mocks.stateService.update, mocks.stateService.upsert]) {
      method.mockReset().mockResolvedValue(null);
    }
    globals.mcpToolsCache?.clear();
    fetchMock.mockReset().mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: SUMMARY } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    for (const name of GUARD_ENV) delete process.env[name];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete globals.toolApprovalState;
  });

  async function approvedText(): Promise<string> {
    seedApproval({ instructions: 'find my emails about the status report' });
    const response = await POST(approveRequest());
    expect(response.status).toBe(200);
    return response.text();
  }

  it.each([undefined, 'off'])('guard %s: the summary text is returned unchanged', async (value) => {
    if (value !== undefined) process.env.RAG_OUTPUT_GUARD = value;
    const body = await approvedText();
    expect(body).toContain('https://other.test/report');
    expect(body).toContain('https://allowed.test/ok');
  });

  it('guard enforce: a non-allowlisted link in the summary is replaced, an allowlisted one is kept', async () => {
    process.env.RAG_OUTPUT_GUARD = 'enforce';
    process.env.RAG_OUTPUT_LINK_ALLOWLIST = 'allowed.test';
    const body = await approvedText();
    expect(body).not.toContain('other.test');
    expect(body).toContain('https://allowed.test/ok');
    expect(body).toContain('(link removed)');
  });

  it('guard flag: the summary text is unchanged', async () => {
    process.env.RAG_OUTPUT_GUARD = 'flag';
    process.env.RAG_OUTPUT_LINK_ALLOWLIST = 'allowed.test';
    const body = await approvedText();
    expect(body).toContain('https://other.test/report');
  });
});
