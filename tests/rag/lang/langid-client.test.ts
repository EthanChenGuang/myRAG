import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { langidConfigured, requestLanguageId } from '@/lib/rag/lang/langid-client';
import { resolveQueryLanguage, type ResolveQueryLanguageInput } from '@/lib/rag/lang/resolve-query-language';

const URL_ = 'http://sidecar.test';
const SECRET = 'test-secret-placeholder';
const QUERY = 'zebrafishquartz gateway';
const PARAMS = { language_confidence_threshold: 0.6, langid_timeout_ms: 30 };

type Recorded = { url: string; init: RequestInit };

function fakeFetch(respond: (signal: AbortSignal) => Promise<Response>) {
  const calls: Recorded[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(init.signal as AbortSignal);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function delayed(ms: number, body: unknown) {
  return (signal: AbortSignal) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(json(body)), ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
}

const options = (fetchImpl: typeof fetch) => ({ timeoutMs: 30, url: URL_, secret: SECRET, fetch: fetchImpl });

function loggedText(): string {
  return [console.log, console.info, console.warn, console.error]
    .flatMap((spy) => vi.mocked(spy).mock.calls)
    .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    .join('\n');
}

describe('requestLanguageId (D-17, D-18)', () => {
  beforeEach(() => {
    for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('a fast answer naming an enabled language is returned; the request carries the text capped at 1000 characters and the candidates', async () => {
    const { impl, calls } = fakeFetch(async () => json({ language: 'it', confidence: 0.92, model: 'fake' }));
    const long = `${QUERY} ${'x'.repeat(1200)}`;
    const answer = await requestLanguageId(long, ['zh', 'en', 'it'], options(impl));
    expect(answer).toEqual({ language: 'it', confidence: 0.92 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${URL_}/v1/langid`);
    expect((calls[0]!.init.headers as Record<string, string>)['x-sidecar-secret']).toBe(SECRET);
    const body = JSON.parse(String(calls[0]!.init.body)) as { text: string; candidates: string[] };
    expect(body.text).toHaveLength(1000);
    expect(body.candidates).toEqual(['zh', 'en', 'it']);
  });

  it('an answer after the timeout is no answer', async () => {
    const { impl } = fakeFetch(delayed(80, { language: 'en', confidence: 0.9, model: 'fake' }));
    await expect(requestLanguageId(QUERY, ['zh', 'en', 'it'], options(impl))).resolves.toBeNull();
  });

  it('an HTTP error is no answer', async () => {
    const { impl } = fakeFetch(async () => json({ detail: 'boom' }, 500));
    await expect(requestLanguageId(QUERY, ['zh', 'en', 'it'], options(impl))).resolves.toBeNull();
  });

  it('an invalid body is no answer', async () => {
    const { impl } = fakeFetch(async () => json({ language: 'en', confidence: 7 }));
    await expect(requestLanguageId(QUERY, ['zh', 'en', 'it'], options(impl))).resolves.toBeNull();
  });

  it('a language outside the candidates, or none, is no answer', async () => {
    const other = fakeFetch(async () => json({ language: 'zh', confidence: 0.9, model: 'fake' }));
    await expect(requestLanguageId(QUERY, ['en', 'it'], options(other.impl))).resolves.toBeNull();
    const none = fakeFetch(async () => json({ language: null, confidence: 0, model: 'fake' }));
    await expect(requestLanguageId(QUERY, ['en', 'it'], options(none.impl))).resolves.toBeNull();
  });

  it('a transport failure or an aborted request never throws', async () => {
    const failing = fakeFetch(async () => {
      throw new TypeError('network down');
    });
    await expect(requestLanguageId(QUERY, ['zh', 'en', 'it'], options(failing.impl))).resolves.toBeNull();
    const controller = new AbortController();
    controller.abort();
    const { impl, calls } = fakeFetch(delayed(5, { language: 'en', confidence: 0.9, model: 'fake' }));
    await expect(requestLanguageId(QUERY, ['zh', 'en', 'it'], { ...options(impl), signal: controller.signal })).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('missing URL or secret: no request is sent', async () => {
    const { impl, calls } = fakeFetch(async () => json({ language: 'en', confidence: 0.9, model: 'fake' }));
    await expect(requestLanguageId(QUERY, ['zh', 'en'], { timeoutMs: 30, url: '', secret: SECRET, fetch: impl })).resolves.toBeNull();
    await expect(requestLanguageId(QUERY, ['zh', 'en'], { timeoutMs: 30, url: URL_, secret: ' ', fetch: impl })).resolves.toBeNull();
    expect(calls).toHaveLength(0);
    expect(langidConfigured({ url: URL_, secret: SECRET })).toBe(true);
    expect(langidConfigured({ url: '', secret: SECRET })).toBe(false);
  });

  it('no log line contains the query text', async () => {
    for (const respond of [async () => json({}, 500), async () => json({ bad: true }), delayed(80, {})]) {
      const { impl } = fakeFetch(respond);
      await requestLanguageId(QUERY, ['zh', 'en', 'it'], options(impl));
    }
    expect(loggedText()).not.toContain('zebrafishquartz');
  });
});

describe('chain step 1: the sidecar (D-17)', () => {
  const base = (request: ResolveQueryLanguageInput['sidecar']): ResolveQueryLanguageInput => ({
    text: 'gateway logs',
    enabled: ['zh', 'en', 'it'],
    primary: 'en',
    previousTurnLanguage: 'zh',
    profile: 'chat',
    params: PARAMS,
    sidecar: request,
  });

  it('a sidecar answer wins over the previous turn for a low-confidence query', async () => {
    const request = vi.fn(async () => ({ language: 'it', confidence: 0.8 }));
    expect(await resolveQueryLanguage(base({ enabled: true, request }))).toEqual({ language: 'it', confidence: 0.8, source: 'sidecar' });
    expect(request).toHaveBeenCalledWith('gateway logs', ['zh', 'en', 'it'], expect.objectContaining({ timeoutMs: 30 }));
  });

  it('no sidecar answer falls through to the previous turn', async () => {
    const request = vi.fn(async () => null);
    expect(await resolveQueryLanguage(base({ enabled: true, request }))).toMatchObject({ language: 'zh', source: 'previous_turn' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('a sidecar language outside the enabled list falls through', async () => {
    const request = vi.fn(async () => ({ language: 'fr', confidence: 0.9 }));
    expect(await resolveQueryLanguage(base({ enabled: true, request }))).toMatchObject({ source: 'previous_turn' });
  });

  it('switch off, the voice profile or a confident detection: the sidecar is not called', async () => {
    const request = vi.fn(async () => ({ language: 'it', confidence: 0.8 }));
    await resolveQueryLanguage(base({ enabled: false, request }));
    await resolveQueryLanguage({ ...base({ enabled: true, request }), profile: 'voice' });
    await resolveQueryLanguage({ ...base({ enabled: true, request }), text: 'how do I reset the sample gateway to its defaults' });
    expect(request).not.toHaveBeenCalled();
  });

  it('embed and eval may call the sidecar', async () => {
    const request = vi.fn(async () => ({ language: 'it', confidence: 0.8 }));
    for (const profile of ['embed', 'eval'] as const) {
      expect((await resolveQueryLanguage({ ...base({ enabled: true, request }), profile })).source).toBe('sidecar');
    }
  });
});
