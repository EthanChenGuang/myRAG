/**
 * SC1: under tiered routing a mixed-pages fixture sends only its table and scanned pages to structured parsing and is merged back
 * in page order. The worker is the real sidecar module (recorded converter), the app callbacks and the ledger are real.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';

type Row = Record<string, unknown>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PARSE_ROOT = path.join(ROOT, 'eval', 'fixtures', 'parse');
const RECORDED_DIR = path.join(PARSE_ROOT, 'recorded');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fixture(id: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(PARSE_ROOT, 'pdf', `${id}.pdf`)));
}

describe('tiered routing: mixed pages and the spec example through both services', () => {
  let harness: QueuedHarness;
  let enqueue: typeof import('@/lib/rag/ingest/enqueue').enqueueIngest;

  before(async () => {
    harness = await startQueuedHarness({ env: { RAG_PARSE_ROUTING: 'tiered' } });
    // The worker reads the original and writes its cache objects over HTTP, so the app must use the same storage: the default
    // Supabase object store, pointed at the fake edge by the process environment, instead of the in-memory fake.
    (await import('@/lib/rag/ingest/object-store')).resetObjectStoreForTests();
    enqueue = (await import('@/lib/rag/ingest/enqueue')).enqueueIngest;
  });

  after(async () => {
    await harness?.close();
  });

  async function upload(id: string): Promise<{ jobId: string; documentId: string }> {
    const queued = await enqueue({
      scope: harness.scopeA,
      source: 'config_upload',
      sourceKey: `root/${id}.pdf`,
      file: fixture(id),
      filename: `${id}.pdf`,
      mimeType: 'application/pdf',
      docType: 'general',
      signal: new AbortController().signal,
    });
    assert.equal(queued.status, 'queued');
    const settings = (await harness.rows('SELECT settings FROM ingestion_jobs WHERE id = $1', [queued.jobId]))[0]?.settings as Row;
    assert.equal(settings.routing, 'tiered', 'the job snapshot carries tiered routing');
    return { jobId: String(queued.jobId), documentId: String(queued.documentId) };
  }

  async function work(jobId: string) {
    const worker = await harness.runWorker(jobId, { RAG_INGEST_CONVERTER: 'recorded', RAG_INGEST_RECORDED_DIR: RECORDED_DIR });
    assert.equal(worker.exitCode, 0, `worker stdout: ${worker.stdout.slice(-1000)} stderr: ${worker.stderr.slice(-3000)} edge: ${JSON.stringify(harness.edge.errors.slice(-3))}`);
    const summary = JSON.parse(worker.stdout.trim().split('\n').at(-1) ?? '{}') as Row;
    assert.equal(summary.status, 'ready');
    return worker;
  }

  const mixed: { jobId?: string; documentId?: string } = {};

  test('mixed fixture: only pages 7-8 are parsed structured_full, page 9 structured_ocr and the others fast', async () => {
    const queued = await upload('mixed-routing');
    mixed.jobId = queued.jobId;
    mixed.documentId = queued.documentId;
    await work(queued.jobId);

    const [job] = await harness.rows(
      'SELECT status, stage, tier, doc_class, parser_used, page_ranges, tier_page_counts, detect_counts, attempts, preflight_ref, pages FROM ingestion_jobs WHERE id = $1',
      [queued.jobId],
    );
    assert.ok(job);
    assert.equal(job.status, 'ready');
    assert.equal(job.tier, 'structured');
    assert.equal(job.doc_class, 'tables', 'one scanned page of ten is exactly 10%, which D-12 does not call mixed');
    assert.equal(job.pages, 10);
    const ranges = job.page_ranges as Row[];
    assert.deepEqual(
      ranges.map((range) => [range.start, range.end, range.tier, range.preset, range.status]),
      [
        [1, 6, 'fast', 'fast', 'ok'],
        [7, 8, 'structured', 'structured_full', 'ok'],
        [9, 9, 'structured', 'structured_ocr', 'ok'],
        [10, 10, 'fast', 'fast', 'ok'],
      ],
    );
    assert.ok(ranges.every((range) => UUID.test(String(range.cache_id))), 'every range points at its cache entry');
    assert.deepEqual(job.tier_page_counts, { native: 0, fast: 7, structured: 3, premium: 0 });
    assert.equal((job.detect_counts as Row).L1, 10);
    const attempts = job.attempts as Row[];
    assert.deepEqual(
      attempts.map((attempt) => [attempt.reason, attempt.preset, (attempt.pages as Row).start, (attempt.pages as Row).end]),
      [
        ['initial', 'fast', 1, 6],
        ['initial', 'structured_full', 7, 8],
        ['initial', 'structured_ocr', 9, 9],
        ['initial', 'fast', 10, 10],
      ],
    );
    assert.ok(attempts.every((attempt) => attempt.check !== undefined && attempt.refused === false));
    assert.match(String(job.preflight_ref), /_parse-cache\/[a-f0-9]{64}\/preflight-.*\/preflight\.json$/);
  });

  test('the published document has its pages 1..10 in order', async () => {
    assert.ok(mixed.documentId);
    const [document] = await harness.rows('SELECT status, is_current, parser_used FROM documents WHERE id = $1', [mixed.documentId]);
    assert.equal(document?.status, 'ready');
    assert.equal(document?.is_current, true);

    const chunks = await harness.rows(
      'SELECT chunk_index, content, page_start, page_end, chunk_kind FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [mixed.documentId],
    );
    assert.ok(chunks.length >= 4, 'the document has chunks');
    const starts = chunks.map((chunk) => Number(chunk.page_start));
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'chunks follow page order');
    const covered = new Set<number>();
    for (const chunk of chunks) {
      assert.ok(Number(chunk.page_start) >= 1 && Number(chunk.page_end) <= 10, 'pages stay within 1..10');
      for (let page = Number(chunk.page_start); page <= Number(chunk.page_end); page += 1) covered.add(page);
    }
    assert.deepEqual([...covered].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('the table pages keep their header row on every table chunk and the open headings continue across the range boundary', async () => {
    const chunks = await harness.rows(
      'SELECT page_start, chunk_kind, section_path, content FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [mixed.documentId],
    );
    const tables = chunks.filter((chunk) => chunk.chunk_kind === 'table');
    assert.deepEqual(
      tables.map((chunk) => Number(chunk.page_start)),
      [7, 8],
      'one table chunk per table page, from the structured_full range',
    );
    for (const chunk of tables) {
      const [header, separator] = String(chunk.content).split('\n');
      assert.equal(header, '| Lane   |   Value | Status   |');
      assert.match(String(separator), /^\|[-| ]+\|$/);
    }
    const byPage = new Map(chunks.map((chunk) => [Number(chunk.page_start), chunk.section_path as string[]]));
    assert.equal(byPage.get(7)?.[0], 'Section 1', 'the first chunk of the structured range inherits the open heading of the fast range');
    assert.deepEqual(byPage.get(10), ['Embedded scan slip', 'Closing note'], 'page 10 continues the heading opened on the scanned page');
  });

  test('no premium request was made for these fixtures with the default bounds', () => {
    assert.equal(harness.llama.uploads.length, 0);
    assert.equal(harness.llama.calls.length, 0);
    assert.deepEqual(harness.edge.errors, []);
  });

  test('spec example (bench-100): 3 of 100 pages are structured and 97 are fast', async () => {
    const queued = await upload('bench-100');
    await work(queued.jobId);
    const [job] = await harness.rows('SELECT status, tier, pages, tier_page_counts, page_ranges FROM ingestion_jobs WHERE id = $1', [queued.jobId]);
    assert.equal(job?.status, 'ready');
    assert.equal(job?.pages, 100);
    assert.deepEqual(job?.tier_page_counts, { native: 0, fast: 97, structured: 3, premium: 0 });
    const structuredPages = (job?.page_ranges as Row[])
      .filter((range) => range.tier === 'structured')
      .reduce((sum, range) => sum + (Number(range.end) - Number(range.start) + 1), 0);
    assert.equal(structuredPages, 3, 'only the three table pages were parsed structured');
  });
});
