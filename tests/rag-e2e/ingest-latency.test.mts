/**
 * D-45, SC4, SC5: the upload latency target, measured from the 202 of the upload route to a ready status read, with fake providers
 * and the always-on worker loop of the real sidecar app (uvicorn, RAG_INGEST_WORKER=on, concurrency 2, recorded converter).
 * Uploads go through the process-document route handler and status reads through the job status route, both inside a minimal
 * Next.js request scope so the cookie session and after() work as they do in the app.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { QueuedHarness } from '../../eval/harness/queued-ingest.mts';
import { spawnSidecarModule, type SpawnSidecarHandle } from '../../eval/harness/sidecar-worker.mts';
import { budgetSteps, formatLatencyReport, perStage, percentile, summarize, type LatencyRun } from './latency-stats.mts';

// Next.js creates its request stores from a global AsyncLocalStorage when its modules load; every Next import below is dynamic.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

describe('latency stats: nearest-rank percentiles and per-stage aggregation', () => {
  const oneToTwenty = Array.from({ length: 20 }, (_, index) => index + 1);

  test('stats: the nearest-rank p95 of 1..20 is 19 and the p50 is 10, in any input order', () => {
    assert.equal(percentile(oneToTwenty, 0.95), 19);
    assert.equal(percentile(oneToTwenty, 0.5), 10);
    assert.equal(percentile([...oneToTwenty].reverse(), 0.95), 19);
    assert.equal(percentile([7], 0.95), 7);
    assert.equal(percentile(oneToTwenty, 1), 20);
  });

  test('stats: an empty sample or a fraction outside (0, 1] throws', () => {
    assert.throws(() => percentile([], 0.95), /empty/);
    assert.throws(() => percentile([1, 2], 0), /fraction/);
    assert.throws(() => percentile([1, 2], 1.5), /fraction/);
  });

  test('stats: perStage gives p50 and p95 per stage name and ignores runs without that stage', () => {
    const timings = [
      ...oneToTwenty.map((value) => ({ parse: value * 10, chunk: value })),
      { embed: 5 },
      { embed: 7, parse: null },
      {},
    ];
    const stats = perStage(timings);
    assert.deepEqual(Object.keys(stats).sort(), ['chunk', 'embed', 'parse']);
    assert.deepEqual(stats.parse, { n: 20, p50: 100, p95: 190 });
    assert.deepEqual(stats.chunk, { n: 20, p50: 10, p95: 19 });
    assert.deepEqual(stats.embed, { n: 2, p50: 5, p95: 7 });
  });

  test('stats: budgetSteps groups one run under the RESEARCH latency budget names', () => {
    const steps = budgetSteps({
      routeMs: 40,
      pickupMs: 300,
      totalMs: 2_000,
      timings: { preflight: 10, parse: 200, check: 5, content_hash_dedup: 1, chunk: 30, embed: 20, publish: 9 },
    });
    assert.deepEqual(steps, {
      route: 40,
      pickup: 300,
      preflight: 10,
      parse: 200,
      check: 5,
      advance: 60,
      total: 2_000,
    });
    assert.deepEqual(budgetSteps({ routeMs: 1, pickupMs: 2, totalMs: 3, timings: { parse: 4 } }), {
      route: 1,
      pickup: 2,
      parse: 4,
      total: 3,
    });
  });
});

type Row = Record<string, unknown>;
type RouteHandler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PARSE_ROOT = path.join(ROOT, 'eval', 'fixtures', 'parse');
const BENCH_PDF = path.join(PARSE_ROOT, 'pdf', 'bench-100.pdf');
const BENCH_SHA = '5eb4e6a776e11143174d088f3bc9f1048cae8bd6792778e08b0b9ec8a4c0ee0c';
const BENCH_RECORDED = path.join(PARSE_ROOT, 'recorded', BENCH_SHA);
// bench-100 has tables on pages 10, 50 and 90; pages 11..30 are a 20-page digital text document.
const SLICE_FIRST = 11;
const SLICE_PAGES = 20;

const RUNS = 20;
const TARGET_P95_MS = 60_000;
const UPLOAD_DEADLINE_MS = 180_000;
const STATUS_POLL_MS = 250;
const BACKFILL_JOBS = 10;
const BACKFILL_PRIORITY = 10;
const BACKFILL_BATCH_CONCURRENCY = 2;
const CONVERTER_DELAY_MS = 1_000;
const BACKFILL_DEADLINE_MS = 900_000;
const WORKING = ['preflight', 'parsing', 'checking', 'chunking', 'embedding'];
const UV_ENV = { UV_OFFLINE: '1', UV_FROZEN: '1' };
const HELPER_ENV = { PYTHONPATH: HERE, PYTHONDONTWRITEBYTECODE: '1' };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

interface NextScope {
  workAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
  workUnitAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
  RequestCookies: new (headers: Headers) => unknown;
}

describe('upload latency through the route and the always-on worker (D-45, SC4, SC5)', () => {
  let harness: QueuedHarness;
  let tmp: string;
  let recordedDir: string;
  let slicePdf: Uint8Array;
  let benchPdf: Uint8Array;
  let next: NextScope;
  let uploadRoute: { POST: (request: Request) => Promise<Response> };
  let statusRoute: { GET: RouteHandler };
  let envModule: typeof import('@/lib/env');
  let queueConfig: typeof import('@/lib/rag/ingest/queue-config');
  let sidecar: { url: string; handle: SpawnSidecarHandle } | null = null;
  let sessionCookie: string;
  const originalFetch = globalThis.fetch;
  const ACCESS_TOKEN = `${base64Url('{"alg":"none","typ":"JWT"}')}.${base64Url('{"sub":"latency-user","role":"authenticated"}')}.sig`;
  let userId: string;
  const reports: string[] = [];

  before(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ingest-latency-'));
    recordedDir = path.join(tmp, 'recorded');
    mkdirSync(recordedDir);

    const slicePath = path.join(tmp, 'digital-20.pdf');
    const sliced = await spawnSidecarModule(
      'latency_sidecar',
      ['slice', BENCH_PDF, slicePath, String(SLICE_FIRST), String(SLICE_FIRST + SLICE_PAGES - 1)],
      { ...HELPER_ENV, ...UV_ENV },
      { timeoutMs: 180_000 },
    ).done;
    assert.equal(sliced.exitCode, 0, `slice failed: ${sliced.stderr.slice(-2000)}`);
    slicePdf = new Uint8Array(readFileSync(slicePath));
    benchPdf = new Uint8Array(readFileSync(BENCH_PDF));

    // Recordings of the slice: bench pages 11..30 become pages 1..20 of every preset bench-100 has.
    const sliceRecorded = path.join(tmp, 'slice-recorded');
    for (const preset of readdirSync(BENCH_RECORDED)) {
      mkdirSync(path.join(sliceRecorded, preset), { recursive: true });
      for (let page = 1; page <= SLICE_PAGES; page += 1) {
        const source = path.join(BENCH_RECORDED, preset, `page-${page + SLICE_FIRST - 1}.json`);
        if (existsSync(source)) copyFileSync(source, path.join(sliceRecorded, preset, `page-${page}.json`));
      }
    }

    const { startQueuedHarness, QUEUED_IDS } = await import('../../eval/harness/queued-ingest.mts');
    userId = QUEUED_IDS.userA;
    // The fixed runs go to the fake LlamaParse, one spec per upload in order; each names its upload so none is a content duplicate.
    const llamaSpecs = Array.from({ length: RUNS }, (_, run) => ({
      pages: Array.from({ length: SLICE_PAGES }, (_, index) => ({
        page_number: index + 1,
        success: true,
        markdown: `Section ${index + 1}\n\nDigital text of page ${index + 1} of upload ${run + 1} about the receiving dock and its pallets.`,
      })),
    }));
    harness = await startQueuedHarness({
      env: { RAG_PARSE_ROUTING: 'fixed', RAG_SIDECAR_URL: 'http://127.0.0.1:9' },
      llamaSpecs,
    });
    // The worker reads the original over HTTP, so the app writes it to the edge-backed Supabase store, not the in-memory fake.
    (await import('@/lib/rag/ingest/object-store')).resetObjectStoreForTests();

    // A fake GoTrue user endpoint for the cookie session: the fake edge serves no auth routes.
    const userUrl = `${harness.edge.url}/auth/v1/user`;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.split('?')[0] === userUrl) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (headers.get('authorization') !== `Bearer ${ACCESS_TOKEN}`) {
          return Response.json({ code: 401, msg: 'invalid token' }, { status: 401 });
        }
        return Response.json({ id: userId, aud: 'authenticated', role: 'authenticated', email: 'tenant-a@example.invalid' });
      }
      return originalFetch(input, init);
    };
    const session = {
      access_token: ACCESS_TOKEN,
      refresh_token: 'latency-refresh-token',
      token_type: 'bearer',
      expires_in: 86_400,
      expires_at: Math.floor(Date.now() / 1000) + 86_400,
      user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'tenant-a@example.invalid' },
    };
    const storageKey = `sb-${new URL(harness.edge.url).hostname.split('.')[0]}-auth-token`;
    sessionCookie = `${storageKey}=base64-${base64Url(JSON.stringify(session))}`;

    const workStorage = (await import('next/dist/server/app-render/work-async-storage.external.js')) as unknown as Pick<NextScope, 'workAsyncStorage'>;
    const unitStorage = (await import('next/dist/server/app-render/work-unit-async-storage.external.js')) as unknown as Pick<NextScope, 'workUnitAsyncStorage'>;
    const cookies = (await import('next/dist/server/web/spec-extension/cookies.js')) as unknown as Pick<NextScope, 'RequestCookies'>;
    next = { ...workStorage, ...unitStorage, ...cookies };

    uploadRoute = (await import('@/app/api/process-document/route')) as unknown as typeof uploadRoute;
    statusRoute = (await import('@/app/api/rag/ingest/jobs/[id]/route')) as unknown as typeof statusRoute;
    envModule = await import('@/lib/env');
    queueConfig = await import('@/lib/rag/ingest/queue-config');
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await stopSidecar();
    await harness?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    for (const report of reports) console.log(report);
  });

  /** Runs a route handler in a request scope with the session cookie; after() tasks start once the response is returned. */
  async function inRequest(handler: () => Promise<Response>): Promise<Response> {
    const tasks: Array<() => unknown> = [];
    const workStore = {
      route: '/api/ingest-latency-test',
      afterContext: {
        after(task: unknown) {
          tasks.push(typeof task === 'function' ? (task as () => unknown) : () => task);
        },
      },
    };
    const requestStore = { type: 'request', phase: 'render', cookies: new next.RequestCookies(new Headers({ cookie: sessionCookie })) };
    const response = await next.workAsyncStorage.run(workStore, () => next.workUnitAsyncStorage.run(requestStore, handler));
    for (const task of tasks) void Promise.resolve().then(task).catch(() => undefined);
    return response;
  }

  function useRouting(routing: 'fixed' | 'tiered'): void {
    process.env.RAG_PARSE_ROUTING = routing;
    (envModule.env as Record<string, string>).RAG_PARSE_ROUTING = routing;
    queueConfig.resetQueueConfigForTests();
  }

  /**
   * Distinct bytes per upload (a comment after %%EOF) so no upload is a file duplicate, and recordings whose page 1 names the upload
   * so none is a content duplicate either; every other recorded page links to the base recordings.
   */
  function variant(base: Uint8Array, label: string, recordings: string): Uint8Array {
    const bytes = new Uint8Array(Buffer.concat([Buffer.from(base), Buffer.from(`\n% ${label}\n`, 'utf8')]));
    const sha = createHash('sha256').update(bytes).digest('hex');
    for (const preset of readdirSync(recordings)) {
      const target = path.join(recordedDir, sha, preset);
      mkdirSync(target, { recursive: true });
      for (const page of readdirSync(path.join(recordings, preset))) {
        const source = path.join(recordings, preset, page);
        if (page !== 'page-1.json') {
          symlinkSync(source, path.join(target, page));
          continue;
        }
        const document = JSON.parse(readFileSync(source, 'utf8')) as { texts: Array<{ text: string; orig?: string }> };
        const first = document.texts[0];
        assert.ok(first, `${source} has a text item`);
        first.text = `${first.text} (${label})`;
        first.orig = first.text;
        writeFileSync(path.join(target, page), JSON.stringify(document));
      }
    }
    return bytes;
  }

  async function startSidecar(converterDelayMs: number): Promise<void> {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const env: Record<string, string> = {
      NEXT_PUBLIC_SUPABASE_URL: harness.edge.url,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      RAG_APP_INTERNAL_URL: harness.app.url,
      RAG_SIDECAR_SECRET: process.env.RAG_SIDECAR_SECRET ?? '',
      RAG_INGEST_WORKER: 'on',
      RAG_INGEST_WORKER_CONCURRENCY: '2',
      RAG_INGEST_CONVERTER: 'recorded',
      RAG_INGEST_RECORDED_DIR: recordedDir,
      ...UV_ENV,
    };
    const handle =
      converterDelayMs > 0
        ? spawnSidecarModule('latency_sidecar', ['serve', String(port)], { ...env, ...HELPER_ENV, LATENCY_CONVERTER_DELAY_MS: String(converterDelayMs) }, { timeoutMs: 3_600_000 })
        : spawnSidecarModule('uvicorn', ['rag_sidecar.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], env, { timeoutMs: 3_600_000 });
    let exited: { stderr: string } | null = null;
    void handle.done.then((result) => {
      exited = result;
    });
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (exited) throw new Error(`sidecar exited before it was ready: ${(exited as { stderr: string }).stderr.slice(-3000)}`);
      if (Date.now() > deadline) {
        handle.kill();
        throw new Error('sidecar did not become ready');
      }
      try {
        const response = await originalFetch(`${url}/ready`);
        const body = (await response.json()) as Row;
        if (response.ok && body.status === 'ready' && body.reason === 'worker_running') break;
      } catch {
        /* not listening yet */
      }
      await sleep(250);
    }
    sidecar = { url, handle };
    process.env.RAG_SIDECAR_URL = url;
    (envModule.env as Record<string, string>).RAG_SIDECAR_URL = url;
  }

  async function stopSidecar(): Promise<void> {
    if (!sidecar) return;
    const { handle } = sidecar;
    sidecar = null;
    handle.kill();
    await handle.done;
  }

  async function backfillInFlight(batchId: string): Promise<number> {
    const [row] = await harness.rows('SELECT count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND status = ANY($2)', [batchId, WORKING]);
    return Number(row?.n ?? 0);
  }

  /**
   * Holds the next upload until a backfill job has a slot. The worker claims a batch job only while both of its slots are free
   * (one slot stays free for jobs without a batch_id, D-23), so back-to-back uploads would otherwise run between backfill jobs.
   */
  async function untilBackfillRuns(batchId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await backfillInFlight(batchId)) > 0) return;
      const [left] = await harness.rows("SELECT count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND status = 'queued'", [batchId]);
      if (Number(left?.n ?? 0) === 0) return;
      await sleep(STATUS_POLL_MS);
    }
  }

  interface MeasuredUpload extends LatencyRun {
    jobId: string;
    routing: string;
    overlappedBackfill: boolean;
  }

  async function measureUpload(label: string, watchBatch?: string): Promise<MeasuredUpload> {
    const bytes = variant(slicePdf, label, path.join(tmp, 'slice-recorded'));
    const form = new FormData();
    form.set('file', new File([Buffer.from(bytes)], `${label}.pdf`, { type: 'application/pdf' }));
    const request = new Request('http://127.0.0.1/api/process-document', { method: 'POST', body: form });

    const started = performance.now();
    const response = await inRequest(() => uploadRoute.POST(request));
    const accepted = performance.now();
    const body = (await response.json()) as Row;
    assert.equal(response.status, 202, `upload ${label}: ${JSON.stringify(body)}`);
    assert.equal(body.status, 'queued');
    const jobId = String(body.jobId);

    let pickupMs: number | undefined;
    let overlappedBackfill = false;
    for (;;) {
      const read = await inRequest(() =>
        statusRoute.GET(new Request(`http://127.0.0.1/api/rag/ingest/jobs/${jobId}`), { params: Promise.resolve({ id: jobId }) }),
      );
      const now = performance.now();
      const status = (await read.json()) as Row;
      assert.equal(read.status, 200, `status of ${label}: ${JSON.stringify(status)}`);
      if (pickupMs === undefined && status.status !== 'queued') pickupMs = now - accepted;
      if (watchBatch && !overlappedBackfill && (await backfillInFlight(watchBatch)) > 0) overlappedBackfill = true;
      if (status.status === 'ready') {
        const [job] = await harness.rows("SELECT timings, settings->>'routing' AS routing FROM ingestion_jobs WHERE id = $1", [jobId]);
        return {
          jobId,
          routing: String(job?.routing),
          overlappedBackfill,
          routeMs: accepted - started,
          pickupMs: pickupMs ?? now - accepted,
          totalMs: now - accepted,
          timings: (job?.timings ?? {}) as Record<string, unknown>,
        };
      }
      assert.ok(
        !['failed', 'needs_review', 'quarantined', 'skipped_duplicate'].includes(String(status.status)),
        `upload ${label} ended ${String(status.status)} (${String(status.reason)})`,
      );
      assert.ok(now - accepted < UPLOAD_DEADLINE_MS, `upload ${label} was not ready after ${UPLOAD_DEADLINE_MS} ms (status ${String(status.status)})`);
      await sleep(STATUS_POLL_MS);
    }
  }

  async function measureRuns(name: string, routing: 'fixed' | 'tiered', watchBatch?: string): Promise<MeasuredUpload[]> {
    const runs: MeasuredUpload[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      if (watchBatch) await untilBackfillRuns(watchBatch, 30_000);
      runs.push(await measureUpload(`latency-${name}-${index + 1}`, watchBatch));
    }
    assert.ok(runs.every((run) => run.routing === routing), `every job snapshot carries ${routing} routing`);
    const report = formatLatencyReport(`[Ingest Latency] ${name} (${RUNS} runs, routing ${routing})`, runs);
    reports.push(report);
    return runs;
  }

  function assertTarget(name: string, runs: MeasuredUpload[]): void {
    const total = summarize(runs.map((run) => run.totalMs));
    assert.equal(total.n, RUNS);
    assert.ok(total.p95 <= TARGET_P95_MS, `${name}: p95 from 202 to ready is ${Math.round(total.p95)} ms, above ${TARGET_P95_MS} ms`);
  }

  test('fixed routing: 20 uploads of a 20-page digital PDF are ready within 60 s p95 of the 202', async () => {
    useRouting('fixed');
    if (!sidecar) await startSidecar(0);
    const runs = await measureRuns('fixed', 'fixed');
    assertTarget('fixed', runs);
    assert.ok(runs.every((run) => typeof run.timings.parse === 'number'), 'the parse stage is timed in the ledger');
  });

  test('tiered routing: 20 uploads of a 20-page digital PDF are ready within 60 s p95 of the 202', async () => {
    useRouting('tiered');
    if (!sidecar) await startSidecar(0);
    const runs = await measureRuns('tiered', 'tiered');
    assertTarget('tiered', runs);
    assert.ok(runs.every((run) => typeof run.timings.preflight === 'number' && typeof run.timings.parse === 'number'));
  });

  test('tiered routing beside ten slow backfill jobs: the uploads still meet 60 s p95 and every backfill job completes (SC5)', async () => {
    await stopSidecar();
    useRouting('tiered');
    const [batch] = await harness.rows(
      "INSERT INTO ingestion_batches (tenant_key, source_kind, source_ref, concurrency, status) VALUES ($1, 'manifest', 'ingest-latency', $2, 'running') RETURNING id",
      [`u:${userId}`, BACKFILL_BATCH_CONCURRENCY],
    );
    const batchId = String(batch?.id);
    const { enqueueIngest } = await import('@/lib/rag/ingest/enqueue');
    const backfillJobs: string[] = [];
    for (let index = 1; index <= BACKFILL_JOBS; index += 1) {
      const queued = await enqueueIngest(
        {
          scope: harness.scopeA,
          source: 'config_upload',
          sourceKey: `backfill/bench-${index}.pdf`,
          file: variant(benchPdf, `latency-backfill-${index}`, BENCH_RECORDED),
          filename: `bench-${index}.pdf`,
          mimeType: 'application/pdf',
          docType: 'general',
          signal: new AbortController().signal,
        },
        { priority: BACKFILL_PRIORITY, batchId },
      );
      assert.equal(queued.status, 'queued');
      backfillJobs.push(String(queued.jobId));
    }

    await startSidecar(CONVERTER_DELAY_MS);
    const runs = await measureRuns('tiered-with-backfill', 'tiered', batchId);
    const overlapped = runs.filter((run) => run.overlappedBackfill).length;
    assert.ok(overlapped >= RUNS * 0.9, `a backfill job was in flight during ${overlapped} of ${RUNS} uploads`);
    assertTarget('tiered beside a backfill', runs);

    const deadline = Date.now() + BACKFILL_DEADLINE_MS;
    let rows: Row[] = [];
    for (;;) {
      rows = await harness.rows('SELECT id, status, priority, timings FROM ingestion_jobs WHERE id = ANY($1)', [backfillJobs]);
      if (rows.every((row) => row.status === 'ready')) break;
      assert.ok(rows.every((row) => WORKING.includes(String(row.status)) || row.status === 'queued' || row.status === 'ready'), `backfill jobs: ${JSON.stringify(rows.map((row) => row.status))}`);
      assert.ok(Date.now() < deadline, `backfill jobs did not finish: ${JSON.stringify(rows.map((row) => row.status))}`);
      await sleep(1_000);
    }
    assert.equal(rows.length, BACKFILL_JOBS);
    assert.ok(rows.every((row) => row.priority === BACKFILL_PRIORITY));
  });
});
