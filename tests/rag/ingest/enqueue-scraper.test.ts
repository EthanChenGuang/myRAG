import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { EnqueueResult, IngestInput, IngestResult } from '@/lib/rag';
import { createPgliteAdmin } from '../../helpers/pglite-admin';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

const SINGLE = mintScope('single', null, null);
const PAGE_A = 'https://example.com/a';
const PAGE_B = 'https://example.com/b';
const PAGE_C = 'https://example.com/c';
const ROOT = 'https://example.com/';

const state = {
  pipeline: 'unified' as 'legacy' | 'unified',
  asyncOn: false,
  configThrows: false,
  ingestResults: [] as IngestResult[],
};

const scrapeUrl = vi.fn();
const crawlWebsite = vi.fn();
const processDocument = vi.fn();
const ingest = vi.fn();
const submitIngest = vi.fn();
const scheduleIngestWake = vi.fn();

function ingestResult(partial: Partial<IngestResult> & Pick<IngestResult, 'status'>): IngestResult {
  return { documentId: null, version: null, parserUsed: 'text', chunkCount: 0, warnings: [], ...partial };
}

function enqueueResult(partial: Partial<EnqueueResult> & Pick<EnqueueResult, 'status'>): EnqueueResult {
  return { jobId: null, documentId: null, ...partial };
}

async function loadAdapter() {
  vi.resetModules();
  const identity = await vi.importActual<typeof import('@/lib/rag/ingest/identity')>('@/lib/rag/ingest/identity');
  vi.doMock('@/lib/scrapers/firecrawl-client', () => ({ scrapeUrl, crawlWebsite }));
  vi.doMock('@/lib/document-processor', () => ({ processDocument }));
  vi.stubEnv('RAG_INGEST_PIPELINE', state.pipeline);
  vi.stubEnv('RAG_INGEST_ASYNC', state.asyncOn ? 'on' : 'off');
  vi.doMock('@/lib/rag', () => ({
    ingest,
    submitIngest,
    scheduleIngestWake,
    buildSourceKey: identity.buildSourceKey,
    currentIngestConfig: () => {
      if (state.configThrows) throw new Error('config unavailable');
      return { pipeline: state.pipeline };
    },
  }));
  return import('@/lib/scrapers/scraper-adapter');
}

function ingestInput(call = 0): IngestInput {
  return ingest.mock.calls[call][0] as IngestInput;
}

function submitInput(call = 0): IngestInput {
  return submitIngest.mock.calls[call][0] as IngestInput;
}

beforeEach(() => {
  state.pipeline = 'unified';
  state.asyncOn = false;
  state.configThrows = false;
  state.ingestResults = [];
  scrapeUrl.mockReset();
  crawlWebsite.mockReset();
  processDocument.mockReset();
  ingest.mockReset();
  submitIngest.mockReset();
  scheduleIngestWake.mockReset();
  ingest.mockImplementation(async () => state.ingestResults.shift() ?? ingestResult({ status: 'ready', documentId: 'doc-default', version: 1 }));
  submitIngest.mockImplementation(
    async () => enqueueResult({ status: 'queued', jobId: 'job-default', documentId: 'doc-queued' }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.doUnmock('@/lib/scrapers/firecrawl-client');
  vi.doUnmock('@/lib/document-processor');
  vi.doUnmock('@/lib/rag');
});

describe('scraper adapter, unified async switch', () => {
  beforeEach(() => {
    state.asyncOn = true;
  });

  it('with async on, scrape enqueues through submitIngest with the page URL as source_key', async () => {
    scrapeUrl.mockResolvedValue({ markdown: '# Guide\n\nBody.', metadata: { title: 'Guide' } });
    submitIngest.mockResolvedValue(enqueueResult({ status: 'queued', jobId: 'job-s1', documentId: 'doc-v1' }));
    const signal = new AbortController().signal;
    const { scrapeAndProcess } = await loadAdapter();

    const result = await scrapeAndProcess({ url: PAGE_A, scope: SINGLE, signal });

    expect(result).toMatchObject({
      documentId: 'doc-v1',
      url: PAGE_A,
      status: 'queued',
      jobId: 'job-s1',
    });
    expect(submitIngest).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
    expect(submitInput()).toMatchObject({
      scope: SINGLE,
      source: 'scraper',
      sourceKey: PAGE_A,
      mimeType: 'text/markdown',
    });
    expect(scheduleIngestWake).toHaveBeenCalledTimes(1);
  });

  it('with async off, calls ingest and never submitIngest', async () => {
    state.asyncOn = false;
    scrapeUrl.mockResolvedValue({ markdown: 'Body', metadata: {} });
    state.ingestResults = [ingestResult({ status: 'ready', documentId: 'doc-inline', version: 1 })];
    const { scrapeAndProcess } = await loadAdapter();

    const result = await scrapeAndProcess({ url: PAGE_A, scope: SINGLE, signal: new AbortController().signal });

    expect(result.documentId).toBe('doc-inline');
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(submitIngest).not.toHaveBeenCalled();
    expect(scheduleIngestWake).not.toHaveBeenCalled();
    expect(ingestInput()).toMatchObject({ source: 'scraper', sourceKey: PAGE_A });
  });

  it('a 3-page crawl submits 3 jobs and schedules one wake for the batch', async () => {
    crawlWebsite.mockResolvedValue([
      { url: PAGE_A, markdown: '# A', metadata: { title: 'A' } },
      { url: PAGE_B, markdown: '# B', metadata: { title: 'B' } },
      { url: PAGE_C, markdown: '# C', metadata: { title: 'C' } },
    ]);
    submitIngest
      .mockResolvedValueOnce(enqueueResult({ status: 'queued', jobId: 'job-a', documentId: 'doc-a' }))
      .mockResolvedValueOnce(enqueueResult({ status: 'queued', jobId: 'job-b', documentId: 'doc-b' }))
      .mockResolvedValueOnce(enqueueResult({ status: 'queued', jobId: 'job-c', documentId: 'doc-c' }));

    const { crawlAndProcess } = await loadAdapter();
    const result = await crawlAndProcess({ url: ROOT, scope: SINGLE, signal: new AbortController().signal, maxPages: 3 });

    expect(submitIngest).toHaveBeenCalledTimes(3);
    expect(ingest).not.toHaveBeenCalled();
    expect(scheduleIngestWake).toHaveBeenCalledTimes(1);
    expect(result.jobIds).toEqual(['job-a', 'job-b', 'job-c']);
    expect(result.documents.map((row) => row.jobId)).toEqual(['job-a', 'job-b', 'job-c']);
    expect(submitIngest.mock.calls.map((call) => (call[0] as IngestInput).sourceKey)).toEqual([PAGE_A, PAGE_B, PAGE_C]);
  });

  it('with async on, skipped_duplicate returns the existing document id and does not wake', async () => {
    scrapeUrl.mockResolvedValue({ markdown: 'Body', metadata: { title: 'T' } });
    submitIngest.mockResolvedValue(
      enqueueResult({ status: 'skipped_duplicate', jobId: 'job-dup', documentId: 'doc-existing' }),
    );
    const { scrapeAndProcess } = await loadAdapter();

    const result = await scrapeAndProcess({ url: PAGE_A, scope: SINGLE, signal: new AbortController().signal });

    expect(result).toMatchObject({
      documentId: 'doc-existing',
      status: 'skipped_duplicate',
      jobId: 'job-dup',
    });
    expect(scheduleIngestWake).not.toHaveBeenCalled();
  });

  it('with async on, a failed enqueue throws with the stable reason', async () => {
    scrapeUrl.mockResolvedValue({ markdown: 'Body', metadata: {} });
    submitIngest.mockResolvedValue(enqueueResult({ status: 'failed', documentId: null, reason: 'enqueue_failed' }));
    const { scrapeAndProcess } = await loadAdapter();

    await expect(scrapeAndProcess({ url: PAGE_A, scope: SINGLE, signal: new AbortController().signal })).rejects.toThrow(
      /enqueue_failed/,
    );
    expect(scheduleIngestWake).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Re-scrape identity under the queue with real submitIngest.
// ---------------------------------------------------------------------------------------------------------------------

const USER = '00000000-0000-4000-8000-0000000000a1';

let fixture: RouteFixture;
let db: PGlite;
let submitSpy: ReturnType<typeof vi.spyOn>;

async function documentRows() {
  const rows = await db.query<{ id: string; source_key: string; version: number; is_current: boolean; status: string }>(
    `SELECT id::text, source_key, version, is_current, status FROM documents WHERE source = 'scraper' ORDER BY version`,
  );
  return rows.rows;
}

async function jobRows() {
  const rows = await db.query<{ id: string; source_key: string; status: string }>(
    `SELECT id::text, source_key, status FROM ingestion_jobs WHERE source = 'scraper' ORDER BY created_at`,
  );
  return rows.rows;
}

describe('scraper re-scrape identity under async queue', () => {
  beforeAll(async () => {
    fixture = await startRouteFixture({
      deploymentMode: 'single-tenant',
      seed: async (database) => {
        db = database;
      },
    });
    process.env.RAG_INGEST_PIPELINE = 'unified';
    process.env.RAG_INGEST_ASYNC = 'on';
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(async () => {
    vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
    vi.stubEnv('RAG_INGEST_ASYNC', 'on');
    process.env.RAG_INGEST_PIPELINE = 'unified';
    process.env.RAG_INGEST_ASYNC = 'on';

    scrapeUrl.mockReset();
    crawlWebsite.mockReset();
    scrapeUrl.mockResolvedValue({ markdown: 'First edition.\n\nParagraph.', metadata: { title: 'Page' } });

    await db.exec(`DELETE FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE source = 'scraper');`);
    await db.exec(`DELETE FROM ingestion_jobs WHERE source = 'scraper';`);
    await db.exec(`DELETE FROM documents WHERE source = 'scraper';`);

    vi.resetModules();
    vi.doMock('@/lib/scrapers/firecrawl-client', () => ({ scrapeUrl, crawlWebsite }));
    const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
    setIngestDepsForTests({ embedDocuments: async (texts) => texts.map((text) => embedText(text)) });
    const { setObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
    const { createFakeObjectStore } = await import('../../helpers/fake-object-store');
    setObjectStoreForTests(createFakeObjectStore());

    const enqueueModule = await import('@/lib/rag/ingest/enqueue');
    submitSpy = vi.spyOn(enqueueModule, 'submitIngest');

    const pglite = createPgliteAdmin(db);
    const real = (await vi.importActual<typeof import('@/lib/supabase')>('@/lib/supabase')).getSupabaseAdmin();
    if (!real) throw new Error('fixture admin client missing');
    const admin = {
      rpc: real.rpc.bind(real),
      storage: real.storage,
      from(table: string) {
        const builder = pglite.from(table) as unknown as Record<string, unknown>;
        builder.single = () => (builder.maybeSingle as () => Promise<unknown>)();
        return builder;
      },
    };
    vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin, supabaseAdmin: admin }));
    const { setRagDepsForTests } = await import('@/lib/rag/deps');
    setRagDepsForTests({ adminClient: () => admin as never });
  });

  afterEach(async () => {
    submitSpy?.mockRestore();
    const { resetIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
    const { resetRagDepsForTests } = await import('@/lib/rag/deps');
    const { resetObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
    resetIngestDepsForTests();
    resetRagDepsForTests();
    resetObjectStoreForTests();
    vi.doUnmock('@/lib/supabase');
    vi.unstubAllEnvs();
  });

  async function scrapePage(markdown: string) {
    scrapeUrl.mockResolvedValueOnce({ markdown, metadata: { title: 'Scraped' } });
    const { mintScope: mint } = await import('@/lib/rag/tenant/scope');
    const scope = mint('single', null, null);
    vi.doMock('@/lib/scrapers/firecrawl-client', () => ({ scrapeUrl, crawlWebsite }));
    const { scrapeAndProcess } = await import('@/lib/scrapers/scraper-adapter');
    return scrapeAndProcess({ url: PAGE_A, scope, signal: new AbortController().signal });
  }

  async function markCurrent(documentId: string) {
    await db.query(`UPDATE documents SET status = 'ready', is_current = true WHERE id = $1::uuid`, [documentId]);
  }

  it('first scrape queues a job with the canonical URL identity', async () => {
    const result = await scrapePage('Edition one.\n\nParagraph.');

    expect(result.status).toBe('queued');
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const jobs = await jobRows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ source_key: PAGE_A, status: 'queued' });
    const docs = await documentRows();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source_key: PAGE_A, version: 1, status: 'processing', is_current: false });
    expect(result.documentId).toBe(docs[0].id);
  });

  it('re-scraping unchanged content returns skipped_duplicate', async () => {
    const first = await scrapePage('Same body.\n\nParagraph.');
    await markCurrent(first.documentId);
    submitSpy.mockClear();

    const again = await scrapePage('Same body.\n\nParagraph.');

    expect(again.status).toBe('skipped_duplicate');
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const queued = await submitSpy.mock.results[0].value;
    expect(queued.status).toBe('skipped_duplicate');
    expect(await documentRows()).toHaveLength(1);
    expect((await jobRows()).filter((row) => row.status === 'skipped_duplicate')).toHaveLength(1);
  });

  it('changed page content queues a new version under the same source key', async () => {
    const first = await scrapePage('Edition one.\n\nParagraph.');
    await markCurrent(first.documentId);
    submitSpy.mockClear();

    const second = await scrapePage('Edition two.\n\nNew paragraph.');

    expect(second.status).toBe('queued');
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const rows = await documentRows();
    expect(rows.map((row) => [row.version, row.status, row.is_current])).toEqual([
      [1, 'ready', true],
      [2, 'processing', false],
    ]);
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set([first.documentId, second.documentId]));
    expect(rows[0].source_key).toBe(PAGE_A);
    expect(rows[1].source_key).toBe(PAGE_A);
    expect((await jobRows()).filter((row) => row.status === 'queued')).toHaveLength(2);
  });
});