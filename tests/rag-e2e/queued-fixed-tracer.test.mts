import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUED_IDS, pdfBytes, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POST_PARSE_STAGES = ['content_hash_dedup', 'scan_injection', 'chunk', 'enrich', 'extract', 'images', 'embed', 'write', 'publish'];

describe('queued fixed tracer: one upload from enqueueIngest through the ledger, the sidecar job function and both callbacks', () => {
  let harness: QueuedHarness;
  let enqueueModule: typeof import('@/lib/rag/ingest/enqueue');
  let rag: typeof import('@/lib/rag');
  let queued: Awaited<ReturnType<typeof import('@/lib/rag/ingest/enqueue').enqueueIngest>>;
  let worker: Awaited<ReturnType<QueuedHarness['runWorker']>>;

  before(async () => {
    harness = await startQueuedHarness();
    enqueueModule = await import('@/lib/rag/ingest/enqueue');
    rag = await import('@/lib/rag');
  });

  after(async () => {
    await harness?.close();
  });

  test('enqueueIngest stores the original, creates the not-current processing version and a queued ledger row', async () => {
    queued = await enqueueModule.enqueueIngest({
      scope: harness.scopeA,
      source: 'config_upload',
      sourceKey: 'root/handbook.pdf',
      file: pdfBytes('handbook'),
      filename: 'handbook.pdf',
      mimeType: 'application/pdf',
      docType: 'general',
      signal: new AbortController().signal,
    });
    assert.equal(queued.status, 'queued');
    assert.match(String(queued.jobId), UUID);
    assert.match(String(queued.documentId), UUID);

    const [job] = await harness.rows('SELECT * FROM ingestion_jobs WHERE id = $1', [queued.jobId]);
    assert.ok(job);
    assert.equal(job.status, 'queued');
    assert.equal(job.tenant_key, `u:${QUEUED_IDS.userA}`);
    assert.equal(job.document_id, queued.documentId);
    assert.equal(job.priority, 100);
    assert.equal(job.kind, 'ingest');
    assert.equal((job.settings as Row).routing, 'fixed');
    assert.equal((job.settings as Row).doc_type, 'general');
    assert.equal((job.original_ref as Row).bucket, 'rag-originals');
    assert.match(String(job.file_sha256), /^[a-f0-9]{64}$/);

    const [document] = await harness.rows('SELECT status, is_current, processing_state, original_path, tenant_key FROM documents WHERE id = $1', [queued.documentId]);
    assert.ok(document);
    assert.equal(document.status, 'processing');
    assert.equal(document.is_current, false);
    assert.deepEqual(document.processing_state, {}, 'processing_state keeps its column default');
    assert.equal(document.tenant_key, `u:${QUEUED_IDS.userA}`);
    assert.equal(String(document.original_path), (job.original_ref as Row).path);
    assert.equal(await harness.fakes.objectStore.exists(String(document.original_path)), true);
  });

  test('run_once claims the job, calls parse-external in chain mode, records one fixed_chain attempt and advances until done', async () => {
    assert.ok(queued?.jobId, 'the first test enqueued the job');
    worker = await harness.runWorker(String(queued.jobId));
    assert.equal(worker.exitCode, 0, `worker stdout: ${worker.stdout.slice(-1000)} stderr: ${worker.stderr.slice(-2000)}`);
    const summary = JSON.parse(worker.stdout.trim().split('\n').at(-1) ?? '{}') as Row;
    assert.equal(summary.status, 'ready');
    assert.equal(summary.job_id, queued.jobId);
    assert.ok(!worker.stdout.includes('Page'), 'no document text on the worker output');

    const [job] = await harness.rows('SELECT * FROM ingestion_jobs WHERE id = $1', [queued.jobId]);
    assert.ok(job);
    assert.equal(job.status, 'ready');
    assert.equal(job.stage, 'ready');
    assert.equal(job.locked_by, null);
    assert.equal(job.parser_used, 'llamaparse');
    const attempts = job.attempts as Row[];
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.reason, 'fixed_chain');
    assert.equal(attempts[0]?.attempt_no, 1);
    assert.equal(attempts[0]?.refused, false);

    const timings = job.timings as Record<string, number>;
    for (const stage of ['parse', ...POST_PARSE_STAGES]) {
      assert.equal(typeof timings[stage], 'number', `timing for stage ${stage}`);
    }
    const state = job.stage_state as Row;
    assert.equal(state.lastCompleted, 'publish');
    assert.equal(state.cursor, 'publish');
  });

  test('the document is ready, current and its processing_state was never written', async () => {
    const [document] = await harness.rows(
      'SELECT status, is_current, processing_state, processing_status, parser_used, version, content_hash FROM documents WHERE id = $1',
      [queued.documentId],
    );
    assert.ok(document);
    assert.equal(document.status, 'ready');
    assert.equal(document.is_current, true);
    assert.deepEqual(document.processing_state, {}, 'processing_state keeps its column default');
    assert.equal(document.processing_status, 'ready');
    assert.equal(document.parser_used, 'llamaparse');
    assert.ok(document.content_hash);

    const chunks = await harness.rows(
      'SELECT content, section_path, embedding IS NOT NULL AS embedded, is_current, status FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index',
      [queued.documentId],
    );
    assert.ok(chunks.length >= 1, 'the document has chunks');
    assert.ok(chunks.every((chunk) => chunk.embedded === true && chunk.is_current === true && chunk.status === 'ready'));
    assert.ok(chunks.some((chunk) => /second page text about the dock/i.test(String(chunk.content))));
  });

  test('the chunks are retrievable for tenant u:A and never for o:B', async () => {
    const retrieve = async (scope: typeof harness.scopeA) =>
      rag.runRetrieval({
        scope,
        query: 'Second page text about the dock.',
        profile: 'eval',
        options: { maxResults: 25, fallbackToLowerThreshold: true },
        signal: new AbortController().signal,
      });
    const forA = await retrieve(harness.scopeA);
    assert.ok(forA.candidates.some((candidate) => candidate.document_id === queued.documentId), 'tenant A retrieves its chunk');
    const forB = await retrieve(harness.scopeB);
    assert.equal(
      forB.candidates.some((candidate) => candidate.document_id === queued.documentId),
      false,
      'tenant B never retrieves it',
    );
  });

  test('the fake edge refused no request on the way', () => {
    assert.deepEqual(harness.edge.errors, []);
  });

  test('an unchanged file under the same identity returns skipped_duplicate with the existing document and a terminal ledger row', async () => {
    const again = await enqueueModule.enqueueIngest({
      scope: harness.scopeA,
      source: 'config_upload',
      sourceKey: 'root/handbook.pdf',
      file: pdfBytes('handbook'),
      filename: 'handbook.pdf',
      mimeType: 'application/pdf',
      docType: 'general',
      signal: new AbortController().signal,
    });
    assert.equal(again.status, 'skipped_duplicate');
    assert.equal(again.documentId, queued.documentId);
    assert.match(String(again.jobId), UUID);
    assert.notEqual(again.jobId, queued.jobId);
    const [job] = await harness.rows('SELECT status, document_id, locked_by FROM ingestion_jobs WHERE id = $1', [again.jobId]);
    assert.equal(job?.status, 'skipped_duplicate');
    assert.equal(job?.document_id, queued.documentId);
    const [{ n }] = (await harness.rows('SELECT count(*)::int AS n FROM documents WHERE file_sha256 = (SELECT file_sha256 FROM documents WHERE id = $1)', [queued.documentId])) as Array<{ n: number }>;
    assert.equal(n, 1, 'no second version for the same bytes');
  });

  test('submitIngest runs the inline pipeline with the async switch off and enqueues with it on', async () => {
    const queueConfig = await import('@/lib/rag/ingest/queue-config');
    const on = queueConfig.loadQueueConfig({ RAG_INGEST_PIPELINE: 'unified', RAG_INGEST_ASYNC: 'on' });
    const off = queueConfig.loadQueueConfig({ RAG_INGEST_PIPELINE: 'unified', RAG_INGEST_ASYNC: 'off' });
    assert.equal(on.ingestAsync, true);
    assert.equal(off.ingestAsync, false);
    const text = '# Switch\n\nThe teal ledger lists every cart on the east dock before the evening shift.\n';
    const base = {
      scope: harness.scopeA,
      source: 'config_upload' as const,
      sourceKey: 'root/switch.md',
      text,
      filename: 'switch.md',
      mimeType: 'text/markdown',
      signal: new AbortController().signal,
    };
    const inline = await enqueueModule.submitIngest(base, { queueConfig: () => off });
    assert.equal('chunkCount' in inline && inline.status, 'ready');
    const asyncResult = await enqueueModule.submitIngest({ ...base, sourceKey: 'root/switch-two.md', text: `${text}\nA second paragraph.\n`, filename: 'switch-two.md' }, { queueConfig: () => on });
    assert.equal(asyncResult.status, 'queued');
    assert.ok('jobId' in asyncResult && asyncResult.jobId);
  });
});
