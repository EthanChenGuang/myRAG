import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as scopeModule from '@/lib/rag/tenant/scope';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { IngestInput, IngestResult } from '@/lib/rag';

const USER = '00000000-0000-4000-8000-0000000000a1';
const PAGE_URL = 'https://example.com/guide';
const SINGLE = mintScope('single', null, null);

const state = {
  pipeline: 'legacy' as 'legacy' | 'unified',
  configThrows: false,
  scrapeResults: [] as Array<Record<string, unknown>>,
  crawlPages: [] as Array<Record<string, unknown>>,
  ingestResults: [] as IngestResult[],
};

const scrapeUrl = vi.fn();
const crawlWebsite = vi.fn();
const processDocument = vi.fn();
const ingest = vi.fn();

function ready(documentId: string, version = 1): IngestResult {
  return { status: 'ready', documentId, version, parserUsed: 'text', chunkCount: 2, warnings: [] };
}

async function loadAdapter() {
  vi.resetModules();
  const identity = await vi.importActual<typeof import('@/lib/rag/ingest/identity')>('@/lib/rag/ingest/identity');
  vi.doMock('@/lib/scrapers/firecrawl-client', () => ({ scrapeUrl, crawlWebsite }));
  vi.doMock('@/lib/document-processor', () => ({ processDocument }));
  vi.doMock('@/lib/rag', () => ({
    ingest,
    buildSourceKey: identity.buildSourceKey,
    currentIngestConfig: () => {
      if (state.configThrows) throw new Error('config unavailable');
      return { pipeline: state.pipeline };
    },
  }));
  return import('@/lib/scrapers/scraper-adapter');
}

async function loadSwitch() {
  vi.resetModules();
  vi.doMock('@/lib/rag', () => ({
    currentIngestConfig: () => {
      if (state.configThrows) throw new Error('config unavailable');
      return { pipeline: state.pipeline };
    },
  }));
  return import('@/lib/scrapers/ingest-switch');
}

beforeEach(() => {
  state.pipeline = 'legacy';
  state.configThrows = false;
  state.ingestResults = [];
  scrapeUrl.mockReset();
  crawlWebsite.mockReset();
  processDocument.mockReset();
  ingest.mockReset();
  ingest.mockImplementation(async () => state.ingestResults.shift() ?? ready('doc-default'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@/lib/scrapers/firecrawl-client');
  vi.doUnmock('@/lib/document-processor');
  vi.doUnmock('@/lib/rag');
});

function ingestInput(call = 0): IngestInput {
  return ingest.mock.calls[call][0] as IngestInput;
}

describe('scraper pipeline switch', () => {
  it('reports unified when the ingest configuration says so', async () => {
    state.pipeline = 'unified';
    const { scraperPipeline } = await loadSwitch();
    expect(scraperPipeline()).toBe('unified');
  });

  it('reports legacy by default', async () => {
    const { scraperPipeline } = await loadSwitch();
    expect(scraperPipeline()).toBe('legacy');
  });

  it('falls back to legacy when the configuration cannot be read', async () => {
    state.pipeline = 'unified';
    state.configThrows = true;
    const { scraperPipeline } = await loadSwitch();
    expect(scraperPipeline()).toBe('legacy');
  });
});

describe('scraper adapter, legacy pipeline', () => {
  it('scrapeAndProcess scrapes HTML with no options and sends it through processDocument with source scrape', async () => {
    scrapeUrl.mockResolvedValue({ html: '<h1>Guide</h1>', metadata: { title: 'Example Guide' } });
    processDocument.mockResolvedValue('doc-1');
    const { scrapeAndProcess } = await loadAdapter();

    const result = await scrapeAndProcess({ url: `${PAGE_URL}/`, userId: USER, organizationId: null });

    expect(scrapeUrl.mock.calls).toEqual([[PAGE_URL]]);
    expect(processDocument).toHaveBeenCalledTimes(1);
    const [filename, buffer, metadata] = processDocument.mock.calls[0];
    expect(filename).toBe('Example-Guide.html');
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect((buffer as Buffer).toString('utf-8')).toBe('<h1>Guide</h1>');
    expect(metadata).toEqual({
      user_id: USER,
      organization_id: null,
      source: 'scrape',
      source_provider: 'firecrawl',
      source_file_id: PAGE_URL,
      source_connection_id: `firecrawl-${USER}`,
      external_url: PAGE_URL,
      scraped_url: PAGE_URL,
      title: 'Example Guide',
    });
    expect(ingest).not.toHaveBeenCalled();
    expect(result).toEqual({ documentId: 'doc-1', url: PAGE_URL, title: 'Example Guide' });
  });

  it('crawlAndProcess crawls with maxPages only and sends every page through processDocument with source scrape', async () => {
    crawlWebsite.mockResolvedValue([
      { url: 'https://example.com/a', html: '<p>a</p>', metadata: { title: 'A' } },
      { url: 'https://example.com/b', html: '<p>b</p>', metadata: {} },
    ]);
    processDocument.mockResolvedValueOnce('doc-a').mockResolvedValueOnce('doc-b');
    const { crawlAndProcess } = await loadAdapter();

    const result = await crawlAndProcess({ url: 'https://example.com/', userId: USER, organizationId: 'org-1', maxPages: 5 });

    expect(crawlWebsite.mock.calls).toEqual([['https://example.com/', { maxPages: 5 }]]);
    expect(processDocument.mock.calls.map((call) => call[0])).toEqual(['A.html', 'example-com_b.html']);
    expect(processDocument.mock.calls.every((call) => call[2].source === 'scrape' && call[2].organization_id === 'org-1')).toBe(true);
    expect(ingest).not.toHaveBeenCalled();
    expect(result.documents).toEqual([
      { documentId: 'doc-a', url: 'https://example.com/a', title: 'A' },
      { documentId: 'doc-b', url: 'https://example.com/b', title: undefined },
    ]);
  });

  it('stays on the legacy path when a scope is passed but the switch is legacy', async () => {
    scrapeUrl.mockResolvedValue({ html: '<p>x</p>', metadata: {} });
    processDocument.mockResolvedValue('doc-1');
    const { scrapeAndProcess } = await loadAdapter();

    await scrapeAndProcess({ url: PAGE_URL, userId: USER, organizationId: null, scope: SINGLE, signal: new AbortController().signal });

    expect(processDocument).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('scraper adapter, unified pipeline', () => {
  beforeEach(() => {
    state.pipeline = 'unified';
  });

  it('scrapeAndProcess asks Firecrawl for Markdown and calls ingest with the scraper identity and provider metadata', async () => {
    scrapeUrl.mockResolvedValue({ markdown: '# Guide\n\nBody text.', metadata: { title: 'Example Guide' } });
    state.ingestResults = [ready('doc-9', 3)];
    const signal = new AbortController().signal;
    const { scrapeAndProcess } = await loadAdapter();

    const result = await scrapeAndProcess({ url: `${PAGE_URL}/#top`, scope: SINGLE, signal });

    expect(scrapeUrl.mock.calls).toEqual([[PAGE_URL, { output: 'markdown' }]]);
    expect(processDocument).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledTimes(1);
    const input = ingestInput();
    expect(input).toMatchObject({
      scope: SINGLE,
      source: 'scraper',
      sourceKey: PAGE_URL,
      text: '# Guide\n\nBody text.',
      filename: 'Example-Guide.md',
      mimeType: 'text/markdown',
      options: {
        origin: {
          sourceProvider: 'firecrawl',
          sourceFileId: PAGE_URL,
          metadata: { external_url: PAGE_URL, scraped_url: PAGE_URL, title: 'Example Guide' },
        },
      },
    });
    expect(input.signal).toBe(signal);
    expect(result).toEqual({ documentId: 'doc-9', url: PAGE_URL, title: 'Example Guide', status: 'ready', version: 3 });
  });

  it('scrapeAndProcess names an untitled page after its URL and refuses a page without Markdown', async () => {
    scrapeUrl.mockResolvedValueOnce({ markdown: 'Body', metadata: {} });
    const { scrapeAndProcess } = await loadAdapter();
    await scrapeAndProcess({ url: PAGE_URL, scope: SINGLE, signal: new AbortController().signal });
    expect(ingestInput().filename).toBe('example-com_guide.md');

    scrapeUrl.mockResolvedValueOnce({ html: '<p>only html</p>', metadata: {} });
    await expect(scrapeAndProcess({ url: PAGE_URL, scope: SINGLE, signal: new AbortController().signal })).rejects.toThrow(/Markdown/);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('scrapeAndProcess throws with the stable reason when ingest fails and reports a duplicate as the existing document', async () => {
    scrapeUrl.mockResolvedValue({ markdown: 'Body', metadata: { title: 'T' } });
    state.ingestResults = [
      { status: 'failed', documentId: null, version: null, parserUsed: null, chunkCount: 0, warnings: [], reason: 'embed_failed' },
      { status: 'skipped_duplicate', documentId: null, version: null, parserUsed: null, chunkCount: 0, warnings: [], duplicateOf: 'doc-existing' },
    ];
    const { scrapeAndProcess } = await loadAdapter();
    const signal = new AbortController().signal;

    await expect(scrapeAndProcess({ url: PAGE_URL, scope: SINGLE, signal })).rejects.toThrow(/embed_failed/);
    const again = await scrapeAndProcess({ url: PAGE_URL, scope: SINGLE, signal });
    expect(again).toEqual({ documentId: 'doc-existing', url: PAGE_URL, title: 'T', status: 'skipped_duplicate', version: null });
  });

  it('refuses to run without a tenant scope and fetches nothing', async () => {
    const { scrapeAndProcess, crawlAndProcess } = await loadAdapter();

    await expect(scrapeAndProcess({ url: PAGE_URL, userId: USER, organizationId: null })).rejects.toThrow(/scope/);
    await expect(crawlAndProcess({ url: PAGE_URL, userId: USER, organizationId: null })).rejects.toThrow(/scope/);

    expect(scrapeUrl).not.toHaveBeenCalled();
    expect(crawlWebsite).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
    expect(processDocument).not.toHaveBeenCalled();
  });

  it('crawlAndProcess ingests each page once, reports processing pages, and lists failures', async () => {
    crawlWebsite.mockResolvedValue([
      { url: 'https://example.com/a', markdown: '# A', metadata: { title: 'A' } },
      { url: 'https://example.com/b/', markdown: '# B', metadata: { title: 'B' } },
      { url: 'https://example.com/c', html: '<p>no markdown</p>', metadata: { title: 'C' } },
    ]);
    state.ingestResults = [
      ready('doc-a'),
      { status: 'processing', documentId: 'doc-b', version: 2, parserUsed: null, chunkCount: 0, warnings: [], reason: 'deadline' },
    ];
    const scope = mintScope('personal', USER, null);
    const { crawlAndProcess } = await loadAdapter();

    const result = await crawlAndProcess({ url: 'https://example.com/', scope, signal: new AbortController().signal, maxPages: 3 });

    expect(crawlWebsite.mock.calls).toEqual([['https://example.com/', { maxPages: 3, output: 'markdown' }]]);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest.mock.calls.map((call) => (call[0] as IngestInput).sourceKey)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(ingest.mock.calls.every((call) => (call[0] as IngestInput).scope === scope)).toBe(true);
    expect(processDocument).not.toHaveBeenCalled();
    expect(result.totalPages).toBe(3);
    expect(result.successfulPages).toBe(2);
    expect(result.failedPages).toBe(1);
    expect(result.documents).toEqual([
      { documentId: 'doc-a', url: 'https://example.com/a', title: 'A', status: 'ready', version: 1 },
      { documentId: 'doc-b', url: 'https://example.com/b/', title: 'B', status: 'processing', version: 2 },
    ]);
    expect(result.errors).toEqual([{ url: 'https://example.com/c', error: expect.stringMatching(/Markdown/) }]);
  });

  it('the pdf output format sends the PDF bytes to ingest as application/pdf', async () => {
    const pdf = Buffer.from('%PDF-1.7\nplaceholder body\n%%EOF');
    scrapeUrl.mockResolvedValue({ markdown: 'ignored', metadata: { title: 'Annual Report' }, actions: { pdfs: [pdf.toString('base64')] } });
    const { scrapeAndProcess } = await loadAdapter();

    await scrapeAndProcess({ url: PAGE_URL, scope: SINGLE, signal: new AbortController().signal, outputFormat: 'pdf' });

    expect(scrapeUrl.mock.calls).toEqual([[PAGE_URL, { output: 'pdf' }]]);
    const input = ingestInput();
    expect(input.mimeType).toBe('application/pdf');
    expect(input.filename).toBe('Annual-Report.pdf');
    expect(input.text).toBeUndefined();
    expect(Buffer.from(input.file as Uint8Array).toString('utf-8')).toBe(pdf.toString('utf-8'));
  });

  it('the pdf output format refuses a link or non-PDF content instead of fetching it', async () => {
    scrapeUrl.mockResolvedValueOnce({ metadata: {}, actions: { pdfs: ['https://files.example.net/page.pdf'] } });
    scrapeUrl.mockResolvedValueOnce({ metadata: {}, actions: { pdfs: [Buffer.from('not a pdf').toString('base64')] } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { scrapeAndProcess } = await loadAdapter();
    const signal = new AbortController().signal;

    await expect(scrapeAndProcess({ url: PAGE_URL, scope: SINGLE, signal, outputFormat: 'pdf' })).rejects.toThrow(/inline PDF/);
    await expect(scrapeAndProcess({ url: PAGE_URL, scope: SINGLE, signal, outputFormat: 'pdf' })).rejects.toThrow(/inline PDF/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Scrape and crawl routes: session first, then scope resolution under the unified pipeline
// ---------------------------------------------------------------------------------------------

const ORG = '00000000-0000-4000-8000-0000000000c1';
const OTHER_USER = '00000000-0000-4000-8000-0000000000b1';

const routeState = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  pipeline: 'legacy' as 'legacy' | 'unified',
  session: null as { id: string } | null,
  authThrows: false,
  authError: null as { name: string } | null,
  getUserCalls: 0,
  adminMissing: false,
  settingsThrows: false,
  admins: [] as string[],
  members: [] as Array<{ organization_id: string; user_id: string }>,
  readOnly: false,
  adapterCalls: [] as Array<{ kind: 'scrape' | 'crawl'; args: Record<string, unknown> }>,
};

function routeAdmin() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return query;
        },
        order: () => query,
        limit: () => query,
        abortSignal: () => query,
        maybeSingle() {
          if (table === 'organization_members') {
            const row = routeState.members.find(
              (member) => member.organization_id === filters.organization_id && member.user_id === filters.user_id,
            );
            return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
          }
          if (table === 'admin_users') {
            const isAdmin = routeState.admins.includes(filters.id as string);
            return Promise.resolve({ data: isAdmin ? { id: filters.id } : null, error: null });
          }
          if (table === 'admin_settings') {
            if (routeState.settingsThrows) return Promise.reject(new Error('settings down'));
            return Promise.resolve({ data: { read_only_doc_dashboard: routeState.readOnly }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return query;
    },
  };
}

async function loadRoute(kind: 'scrape' | 'crawl') {
  vi.resetModules();
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => routeState.mode,
    isMultiTenant: () => routeState.mode === 'multi-tenant',
    isSingleTenant: () => routeState.mode === 'single-tenant',
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          routeState.getUserCalls += 1;
          if (routeState.authThrows) throw new Error('auth down');
          return { data: { user: routeState.session }, error: routeState.authError };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => (routeState.adminMissing ? null : routeAdmin()),
    supabaseAdmin: routeAdmin(),
  }));
  vi.doMock('@/lib/auth/organization-handler', () => ({
    verifyUserOrganizationAccess: async (userId: string, organizationId: string) => ({
      hasAccess: routeState.members.some((member) => member.user_id === userId && member.organization_id === organizationId),
    }),
  }));
  vi.doMock('@/lib/scrapers/firecrawl-client', () => ({ isFirecrawlEnabled: () => true }));
  vi.doMock('@/lib/scrapers/scraper-adapter', () => ({
    scrapeAndProcess: async (args: Record<string, unknown>) => {
      routeState.adapterCalls.push({ kind: 'scrape', args });
      return 'scope' in args
        ? { documentId: 'doc-1', url: PAGE_URL, title: 'Example', status: 'ready', version: 2 }
        : { documentId: 'doc-1', url: PAGE_URL, title: 'Example' };
    },
    crawlAndProcess: async (args: Record<string, unknown>) => {
      routeState.adapterCalls.push({ kind: 'crawl', args });
      return {
        totalPages: 1,
        successfulPages: 1,
        failedPages: 0,
        documents: [{ documentId: 'doc-1', url: PAGE_URL, title: 'Example', ...('scope' in args ? { status: 'ready', version: 2 } : {}) }],
        errors: [],
      };
    },
  }));
  const { setRagDepsForTests } = await import('@/lib/rag/deps');
  setRagDepsForTests({ adminClient: () => routeAdmin() as never });
  const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  setIngestDepsForTests({ ingestEnv: () => ({ RAG_INGEST_PIPELINE: routeState.pipeline }) });
  return kind === 'scrape' ? import('@/app/api/scrapers/scrape/route') : import('@/app/api/scrapers/crawl/route');
}

async function post(kind: 'scrape' | 'crawl', body: Record<string, unknown> = {}) {
  const { POST } = await loadRoute(kind);
  const { NextRequest } = await import('next/server');
  const request = new NextRequest(`http://localhost/api/scrapers/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: PAGE_URL, ...body }),
  });
  return POST(request);
}

describe.each(['scrape', 'crawl'] as const)('%s route', (kind) => {
  beforeEach(() => {
    routeState.mode = 'single-tenant';
    routeState.pipeline = 'legacy';
    routeState.session = null;
    routeState.authThrows = false;
    routeState.authError = null;
    routeState.getUserCalls = 0;
    routeState.adminMissing = false;
    routeState.settingsThrows = false;
    routeState.admins = [];
    routeState.members = [];
    routeState.readOnly = false;
    routeState.adapterCalls = [];
  });

  afterEach(async () => {
    const { resetIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
    const { resetRagDepsForTests } = await import('@/lib/rag/deps');
    resetIngestDepsForTests();
    resetRagDepsForTests();
    for (const id of [
      '@/lib/deployment-mode',
      '@/lib/supabase/server',
      '@/lib/supabase',
      '@/lib/auth/organization-handler',
      '@/lib/scrapers/firecrawl-client',
      '@/lib/scrapers/scraper-adapter',
    ]) {
      vi.doUnmock(id);
    }
  });

  describe.each([
    ['single-tenant', 'legacy'],
    ['single-tenant', 'unified'],
    ['multi-tenant', 'legacy'],
    ['multi-tenant', 'unified'],
  ] as const)('%s, %s pipeline', (mode, pipeline) => {
    beforeEach(() => {
      routeState.mode = mode;
      routeState.pipeline = pipeline;
    });

    it('answers 401 Authentication required without a session and reaches nothing', async () => {
      const response = await post(kind);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Authentication required' });
      expect(routeState.adapterCalls).toEqual([]);
    });

    it('answers 503 when the session lookup throws and reaches nothing', async () => {
      routeState.authThrows = true;
      const response = await post(kind);
      expect(response.status).toBe(503);
      expect(routeState.adapterCalls).toEqual([]);
    });

    it('answers 503, not 401, when the session service is only temporarily unreachable', async () => {
      routeState.authError = { name: 'AuthRetryableFetchError' };
      const response = await post(kind);
      expect(response.status).toBe(503);
      expect(routeState.adapterCalls).toEqual([]);
    });
  });

  describe.each(['legacy', 'unified'] as const)('single-tenant writes, %s pipeline', (pipeline) => {
    beforeEach(() => {
      routeState.mode = 'single-tenant';
      routeState.pipeline = pipeline;
      routeState.session = { id: USER };
    });

    it('refuses a non-admin with 403 while read_only_doc_dashboard is on and reaches nothing', async () => {
      routeState.readOnly = true;
      const response = await post(kind);
      expect(response.status).toBe(403);
      expect(routeState.adapterCalls).toEqual([]);
    });

    it('lets an admin write while read_only_doc_dashboard is on', async () => {
      routeState.readOnly = true;
      routeState.admins = [USER];
      const response = await post(kind);
      expect(response.status).toBe(200);
      expect(routeState.adapterCalls).toHaveLength(1);
    });

    it('answers 503 when the authorization lookup fails and reaches nothing', async () => {
      routeState.settingsThrows = true;
      const response = await post(kind);
      expect(response.status).toBe(503);
      expect(routeState.adapterCalls).toEqual([]);
    });

    it('answers 500 when the database client is missing and reaches nothing', async () => {
      routeState.adminMissing = true;
      const response = await post(kind);
      expect(response.status).toBe(500);
      expect(routeState.adapterCalls).toEqual([]);
    });
  });

  describe('legacy pipeline', () => {
    it('single-tenant: passes the session user and no scope, as before', async () => {
      routeState.session = { id: USER };
      const response = await post(kind);
      expect(response.status).toBe(200);
      expect(routeState.adapterCalls).toHaveLength(1);
      const args = routeState.adapterCalls[0].args;
      expect(args).toMatchObject({ url: PAGE_URL, userId: USER, organizationId: null, outputFormat: 'html' });
      expect('scope' in args).toBe(false);
      expect(Object.keys(await response.json())).not.toContain('version');
    });

    it('multi-tenant: a member organization is passed as before and a non-member gets 403', async () => {
      routeState.mode = 'multi-tenant';
      routeState.session = { id: USER };
      routeState.members = [{ organization_id: ORG, user_id: USER }];
      const member = await post(kind, { organizationId: ORG });
      expect(member.status).toBe(200);
      expect(routeState.adapterCalls[0].args).toMatchObject({ userId: USER, organizationId: ORG });

      routeState.adapterCalls = [];
      routeState.members = [];
      const outsider = await post(kind, { organizationId: ORG });
      expect(outsider.status).toBe(403);
      expect(routeState.adapterCalls).toEqual([]);
    });
  });

  describe('unified pipeline', () => {
    beforeEach(() => {
      routeState.pipeline = 'unified';
      routeState.session = { id: USER };
    });

    it('single-tenant: passes the s:default scope and the request signal, with no user id', async () => {
      const response = await post(kind);
      expect(response.status).toBe(200);
      expect(routeState.adapterCalls).toHaveLength(1);
      const args = routeState.adapterCalls[0].args;
      expect(scopeKeyOf(args.scope)).toBe('s:default');
      expect(args.signal).toBeInstanceOf(AbortSignal);
      expect(args.userId).toBeUndefined();
    });

    it('multi-tenant: a member of organization O gets the o:<O> scope even when the legacy check would refuse', async () => {
      routeState.mode = 'multi-tenant';
      routeState.members = [{ organization_id: ORG, user_id: USER }];
      const response = await post(kind, { organizationId: ORG });
      expect(response.status).toBe(200);
      expect(scopeKeyOf(routeState.adapterCalls[0].args.scope)).toBe(`o:${ORG}`);
    });

    it('multi-tenant: no organization gives the personal u:<session user> scope', async () => {
      routeState.mode = 'multi-tenant';
      const response = await post(kind);
      expect(response.status).toBe(200);
      expect(scopeKeyOf(routeState.adapterCalls[0].args.scope)).toBe(`u:${USER}`);
    });

    it('multi-tenant: a non-member gets 403 and nothing is scraped', async () => {
      routeState.mode = 'multi-tenant';
      routeState.members = [{ organization_id: ORG, user_id: OTHER_USER }];
      const response = await post(kind, { organizationId: ORG });
      expect(response.status).toBe(403);
      expect(routeState.adapterCalls).toEqual([]);
    });

    it('multi-tenant: an organization id that is not a UUID gets 403 and nothing is scraped', async () => {
      routeState.mode = 'multi-tenant';
      const response = await post(kind, { organizationId: 'not-an-organization' });
      expect(response.status).toBe(403);
      expect(routeState.adapterCalls).toEqual([]);
    });

    it('looks the session up once', async () => {
      routeState.mode = 'multi-tenant';
      routeState.members = [{ organization_id: ORG, user_id: USER }];
      await post(kind, { organizationId: ORG });
      expect(routeState.getUserCalls).toBe(1);
    });

    it('returns the same JSON as today plus status and version', async () => {
      const body = await (await post(kind)).json();
      if (kind === 'scrape') {
        expect(body).toMatchObject({ success: true, documentId: 'doc-1', url: PAGE_URL, title: 'Example', status: 'ready', version: 2 });
      } else {
        expect(body).toMatchObject({ success: true, totalPages: 1, successfulPages: 1, failedPages: 0 });
        expect(body.documents).toEqual([{ documentId: 'doc-1', url: PAGE_URL, title: 'Example', status: 'ready', version: 2 }]);
      }
    });
  });
});

function scopeKeyOf(scope: unknown): string {
  if (scope === undefined) return '(no scope)';
  const { scopeKey } = scopeModule;
  return scopeKey(scope as Parameters<typeof scopeKey>[0]);
}
