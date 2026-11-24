import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chunkFingerprint, pdfBytes, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const RECORDED_PDF = path.join('eval/fixtures/ingest/pdf/report-zh-table.pdf');

const MARKDOWN = [
  '# Warehouse Handbook',
  '',
  'Forklift batteries rotate every shift under the zebra quartz seventeen policy.',
  '',
  '## Receiving Dock',
  '',
  'Pallets arriving at the receiving dock are scanned by the night crew and staged beside bay four.',
  '',
  '| Bay | Owner |',
  '| --- | --- |',
  '| 4 | Night crew |',
  '| 5 | Day crew |',
  '',
  '## Shipping Cage',
  '',
  'Outbound pallets leave through the shipping cage after the supervisor signs the manifest.',
  '',
].join('\n');

const INVOICE = [
  'INVOICE',
  '',
  'Invoice No.: INV-2025-0042',
  'Issue date: 2025-03-15',
  'Supplier: Example Supplier Ltd',
  'VAT No.: IT01234567890',
  'Buyer: Example Buyer',
  '',
  'Line 1: Pallet wrap, 40 rolls, EUR 400.00',
  'Line 2: Strapping, 25 rolls, EUR 850.00',
  'Total: EUR 1,250.00',
  '',
].join('\n');

const PLAIN = 'Delivery notes\n\nThe copper tally sheet is filed by the dispatch clerk each evening.\n\nA second paragraph closes the sheet.\n';

interface Fixture {
  id: string;
  parser: 'text' | 'llamaparse' | 'docling';
  /** RAG_PARSER for this fixture: the configured parser the chain tries first. */
  configured: 'llamaparse' | 'docling';
  input: { text: string } | { file: Uint8Array };
  filename: string;
  mimeType: string;
  docType?: 'general' | 'financial_report';
}

const FIXTURES: Fixture[] = [
  { id: 'markdown', parser: 'text', configured: 'llamaparse', input: { text: MARKDOWN }, filename: 'handbook.md', mimeType: 'text/markdown', docType: 'general' },
  // No picked type: the origin the identify stage decided has to reach the queued run through queued-input.json.
  { id: 'invoice-auto', parser: 'text', configured: 'llamaparse', input: { text: INVOICE }, filename: 'invoice-0042.md', mimeType: 'text/markdown' },
  { id: 'txt', parser: 'text', configured: 'llamaparse', input: { text: PLAIN }, filename: 'notes.txt', mimeType: 'text/plain', docType: 'general' },
  { id: 'llamaparse-pdf', parser: 'llamaparse', configured: 'llamaparse', input: { file: pdfBytes('llamaparse fixture') }, filename: 'report.pdf', mimeType: 'application/pdf', docType: 'general' },
  { id: 'docling-docx', parser: 'docling', configured: 'docling', input: { file: new Uint8Array(Buffer.from('PK docx fixture bytes for the fake sidecar', 'utf8')) }, filename: 'memo.docx', mimeType: DOCX_MIME, docType: 'general' },
  {
    id: 'docling-pdf-recorded',
    parser: 'docling',
    configured: 'docling',
    input: { file: new Uint8Array(fs.readFileSync(RECORDED_PDF)) },
    filename: 'report-zh-table.pdf',
    mimeType: 'application/pdf',
    docType: 'financial_report',
  },
];

describe('fixed equals Phase 3: the queued fixed path and inline ingest() produce the same chunks', () => {
  let harness: QueuedHarness;
  let enqueueModule: typeof import('@/lib/rag/ingest/enqueue');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let baseEnv: ReturnType<ReturnType<typeof import('@/lib/rag/ingest/deps').getIngestDeps>['ingestEnv']>;

  before(async () => {
    harness = await startQueuedHarness();
    enqueueModule = await import('@/lib/rag/ingest/enqueue');
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    baseEnv = depsModule.getIngestDeps().ingestEnv();
  });

  after(async () => {
    depsModule?.setIngestDepsForTests({ ingestEnv: () => baseEnv });
    await harness?.close();
  });

  for (const fixture of FIXTURES) {
    test(`${fixture.id}: equal chunk content hashes, section paths, page numbers, parser and metadata`, async () => {
      depsModule.setIngestDepsForTests({ ingestEnv: () => ({ ...baseEnv, RAG_PARSER: fixture.configured }) });
      const common = {
        source: 'config_upload' as const,
        sourceKey: `root/${fixture.filename}`,
        filename: fixture.filename,
        mimeType: fixture.mimeType,
        ...(fixture.docType ? { docType: fixture.docType } : {}),
        signal: new AbortController().signal,
        ...fixture.input,
      };

      const inline = await ingestModule.ingest({ ...common, scope: harness.scopeB } as Parameters<typeof ingestModule.ingest>[0]);
      assert.equal(inline.status, 'ready', `inline: ${inline.reason ?? ''}`);
      assert.equal(inline.parserUsed, fixture.parser);

      const queued = await enqueueModule.enqueueIngest({ ...common, scope: harness.scopeA } as Parameters<typeof enqueueModule.enqueueIngest>[0]);
      assert.equal(queued.status, 'queued', queued.reason ?? '');
      const worker = await harness.runWorker(String(queued.jobId));
      assert.equal(worker.exitCode, 0, `worker stdout: ${worker.stdout.slice(-600)} stderr: ${worker.stderr.slice(-1500)}`);

      const expected = await chunkFingerprint(harness, String(inline.documentId), { embeddings: true });
      const actual = await chunkFingerprint(harness, String(queued.documentId), { embeddings: true });
      assert.ok(expected.chunks.length > 0, 'the inline run produced chunks');
      assert.equal(actual.doc.parser_used, fixture.parser);
      assert.deepEqual(actual, expected);

      const [job] = await harness.rows('SELECT status, parser_used FROM ingestion_jobs WHERE id = $1', [queued.jobId]);
      assert.equal(job?.status, 'ready');
      assert.equal(job?.parser_used, fixture.parser);
    });
  }
});
