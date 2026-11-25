import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestGroundedness } from '@/lib/rag/generation/groundedness-client';
import type { GroundednessRequest } from '@/lib/rag-eval/contracts.generated';

const SECRET = 'test-sidecar-secret-placeholder-0000000000';
const HYPOTHESIS = 'Employees get twenty days of leave per year.';
const PREMISE = 'Annual leave: every employee is entitled to twenty days.';

const request: GroundednessRequest = {
  request_id: 'answer-1',
  language: 'en',
  premise_texts: [PREMISE],
  hypothesis: HYPOTHESIS,
  allow_vectara: false,
};

interface Seen {
  method?: string;
  path?: string;
  secret?: string | string[];
  contentType?: string;
  body?: unknown;
}

type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

const servers: Server[] = [];

async function startServer(handler: Handler): Promise<{ url: string; seen: Seen }> {
  const seen: Seen = {};
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      seen.method = req.method;
      seen.path = req.url;
      seen.secret = req.headers['x-sidecar-secret'];
      seen.contentType = req.headers['content-type'];
      seen.body = raw ? JSON.parse(raw) : undefined;
      handler(req, res, seen);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function allLogText(spies: Array<{ mock: { calls: unknown[][] } }>): string {
  return spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call))).join('\n');
}

describe('requestGroundedness', () => {
  it('posts the request with the secret header and returns the parsed result', async () => {
    const result = { status: 'scored', scorer: 'hhem_2_1_open', score: 0.83, reason: null, truncated: false, latency_ms: 412 };
    const { url, seen } = await startServer((_req, res) => json(res, 200, result));
    const got = await requestGroundedness(request, { url: `${url}/`, secret: SECRET, timeoutMs: 2000 });
    expect(got).toEqual(result);
    expect(seen.method).toBe('POST');
    expect(seen.path).toBe('/v1/groundedness');
    expect(seen.secret).toBe(SECRET);
    expect(seen.contentType).toContain('application/json');
    expect(seen.body).toEqual(request);
  });

  it('fills schema defaults for omitted optional fields', async () => {
    const { url } = await startServer((_req, res) =>
      json(res, 200, { status: 'not_checked', scorer: 'none', latency_ms: 2, reason: 'unsupported_language' }),
    );
    expect(await requestGroundedness(request, { url, secret: SECRET, timeoutMs: 2000 })).toEqual({
      status: 'not_checked',
      scorer: 'none',
      score: null,
      reason: 'unsupported_language',
      truncated: false,
      latency_ms: 2,
    });
  });

  it('aborts a sidecar that never answers after the timeout', async () => {
    const { url } = await startServer(() => {
      // never answers
    });
    const started = Date.now();
    const got = await requestGroundedness(request, { url, secret: SECRET, timeoutMs: 150 });
    const elapsed = Date.now() - started;
    expect(got).toMatchObject({ status: 'not_checked', scorer: 'none', score: null, reason: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(2000);
  });

  it('times out a sidecar that sends headers but stalls the body', async () => {
    const { url } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"status":');
    });
    const got = await requestGroundedness(request, { url, secret: SECRET, timeoutMs: 150 });
    expect(got).toMatchObject({ status: 'not_checked', scorer: 'none', reason: 'timeout' });
  });

  for (const status of [401, 503, 500]) {
    it(`maps HTTP ${status} to reason error`, async () => {
      const { url } = await startServer((_req, res) => json(res, status, { error: 'nope' }));
      const got = await requestGroundedness(request, { url, secret: SECRET, timeoutMs: 2000 });
      expect(got).toMatchObject({ status: 'not_checked', scorer: 'none', score: null, reason: 'error', truncated: false });
    });
  }

  it('maps a body that fails the schema to reason error', async () => {
    const { url } = await startServer((_req, res) =>
      json(res, 200, { status: 'scored', scorer: 'hhem_2_1_open', score: 7, latency_ms: 1 }),
    );
    expect(await requestGroundedness(request, { url, secret: SECRET, timeoutMs: 2000 })).toMatchObject({
      status: 'not_checked',
      reason: 'error',
    });
  });

  it('maps a body that is not JSON to reason error', async () => {
    const { url } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    expect(await requestGroundedness(request, { url, secret: SECRET, timeoutMs: 2000 })).toMatchObject({
      status: 'not_checked',
      reason: 'error',
    });
  });

  it('maps a refused connection to reason error', async () => {
    const { url } = await startServer(() => {});
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    expect(await requestGroundedness(request, { url, secret: SECRET, timeoutMs: 2000 })).toMatchObject({
      status: 'not_checked',
      reason: 'error',
    });
  });

  it('gives scorer_unavailable without a request when the URL or secret is empty', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    for (const options of [
      { url: '', secret: SECRET },
      { url: 'http://127.0.0.1:9', secret: '' },
      { url: '  ', secret: '  ' },
    ]) {
      expect(await requestGroundedness(request, { ...options, timeoutMs: 2000, fetch: fetchSpy })).toEqual({
        status: 'not_checked',
        scorer: 'none',
        score: null,
        reason: 'scorer_unavailable',
        truncated: false,
        latency_ms: 0,
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never throws, even when fetch itself throws synchronously', async () => {
    const throwing = (() => {
      throw new Error(`boom ${HYPOTHESIS}`);
    }) as unknown as typeof fetch;
    await expect(
      requestGroundedness(request, { url: 'http://127.0.0.1:9', secret: SECRET, timeoutMs: 2000, fetch: throwing }),
    ).resolves.toMatchObject({ status: 'not_checked', reason: 'error' });
  });

  it('logs nothing that contains request text or the secret', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];
    const { url } = await startServer((_req, res) => json(res, 500, { detail: HYPOTHESIS }));
    await requestGroundedness(request, { url, secret: SECRET, timeoutMs: 2000 });
    const throwing = (() => {
      throw new Error(`boom ${HYPOTHESIS} ${PREMISE}`);
    }) as unknown as typeof fetch;
    await requestGroundedness(request, { url, secret: SECRET, timeoutMs: 2000, fetch: throwing });
    const logged = allLogText(spies);
    expect(logged).not.toContain(HYPOTHESIS);
    expect(logged).not.toContain(PREMISE);
    expect(logged).not.toContain(SECRET);
  });
});
