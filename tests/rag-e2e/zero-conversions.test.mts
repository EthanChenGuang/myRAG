/**
 * D-21: four paths that must not call Docling converters or LlamaParse (conversion counters stay at zero).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const OPTIONS_A = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const OPTIONS_B = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

type Harness = Awaited<ReturnType<(typeof import('../../eval/harness/queued-ingest.mts'))['startQueuedHarness']>>;
type PutParse = typeof import('@/lib/rag/ingest/parse-cache').putParseResult;
type ReadParse = typeof import('@/lib/rag/ingest/parse-cache').readParseOutputForDocument;
type ParseResult = import('@/lib/rag-eval/contracts.generated').ParseResult;

let harness: Harness;
let putParseResult: PutParse;
let readParseOutputForDocument: ReadParse;
let parseResult: ParseResult;
let cachedDocumentId: string;
let inlineDocumentId: string;

before(async () => {
  const queued = await import('../../eval/harness/queued-ingest.mts');
  harness = await queued.startQueuedHarness();
  const { installFakeObjectStore } = await import('../helpers/fake-object-store');
  const objectStore = installFakeObjectStore();
  const contracts = await import('@/lib/rag-eval/contracts.generated');
  const cache = await import('@/lib/rag/ingest/parse-cache');
  const { enqueueIngest } = await import('@/lib/rag/ingest/enqueue');
  putParseResult = cache.putParseResult;
  readParseOutputForDocument = cache.readParseOutputForDocument;
  parseResult = contracts.ParseResultSchema.parse({
    markdown: '# Cached\n\nStored merged output for re-chunk.',
    chunks: [
      {
        contextualized_text: 'Cached\nStored merged output for re-chunk.',
        text: 'Stored merged output for re-chunk.',
        headings: ['Cached'],
        pages: [1],
        is_table: false,
        table_header: null,
      },
    ],
    pictures: [],
    page_count: 1,
    parser: 'docling',
    parser_version: 'test',
    partial: false,
    warnings: [],
    text_layer_page_share: null,
  });
  const first = await enqueueIngest({
    scope: harness.scopeA,
    source: 'config_upload',
    sourceKey: 'cache/doc.pdf',
    file: queued.pdfBytes('cache'),
    filename: 'cache.pdf',
    mimeType: 'application/pdf',
    signal: new AbortController().signal,
  });
  assert.equal(first.status, 'queued');
  cachedDocumentId = String(first.documentId);
  const jobId = String(first.jobId);
  await putParseResult(jobId, 'merged', 'test', OPTIONS_A, parseResult, [], new AbortController().signal);
  const cacheRow = (await harness.rows(`SELECT id FROM rag_parse_cache_lookup($1, 'merged', 'test', $2)`, [jobId, OPTIONS_A]))[0];
  assert.ok(cacheRow?.id);
  await harness.rows('SELECT rag_set_document_parse_cache($1, $2)', [jobId, cacheRow.id]);
  await harness.rows(`UPDATE documents SET status = 'ready', is_current = true WHERE id = $1`, [cachedDocumentId]);

  const inline = await enqueueIngest({
    scope: harness.scopeA,
    source: 'config_upload',
    sourceKey: 'cache/inline.md',
    text: '# Inline\n\nPhase 3 body',
    filename: 'inline.md',
    mimeType: 'text/markdown',
    signal: new AbortController().signal,
  });
  inlineDocumentId = String(inline.documentId);
  const doc = (await harness.rows('SELECT lineage_id, version, tenant_key FROM documents WHERE id = $1', [inlineDocumentId]))[0];
  assert.ok(doc?.lineage_id);
  const path = `${doc.tenant_key}/${doc.lineage_id}/${doc.version}/parse.md`;
  await objectStore.put(path, new TextEncoder().encode('# Inline\n\nPhase 3 body'), { contentType: 'text/markdown' });
  await harness.rows(
    `UPDATE documents SET status = 'ready', is_current = true, parser_used = 'text', parser_version = 'inline', original_path = $2 WHERE id = $1`,
    [inlineDocumentId, path],
  );
});

after(async () => {
  await harness?.close();
});

describe('zero conversions (D-21)', () => {
  test('readParseOutputForDocument returns the merged cache for the owning tenant', async () => {
    const callsBefore = harness.llama.calls.length;
    const read = await readParseOutputForDocument(harness.scopeA, cachedDocumentId, new AbortController().signal);
    assert.ok(read);
    assert.match(read.markdown, /re-chunk/);
    assert.equal(harness.llama.calls.length, callsBefore);
  });

  test('readParseOutputForDocument returns null for another tenant', async () => {
    const callsBefore = harness.llama.calls.length;
    const read = await readParseOutputForDocument(harness.scopeB, cachedDocumentId, new AbortController().signal);
    assert.equal(read, null);
    assert.equal(harness.llama.calls.length, callsBefore);
  });

  test('readParseOutputForDocument returns inline parse.md when no cache is linked', async () => {
    const callsBefore = harness.llama.calls.length;
    const read = await readParseOutputForDocument(harness.scopeA, inlineDocumentId, new AbortController().signal);
    assert.ok(read);
    assert.equal(read.parser, 'text');
    assert.match(read.markdown, /Phase 3/);
    assert.equal(harness.llama.calls.length, callsBefore);
  });

  test('re-chunking from the cache with another options hash needs no new parser calls', async () => {
    const callsBefore = harness.llama.calls.length;
    const jobRow = (await harness.rows('SELECT id FROM ingestion_jobs WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1', [cachedDocumentId]))[0];
    assert.ok(jobRow?.id);
    const entry = await putParseResult(
      String(jobRow.id),
      'merged',
      'test',
      OPTIONS_B,
      { ...parseResult, markdown: '# Other chunk size\n\nSame bytes.' },
      [],
      new AbortController().signal,
    );
    await harness.rows('SELECT rag_set_document_parse_cache($1, $2)', [jobRow.id, entry.id]);
    const read = await readParseOutputForDocument(harness.scopeA, cachedDocumentId, new AbortController().signal);
    assert.ok(read);
    assert.match(read.markdown, /chunk size/);
    assert.equal(harness.llama.calls.length, callsBefore);
  });
});