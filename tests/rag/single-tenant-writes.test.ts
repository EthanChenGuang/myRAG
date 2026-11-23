import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '00000000-0000-4000-8000-0000000000a1';

const state = {
  session: null as { id: string } | null,
  authThrows: false,
  inserts: [] as Array<{ table: string; rows: unknown }>,
  llamaCalls: 0,
  embedCalls: 0,
  scrapeCalls: 0,
  crawlCalls: 0,
  admins: [] as string[],
  readOnly: false,
};

function adminClient() {
  return {
    from(table: string) {
      let filter: unknown;
      const builder = {
        insert(rows: unknown) {
          state.inserts.push({ table, rows });
          return builder;
        },
        select: () => builder,
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
        single: () => Promise.resolve({ data: { id: 'doc' }, error: null }),
        then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(ok, bad),
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

function baseMocks() {
  vi.resetModules();
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => 'single-tenant',
    isMultiTenant: () => false,
    isSingleTenant: () => true,
  }));
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
  vi.doMock('@/lib/auth/organization-handler', () => ({
    verifyUserOrganizationAccess: async () => ({ hasAccess: false }),
  }));
}

async function loadProcessDocument() {
  baseMocks();
  vi.doMock('@/lib/env', () => ({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-placeholder',
      LLAMA_CLOUD_API_KEY: 'test-llama-key-placeholder',
      LLAMACLOUD_CHUNK_SIZE: '768',
      LLAMACLOUD_CHUNK_OVERLAP: '416',
      LLAMACLOUD_CHUNK_STRATEGY: 'sentence',
      LLAMACLOUD_PARSING_MODE: 'balanced',
    },
  }));
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => adminClient() }));
  vi.doMock('@/lib/rag', () => ({
    embedText: async () => {
      state.embedCalls += 1;
      return [0.1, 0.2];
    },
    isAdminUser: async (admin: ReturnType<typeof adminClient>, userId: string) => {
      const { data } = await admin.from('admin_users').eq('id', userId).abortSignal().maybeSingle();
      return Boolean(data);
    },
  }));
  vi.doMock('node-fetch', () => ({
    default: async (url: string) => {
      state.llamaCalls += 1;
      const json = (body: unknown) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => body,
        text: async () => '',
      });
      if (url.endsWith('/parsing/upload')) return json({ id: 'job-1', status: 'PENDING' });
      if (url.endsWith('/result/markdown')) {
        return json({
          markdown: 'Placeholder document body text.',
          metadata: { total_pages: 1 },
          chunks: ['Placeholder document body text.'],
        });
      }
      return json({ status: 'SUCCESS' });
    },
  }));
  return import('@/app/api/process-document/route');
}

async function loadScraper(kind: 'scrape' | 'crawl') {
  baseMocks();
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => adminClient() }));
  vi.doMock('@/lib/rag', () => ({
    isAdminUser: async (admin: ReturnType<typeof adminClient>, userId: string) => {
      const { data } = await admin.from('admin_users').eq('id', userId).abortSignal().maybeSingle();
      return Boolean(data);
    },
  }));
  vi.doMock('@/lib/scrapers/firecrawl-client', () => ({ isFirecrawlEnabled: () => true }));
  vi.doMock('@/lib/scrapers/scraper-adapter', () => ({
    scrapeAndProcess: async () => {
      state.scrapeCalls += 1;
      return { documentId: 'doc-1', url: 'https://example.com/', title: 'Example' };
    },
    crawlAndProcess: async () => {
      state.crawlCalls += 1;
      return { totalPages: 1, successfulPages: 1, failedPages: 0, documents: [], errors: [] };
    },
  }));
  return kind === 'scrape' ? import('@/app/api/scrapers/scrape/route') : import('@/app/api/scrapers/crawl/route');
}

function docRequest(isTemporary: boolean) {
  const form = new FormData();
  form.append('file', new File(['placeholder'], 'notes.txt', { type: 'text/plain' }));
  form.append('isTemporary', String(isTemporary));
  return new Request('http://localhost/api/process-document', { method: 'POST', body: form });
}

function jsonRequest(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('single-tenant permanent writes require a session', () => {
  beforeEach(() => {
    state.session = null;
    state.authThrows = false;
    state.inserts = [];
    state.llamaCalls = 0;
    state.embedCalls = 0;
    state.scrapeCalls = 0;
    state.crawlCalls = 0;
    state.admins = [];
    state.readOnly = false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    for (const id of [
      '@/lib/deployment-mode',
      '@/lib/supabase/server',
      '@/lib/auth/organization-handler',
      '@/lib/env',
      '@supabase/supabase-js',
      '@/lib/rag',
      '@/lib/supabase',
      'node-fetch',
      '@/lib/scrapers/firecrawl-client',
      '@/lib/scrapers/scraper-adapter',
    ]) {
      vi.doUnmock(id);
    }
  });

  it('process-document: no session and isTemporary=false returns 401 with no insert, parse or embed', async () => {
    const { POST } = await loadProcessDocument();
    const res = await POST(docRequest(false));
    expect(res.status).toBe(401);
    expect(state.inserts).toEqual([]);
    expect(state.llamaCalls).toBe(0);
    expect(state.embedCalls).toBe(0);
  });

  it('process-document: a throwing session lookup returns 503 with no insert', async () => {
    state.authThrows = true;
    const { POST } = await loadProcessDocument();
    const res = await POST(docRequest(false));
    expect(res.status).toBe(503);
    expect(state.inserts).toEqual([]);
  });

  it('process-document: a signed-in user stores a permanent document', async () => {
    state.session = { id: USER };
    const { POST } = await loadProcessDocument();
    const res = await POST(docRequest(false));
    expect(res.status).toBe(200);
    expect(state.inserts.map((entry) => entry.table)).toEqual(['documents', 'document_chunks']);
  });

  it('process-document: anonymous temporary processing returns 401 and never reaches the parser', async () => {
    const { POST } = await loadProcessDocument();
    const res = await POST(docRequest(true));
    expect(res.status).toBe(401);
    expect(state.inserts).toEqual([]);
    expect(state.llamaCalls).toBe(0);
    expect(state.embedCalls).toBe(0);
  });

  it('process-document: a throwing session lookup on a temporary request returns 503 and never reaches the parser', async () => {
    state.authThrows = true;
    const { POST } = await loadProcessDocument();
    const res = await POST(docRequest(true));
    expect(res.status).toBe(503);
    expect(state.llamaCalls).toBe(0);
  });

  it('process-document: a signed-in temporary request persists nothing', async () => {
    state.session = { id: USER };
    const { POST } = await loadProcessDocument();
    const res = await POST(docRequest(true));
    expect(res.status).toBe(200);
    expect(state.inserts).toEqual([]);
    expect(state.embedCalls).toBe(0);
  });

  it('scrape: no session returns 401 and the scraper is not called', async () => {
    const { POST } = await loadScraper('scrape');
    const res = await POST(jsonRequest('/api/scrapers/scrape', { url: 'https://example.com/' }));
    expect(res.status).toBe(401);
    expect(state.scrapeCalls).toBe(0);
  });

  it('scrape: a signed-in user succeeds', async () => {
    state.session = { id: USER };
    const { POST } = await loadScraper('scrape');
    const res = await POST(jsonRequest('/api/scrapers/scrape', { url: 'https://example.com/' }));
    expect(res.status).toBe(200);
    expect(state.scrapeCalls).toBe(1);
  });

  it('crawl: no session returns 401 and the crawler is not called', async () => {
    const { POST } = await loadScraper('crawl');
    const res = await POST(jsonRequest('/api/scrapers/crawl', { url: 'https://example.com/' }));
    expect(res.status).toBe(401);
    expect(state.crawlCalls).toBe(0);
  });

  it('crawl: a signed-in user succeeds', async () => {
    state.session = { id: USER };
    const { POST } = await loadScraper('crawl');
    const res = await POST(jsonRequest('/api/scrapers/crawl', { url: 'https://example.com/' }));
    expect(res.status).toBe(200);
    expect(state.crawlCalls).toBe(1);
  });

  it('process-document: the permanent document is stored with the session user as owner', async () => {
    state.session = { id: USER };
    const { POST } = await loadProcessDocument();
    expect((await POST(docRequest(false))).status).toBe(200);
    const document = state.inserts.find((entry) => entry.table === 'documents')?.rows as Array<Record<string, unknown>>;
    expect(document[0]).toMatchObject({ user_id: USER });
  });

  describe('read_only_doc_dashboard', () => {
    beforeEach(() => {
      state.readOnly = true;
    });

    it('process-document: a non-admin gets 403 for a permanent upload before any parse, insert or embed', async () => {
      state.session = { id: USER };
      const { POST } = await loadProcessDocument();
      const res = await POST(docRequest(false));
      expect(res.status).toBe(403);
      expect(state.inserts).toEqual([]);
      expect(state.llamaCalls).toBe(0);
      expect(state.embedCalls).toBe(0);
    });

    it('process-document: temporary processing persists nothing, so it stays allowed', async () => {
      state.session = { id: USER };
      const { POST } = await loadProcessDocument();
      expect((await POST(docRequest(true))).status).toBe(200);
    });

    it('process-document: an admin can still upload', async () => {
      state.session = { id: USER };
      state.admins = [USER];
      const { POST } = await loadProcessDocument();
      expect((await POST(docRequest(false))).status).toBe(200);
      expect(state.inserts.map((entry) => entry.table)).toEqual(['documents', 'document_chunks']);
    });

    it('scrape and crawl: a non-admin gets 403 and the scraper is not called, an admin succeeds', async () => {
      state.session = { id: USER };
      const scrape = await loadScraper('scrape');
      expect((await scrape.POST(jsonRequest('/api/scrapers/scrape', { url: 'https://example.com/' }))).status).toBe(403);
      const crawl = await loadScraper('crawl');
      expect((await crawl.POST(jsonRequest('/api/scrapers/crawl', { url: 'https://example.com/' }))).status).toBe(403);
      expect(state.scrapeCalls).toBe(0);
      expect(state.crawlCalls).toBe(0);
      state.admins = [USER];
      const adminScrape = await loadScraper('scrape');
      expect((await adminScrape.POST(jsonRequest('/api/scrapers/scrape', { url: 'https://example.com/' }))).status).toBe(200);
    });
  });
});
