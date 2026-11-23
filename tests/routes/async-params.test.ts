import fs from 'fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

type EqCall = [string, unknown];

interface QueryResult {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

interface FakeQuery {
  select: (...args: unknown[]) => FakeQuery;
  update: (...args: unknown[]) => FakeQuery;
  insert: (...args: unknown[]) => FakeQuery;
  delete: (...args: unknown[]) => FakeQuery;
  eq: (column: string, value: unknown) => FakeQuery;
  single: () => Promise<QueryResult>;
  then: (resolve: (value: QueryResult) => unknown) => Promise<unknown>;
}

interface FakeDb {
  from: (table: string) => FakeQuery;
  eqCalls: EqCall[];
  tables: string[];
}

function fakeDb(results: QueryResult[]): FakeDb {
  const queue = [...results];
  const db: FakeDb = {
    eqCalls: [],
    tables: [],
    from(table: string) {
      db.tables.push(table);
      const result = queue.shift() ?? { data: null, error: null };
      const query: FakeQuery = {
        select: () => query,
        update: () => query,
        insert: () => query,
        delete: () => query,
        eq: (column, value) => {
          db.eqCalls.push([column, value]);
          return query;
        },
        single: async () => result,
        then: (resolve) => Promise.resolve(result).then(resolve),
      };
      return query;
    },
  };
  return db;
}

function eqs(db: FakeDb): string {
  return db.eqCalls.map(([column, value]) => `${column}=${String(value)}`).join(',');
}

function argsOf(mock: { mock: { calls: unknown[][] } }): string {
  return JSON.stringify(mock.mock.calls);
}

function asyncParams<T extends Record<string, string>>(value: T): Promise<T> {
  return Promise.resolve(value);
}

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('@/lib/system-prompt-manager');
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/deployment-mode');
  vi.doUnmock('@/lib/auth/organization-handler');
  vi.doUnmock('@supabase/auth-helpers-nextjs');
  vi.doUnmock('next/headers');
});

describe('config/system-prompts/:lang', () => {
  test('GET resolves the awaited language', async () => {
    const getAllTemplates = vi.fn(() => ({ strict: 'prompt {{context}}' }));
    vi.doMock('@/lib/system-prompt-manager', () => ({
      SystemPromptManager: { getAllTemplates, getAvailableTemplates: () => ['strict'] },
    }));
    const route = await import('@/app/api/config/system-prompts/[lang]/route');
    const res = await route.GET(jsonRequest('http://localhost/api/config/system-prompts/es', 'GET'), {
      params: asyncParams({ lang: 'es' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { language: string }).language).toBe('es');
    expect(argsOf(getAllTemplates)).toBe('[["es"]]');
  });
});

describe('folders/:id', () => {
  function mockFolders(db: FakeDb, rpc = vi.fn(async () => ({ error: null }))) {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
        from: db.from,
        rpc,
      }),
    }));
    return rpc;
  }

  test('PUT filters the update by the awaited folder id', async () => {
    const db = fakeDb([{ error: null }]);
    mockFolders(db);
    const route = await import('@/app/api/folders/[id]/route');
    const res = await route.PUT(jsonRequest('http://localhost/api/folders/f-1', 'PUT', { name: ' Docs ' }), {
      params: asyncParams({ id: 'f-1' }),
    });
    expect(res.status).toBe(200);
    expect(eqs(db)).toContain('id=f-1');
  });

  test('DELETE passes the awaited folder id to the delete_folder function', async () => {
    const db = fakeDb([]);
    const rpc = mockFolders(db);
    const route = await import('@/app/api/folders/[id]/route');
    const res = await route.DELETE(jsonRequest('http://localhost/api/folders/f-1?deleteChats=true', 'DELETE'), {
      params: asyncParams({ id: 'f-1' }),
    });
    expect(res.status).toBe(200);
    expect(argsOf(rpc)).toBe('[["delete_folder",{"folder_uuid":"f-1","delete_chats":true}]]');
  });

  test('PATCH toggles the pin of the awaited folder id', async () => {
    const db = fakeDb([{ data: { pinned: false }, error: null }, { error: null }]);
    mockFolders(db);
    const route = await import('@/app/api/folders/[id]/route');
    const res = await route.PATCH(jsonRequest('http://localhost/api/folders/f-1', 'PATCH'), {
      params: asyncParams({ id: 'f-1' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pinned: boolean }).pinned).toBe(true);
    expect(eqs(db).split(',').filter((entry) => entry.startsWith('id=')).join(',')).toBe('id=f-1,id=f-1');
  });
});

describe('invites/:token', () => {
  function mockInvites(db: FakeDb, session: unknown = null) {
    vi.doMock('@/lib/deployment-mode', () => ({ requireMultiTenant: () => undefined }));
    vi.doMock('next/headers', () => ({ cookies: () => undefined }));
    vi.doMock('@supabase/auth-helpers-nextjs', () => ({
      createRouteHandlerClient: () => ({
        auth: { getSession: async () => ({ data: { session } }) },
        from: db.from,
      }),
    }));
  }

  test('GET looks the invitation up by the awaited token', async () => {
    const db = fakeDb([
      {
        data: {
          id: 'inv-1',
          email: 'invitee@example.invalid',
          role: 'member',
          status: 'pending',
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          organizations: { id: 'org-1', name: 'Org', slug: 'org' },
        },
        error: null,
      },
    ]);
    mockInvites(db);
    const route = await import('@/app/api/invites/[token]/route');
    const res = await route.GET(new Request('http://localhost/api/invites/tok-1'), {
      params: asyncParams({ token: 'tok-1' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe('member');
    expect(eqs(db)).toContain('token=tok-1');
  });

  test('POST looks the invitation up by the awaited token', async () => {
    const db = fakeDb([{ data: null, error: { message: 'not found' } }]);
    mockInvites(db, { user: { id: 'user-1', email: 'invitee@example.invalid' } });
    const route = await import('@/app/api/invites/[token]/route');
    const res = await route.POST(new Request('http://localhost/api/invites/tok-1', { method: 'POST' }), {
      params: asyncParams({ token: 'tok-1' }),
    });
    expect(res.status).toBe(404);
    expect(eqs(db)).toContain('token=tok-1');
  });
});

describe('mcp/servers/:id', () => {
  const SERVER = {
    id: 'srv-1',
    name: 'Test Server',
    endpoint: 'https://mcp.example.invalid/api',
    type: 'http',
    enabled: true,
  };

  function mockEnvFile() {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(`MCP_CUSTOM_SERVERS=${JSON.stringify([SERVER])}\n`);
    return vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
  }

  test('GET returns the server for the awaited id', async () => {
    const route = await import('@/app/api/mcp/servers/[id]/route');
    mockEnvFile();
    const res = await route.GET(jsonRequest('http://localhost/api/mcp/servers/srv-1', 'GET'), {
      params: asyncParams({ id: 'srv-1' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { server: { id: string } }).server.id).toBe('srv-1');
  });

  test('PUT updates the server matching the awaited id', async () => {
    const route = await import('@/app/api/mcp/servers/[id]/route');
    const write = mockEnvFile();
    const res = await route.PUT(
      jsonRequest('http://localhost/api/mcp/servers/srv-1', 'PUT', { ...SERVER, name: 'Renamed' }),
      { params: asyncParams({ id: 'srv-1' }) },
    );
    expect(res.status).toBe(200);
    expect(write.mock.calls.length).toBe(1);
  });

  test('DELETE removes the server matching the awaited id', async () => {
    const route = await import('@/app/api/mcp/servers/[id]/route');
    const write = mockEnvFile();
    const res = await route.DELETE(jsonRequest('http://localhost/api/mcp/servers/srv-1', 'DELETE'), {
      params: asyncParams({ id: 'srv-1' }),
    });
    expect(res.status).toBe(200);
    expect(write.mock.calls.length).toBe(1);
  });

  test('POST runs the requested action for the awaited id', async () => {
    const route = await import('@/app/api/mcp/servers/[id]/route');
    mockEnvFile();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const res = await route.POST(jsonRequest('http://localhost/api/mcp/servers/srv-1', 'POST', { action: 'test' }), {
      params: asyncParams({ id: 'srv-1' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
  });
});

describe('mcp/servers/:id/test', () => {
  test('POST tests the server matching the awaited id', async () => {
    const route = await import('@/app/api/mcp/servers/[id]/test/route');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      `MCP_CUSTOM_SERVERS=${JSON.stringify([
        { id: 'srv-1', name: 'Test Server', endpoint: 'https://mcp.example.invalid/api', type: 'http', enabled: true },
      ])}\n`,
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const res = await route.POST(
      jsonRequest('http://localhost/api/mcp/servers/srv-1/test', 'POST', { action: 'test' }),
      { params: asyncParams({ id: 'srv-1' }) },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
  });
});

describe('organizations/:id/members/:userId', () => {
  function mockOrganizations(db: FakeDb) {
    const isPersonalOrganization = vi.fn(async () => false);
    vi.doMock('@/lib/deployment-mode', () => ({ requireMultiTenant: () => undefined }));
    vi.doMock('@/lib/auth/organization-handler', () => ({ isPersonalOrganization }));
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({
        auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
        from: db.from,
        rpc: vi.fn(async () => ({ data: null, error: null })),
      }),
    }));
    return isPersonalOrganization;
  }

  test('PATCH updates the member identified by the awaited ids', async () => {
    const db = fakeDb([
      { data: { role: 'owner' }, error: null },
      { data: { role: 'member' }, error: null },
      { data: { id: 'm-1', role: 'viewer' }, error: null },
    ]);
    const isPersonal = mockOrganizations(db);
    const route = await import('@/app/api/organizations/[id]/members/[userId]/route');
    const res = await route.PATCH(
      new Request('http://localhost/api/organizations/org-1/members/user-2', {
        method: 'PATCH',
        body: JSON.stringify({ role: 'viewer' }),
      }),
      { params: asyncParams({ id: 'org-1', userId: 'user-2' }) },
    );
    expect(res.status).toBe(200);
    expect(argsOf(isPersonal)).toBe('[["org-1"]]');
    expect(eqs(db)).toContain('organization_id=org-1');
    expect(eqs(db)).toContain('user_id=user-2');
  });

  test('DELETE removes the member identified by the awaited ids', async () => {
    const db = fakeDb([
      { data: { role: 'member' }, error: null },
      { data: { role: 'owner' }, error: null },
      { error: null },
    ]);
    const isPersonal = mockOrganizations(db);
    const route = await import('@/app/api/organizations/[id]/members/[userId]/route');
    const res = await route.DELETE(
      new Request('http://localhost/api/organizations/org-1/members/user-2', { method: 'DELETE' }),
      { params: asyncParams({ id: 'org-1', userId: 'user-2' }) },
    );
    expect(res.status).toBe(200);
    expect(argsOf(isPersonal)).toBe('[["org-1"]]');
    expect(eqs(db)).toContain('organization_id=org-1');
    expect(eqs(db)).toContain('user_id=user-2');
  });
});

describe('organizations/:id/share', () => {
  test('POST shares the organization identified by the awaited id', async () => {
    const db = fakeDb([
      { data: { id: 'org-1', name: 'Org', is_personal: true, owner_id: 'user-1' }, error: null },
      { data: { id: 'org-1', name: 'Org', is_personal: false }, error: null },
    ]);
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    vi.doMock('@/lib/deployment-mode', () => ({ requireMultiTenant: () => undefined }));
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({
        auth: { getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }) },
        from: db.from,
        rpc,
      }),
    }));
    const route = await import('@/app/api/organizations/[id]/share/route');
    const res = await route.POST(new Request('http://localhost/api/organizations/org-1/share', { method: 'POST' }), {
      params: asyncParams({ id: 'org-1' }),
    });
    expect(res.status).toBe(200);
    expect(argsOf(rpc)).toBe('[["share_personal_organization",{"org_id":"org-1"}]]');
    expect(eqs(db)).toContain('id=org-1');
  });
});
