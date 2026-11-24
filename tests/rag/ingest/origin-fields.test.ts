import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingest } from '@/lib/rag/ingest';
import { mintScope } from '@/lib/rag/tenant/scope';
import { callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../../helpers/ingest-fakes';

const PAGE_URL = 'https://example.com/guide';
const MARKDOWN = [
  '# Guide',
  '',
  'The night crew scans every pallet at the dock and stages it beside bay four for the morning team.',
  '',
].join('\n');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  uninstallIngestDeps();
  vi.restoreAllMocks();
});

function scrape(options?: Record<string, unknown>) {
  return ingest({
    scope: mintScope('single', null, null),
    source: 'scraper',
    sourceKey: PAGE_URL,
    text: MARKDOWN,
    filename: 'Guide.md',
    mimeType: 'text/markdown',
    signal: new AbortController().signal,
    ...(options ? { options } : {}),
  });
}

function fieldWrites(calls: ReturnType<typeof fakeIngestDb>['calls']): Array<Record<string, unknown>> {
  return callsOf(calls, 'rag_set_document_fields').map((call) => call.args.p_fields as Record<string, unknown>);
}

describe('ingest origin fields', () => {
  it('writes the provider fields and URL metadata a scraper names onto the document row', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    const result = await scrape({
      origin: {
        sourceProvider: 'firecrawl',
        sourceFileId: PAGE_URL,
        metadata: { external_url: PAGE_URL, scraped_url: PAGE_URL, title: 'Guide' },
      },
    });

    expect(result.status).toBe('ready');
    const origin = fieldWrites(calls).find((fields) => 'source_provider' in fields);
    expect(origin).toEqual({
      source_provider: 'firecrawl',
      source_file_id: PAGE_URL,
      metadata: { external_url: PAGE_URL, scraped_url: PAGE_URL, title: 'Guide' },
    });
  });

  it('writes the origin before parsing, right after the version begins', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    await scrape({ origin: { sourceProvider: 'firecrawl', sourceFileId: PAGE_URL } });

    const names = calls.map((call) => call.fn);
    const begin = names.indexOf('rag_begin_document_version');
    const originWrite = calls.findIndex((call) => call.fn === 'rag_set_document_fields' && 'source_provider' in (call.args.p_fields as object));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(originWrite).toBe(begin + 1);
  });

  it('writes no origin fields when the caller names none', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    await scrape();

    expect(fieldWrites(calls).some((fields) => 'source_provider' in fields || 'source_file_id' in fields)).toBe(false);
  });

  it('ignores origin values that are not plain strings', async () => {
    const { db, calls } = fakeIngestDb();
    installIngestDeps({ db });

    await scrape({ origin: { sourceProvider: { nested: true }, sourceFileId: 7, metadata: { title: 'Guide', depth: { x: 1 } } } });

    const origin = fieldWrites(calls).find((fields) => 'metadata' in fields && 'title' in (fields.metadata as object));
    expect(origin).toEqual({ metadata: { title: 'Guide' } });
  });
});
