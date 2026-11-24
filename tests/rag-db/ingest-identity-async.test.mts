import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUED_IDS, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';

const SOURCE_KEY = 'uploads/handbook.md';
const FILENAME = 'handbook.md';
const TEXT_V1 = '# Handbook\n\nThe teal convoy crosses the north bridge every Thursday.\n';
const TEXT_V2 = '# Handbook\n\nThe amber convoy crosses the south viaduct every Friday.\n';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('queued process-document identity: dedup, versions and tenants (D-22, D-26)', () => {
  let harness: QueuedHarness;
  let enqueueModule: typeof import('@/lib/rag/ingest/enqueue');
  let fetchRows: typeof import('@/lib/rag/context/fetch-rows');
  let supabaseModule: typeof import('@/lib/supabase');

  let firstJobId: string | null;
  let firstDocumentId: string | null;
  let v2JobId: string | null;
  let v2DocumentId: string | null;
  let v1ChunkId: string | null;

  const enqueue = (scope: typeof harness.scopeA, text: string, sourceKey = SOURCE_KEY) =>
    enqueueModule.enqueueIngest({
      scope,
      source: 'chat_upload',
      sourceKey,
      text,
      filename: FILENAME,
      mimeType: 'text/markdown',
      docType: 'general',
      signal: new AbortController().signal,
    });

  before(async () => {
    harness = await startQueuedHarness({ deploymentMode: 'multi-tenant' });
    enqueueModule = await import('@/lib/rag/ingest/enqueue');
    fetchRows = await import('@/lib/rag/context/fetch-rows');
    supabaseModule = await import('@/lib/supabase');
  });

  after(async () => {
    await harness?.close();
  });

  const rows = (sql: string, params: unknown[] = []) => harness.rows(sql, params);

  test('chat_upload bytes enqueue as queued; run_once publishes version 1 as current', async () => {
    const result = await enqueue(harness.scopeA, TEXT_V1);
    assert.equal(result.status, 'queued');
    assert.match(String(result.jobId), UUID);
    assert.match(String(result.documentId), UUID);
    firstJobId = result.jobId;
    firstDocumentId = result.documentId;

    const [beforeRun] = await rows('SELECT status, is_current, version FROM documents WHERE id = $1', [firstDocumentId]);
    assert.equal(beforeRun?.status, 'processing');
    assert.equal(beforeRun?.is_current, false);
    assert.equal(beforeRun?.version, 1);

    const worker = await harness.runWorker(String(firstJobId));
    assert.equal(worker.exitCode, 0, worker.stderr.slice(-1500));

    const [afterRun] = await rows('SELECT status, is_current, version FROM documents WHERE id = $1', [firstDocumentId]);
    assert.equal(afterRun?.status, 'ready');
    assert.equal(afterRun?.is_current, true);
    assert.equal(afterRun?.version, 1);

    const chunks = await rows('SELECT id FROM document_chunks WHERE document_id = $1', [firstDocumentId]);
    assert.ok(chunks.length > 0);
    v1ChunkId = String(chunks[0]?.id);
  });

  test('the same file again returns skipped_duplicate with the version-1 document and a terminal ledger row', async () => {
    assert.ok(firstDocumentId);
    const again = await enqueue(harness.scopeA, TEXT_V1);
    assert.equal(again.status, 'skipped_duplicate');
    assert.equal(again.documentId, firstDocumentId);
    assert.match(String(again.jobId), UUID);
    assert.notEqual(again.jobId, firstJobId);

    const [job] = await rows('SELECT status, document_id FROM ingestion_jobs WHERE id = $1', [again.jobId]);
    assert.equal(job?.status, 'skipped_duplicate');
    assert.equal(job?.document_id, firstDocumentId);

    const [{ n }] = (await rows('SELECT count(*)::int AS n FROM documents WHERE source_key = $1 AND tenant_key = $2', [
      SOURCE_KEY,
      `u:${QUEUED_IDS.userA}`,
    ])) as Array<{ n: number }>;
    assert.equal(n, 1, 'no second document row for unchanged bytes');
  });

  test('changed bytes under the same source key become version 2, stay not-current until publish, then supersede version 1', async () => {
    assert.ok(firstDocumentId);
    const queued = await enqueue(harness.scopeA, TEXT_V2);
    assert.equal(queued.status, 'queued');
    v2JobId = queued.jobId;
    v2DocumentId = queued.documentId;
    assert.notEqual(v2DocumentId, firstDocumentId);

    const pending = await rows(
      'SELECT id, version, is_current, status FROM documents WHERE source_key = $1 AND tenant_key = $2 ORDER BY version',
      [SOURCE_KEY, `u:${QUEUED_IDS.userA}`],
    );
    assert.equal(pending.length, 2);
    assert.equal(pending[0]?.id, firstDocumentId);
    assert.equal(pending[0]?.is_current, true, 'version 1 stays current until v2 publishes');
    assert.equal(pending[1]?.version, 2);
    assert.equal(pending[1]?.is_current, false);
    assert.equal(pending[1]?.status, 'processing');

    const worker = await harness.runWorker(String(v2JobId));
    assert.equal(worker.exitCode, 0, worker.stderr.slice(-1500));

    const versions = await rows(
      'SELECT id, version, is_current, status, superseded_by FROM documents WHERE source_key = $1 AND tenant_key = $2 ORDER BY version',
      [SOURCE_KEY, `u:${QUEUED_IDS.userA}`],
    );
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.is_current, false);
    assert.equal(versions[0]?.superseded_by, v2DocumentId);
    assert.equal(versions[1]?.is_current, true);
    assert.equal(versions[1]?.status, 'ready');
  });

  test('a citation to a version-1 chunk still resolves after version 2 is current', async () => {
    assert.ok(firstDocumentId && v1ChunkId);
    const admin = supabaseModule.getSupabaseAdmin();
    const chunk = await admin.from('document_chunks').select('id, content').eq('id', v1ChunkId).maybeSingle();
    assert.equal(chunk.error, null);
    assert.ok(chunk.data?.content);

    const assembled = await fetchRows.fetchAssemblyRows(
      [{ chunk_id: v1ChunkId, document_id: firstDocumentId }] as unknown as Parameters<typeof fetchRows.fetchAssemblyRows>[0],
      { adminClient: admin, signal: new AbortController().signal },
    );
    assert.equal(assembled.documents.get(firstDocumentId)?.filename, FILENAME);
    assert.ok(assembled.chunkMetadata.has(v1ChunkId));
  });

  test('the same bytes in another tenant enqueue and ingest independently', async () => {
    const forB = await enqueue(harness.scopeB, TEXT_V1, 'uploads/tenant-b-handbook.md');
    assert.equal(forB.status, 'queued');
    assert.notEqual(forB.documentId, firstDocumentId);

    const worker = await harness.runWorker(String(forB.jobId));
    assert.equal(worker.exitCode, 0);

    const [docB] = await rows('SELECT status, is_current, tenant_key FROM documents WHERE id = $1', [forB.documentId]);
    assert.equal(docB?.status, 'ready');
    assert.equal(docB?.is_current, true);
    assert.equal(docB?.tenant_key, `o:${QUEUED_IDS.orgB}`);
  });
});