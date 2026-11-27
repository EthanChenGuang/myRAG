import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { harness, headersFor, loadRoute, resetHarness } from './route-harness';

/**
 * D-15 (ADM-01): POST /api/rag/admin/providers/test. The guard runs first, the body is a strict provider enum, and neither the
 * response nor a log line carries the configured endpoint. Hosts, ports and keys are synthetic placeholders.
 */

const ROUTE = 'http://localhost/api/rag/admin/providers/test';
const QDRANT_URL = 'https://probe-host-qdrant.example.com:7443';
const QDRANT_HOST = 'probe-host-qdrant.example.com';
const QDRANT_READ_KEY = 'K7UJ6IK7OL18';

type Route = typeof import('@/app/api/rag/admin/providers/test/route');

const fetchState = { mode: 'ok' as 'ok' | 'refused', calls: [] as string[] };

const fakeFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  fetchState.calls.push(url);
  if (fetchState.mode === 'refused') {
    throw new TypeError(`fetch failed: connect ECONNREFUSED ${QDRANT_HOST}:7443 (${url})`);
  }
  const path = new URL(url).pathname;
  const body = path.startsWith('/collections/')
    ? { result: { config: { params: { vectors: { dense: { size: 1536 } } }, metadata: { dims: 1536 } } }, status: 'ok', time: 0 }
    : { title: 'qdrant', version: '1.0.0' };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
});

async function load(): Promise<Route> {
  const route = await loadRoute<Route>(() => import('@/app/api/rag/admin/providers/test/route'));
  const ragDeps = await import('@/lib/rag/deps');
  ragDeps.setRagDepsForTests({ fetch: fakeFetch as unknown as typeof fetch });
  return route;
}

function post(route: Route, auth: Parameters<typeof headersFor>[0], body: unknown, raw = false): Promise<Response> {
  return route.POST(
    new Request(ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headersFor(auth) },
      body: raw ? (body as string) : JSON.stringify(body),
    }) as never,
  );
}

function expectNoEndpoint(text: string): void {
  for (const needle of [QDRANT_URL, QDRANT_HOST, `${QDRANT_HOST}:7443`, 'probe-host-qdrant', QDRANT_READ_KEY]) {
    expect(text).not.toContain(needle);
  }
}

beforeEach(() => {
  resetHarness();
  fetchState.mode = 'ok';
  fetchState.calls = [];
  fakeFetch.mockClear();
  vi.stubGlobal('fetch', fakeFetch);
  vi.stubEnv('QDRANT_URL', QDRANT_URL);
  vi.stubEnv('QDRANT_READ_API_KEY', QDRANT_READ_KEY);
  vi.stubEnv('QDRANT_API_KEY', '');
  vi.stubEnv('RAG_EMBEDDING_PROFILES', 'off');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/rag/admin/providers/test', () => {
  test('no session: 401; non-admin: 403; forged cookie or literal bearer: 401; no probe runs', async () => {
    const route = await load();
    expect((await post(route, 'none', { provider: 'backend:qdrant' })).status).toBe(401);
    expect((await post(route, 'user', { provider: 'backend:qdrant' })).status).toBe(403);
    expect((await post(route, 'forged', { provider: 'backend:qdrant' })).status).toBe(401);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test('admin verification unavailable: 503 and no probe runs', async () => {
    harness.guardAvailable = false;
    const route = await load();
    expect((await post(route, 'admin', { provider: 'backend:qdrant' })).status).toBe(503);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test('backend:qdrant returns the probe result with status 200, within a 10 s signal', async () => {
    const route = await load();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const response = await post(route, 'admin', { provider: 'backend:qdrant' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ provider: 'backend:qdrant', ok: true, code: 'ok', message: 'Connected.' });
    expect(Object.keys(body).sort()).toEqual(['code', 'latencyMs', 'message', 'ok', 'provider']);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetchState.calls.length).toBeGreaterThan(0);
  });

  test('a failed probe still answers 200 with ok false', async () => {
    fetchState.mode = 'refused';
    const route = await load();
    const response = await post(route, 'admin', { provider: 'backend:qdrant' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: 'backend:qdrant', ok: false, code: 'unreachable' });
  });

  test('never leaks endpoint: neither the body nor a log line names the Qdrant URL, host or host:port', async () => {
    for (const mode of ['ok', 'refused'] as const) {
      fetchState.mode = mode;
      harness.logged = [];
      const route = await load();
      const text = await (await post(route, 'admin', { provider: 'backend:qdrant' })).text();
      expectNoEndpoint(text);
      for (const line of harness.logged) expectNoEndpoint(line);
    }
  });

  test('logs [RAG Admin] provider test with provider, ok and code only', async () => {
    const route = await load();
    await post(route, 'admin', { provider: 'backend:qdrant' });
    const line = harness.logged.find((entry) => entry.startsWith('[RAG Admin] provider test'));
    expect(line).toBeDefined();
    const detail = JSON.parse(line!.slice('[RAG Admin] provider test '.length)) as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(['code', 'ok', 'provider']);
  });

  test.each([
    ['an unknown provider', { provider: 'backend:other' }, false],
    ['an extra url key', { provider: 'backend:qdrant', url: 'https://attacker.example.com' }, false],
    ['an extra key field', { provider: 'backend:qdrant', apiKey: 'override' }, false],
    ['a missing provider', {}, false],
    ['a non-JSON body', 'provider=backend:qdrant', true],
  ])('%s returns 400 with details and runs nothing', async (_label, body, raw) => {
    const route = await load();
    const response = await post(route, 'admin', body, raw);
    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.success).toBe(false);
    expect(json.details).toBeDefined();
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});
