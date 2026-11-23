import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEmbedder } from './helpers/pipeline-fakes';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const CONTENT = 'First placeholder paragraph.\n\nSecond placeholder paragraph.';

type Row = Record<string, unknown>;

const state = {
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  members: [] as Array<{ organization_id: string; user_id: string }>,
  inserts: [] as Array<{ table: string; rows: Row[] }>,
  admins: [] as string[],
  readOnly: false,
};

function writeAdmin() {
  return {
    from(table: string) {
      let filter: unknown;
      const builder = {
        eq(_column: string, value: unknown) {
          filter = value;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        maybeSingle: () => {
          if (table === 'admin_users') return Promise.resolve({ data: state.admins.includes(filter as string) ? { id: filter } : null, error: null });
          if (table === 'admin_settings') return Promise.resolve({ data: { read_only_doc_dashboard: state.readOnly }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        insert(rows: Row[]) {
          state.inserts.push({ table, rows });
          return builder;
        },
        select: () => builder,
        single: () => Promise.resolve({ data: state.inserts.at(-1)?.rows[0] ?? null, error: null }),
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
}

function membershipAdmin() {
  return {
    from() {
      const filters: Record<string, string> = {};
      const query = {
        select: () => query,
        eq(column: string, value: string) {
          filters[column] = value;
          return query;
        },
        abortSignal: () => query,
        maybeSingle() {
          const row = state.members.find(
            (member) => member.organization_id === filters.organization_id && member.user_id === filters.user_id,
          );
          return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
        },
      };
      return query;
    },
  };
}

async function loadPost(): Promise<(req: Request) => Promise<Response>> {
  vi.resetModules();
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => state.mode,
    isMultiTenant: () => state.mode === 'multi-tenant',
    isSingleTenant: () => state.mode === 'single-tenant',
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session } }) } }),
  }));
  vi.doMock('@/lib/auth/organization-handler', () => ({ verifyUserOrganizationAccess: async () => ({ hasAccess: false }) }));
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => writeAdmin() }));
  vi.doMock('openai', () => ({
    default: class FakeOpenAI {
      chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Placeholder Title' } }] }) } };
    },
  }));
  const embedder = fakeEmbedder().embedder;
  vi.doMock('@/lib/rag', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/rag')>()),
    embedText: (text: string, opts: { signal: AbortSignal }) => embedder(text, opts),
  }));
  const { setRagDepsForTests } = await import('@/lib/rag/deps');
  setRagDepsForTests({ adminClient: () => membershipAdmin() as never });
  const { POST } = await import('@/app/api/ai-to-rag/route');
  return POST;
}

function request(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/ai-to-rag', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: CONTENT, messageId: 'message-1', chatId: 'chat-1', ...body }),
  });
}

const writesOf = (table: string) => state.inserts.filter((insert) => insert.table === table).flatMap((insert) => insert.rows);

describe('ai-to-rag route', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.session = null;
    state.members = [];
    state.inserts = [];
    state.admins = [];
    state.readOnly = false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/rag');
    vi.doUnmock('@supabase/supabase-js');
    vi.doUnmock('openai');
  });

  it('refuses a request with no session and writes nothing', async () => {
    const POST = await loadPost();
    const response = await POST(request({ userId: USER_A }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(state.inserts).toEqual([]);
  });

  it('refuses a body userId that differs from the session user and writes nothing', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost();
    const response = await POST(request({ userId: USER_B }));
    expect(response.status).toBe(403);
    expect(state.inserts).toEqual([]);
  });

  it('writes under the session user when the body carries no userId', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost();
    const response = await POST(request({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, chunksStored: 1, totalChunks: 1 });
    const documents = writesOf('documents');
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ user_id: USER_A, organization_id: null });
    const chunks = writesOf('document_chunks');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ document_id: documents[0].id, organization_id: null });
  });

  it('accepts a body userId equal to the session user', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost();
    const response = await POST(request({ userId: USER_A.toUpperCase() }));
    expect(response.status).toBe(200);
    expect(writesOf('documents')[0]).toMatchObject({ user_id: USER_A });
  });

  it('refuses an organization the session user is not a member of in multi-tenant mode', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_B }];
    const POST = await loadPost();
    const response = await POST(request({ userId: USER_A, organizationId: ORG_X }));
    expect(response.status).toBe(403);
    expect(state.inserts).toEqual([]);
  });

  it('writes with the verified organization when the session user is a member', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const POST = await loadPost();
    const response = await POST(request({ organizationId: ORG_X }));
    expect(response.status).toBe(200);
    expect(writesOf('documents')[0]).toMatchObject({ user_id: USER_A, organization_id: ORG_X });
    expect(writesOf('document_chunks')[0]).toMatchObject({ organization_id: ORG_X });
  });

  it('keeps the single-tenant write shape', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    const POST = await loadPost();
    const response = await POST(request({ userId: USER_A, organizationId: ORG_X }));
    expect(response.status).toBe(200);
    const documents = writesOf('documents');
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ user_id: USER_A });
    expect(documents[0]).not.toHaveProperty('organization_id');
    expect(writesOf('document_chunks')[0]).not.toHaveProperty('organization_id');
  });

  it('single-tenant read_only_doc_dashboard: a non-admin gets 403 and nothing is written, an admin can still write', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    state.readOnly = true;
    const POST = await loadPost();
    expect((await POST(request({}))).status).toBe(403);
    expect(state.inserts).toEqual([]);
    state.admins = [USER_A];
    expect((await POST(request({}))).status).toBe(200);
    expect(writesOf('documents')).toHaveLength(1);
  });

  it('still refuses a mismatched body userId in single-tenant mode', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    const POST = await loadPost();
    const response = await POST(request({ userId: USER_B }));
    expect(response.status).toBe(403);
    expect(state.inserts).toEqual([]);
  });

  it('returns 400 for empty content after authentication', async () => {
    state.session = { id: USER_A };
    const POST = await loadPost();
    const response = await POST(request({ content: '' }));
    expect(response.status).toBe(400);
    expect(state.inserts).toEqual([]);
  });

  it('never logs the content', async () => {
    state.session = { id: USER_A };
    const logs = vi.spyOn(console, 'log');
    const POST = await loadPost();
    await POST(request({}));
    expect(JSON.stringify(logs.mock.calls)).not.toContain('placeholder paragraph');
  });
});
