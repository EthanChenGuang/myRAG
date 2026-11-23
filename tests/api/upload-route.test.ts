import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-4000-8000-0000000000a1';

const state = {
  session: null as { id: string } | null,
  authThrows: false,
  uploads: [] as string[],
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  admins: [] as string[],
  readOnly: false,
  processed: [] as string[],
};

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (state.authThrows) throw new Error('auth down');
          return { data: { user: state.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/deployment-mode', () => ({
    isSingleTenant: () => state.mode === 'single-tenant',
    isMultiTenant: () => state.mode === 'multi-tenant',
    getDeploymentMode: () => state.mode,
  }));
  vi.doMock('@/lib/rag', () => ({
    isAdminUser: async (_admin: unknown, userId: string) => state.admins.includes(userId),
  }));
  vi.doMock('@/lib/supabase', () => ({
    supabaseAdmin: {
      from: () => {
        const builder = {
          select: () => builder,
          order: () => builder,
          limit: () => builder,
          maybeSingle: async () => ({ data: { read_only_doc_dashboard: state.readOnly }, error: null }),
        };
        return builder;
      },
      storage: {
        from: () => ({
          upload: async (path: string) => {
            state.uploads.push(path);
            return { data: { path }, error: null };
          },
        }),
      },
    },
  }));
  vi.doMock('@/lib/document-processor', () => ({
    processImageDocument: async (name: string) => {
      state.processed.push(name);
    },
  }));
  vi.doMock('@/lib/logger', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
  return import('@/app/api/upload/route');
}

function uploadRequest(fields: Record<string, string> = {}, fileName = 'photo.png') {
  const form = new FormData();
  form.append('files', new File(['placeholder'], fileName, { type: 'image/png' }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new NextRequest('http://localhost/api/upload', { method: 'POST', body: form });
}

describe('upload route', () => {
  beforeEach(() => {
    state.session = null;
    state.authThrows = false;
    state.uploads = [];
    state.mode = 'single-tenant';
    state.admins = [];
    state.readOnly = false;
    state.processed = [];
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/lib/supabase/server');
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/document-processor');
    vi.doUnmock('@/lib/deployment-mode');
    vi.doUnmock('@/lib/rag');
    vi.doUnmock('@/lib/logger');
  });

  it('returns 401 with no session and writes nothing', async () => {
    const { POST } = await loadRoute();
    const res = await POST(uploadRequest());
    expect(res.status).toBe(401);
    expect(state.uploads).toEqual([]);
  });

  it('returns 503 when the session lookup throws and writes nothing', async () => {
    state.authThrows = true;
    const { POST } = await loadRoute();
    const res = await POST(uploadRequest());
    expect(res.status).toBe(503);
    expect(state.uploads).toEqual([]);
  });

  it('uses the session user id as the path prefix and ignores a client sessionId', async () => {
    state.session = { id: USER };
    const { POST } = await loadRoute();
    const res = await POST(uploadRequest({ sessionId: 'victim-prefix/../other' }));
    expect(res.status).toBe(200);
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0].startsWith(`${USER}/`)).toBe(true);
    expect(state.uploads[0]).not.toContain('victim-prefix');
    const body = await res.json();
    expect(body.files[0].filePath).toBe(state.uploads[0]);
    expect(body.files[0].downloadUrl).toContain(`/chat-images/${USER}/`);
  });

  it('keeps a crafted file name inside the user prefix', async () => {
    state.session = { id: USER };
    const { POST } = await loadRoute();
    const res = await POST(uploadRequest({}, 'a.b/../../evil'));
    expect(res.status).toBe(200);
    expect(state.uploads[0]).toMatch(new RegExp(`^${USER}/[A-Za-z0-9_.-]+$`));
  });

  it('read_only_doc_dashboard: a non-admin asking for knowledge-base processing gets 403 and nothing is uploaded or processed', async () => {
    state.session = { id: USER };
    state.readOnly = true;
    const { POST } = await loadRoute();
    const res = await POST(uploadRequest({ process_rag: 'true' }));
    expect(res.status).toBe(403);
    expect(state.uploads).toEqual([]);
    expect(state.processed).toEqual([]);
  });

  it('read_only_doc_dashboard: plain chat attachments still upload for a non-admin, and an admin can process into the knowledge base', async () => {
    state.session = { id: USER };
    state.readOnly = true;
    const { POST } = await loadRoute();
    expect((await POST(uploadRequest())).status).toBe(200);
    state.admins = [USER];
    expect((await POST(uploadRequest({ process_rag: 'true' }))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.processed).toEqual(['photo.png']);
  });
});
