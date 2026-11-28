import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyWithPromptGuard, type PromptGuardItem } from '@/lib/rag/security/prompt-guard-client';

const SECRET = 'test-sidecar-secret-placeholder-0000000000';
const URL_BASE = 'http://sidecar.test';
const SENSITIVE = 'SENSITIVE-CHUNK-BODY-9921';
const config = { url: `${URL_BASE}/`, secret: SECRET };

interface Call {
  url: string;
  init: RequestInit;
  body: { items: PromptGuardItem[] };
}

function respond(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function benignFor(items: PromptGuardItem[]) {
  return {
    model_id: 'fake/prompt-guard',
    revision: '0'.repeat(40),
    results: items.map((item) => ({
      id: item.id,
      score: item.text.includes('PGFAKE-MALICIOUS') ? 0.995 : 0.01,
      label: item.text.includes('PGFAKE-MALICIOUS') ? 'MALICIOUS' : 'BENIGN',
      windows: 1,
    })),
  };
}

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) };
    calls.push(call);
    return handler(call);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function hangingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')));
      }),
  ) as unknown as typeof fetch;
}

function items(count: number, prefix = 'c'): PromptGuardItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, text: `${SENSITIVE} text ${index}` }));
}

function logSpies() {
  return ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
    vi.spyOn(console, method as 'log').mockImplementation(() => undefined),
  );
}

function allLogText(spies: Array<{ mock: { calls: unknown[][] } }>): string {
  return spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call))).join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyWithPromptGuard', () => {
  it('posts to the classify route with the secret header and returns results in request order', async () => {
    const { impl, calls } = fakeFetch((call) => respond(200, benignFor(call.body.items)));
    const input = [
      { id: 'z', text: 'plain text' },
      { id: 'a', text: 'has PGFAKE-MALICIOUS inside' },
    ];
    const outcome = await classifyWithPromptGuard(input, { timeoutMs: 1000, config, fetch: impl });
    expect(outcome).toEqual({
      ok: true,
      modelId: 'fake/prompt-guard',
      revision: '0'.repeat(40),
      results: [
        { id: 'z', score: 0.01, label: 'BENIGN', windows: 1 },
        { id: 'a', score: 0.995, label: 'MALICIOUS', windows: 1 },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${URL_BASE}/v1/injection/classify`);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['x-sidecar-secret']).toBe(SECRET);
    expect(calls[0].body).toEqual({ items: input });
  });

  it('splits batches above 32 items into sequential requests and keeps order', async () => {
    const { impl, calls } = fakeFetch((call) => respond(200, benignFor(call.body.items)));
    const input = items(70);
    const outcome = await classifyWithPromptGuard(input, { timeoutMs: 1000, config, fetch: impl });
    expect(calls.map((call) => call.body.items.length)).toEqual([32, 32, 6]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.results.map((result) => result.id)).toEqual(input.map((item) => item.id));
  });

  it('returns ok with no results and no request for an empty batch', async () => {
    const { impl, calls } = fakeFetch(() => respond(500, {}));
    const outcome = await classifyWithPromptGuard([], { timeoutMs: 1000, config, fetch: impl });
    expect(outcome).toEqual({ ok: true, modelId: null, revision: null, results: [] });
    expect(calls).toHaveLength(0);
  });

  it.each([
    { url: '', secret: SECRET },
    { url: URL_BASE, secret: '' },
    { url: '   ', secret: '  ' },
  ])('gives not_configured without calling fetch when url or secret is empty (%o)', async (partial) => {
    const { impl, calls } = fakeFetch(() => respond(200, {}));
    const outcome = await classifyWithPromptGuard(items(1), { timeoutMs: 1000, config: partial, fetch: impl });
    expect(outcome).toEqual({ ok: false, reason: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('reads the sidecar url and secret from env by default', async () => {
    const original = { url: process.env.RAG_SIDECAR_URL, secret: process.env.RAG_SIDECAR_SECRET };
    delete process.env.RAG_SIDECAR_URL;
    delete process.env.RAG_SIDECAR_SECRET;
    try {
      const { impl, calls } = fakeFetch(() => respond(200, {}));
      const outcome = await classifyWithPromptGuard(items(1), { timeoutMs: 1000, fetch: impl });
      expect(outcome).toEqual({ ok: false, reason: 'not_configured' });
      expect(calls).toHaveLength(0);
    } finally {
      if (original.url !== undefined) process.env.RAG_SIDECAR_URL = original.url;
      if (original.secret !== undefined) process.env.RAG_SIDECAR_SECRET = original.secret;
    }
  });

  it.each([401, 503, 500])('maps HTTP %i to http_<status> and cancels the body', async (status) => {
    const response = respond(status, { error: 'promptguard_unavailable' });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const { impl } = fakeFetch(() => response);
    const outcome = await classifyWithPromptGuard(items(2), { timeoutMs: 1000, config, fetch: impl });
    expect(outcome).toEqual({ ok: false, reason: `http_${status}` });
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    ['not json', '{oops'],
    ['wrong shape', { results: 'nope' }],
    ['score out of range', { model_id: 'm', revision: 'r', results: [{ id: 'c0', score: 2, label: 'BENIGN', windows: 1 }] }],
    ['extra field', { model_id: 'm', revision: 'r', results: [], extra: true }],
    ['missing result', { model_id: 'm', revision: 'r', results: [] }],
    ['wrong id', { model_id: 'm', revision: 'r', results: [{ id: 'other', score: 0.1, label: 'BENIGN', windows: 1 }] }],
  ])('gives malformed for a body that fails the schema or the request (%s)', async (_name, body) => {
    const { impl } = fakeFetch(() => respond(200, body));
    const outcome = await classifyWithPromptGuard([{ id: 'c0', text: 'x' }], { timeoutMs: 1000, config, fetch: impl });
    expect(outcome).toEqual({ ok: false, reason: 'malformed' });
  });

  it('gives malformed when results come back out of order', async () => {
    const { impl } = fakeFetch((call) => {
      const payload = benignFor(call.body.items);
      return respond(200, { ...payload, results: [...payload.results].reverse() });
    });
    const outcome = await classifyWithPromptGuard(items(2), { timeoutMs: 1000, config, fetch: impl });
    expect(outcome).toEqual({ ok: false, reason: 'malformed' });
  });

  it('gives timeout when the request outlives timeoutMs', async () => {
    const outcome = await classifyWithPromptGuard(items(1), { timeoutMs: 20, config, fetch: hangingFetch() });
    expect(outcome).toEqual({ ok: false, reason: 'timeout' });
  });

  it('gives aborted when the caller signal aborts, before or during the request', async () => {
    const already = new AbortController();
    already.abort();
    const { impl, calls } = fakeFetch(() => respond(200, {}));
    expect(await classifyWithPromptGuard(items(1), { signal: already.signal, timeoutMs: 1000, config, fetch: impl })).toEqual({
      ok: false,
      reason: 'aborted',
    });
    expect(calls).toHaveLength(0);

    const during = new AbortController();
    const pending = classifyWithPromptGuard(items(1), { signal: during.signal, timeoutMs: 5000, config, fetch: hangingFetch() });
    setTimeout(() => during.abort(), 10);
    expect(await pending).toEqual({ ok: false, reason: 'aborted' });
  });

  it('turns transport errors and invalid requests into values', async () => {
    const throwing = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await classifyWithPromptGuard(items(1), { timeoutMs: 1000, config, fetch: throwing })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
    const { impl, calls } = fakeFetch(() => respond(200, {}));
    const tooLong = [{ id: 'c0', text: 'x'.repeat(20_001) }];
    expect(await classifyWithPromptGuard(tooLong, { timeoutMs: 1000, config, fetch: impl })).toEqual({
      ok: false,
      reason: 'invalid_request',
    });
    expect(calls).toHaveLength(0);
  });

  it('never logs item text on any path', async () => {
    const spies = logSpies();
    const paths: Array<typeof fetch> = [
      fakeFetch(() => respond(500, { error: SENSITIVE })).impl,
      fakeFetch(() => respond(200, { echoed: SENSITIVE })).impl,
      vi.fn(async () => {
        throw new Error(SENSITIVE);
      }) as unknown as typeof fetch,
      hangingFetch(),
    ];
    for (const impl of paths) {
      const outcome = await classifyWithPromptGuard(items(3), { timeoutMs: 20, config, fetch: impl });
      expect(outcome.ok).toBe(false);
    }
    expect(allLogText(spies)).not.toContain(SENSITIVE);
  });
});
