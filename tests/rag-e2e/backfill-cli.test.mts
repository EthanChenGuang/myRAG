/**
 * `npm run rag:backfill` end to end (D-34, SC5): the real CLI in a child process through tsx, the real sidecar worker, killed mid-run
 * together and resumed with `--resume <batch_id>`.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIDECAR_SECRET, QUEUED_IDS, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';
import { spawnSidecarModule } from '../../eval/harness/sidecar-worker.mts';

type Row = Record<string, unknown>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO_ROOT, 'src/lib/rag/ingest/backfill/cli.ts');
const UNIQUE = 20;
const COPIES = 4;

interface CliRun {
  out(): string;
  batchId(): string | null;
  kill(): void;
  done: Promise<{ code: number | null; out: string; err: string }>;
}

let harness: QueuedHarness;
let tenant: string;
let folder: string;
let serviceKey: string;

function runCli(args: string[]): CliRun {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    child.on('close', (code) => resolve({ code, out, err }));
  });
  return {
    out: () => out,
    batchId: () => /batch ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(out)?.[1] ?? null,
    kill: () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    },
    done,
  };
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
    { timeoutMs: 900_000 },
  );
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function counts(batchId: string, kind: string): Promise<Record<string, number>> {
  const rows = await harness.rows('SELECT status, count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND kind = $2 GROUP BY status', [batchId, kind]);
  return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.n)]));
}

function textFile(label: string): Buffer {
  return Buffer.from(`# ${label}\n\nThe ${label} record explains one archive procedure in a few plain sentences.\n`, 'utf8');
}

before(async () => {
  harness = await startQueuedHarness();
  // The fixed chain sends text files to LlamaParse first: every upload gets its own text, so no two versions are content duplicates.
  harness.llama.enqueue(
    ...Array.from({ length: 200 }, (_, index) => ({
      pages: [{ page_number: 1, success: true, markdown: `Archive page ${index}\n\nUnique backfill text number ${index} about drawer ${index}.` }],
    })),
  );
  // The CLI child stages originals in the edge's storage; the app routes here must read the same store, not the in-memory fake.
  const objectStore = await import('@/lib/rag/ingest/object-store');
  objectStore.resetObjectStoreForTests();
  const { scopeKey } = await import('@/lib/rag/tenant/scope');
  tenant = scopeKey(harness.scopeB).toLowerCase();
  assert.equal(tenant, `o:${QUEUED_IDS.orgB}`);
  const { fixtureProcessEnv } = await import('../../eval/harness/fake-edge.mts');
  serviceKey = String(fixtureProcessEnv(harness.edge.url).SUPABASE_SERVICE_ROLE_KEY);
  folder = await mkdtemp(path.join(os.tmpdir(), 'backfill-cli-'));
  await mkdir(path.join(folder, 'copies'));
  for (let index = 0; index < UNIQUE; index += 1) await writeFile(path.join(folder, `record-${String(index).padStart(2, '0')}.txt`), textFile(`record-${index}`));
  for (let index = 0; index < COPIES; index += 1) await writeFile(path.join(folder, 'copies', `record-${String(index).padStart(2, '0')}.txt`), textFile(`record-${index}`));
});

after(async () => {
  await harness?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('rag:backfill CLI: kill and resume (D-34, SC5)', () => {
  let batchId: string;

  test('a run killed mid-way with the sidecar resumes from --resume without reprocessing, within the batch concurrency', async () => {
    let maxLeased = 0;
    const sampler = setInterval(() => {
      harness
        .rows(
          "SELECT batch_id, count(*)::int AS n FROM ingestion_jobs WHERE batch_id IS NOT NULL AND status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding') AND lease_until > now() GROUP BY batch_id",
        )
        .then((rows) => {
          for (const row of rows) maxLeased = Math.max(maxLeased, Number(row.n));
        })
        .catch(() => undefined);
    }, 100);
    try {
      let worker = startWorker();
      const first = runCli(['--tenant', tenant, '--source', `folder:${folder}`, '--budget', '100', '--concurrency', '2']);
      await waitFor(async () => first.batchId() !== null, 120_000, 'the batch id');
      batchId = first.batchId() as string;
      await waitFor(async () => ((await counts(batchId, 'ingest')).ready ?? 0) >= 6, 400_000, '6 ready ingest jobs');
      first.kill();
      worker.kill();
      const killed = await first.done;
      assert.notEqual(killed.code, 0, 'the CLI was killed');
      await worker.done;

      const readyBefore = await harness.rows(
        "SELECT id, retries, jsonb_array_length(attempts) AS attempts, updated_at::text AS updated_at, document_id FROM ingestion_jobs WHERE batch_id = $1 AND kind = 'ingest' AND status = 'ready' ORDER BY id",
        [batchId],
      );
      assert.ok(readyBefore.length >= 6);
      assert.ok(readyBefore.length < UNIQUE, 'killed mid-run');
      const [batch] = await harness.rows('SELECT status FROM ingestion_batches WHERE id = $1', [batchId]);
      assert.equal(batch?.status, 'running');
      // The killed worker's leases run out (120 s in production; expired here so the test does not wait).
      await harness.rows("UPDATE ingestion_jobs SET lease_until = now() - interval '1 second' WHERE batch_id = $1 AND lease_until IS NOT NULL", [batchId]);

      worker = startWorker();
      const resumed = runCli(['--tenant', tenant, '--resume', batchId]);
      const result = await resumed.done;
      worker.kill();
      await worker.done;
      assert.equal(result.code, 0, `${result.out}\n${result.err}`);
      assert.match(result.out, /resuming batch/);

      const readyAfter = await harness.rows(
        'SELECT id, retries, jsonb_array_length(attempts) AS attempts, updated_at::text AS updated_at, document_id FROM ingestion_jobs WHERE id = ANY($1) ORDER BY id',
        [readyBefore.map((row) => row.id)],
      );
      assert.deepEqual(readyAfter, readyBefore, 'ready jobs are never processed again');
      assert.deepEqual(await counts(batchId, 'ingest'), { ready: UNIQUE, skipped_duplicate: COPIES }, 'duplicates stay skipped');
      const sample = await counts(batchId, 'dry_run');
      const sampleTotal = Object.values(sample).reduce((sum, n) => sum + n, 0);
      assert.ok(sampleTotal >= 1 && sample.ready === sampleTotal, JSON.stringify(sample));

      const [row] = await harness.rows('SELECT status, totals, dry_run_report FROM ingestion_batches WHERE id = $1', [batchId]);
      assert.equal(row?.status, 'completed');
      const totals = row?.totals as Row;
      assert.equal(totals.ingest_total, UNIQUE + COPIES, 'ingest counts reconcile with the inventory');
      assert.equal(totals.ready, UNIQUE, 'the sample never adds to ready');
      assert.equal(totals.skipped_duplicate, COPIES);
      assert.deepEqual(totals.sample, { total: sampleTotal, by_status: { ready: sampleTotal } });
      assert.equal(((row?.dry_run_report as Row).inventory as Row).files, UNIQUE);
      assert.match(result.out, new RegExp(`ingest jobs ${UNIQUE + COPIES}: ready ${UNIQUE}, skipped_duplicate ${COPIES}`));
      assert.match(result.out, new RegExp(`sample \\(dry runs, not ingested\\) ${sampleTotal}: ready ${sampleTotal}`));

      const docs = await harness.rows(
        "SELECT d.file_sha256, count(*)::int AS versions FROM documents d JOIN ingestion_jobs j ON j.document_id = d.id WHERE j.batch_id = $1 AND j.kind = 'ingest' GROUP BY d.file_sha256",
        [batchId],
      );
      assert.equal(docs.length, UNIQUE, 'one document per unique file');
      assert.ok(docs.every((doc) => doc.versions === 1));
      const [sampleDocs] = await harness.rows("SELECT count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND kind = 'dry_run' AND document_id IS NOT NULL", [
        batchId,
      ]);
      assert.equal(Number(sampleDocs?.n), 0, 'sample jobs leave no document row');
    } finally {
      clearInterval(sampler);
    }
    assert.ok(maxLeased <= 2, `batch concurrency exceeded: ${maxLeased}`);
    assert.ok(maxLeased >= 1);
  });

  test('--resume of a finished batch prints the end report and exits 0 without enqueuing', async () => {
    assert.ok(batchId, 'the first case ran');
    const [before] = await harness.rows('SELECT count(*)::int AS n, max(updated_at)::text AS updated FROM ingestion_jobs WHERE batch_id = $1', [batchId]);
    const enqueueCalls = harness.edge.calls.filter((call) => call.path.endsWith('/rag_enqueue_backfill_jobs')).length;
    const result = await runCli(['--tenant', tenant, '--resume', batchId]).done;
    assert.equal(result.code, 0, `${result.out}\n${result.err}`);
    assert.match(result.out, new RegExp(`ingest jobs ${UNIQUE + COPIES}: ready ${UNIQUE}`));
    const [afterRow] = await harness.rows('SELECT count(*)::int AS n, max(updated_at)::text AS updated FROM ingestion_jobs WHERE batch_id = $1', [batchId]);
    assert.deepEqual(afterRow, before, 'no job added or touched');
    assert.equal(harness.edge.calls.filter((call) => call.path.endsWith('/rag_enqueue_backfill_jobs')).length, enqueueCalls);
    assert.equal(harness.edge.calls.filter((call) => /activate_embedding_profile/.test(call.path)).length, 0, 'no profile activation');
  });
});
