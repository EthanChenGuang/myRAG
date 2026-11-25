/**
 * Progressive mode (D-30, A-9, F-10): a provisional fast-tier version first, then the routed version, and the same-lineage duplicate
 * rule. The eligibility rule runs in the real sidecar module, rag_clear_provisional in PGlite, the provisional advance through the
 * app's callback route.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIngestAppServer, type IngestAppServer, type IngestRouteHandler } from '../../eval/harness/ingest-app-server.mts';
import { pdfBytes, startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';
import { spawnSidecarModule } from '../../eval/harness/sidecar-worker.mts';

type Row = Record<string, unknown>;
type Tier = 'fast' | 'structured' | 'premium';

const WORKER = 'progressive-test-worker';
const OPTIONS_HASH = 'd'.repeat(64);
const TERMINAL = new Set(['ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate']);

const SETTINGS = {
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
  progressive: true,
  routing: 'tiered',
  routing_config_version: '1',
  vlm_detect: false,
  vlm_model: null,
};

const PRESET: Record<Tier, string> = { fast: 'fast', structured: 'structured_full', premium: 'premium' };

/** A preflight result with one entry per page: its tier and whether it has a usable text layer. */
function preflight(pages: Array<{ tier: Tier; textLayer: boolean }>): Row {
  const counts: Record<string, number> = { native: 0, fast: 0, structured: 0, premium: 0 };
  for (const page of pages) counts[page.tier] = (counts[page.tier] ?? 0) + 1;
  return {
    probe_version: 'test',
    page_count: pages.length,
    encrypted: false,
    doc_class: 'tables',
    pages: pages.map((page, index) => ({
      page: index + 1,
      chars: page.textLayer ? 400 : 0,
      text_layer: page.textLayer,
      image_area_ratio: page.textLayer ? 0 : 1,
      ruled_tables: page.tier === 'structured' ? 1 : 0,
      aligned_number_rows: 0,
      multi_column: false,
      has_figure: false,
      scanned: !page.textLayer,
      garbled_ratio: 0,
      signals: page.tier === 'structured' ? ['tables'] : [],
      layer: 'L1',
      tier: page.tier,
      preset: PRESET[page.tier],
      continues_to_next: false,
    })),
    ranges: pages.map((page, index) => ({
      start: index + 1,
      end: index + 1,
      tier: page.tier,
      preset: PRESET[page.tier],
      parser: 'docling',
      layer: 'L1',
      signals: [],
      status: 'pending',
      cache_id: null,
    })),
    tier_page_counts: counts,
    detect_counts: { L1: pages.length, L2: 0, L3: 0, gated_share: 0 },
    timings_ms: {},
  };
}

/** The shape of the mixed-routing fixture: pages 7-8 hold tables, page 9 is a scan with no text layer. */
const MIXED = preflight(
  Array.from({ length: 10 }, (_, index) => {
    const page = index + 1;
    if (page === 7 || page === 8) return { tier: 'structured' as const, textLayer: true };
    if (page === 9) return { tier: 'structured' as const, textLayer: false };
    return { tier: 'fast' as const, textLayer: true };
  }),
);

async function eligibility(cases: Array<{ preflight: Row; settings: Row; kind: string }>): Promise<boolean[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'progressive-eligible-'));
  try {
    const file = path.join(dir, 'cases.json');
    writeFileSync(file, JSON.stringify(cases));
    const run = await spawnSidecarModule('rag_sidecar.ingest.progressive', ['--cases', file], { UV_OFFLINE: '1', UV_FROZEN: '1' }, { timeoutMs: 120_000 }).done;
    assert.equal(run.exitCode, 0, `stderr: ${run.stderr.slice(-2000)}`);
    return JSON.parse(run.stdout.trim().split('\n').at(-1) ?? 'null') as boolean[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : '';
}

/** One database, edge and app for the file: the Supabase admin client is a process singleton bound to the first edge. */
let harness: QueuedHarness;

before(async () => {
  harness = await startQueuedHarness({ env: { RAG_PARSE_ROUTING: 'tiered', RAG_PARSE_PROGRESSIVE: 'true' } });
  // The worker reads the original and writes its cache objects over HTTP, so the app uses the edge-backed store as well.
  (await import('@/lib/rag/ingest/object-store')).resetObjectStoreForTests();
});

after(async () => {
  await harness?.close();
});

describe('progressive eligibility (D-30), in the sidecar module', () => {
  test('backfill never, all-fast never, under half text layer never, the mixed fixture yes', async () => {
    const allFast = preflight(Array.from({ length: 6 }, () => ({ tier: 'fast' as const, textLayer: true })));
    const mostlyScanned = preflight(
      Array.from({ length: 10 }, (_, index) => ({ tier: 'structured' as const, textLayer: index < 4 })),
    );
    const halfScanned = preflight(
      Array.from({ length: 10 }, (_, index) => ({ tier: index < 5 ? ('fast' as const) : ('structured' as const), textLayer: index < 5 })),
    );
    const results = await eligibility([
      { preflight: MIXED, settings: SETTINGS, kind: 'incremental' },
      { preflight: MIXED, settings: SETTINGS, kind: 'backfill' },
      { preflight: allFast, settings: SETTINGS, kind: 'incremental' },
      { preflight: mostlyScanned, settings: SETTINGS, kind: 'incremental' },
      { preflight: halfScanned, settings: SETTINGS, kind: 'incremental' },
      { preflight: MIXED, settings: { ...SETTINGS, progressive: false }, kind: 'incremental' },
    ]);
    assert.deepEqual(results, [true, false, false, false, true, false]);
  });
});

describe('provisional publish and rag_clear_provisional', () => {
  let enqueue: typeof import('@/lib/rag/ingest/enqueue').enqueueIngest;
  let queueConfig: typeof import('@/lib/rag/ingest/queue-config');
  const flagged: { jobId?: string; documentId?: string } = {};

  before(async () => {
    enqueue = (await import('@/lib/rag/ingest/enqueue')).enqueueIngest;
    queueConfig = await import('@/lib/rag/ingest/queue-config');
  });

  async function upload(scope: QueuedHarness['scopeA'], label: string): Promise<{ jobId: string; documentId: string }> {
    // Fixed routing: the test plays the worker through the chain parse, which needs no converter.
    const config = queueConfig.queueConfigFromProcessEnv();
    const queued = await enqueue(
      {
        scope,
        source: 'config_upload',
        sourceKey: `root/${label}.pdf`,
        file: pdfBytes(label),
        filename: `${label}.pdf`,
        mimeType: 'application/pdf',
        docType: 'general',
        signal: new AbortController().signal,
      },
      { queueConfig: () => ({ ...config, parseRouting: 'fixed' }) },
    );
    assert.equal(queued.status, 'queued');
    return { jobId: String(queued.jobId), documentId: String(queued.documentId) };
  }

  /** Plays the worker: the chain parse, then advance with the given provisional flag until the app says done. */
  async function parseAndAdvance(jobId: string, provisional: boolean): Promise<Row> {
    await harness.claim(jobId, WORKER);
    return harness.withHeartbeat(jobId, WORKER, async () => {
      const parsed = await harness.callback(jobId, 'parse-external', { worker_id: WORKER, attempt_no: 1, mode: 'chain', options_hash: OPTIONS_HASH });
      assert.equal(parsed.status, 200, JSON.stringify(parsed.body));
      assert.equal(parsed.body.status, 'done');
      let cursor: string | null = null;
      for (let call = 0; call < 50; call += 1) {
        const reply = await harness.callback(jobId, 'advance', {
          worker_id: WORKER,
          attempt_no: 1,
          phase: 'post_parse',
          parse_cache_id: parsed.body.cache_id,
          deadline_ms: 40_000,
          cursor,
          provisional,
        });
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        if (reply.body.done === true) return reply.body;
        cursor = String(reply.body.stage);
      }
      throw new Error('advance did not finish');
    });
  }

  test('advance with provisional true marks the version and its chunks provisional, sets provisional_published_at and keeps the job open', async () => {
    const queued = await upload(harness.scopeA, 'progressive-flag');
    Object.assign(flagged, queued);
    const settings = (await harness.rows('SELECT settings FROM ingestion_jobs WHERE id = $1', [queued.jobId]))[0]?.settings as Row;
    assert.equal(settings.progressive, true, 'the snapshot carries RAG_PARSE_PROGRESSIVE');

    const reply = await parseAndAdvance(queued.jobId, true);
    assert.equal(reply.done, true);
    assert.equal(reply.stage, 'provisional');
    assert.equal(reply.status ?? null, null, 'a provisional publish is not a terminal status');

    const [job] = await harness.rows('SELECT status, stage, provisional_published_at, document_id, stage_state, locked_by FROM ingestion_jobs WHERE id = $1', [queued.jobId]);
    assert.ok(job);
    assert.ok(!TERMINAL.has(String(job.status)), `the job stays non-terminal, got ${String(job.status)}`);
    assert.equal(job.stage, 'parse', 'the routed run starts again at parse');
    assert.ok(job.provisional_published_at, 'provisional_published_at is set');
    assert.equal(job.document_id, queued.documentId);
    assert.equal((job.stage_state as Row).cursor ?? null, null, 'the routed run starts with no post-parse position');
    assert.equal(job.locked_by, WORKER, 'the worker keeps its lease for the routed run');

    const [document] = await harness.rows('SELECT status, is_current, provisional FROM documents WHERE id = $1', [queued.documentId]);
    assert.deepEqual(document, { status: 'ready', is_current: true, provisional: true });
    const chunks = await harness.rows('SELECT provisional, is_current FROM document_chunks WHERE document_id = $1', [queued.documentId]);
    assert.ok(chunks.length >= 1, 'the provisional version has chunks');
    assert.ok(chunks.every((chunk) => chunk.provisional === true && chunk.is_current === true));
  });

  test('a job of a backfill batch or without the progressive snapshot is refused a provisional publish', async () => {
    const queued = await upload(harness.scopeA, 'progressive-refused');
    await harness.db.query(`UPDATE ingestion_jobs SET settings = jsonb_set(settings, '{progressive}', 'false') WHERE id = $1`, [queued.jobId]);
    await harness.claim(queued.jobId, WORKER);
    const reply = await harness.callback(queued.jobId, 'advance', {
      worker_id: WORKER,
      attempt_no: 1,
      phase: 'post_parse',
      parse_cache_id: '00000000-0000-4000-8000-000000000000',
      deadline_ms: 40_000,
      cursor: null,
      provisional: true,
    });
    assert.equal(reply.status, 409, JSON.stringify(reply.body));
    assert.equal(reply.body.error, 'provisional_not_allowed');
  });

  test('rag_clear_provisional clears the current version of the job and its chunks only, within the job tenant', async () => {
    assert.ok(flagged.jobId && flagged.documentId, 'the first test published a provisional version');
    const other = await upload(harness.scopeB, 'progressive-other-tenant');
    await harness.db.query(`UPDATE documents SET provisional = true WHERE id = $1`, [other.documentId]);

    const cleared = (await harness.rows('SELECT * FROM rag_clear_provisional($1)', [flagged.jobId]))[0];
    assert.ok(cleared);
    assert.equal(cleared.document_id, flagged.documentId);

    const [document] = await harness.rows('SELECT provisional, is_current, status FROM documents WHERE id = $1', [flagged.documentId]);
    assert.deepEqual(document, { provisional: false, is_current: true, status: 'ready' });
    const chunks = await harness.rows('SELECT provisional FROM document_chunks WHERE document_id = $1', [flagged.documentId]);
    assert.ok(chunks.length >= 1 && chunks.every((chunk) => chunk.provisional === false));
    const [otherDocument] = await harness.rows('SELECT provisional FROM documents WHERE id = $1', [other.documentId]);
    assert.equal(otherDocument?.provisional, true, 'another tenant keeps its flag');
  });

  test('rag_clear_provisional raises 22023 for a job that never published provisionally', async () => {
    const plain = await upload(harness.scopeB, 'progressive-plain');
    const error = await harness.db.query('SELECT * FROM rag_clear_provisional($1)', [plain.jobId]).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error, 'the call is refused');
    assert.equal(sqlState(error), '22023');
  });

  test('anon and authenticated get 42501 on rag_clear_provisional', async () => {
    assert.ok(flagged.jobId);
    for (const role of ['anon', 'authenticated']) {
      await harness.db.exec(`SET ROLE ${role}`);
      let error: unknown = null;
      try {
        await harness.db.query('SELECT * FROM rag_clear_provisional($1)', [flagged.jobId]);
      } catch (caught) {
        error = caught;
      } finally {
        await harness.db.exec('RESET ROLE');
      }
      assert.ok(error, `${role} is refused`);
      assert.equal(sqlState(error), '42501', `${role}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PARSE_ROOT = path.join(ROOT, 'eval', 'fixtures', 'parse');
const RECORDED_DIR = path.join(PARSE_ROOT, 'recorded');
const MIXED_PDF = new Uint8Array(readFileSync(path.join(PARSE_ROOT, 'pdf', 'mixed-routing.pdf')));
const MIXED_SHA = '1ae7eaff14736765335fab82e5e214501c088cf403ad52b1500183128e819605';
const MIXED_QUERY = 'Digital narrative on page 3 for mixed routing coverage.';

/** A Docling JSON whose body and furniture keep only the child references that resolve. */
function withResolvableRefs(doc: Row): Row {
  const resolves = (ref: unknown): boolean => {
    const match = /^#\/(\w+)\/(\d+)$/.exec(String(ref));
    if (!match) return true;
    const items = doc[match[1] as string];
    return Array.isArray(items) && Number(match[2]) < items.length;
  };
  for (const key of ['body', 'furniture']) {
    const node = doc[key] as Row | undefined;
    if (node && Array.isArray(node.children)) node.children = (node.children as Row[]).filter((child) => resolves(child.$ref));
  }
  return doc;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('progressive mode end to end: the worker, both callbacks and the ledger', () => {
  let proxy: IngestAppServer;
  let enqueue: typeof import('@/lib/rag/ingest/enqueue').enqueueIngest;
  let queueConfig: typeof import('@/lib/rag/ingest/queue-config');
  let rag: typeof import('@/lib/rag');
  let status: typeof import('@/lib/rag/ingest/status');
  let ledger: typeof import('@/lib/rag/ingest/ledger');
  let fetchRows: typeof import('@/lib/rag/context/fetch-rows');
  let mintScope: typeof import('@/lib/rag/tenant/scope').mintScope;
  let recordedDir: string;
  let sameTextDir: string;
  /** Armed for one job: the first routed-run advance call of that job waits here until the test has looked at the provisional state. */
  let gate: { jobId: string; reached: Deferred; release: Deferred } | null = null;

  before(async () => {
    enqueue = (await import('@/lib/rag/ingest/enqueue')).enqueueIngest;
    queueConfig = await import('@/lib/rag/ingest/queue-config');
    rag = await import('@/lib/rag');
    status = await import('@/lib/rag/ingest/status');
    ledger = await import('@/lib/rag/ingest/ledger');
    fetchRows = await import('@/lib/rag/context/fetch-rows');
    mintScope = (await import('@/lib/rag/tenant/scope')).mintScope;

    const parseExternal = (await import('@/app/api/internal/rag/ingest/jobs/[id]/parse-external/route')) as { POST: IngestRouteHandler };
    const advance = (await import('@/app/api/internal/rag/ingest/jobs/[id]/advance/route')) as { POST: IngestRouteHandler };
    proxy = await startIngestAppServer({
      'parse-external': parseExternal.POST,
      async advance(request, context) {
        const armed = gate;
        if (armed) {
          const { id } = await context.params;
          const body = (await request.clone().json()) as Row;
          const [job] = await harness.rows('SELECT provisional_published_at FROM ingestion_jobs WHERE id = $1', [id]);
          if (id === armed.jobId && body.provisional !== true && job?.provisional_published_at) {
            gate = null;
            armed.reached.resolve();
            await armed.release.promise;
          }
        }
        return advance.POST(request, context);
      },
    });

    // The recorded fast output of the scanned page 9 points its body at texts it does not have; the routed flow never reads it, the
    // provisional fast parse of the whole document does. The copy keeps only the references that resolve (an empty fast page).
    recordedDir = mkdtempSync(path.join(os.tmpdir(), 'progressive-recorded-'));
    cpSync(path.join(RECORDED_DIR, MIXED_SHA), path.join(recordedDir, MIXED_SHA), { recursive: true });
    const fastNine = path.join(recordedDir, MIXED_SHA, 'fast', 'page-9.json');
    writeFileSync(fastNine, JSON.stringify(withResolvableRefs(JSON.parse(readFileSync(fastNine, 'utf8')) as Row)));

    // The fast parse of pages 7-9 gives the same text as the routed parse: a copy of the recordings whose fast pages are the routed ones.
    sameTextDir = mkdtempSync(path.join(os.tmpdir(), 'progressive-same-text-'));
    cpSync(path.join(recordedDir, MIXED_SHA), path.join(sameTextDir, MIXED_SHA), { recursive: true });
    for (const [preset, page] of [['structured_full', 7], ['structured_full', 8], ['structured_ocr', 9]] as const) {
      copyFileSync(path.join(recordedDir, MIXED_SHA, preset, `page-${page}.json`), path.join(sameTextDir, MIXED_SHA, 'fast', `page-${page}.json`));
    }
  });

  after(async () => {
    gate?.release.resolve();
    await proxy?.close();
    for (const dir of [recordedDir, sameTextDir]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A personal tenant of its own, so the same fixture can be uploaded once per case without the file-hash skip. */
  async function newTenant(): Promise<QueuedHarness['scopeA']> {
    const userId = randomUUID();
    await harness.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [userId, `progressive-${userId.slice(0, 8)}@example.invalid`]);
    return mintScope('personal', userId, null);
  }

  async function uploadMixed(
    scope: QueuedHarness['scopeA'],
    options: { progressive?: boolean; batchId?: string } = {},
  ): Promise<{ jobId: string; documentId: string }> {
    const config = queueConfig.queueConfigFromProcessEnv();
    const queued = await enqueue(
      {
        scope,
        source: 'config_upload',
        sourceKey: 'root/mixed-routing.pdf',
        file: MIXED_PDF,
        filename: 'mixed-routing.pdf',
        mimeType: 'application/pdf',
        docType: 'general',
        signal: new AbortController().signal,
      },
      {
        queueConfig: () => ({ ...config, parseProgressive: options.progressive ?? true }),
        ...(options.batchId ? { batchId: options.batchId } : {}),
      },
    );
    assert.equal(queued.status, 'queued');
    return { jobId: String(queued.jobId), documentId: String(queued.documentId) };
  }

  function runWorker(jobId: string, dir = recordedDir) {
    return harness.runWorker(jobId, {
      RAG_INGEST_CONVERTER: 'recorded',
      RAG_INGEST_RECORDED_DIR: dir,
      RAG_APP_INTERNAL_URL: proxy.url,
    });
  }

  function assertWorkerReady(worker: Awaited<ReturnType<QueuedHarness['runWorker']>>): void {
    assert.equal(worker.exitCode, 0, `worker stdout: ${worker.stdout.slice(-1000)} stderr: ${worker.stderr.slice(-3000)} edge: ${JSON.stringify(harness.edge.errors.slice(-3))}`);
    const summary = JSON.parse(worker.stdout.trim().split('\n').at(-1) ?? '{}') as Row;
    assert.equal(summary.status, 'ready');
  }

  async function lineageRows(documentId: string): Promise<Row[]> {
    return harness.rows(
      `SELECT d.id, d.version, d.status, d.is_current, d.provisional, d.superseded_by
         FROM documents d
        WHERE d.lineage_id = (SELECT lineage_id FROM documents WHERE id = $1)
        ORDER BY d.version`,
      [documentId],
    );
  }

  async function chunkFlags(documentId: string): Promise<Row[]> {
    return harness.rows('SELECT id, provisional, is_current, content FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [documentId]);
  }

  test('progressive on, mixed fixture: the provisional version is searchable and reported, then version 2 replaces it and version 1 still resolves', async () => {
    const scope = await newTenant();
    const queued = await uploadMixed(scope);
    gate = { jobId: queued.jobId, reached: deferred(), release: deferred() };
    const armed = gate;
    const running = runWorker(queued.jobId);
    const first = await Promise.race([armed.reached.promise.then(() => 'paused' as const), running.then(() => 'finished' as const)]);
    if (first !== 'paused') {
      armed.release.resolve();
      assertWorkerReady(await running);
      assert.fail('the worker finished without a routed run after a provisional publish');
    }

    try {
      const [job] = await harness.rows('SELECT status, provisional_published_at, document_id, attempts FROM ingestion_jobs WHERE id = $1', [queued.jobId]);
      assert.ok(job?.provisional_published_at, 'provisional_published_at is set after the provisional publish');
      assert.ok(!TERMINAL.has(String(job?.status)), 'the job is not terminal between the two publishes');
      assert.equal(job?.document_id, queued.documentId);
      assert.ok((job?.attempts as Row[]).some((attempt) => attempt.reason === 'progressive_fast' && (attempt.pages as Row).start === 1 && (attempt.pages as Row).end === 10));
      assert.deepEqual(
        (await lineageRows(queued.documentId)).map((row) => [row.version, row.status, row.is_current, row.provisional]),
        [[1, 'ready', true, true]],
      );
      const chunks = await chunkFlags(queued.documentId);
      assert.ok(chunks.length >= 1 && chunks.every((chunk) => chunk.provisional === true && chunk.is_current === true));

      const retrieved = await rag.runRetrieval({
        scope,
        query: MIXED_QUERY,
        profile: 'eval',
        options: { maxResults: 25, fallbackToLowerThreshold: true },
        signal: new AbortController().signal,
      });
      assert.ok(retrieved.candidates.some((candidate) => candidate.document_id === queued.documentId), 'retrieval returns the provisional chunks');

      const report = await status.getIngestStatusReport(scope, queued.documentId);
      assert.equal(report?.provisional, true, 'the document status reports provisional');
      assert.equal(report?.view.status, 'ready');
      assert.ok(report?.jobStatus && !TERMINAL.has(report.jobStatus));
      const owned = await ledger.getJobForScope(scope, queued.jobId, { signal: new AbortController().signal });
      assert.ok(owned?.provisional_published_at, 'the job status route reads provisional for the owner');
    } finally {
      armed.release.resolve();
    }

    assertWorkerReady(await running);
    const [job] = await harness.rows('SELECT status, document_id, provisional_published_at, page_ranges FROM ingestion_jobs WHERE id = $1', [queued.jobId]);
    assert.equal(job?.status, 'ready');
    assert.ok(job?.provisional_published_at);
    assert.equal((job?.page_ranges as Row[]).length, 4, 'the routed ranges are recorded');
    const versions = await lineageRows(queued.documentId);
    assert.deepEqual(
      versions.map((row) => [row.version, row.status, row.is_current, row.provisional]),
      [
        [1, 'ready', false, true],
        [2, 'ready', true, false],
      ],
    );
    const v2 = String(versions[1]?.id);
    assert.equal(job?.document_id, v2, 'the job ends on the routed version');
    assert.equal(versions[0]?.superseded_by, v2);
    const finalChunks = await chunkFlags(v2);
    assert.ok(finalChunks.length >= 1 && finalChunks.every((chunk) => chunk.provisional === false && chunk.is_current === true));
    assert.ok(finalChunks.some((chunk) => /\| Lane\s+\|\s+Value \| Status\s+\|/.test(String(chunk.content))), 'the routed version has the structured table');

    const oldChunks = await chunkFlags(queued.documentId);
    assert.ok(oldChunks.length >= 1, 'version 1 keeps its chunks');
    const admin = (await import('@/lib/supabase')).getSupabaseAdmin();
    const assembled = await fetchRows.fetchAssemblyRows(
      [{ chunk_id: String(oldChunks[0]?.id), document_id: queued.documentId }] as unknown as Parameters<typeof fetchRows.fetchAssemblyRows>[0],
      { adminClient: admin, signal: new AbortController().signal },
    );
    assert.ok(assembled.chunkMetadata.has(String(oldChunks[0]?.id)), 'a citation to version 1 still resolves');
  });

  test('same normalised text in the routed run: no version 2, flags cleared in place, job ready', async () => {
    const scope = await newTenant();
    const queued = await uploadMixed(scope);
    assertWorkerReady(await runWorker(queued.jobId, sameTextDir));
    const [job] = await harness.rows('SELECT status, document_id, provisional_published_at FROM ingestion_jobs WHERE id = $1', [queued.jobId]);
    assert.equal(job?.status, 'ready');
    assert.ok(job?.provisional_published_at, 'the job did publish provisionally');
    assert.equal(job?.document_id, queued.documentId, 'the job ends on the version it published');
    assert.deepEqual(
      (await lineageRows(queued.documentId)).map((row) => [row.version, row.status, row.is_current, row.provisional]),
      [[1, 'ready', true, false]],
    );
    const chunks = await chunkFlags(queued.documentId);
    assert.ok(chunks.length >= 1 && chunks.every((chunk) => chunk.provisional === false && chunk.is_current === true));
  });

  test('progressive off: one version, no provisional flags, no provisional_published_at', async () => {
    const scope = await newTenant();
    const queued = await uploadMixed(scope, { progressive: false });
    assertWorkerReady(await runWorker(queued.jobId));
    const [job] = await harness.rows('SELECT status, provisional_published_at, settings, attempts FROM ingestion_jobs WHERE id = $1', [queued.jobId]);
    assert.equal(job?.status, 'ready');
    assert.equal((job?.settings as Row).progressive, false);
    assert.equal(job?.provisional_published_at, null);
    assert.ok((job?.attempts as Row[]).every((attempt) => attempt.reason !== 'progressive_fast'));
    assert.deepEqual(
      (await lineageRows(queued.documentId)).map((row) => [row.version, row.status, row.is_current, row.provisional]),
      [[1, 'ready', true, false]],
    );
    assert.ok((await chunkFlags(queued.documentId)).every((chunk) => chunk.provisional === false));
  });

  test('a backfill job with progressive in the environment stays non-progressive', async () => {
    const scope = await newTenant();
    const batchId = randomUUID();
    const tenantKey = (await import('@/lib/rag/tenant/scope')).scopeKey(scope).toLowerCase();
    await harness.db.query(
      `INSERT INTO ingestion_batches (id, tenant_key, source_kind, source_ref, budget_usd, concurrency, runner, status)
       VALUES ($1, $2, 'folder', '/tmp/backfill', 100, 2, 'worker', 'pending')`,
      [batchId, tenantKey],
    );
    const queued = await uploadMixed(scope, { batchId });
    assertWorkerReady(await runWorker(queued.jobId));
    const [job] = await harness.rows('SELECT status, batch_id, provisional_published_at, attempts FROM ingestion_jobs WHERE id = $1', [queued.jobId]);
    assert.equal(job?.status, 'ready');
    assert.equal(job?.batch_id, batchId);
    assert.equal(job?.provisional_published_at, null);
    assert.ok((job?.attempts as Row[]).every((attempt) => attempt.reason !== 'progressive_fast'));
    assert.deepEqual(
      (await lineageRows(queued.documentId)).map((row) => [row.version, row.status, row.is_current, row.provisional]),
      [[1, 'ready', true, false]],
    );
  });
});
