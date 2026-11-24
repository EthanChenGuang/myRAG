import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { IngestionJobSchema, type IngestionJob } from '@/lib/rag-eval/contracts.generated';
import { mintScope } from '@/lib/rag/tenant/scope';
import { buildQueueIngestTrace, finishQueueIngestTrace as finishQueueIngestTraceActual } from '@/lib/rag/ingest/queue-trace';
import { createIngestTrace, finishIngestTrace } from '@/lib/rag/ingest/trace';
import { handleAdvance } from '@/lib/rag/ingest/callbacks/advance';
import type { StageContext } from '@/lib/rag/ingest/types';

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const WORKER = 'worker-test-1';
const CACHE_ID = '22222222-2222-4222-8222-222222222222';
const scope = mintScope('single', null, null);

const SAMPLE = IngestionJobSchema.parse({
  ...JSON.parse(
    JSON.stringify({
      attempts: [],
      batch_id: null,
      created_at: '2026-01-01T00:00:00Z',
      deleted_at: null,
      detect_counts: null,
      doc_class: null,
      document_id: DOC_ID,
      embedding_profile: null,
      error_class: null,
      escalations: 0,
      est_cost_usd: null,
      file_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      filename: 'sample.pdf',
      id: JOB_ID,
      kind: 'ingest',
      lease_until: new Date(Date.now() + 60_000).toISOString(),
      lineage_id: null,
      locked_by: WORKER,
      max_retries: 3,
      mime_type: 'application/pdf',
      needs_review_reason: null,
      original_ref: { bucket: 'rag-originals', path: 's:default/x/sample.pdf' },
      page_ranges: [],
      pages: null,
      parser_used: null,
      parser_version: null,
      preflight_ref: null,
      priority: 100,
      provisional_published_at: null,
      retries: 0,
      routing_note: null,
      run_after: null,
      runner: 'worker',
      settings: {
        cloud_allowed: true,
        doc_type: 'general',
        embed_mode: 'sync',
        escalation: true,
        max_tier: 'premium',
        min_tier: 'fast',
        ocr_languages: ['en'],
        premium_max_pages_per_doc: 20,
        premium_page_budget: 0,
        profile_id: 'general@1',
        profile_version: 1,
        progressive: false,
        routing: 'fixed',
        routing_config_version: '1',
        vlm_detect: false,
        vlm_model: null,
      },
      source: 'upload',
      source_key: 'docs/sample.pdf',
      stage: 'chunking',
      stage_state: { cursor: null },
      status: 'chunking',
      tenant_key: 's:default',
      tier: null,
      tier_page_counts: {},
      timings: {},
      trace_id: null,
      updated_at: '2026-01-01T00:00:00Z',
      version: 1,
    }),
  ),
  attempts: [
    {
      attempt_no: 1,
      cache_hit: false,
      check: null,
      est_cost_usd: 0.001,
      ms: 12,
      pages: { start: 1, end: 5 },
      parser: 'docling_fast',
      parser_version: '2',
      preset: 'fast',
      reason: 'initial',
      refused: false,
      tier: 'fast',
    },
    {
      attempt_no: 2,
      cache_hit: false,
      check: null,
      est_cost_usd: 0.004,
      ms: 40,
      pages: { start: 6, end: 8 },
      parser: 'llamaparse',
      parser_version: 'v2',
      preset: 'premium',
      reason: 'escalation',
      refused: false,
      tier: 'premium',
    },
    {
      attempt_no: 3,
      cache_hit: true,
      check: null,
      est_cost_usd: 0,
      ms: 5,
      pages: { start: 7, end: 7 },
      parser: 'docling_fast',
      parser_version: '2',
      preset: 'structured_full',
      reason: 'table_boundary',
      refused: false,
      tier: 'structured',
    },
  ],
  detect_counts: { L1: 10, L2: 2, L3: 0, gated_share: 0 },
  page_ranges: [
    { start: 1, end: 5, tier: 'fast', preset: 'fast', parser: 'docling_fast', layer: 'L1', signals: [], status: 'ok', cache_id: null },
    { start: 6, end: 8, tier: 'premium', preset: 'premium', parser: 'llamaparse', layer: 'L1', signals: [], status: 'ok', cache_id: null },
  ],
});

const ledger = vi.hoisted(() => ({
  job: null as IngestionJob | null,
  advanceFields: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/rag/ingest/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/ingest/ledger')>();
  return {
    ...actual,
    getJobInternal: vi.fn(async () => ledger.job),
    advanceJob: vi.fn(async (args: { fields?: Record<string, unknown>; status: string }) => {
      ledger.advanceFields = args.fields ?? {};
      return { ...(ledger.job as IngestionJob), status: args.status as IngestionJob['status'] };
    }),
    failJob: vi.fn(async (_id, _w, errorClass: string) => ({ ...(ledger.job as IngestionJob), status: 'failed' as const, error_class: errorClass })),
  };
});

vi.mock('@/lib/rag/tenant/ingestion-job', () => ({
  scopeFromIngestionJob: vi.fn(async () => scope),
}));

vi.mock('@/lib/rag/ingest/queued-context', () => ({
  buildQueuedContext: vi.fn(async () => ({
    ok: true as const,
    ctx: {
      input: { scope },
      deps: { now: () => Date.now() },
      writer: {
        setFields: vi.fn(async () => undefined),
        markFailed: vi.fn(async () => undefined),
        getDocument: vi.fn(async () => null),
        publish: vi.fn(async () => ({ outcome: 'published' as const, documentId: DOC_ID, version: 1, supersededDocumentId: null })),
      },
      config: { injectionScan: 'off' as const },
      signal: new AbortController().signal,
      deadline: Date.now() + 40_000,
      state: { lastCompleted: null, chunkCount: null, docTypeOrigin: null, parseJob: null, artifacts: {}, docTypeDetection: null, quarantine: null, invoice: null, images: { nextIndex: 0, captioned: 0 } },
      warnings: [],
      identity: { tenantKey: 's:default', filename: 'sample.pdf', fileSha256: 'aa', docType: 'general', docTypeOrigin: 'fallback', profile: { id: 'general@1', version: 1, chunker: 'markdown_sections' }, bytes: null },
      document: { id: DOC_ID, version: 1, lineageId: 'lineage', resumed: false },
      parserUsed: 'docling',
      work: { parseText: 'Hello world', parseChunks: null, pictures: null, parserVersion: '2', templateRow: null, chunks: [], chunksWritten: 0 },
    } satisfies StageContext,
  })),
}));

vi.mock('@/lib/rag/ingest/parse-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/ingest/parse-cache')>();
  return {
    ...actual,
    readParseResultForJob: vi.fn(async () => ({
    result: {
      markdown: 'Hello world',
      chunks: [],
      pictures: [],
      page_count: 2,
      parser: 'docling',
      parser_version: '2',
      partial: false,
      warnings: [],
      text_layer_page_share: null,
    },
    artifacts: [],
    entry: { id: CACHE_ID },
  })),
  };
});

vi.mock('@/lib/rag/ingest/state-store', () => ({
  createLedgerStateStore: vi.fn(() => ({ save: vi.fn(), load: vi.fn() })),
  saveContextState: vi.fn(async () => undefined),
}));

const finishQueueIngestTrace = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rag/ingest/queue-trace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/ingest/queue-trace')>();
  return {
    ...actual,
    finishQueueIngestTrace,
  };
});

vi.mock('@/lib/rag/ingest/stages/parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/ingest/stages/parse')>();
  return {
    ...actual,
    applyParseResult: vi.fn(async (ctx: StageContext, parsed: { result: { markdown: string; parser: string; parser_version: string } }) => {
      ctx.work.parseText = parsed.result.markdown;
      ctx.work.parserVersion = parsed.result.parser_version;
      ctx.parserUsed = parsed.result.parser;
    }),
  };
});

const runStages = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rag/ingest/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/ingest/runner')>();
  return {
    ...actual,
    runIngestStages: runStages,
    rehydrateFromStore: vi.fn(async () => true),
  };
});

vi.mock('@/lib/rag/ingest/deps', () => ({
  getIngestDeps: () => ({
    db: () => ({ rpc: () => ({ abortSignal: () => ({ then: (ok: (v: unknown) => void) => Promise.resolve({ data: [], error: null }).then(ok) }) }) }),
    now: () => Date.now(),
  }),
}));

const defaultCache = async () => ({
  result: {
    markdown: 'Hello world',
    chunks: [],
    pictures: [],
    page_count: 2,
    parser: 'docling',
    parser_version: '2',
    partial: false,
    warnings: [],
    text_layer_page_share: null,
  },
  artifacts: [],
  entry: { id: CACHE_ID },
});

beforeEach(async () => {
  ledger.job = { ...SAMPLE, needs_review_reason: null, locked_by: WORKER, lease_until: new Date(Date.now() + 60_000).toISOString() };
  ledger.advanceFields = null;
  runStages.mockReset();
  const { readParseResultForJob } = await import('@/lib/rag/ingest/parse-cache');
  vi.mocked(readParseResultForJob).mockImplementation(defaultCache);
  finishQueueIngestTrace.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('advance needs_review and mixed parser bookkeeping', () => {
  test('publishes with needs_review when the job carries budget_exhausted and text is present', async () => {
    ledger.job = { ...ledger.job!, needs_review_reason: 'budget_exhausted' };
    runStages.mockResolvedValue({ status: 'ready', documentId: DOC_ID, version: 1, parserUsed: 'mixed', chunkCount: 2, warnings: [] });
    const response = await handleAdvance(JOB_ID, {
      worker_id: WORKER,
      attempt_no: 3,
      phase: 'post_parse',
      parse_cache_id: CACHE_ID,
      deadline_ms: 40_000,
      cursor: null,
    }, { signal: new AbortController().signal });
    expect(response, JSON.stringify(response)).toMatchObject({ status: 200 });
    expect(response.body).toMatchObject({ done: true, status: 'needs_review' });
    expect(ledger.advanceFields).toMatchObject({ needs_review_reason: 'budget_exhausted' });
  });

  // TODO: finishNeedsReviewEmpty isolation — exercised in zero-conversions e2e retry path
  test.skip('does not publish when needs_review and the merged parse has no text', async () => {
    const { readParseResultForJob } = await import('@/lib/rag/ingest/parse-cache');
    vi.mocked(readParseResultForJob).mockResolvedValueOnce({
      result: {
        markdown: '   ',
        chunks: [],
        pictures: [],
        page_count: 0,
        parser: 'docling',
        parser_version: '2',
        partial: false,
        warnings: [],
        text_layer_page_share: null,
      },
      artifacts: [],
      entry: { id: CACHE_ID },
    } as never);
    const { buildQueuedContext } = await import('@/lib/rag/ingest/queued-context');
    vi.mocked(buildQueuedContext).mockResolvedValueOnce({
      ok: true,
      ctx: {
        input: { scope },
        deps: { now: () => Date.now() },
        writer: { setFields: vi.fn(), markFailed: vi.fn(), getDocument: vi.fn(), publish: vi.fn() },
        config: { injectionScan: 'off' },
        signal: new AbortController().signal,
        deadline: Date.now() + 40_000,
        state: { lastCompleted: null, chunkCount: null, docTypeOrigin: null, parseJob: null, artifacts: {}, docTypeDetection: null, quarantine: null, invoice: null, images: { nextIndex: 0, captioned: 0 } },
        warnings: [],
        identity: { tenantKey: 's:default', filename: 'sample.pdf', fileSha256: 'aa', docType: 'general', docTypeOrigin: 'fallback', profile: { id: 'general@1', version: 1, chunker: 'markdown_sections' }, bytes: null },
        document: { id: DOC_ID, version: 1, lineageId: 'lineage', resumed: false },
        parserUsed: null,
        work: { parseText: '   ', parseChunks: null, pictures: null, parserVersion: null, templateRow: null, chunks: [], chunksWritten: 0 },
      },
    } as never);
    ledger.job = { ...ledger.job!, needs_review_reason: 'budget_exhausted' };
    const response = await handleAdvance(JOB_ID, {
      worker_id: WORKER,
      attempt_no: 1,
      phase: 'post_parse',
      parse_cache_id: CACHE_ID,
      deadline_ms: 40_000,
      cursor: null,
    }, { signal: new AbortController().signal });
    expect(response).toMatchObject({ status: 200 });
    expect(response.body).toMatchObject({ done: true, status: 'needs_review' });
    expect(runStages).not.toHaveBeenCalled();
  });

  test('records mixed parser_used on the document fields when page ranges differ', async () => {
    const setFields = vi.fn(async () => undefined);
    const { buildQueuedContext } = await import('@/lib/rag/ingest/queued-context');
    vi.mocked(buildQueuedContext).mockImplementation(async () => {
      return {
        ok: true,
        ctx: {
          input: { scope },
          deps: { now: () => Date.now() },
          writer: { setFields, markFailed: vi.fn(), getDocument: vi.fn(), publish: vi.fn() },
          config: { injectionScan: 'off' },
          signal: new AbortController().signal,
          deadline: Date.now() + 40_000,
          state: { lastCompleted: 'scan_injection', chunkCount: null, docTypeOrigin: null, parseJob: null, artifacts: {}, docTypeDetection: null, quarantine: null, invoice: null, images: { nextIndex: 0, captioned: 0 } },
          warnings: [],
          identity: { tenantKey: 's:default', filename: 'sample.pdf', fileSha256: 'aa', docType: 'general', docTypeOrigin: 'fallback', profile: { id: 'general@1', version: 1, chunker: 'markdown_sections' }, bytes: null },
          document: { id: DOC_ID, version: 1, lineageId: 'lineage', resumed: false },
          parserUsed: 'docling',
          work: {
            parseText: 'page one\n\npage six',
            parseChunks: [
              { text: 'page one', headings: ['P1'], pages: [1], is_table: false },
              { text: 'page six', headings: ['P6'], pages: [6], is_table: false },
            ],
            pictures: null,
            parserVersion: '2',
            templateRow: null,
            chunks: [],
            chunksWritten: 0,
          },
        },
      } as never;
    });
    runStages.mockImplementation(async (ctx, stages) => {
      for (const stage of stages) {
        if (stage.name === 'chunk') await stage.run(ctx);
      }
      return { status: 'ready', documentId: DOC_ID, version: 1, parserUsed: ctx.parserUsed, chunkCount: ctx.work.chunks.length, warnings: [] };
    });
    ledger.job = { ...SAMPLE, stage_state: { cursor: 'scan_injection' }, status: 'chunking' };
    await handleAdvance(JOB_ID, {
      worker_id: WORKER,
      attempt_no: 3,
      phase: 'post_parse',
      parse_cache_id: CACHE_ID,
      deadline_ms: 40_000,
      cursor: 'scan_injection',
    }, { signal: new AbortController().signal });
    expect(ledger.advanceFields?.parser_used).toBe('mixed');
  });
});

describe('queue ingestion trace from the ledger', () => {
  test('builds preflight, parse, check and stage spans without document text', () => {
    const trace = createIngestTrace(scope);
    expect(trace).not.toBeNull();
    if (!trace) return;
    buildQueueIngestTrace({ ...SAMPLE, timings: { ...SAMPLE.timings, check: 3 } }, trace);
    const names = trace.collector.stages().map((stage) => stage.name);
    expect(names).toContain('preflight');
    expect(names.filter((name) => name.startsWith('parse:')).length).toBe(3);
    expect(names).toContain('check');
    const serialized = JSON.stringify(trace.collector.stages());
    expect(serialized).not.toMatch(/Hello/);
    expect(serialized).toContain('table_boundary');
  });

  test('a failed job emits one error-level trace and exactly one ingest alert', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { finishQueueIngestTrace: finishReal } = await vi.importActual<typeof import('@/lib/rag/ingest/queue-trace')>(
      '@/lib/rag/ingest/queue-trace',
    );
    finishReal({ scope, job: { ...SAMPLE, status: 'failed', error_class: 'embed_failed' }, status: 'failed', errorClass: 'embed_failed', sink: (line) => log(line) });
    expect(err.mock.calls.filter((call) => String(call[0]).includes('[Ingest Alert]'))).toHaveLength(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('embed_failed');
    expect(String(err.mock.calls[0]?.[0])).not.toContain('sample.pdf');
    const trace = createIngestTrace(scope);
    if (!trace) return;
    buildQueueIngestTrace(SAMPLE, trace);
    finishIngestTrace(trace, { status: 'failed', documentId: DOC_ID, version: 1, parserUsed: null, chunkCount: 0, warnings: [], reason: 'embed_failed' });
    expect(log.mock.calls.some((call) => String(call[0]).includes('[Ingest Trace]'))).toBe(true);
  });
});