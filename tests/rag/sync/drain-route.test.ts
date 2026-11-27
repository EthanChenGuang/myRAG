import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { VectorSyncSliceReportSchema, type VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';

const SECRET = 'vector-sync-secret-placeholder-0123456789';
const ROUTE_URL = 'http://localhost/api/internal/vector-sync/drain';

const sliceMock = vi.hoisted(() => vi.fn());
const adminMock = vi.hoisted(() => vi.fn(() => ({ rpc: () => undefined })));

vi.mock('@/lib/rag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag')>()),
  runVectorSyncSlice: sliceMock,
}));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: adminMock }));

function report(mode: 'drain' | 'reconcile'): VectorSyncSliceReport {
  return {
    mode,
    claimed: 2,
    upserted: 1,
    deleted: 0,
    failed: 0,
    dead: 0,
    lag_seconds: 0.5,
    elapsed_ms: 12,
    budget_ms: 45_000,
    more_pending: false,
  };
}

const env = process.env as Record<string, string | undefined>;
let saved: string | undefined;

async function loadRoute(secret: string | undefined) {
  if (secret === undefined) delete env.RAG_VECTOR_SYNC_SECRET;
  else env.RAG_VECTOR_SYNC_SECRET = secret;
  vi.resetModules();
  return import('@/app/api/internal/vector-sync/drain/route');
}

function post(headers: Record<string, string>, body?: unknown, signal?: AbortSignal): NextRequest {
  return new NextRequest(ROUTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

function get(headers: Record<string, string>, query = ''): NextRequest {
  return new NextRequest(`${ROUTE_URL}${query}`, { method: 'GET', headers });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(() => {
  saved = env.RAG_VECTOR_SYNC_SECRET;
  sliceMock.mockReset();
  sliceMock.mockImplementation(async (mode: 'drain' | 'reconcile') => report(mode));
  adminMock.mockClear();
});

afterEach(() => {
  if (saved === undefined) delete env.RAG_VECTOR_SYNC_SECRET;
  else env.RAG_VECTOR_SYNC_SECRET = saved;
});

describe('vector sync drain route: configuration (503)', () => {
  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['31 characters', 'x'.repeat(31)],
  ])('503 and nothing runs when the secret is %s', async (_label, secret) => {
    const route = await loadRoute(secret);
    for (const res of [
      await route.POST(post(bearer('x'.repeat(31)), {})),
      await route.GET(get(bearer('x'.repeat(31)))),
      await route.POST(post({}, {})),
    ]) {
      expect(res.status).toBe(503);
    }
    expect(sliceMock).not.toHaveBeenCalled();
  });
});

describe('vector sync drain route: authentication (401)', () => {
  test.each([
    ['no Authorization header', {}],
    ['a wrong token', bearer(`${SECRET}x`)],
    ['a non-Bearer scheme', { authorization: `Basic ${SECRET}` }],
    ['the bare secret', { authorization: SECRET }],
    ['an empty Bearer', { authorization: 'Bearer ' }],
  ])('401 and nothing runs with %s', async (_label, headers) => {
    const route = await loadRoute(SECRET);
    expect((await route.POST(post(headers as Record<string, string>, {}))).status).toBe(401);
    expect((await route.GET(get(headers as Record<string, string>))).status).toBe(401);
    expect(sliceMock).not.toHaveBeenCalled();
  });
});

describe('vector sync drain route: modes', () => {
  test('POST {} runs one drain slice and returns the report', async () => {
    const route = await loadRoute(SECRET);
    const res = await route.POST(post(bearer(SECRET), {}));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(VectorSyncSliceReportSchema.parse(json)).toEqual(report('drain'));
    expect(sliceMock).toHaveBeenCalledTimes(1);
    expect(sliceMock.mock.calls[0][0]).toBe('drain');
    expect(sliceMock.mock.calls[0][1].budgetMs).toBe(45_000);
  });

  test('POST with no body runs one drain slice (pg_net may send none)', async () => {
    const route = await loadRoute(SECRET);
    const res = await route.POST(post(bearer(SECRET)));
    expect(res.status).toBe(200);
    expect(sliceMock.mock.calls[0][0]).toBe('drain');
  });

  test('POST {mode: reconcile} runs one reconcile slice', async () => {
    const route = await loadRoute(SECRET);
    const res = await route.POST(post(bearer(SECRET), { mode: 'reconcile' }));
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('reconcile');
    expect(sliceMock.mock.calls[0][0]).toBe('reconcile');
  });

  test('GET (Vercel Cron) runs a drain slice; GET ?mode=reconcile a reconcile slice', async () => {
    const route = await loadRoute(SECRET);
    expect((await route.GET(get(bearer(SECRET)))).status).toBe(200);
    expect((await route.GET(get(bearer(SECRET), '?mode=reconcile'))).status).toBe(200);
    expect(sliceMock.mock.calls.map((call) => call[0])).toEqual(['drain', 'reconcile']);
  });

  test.each([
    ['an unknown mode', { mode: 'purge' }],
    ['an extra key', { mode: 'drain', tenant_key: 's:default' }],
    ['a non-object body', '[1]'],
    ['malformed JSON', '{"mode":'],
  ])('POST with %s answers 400 with the structured validation error and runs nothing', async (_label, body) => {
    const route = await loadRoute(SECRET);
    const res = await route.POST(post(bearer(SECRET), body));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(typeof json.error).toBe('string');
    expect(Array.isArray(json.details)).toBe(true);
    expect(sliceMock).not.toHaveBeenCalled();
  });

  test('GET with an unknown mode or an extra query key answers 400', async () => {
    const route = await loadRoute(SECRET);
    expect((await route.GET(get(bearer(SECRET), '?mode=purge'))).status).toBe(400);
    expect((await route.GET(get(bearer(SECRET), '?mode=drain&tenant=s:default'))).status).toBe(400);
    expect(sliceMock).not.toHaveBeenCalled();
  });

  test('the route does not abort its slice when the request signal aborts', async () => {
    const route = await loadRoute(SECRET);
    const controller = new AbortController();
    sliceMock.mockImplementation(async (mode: 'drain' | 'reconcile', options: Record<string, unknown>) => {
      controller.abort();
      expect(Object.values(options)).not.toContain(controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return report(mode);
    });
    const res = await route.POST(post(bearer(SECRET), {}, controller.signal));
    expect(res.status).toBe(200);
    expect(VectorSyncSliceReportSchema.safeParse(await res.json()).success).toBe(true);
  });

  test('a slice failure answers 500 with a code, never the secret or the error text', async () => {
    const route = await loadRoute(SECRET);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logs.push(JSON.stringify(args)));
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void logs.push(JSON.stringify(args)));
    sliceMock.mockRejectedValue(new Error(`boom ${SECRET} chunk text`));
    const res = await route.POST(post(bearer(SECRET), {}));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('chunk text');
    expect(logs.join('\n')).not.toContain(SECRET);
    spy.mockRestore();
    warn.mockRestore();
  });

  test('the secret never appears in a response', async () => {
    const route = await loadRoute(SECRET);
    for (const res of [
      await route.POST(post(bearer(SECRET), {})),
      await route.POST(post(bearer('wrong'), {})),
      await route.POST(post(bearer(SECRET), { mode: 'x' })),
    ]) {
      expect(await res.text()).not.toContain(SECRET);
    }
  });

  test('the route exports the Next.js segment config', async () => {
    const route = await loadRoute(SECRET);
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.maxDuration).toBe(60);
  });
});
