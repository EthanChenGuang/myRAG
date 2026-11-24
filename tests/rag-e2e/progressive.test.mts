/**
 * Progressive mode (D-30, A-9, F-10): a provisional fast-tier version first, then the routed version, and the same-lineage duplicate
 * rule. The eligibility rule runs in the real sidecar module, rag_clear_provisional in PGlite, the provisional advance through the
 * app's callback route.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  let harness: QueuedHarness;
  let enqueue: typeof import('@/lib/rag/ingest/enqueue').enqueueIngest;
  const flagged: { jobId?: string; documentId?: string } = {};

  before(async () => {
    harness = await startQueuedHarness({ env: { RAG_PARSE_PROGRESSIVE: 'true' } });
    enqueue = (await import('@/lib/rag/ingest/enqueue')).enqueueIngest;
  });

  after(async () => {
    await harness?.close();
  });

  async function upload(scope: QueuedHarness['scopeA'], label: string): Promise<{ jobId: string; documentId: string }> {
    const queued = await enqueue({
      scope,
      source: 'config_upload',
      sourceKey: `root/${label}.pdf`,
      file: pdfBytes(label),
      filename: `${label}.pdf`,
      mimeType: 'application/pdf',
      docType: 'general',
      signal: new AbortController().signal,
    });
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
