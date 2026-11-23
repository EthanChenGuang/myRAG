import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-4000-8000-0000000000a1';

const state = {
  session: null as { id: string } | null,
  authThrows: false,
  uploads: [] as string[],
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
  vi.doMock('@/lib/supabase', () => ({
    supabaseAdmin: {
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
  vi.doMock('@/lib/document-processor', () => ({ processImageDocument: async () => undefined }));
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
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/lib/supabase/server');
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/document-processor');
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
});
