import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { SIDECAR_SECRET_HEADER } from '@/lib/rag/ingest/callbacks/internal-auth';
import { resetVlmDetectorForTests, setVlmDetectorForTests, type VlmDetectInput } from '@/lib/rag/ingest/callbacks/detect-vlm';
import { imageCaptionModelId } from '@/lib/rag/ingest/captioner';
import { DetectVlmResponseSchema } from '@/lib/rag-eval/contracts.generated';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { installIngestDeps, uninstallIngestDeps } from '../../helpers/ingest-fakes';

const SECRET = 'detect-vlm-sidecar-secret-0000000000000';
const JOB = '10000000-0000-4000-8000-000000000001';
const JOB_UNKNOWN = '20000000-0000-4000-8000-000000000002';
const WORKER = 'worker-holding-lease-a';
const OTHER_WORKER = 'worker-without-lease-b';
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const PIXEL_MARKER = 'SECRET-PAGE-PIXELS-0123456789';

const PARSE_ROOT = join(process.cwd(), 'eval', 'fixtures', 'parse');

type LedgerCall = { fn: string; args: Record<string, unknown> };

function pngBase64(tag: string): string {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, Buffer.from(`${PIXEL_MARKER}:${tag}`)]).toString('base64');
}

function jobRow(overrides: Record<string, unknown> = {}, settingsOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  const settings = {
    ...buildJobSettings({
      queueConfig: loadQueueConfig({}),
      profile: getProcessingProfile('general'),
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig: loadRoutingConfig(),
    }),
    routing: 'tiered',
    vlm_detect: true,
    ...settingsOverrides,
  };
  return {
    id: JOB,
    kind: 'ingest',
    status: 'preflight',
    tenant_key: `u:${USER_A}`,
    source: 'config_upload',
    source_key: 'doc.pdf',
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
    document_id: null,
    lineage_id: null,
    version: null,
    lease_until: new Date(NOW + 60_000).toISOString(),
    run_after: null,
    locked_by: WORKER,
    runner: 'worker',
    batch_id: null,
    file_sha256: null,
    filename: 'ledger-filename.pdf',
    mime_type: 'application/pdf',
    original_ref: null,
    stage: 'preflight',
    doc_class: null,
    tier: null,
    parser_used: null,
    parser_version: null,
    pages: null,
    preflight_ref: null,
    est_cost_usd: null,
    embedding_profile: null,
    error_class: null,
    needs_review_reason: null,
    routing_note: null,
    provisional_published_at: null,
    trace_id: null,
    ...overrides,
  };
}

interface Ledger {
  db: RpcClient;
  calls: LedgerCall[];
  events: string[];
}

function fakeLedger(
  options: { job?: Record<string, unknown> | null; batchFits?: boolean; failReserve?: boolean; onBatch?: () => void } = {},
): Ledger {
  const calls: LedgerCall[] = [];
  const events: string[] = [];
  const job = options.job === undefined ? jobRow() : options.job;
  const handlers: Record<string, (_args: Record<string, unknown>) => RpcResponse> = {
    rag_get_ingestion_job_internal: (args) => ({ data: job && args.p_job_id === JOB ? [job] : [], error: null }),
    rag_reserve_parse_budget: (args) => {
      events.push('reserve');
      if (options.failReserve) return { data: null, error: { code: 'XX000', message: 'db exploded with sensitive text' } };
      return { data: [{ rag_reserve_parse_budget: Number(args.p_pages) <= Number(args.p_limit) }], error: null };
    },
    rag_reserve_batch_budget: () => {
      events.push('batch');
      options.onBatch?.();
      return { data: [{ rag_reserve_batch_budget: options.batchFits ?? true }], error: null };
    },
    rag_settle_parse_budget: () => {
      events.push('settle');
      return { data: [{ rag_settle_parse_budget: true }], error: null };
    },
    rag_release_parse_budget: () => {
      events.push('release');
      return { data: [{ rag_release_parse_budget: true }], error: null };
    },
  };
  const db: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
      const result = handlers[fn]?.((args ?? {}) as Record<string, unknown>) ?? { data: [], error: null };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { db, calls, events };
}

interface Stub {
  inputs: VlmDetectInput[];
}

function installStub(answer: (_index: number, _input: VlmDetectInput) => unknown, ledger?: Ledger): Stub {
  const stub: Stub = { inputs: [] };
  setVlmDetectorForTests(async (input) => {
    ledger?.events.push('model');
    const index = stub.inputs.length;
    stub.inputs.push(input);
    return answer(index, input);
  });
  return stub;
}

const SIMPLE_VERDICT = {
  complexity: 'simple',
  confidence: 0.91,
  has_chart: false,
  has_formula: false,
  has_multi_column: false,
  has_table: true,
  is_scanned: false,
};

function recordedVerdict(sha: string, page: number): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PARSE_ROOT, 'recorded', sha, 'vlm', `page-${page}.json`), 'utf8')) as Record<string, unknown>;
}

function body(pages: number[], extra: Record<string, unknown> = {}, worker = WORKER) {
  return {
    worker_id: worker,
    attempt_no: 1,
    pages: pages.map((page) => ({ page, png_base64: pngBase64(String(page)) })),
    ...extra,
  };
}

async function post(jobId: string, payload: unknown, secret: string | null | undefined = SECRET) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null && secret !== undefined) headers[SIDECAR_SECRET_HEADER] = secret;
  const route = await import('@/app/api/internal/rag/ingest/jobs/[id]/detect-vlm/route');
  const req = new NextRequest(`http://localhost/api/internal/rag/ingest/jobs/${jobId}/detect-vlm`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const res = await route.POST(req, { params: Promise.resolve({ id: jobId }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text };
}

function install(ledger: Ledger): void {
  installIngestDeps({ db: ledger.db, now: () => NOW });
}

function loggedText(): string {
  const spies = [console.log, console.warn, console.error, console.info, console.debug] as unknown as Array<{
    mock?: { calls: unknown[][] };
  }>;
  return spies.map((spy) => JSON.stringify(spy.mock?.calls ?? [])).join('\n');
}

const ENV_KEYS = ['RAG_SIDECAR_SECRET', 'RAG_PARSER_ALLOW_CLOUD', 'RAG_PARSE_PREMIUM_PAGE_BUDGET', 'RAG_PARSE_VLM_MODEL'] as const;

beforeEach(() => {
  process.env.RAG_SIDECAR_SECRET = SECRET;
  process.env.RAG_PARSER_ALLOW_CLOUD = 'true';
  process.env.RAG_PARSE_PREMIUM_PAGE_BUDGET = '10';
  delete process.env.RAG_PARSE_VLM_MODEL;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  resetVlmDetectorForTests();
  uninstallIngestDeps();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('detect-vlm authentication, validation and lease', () => {
  it('returns 401 without a ledger call or model request when the secret is unset, missing or wrong', async () => {
    const ledger = fakeLedger();
    install(ledger);
    const stub = installStub(() => SIMPLE_VERDICT, ledger);
    delete process.env.RAG_SIDECAR_SECRET;
    const unset = await post(JOB, body([1]), SECRET);
    expect(unset.status).toBe(401);
    expect(unset.json).toEqual({ error: 'unauthorized' });
    process.env.RAG_SIDECAR_SECRET = SECRET;
    for (const secret of [null, '', 'not-the-secret', SECRET.slice(0, -1)]) {
      const res = await post(JOB, body([1]), secret);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: 'unauthorized' });
    }
    expect(ledger.calls).toHaveLength(0);
    expect(stub.inputs).toHaveLength(0);
  });

  it('returns 400 for a non-UUID job id before the ledger runs', async () => {
    const ledger = fakeLedger();
    install(ledger);
    const res = await post('abc', body([1]));
    expect(res.status).toBe(400);
    expect(ledger.calls).toHaveLength(0);
  });

  it('returns 400 for an empty page list, more than 20 pages and a tenant_key in the body', async () => {
    const ledger = fakeLedger();
    install(ledger);
    const stub = installStub(() => SIMPLE_VERDICT, ledger);
    const tooMany = Array.from({ length: 21 }, (_, index) => index + 1);
    for (const payload of [body([]), body(tooMany), body([1], { tenant_key: 'o:00000000-0000-4000-8000-0000000000c2' })]) {
      const res = await post(JOB, payload);
      expect(res.status).toBe(400);
    }
    expect(ledger.calls).toHaveLength(0);
    expect(stub.inputs).toHaveLength(0);
  });

  it('returns 404 for an unknown job and 409 lease_lost for a worker without the lease or a terminal job', async () => {
    const unknown = fakeLedger({ job: null });
    install(unknown);
    const stub = installStub(() => SIMPLE_VERDICT, unknown);
    const missing = await post(JOB_UNKNOWN, body([1]));
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ error: 'job_not_found' });

    const held = fakeLedger();
    install(held);
    const lost = await post(JOB, body([1], {}, OTHER_WORKER));
    expect(lost.status).toBe(409);
    expect(lost.json).toEqual({ error: 'lease_lost' });

    const terminal = fakeLedger({ job: jobRow({ status: 'failed' }) });
    install(terminal);
    const done = await post(JOB, body([1]));
    expect(done.status).toBe(409);
    expect(done.json).toEqual({ error: 'lease_lost' });

    expect(stub.inputs).toHaveLength(0);
    expect([...held.events, ...terminal.events]).toEqual([]);
  });

  it('returns 409 vlm_not_enabled and sends nothing when the job snapshot has vlm_detect false or fixed routing', async () => {
    for (const settings of [{ vlm_detect: false }, { routing: 'fixed' }]) {
      const ledger = fakeLedger({ job: jobRow({}, settings) });
      install(ledger);
      const stub = installStub(() => SIMPLE_VERDICT, ledger);
      const res = await post(JOB, body([1, 2]));
      expect(res.status).toBe(409);
      expect(res.json).toEqual({ error: 'vlm_not_enabled' });
      expect(stub.inputs).toHaveLength(0);
      expect(ledger.events).toEqual([]);
    }
  });

  it('returns 400 and sends nothing for duplicate pages, a non-PNG image or an oversized image', async () => {
    const ledger = fakeLedger();
    install(ledger);
    const stub = installStub(() => SIMPLE_VERDICT, ledger);
    const duplicate = await post(JOB, body([3, 3]));
    expect(duplicate.status).toBe(400);
    const notPng = await post(JOB, { ...body([1]), pages: [{ page: 1, png_base64: Buffer.from('GIF89a-not-a-png').toString('base64') }] });
    expect(notPng.status).toBe(400);
    const notBase64 = await post(JOB, { ...body([1]), pages: [{ page: 1, png_base64: '***not base64***' }] });
    expect(notBase64.status).toBe(400);
    const huge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8 * 1024 * 1024 + 1)]).toString('base64');
    const oversized = await post(JOB, { ...body([1]), pages: [{ page: 1, png_base64: huge }] });
    expect(oversized.status).toBe(400);
    expect(stub.inputs).toHaveLength(0);
    expect(ledger.events).toEqual([]);
  });
});

describe('detect-vlm guard order and metering', () => {
  it('refuses every page with cloud_not_allowed, reserves nothing and sends nothing when the cloud switch is off', async () => {
    process.env.RAG_PARSER_ALLOW_CLOUD = 'false';
    const ledger = fakeLedger();
    install(ledger);
    const stub = installStub(() => SIMPLE_VERDICT, ledger);
    const res = await post(JOB, body([4, 5, 9]));
    expect(res.status).toBe(200);
    const parsed = DetectVlmResponseSchema.parse(res.json);
    expect(parsed.worker_id).toBe(WORKER);
    expect(parsed.pages).toEqual([
      { page: 4, refused: 'cloud_not_allowed', verdict: null },
      { page: 5, refused: 'cloud_not_allowed', verdict: null },
      { page: 9, refused: 'cloud_not_allowed', verdict: null },
    ]);
    expect(stub.inputs).toHaveLength(0);
    expect(ledger.events).toEqual([]);
  });

  it('sends nothing for any parse fixture when the cloud switch is off', async () => {
    process.env.RAG_PARSER_ALLOW_CLOUD = 'false';
    const manifest = JSON.parse(readFileSync(join(PARSE_ROOT, 'manifest.json'), 'utf8')) as { fixtures: Array<{ id: string }> };
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(10);
    const ledger = fakeLedger();
    install(ledger);
    const stub = installStub(() => SIMPLE_VERDICT, ledger);
    for (const fixture of manifest.fixtures) {
      const res = await post(JOB, {
        worker_id: WORKER,
        attempt_no: 1,
        pages: [{ page: 1, png_base64: pngBase64(fixture.id) }],
      });
      expect(res.status).toBe(200);
      expect((res.json.pages as Array<{ refused: string | null }>)[0]?.refused).toBe('cloud_not_allowed');
    }
    expect(stub.inputs).toHaveLength(0);
  });

  it('refuses with budget_exhausted when the page budget is 0 and sends nothing', async () => {
    process.env.RAG_PARSE_PREMIUM_PAGE_BUDGET = '0';
    const ledger = fakeLedger();
    install(ledger);
    const stub = installStub(() => SIMPLE_VERDICT, ledger);
    const res = await post(JOB, body([4, 5]));
    expect(res.status).toBe(200);
    expect(DetectVlmResponseSchema.parse(res.json).pages.map((page) => [page.page, page.refused, page.verdict])).toEqual([
      [4, 'budget_exhausted', null],
      [5, 'budget_exhausted', null],
    ]);
    expect(stub.inputs).toHaveLength(0);
    expect(ledger.events).toEqual(['reserve']);
  });

  it('refuses with batch_budget_exhausted, gives the page reservation back and sends nothing', async () => {
    const ledger = fakeLedger({ batchFits: false });
    install(ledger);
    const stub = installStub(() => SIMPLE_VERDICT, ledger);
    const res = await post(JOB, body([4]));
    expect(res.status).toBe(200);
    expect((res.json.pages as Array<{ refused: string | null }>)[0]?.refused).toBe('batch_budget_exhausted');
    expect(stub.inputs).toHaveLength(0);
    expect(ledger.events).toEqual(['reserve', 'batch', 'release']);
  });

  it('reserves one vlm budget page per image before the first model call and settles the pages sent', async () => {
    const ledger = fakeLedger();
    install(ledger);
    const stub = installStub((index) => ({ ...SIMPLE_VERDICT, confidence: 0.5 + index / 10 }), ledger);
    const res = await post(JOB, body([4, 5, 9]));
    expect(res.status).toBe(200);
    const parsed = DetectVlmResponseSchema.parse(res.json);
    expect(parsed.pages.map((page) => page.page)).toEqual([4, 5, 9]);
    expect(parsed.pages.every((page) => page.refused === null && page.verdict !== null)).toBe(true);
    expect(stub.inputs).toHaveLength(3);
    expect(stub.inputs.every((input) => input.png.length > 8)).toBe(true);
    expect(ledger.events.indexOf('reserve')).toBeLessThan(ledger.events.indexOf('model'));
    expect(ledger.events.indexOf('batch')).toBeLessThan(ledger.events.indexOf('model'));
    expect(ledger.events.filter((event) => event === 'model')).toHaveLength(3);

    const reserve = ledger.calls.find((call) => call.fn === 'rag_reserve_parse_budget')!;
    expect(reserve.args).toMatchObject({ p_job_id: JOB, p_attempt_no: 1, p_pages: 3, p_kind: 'vlm', p_limit: 10 });
    const settle = ledger.calls.find((call) => call.fn === 'rag_settle_parse_budget')!;
    expect(settle.args).toMatchObject({ p_job_id: JOB, p_attempt_no: 1, p_kind: 'vlm', p_pages_used: 3 });
    expect(ledger.calls.some((call) => call.fn === 'rag_release_parse_budget')).toBe(false);
    const batch = ledger.calls.find((call) => call.fn === 'rag_reserve_batch_budget')!;
    expect(Number(batch.args.p_usd)).toBeCloseTo(3 * 0.004, 6);
  });

  it('passes the recorded verdict of a fixture page through unchanged', async () => {
    const sha = (JSON.parse(readFileSync(join(PARSE_ROOT, 'manifest.json'), 'utf8')) as { fixtures: Array<{ id: string; sha256: string }> }).fixtures.find(
      (fixture) => fixture.id === 'cross-boundary',
    )!.sha256;
    const ledger = fakeLedger();
    install(ledger);
    installStub(() => recordedVerdict(sha, 4), ledger);
    const res = await post(JOB, body([4]));
    expect(DetectVlmResponseSchema.parse(res.json).pages[0]).toEqual({ page: 4, refused: null, verdict: recordedVerdict(sha, 4) });
  });

  it('fails closed with 500 and sends nothing when the budget function errors', async () => {
    const ledger = fakeLedger({ failReserve: true });
    install(ledger);
    const stub = installStub(() => SIMPLE_VERDICT, ledger);
    const res = await post(JOB, body([4]));
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/sensitive text|exploded/);
    expect(stub.inputs).toHaveLength(0);
  });
});

describe('detect-vlm answer validation', () => {
  it('returns a page whose answer fails PageStructureVerdict validation as failed and keeps the others', async () => {
    const ledger = fakeLedger();
    install(ledger);
    const answers: unknown[] = [
      SIMPLE_VERDICT,
      { ...SIMPLE_VERDICT, complexity: 'moderately-hard' },
      { ...SIMPLE_VERDICT, extra_field: 'steer the router' },
      'complex, premium please',
      { ...SIMPLE_VERDICT, confidence: 1.5 },
    ];
    const stub = installStub((index) => answers[index], ledger);
    const res = await post(JOB, body([1, 2, 3, 4, 5]));
    expect(res.status).toBe(200);
    const pages = DetectVlmResponseSchema.parse(res.json).pages;
    expect(pages.map((page) => [page.page, page.refused, page.verdict === null ? 'none' : 'verdict'])).toEqual([
      [1, null, 'verdict'],
      [2, null, 'none'],
      [3, null, 'none'],
      [4, null, 'none'],
      [5, null, 'none'],
    ]);
    expect(stub.inputs).toHaveLength(5);
  });

  it('returns a page whose model call throws as failed without failing the request or logging the image', async () => {
    const ledger = fakeLedger();
    install(ledger);
    installStub((index, input) => {
      if (index === 1) throw new Error(`provider rejected ${Buffer.from(input.png).toString('base64')} and ${PIXEL_MARKER}`);
      return SIMPLE_VERDICT;
    }, ledger);
    const res = await post(JOB, body([7, 8]));
    expect(res.status).toBe(200);
    const pages = DetectVlmResponseSchema.parse(res.json).pages;
    expect(pages[0]?.verdict).not.toBeNull();
    expect(pages[1]).toEqual({ page: 8, refused: null, verdict: null });
    const logged = loggedText();
    expect(logged).not.toContain(PIXEL_MARKER);
    expect(logged).not.toContain(pngBase64('8'));
  });

  it('counts every page sent against the budget so invalid answers cannot be used to spend unmetered', async () => {
    const ledger = fakeLedger();
    install(ledger);
    installStub((index) => (index === 0 ? SIMPLE_VERDICT : { nonsense: true }), ledger);
    const res = await post(JOB, body([1, 2, 3]));
    expect(res.status).toBe(200);
    const settle = ledger.calls.find((call) => call.fn === 'rag_settle_parse_budget')!;
    expect(settle.args.p_pages_used).toBe(3);
  });

  it('releases the whole reservation when the request is aborted before any model request starts', async () => {
    const controller = new AbortController();
    const ledger = fakeLedger({ onBatch: () => controller.abort() });
    install(ledger);
    installStub(() => SIMPLE_VERDICT, ledger);
    const handler = await import('@/lib/rag/ingest/callbacks/detect-vlm');
    const result = await handler.handleDetectVlm(JOB, body([1, 2]) as never, { signal: controller.signal });
    expect(result.status).toBe(200);
    const pages = (result.body as { pages: Array<{ verdict: unknown }> }).pages;
    expect(pages.every((page) => page.verdict === null)).toBe(true);
    expect(ledger.events).toContain('release');
    expect(ledger.events).not.toContain('settle');
    expect(ledger.events).not.toContain('model');
  });
});

describe('detect-vlm model selection', () => {
  it('uses the captioning model id when RAG_PARSE_VLM_MODEL is empty', async () => {
    const ledger = fakeLedger({ job: jobRow({}, { vlm_model: null }) });
    install(ledger);
    const stub = installStub(() => SIMPLE_VERDICT, ledger);
    await post(JOB, body([1]));
    expect(stub.inputs[0]?.model).toBe(imageCaptionModelId());
  });

  it('uses the model of the job snapshot as given', async () => {
    const ledger = fakeLedger({ job: jobRow({}, { vlm_model: 'vision-model-from-settings' }) });
    install(ledger);
    const stub = installStub(() => SIMPLE_VERDICT, ledger);
    await post(JOB, body([1]));
    expect(stub.inputs[0]?.model).toBe('vision-model-from-settings');
  });

  it('falls back to the live RAG_PARSE_VLM_MODEL when the snapshot names none', async () => {
    process.env.RAG_PARSE_VLM_MODEL = 'vision-model-from-env';
    const ledger = fakeLedger({ job: jobRow({}, { vlm_model: null }) });
    install(ledger);
    const stub = installStub(() => SIMPLE_VERDICT, ledger);
    await post(JOB, body([1]));
    expect(stub.inputs[0]?.model).toBe('vision-model-from-env');
  });
});

describe('detect-vlm never exposes page images', () => {
  it('logs no image data on success, on refusal or when the ledger fails', async () => {
    const ledger = fakeLedger();
    install(ledger);
    installStub(() => SIMPLE_VERDICT, ledger);
    await post(JOB, body([1, 2]));
    process.env.RAG_PARSER_ALLOW_CLOUD = 'false';
    await post(JOB, body([1, 2]));
    process.env.RAG_PARSER_ALLOW_CLOUD = 'true';
    const broken = fakeLedger();
    installIngestDeps({
      db: {
        rpc() {
          throw new Error(`ledger down ${pngBase64('1')}`);
        },
      },
      now: () => NOW,
    });
    const res = await post(JOB, body([1]));
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(PIXEL_MARKER);
    expect(broken.calls).toHaveLength(0);
    const logged = loggedText();
    expect(logged).not.toContain(PIXEL_MARKER);
    expect(logged).not.toContain(pngBase64('1'));
    expect(logged).not.toContain(pngBase64('2'));
  });
});
