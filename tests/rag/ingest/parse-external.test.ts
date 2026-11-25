import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { setLedgerDepsForTests, resetLedgerDepsForTests } from '@/lib/rag/ingest/ledger';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { resetIngestConfigForTests } from '@/lib/rag/ingest/config';
import { getObjectStore, resetObjectStoreForTests } from '@/lib/rag/ingest/object-store';
import { installFakeObjectStore } from '../../helpers/fake-object-store';
import { encodeQueuedInput, QUEUED_INPUT_ARTIFACT } from '@/lib/rag/ingest/queued-context';
import { handleParseExternal } from '@/lib/rag/ingest/callbacks/parse-external';
import { setCaptionerForTests, resetCaptionerForTests } from '@/lib/rag/ingest/captioner';
import * as plainText from '@/lib/rag/ingest/parsers/plain-text';
import {
  resetCloudGuardDepsForTests,
  setCloudGuardDepsForTests,
} from '@/lib/rag/ingest/guard/cloud-budget';
import {
  createLlamaParseParser,
  resetLlamaParseParserForTests,
  setLlamaParseParserForTests,
} from '@/lib/rag/ingest/parsers/llamaparse-v2';
import { startFakeLlamaParse, type FakeLlamaParse } from '../../helpers/fake-llamaparse';
import { createHash } from 'node:crypto';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const LINEAGE = '33333333-3333-4333-8333-333333333333';
const WORKER = 'worker-a';
const FILE_SHA = 'a'.repeat(64);
const OPTIONS_HASH = 'b'.repeat(64);

let now = 1_000_000;

function jobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const settings = buildJobSettings({
    queueConfig: loadQueueConfig({
      RAG_INGEST_PIPELINE: 'unified',
      RAG_INGEST_ASYNC: 'on',
      RAG_PARSER_ALLOW_CLOUD: 'true',
      RAG_PARSE_ROUTING: 'tiered',
    }),
    profile: getProcessingProfile('general'),
    bounds: { min_tier: 'fast', max_tier: 'premium' },
    routingConfig: loadRoutingConfig(),
  });
  return {
    id: JOB_ID,
    kind: 'ingest',
    status: 'parsing',
    tenant_key: 's:default',
    source: 'config_upload',
    source_key: 'notes.md',
    priority: 100,
    retries: 0,
    max_retries: 3,
    escalations: 0,
    attempts: [],
    page_ranges: [],
    tier_page_counts: {},
    detect_counts: null,
    timings: {},
    stage_state: {},
    settings,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    lease_until: new Date(now + 60_000).toISOString(),
    run_after: null,
    locked_by: WORKER,
    runner: null,
    batch_id: null,
    document_id: DOC_ID,
    lineage_id: LINEAGE,
    version: 1,
    file_sha256: FILE_SHA,
    filename: 'notes.md',
    mime_type: 'text/markdown',
    original_ref: { bucket: 'rag-originals', path: `s:default/${LINEAGE}/1/original.md` },
    stage: 'parse',
    doc_class: null,
    tier: null,
    parser_used: null,
    parser_version: null,
    pages: null,
    preflight_ref: null,
    est_cost_usd: 0.05,
    embedding_profile: null,
    error_class: null,
    needs_review_reason: null,
    routing_note: null,
    provisional_published_at: null,
    trace_id: null,
    ...overrides,
  };
}

function fakeDb(answers: Record<string, unknown>): { client: RpcClient; calls: Array<{ fn: string; args: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
      let data: unknown = answers[fn];
      if (typeof data === 'function') data = (data as (args: Record<string, unknown>) => unknown)(args as Record<string, unknown>);
      const response: RpcResponse =
        data && typeof data === 'object' && !Array.isArray(data) && 'error' in (data as object)
          ? { data: null, error: (data as { error: { code: string; message: string } }).error }
          : { data: data as never, error: null };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { client, calls };
}

async function seedQueuedUpload(
  scopePath: string,
  file: Uint8Array,
  filename: string,
  mimeType: string,
  originalObject = 'original.md',
  kind: 'file' | 'text' = 'file',
) {
  const store = installFakeObjectStore();
  const queued = encodeQueuedInput({
    v: 1,
    source: 'config_upload',
    sourceKey: 'notes.md',
    filename,
    mimeType,
    kind,
    state: {},
  });
  await store.put(`${scopePath}${QUEUED_INPUT_ARTIFACT}`, queued, { contentType: 'application/json' });
  await store.put(`${scopePath}${originalObject}`, file, { contentType: mimeType });
  return store;
}

async function seedPremiumSubpdf(subpdf: string) {
  await seedQueuedUpload(`s:default/${LINEAGE}/1/`, new Uint8Array(), 'doc.pdf', 'application/pdf');
  await getObjectStore().put(subpdf, new TextEncoder().encode('%PDF-1.4'), { contentType: 'application/pdf' });
}

function installHarness(answers: Record<string, unknown> = {}, jobOverrides: Record<string, unknown> = {}) {
  const job = jobRow(jobOverrides);
  const { client, calls } = fakeDb({
    rag_get_ingestion_job_internal: job,
    rag_advance_ingestion_job: job,
    rag_get_ingest_document: [
      {
        status: 'processing',
        version: 1,
        processing_status: 'parse',
        processing_state: {},
        filename: job.filename,
        doc_type: 'general',
        parser_used: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    rag_get_ingest_origin: [
      { lineage_id: LINEAGE, original_path: `s:default/${LINEAGE}/1/original.md`, source: 'config_upload', source_key: 'notes.md' },
    ],
    rag_parse_cache_lookup: null,
    rag_parse_cache_prefix: (args: Record<string, unknown>) => {
      const parser = String(args.p_parser);
      const version = String(args.p_parser_version);
      const hash = String(args.p_options_hash);
      const versionSegment = createHash('sha256').update(version, 'utf8').digest('hex').slice(0, 16);
      return `${job.tenant_key}/_parse-cache/${FILE_SHA}/${parser}-${versionSegment}-${hash}/`;
    },
    rag_parse_cache_put: {
      id: 'cache-entry-1',
      tenant_key: job.tenant_key,
      file_sha256: FILE_SHA,
      parser: 'plain_text',
      parser_version: 'native',
      options_hash: OPTIONS_HASH,
      object_prefix: `${job.tenant_key}/_parse-cache/${FILE_SHA}/plain_text-native-${OPTIONS_HASH}/`,
      result: {},
      byte_size: 10,
    },
    rag_reserve_parse_budget: true,
    rag_reserve_batch_budget: true,
    rag_settle_parse_budget: true,
    rag_release_parse_budget: true,
    ...answers,
  });
  setLedgerDepsForTests({ db: () => client });
  setCloudGuardDepsForTests({ db: () => client });
  setIngestDepsForTests({
    db: () => client,
    now: () => now,
    embedDocuments: async (texts) => texts.map(() => Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0))),
  });
  return { calls, client };
}

let plainCalls = 0;

beforeEach(() => {
  now = 1_000_000;
  plainCalls = 0;
  vi.stubEnv('RAG_SIDECAR_SECRET', 'test-sidecar-secret-48-chars-minimum-000000000');
  vi.spyOn(plainText, 'parsePlainText').mockImplementation(() => {
    plainCalls += 1;
    return {
      markdown: '# Notes\n\nHello native.',
      chunks: [],
      pictures: [],
      page_count: 0,
      language: null,
      parser: 'text',
      parser_version: 'native',
      partial: false,
      text_layer_page_share: null,
      warnings: [],
    };
  });
});

afterEach(() => {
  resetLedgerDepsForTests();
  resetIngestDepsForTests();
  resetCloudGuardDepsForTests();
  resetCaptionerForTests();
  resetLlamaParseParserForTests();
  resetObjectStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('parse-external native mode', () => {
  test('native md returns done, caches plain_text, and the second call hits the cache', async () => {
    const file = new TextEncoder().encode('# Notes\n\nHello native.');
    let savedRow: Record<string, unknown> | null = null;
    installHarness({
      rag_parse_cache_lookup: () => (savedRow ? [savedRow] : []),
      rag_parse_cache_put: (args: Record<string, unknown>) => {
        const prefix = String(args.p_object_prefix);
        savedRow = {
          id: 'cache-entry-1',
          tenant_key: 's:default',
          file_sha256: FILE_SHA,
          parser: 'plain_text',
          parser_version: 'native',
          options_hash: OPTIONS_HASH,
          object_prefix: prefix,
          result: {},
          byte_size: 10,
        };
        return savedRow;
      },
    });
    await seedQueuedUpload(`s:default/${LINEAGE}/1/`, file, 'notes.md', 'text/markdown');
    const signal = new AbortController().signal;
    const body = { worker_id: WORKER, attempt_no: 1, mode: 'native' as const, continuation: null, cursor: null, pages: null, subpdf_ref: null, options_hash: OPTIONS_HASH };
    const first = await handleParseExternal(JOB_ID, body, { signal });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'done', cache_id: 'cache-entry-1' });
    expect(plainCalls).toBe(1);
    const second = await handleParseExternal(JOB_ID, body, { signal });
    expect(second.body).toMatchObject({ status: 'done', cache_id: 'cache-entry-1' });
    expect(plainCalls).toBe(1);
  });

  test('native png uses the captioner', async () => {
    const captionCalls: number[] = [];
    setCaptionerForTests(async () => {
      captionCalls.push(1);
      return 'A chart with blue bars.';
    });
    const file = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    installHarness(
      {
        rag_get_ingest_document: [
          {
            status: 'processing',
            version: 1,
            processing_status: 'parse',
            processing_state: {},
            filename: 'slide.png',
            doc_type: 'general',
            parser_used: null,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      {
        filename: 'slide.png',
        mime_type: 'image/png',
        original_ref: { bucket: 'rag-originals', path: `s:default/${LINEAGE}/1/original.png` },
      },
    );
    await seedQueuedUpload(`s:default/${LINEAGE}/1/`, file, 'slide.png', 'image/png', 'original.png');
    const result = await handleParseExternal(
      JOB_ID,
      { worker_id: WORKER, attempt_no: 1, mode: 'native', continuation: null, cursor: null, pages: null, subpdf_ref: null, options_hash: OPTIONS_HASH },
      { signal: new AbortController().signal },
    );
    expect(result.body).toMatchObject({ status: 'done', pages: [{ page: 1, text: 'A chart with blue bars.' }] });
    expect(captionCalls).toHaveLength(1);
  });

  test('native png under RAG_CAPTION_LANGUAGE=document asks for the language with the largest tenant share (D-23)', async () => {
    const targets: Array<string | null | undefined> = [];
    setCaptionerForTests(async (_bytes, _mime, options) => {
      targets.push(options.targetLanguage);
      return 'Una tabella con tre colonne e una riga di intestazione.';
    });
    const file = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const { calls } = installHarness(
      {
        rag_tenant_language_shares: [
          { language: 'it', share: 0.6, docs: 3 },
          { language: 'en', share: 0.4, docs: 2 },
        ],
      },
      {
        filename: 'slide.png',
        mime_type: 'image/png',
        original_ref: { bucket: 'rag-originals', path: `s:default/${LINEAGE}/1/original.png` },
      },
    );
    setIngestDepsForTests({ ingestEnv: () => ({ RAG_CAPTION_LANGUAGE: 'document' }) });
    resetIngestConfigForTests();
    await seedQueuedUpload(`s:default/${LINEAGE}/1/`, file, 'slide.png', 'image/png', 'original.png');
    const result = await handleParseExternal(
      JOB_ID,
      { worker_id: WORKER, attempt_no: 1, mode: 'native', continuation: null, cursor: null, pages: null, subpdf_ref: null, options_hash: OPTIONS_HASH },
      { signal: new AbortController().signal },
    );
    expect(result.body).toMatchObject({ status: 'done' });
    expect(targets).toEqual(['it']);
    expect(calls.filter((call) => call.fn === 'rag_tenant_language_shares')).toEqual([
      { fn: 'rag_tenant_language_shares', args: { p_tenant_key: 's:default' } },
    ]);
    resetIngestConfigForTests();
  });

  test('a text upload named like an image is its text, as in the Phase 3 chain, and is not captioned', async () => {
    const captionCalls: number[] = [];
    setCaptionerForTests(async () => {
      captionCalls.push(1);
      return 'A caption of something else.';
    });
    const text = '# Floor plan\n\nAisle A holding thermal probes and spare cables.';
    installHarness(
      {
        rag_get_ingest_document: [
          {
            status: 'processing',
            version: 1,
            processing_status: 'parse',
            processing_state: {},
            filename: 'floorplan.png',
            doc_type: 'general',
            parser_used: null,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      {
        filename: 'floorplan.png',
        mime_type: 'text/markdown',
        original_ref: { bucket: 'rag-originals', path: `s:default/${LINEAGE}/1/original.png` },
      },
    );
    await seedQueuedUpload(`s:default/${LINEAGE}/1/`, new TextEncoder().encode(text), 'floorplan.png', 'text/markdown', 'original.png', 'text');
    const result = await handleParseExternal(
      JOB_ID,
      { worker_id: WORKER, attempt_no: 1, mode: 'native', continuation: null, cursor: null, pages: null, subpdf_ref: null, options_hash: OPTIONS_HASH },
      { signal: new AbortController().signal },
    );
    expect(result.body).toMatchObject({ status: 'done', pages: [{ page: 1, text }] });
    expect(captionCalls).toHaveLength(0);
  });

  test('docx and html return failed unsupported_mode', async () => {
    for (const [filename, mimeType, originalName] of [
      ['brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'original.docx'],
      ['page.html', 'text/html', 'original.html'],
    ] as const) {
      installHarness(
        {
          rag_get_ingest_document: [
            {
              status: 'processing',
              version: 1,
              processing_status: 'parse',
              processing_state: {},
              filename,
              doc_type: 'general',
              parser_used: null,
              created_at: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
        {
          filename,
          mime_type: mimeType,
          original_ref: { bucket: 'rag-originals', path: `s:default/${LINEAGE}/1/${originalName}` },
        },
      );
      const bytes = new Uint8Array([1, 2, 3]);
      await seedQueuedUpload(`s:default/${LINEAGE}/1/`, bytes, filename, mimeType);
      await getObjectStore().put(`s:default/${LINEAGE}/1/${originalName}`, bytes, { contentType: mimeType });
      const result = await handleParseExternal(
        JOB_ID,
        { worker_id: WORKER, attempt_no: 1, mode: 'native', continuation: null, cursor: null, pages: null, subpdf_ref: null, options_hash: OPTIONS_HASH },
        { signal: new AbortController().signal },
      );
      expect(result.body).toMatchObject({ status: 'failed', error_class: 'unsupported_mode' });
    }
  });
});

describe('parse-external premium mode', () => {
  let fake: FakeLlamaParse;

  beforeEach(async () => {
    vi.stubEnv('LLAMA_CLOUD_API_KEY', 'llx-test-key-0000');
    fake = await startFakeLlamaParse();
    setLlamaParseParserForTests(
      createLlamaParseParser({ baseUrl: fake.url, apiKey: fake.apiKey, tier: 'agentic', sleep: async () => undefined }),
    );
  });

  afterEach(async () => {
    await fake.close();
  });

  test('cloud off refuses without upload', async () => {
    vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', 'false');
    const { calls } = installHarness();
    const subpdf = `s:default/_parse-cache/${FILE_SHA}/work/range.pdf`;
    await seedQueuedUpload(`s:default/${LINEAGE}/1/`, new Uint8Array(), 'doc.pdf', 'application/pdf');
    const result = await handleParseExternal(
      JOB_ID,
      {
        worker_id: WORKER,
        attempt_no: 1,
        mode: 'premium',
        continuation: null,
        cursor: JSON.stringify({ original_pages: [1, 2, 3], reserve_pages: 3 }),
        pages: { start: 1, end: 3 },
        subpdf_ref: subpdf,
        options_hash: OPTIONS_HASH,
      },
      { signal: new AbortController().signal },
    );
    expect(result.body).toMatchObject({ status: 'refused', reason: 'cloud_not_allowed' });
    expect(fake.uploads).toHaveLength(0);
    expect(calls.filter((call) => call.fn === 'rag_reserve_parse_budget')).toHaveLength(0);
  });

  test('over_page_cap and budget_exhausted refuse without reserve side effects on cap', async () => {
    vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
    vi.stubEnv('RAG_INGEST_ASYNC', 'on');
    vi.stubEnv('RAG_PARSE_ROUTING', 'tiered');
    vi.stubEnv('RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC', '200');
    vi.stubEnv('RAG_PARSE_PREMIUM_PAGE_BUDGET', '10');
    const capCalls = installHarness();
    const subpdf = `s:default/_parse-cache/${FILE_SHA}/work/range.pdf`;
    await seedPremiumSubpdf(subpdf);
    const overCap = await handleParseExternal(
      JOB_ID,
      {
        worker_id: WORKER,
        attempt_no: 1,
        mode: 'premium',
        continuation: null,
        cursor: JSON.stringify({ original_pages: [1], reserve_pages: 201 }),
        pages: { start: 1, end: 1 },
        subpdf_ref: subpdf,
        options_hash: OPTIONS_HASH,
      },
      { signal: new AbortController().signal },
    );
    expect(overCap.body).toMatchObject({ status: 'refused', reason: 'over_page_cap' });
    expect(capCalls.calls.filter((call) => call.fn === 'rag_reserve_parse_budget')).toHaveLength(0);

    vi.stubEnv('RAG_PARSE_PREMIUM_PAGE_BUDGET', '0');
    const budgetCalls = installHarness({
      rag_reserve_parse_budget: (args: Record<string, unknown>) => Number(args.p_pages) <= Number(args.p_limit),
    });
    await seedPremiumSubpdf(subpdf);
    const noBudget = await handleParseExternal(
      JOB_ID,
      {
        worker_id: WORKER,
        attempt_no: 1,
        mode: 'premium',
        continuation: null,
        cursor: JSON.stringify({ original_pages: [4, 9, 12], reserve_pages: 6 }),
        pages: { start: 4, end: 12 },
        subpdf_ref: subpdf,
        options_hash: 'c'.repeat(64),
      },
      { signal: new AbortController().signal },
    );
    expect(noBudget.body).toMatchObject({ status: 'refused', reason: 'budget_exhausted' });
  });

  test('maps sub pages to original pages and settles', async () => {
    fake.enqueue({
      pages: [
        { page_number: 1, success: true, markdown: 'P1' },
        { page_number: 2, success: true, markdown: 'P2' },
        { page_number: 3, success: true, markdown: 'P3' },
      ],
    });
    const { calls } = installHarness();
    const subpdf = `s:default/_parse-cache/${FILE_SHA}/work/range.pdf`;
    await seedPremiumSubpdf(subpdf);
    const result = await handleParseExternal(
      JOB_ID,
      {
        worker_id: WORKER,
        attempt_no: 1,
        mode: 'premium',
        continuation: null,
        cursor: JSON.stringify({ original_pages: [4, 9, 12], reserve_pages: 6 }),
        pages: { start: 4, end: 12 },
        subpdf_ref: subpdf,
        options_hash: OPTIONS_HASH,
      },
      { signal: new AbortController().signal },
    );
    expect(result.body).toMatchObject({ status: 'done' });
    const pages = (result.body as { pages: Array<{ page: number; text: string }> }).pages;
    expect(pages.map((page) => page.page)).toEqual([4, 9, 12]);
    expect(fake.uploads).toHaveLength(1);
    expect(calls.some((call) => call.fn === 'rag_settle_parse_budget')).toBe(true);
  });

  test('keeps every paragraph of a page and the page each one came from', async () => {
    fake.enqueue({
      pages: [
        { page_number: 1, success: true, markdown: '# Notice\n\nFirst paragraph of page one.\n\nSecond paragraph of page one.' },
        { page_number: 2, success: false, error: 'page failed' },
        { page_number: 3, success: true, markdown: 'Only paragraph of page three.' },
      ],
    });
    installHarness();
    const subpdf = `s:default/_parse-cache/${FILE_SHA}/work/range.pdf`;
    await seedPremiumSubpdf(subpdf);
    const result = await handleParseExternal(
      JOB_ID,
      {
        worker_id: WORKER,
        attempt_no: 1,
        mode: 'premium',
        continuation: null,
        cursor: JSON.stringify({ original_pages: [4, 9, 12], reserve_pages: 6 }),
        pages: { start: 4, end: 12 },
        subpdf_ref: subpdf,
        options_hash: 'd'.repeat(64),
      },
      { signal: new AbortController().signal },
    );
    expect(result.body).toMatchObject({ status: 'done' });
    const pages = (result.body as { pages: Array<{ page: number; text: string }> }).pages;
    expect(pages).toEqual([
      { page: 4, text: '# Notice\n\nFirst paragraph of page one.\n\nSecond paragraph of page one.', has_table: false },
      { page: 9, text: '', has_table: false },
      { page: 12, text: 'Only paragraph of page three.', has_table: false },
    ]);
  });

  test('rejects subpdf_ref outside the cache prefix', async () => {
    installHarness();
    await seedQueuedUpload(`s:default/${LINEAGE}/1/`, new Uint8Array(), 'doc.pdf', 'application/pdf');
    const bad = await handleParseExternal(
      JOB_ID,
      {
        worker_id: WORKER,
        attempt_no: 1,
        mode: 'premium',
        continuation: null,
        cursor: JSON.stringify({ original_pages: [1], reserve_pages: 1 }),
        pages: { start: 1, end: 1 },
        subpdf_ref: 'evil/tenant/path/range.pdf',
        options_hash: OPTIONS_HASH,
      },
      { signal: new AbortController().signal },
    );
    expect(bad).toMatchObject({ status: 400, body: { error: 'subpdf_ref_invalid' } });
  });
});