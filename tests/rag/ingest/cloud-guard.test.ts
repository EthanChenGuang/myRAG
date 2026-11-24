import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import {
  CloudGuardError,
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
