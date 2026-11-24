import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { buildParserChain, parseWithFallback } from '@/lib/rag/ingest/parsers/chain';
import { createLlamaParseParser, resetLlamaParseParserForTests, setLlamaParseParserForTests } from '@/lib/rag/ingest/parsers/llamaparse-v2';
import { resetSidecarParserForTests, setSidecarParserForTests } from '@/lib/rag/ingest/parsers/sidecar-docling';
import type { DocumentParser, ParseRequest } from '@/lib/rag/ingest/parsers/shared';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { mintScope } from '@/lib/rag/tenant/scope';
import { startFakeLlamaParse, type FakeLlamaParse } from '../../helpers/fake-llamaparse';
import {
  CloudGuardError,
  CloudRefused,
  assertCloudAllowed,
  readMonthlyUsage,
  release,
  reservePremium,
  reserveVlm,
  resetCloudGuardDepsForTests,
  setCloudGuardDepsForTests,
  settle,
} from '@/lib/rag/ingest/guard/cloud-budget';

const JOB = '11111111-1111-4111-8111-111111111111';

interface Recorded {
  fn: string;
  args: Record<string, unknown>;
}

type Answer = boolean | { error: { code: string; message: string } } | unknown[];

function fakeDb(answers: Record<string, Answer | ((args: Record<string, unknown>) => Answer)> = {}): { client: RpcClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const raw = answers[fn];
      const answer = typeof raw === 'function' ? raw(args) : raw;
      let response: RpcResponse;
      if (answer && typeof answer === 'object' && !Array.isArray(answer)) response = { data: null, error: answer.error };
      else if (Array.isArray(answer)) response = { data: answer, error: null };
      else response = { data: [{ [fn]: answer ?? true }], error: null };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { client, calls };
}

const queued = (pages: number, overrides: Partial<Parameters<typeof reservePremium>[0]> = {}) => ({
  jobId: JOB,
  attemptNo: 1,
  pages,
  estUsd: 0.05,
  routing: 'tiered' as const,
  queued: true,
  ...overrides,
});

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', 'true');
  vi.stubEnv('RAG_PARSE_PREMIUM_PAGE_BUDGET', '100');
  vi.stubEnv('RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC', '200');
});

afterEach(() => {
  resetCloudGuardDepsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('cloud switch', () => {
  test('cloud false: every entry point refuses with cloud_not_allowed and no RPC is called', async () => {
    vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', 'false');
    const db = fakeDb();
    setCloudGuardDepsForTests({ db: () => db.client });
    expect(assertCloudAllowed('parse')).toEqual({ ok: false, reason: 'cloud_not_allowed' });
    expect(assertCloudAllowed('vlm')).toEqual({ ok: false, reason: 'cloud_not_allowed' });
    expect(await reservePremium(queued(5))).toEqual({ ok: false, reason: 'cloud_not_allowed' });
    expect(await reserveVlm(queued(5))).toEqual({ ok: false, reason: 'cloud_not_allowed' });
    expect(await reservePremium({ pages: 5, routing: 'fixed', queued: false })).toEqual({ ok: false, reason: 'cloud_not_allowed' });
    expect(db.calls).toEqual([]);
  });

  test('the switch is read on every call, not once at import', () => {
    expect(assertCloudAllowed('parse')).toEqual({ ok: true });
    vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', 'false');
    expect(assertCloudAllowed('parse')).toEqual({ ok: false, reason: 'cloud_not_allowed' });
    vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', 'true');
    expect(assertCloudAllowed('parse')).toEqual({ ok: true });
  });

  test('a refusal logs the reason under [Ingest] and nothing else about the document', async () => {
    vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', 'false');
    assertCloudAllowed('parse');
    const lines = warn.mock.calls.map((args: unknown[]) => JSON.stringify(args));
    expect(lines.some((line: string) => line.includes('[Ingest]') && line.includes('cloud_not_allowed'))).toBe(true);
  });
});

describe('inline and fixed runs', () => {
  test('without a queued tiered job only the cloud switch applies: no cap, no budget, no RPC', async () => {
    vi.stubEnv('RAG_PARSE_PREMIUM_PAGE_BUDGET', '0');
    vi.stubEnv('RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC', '1');
    const db = fakeDb();
    setCloudGuardDepsForTests({ db: () => db.client });
    expect(await reservePremium({ pages: 900, routing: 'fixed', queued: false })).toEqual({ ok: true, handle: null });
    expect(await reservePremium(queued(900, { routing: 'fixed' }))).toEqual({ ok: true, handle: null });
    expect(await reservePremium(queued(900, { queued: false }))).toEqual({ ok: true, handle: null });
    expect(await reserveVlm({ pages: 3, routing: 'fixed', queued: false })).toEqual({ ok: true, handle: null });
    expect(db.calls).toEqual([]);
  });
});

describe('queued tiered jobs', () => {
  test('201 premium pages with a cap of 200 refuses with over_page_cap and reserves nothing', async () => {
    const db = fakeDb();
    setCloudGuardDepsForTests({ db: () => db.client });
    expect(await reservePremium(queued(201))).toEqual({ ok: false, reason: 'over_page_cap' });
    expect(db.calls).toEqual([]);
  });

  test('exactly the cap passes the cap check', async () => {
    const db = fakeDb();
    setCloudGuardDepsForTests({ db: () => db.client });
    vi.stubEnv('RAG_PARSE_PREMIUM_PAGE_BUDGET', '500');
    const result = await reservePremium(queued(200));
    expect(result.ok).toBe(true);
  });

  test('50 pages with a budget of 0 refuses with budget_exhausted', async () => {
    vi.stubEnv('RAG_PARSE_PREMIUM_PAGE_BUDGET', '0');
    const db = fakeDb({ rag_reserve_parse_budget: (args) => Number(args.p_pages) <= Number(args.p_limit) });
    setCloudGuardDepsForTests({ db: () => db.client });
    expect(await reservePremium(queued(50))).toEqual({ ok: false, reason: 'budget_exhausted' });
    expect(db.calls.map((call) => call.fn)).toEqual(['rag_reserve_parse_budget']);
  });

  test('50 pages with a budget of 100 reserves 50 and returns the handle', async () => {
    const db = fakeDb({ rag_reserve_parse_budget: (args) => Number(args.p_pages) <= Number(args.p_limit) });
    setCloudGuardDepsForTests({ db: () => db.client });
    const result = await reservePremium(queued(50));
    expect(result).toEqual({ ok: true, handle: { jobId: JOB, attemptNo: 1, kind: 'parse', pages: 50 } });
    expect(db.calls[0]).toEqual({
      fn: 'rag_reserve_parse_budget',
      args: { p_job_id: JOB, p_attempt_no: 1, p_pages: 50, p_kind: 'parse', p_limit: 100 },
    });
    expect(db.calls.map((call) => call.fn)).toEqual(['rag_reserve_parse_budget', 'rag_reserve_batch_budget']);
    expect(db.calls[1]?.args).toEqual({ p_job_id: JOB, p_usd: 0.05 });
  });

  test('a batch with 0.10 USD left and a 0.20 USD estimate refuses with batch_budget_exhausted and releases the pages it took', async () => {
    const db = fakeDb({ rag_reserve_batch_budget: false });
    setCloudGuardDepsForTests({ db: () => db.client });
    const result = await reservePremium(queued(50, { estUsd: 0.2 }));
    expect(result).toEqual({ ok: false, reason: 'batch_budget_exhausted' });
    expect(db.calls.map((call) => call.fn)).toEqual(['rag_reserve_parse_budget', 'rag_reserve_batch_budget', 'rag_release_parse_budget']);
    expect(db.calls[2]?.args).toEqual({ p_job_id: JOB, p_attempt_no: 1, p_kind: 'parse' });
  });

  test('the cap is checked before the budget, and the budget before the batch', async () => {
    const db = fakeDb({ rag_reserve_parse_budget: false });
    setCloudGuardDepsForTests({ db: () => db.client });
    expect(await reservePremium(queued(50))).toEqual({ ok: false, reason: 'budget_exhausted' });
    expect(db.calls.map((call) => call.fn)).toEqual(['rag_reserve_parse_budget']);
    expect(await reservePremium(queued(500))).toEqual({ ok: false, reason: 'over_page_cap' });
    expect(db.calls).toHaveLength(1);
  });

  test('reserveVlm reserves kind vlm and does not apply the per-document premium cap', async () => {
    vi.stubEnv('RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC', '5');
    const db = fakeDb();
    setCloudGuardDepsForTests({ db: () => db.client });
    const result = await reserveVlm(queued(20));
    expect(result).toEqual({ ok: true, handle: { jobId: JOB, attemptNo: 1, kind: 'vlm', pages: 20 } });
    expect(db.calls[0]?.args).toMatchObject({ p_kind: 'vlm', p_pages: 20 });
  });

  test('a database error fails closed with a stable code and releases a page reservation already taken', async () => {
    const db = fakeDb({ rag_reserve_batch_budget: { error: { code: '22023', message: 'parse_budget_refused: job_not_found with row text' } } });
    setCloudGuardDepsForTests({ db: () => db.client });
    const failure = await reservePremium(queued(10)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CloudGuardError);
    expect((failure as CloudGuardError).code).toBe('22023');
    expect((failure as Error).message).not.toContain('row text');
    expect(db.calls.map((call) => call.fn)).toEqual(['rag_reserve_parse_budget', 'rag_reserve_batch_budget', 'rag_release_parse_budget']);

    setCloudGuardDepsForTests({ db: () => null });
    await expect(reservePremium(queued(10))).rejects.toBeInstanceOf(CloudGuardError);
  });
});

describe('settle, release and usage', () => {
  const handle = { jobId: JOB, attemptNo: 2, kind: 'parse' as const, pages: 30 };

  test('settle and release call the matching RPC once by job id and attempt', async () => {
    const db = fakeDb();
    setCloudGuardDepsForTests({ db: () => db.client });
    expect(await settle(handle, 28)).toBe(true);
    expect(db.calls).toEqual([{ fn: 'rag_settle_parse_budget', args: { p_job_id: JOB, p_attempt_no: 2, p_kind: 'parse', p_pages_used: 28 } }]);
    expect(await release({ ...handle, kind: 'vlm' })).toBe(true);
    expect(db.calls).toHaveLength(2);
    expect(db.calls[1]).toEqual({ fn: 'rag_release_parse_budget', args: { p_job_id: JOB, p_attempt_no: 2, p_kind: 'vlm' } });
  });

  test('a scalar boolean answer, as PostgREST gives it, is read like a row answer', async () => {
    const db = fakeDb();
    const scalar: RpcClient = {
      rpc(fn, args) {
        db.calls.push({ fn, args });
        const request: RpcRequest = {
          abortSignal: () => request,
          then: (onFulfilled, onRejected) => Promise.resolve({ data: true as unknown as unknown[], error: null }).then(onFulfilled, onRejected),
        };
        return request;
      },
    };
    setCloudGuardDepsForTests({ db: () => scalar });
    expect(await settle(handle, 1)).toBe(true);
    expect((await reservePremium(queued(5))).ok).toBe(true);
  });

  test('readMonthlyUsage wraps rag_parse_budget_month with the tenant key', async () => {
    const rows = [{ tenant_key: 's:default', month: '2026-11-01', pages_reserved: 1, pages_used: 2, vlm_pages_used: 3 }];
    const db = fakeDb({ rag_parse_budget_month: rows });
    setCloudGuardDepsForTests({ db: () => db.client });
    expect(await readMonthlyUsage('s:default')).toEqual(rows);
    expect(db.calls[0]).toEqual({ fn: 'rag_parse_budget_month', args: { p_tenant_key: 's:default' } });
    await readMonthlyUsage();
    expect(db.calls[1]?.args).toEqual({ p_tenant_key: null });
  });
});

const scope = mintScope('single', null, null);
const PDF = new TextEncoder().encode('%PDF-1.4 cloud guard fixture');
const SCAN = new TextEncoder().encode('%PDF-1.4 scanned pages only');

function parseRequest(overrides: Partial<ParseRequest> = {}): ParseRequest {
  return {
    scope,
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    bytes: PDF,
    profile: getProcessingProfile('general'),
    signal: new AbortController().signal,
    now: () => 0,
    deadline: 10 ** 9,
    pollUntil: 45_000,
    resume: null,
    onSubmitted: async () => undefined,
    ...overrides,
  };
}

function doclingStub(): DocumentParser & { calls: ParseRequest[] } {
  const calls: ParseRequest[] = [];
  return {
    name: 'docling',
    calls,
    unavailableReason: () => null,
    async parse(request) {
      calls.push(request);
      const result = {
        markdown: '# Handbook\n\nThe night crew scans every pallet at the dock.',
        chunks: [],
        pictures: [],
        page_count: 1,
        language: 'en',
        parser: 'docling',
        parser_version: 'docling-test',
        partial: false,
        text_layer_page_share: null,
        warnings: [],
      } as ParseResult;
      return { kind: 'done', result, artifacts: [], warnings: [] };
    },
  };
}

describe('LlamaParse entry and the chain with cloud parsing off', () => {
  let fake: FakeLlamaParse;
  let lines: string[];

  beforeEach(async () => {
    fake = await startFakeLlamaParse();
    lines = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(JSON.stringify(args)));
    }
  });

  afterEach(async () => {
    resetLlamaParseParserForTests();
    resetSidecarParserForTests();
    await fake.close();
  });

  const llama = () => createLlamaParseParser({ baseUrl: fake.url, apiKey: fake.apiKey, tier: 'cost_effective' });
  const chain = () => buildParserChain(getProcessingProfile('general'), { parser: 'llamaparse' }, { filename: 'a.pdf', mimeType: 'application/pdf' });

  test('RAG_PARSER_ALLOW_CLOUD=false: a PDF and a scan reach Docling and the LlamaParse stub gets zero requests', async () => {
    vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', 'false');
    const docling = doclingStub();
    setLlamaParseParserForTests(llama());
    setSidecarParserForTests(docling);
    for (const bytes of [PDF, SCAN]) {
      const outcome = await parseWithFallback(chain(), parseRequest({ bytes }));
      expect(outcome.kind).toBe('done');
      if (outcome.kind !== 'done') return;
      expect(outcome.parser).toBe('docling');
      expect(outcome.fallbacks).toEqual([{ parser: 'llamaparse', reason: 'cloud_not_allowed' }]);
    }
    expect(fake.calls).toEqual([]);
    expect(fake.uploads).toEqual([]);
    expect(docling.calls).toHaveLength(2);
  });

  test('a cloud-off run logs one [Ingest] line with the reason per document and no file name', async () => {
    vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', 'false');
    setLlamaParseParserForTests(llama());
    setSidecarParserForTests(doclingStub());
    await parseWithFallback(chain(), parseRequest({ filename: 'quarterly-secret-plan.pdf' }));
    const reasons = lines.filter((line) => line.includes('[Ingest]') && line.includes('cloud_not_allowed'));
    expect(reasons).toHaveLength(1);
    expect(lines.some((line) => line.includes('quarterly-secret-plan'))).toBe(false);
  });

  test('a direct call to the v2 client with cloud off throws CloudRefused before fetch is called', async () => {
    vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', 'false');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(llama().parse(parseRequest())).rejects.toBeInstanceOf(CloudRefused);
    await expect(llama().parse(parseRequest())).rejects.toMatchObject({ reason: 'cloud_not_allowed' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  test('the switch is live: turning it off after the parser was built still stops the upload', async () => {
    const parser = llama();
    vi.stubEnv('RAG_PARSER_ALLOW_CLOUD', 'false');
    await expect(parser.parse(parseRequest())).rejects.toBeInstanceOf(CloudRefused);
    expect(fake.uploads).toEqual([]);
  });

  test('cloud on (the default): the chain still uses LlamaParse first', async () => {
    const docling = doclingStub();
    setLlamaParseParserForTests(llama());
    setSidecarParserForTests(docling);
    const outcome = await parseWithFallback(chain(), parseRequest());
    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.parser).toBe('llamaparse');
    expect(fake.uploads).toHaveLength(1);
    expect(docling.calls).toHaveLength(0);
  });

  test('a queued tiered request reserves before the upload and hands the reservation to the caller', async () => {
    const db = fakeDb({ rag_reserve_parse_budget: true });
    setCloudGuardDepsForTests({ db: () => db.client });
    const reservations: unknown[] = [];
    const guarded = parseRequest({
      guard: { context: queued(3), onReserved: async (handle) => void reservations.push(handle) },
    });
    const attempt = await llama().parse(guarded);
    expect(attempt.kind).toBe('done');
    expect(reservations).toEqual([{ jobId: JOB, attemptNo: 1, kind: 'parse', pages: 3 }]);
    expect(db.calls.map((call) => call.fn)).toEqual(['rag_reserve_parse_budget', 'rag_reserve_batch_budget']);
    expect(fake.uploads).toHaveLength(1);
  });

  test('a queued tiered request over the page cap or the budget is refused with zero requests at the stub', async () => {
    const db = fakeDb({ rag_reserve_parse_budget: false });
    setCloudGuardDepsForTests({ db: () => db.client });
    await expect(llama().parse(parseRequest({ guard: { context: queued(500) } }))).rejects.toMatchObject({ reason: 'over_page_cap' });
    await expect(llama().parse(parseRequest({ guard: { context: queued(5) } }))).rejects.toMatchObject({ reason: 'budget_exhausted' });
    expect(fake.calls).toEqual([]);
  });

  test('a resumed job is not reserved again', async () => {
    const db = fakeDb();
    setCloudGuardDepsForTests({ db: () => db.client });
    fake.enqueue({ statuses: ['COMPLETED'] });
    const first = await llama().parse(parseRequest({ guard: { context: queued(3) } }));
    expect(first.kind).toBe('done');
    db.calls.length = 0;
    const resume = { parser: 'llamaparse' as const, jobId: 'job-1', submittedAt: new Date(0).toISOString(), attempt: 1 };
    await llama().parse(parseRequest({ resume, guard: { context: queued(3) } }));
    expect(db.calls).toEqual([]);
  });
});
