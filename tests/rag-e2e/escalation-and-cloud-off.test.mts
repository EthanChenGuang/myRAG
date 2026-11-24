/**
 * SC1 (escalation clause) and SC2 through both services: the worker is the real sidecar module (recorded converter), the app
 * callbacks, the guard and the ledger are real; LlamaParse and the vision model are counting stubs.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { startQueuedHarness, type QueuedHarness } from '../../eval/harness/queued-ingest.mts';
import { startIngestAppServer, type IngestAppServer, type IngestRouteHandler } from '../../eval/harness/ingest-app-server.mts';
import type { DocType } from '@/lib/rag/ingest/profiles/load';
import type { QueueConfig } from '@/lib/rag/ingest/queue-config';

type Row = Record<string, unknown>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PARSE_ROOT = path.join(ROOT, 'eval', 'fixtures', 'parse');
const RECORDED_DIR = path.join(PARSE_ROOT, 'recorded');
const MANIFEST = JSON.parse(readFileSync(path.join(PARSE_ROOT, 'manifest.json'), 'utf8')) as {
  fixtures: Array<{ id: string; sha256: string; class: string; page_count: number }>;
};
const PREMIUM_TYPES = new Set<DocType>(['invoice_receipt', 'scanned_image']);
const GUARD_KEYS = ['RAG_PARSER_ALLOW_CLOUD', 'RAG_PARSE_PREMIUM_PAGE_BUDGET', 'RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC', 'RAG_PARSE_VLM_DETECT'] as const;

function fixture(id: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(PARSE_ROOT, 'pdf', `${id}.pdf`)));
}

function docTypeOf(id: string): DocType {
  if (id.startsWith('invoice')) return 'invoice_receipt';
  if (id.startsWith('scan')) return 'scanned_image';
  return 'general';
}

/** A copy of the recordings in which one page of one preset reads as an empty page: a parser that returned no text. */
function recordingsWithEmptyPage(sha: string, preset: string, page: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rag-escalation-'));
  cpSync(path.join(RECORDED_DIR, sha), path.join(dir, sha), { recursive: true });
  const file = path.join(dir, sha, preset, `page-${page}.json`);
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Row;
  for (const key of ['texts', 'tables', 'pictures', 'groups', 'key_value_items', 'form_items']) doc[key] = [];
  (doc.body as Row).children = [];
  writeFileSync(file, JSON.stringify(doc));
  return dir;
}

describe('escalation and cloud-off: SC1 escalation and SC2 through both services', () => {
  let harness: QueuedHarness;
  let app: IngestAppServer;
  let enqueue: typeof import('@/lib/rag/ingest/enqueue').enqueueIngest;
  let loadQueueConfig: typeof import('@/lib/rag/ingest/queue-config').loadQueueConfig;
  const actions = new Map<string, number>();
  let visionCalls = 0;
  const saved = new Map<string, string | undefined>();
  const tempDirs: string[] = [];

  function counted(action: string, handler: IngestRouteHandler): IngestRouteHandler {
    return (request: NextRequest, context) => {
      actions.set(action, (actions.get(action) ?? 0) + 1);
      return handler(request, context);
    };
  }

  before(async () => {
    harness = await startQueuedHarness({ env: { RAG_PARSE_ROUTING: 'tiered' } });
    for (const key of GUARD_KEYS) saved.set(key, process.env[key]);
    (await import('@/lib/rag/ingest/object-store')).resetObjectStoreForTests();
    enqueue = (await import('@/lib/rag/ingest/enqueue')).enqueueIngest;
    loadQueueConfig = (await import('@/lib/rag/ingest/queue-config')).loadQueueConfig;

    // min_tier premium for the invoice and scanned types, as an admin override would set it (D-13).
    const { setTierBoundsDepsForTests } = await import('@/lib/rag/ingest/routing/tier-bounds');
    const overrides = {
      from: () => ({
        select: () => ({
          eq: (_column: string, docType: DocType) => ({
            maybeSingle: async () => ({ data: PREMIUM_TYPES.has(docType) ? { min_tier: 'premium', max_tier: 'premium' } : null, error: null }),
          }),
        }),
      }),
    };
    setTierBoundsDepsForTests({ admin: () => overrides as unknown as Pick<SupabaseClient, 'from'> });

    const { setVlmDetectorForTests } = await import('@/lib/rag/ingest/callbacks/detect-vlm');
    setVlmDetectorForTests(async () => {
      visionCalls += 1;
      return { has_table: false, has_multi_column: false, is_scanned: false, has_formula: false, has_chart: false, complexity: 'simple', confidence: 0.9 };
    });

    const parseExternal = (await import('@/app/api/internal/rag/ingest/jobs/[id]/parse-external/route')) as { POST: IngestRouteHandler };
    const advance = (await import('@/app/api/internal/rag/ingest/jobs/[id]/advance/route')) as { POST: IngestRouteHandler };
    const detectVlm = (await import('@/app/api/internal/rag/ingest/jobs/[id]/detect-vlm/route')) as { POST: IngestRouteHandler };
    app = await startIngestAppServer({
      'parse-external': counted('parse-external', parseExternal.POST),
      advance: counted('advance', advance.POST),
      'detect-vlm': counted('detect-vlm', detectVlm.POST),
    });
  });

  after(async () => {
    const { resetVlmDetectorForTests } = await import('@/lib/rag/ingest/callbacks/detect-vlm');
    resetVlmDetectorForTests();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app?.close();
    await harness?.close();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  /** The guard reads the switch, budget and cap live from the process; the job snapshot is built from the same values. */
  function configure(values: { cloud: boolean; budget: number; cap: number; vlm?: boolean }): () => QueueConfig {
    const live = {
      RAG_PARSER_ALLOW_CLOUD: String(values.cloud),
      RAG_PARSE_PREMIUM_PAGE_BUDGET: String(values.budget),
      RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC: String(values.cap),
      RAG_PARSE_VLM_DETECT: String(values.vlm ?? false),
    };
    Object.assign(process.env, live);
    return () => loadQueueConfig({ RAG_INGEST_PIPELINE: 'unified', RAG_INGEST_ASYNC: 'on', RAG_PARSE_ROUTING: 'tiered', RAG_PARSE_ESCALATION: 'on', ...live });
  }

  async function upload(
    id: string,
    docType: DocType,
    queueConfig: () => QueueConfig,
    key = id,
    scope = harness.scopeA,
  ): Promise<{ jobId: string; documentId: string }> {
    const queued = await enqueue(
      {
        scope,
        source: 'config_upload',
        sourceKey: `root/${key}.pdf`,
        file: fixture(id),
        filename: `${key}.pdf`,
        mimeType: 'application/pdf',
        docType,
        signal: new AbortController().signal,
      },
      { queueConfig },
    );
    assert.equal(queued.status, 'queued', `enqueue of ${id}: ${JSON.stringify(queued)}`);
    return { jobId: String(queued.jobId), documentId: String(queued.documentId) };
  }

  async function work(jobId: string, recordedDir = RECORDED_DIR): Promise<Row> {
    const worker = await harness.runWorker(jobId, {
      RAG_INGEST_CONVERTER: 'recorded',
      RAG_INGEST_RECORDED_DIR: recordedDir,
      RAG_APP_INTERNAL_URL: app.url,
    });
    assert.equal(worker.exitCode, 0, `worker stdout: ${worker.stdout.slice(-1000)} stderr: ${worker.stderr.slice(-3000)} edge: ${JSON.stringify(harness.edge.errors.slice(-3))}`);
    const [job] = await harness.rows(
      'SELECT status, needs_review_reason, routing_note, escalations, attempts, page_ranges, settings FROM ingestion_jobs WHERE id = $1',
      [jobId],
    );
    assert.ok(job);
    return job;
  }

  function noCloudRequest(label: string): void {
    assert.equal(harness.llama.uploads.length, 0, `${label}: no upload reached the LlamaParse stub`);
    assert.equal(harness.llama.calls.length, 0, `${label}: no request reached the LlamaParse stub`);
    assert.equal(visionCalls, 0, `${label}: no request reached the vision stub`);
    assert.equal(actions.get('detect-vlm') ?? 0, 0, `${label}: the detect-vlm route was never called`);
  }

  test('SC1: a page the converter returns empty is escalated, and the escalation is recorded with its reason', async () => {
    const digital = MANIFEST.fixtures.find((item) => item.id === 'digital-text');
    assert.ok(digital);
    const recorded = recordingsWithEmptyPage(digital.sha256, 'fast', 1);
    tempDirs.push(recorded);
    const queueConfig = configure({ cloud: true, budget: 0, cap: 200 });

    const queued = await upload('digital-text', 'general', queueConfig, 'digital-text-empty-page');
    const job = await work(queued.jobId, recorded);

    assert.equal(job.status, 'ready');
    assert.equal(job.escalations, 1);
    const attempts = job.attempts as Row[];
    assert.deepEqual(
      attempts.map((attempt) => [attempt.reason, attempt.preset, (attempt.pages as Row).start, (attempt.pages as Row).end]),
      [
        ['initial', 'fast', 1, 2],
        ['escalation', 'structured_ocr', 1, 1],
      ],
    );
    const initialCheck = attempts[0]?.check as { passed: boolean; pages: Array<{ page: number; failed: string[] }> };
    assert.equal(initialCheck.passed, false);
    assert.ok(initialCheck.pages.find((page) => page.page === 1)?.failed.includes('empty_text'), 'the failed condition is empty_text');
    assert.equal((attempts[1]?.check as { passed: boolean }).passed, true);
    assert.deepEqual(
      (job.page_ranges as Row[]).map((range) => [range.start, range.end, range.preset, range.status]),
      [
        [1, 1, 'structured_ocr', 'escalated'],
        [2, 2, 'fast', 'ok'],
      ],
    );
    const chunks = await harness.rows('SELECT page_start, content FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [queued.documentId]);
    assert.ok(chunks.some((chunk) => Number(chunk.page_start) === 1 && String(chunk.content).trim() !== ''), 'page 1 is published from the escalation');
    noCloudRequest('SC1');
  });

  test('SC2: with the cloud switch off no request reaches LlamaParse or the vision model for any parse fixture', async () => {
    const queueConfig = configure({ cloud: false, budget: 1000, cap: 200, vlm: true });
    const outcomes: Array<[string, unknown, unknown]> = [];
    for (const item of MANIFEST.fixtures) {
      const docType = docTypeOf(item.id);
      // Another tenant, so the bytes the other cases upload are not duplicates here.
      const queued = await upload(item.id, docType, queueConfig, `${item.id}-cloud-off`, harness.scopeB);
      const job = await work(queued.jobId);
      const settings = job.settings as Row;
      assert.equal(settings.cloud_allowed, false);
      assert.equal(settings.vlm_detect, true, 'L3 is switched on in the snapshot');
      if (PREMIUM_TYPES.has(docType)) assert.equal(settings.min_tier, 'premium');
      assert.ok(['ready', 'needs_review'].includes(String(job.status)), `${item.id} ended ${String(job.status)}`);
      const ranges = job.page_ranges as Row[];
      assert.ok(ranges.every((range) => range.tier !== 'premium' && range.parser === 'docling'), `${item.id} ended on structured or fast results`);
      const attempts = job.attempts as Row[];
      assert.ok(attempts.filter((attempt) => attempt.tier === 'premium').every((attempt) => attempt.refused === true), `${item.id}: every premium attempt was refused`);
      if (job.status === 'needs_review') assert.equal(job.needs_review_reason, 'cloud_not_allowed', `${item.id}: blocked by cloud`);
      outcomes.push([item.id, job.status, job.needs_review_reason]);
      noCloudRequest(item.id);
    }
    assert.equal(outcomes.length, MANIFEST.fixtures.length);
    assert.equal(actions.get('parse-external') ?? 0, 0, 'the worker did not even ask the app for premium with the cloud off');
  });

  test('SC2: with no page budget a premium document stays on the best allowed tier and is marked needs_review', async () => {
    const queueConfig = configure({ cloud: true, budget: 0, cap: 200 });

    const queued = await upload('invoice-en', 'invoice_receipt', queueConfig, 'invoice-no-budget');
    const job = await work(queued.jobId);

    assert.equal(job.status, 'needs_review');
    assert.equal(job.needs_review_reason, 'budget_exhausted');
    const attempts = job.attempts as Row[];
    assert.deepEqual(
      attempts.map((attempt) => [attempt.tier, attempt.preset, attempt.refused]),
      [
        ['premium', 'premium', true],
        ['structured', 'structured_full', false],
      ],
    );
    assert.deepEqual((job.page_ranges as Row[]).map((range) => [range.start, range.end, range.preset, range.status]), [[1, 1, 'structured_full', 'needs_review']]);
    noCloudRequest('budget 0');
  });

  test('SC2: a document whose premium pages exceed the page cap sends none of them and is marked needs_review', async () => {
    const queueConfig = configure({ cloud: true, budget: 100, cap: 9 });
    const before = actions.get('parse-external') ?? 0;

    const queued = await upload('mixed-routing', 'invoice_receipt', queueConfig, 'mixed-over-cap');
    const job = await work(queued.jobId);

    assert.equal(job.status, 'needs_review');
    assert.equal(job.needs_review_reason, 'over_page_cap');
    assert.equal(actions.get('parse-external') ?? 0, before, 'ten premium pages over a cap of nine: no premium request');
    const ranges = job.page_ranges as Row[];
    assert.equal(ranges[0]?.start, 1);
    assert.equal(ranges.at(-1)?.end, 10);
    assert.ok(ranges.every((range) => range.status === 'needs_review' && range.tier !== 'premium'));
    const [usage] = await harness.rows('SELECT COALESCE(SUM(pages_reserved + pages_used), 0)::int AS pages FROM rag_parse_budget_usage');
    assert.equal(usage?.pages, 0, 'no budget page was reserved');
    noCloudRequest('over cap');
  });
});
