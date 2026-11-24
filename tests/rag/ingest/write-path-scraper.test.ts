import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
