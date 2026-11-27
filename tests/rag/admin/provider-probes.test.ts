import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  PROVIDER_IDS,
  PROVIDER_PROBE_CODES,
  PROVIDER_PROBE_MESSAGES,
  PROVIDER_PROBE_TIMEOUT_MS,
  runProviderProbe,
  type ProbeEnv,
  type ProviderId,
  type ProviderProbeDeps,
  type ProviderProbeResult,
} from '@/lib/rag/admin/provider-probes';
import type { QdrantApi } from '@/lib/rag/backend/qdrant/client';
import type { WeaviateClientLike } from '@/lib/rag/backend/weaviate/types';

/**
 * D-15 (ADM-01): Test-connection probes over fetch fakes and fake backend clients; no live call. Keys, hosts and ports are
 * synthetic placeholders.
 */

const PROFILE_ID = 'profile-probe-1024';
const KEYS: Record<string, string> = {
  OPENAI_API_KEY: 'K7QW2ZX9VB41',
  OPENROUTER_API_KEY: 'K8RT3YU6NM52',
  VOYAGE_API_KEY: 'K2PL9OK8IJ63',
  DEEPINFRA_API_KEY: 'K3HG7FD5SA74',
  COHERE_API_KEY: 'K4ZX1CV3BN85',
  WEAVIATE_READ_API_KEY: 'K5QA2WS3ED96',
  WEAVIATE_API_KEY: 'K6RF4TG5YH07',
  QDRANT_READ_API_KEY: 'K7UJ6IK7OL18',
  QDRANT_API_KEY: 'K8PM9NB8VC29',
  RAG_SIDECAR_SECRET: 'K9XZ0LK9JH30',
  LANGFUSE_PUBLIC_KEY: 'K1GF2DS1AQ41',
  LANGFUSE_SECRET_KEY: 'K2WE3RT2YU52',
  LAKERA_GUARD_API_KEY: 'K3IO4PL3KJ63',
  LLAMA_CLOUD_API_KEY: 'K4HG5FD4SA74',
  ANTHROPIC_API_KEY: 'K5ZX6CV5BN85',
  EXA_API_KEY: 'K6QW7ER6TY96',
};

function placeholderUrl(id: string, path = ''): string {
  return `https://probe-host-${id}.example.com:7443${path}`;
}

/** Every provider configured, each URL a distinctive placeholder host and port. */
function configuredEnv(): ProbeEnv {
  return {
    ...KEYS,
    VOYAGE_BASE_URL: placeholderUrl('voyage', '/v1'),
    DEEPINFRA_BASE_URL: placeholderUrl('deepinfra', '/v1/openai'),
    COHERE_BASE_URL: placeholderUrl('cohere'),
    WEAVIATE_URL: placeholderUrl('weaviate'),
    QDRANT_URL: placeholderUrl('qdrant'),
    RAG_SIDECAR_URL: placeholderUrl('sidecar'),
    LANGFUSE_BASE_URL: placeholderUrl('langfuse'),
    LAKERA_GUARD_BASE_URL: placeholderUrl('lakera'),
    ANTHROPIC_BASE_URL: placeholderUrl('anthropic', '/v1'),
    RAG_PARSER_ALLOW_CLOUD: 'true',
  };
}

type Scenario = 'ok' | 'unauthorized' | 'hang' | 'refused' | 'malformed';

const state = {
  scenario: 'ok' as Scenario,
  calls: [] as string[],
  collectionExists: true,
  vectaraCode: 'ok',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function vector(dims: number): number[] {
  return Array.from({ length: dims }, () => 0.1);
}

function successBody(url: URL, init: RequestInit | undefined): Response {
  const path = url.pathname;
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  if (path.endsWith('/embeddings')) {
    const model = String(body.model ?? '');
    const dims = model === 'BAAI/bge-m3' || model.startsWith('voyage') ? 1024 : 1536;
    const embedding = body.encoding_format === 'base64' ? Buffer.from(new Float32Array(vector(dims)).buffer).toString('base64') : vector(dims);
    return json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding }], model, usage: { prompt_tokens: 1, total_tokens: 1 } });
  }
  if (path.endsWith('/v2/rerank')) return json({ results: [{ index: 0, relevance_score: 0.6 }, { index: 1, relevance_score: 0.4 }] });
  if (path.endsWith('/rerank')) return json({ data: [{ index: 0, relevance_score: 0.6 }, { index: 1, relevance_score: 0.4 }] });
  if (path.endsWith('/v1/providers/test')) {
    const ok = state.vectaraCode === 'ok';
    return json({ provider: 'vectara', ok, latencyMs: 3, code: state.vectaraCode, message: 'fixed' });
  }
  if (path.endsWith('/v2/guard')) return json({ breakdown: [{ detector_type: 'prompt_attack', detected: false }] });
  return json({ ok: true });
}

function leakText(url: string): string {
  const parsed = new URL(url);
  return `connect ECONNREFUSED ${parsed.hostname}:${parsed.port || 443} while calling ${url} with ${Object.values(KEYS).join(',')}`;
}

function hangUntilAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(Object.assign(new Error(`aborted ${state.calls.at(-1) ?? ''}`), { name: 'AbortError' }));
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  state.calls.push(url);
  switch (state.scenario) {
    case 'ok':
      return successBody(new URL(url), init);
    case 'unauthorized':
      return json({ error: `invalid api key ${Object.values(KEYS).join(' ')} for ${url}` }, 401);
    case 'hang':
      return hangUntilAbort(init?.signal);
    case 'refused':
      throw Object.assign(new TypeError(`fetch failed: ${leakText(url)}`), { cause: { code: 'ECONNREFUSED', address: new URL(url).hostname } });
    case 'malformed':
      return new Response(`<html>${leakText(url)}</html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  }
});

function vendorError(url: string, status: number | null): Error {
  return Object.assign(new Error(status === null ? `fetch failed: ${leakText(url)}` : `Unexpected Response: ${status} ${leakText(url)}`), status === null ? {} : { status });
}

const qdrantFactory = vi.fn((source: ProbeEnv): QdrantApi => {
  const url = source.QDRANT_URL ?? '';
  state.calls.push(url);
  const call = async <T>(ok: () => T): Promise<T> => {
    switch (state.scenario) {
      case 'ok':
        return ok();
      case 'unauthorized':
        throw vendorError(url, 401);
      case 'hang':
        return new Promise<T>(() => undefined);
      case 'refused':
        throw vendorError(url, null);
      case 'malformed':
        return { unexpected: leakText(url) } as T;
    }
  };
  return {
    versionInfo: () => call(() => ({ title: 'qdrant', version: '1.0.0' })),
    getCollection: () =>
      state.collectionExists
        ? call(() => ({ config: { params: { vectors: { dense: { size: 1024 } } }, metadata: { dims: 1024 } } }))
        : Promise.reject(vendorError(url, 404)),
  } as unknown as QdrantApi;
});

const weaviateFactory = vi.fn(async (): Promise<WeaviateClientLike> => {
  const url = placeholderUrl('weaviate');
  state.calls.push(url);
  const call = async <T>(ok: () => T): Promise<T> => {
    switch (state.scenario) {
      case 'ok':
        return ok();
      case 'unauthorized':
        throw new Error(`401 Unauthorized ${leakText(url)}`);
      case 'hang':
        return new Promise<T>(() => undefined);
      case 'refused':
        throw new Error(`fetch failed ${leakText(url)}`);
      case 'malformed':
        return { unexpected: leakText(url) } as T;
    }
  };
  return {
    isReady: () => call(() => true),
    collections: {
      exists: () => call(() => state.collectionExists),
      export: () => call(() => ({ description: JSON.stringify({ dims: 1024 }) })),
    },
  } as unknown as WeaviateClientLike;
});

function deps(env: ProbeEnv): Partial<ProviderProbeDeps> {
  return {
    env,
    fetch: fakeFetch as unknown as typeof fetch,
    activeProfileId: async () => PROFILE_ID,
    qdrantReadClient: qdrantFactory,
    weaviateReadClient: weaviateFactory,
  };
}

async function probe(provider: ProviderId, env: ProbeEnv = configuredEnv(), abortAfterMs?: number): Promise<ProviderProbeResult> {
  const controller = new AbortController();
  const timer = abortAfterMs === undefined ? undefined : setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), abortAfterMs);
  try {
    return await runProviderProbe(provider, { signal: controller.signal, deps: deps(env) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hostsOf(urls: string[]): string[] {
  const out = new Set<string>();
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      out.add(url.origin);
      out.add(url.hostname);
      out.add(`${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`);
      out.add(url.host);
    } catch {
      // not a URL
    }
  }
  return [...out];
}

function assertNoLeak(result: ProviderProbeResult, provider: ProviderId, env: ProbeEnv): void {
  const serialised = JSON.stringify(result);
  const urls = [...state.calls, ...Object.values(env).filter((v): v is string => typeof v === 'string' && /^https?:\/\//.test(v))];
  for (const needle of [...urls, ...hostsOf(urls)]) expect(serialised).not.toContain(needle);
  for (const key of Object.values(KEYS)) {
    for (let i = 0; i + 4 <= key.length; i += 1) expect(serialised).not.toContain(key.slice(i, i + 4));
  }
  expect(Object.keys(result).sort()).toEqual(['code', 'latencyMs', 'message', 'ok', 'provider']);
  expect(result.provider).toBe(provider);
  expect(PROVIDER_PROBE_CODES).toContain(result.code);
  expect(result.message).toBe(PROVIDER_PROBE_MESSAGES[result.code]);
  expect(typeof result.ok).toBe('boolean');
  expect(typeof result.latencyMs).toBe('number');
}

beforeEach(() => {
  state.scenario = 'ok';
  state.calls = [];
  state.collectionExists = true;
  state.vectaraCode = 'ok';
  fakeFetch.mockClear();
  qdrantFactory.mockClear();
  weaviateFactory.mockClear();
  vi.stubGlobal('fetch', fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider probe registry', () => {
  test('stable contract: provider ids in order and the five UI failure codes', () => {
    expect([...PROVIDER_IDS]).toEqual([
      'embedding:openai',
      'embedding:voyage',
      'embedding:deepinfra',
      'rerank:cohere',
      'rerank:voyage',
      'backend:weaviate',
      'backend:qdrant',
      'sidecar',
      'langfuse',
      'vectara',
      'lakera',
      'llamacloud',
      'anthropic',
      'exa',
    ]);
    for (const code of ['not_configured', 'unauthorized', 'timeout', 'unreachable', 'collection_missing']) {
      expect(PROVIDER_PROBE_CODES).toContain(code);
    }
    for (const code of PROVIDER_PROBE_CODES) expect(typeof PROVIDER_PROBE_MESSAGES[code]).toBe('string');
    expect(Object.keys(PROVIDER_PROBE_MESSAGES).sort()).toEqual([...PROVIDER_PROBE_CODES].sort());
    expect(PROVIDER_PROBE_TIMEOUT_MS).toBe(10_000);
  });

  test('stable contract: every code a probe returns is in PROVIDER_PROBE_CODES', async () => {
    for (const scenario of ['ok', 'unauthorized', 'hang', 'refused', 'malformed'] as Scenario[]) {
      state.scenario = scenario;
      for (const provider of PROVIDER_IDS) {
        const result = await probe(provider, configuredEnv(), scenario === 'hang' ? 30 : undefined);
        expect(PROVIDER_PROBE_CODES).toContain(result.code);
      }
    }
  });

  test('an unknown provider id is refused before any call', async () => {
    await expect(runProviderProbe('backend:other' as ProviderId, { signal: new AbortController().signal, deps: deps(configuredEnv()) })).rejects.toThrow(
      TypeError,
    );
    expect(state.calls).toEqual([]);
  });

  test.each(PROVIDER_IDS)('%s: an unset key or URL gives not_configured without a network call', async (provider) => {
    const result = await probe(provider, {});
    expect(result).toEqual({ provider, ok: false, latencyMs: 0, code: 'not_configured', message: PROVIDER_PROBE_MESSAGES.not_configured });
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(qdrantFactory).not.toHaveBeenCalled();
    expect(weaviateFactory).not.toHaveBeenCalled();
  });

  test.each(PROVIDER_IDS)('%s: a 200 gives ok with a latency', async (provider) => {
    const result = await probe(provider);
    expect(result).toMatchObject({ provider, ok: true, code: 'ok', message: PROVIDER_PROBE_MESSAGES.ok });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(state.calls.length).toBeGreaterThan(0);
  });

  test.each(PROVIDER_IDS)('%s: a 401 gives unauthorized', async (provider) => {
    state.scenario = 'unauthorized';
    expect((await probe(provider)).code).toBe('unauthorized');
  });

  test.each(PROVIDER_IDS)('%s: no answer before the signal fires gives timeout', async (provider) => {
    state.scenario = 'hang';
    const result = await probe(provider, configuredEnv(), 30);
    expect(result).toMatchObject({ ok: false, code: 'timeout', message: PROVIDER_PROBE_MESSAGES.timeout });
  });

  test.each(PROVIDER_IDS)('%s: a network error gives unreachable', async (provider) => {
    state.scenario = 'refused';
    expect((await probe(provider)).code).toBe('unreachable');
  });

  test('backend:qdrant is ok only with health and the active profile collection; a missing collection is collection_missing', async () => {
    state.collectionExists = false;
    expect((await probe('backend:qdrant')).code).toBe('collection_missing');
    state.collectionExists = true;
    expect((await probe('backend:qdrant')).code).toBe('ok');
  });

  test('backend:weaviate reports collection_missing for the active profile', async () => {
    state.collectionExists = false;
    expect((await probe('backend:weaviate')).code).toBe('collection_missing');
  });

  test('backend probes use the read key', async () => {
    await probe('backend:qdrant');
    expect(qdrantFactory.mock.calls[0]?.[0]).toMatchObject({ QDRANT_READ_API_KEY: KEYS.QDRANT_READ_API_KEY });
  });

  test('vectara relays the sidecar code and refuses an unknown one', async () => {
    state.vectaraCode = 'not_configured';
    expect((await probe('vectara')).code).toBe('not_configured');
    state.vectaraCode = 'unauthorized';
    expect((await probe('vectara')).code).toBe('unauthorized');
    state.vectaraCode = 'free text from a vendor';
    expect((await probe('vectara')).code).toBe('bad_response');
  });

  test('llamacloud sends nothing while cloud parsing is off', async () => {
    const result = await probe('llamacloud', { ...configuredEnv(), RAG_PARSER_ALLOW_CLOUD: 'false' });
    expect(result.code).toBe('disabled');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test('never leaks: no key, Authorization header or response body reaches the result', async () => {
    for (const scenario of ['unauthorized', 'malformed'] as Scenario[]) {
      state.scenario = scenario;
      for (const provider of PROVIDER_IDS) {
        const result = await probe(provider);
        const serialised = JSON.stringify(result);
        expect(serialised).not.toMatch(/invalid api key|<html>|Bearer|Basic |x-api-key/i);
        for (const key of Object.values(KEYS)) expect(serialised).not.toContain(key);
      }
    }
  });

  test.each(PROVIDER_IDS)('never leaks endpoint: %s on every path', async (provider) => {
    for (const scenario of ['ok', 'unauthorized', 'hang', 'refused', 'malformed'] as Scenario[]) {
      state.scenario = scenario;
      state.calls = [];
      const env = configuredEnv();
      assertNoLeak(await probe(provider, env, scenario === 'hang' ? 30 : undefined), provider, env);
    }
    state.calls = [];
    assertNoLeak(await probe(provider, {}), provider, configuredEnv());
  });
});
