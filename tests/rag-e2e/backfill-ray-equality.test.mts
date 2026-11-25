/**
 * SC5 runner equality (D-34, D-37): the same fixture backfill through the real `rag:backfill` CLI with `--runner worker` (the always-on
 * sidecar worker) and with `--runner ray` (the Ray runner on a local Ray instance) ends with equal ledger rows and equal chunk content,
 * keeps within the batch budget and concurrency, and a Ray run killed mid-way resumes without reprocessing a ready job.
 *
 * Opt-in: it runs only with RAG_TEST_RAY=1 and the ray extra synced into the sidecar environment (`uv sync --extra ray`), which the
 * optional `ray-optional` CI workflow does. Each runner backfills its own tenant of one database, so neither sees the other's knowledge
 * base: worker, ray, and ray killed and resumed each get an organization tenant. The premium page budget is 0, so no page is parsed
 * premium; a page that fails its check ends needs_review, and both runners must agree on that set (multi-column-en today).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUEUED_IDS, SIDECAR_SECRET, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';
import { spawnSidecarModule } from '../../eval/harness/sidecar-worker.mts';

type Row = Record<string, unknown>;
type Runner = 'worker' | 'ray';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SIDECAR_DIR = path.join(REPO_ROOT, 'rag-sidecar');
const CLI = path.join(REPO_ROOT, 'src/lib/rag/ingest/backfill/cli.ts');
const PARSE_ROOT = path.join(REPO_ROOT, 'eval', 'fixtures', 'parse');
const RECORDED_DIR = path.join(PARSE_ROOT, 'recorded');
const PDFS = ['digital-text', 'multi-column-en', 'table-en'] as const;
const TEXTS = 8;
const COPIES = 2;
const CONCURRENCY = 2;
const BUDGET_USD = 100;
const BATCH_ID = /batch ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ORG_WORKER = '00000000-0000-4000-8000-0000000000c3';
const ORG_RESUMED = '00000000-0000-4000-8000-0000000000c4';
const TERMINAL = ['ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate'];

/** Ledger columns that name the run rather than the result: ids, tenant, lease holder, runner and every timestamp (SC5). */
const RUN_COLUMNS = new Set([
  'id',
  'batch_id',
  'tenant_key',
  'document_id',
  'lineage_id',
  'original_ref',
  'preflight_ref',
  'stage_state',
  'locked_by',
  'runner',
  'lease_until',
  'run_after',
  'created_at',
  'updated_at',
  'dead_letter_at',
  'deleted_at',
  'timings',
]);
/** Attempt fields that are timings, or that depend on which files the batch-seeded sample parsed first (cache hits and their cost). */
const RUN_ATTEMPT_FIELDS = new Set(['ms', 'cache_hit', 'est_cost_usd']);

function skipReason(): string | false {
  if (process.env.RAG_TEST_RAY !== '1') return 'set RAG_TEST_RAY=1 with the ray extra synced in rag-sidecar (uv sync --extra ray) to run the Ray equality test';
  // --no-sync: the probe never installs anything; the environment must already carry the ray extra.
  const probe = spawnSync('uv', ['run', '--no-sync', '--project', SIDECAR_DIR, 'python', '-c', 'import ray'], { cwd: REPO_ROOT, stdio: 'ignore', timeout: 300_000 });
  return probe.status === 0 ? false : 'ray is not importable in the sidecar environment (run uv sync --extra ray in rag-sidecar)';
}

const SKIP = skipReason();
if (SKIP) console.log(`[Ray equality] skipped: ${SKIP}`);

let harness: QueuedHarness;
let folder: string;
let serviceKey: string;

interface CliRun {
  out(): string;
  kill(): void;
  done: Promise<{ code: number | null; out: string; err: string }>;
}

function runnerEnv(): Record<string, string> {
  return {
    RAG_APP_INTERNAL_URL: harness.app.url,
    RAG_SIDECAR_SECRET: SIDECAR_SECRET,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    RAG_INGEST_CONVERTER: 'recorded',
    RAG_INGEST_RECORDED_DIR: RECORDED_DIR,
    UV_OFFLINE: '1',
    UV_FROZEN: '1',
  };
}

function runCli(args: string[]): CliRun {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...runnerEnv(), RAG_SIDECAR_ENV: 'test' },
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
  return {
    out: () => out,
    kill: () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    },
    done: new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err }))),
  };
}

function startWorker(): { kill(): void; done: Promise<unknown> } {
  return spawnSidecarModule(
    'uvicorn',
    ['rag_sidecar.main:app', '--host', '127.0.0.1', '--port', '0', '--log-level', 'warning'],
    {
      ...runnerEnv(),
      RAG_INGEST_WORKER: 'on',
      RAG_INGEST_WORKER_CONCURRENCY: '4',
      RAG_INGEST_MAINTENANCE: 'off',
      NEXT_PUBLIC_SUPABASE_URL: harness.edge.url,
    },
    { timeoutMs: 900_000 },
  );
}

/** Ray processes a SIGKILLed driver leaves behind would keep claiming; stop them (best effort, ignored without the ray CLI). */
function stopRay(): void {
  spawnSync('uv', ['run', '--no-sync', '--project', SIDECAR_DIR, 'ray', 'stop', '--force'], { cwd: REPO_ROOT, stdio: 'ignore', timeout: 120_000 });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function batchIdOf(out: string): string {
  const id = BATCH_ID.exec(out)?.[1];
  assert.ok(id, `no batch id in the CLI output:\n${out}`);
  return id;
}

/** Runs a whole backfill for one tenant with one runner and returns its batch id; samples the batch's live leases meanwhile. */
async function backfill(tenant: string, runner: Runner, samples: LeaseSamples): Promise<string> {
  const worker = runner === 'worker' ? startWorker() : null;
  const sampler = sampleLeases(samples);
  try {
    const result = await runCli(['--tenant', tenant, '--source', `folder:${folder}`, '--budget', String(BUDGET_USD), '--concurrency', String(CONCURRENCY), '--runner', runner])
      .done;
    assert.equal(result.code, 0, `${runner} backfill failed:\n${result.out}\n${result.err}`);
    return batchIdOf(result.out);
  } finally {
    clearInterval(sampler);
    worker?.kill();
    await worker?.done;
  }
}

interface LeaseSamples {
  counts: number[];
  /** `runner` and the lease holder's prefix of every leased job seen; a terminal transition clears both, so they are sampled live. */
  holders: Set<string>;
}

function sampleLeases(samples: LeaseSamples): NodeJS.Timeout {
  return setInterval(() => {
    harness
      .rows(
        "SELECT batch_id, count(*)::int AS n, array_agg(DISTINCT runner || '|' || split_part(locked_by, ':', 1)) AS holders FROM ingestion_jobs WHERE batch_id IS NOT NULL AND status IN ('preflight', 'parsing', 'checking', 'chunking', 'embedding') AND lease_until > now() GROUP BY batch_id",
      )
      .then((rows) => {
        for (const row of rows) {
          samples.counts.push(Number(row.n));
          for (const holder of (row.holders as string[] | null) ?? []) samples.holders.add(holder);
        }
      })
      .catch(() => undefined);
  }, 100);
}

function withoutRunFields(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (RUN_COLUMNS.has(key)) continue;
    if (key === 'attempts' && Array.isArray(value)) {
      out.attempts = value.map((attempt) => Object.fromEntries(Object.entries(attempt as Row).filter(([field]) => !RUN_ATTEMPT_FIELDS.has(field))));
      continue;
    }
    if (key === 'est_cost_usd') continue;
    out[key] = value;
  }
  return JSON.parse(JSON.stringify(out).replace(UUID_IN_TEXT, '<uuid>')) as Row;
}

/** Ingest rows by source key without the run's fields; the sample (dry runs) by status, since the batch id seeds which files it takes. */
async function ledger(batchId: string, options: { keepRetries?: boolean } = {}): Promise<{ ingest: Record<string, Row>; sample: Record<string, number> }> {
  const rows = await harness.rows("SELECT * FROM ingestion_jobs WHERE batch_id = $1 AND kind = 'ingest' ORDER BY source_key", [batchId]);
  const ingest: Record<string, Row> = {};
  for (const row of rows) {
    const clean = withoutRunFields(row);
    if (!options.keepRetries) {
      delete clean.retries;
      delete clean.attempts;
    }
    ingest[String(row.source_key)] = clean;
  }
  const sample: Record<string, number> = {};
  for (const row of await harness.rows("SELECT status, count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND kind = 'dry_run' GROUP BY status", [batchId])) {
    sample[String(row.status)] = Number(row.n);
  }
  return { ingest, sample };
}

/** Per source key, the content hashes of the document's chunks in chunk order. */
async function chunkHashes(batchId: string): Promise<Record<string, string[]>> {
  const rows = await harness.rows(
    `SELECT j.source_key, c.chunk_index, c.content
       FROM ingestion_jobs j JOIN document_chunks c ON c.document_id = j.document_id
      WHERE j.batch_id = $1 AND j.kind = 'ingest'
      ORDER BY j.source_key, c.chunk_index`,
    [batchId],
  );
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    const key = String(row.source_key);
    (out[key] ??= []).push(createHash('sha256').update(String(row.content)).digest('hex'));
  }
  return out;
}

async function batchRow(batchId: string): Promise<Row> {
  const [row] = await harness.rows('SELECT status, budget_usd::float8 AS budget_usd, spent_usd::float8 AS spent_usd, totals FROM ingestion_batches WHERE id = $1', [batchId]);
  assert.ok(row, `batch ${batchId}`);
  return row;
}

async function readyCount(batchId: string): Promise<number> {
  const [row] = await harness.rows("SELECT count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND kind = 'ingest' AND status = 'ready'", [batchId]);
  return Number(row?.n ?? 0);
}

function textFile(index: number): Buffer {
  return Buffer.from(
    `# Archive record ${index}\n\nRecord ${index} describes how drawer ${index} of the archive is labelled, checked and returned.\n\n## Checks\n\nThe clerk checks drawer ${index} every ${index + 2} days.\n`,
    'utf8',
  );
}

describe('rag:backfill: --runner ray equals --runner worker (SC5)', { skip: SKIP }, () => {
  const tenants = { worker: '', ray: '', resumed: '' };
  const batches = { worker: '', ray: '', resumed: '' };
  const leased: Record<'worker' | 'ray', LeaseSamples> = { worker: { counts: [], holders: new Set() }, ray: { counts: [], holders: new Set() } };

  before(async () => {
    harness = await startQueuedHarness({ env: { RAG_PARSE_ROUTING: 'tiered', RAG_PARSE_PREMIUM_PAGE_BUDGET: '0' } });
    // The CLI and the runners read and write originals and cache objects over HTTP; the app routes must use the same store.
    (await import('@/lib/rag/ingest/object-store')).resetObjectStoreForTests();
    // Backfill tenants are organizations here: the fake edge has no auth admin API for the personal-tenant lookup.
    for (const [id, slug] of [
      [ORG_WORKER, 'ray-equality-worker'],
      [ORG_RESUMED, 'ray-equality-resumed'],
    ] as const) {
      await harness.rows('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $2, $3, false)', [id, slug, QUEUED_IDS.userA]);
      await harness.rows("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [id, QUEUED_IDS.userA]);
    }
    tenants.worker = `o:${ORG_WORKER}`;
    tenants.ray = `o:${QUEUED_IDS.orgB}`;
    tenants.resumed = `o:${ORG_RESUMED}`;
    const { fixtureProcessEnv } = await import('../../eval/harness/fake-edge.mts');
    serviceKey = String(fixtureProcessEnv(harness.edge.url).SUPABASE_SERVICE_ROLE_KEY);

    folder = await mkdtemp(path.join(os.tmpdir(), 'backfill-ray-'));
    await mkdir(path.join(folder, 'notes'));
    await mkdir(path.join(folder, 'copies'));
    await mkdir(path.join(folder, 'pdf'));
    for (let index = 0; index < TEXTS; index += 1) {
      const ext = index % 2 === 0 ? 'txt' : 'md';
      await writeFile(path.join(folder, 'notes', `record-${String(index).padStart(2, '0')}.${ext}`), textFile(index));
    }
    for (let index = 0; index < COPIES; index += 1) await writeFile(path.join(folder, 'copies', `record-${String(index * 2).padStart(2, '0')}.txt`), textFile(index * 2));
    for (const id of PDFS) await copyFile(path.join(PARSE_ROOT, 'pdf', `${id}.pdf`), path.join(folder, 'pdf', `${id}.pdf`));
  });

  after(async () => {
    stopRay();
    await harness?.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  test('the worker and the Ray runner end with equal ledger rows, equal chunks, the same needs_review set, within budget and concurrency', { timeout: 1_800_000 }, async () => {
    batches.worker = await backfill(tenants.worker, 'worker', leased.worker);
    batches.ray = await backfill(tenants.ray, 'ray', leased.ray);

    const byWorker = await ledger(batches.worker, { keepRetries: true });
    const byRay = await ledger(batches.ray, { keepRetries: true });
    assert.equal(Object.keys(byWorker.ingest).length, TEXTS + COPIES + PDFS.length, 'one ingest job per inventoried file');
    assert.ok(Object.values(byWorker.ingest).every((row) => TERMINAL.includes(String(row.status))), JSON.stringify(byWorker.ingest));
    assert.deepEqual(byRay.ingest, byWorker.ingest, 'ingest ledger rows are equal apart from ids, runner, lease holder and timings');
    assert.deepEqual(byRay.sample, byWorker.sample, 'the dry-run sample ends the same');

    assert.deepEqual([...leased.ray.holders], ['ray|ray'], 'every job of the Ray batch was claimed by a Ray actor with runner ray');
    assert.ok(![...leased.worker.holders].some((holder) => holder.startsWith('ray')), 'the worker batch never ran on Ray');

    assert.deepEqual(await chunkHashes(batches.ray), await chunkHashes(batches.worker), 'chunk content hashes are equal');

    const review = (rows: Record<string, Row>) =>
      Object.entries(rows)
        .filter(([, row]) => row.status === 'needs_review')
        .map(([key, row]) => [key, row.needs_review_reason]);
    assert.deepEqual(review(byRay.ingest), review(byWorker.ingest), 'the same documents end needs_review, for the same reason, under both runners');

    for (const runner of ['worker', 'ray'] as const) {
      const row = await batchRow(batches[runner]);
      assert.equal(row.status, 'completed', `${runner} batch`);
      assert.ok(Number(row.spent_usd) <= Number(row.budget_usd), `${runner} batch spent ${String(row.spent_usd)} of ${String(row.budget_usd)}`);
      const counts = leased[runner].counts;
      assert.ok(counts.length > 0 && Math.max(...counts) <= CONCURRENCY, `${runner} batch concurrency: ${Math.max(0, ...counts)}`);
    }
    assert.equal((await batchRow(batches.ray)).spent_usd, (await batchRow(batches.worker)).spent_usd, 'both runners spent the same');
  });

  test('a Ray run killed mid-way resumes with --resume without reprocessing a ready job and ends like the worker run', { timeout: 1_800_000 }, async () => {
    assert.ok(batches.worker, 'the worker batch ran');
    const first = runCli([
      '--tenant',
      tenants.resumed,
      '--source',
      `folder:${folder}`,
      '--budget',
      String(BUDGET_USD),
      '--concurrency',
      '1',
      '--runner',
      'ray',
    ]);
    await waitFor(async () => BATCH_ID.test(first.out()), 300_000, 'the batch id');
    batches.resumed = batchIdOf(first.out());
    await waitFor(async () => (await readyCount(batches.resumed)) >= 3, 900_000, '3 ready ingest jobs');
    first.kill();
    const killed = await first.done;
    assert.notEqual(killed.code, 0, 'the CLI was killed');
    stopRay();

    const readyBefore = await harness.rows(
      "SELECT id, retries, jsonb_array_length(attempts) AS attempts, updated_at::text AS updated_at, document_id FROM ingestion_jobs WHERE batch_id = $1 AND kind = 'ingest' AND status = 'ready' ORDER BY id",
      [batches.resumed],
    );
    assert.ok(readyBefore.length >= 3);
    assert.ok(readyBefore.length < TEXTS + PDFS.length, 'killed mid-run');
    // The killed runner's leases run out (120 s in production; expired here so the test does not wait).
    await harness.rows("UPDATE ingestion_jobs SET lease_until = now() - interval '1 second' WHERE batch_id = $1 AND lease_until IS NOT NULL", [batches.resumed]);

    const resumed = await runCli(['--tenant', tenants.resumed, '--resume', batches.resumed, '--runner', 'ray']).done;
    assert.equal(resumed.code, 0, `${resumed.out}\n${resumed.err}`);
    assert.match(resumed.out, /resuming batch/);

    const readyAfter = await harness.rows(
      'SELECT id, retries, jsonb_array_length(attempts) AS attempts, updated_at::text AS updated_at, document_id FROM ingestion_jobs WHERE id = ANY($1) ORDER BY id',
      [readyBefore.map((row) => row.id)],
    );
    assert.deepEqual(readyAfter, readyBefore, 'ready jobs are never processed again');

    // A job in flight at the kill was reclaimed once more, so its retries and attempts may differ; the result may not.
    assert.deepEqual((await ledger(batches.resumed)).ingest, (await ledger(batches.worker)).ingest, 'the resumed Ray batch ends like the worker batch');
    assert.deepEqual(await chunkHashes(batches.resumed), await chunkHashes(batches.worker), 'and with the same chunks');
    const row = await batchRow(batches.resumed);
    assert.equal(row.status, 'completed');
    assert.ok(Number(row.spent_usd) <= Number(row.budget_usd));
  });
});
