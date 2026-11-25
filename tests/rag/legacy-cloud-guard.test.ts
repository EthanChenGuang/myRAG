import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-4000-8000-0000000000b1';
const BODY = '%PDF-1.4 placeholder body';

const state = {
  session: null as { id: string } | null,
  llamaCalls: 0,
  storeCalls: 0,
  inserts: [] as string[],
};

function stubCloud(value: string | undefined): void {
  vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', value ?? '');
}

function fakeLlamaFetch() {
  return async (_url: string) => {
    state.llamaCalls += 1;
    const url = String(_url);
    const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' });
    if (url.endsWith('/parsing/upload')) return json({ id: 'job-1', status: 'PENDING' });
    if (url.endsWith('/result/markdown')) return json({ markdown: 'Placeholder document body text.', metadata: { total_pages: 1 }, chunks: ['Placeholder document body text.'] });
    return json({ status: 'SUCCESS' });
  };
}

function routeAdmin() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert() {
          state.inserts.push(table);
          return builder;
        },
        select: () => builder,
        single: () => Promise.resolve({ data: { id: 'doc' }, error: null }),
        then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok, bad),
      };
      return builder;
    },
    storage: { from: () => ({ upload: async () => ({ data: {}, error: null }), getPublicUrl: () => ({ data: { publicUrl: 'http://127.0.0.1/x' } }) }) },
  };
}

async function loadPost(pipeline: string): Promise<(req: Request) => Promise<Response>> {
  vi.resetModules();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key-placeholder');
  vi.stubEnv('LLAMA_CLOUD_API_KEY', 'test-llama-key-placeholder');
  vi.stubEnv('RAG_INGEST_PIPELINE', pipeline);
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => 'multi-tenant',
    isMultiTenant: () => true,
    isSingleTenant: () => false,
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => routeAdmin(), getSupabase: () => ({}) }));
  vi.doMock('@/lib/auth/organization-handler', () => ({ verifyUserOrganizationAccess: async () => ({ hasAccess: false }) }));
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => routeAdmin() }));
  vi.doMock('node-fetch', () => ({ default: fakeLlamaFetch() }));
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/rag')>();
    return { ...original, embedText: async () => [0.1, 0.2], embedBatch: async () => [[0.1, 0.2]] };
  });
  const { POST } = await import('@/app/api/process-document/route');
  return POST;
}

function upload(options: { temporary?: boolean; name?: string } = {}): Request {
  const form = new FormData();
  form.append('file', new File([BODY], options.name ?? 'report.pdf', { type: 'application/pdf' }));
  form.append('isTemporary', String(options.temporary ?? false));
  return new Request('http://localhost/api/process-document', { method: 'POST', body: form });
}

beforeEach(() => {
  state.session = null;
  state.llamaCalls = 0;
  state.storeCalls = 0;
  state.inserts = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const id of ['@/lib/deployment-mode', '@/lib/supabase/server', '@/lib/supabase', '@/lib/auth/organization-handler', '@supabase/supabase-js', 'node-fetch', '@/lib/rag']) {
    vi.doUnmock(id);
  }
});

describe('process-document route: cloud switch off', () => {
  it.each(['legacy', 'unified'])('pipeline %s: a temporary attachment returns 503 cloud_parsing_disabled and sends nothing to LlamaParse', async (pipeline) => {
    stubCloud('false');
    state.session = { id: USER };
    const POST = await loadPost(pipeline);
    const response = await POST(upload({ temporary: true }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'cloud_parsing_disabled' });
    expect(state.llamaCalls).toBe(0);
    expect(state.inserts).toEqual([]);
  });

  it('legacy: a knowledge-base PDF upload returns 503 cloud_parsing_disabled, sends nothing and persists nothing', async () => {
    stubCloud('false');
    state.session = { id: USER };
    const POST = await loadPost('legacy');
    const response = await POST(upload());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'cloud_parsing_disabled' });
    expect(state.llamaCalls).toBe(0);
    expect(state.inserts).toEqual([]);
  });

  it('the session check stays first: no session returns 401, not 503', async () => {
    stubCloud('false');
    state.session = null;
    const POST = await loadPost('legacy');
    const response = await POST(upload());
    expect(response.status).toBe(401);
    expect(state.llamaCalls).toBe(0);
  });

  it('the refusal log carries no file name', async () => {
    stubCloud('false');
    state.session = { id: USER };
    const POST = await loadPost('legacy');
    await POST(upload({ name: 'confidential-name-placeholder.pdf', temporary: true }));
    const lines = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls].map((call) => JSON.stringify(call));
    expect(lines.some((line) => line.includes('[Ingest] cloud parsing disabled'))).toBe(true);
    expect(lines.filter((line) => line.includes('[Ingest] cloud parsing disabled')).every((line) => !line.includes('confidential-name-placeholder'))).toBe(true);
  });
});

describe('refused requests do not log the file name (LOW-4)', () => {
  function allLogLines(): string[] {
    return [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls].map((call) => JSON.stringify(call));
  }

  it.each([true, false])('route, temporary=%s: no log line carries the name of a refused file', async (temporary) => {
    stubCloud('false');
    state.session = { id: USER };
    const POST = await loadPost('legacy');
    const response = await POST(upload({ name: 'confidential-name-placeholder.pdf', temporary }));
    expect(response.status).toBe(503);
    expect(allLogLines().some((line) => line.includes('confidential-name-placeholder'))).toBe(false);
  });

  it('processDocument: no log line carries the name of a refused file', async () => {
    stubCloud('false');
    vi.resetModules();
    vi.stubEnv('LLAMA_CLOUD_API_KEY', 'test-llama-key-placeholder');
    vi.doMock('node-fetch', () => ({ default: fakeLlamaFetch() }));
    vi.doMock('@/lib/supabase', () => ({ storeDocument: async () => 'doc-1' }));
    try {
      const { processDocument } = await import('@/lib/document-processor');
      await expect(processDocument('confidential-name-placeholder.pdf', Buffer.from(BODY), { user_id: USER })).rejects.toThrow();
      expect(allLogLines().some((line) => line.includes('confidential-name-placeholder'))).toBe(false);
    } finally {
      vi.doUnmock('node-fetch');
      vi.doUnmock('@/lib/supabase');
    }
  });
});

describe('document-processor: provider file names cannot leave the temp directory (LOW-5)', () => {
  const tempDir = path.join(os.tmpdir(), 'myrag');

  async function runWithName(name: string): Promise<void> {
    stubCloud('true');
    vi.resetModules();
    vi.stubEnv('LLAMA_CLOUD_API_KEY', 'test-llama-key-placeholder');
    vi.doMock('node-fetch', () => ({
      default: async () => {
        throw new Error('network down');
      },
    }));
    vi.doMock('@/lib/supabase', () => ({ storeDocument: async () => 'doc-1' }));
    try {
      const { processDocument } = await import('@/lib/document-processor');
      await expect(processDocument(name, Buffer.from(BODY), { user_id: USER })).rejects.toThrow();
    } finally {
      vi.doUnmock('node-fetch');
      vi.doUnmock('@/lib/supabase');
    }
  }

  const probe = `probe-${crypto.randomUUID()}`;

  it.each([`../${probe}-one.pdf`, `../../${probe}-two.pdf`, `sub/../../${probe}-three.pdf`, `..\\${probe}-four.pdf`])(
    'a name like %s is written inside the temp directory, and removed after a failed parse',
    async (name) => {
      const escaped = [path.join(os.tmpdir(), path.basename(name.replace(/\\/g, '/'))), path.join(path.dirname(os.tmpdir()), path.basename(name.replace(/\\/g, '/')))];
      fs.mkdirSync(tempDir, { recursive: true });
      const before = new Set(fs.readdirSync(tempDir));
      await runWithName(name);
      for (const location of escaped) {
        expect(fs.existsSync(location), location).toBe(false);
        fs.rmSync(location, { force: true });
      }
      const leftover = fs.readdirSync(tempDir).filter((entry) => !before.has(entry));
      expect(leftover).toEqual([]);
    },
  );

  it('exports a temp path helper that stays in the directory and keeps only a safe extension', async () => {
    vi.resetModules();
    vi.doMock('@/lib/supabase', () => ({ storeDocument: async () => 'doc-1' }));
    try {
      const { tempPathFor } = await import('@/lib/document-processor');
      for (const name of ['../../etc/passwd', '/abs/path/report.pdf', 'a/b/c.docx', '..', '', 'x.p$d%f', 'plain.pdf']) {
        const resolved = tempPathFor(tempDir, name);
        expect(path.dirname(resolved), name).toBe(tempDir);
        expect(path.basename(resolved), name).toMatch(/^[0-9a-f-]{36}(\.[a-z0-9]{1,8})?$/);
      }
      expect(path.extname(tempPathFor(tempDir, 'sub/report.PDF'))).toBe('.pdf');
      expect(tempPathFor(tempDir, 'a.pdf')).not.toBe(tempPathFor(tempDir, 'a.pdf'));
    } finally {
      vi.doUnmock('@/lib/supabase');
    }
  });
});

describe('process-document route: cloud switch on (default)', () => {
  it.each([undefined, 'true'])('RAG_PARSER_ALLOW_CLOUD=%s: a temporary attachment still reaches LlamaParse and returns its text', async (value) => {
    stubCloud(value);
    state.session = { id: USER };
    const POST = await loadPost('legacy');
    const response = await POST(upload({ temporary: true }));
    expect(response.status).toBe(200);
    expect(state.llamaCalls).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ name: 'report.pdf', text: 'Placeholder document body text.' });
  });
});

describe('document-processor: cloud switch', () => {
  const tempDir = path.join(os.tmpdir(), 'myrag');
  const filename = 'cloud-guard-placeholder.pdf';

  async function loadProcessor() {
    vi.resetModules();
    vi.stubEnv('LLAMA_CLOUD_API_KEY', 'test-llama-key-placeholder');
    vi.doMock('node-fetch', () => ({ default: fakeLlamaFetch() }));
    vi.doMock('@/lib/supabase', () => ({
      storeDocument: async () => {
        state.storeCalls += 1;
        return 'doc-1';
      },
    }));
    vi.doMock('@/lib/rag', async (importOriginal) => {
      const original = await importOriginal<typeof import('@/lib/rag')>();
      return { ...original, embedText: async () => [0.1], embedBatch: async (chunks: string[]) => chunks.map(() => [0.1, 0.2]) };
    });
    return import('@/lib/document-processor');
  }

  afterEach(() => {
    vi.doUnmock('node-fetch');
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/rag');
    fs.rmSync(path.join(tempDir, filename), { force: true });
  });

  it('cloud off: processDocument on a PDF throws CloudRefused with reason cloud_parsing_disabled before any request, and keeps no copy on disk', async () => {
    stubCloud('false');
    const { processDocument } = await loadProcessor();
    const { CloudRefused } = await import('@/lib/rag');
    const failure = await processDocument(filename, Buffer.from(BODY), { user_id: USER }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CloudRefused);
    expect((failure as Error).message).toContain('cloud_parsing_disabled');
    expect(state.llamaCalls).toBe(0);
    expect(state.storeCalls).toBe(0);
    expect(fs.existsSync(path.join(tempDir, filename))).toBe(false);
  });

  it('cloud off: a Markdown file is still processed locally', async () => {
    stubCloud('false');
    const { processDocument } = await loadProcessor();
    const id = await processDocument('cloud-guard-placeholder.md', Buffer.from('# Title\n\nPlaceholder paragraph.'), { user_id: USER });
    expect(id).toBe('doc-1');
    expect(state.llamaCalls).toBe(0);
    expect(state.storeCalls).toBe(1);
  });

  it('cloud off: the Nango adapter under legacy rejects with the reason, so the sync records the file as failed with it', async () => {
    stubCloud('false');
    vi.stubEnv('RAG_INGEST_PIPELINE', 'legacy');
    await loadProcessor();
    const { processDocumentWithMetadata } = await import('@/lib/nango/document-adapter');
    await expect(
      processDocumentWithMetadata(filename, Buffer.from(BODY), { userId: USER, source: 'nango', sourceProvider: 'google-drive', sourceFileId: 'file-1', mimeType: 'application/pdf' }),
    ).rejects.toThrow('cloud_parsing_disabled');
    expect(state.llamaCalls).toBe(0);
    expect(state.storeCalls).toBe(0);
  });

  it.each([undefined, 'true'])('RAG_PARSER_ALLOW_CLOUD=%s: a PDF is parsed through LlamaParse and stored as before', async (value) => {
    stubCloud(value);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { processDocument } = await loadProcessor();
      const pending = processDocument(filename, Buffer.from(BODY), { user_id: USER });
      await vi.advanceTimersByTimeAsync(10000);
      expect(await pending).toBe('doc-1');
      expect(state.llamaCalls).toBeGreaterThan(0);
      expect(state.storeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
