import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestInput, IngestResult } from '@/lib/rag/ingest';

const USER = '00000000-0000-4000-8000-0000000000b1';
const DOCUMENT = '00000000-0000-4000-8000-0000000000e1';
const BODY = 'First placeholder paragraph.\n\nSecond placeholder paragraph.';

type Row = Record<string, unknown>;

const state = {
  session: null as { id: string } | null,
  inserts: [] as Array<{ table: string; rows: Row[] }>,
  llamaUrls: [] as string[],
};

const ingestSpy = vi.fn<(input: IngestInput) => Promise<IngestResult>>();
const submitSpy = vi.fn<(input: IngestInput) => Promise<IngestResult>>();
const readyResult: IngestResult = { status: 'ready', documentId: DOCUMENT, version: 1, parserUsed: 'text', chunkCount: 2, warnings: [] };

function routeAdmin() {
  return {
    from(table: string) {
      const builder = {
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        maybeSingle: () => {
          if (table === 'admin_settings') return Promise.resolve({ data: { read_only_doc_dashboard: false }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        insert(rows: Row[]) {
          state.inserts.push({ table, rows });
          return builder;
        },
        select: () => builder,
        single: () => Promise.resolve({ data: { id: 'doc' }, error: null }),
        then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok, bad),
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: {}, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'http://127.0.0.1/placeholder' } }),
      }),
    },
  };
}

function guardAdmin() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from() {
      const builder = {
        select: () => builder,
        abortSignal: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return builder;
    },
  };
}

interface Env {
  pipeline?: string;
  languageAware?: string;
  languages?: [supported: string, primary: string] | null;
  approval?: string;
}

function stubEnv(env: Env): void {
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key-placeholder');
  vi.stubEnv('LLAMA_CLOUD_API_KEY', 'test-llama-key-placeholder');
  vi.stubEnv('RAG_INGEST_PIPELINE', env.pipeline ?? 'legacy');
  vi.stubEnv('RAG_LANGUAGE_AWARE_INGEST', env.languageAware ?? '');
  vi.stubEnv('RAG_UPLOAD_APPROVAL', env.approval ?? '');
  const languages = env.languages === undefined ? (['zh,en,it', 'en'] as const) : env.languages;
  vi.stubEnv('RAG_SUPPORTED_LANGUAGES', languages ? languages[0] : '');
  vi.stubEnv('RAG_PRIMARY_LANGUAGE', languages ? languages[1] : '');
}

function mockModules(): void {
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => 'single-tenant',
    isMultiTenant: () => false,
    isSingleTenant: () => true,
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => guardAdmin(),
    getSupabase: () => ({}),
    storeDocument: async () => 'doc',
  }));
  vi.doMock('@/lib/auth/organization-handler', () => ({ verifyUserOrganizationAccess: async () => ({ hasAccess: false }) }));
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => routeAdmin() }));
  vi.doMock('node-fetch', () => ({
    default: async (url: string) => {
      state.llamaUrls.push(String(url));
      const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' });
      if (String(url).endsWith('/parsing/upload')) return json({ id: 'job-1', status: 'PENDING' });
      if (String(url).endsWith('/result/markdown')) {
        return json({ markdown: 'Placeholder document body text.', metadata: { total_pages: 1 }, chunks: ['Placeholder document body text.'] });
      }
      return json({ status: 'SUCCESS' });
    },
  }));
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...original,
      embedText: async () => [0.1, 0.2],
      embedBatch: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
      ingest: (input: IngestInput) => ingestSpy(input),
      submitIngest: (input: IngestInput) => submitSpy(input),
    };
  });
}

async function loadPost(env: Env): Promise<(req: Request) => Promise<Response>> {
  vi.resetModules();
  stubEnv(env);
  mockModules();
  const { POST } = await import('@/app/api/process-document/route');
  return POST;
}

function upload(options: { temporary?: boolean } = {}): Request {
  const form = new FormData();
  form.append('file', new File([BODY], 'notes.txt', { type: 'text/plain' }));
  form.append('isTemporary', String(options.temporary ?? false));
  return new Request('http://localhost/api/process-document', { method: 'POST', body: form });
}

const unifiedCalls = () => ingestSpy.mock.calls.length + submitSpy.mock.calls.length;
const lastUnifiedInput = (): IngestInput => (ingestSpy.mock.calls.at(-1)?.[0] ?? submitSpy.mock.calls.at(-1)?.[0]) as IngestInput;

// Recorded before plan 03.2-24: the legacy writer's LlamaParse calls and table writes for one knowledge-base text upload.
const RECORDED_LEGACY_CALLS = {
  llamaUrls: [
    'https://api.cloud.llamaindex.ai/api/parsing/upload',
    'https://api.cloud.llamaindex.ai/api/parsing/job/job-1',
    'https://api.cloud.llamaindex.ai/api/parsing/job/job-1/result/markdown',
  ],
  tables: ['documents', 'document_chunks'],
  chunk: 'Document: notes.txt. Chunk 1 of 1. Content: Placeholder document body text.',
};

function legacyCalls() {
  return {
    llamaUrls: state.llamaUrls,
    tables: state.inserts.map((entry) => entry.table),
    chunk: String(state.inserts.find((entry) => entry.table === 'document_chunks')?.rows[0]?.content),
  };
}

beforeEach(() => {
  state.session = { id: USER };
  state.inserts = [];
  state.llamaUrls = [];
  ingestSpy.mockReset();
  ingestSpy.mockResolvedValue(readyResult);
  submitSpy.mockReset();
  submitSpy.mockResolvedValue(readyResult);
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

describe('process-document under RAG_INGEST_PIPELINE=legacy: RAG_LANGUAGE_AWARE_INGEST (D-16)', () => {
  it.each(['', 'off'])('switch %j: the knowledge-base upload calls the legacy writer exactly as recorded', async (languageAware) => {
    const POST = await loadPost({ languageAware });
    const response = await POST(upload());
    expect(response.status).toBe(200);
    expect(legacyCalls()).toEqual(RECORDED_LEGACY_CALLS);
    expect(unifiedCalls()).toBe(0);
  });

  it('switch off with the languages unset: the same recorded legacy calls', async () => {
    const POST = await loadPost({ languageAware: 'off', languages: null });
    const response = await POST(upload());
    expect(response.status).toBe(200);
    expect(legacyCalls()).toEqual(RECORDED_LEGACY_CALLS);
    expect(unifiedCalls()).toBe(0);
  });

  it('switch on, languages configured: the upload goes to the unified pipeline and the legacy writer records zero calls', async () => {
    const POST = await loadPost({ languageAware: 'on' });
    const response = await POST(upload());
    expect(response.status).toBe(200);
    expect(unifiedCalls()).toBe(1);
    const input = lastUnifiedInput();
    expect(input).toMatchObject({ source: 'chat_upload', uploaderId: USER, filename: 'notes.txt', mimeType: 'text/plain' });
    expect(state.llamaUrls).toEqual([]);
    expect(state.inserts).toEqual([]);
    expect(await response.json()).toMatchObject({ documentId: DOCUMENT, status: 'ready' });
  });

  it('switch on, languages unset: 503 languages_not_configured and nothing is parsed, ingested or written', async () => {
    const POST = await loadPost({ languageAware: 'on', languages: null });
    const response = await POST(upload());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'languages_not_configured' });
    expect(unifiedCalls()).toBe(0);
    expect(state.llamaUrls).toEqual([]);
    expect(state.inserts).toEqual([]);
  });

  it('switch on: the session check stays first (no session is 401, nothing runs)', async () => {
    state.session = null;
    const POST = await loadPost({ languageAware: 'on' });
    const response = await POST(upload());
    expect(response.status).toBe(401);
    expect(unifiedCalls()).toBe(0);
    expect(state.llamaUrls).toEqual([]);
  });

  it('switch on with upload approval: the plan-15 refusal still answers first', async () => {
    const POST = await loadPost({ languageAware: 'on', approval: 'members' });
    const response = await POST(upload());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'upload_approval_requires_unified_pipeline' });
    expect(unifiedCalls()).toBe(0);
    expect(state.llamaUrls).toEqual([]);
  });

  it.each([
    ['off', ['zh,en,it', 'en']],
    ['on', ['zh,en,it', 'en']],
    ['on', null],
  ] as const)('switch %s, languages %j: a temporary attachment is parsed as today and nothing is written', async (languageAware, languages) => {
    const POST = await loadPost({ languageAware, languages: languages ? [...languages] as [string, string] : null });
    const response = await POST(upload({ temporary: true }));
    expect(response.status).toBe(200);
    expect(state.llamaUrls).toEqual(RECORDED_LEGACY_CALLS.llamaUrls);
    expect(state.inserts).toEqual([]);
    expect(unifiedCalls()).toBe(0);
  });
});

describe('document-processor entry under RAG_LANGUAGE_AWARE_INGEST=on (D-16)', () => {
  async function loadProcessor(env: Env) {
    vi.resetModules();
    stubEnv(env);
    mockModules();
    return import('@/lib/document-processor');
  }

  it('switch off: processDocument runs the legacy writer as today', async () => {
    const { processDocument } = await loadProcessor({ languageAware: 'off' });
    await expect(processDocument('notes.pdf', Buffer.from(BODY), { user_id: USER })).resolves.toBe('doc');
    expect(state.llamaUrls[0]).toBe('https://api.cloud.llamaindex.ai/api/v1/parsing/upload');
  });

  it.each([
    [['zh,en,it', 'en'], 'language_aware_ingest_requires_unified_pipeline'],
    [null, 'languages_not_configured'],
  ] as const)('switch on, languages %j: processDocument refuses with %s before any parse', async (languages, code) => {
    const { processDocument } = await loadProcessor({ languageAware: 'on', languages: languages ? [...languages] as [string, string] : null });
    await expect(processDocument('notes.pdf', Buffer.from(BODY), { user_id: USER })).rejects.toMatchObject({ code, status: 503 });
    await expect(processDocument('notes.md', Buffer.from(BODY), { user_id: USER })).rejects.toMatchObject({ code });
    expect(state.llamaUrls).toEqual([]);
  });

  it('switch on, languages configured: the scraper and Nango switches choose the unified path; off keeps legacy', async () => {
    vi.resetModules();
    stubEnv({ languageAware: 'on' });
    const scrapers = await import('@/lib/scrapers/ingest-switch');
    const nango = await import('@/lib/nango/document-adapter');
    expect(scrapers.scraperPipeline()).toBe('unified');
    expect(nango.nangoPipeline()).toBe('unified');
    vi.stubEnv('RAG_LANGUAGE_AWARE_INGEST', 'off');
    expect(scrapers.scraperPipeline()).toBe('legacy');
    expect(nango.nangoPipeline()).toBe('legacy');
    vi.stubEnv('RAG_LANGUAGE_AWARE_INGEST', 'on');
    vi.stubEnv('RAG_SUPPORTED_LANGUAGES', '');
    vi.stubEnv('RAG_PRIMARY_LANGUAGE', '');
    expect(scrapers.scraperPipeline()).toBe('legacy');
    expect(nango.nangoPipeline()).toBe('legacy');
  });
});
