/**
 * Backfill runs through the same worker and ledger as uploads (D-25, D-31, D-33, D-34, D-36): the document row is created when a
 * job is first claimed (advance phase begin), and a batch is enqueued, monitored, reported and resumed after a kill.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';

type Row = Record<string, unknown>;

const WORKER = 'backfill-test-worker';
const BEGIN_BODY = { worker_id: WORKER, attempt_no: 1, phase: 'begin', deadline_ms: 40_000 };

function settings(routing: 'fixed' | 'tiered' = 'fixed'): Row {
  return {
    cloud_allowed: false,
    doc_type: 'general',
    embed_mode: 'sync',
    escalation: true,
    max_tier: null,
    min_tier: null,
    ocr_languages: ['en'],
    premium_max_pages_per_doc: 0,
    premium_page_budget: 0,
    profile_id: 'general',
    profile_version: 1,
    progressive: false,
    routing,
    routing_config_version: '1',
    vlm_detect: false,
    vlm_model: null,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function textFile(label: string): Uint8Array {
  return new Uint8Array(
    Buffer.from(`# ${label}\n\nThis backfill fixture is called ${label}. It explains the ${label} procedure in a few plain sentences.\n`, 'utf8'),
  );
}

/** One database, edge and app for the file: the Supabase admin client is a process singleton bound to the first edge. */
let harness: QueuedHarness;
let tenantA: string;
let tenantB: string;
let store: ReturnType<typeof import('@/lib/rag/ingest/object-store').getObjectStore>;

before(async () => {
  harness = await startQueuedHarness();
  const objectStore = await import('@/lib/rag/ingest/object-store');
  objectStore.resetObjectStoreForTests();
  store = objectStore.getObjectStore();
  const { scopeKey } = await import('@/lib/rag/tenant/scope');
  tenantA = scopeKey(harness.scopeA).toLowerCase();
  tenantB = scopeKey(harness.scopeB).toLowerCase();
});

after(async () => {
  await harness?.close();
});

async function createBatch(tenant: string, concurrency = 2): Promise<string> {
  const [row] = await harness.rows("SELECT id FROM rag_create_ingestion_batch($1, 'folder', 'fixture', NULL, $2, 'worker', NULL)", [tenant, concurrency]);
  return String(row?.id);
}

/** Stages a file under `prefixTenant` and enqueues one job of the batch for it, the way enqueueRun does, without a document row. */
async function enqueueStaged(
  batchId: string,
  label: string,
  options: { kind?: 'ingest' | 'dry_run'; routing?: 'fixed' | 'tiered'; prefixTenant?: string; bytes?: Uint8Array } = {},
): Promise<{ jobId: string; sha: string }> {
  const bytes = options.bytes ?? textFile(label);
  const sha = sha256(bytes);
  const [batch] = await harness.rows('SELECT tenant_key FROM ingestion_batches WHERE id = $1', [batchId]);
  const prefixTenant = options.prefixTenant ?? String(batch?.tenant_key);
  const key = `${prefixTenant}/backfill/${batchId}/${sha}/original.txt`;
  await store.put(key, bytes, { contentType: 'text/plain' });
  const kind = options.kind ?? 'ingest';
  const jobs = [
    {
      kind,
      source: 'config_upload',
      source_key: `fixture/${label}.txt`,
      file_sha256: sha,
      filename: `${label}.txt`,
      mime_type: 'text/plain',
      original_ref: { bucket: 'rag-originals', path: key },
      settings: settings(options.routing ?? 'fixed'),
    },
  ];
  await harness.rows('SELECT rag_enqueue_backfill_jobs($1, $2::jsonb)', [batchId, JSON.stringify(jobs)]);
  const [job] = await harness.rows('SELECT id FROM ingestion_jobs WHERE batch_id = $1 AND kind = $2 AND source_key = $3', [
    batchId,
    kind,
    `fixture/${label}.txt`,
  ]);
  return { jobId: String(job?.id), sha };
}

async function job(jobId: string): Promise<Row> {
  const [row] = await harness.rows('SELECT * FROM ingestion_jobs WHERE id = $1', [jobId]);
  assert.ok(row, 'job row');
  return row;
}

async function documentsWithHash(sha: string): Promise<Row[]> {
  return harness.rows('SELECT id, tenant_key, status, is_current, version FROM documents WHERE file_sha256 = $1 ORDER BY version', [sha]);
}

describe('advance phase begin: the document row at first claim (D-31)', () => {
  test('begin: an enqueued but never claimed backfill job leaves no document row', async () => {
    const batchId = await createBatch(tenantA);
    const { jobId, sha } = await enqueueStaged(batchId, 'never-claimed');
    const row = await job(jobId);
    assert.equal(row.document_id, null);
    assert.equal(row.priority, 10);
    assert.deepEqual(await documentsWithHash(sha), []);
  });

  test('begin: the first claim creates the processing version in the job tenant and records the document id, then parsing proceeds', async () => {
    const batchId = await createBatch(tenantA);
    const { jobId, sha } = await enqueueStaged(batchId, 'first-claim');
    await harness.claim(jobId, WORKER);
    const reply = await harness.callback(jobId, 'advance', BEGIN_BODY);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.done, false);

    const claimed = await job(jobId);
    const docs = await documentsWithHash(sha);
    assert.equal(docs.length, 1);
    assert.equal(claimed.document_id, docs[0]?.id);
    assert.equal(docs[0]?.tenant_key, tenantA);
    assert.equal(docs[0]?.status, 'processing');
    assert.equal(docs[0]?.is_current, false);
    assert.equal(claimed.status, 'preflight');

    // A repeated begin (a worker retrying its call) changes nothing.
    const again = await harness.callback(jobId, 'advance', BEGIN_BODY);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.done, false);
    assert.equal((await documentsWithHash(sha)).length, 1);

    // The worker dies after begin; once the lease expires the job is reclaimed and finishes on the same document.
    await harness.rows("UPDATE ingestion_jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [jobId]);
    const run = await harness.runWorker(jobId);
    assert.equal(run.exitCode, 0, `stdout: ${run.stdout.slice(-1000)} stderr: ${run.stderr.slice(-2000)}`);
    const done = await job(jobId);
    assert.equal(done.status, 'ready');
    assert.equal(done.document_id, docs[0]?.id);
    const finished = await documentsWithHash(sha);
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.status, 'ready');
    assert.equal(finished[0]?.is_current, true);
  });

  test('begin: the worker calls begin itself for an unclaimed backfill job and the job ends ready', async () => {
    const batchId = await createBatch(tenantA);
    const { jobId, sha } = await enqueueStaged(batchId, 'worker-begins');
    const run = await harness.runWorker(jobId);
    assert.equal(run.exitCode, 0, `stdout: ${run.stdout.slice(-1000)} stderr: ${run.stderr.slice(-2000)}`);
    const done = await job(jobId);
    assert.equal(done.status, 'ready');
    const docs = await documentsWithHash(sha);
    assert.equal(docs.length, 1);
    assert.equal(done.document_id, docs[0]?.id);
    assert.equal(docs[0]?.tenant_key, tenantA);
    const [chunks] = await harness.rows('SELECT count(*)::int AS n FROM document_chunks WHERE document_id = $1', [docs[0]?.id]);
    assert.ok(Number(chunks?.n) > 0);
  });

  test('begin: a file the tenant already has (raced in after the inventory) ends skipped_duplicate at begin without parsing', async () => {
    const batchId = await createBatch(tenantA);
    const bytes = textFile('raced-in');
    const first = await enqueueStaged(batchId, 'raced-in', { bytes });
    assert.equal((await harness.runWorker(first.jobId)).exitCode, 0);
    assert.equal((await job(first.jobId)).status, 'ready');

    const later = await createBatch(tenantA);
    const { jobId, sha } = await enqueueStaged(later, 'raced-in-copy', { bytes });
    const run = await harness.runWorker(jobId);
    assert.equal(run.exitCode, 0, `stderr: ${run.stderr.slice(-2000)}`);
    const skipped = await job(jobId);
    assert.equal(skipped.status, 'skipped_duplicate');
    assert.deepEqual(skipped.attempts, []);
    assert.equal(skipped.stage, 'skipped_duplicate');
    const docs = await documentsWithHash(sha);
    assert.equal(docs.length, 1, 'no second version');
  });

  test('begin: dry_run jobs never call begin and leave no document row', async () => {
    const batchId = await createBatch(tenantA);
    const { jobId, sha } = await enqueueStaged(batchId, 'sample-only', { kind: 'dry_run', routing: 'tiered' });
    await harness.claim(jobId, WORKER);
    const refused = await harness.callback(jobId, 'advance', BEGIN_BODY);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'begin_not_allowed');
    await harness.rows("UPDATE ingestion_jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [jobId]);

    const run = await harness.runWorker(jobId);
    assert.equal(run.exitCode, 0, `stderr: ${run.stderr.slice(-2000)}`);
    const done = await job(jobId);
    assert.equal(done.status, 'ready');
    assert.equal(done.document_id, null);
    assert.deepEqual(await documentsWithHash(sha), []);
  });

  test('begin: a staged original under another tenant prefix fails the job and creates no document in either tenant', async () => {
    const batchId = await createBatch(tenantA);
    const { jobId, sha } = await enqueueStaged(batchId, 'foreign-prefix', { prefixTenant: tenantB });
    await harness.claim(jobId, WORKER);
    const reply = await harness.callback(jobId, 'advance', BEGIN_BODY);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.done, true);
    assert.equal(reply.body.status, 'failed');
    assert.equal(reply.body.reason, 'original_unavailable');
    assert.deepEqual(await documentsWithHash(sha), []);
    assert.equal((await job(jobId)).document_id, null);
  });

  test('begin: refused for an incremental job, which got its document row at enqueue', async () => {
    const { enqueueIngest } = await import('@/lib/rag/ingest/enqueue');
    const queued = await enqueueIngest({
      scope: harness.scopeA,
      source: 'config_upload',
      sourceKey: 'root/incremental-begin.txt',
      file: textFile('incremental-begin'),
      filename: 'incremental-begin.txt',
      mimeType: 'text/plain',
      signal: new AbortController().signal,
    });
    assert.equal(queued.status, 'queued');
    const jobId = String(queued.jobId);
    await harness.claim(jobId, WORKER);
    const reply = await harness.callback(jobId, 'advance', BEGIN_BODY);
    assert.equal(reply.status, 409, JSON.stringify(reply.body));
    assert.equal(reply.body.error, 'begin_not_allowed');
    await harness.rows("UPDATE ingestion_jobs SET status = 'failed', locked_by = NULL, lease_until = NULL WHERE id = $1", [jobId]);
  });

  test('begin: a worker without the lease is refused', async () => {
    const batchId = await createBatch(tenantA);
    const { jobId, sha } = await enqueueStaged(batchId, 'no-lease');
    await harness.claim(jobId, 'another-worker');
    const reply = await harness.callback(jobId, 'advance', BEGIN_BODY);
    assert.equal(reply.status, 409);
    assert.equal(reply.body.error, 'lease_lost');
    assert.deepEqual(await documentsWithHash(sha), []);
  });
});

describe('enqueueIngest with a batch id (03.1-43 follow-up)', () => {
  test('a batch job snapshot is a backfill snapshot: progressive off and sync embeds whatever the environment says', async () => {
    const { enqueueIngest } = await import('@/lib/rag/ingest/enqueue');
    const { loadQueueConfig } = await import('@/lib/rag/ingest/queue-config');
    const batchId = await createBatch(tenantA);
    const config = loadQueueConfig({
      RAG_INGEST_PIPELINE: 'unified',
      RAG_INGEST_ASYNC: 'on',
      RAG_PARSE_PROGRESSIVE: 'true',
      RAG_EMBED_BATCH_MODE: 'sync',
    });
    const queued = await enqueueIngest(
      {
        scope: harness.scopeA,
        source: 'config_upload',
        sourceKey: 'root/batch-snapshot.txt',
        file: textFile('batch-snapshot'),
        filename: 'batch-snapshot.txt',
        mimeType: 'text/plain',
        signal: new AbortController().signal,
      },
      { batchId, priority: 10, queueConfig: () => config },
    );
    assert.equal(queued.status, 'queued');
    const row = await job(String(queued.jobId));
    const snapshot = row.settings as Row;
    assert.equal(row.batch_id, batchId);
    assert.equal(snapshot.progressive, false);
    assert.equal(snapshot.embed_mode, 'sync');
    await harness.rows("UPDATE ingestion_jobs SET status = 'failed' WHERE id = $1", [row.id]);
  });
});
