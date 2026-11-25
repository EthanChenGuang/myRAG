/**
 * Backfill runs through the same worker and ledger as uploads (D-25, D-31, D-33, D-34, D-36): the document row is created when a
 * job is first claimed (advance phase begin), and a batch is enqueued, monitored, reported and resumed after a kill.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { QUEUED_IDS, SIDECAR_SECRET, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';
import { spawnSidecarModule } from '../../eval/harness/sidecar-worker.mts';

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
  // The chain sends text files to LlamaParse first: every upload gets its own text, so no two versions are content duplicates.
  harness.llama.enqueue(
    ...Array.from({ length: 400 }, (_, index) => ({
      pages: [{ page_number: 1, success: true, markdown: `Backfill page ${index}\n\nUnique fixture text number ${index} about shelf ${index}.` }],
    })),
  );
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

  test('begin: an organization tenant job gets its version owned by the organization owner (documents.user_id is required)', async () => {
    const batchId = await createBatch(tenantB);
    const { jobId, sha } = await enqueueStaged(batchId, 'org-tenant');
    await harness.claim(jobId, WORKER);
    const reply = await harness.callback(jobId, 'advance', BEGIN_BODY);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.done, false, JSON.stringify(reply.body));
    const [doc] = await harness.rows('SELECT id, tenant_key, user_id, organization_id FROM documents WHERE file_sha256 = $1', [sha]);
    assert.equal(doc?.tenant_key, tenantB);
    assert.equal(doc?.organization_id, QUEUED_IDS.orgB);
    assert.equal(doc?.user_id, QUEUED_IDS.userB, 'the organization owner');
    assert.equal((await job(jobId)).document_id, doc?.id);
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

describe('backfill run: enqueue, monitor, end report and resume after a kill (D-25, D-33, D-34, D-36)', () => {
  let run: typeof import('@/lib/rag/ingest/backfill/run');
  let rpc: import('@/lib/rag/backend/supabase-rpc').RpcClient;
  let serviceKey: string;
  const writeSizes: number[] = [];

  before(async () => {
    run = await import('@/lib/rag/ingest/backfill/run');
    const deps = await import('@/lib/rag/ingest/deps');
    const admin = deps.getIngestDeps().db();
    assert.ok(admin, 'admin client');
    rpc = admin;
    // Writer spy: every chunk write of the app goes through this client (D-25).
    deps.setIngestDepsForTests({
      db: () => ({
        rpc(fn: string, args: Record<string, unknown>) {
          if (fn === 'rag_write_chunks' && Array.isArray(args.p_chunks)) writeSizes.push(args.p_chunks.length);
          return admin.rpc(fn, args);
        },
      }),
    });
    const { fixtureProcessEnv } = await import('../../eval/harness/fake-edge.mts');
    serviceKey = String(fixtureProcessEnv(harness.edge.url).SUPABASE_SERVICE_ROLE_KEY);
    // Open jobs of the begin cases would be claimed by the always-on worker below.
    await harness.rows(
      "UPDATE ingestion_jobs SET deleted_at = now() WHERE status NOT IN ('ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate')",
    );
  });

  function item(sourceKey: string, bytes: Uint8Array): import('@/lib/rag/ingest/backfill/sources').SourceItem {
    return {
      sourceKey,
      size: bytes.byteLength,
      ext: 'txt',
      async open() {
        const { Readable } = await import('node:stream');
        return Readable.from([Buffer.from(bytes)]);
      },
    };
  }

  async function* listOf(items: import('@/lib/rag/ingest/backfill/sources').SourceItem[]) {
    for (const entry of items) yield entry;
  }

  function startWorker(): { kill(): void; done: Promise<{ exitCode: number | null; stderr: string }> } {
    return spawnSidecarModule(
      'uvicorn',
      ['rag_sidecar.main:app', '--host', '127.0.0.1', '--port', '0', '--log-level', 'warning'],
      {
        RAG_INGEST_WORKER: 'on',
        RAG_INGEST_WORKER_CONCURRENCY: '4',
        RAG_INGEST_MAINTENANCE: 'off',
        RAG_SIDECAR_SECRET: SIDECAR_SECRET,
        NEXT_PUBLIC_SUPABASE_URL: harness.edge.url,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        RAG_APP_INTERNAL_URL: harness.app.url,
        UV_OFFLINE: '1',
        UV_FROZEN: '1',
      },
      { timeoutMs: 600_000 },
    );
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function ingestCounts(batchId: string): Promise<Record<string, number>> {
    const rows = await harness.rows("SELECT status, count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND kind = 'ingest' GROUP BY status", [
      batchId,
    ]);
    return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.n)]));
  }

  test('a 30-file archive with 4 duplicates runs on the worker with batch concurrency 2, survives a kill and reconciles to 30', async () => {
    const signal = new AbortController().signal;
    // Two files the tenant already has, ingested before the batch.
    const existing = [textFile('run-existing-0'), textFile('run-existing-1')];
    const seedBatch = await createBatch(tenantA);
    for (const [index, bytes] of existing.entries()) {
      const { jobId } = await enqueueStaged(seedBatch, `run-existing-${index}`, { bytes });
      assert.equal((await harness.runWorker(jobId)).exitCode, 0);
    }

    const unique = Array.from({ length: 26 }, (_, index) => textFile(`run-file-${String(index).padStart(2, '0')}`));
    const items = [
      ...unique.map((bytes, index) => item(`archive/file-${String(index).padStart(2, '0')}.txt`, bytes)),
      item('archive/copies/file-00.txt', unique[0] as Uint8Array),
      item('archive/copies/file-01.txt', unique[1] as Uint8Array),
      item('archive/old/existing-0.txt', existing[0] as Uint8Array),
      item('archive/old/existing-1.txt', existing[1] as Uint8Array),
    ];
    const batchId = await createBatch(tenantA, 2);
    const batch = { id: batchId, scope: harness.scopeA };
    const { inventory } = await import('@/lib/rag/ingest/backfill/inventory');
    const inv = await inventory(batch, listOf(items), { rpc, signal });
    assert.equal(inv.entries.length, 26);
    const opener = new Map(items.map((entry) => [entry.sourceKey, entry.open]));
    const entries = inv.entries.map((entry) => ({ ...entry, open: opener.get(entry.sourceKey) as (typeof items)[number]['open'] }));

    const { loadQueueConfig } = await import('@/lib/rag/ingest/queue-config');
    const snapshot = () => loadQueueConfig({ RAG_INGEST_PIPELINE: 'unified', RAG_INGEST_ASYNC: 'on', RAG_PARSE_PROGRESSIVE: 'true' });
    const first = await run.enqueueRun(batch, entries, { signal, snapshot });
    assert.equal(first.enqueued, 26);
    const queued = await harness.rows("SELECT * FROM ingestion_jobs WHERE batch_id = $1 AND kind = 'ingest' AND status = 'queued'", [batchId]);
    assert.equal(queued.length, 26);
    for (const row of queued) {
      assert.equal(row.priority, 10);
      assert.equal(row.document_id, null);
      assert.equal((row.settings as Row).progressive, false, 'a backfill snapshot is never progressive');
      assert.equal((row.original_ref as Row).bucket, 'rag-originals');
      assert.ok(String((row.original_ref as Row).path).startsWith(`${tenantA}/backfill/${batchId}/`));
    }
    assert.deepEqual(await ingestCounts(batchId), { queued: 26, skipped_duplicate: 4 });
    const shas = inv.entries.map((entry) => entry.fileSha256);
    const [none] = await harness.rows('SELECT count(*)::int AS n FROM documents WHERE file_sha256 = ANY($1)', [shas]);
    assert.equal(Number(none?.n), 0, 'no document row before a claim');

    const again = await run.enqueueRun(batch, entries, { signal, snapshot });
    assert.equal(again.enqueued, 0);
    assert.equal(again.existing, 26);
    assert.deepEqual(await ingestCounts(batchId), { queued: 26, skipped_duplicate: 4 });

    let maxLeased = 0;
    const sample = setInterval(() => {
      harness
        .rows(
          "SELECT count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding') AND lease_until > now()",
          [batchId],
        )
        .then((rows) => {
          maxLeased = Math.max(maxLeased, Number(rows[0]?.n ?? 0));
        })
        .catch(() => undefined);
    }, 100);
    try {
      const worker = startWorker();
      await waitFor(async () => ((await ingestCounts(batchId)).ready ?? 0) >= 10, 240_000, '10 ready jobs');
      worker.kill();
      await worker.done;
      const readyBefore = await harness.rows(
        "SELECT id, retries, jsonb_array_length(attempts) AS attempts, updated_at::text AS updated_at, document_id FROM ingestion_jobs WHERE batch_id = $1 AND status = 'ready' ORDER BY id",
        [batchId],
      );
      assert.ok(readyBefore.length >= 10);
      assert.ok(readyBefore.length < 26, 'killed mid-run');
      // The killed worker's leases run out (120 s in production; expired here so the test does not wait).
      await harness.rows("UPDATE ingestion_jobs SET lease_until = now() - interval '1 second' WHERE batch_id = $1 AND lease_until IS NOT NULL", [batchId]);

      const restarted = startWorker();
      const progress: Array<{ leased: number }> = [];
      const final = await run.monitor(batch, { signal, intervalMs: 250, timeoutMs: 300_000, onProgress: (p) => progress.push(p) });
      restarted.kill();
      await restarted.done;
      assert.equal(run.openJobs(final), 0, JSON.stringify(final));
      assert.ok(progress.every((p) => p.leased <= 2), 'monitor never saw more than 2 leased jobs');

      const readyAfter = await harness.rows(
        `SELECT id, retries, jsonb_array_length(attempts) AS attempts, updated_at::text AS updated_at, document_id FROM ingestion_jobs WHERE id = ANY($1) ORDER BY id`,
        [readyBefore.map((row) => row.id)],
      );
      assert.deepEqual(readyAfter, readyBefore, 'ready jobs are never processed again');
    } finally {
      clearInterval(sample);
    }
    assert.ok(maxLeased <= 2, `batch concurrency exceeded: ${maxLeased}`);
    assert.ok(maxLeased >= 1);

    assert.deepEqual(await ingestCounts(batchId), { ready: 26, skipped_duplicate: 4 });
    const docs = await harness.rows(
      'SELECT file_sha256, count(*)::int AS versions, bool_and(status = $2) AS ready, bool_and(is_current) AS current, min(tenant_key) AS tenant FROM documents WHERE file_sha256 = ANY($1) GROUP BY file_sha256',
      [shas, 'ready'],
    );
    assert.equal(docs.length, 26, 'one document per unique file');
    assert.ok(docs.every((row) => row.versions === 1 && row.ready === true && row.current === true && row.tenant === tenantA));

    const report = await run.endReport(batch, { signal });
    assert.equal(report.ingest.total, 30);
    assert.deepEqual(report.ingest.byStatus, { ready: 26, skipped_duplicate: 4 });
    assert.equal(report.sample.total, 0);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.needsReview, []);

    assert.ok(writeSizes.length >= 26, `chunk writes seen: ${writeSizes.length}`);
    assert.ok(Math.max(...writeSizes) <= 300, `a chunk write carried ${Math.max(...writeSizes)} rows`);
    assert.equal(harness.edge.calls.filter((call) => call.path.endsWith('/rag_activate_embedding_profile')).length, 0, 'no profile activation');

    const staged = queued.map((row) => String((row.original_ref as Row).path));
    assert.equal(await run.releaseStagedOriginals(batch, { signal }), 26);
    for (const key of staged) assert.equal(await store.exists(key), false);
    const [kept] = await harness.rows("SELECT count(*)::int AS n FROM documents WHERE file_sha256 = ANY($1) AND original_path LIKE '%/original.txt'", [shas]);
    assert.equal(Number(kept?.n), 26, 'every version keeps its own original');
  });

  test('endReport lists needs_review documents with reasons, failures with error classes, the sample apart, and actual against projected cost', async () => {
    const signal = new AbortController().signal;
    const batchId = await createBatch(tenantA);
    const jobs = [
      { kind: 'ingest', source: 'config_upload', source_key: 'r/ready.txt', status: 'ready', settings: {} },
      { kind: 'ingest', source: 'config_upload', source_key: 'r/review.txt', status: 'needs_review', settings: {} },
      { kind: 'ingest', source: 'config_upload', source_key: 'r/failed.txt', status: 'failed', settings: {} },
      { kind: 'ingest', source: 'config_upload', source_key: 'r/dup.txt', status: 'skipped_duplicate', settings: {} },
      { kind: 'dry_run', source: 'config_upload', source_key: 'r/ready.txt', status: 'ready', settings: {} },
    ];
    await harness.rows('SELECT rag_enqueue_backfill_jobs($1, $2::jsonb)', [batchId, JSON.stringify(jobs)]);
    await harness.rows("UPDATE ingestion_jobs SET est_cost_usd = 0.25 WHERE batch_id = $1 AND source_key = 'r/ready.txt'", [batchId]);
    await harness.rows(
      "UPDATE ingestion_jobs SET needs_review_reason = 'batch_budget_exhausted', est_cost_usd = 0.5 WHERE batch_id = $1 AND source_key = 'r/review.txt'",
      [batchId],
    );
    await harness.rows(
      "UPDATE ingestion_jobs SET error_class = 'parse_timeout', dead_letter_at = now() WHERE batch_id = $1 AND source_key = 'r/failed.txt'",
      [batchId],
    );
    await harness.rows("SELECT rag_update_ingestion_batch($1, NULL, $2::jsonb, NULL)", [
      batchId,
      JSON.stringify({ projected_cost: { premium_parse_usd: 0.5, vlm_usd: 0, embeddings_usd: 0.25, total_usd: 0.75 } }),
    ]);

    const report = await run.endReport({ id: batchId, scope: harness.scopeA }, { signal });
    assert.equal(report.ingest.total, 4);
    assert.deepEqual(report.ingest.byStatus, { ready: 1, needs_review: 1, failed: 1, skipped_duplicate: 1 });
    assert.deepEqual(report.sample, { total: 1, byStatus: { ready: 1 } });
    assert.deepEqual(report.needsReview, [{ sourceKey: 'r/review.txt', documentId: null, reason: 'batch_budget_exhausted' }]);
    assert.deepEqual(report.failures, [{ sourceKey: 'r/failed.txt', errorClass: 'parse_timeout', deadLetter: true }]);
    assert.deepEqual(report.cost, { projectedUsd: 0.75, actualUsd: 1, spentUsd: 0, differenceUsd: 0.25 });
  });

  test('the run refuses a batch of another tenant', async () => {
    const signal = new AbortController().signal;
    const batchId = await createBatch(tenantA);
    const foreign = { id: batchId, scope: harness.scopeB };
    await assert.rejects(run.enqueueRun(foreign, [], { signal }), /tenant mismatch/);
    await assert.rejects(run.endReport(foreign, { signal }), /tenant mismatch/);
    await assert.rejects(run.monitor(foreign, { signal }), /tenant mismatch/);
  });
});
