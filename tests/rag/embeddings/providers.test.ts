import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import { createQwenProvider } from '@/lib/rag/embeddings/qwen';
import type { QwenConfig } from '@/lib/rag/embeddings/qwen';
import { createVoyageProvider } from '@/lib/rag/embeddings/voyage';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';
import { startFakeEmbeddingEndpoints } from '../../helpers/fake-embedding-endpoints';
import type { FakeEmbeddingEndpoints } from '../../helpers/fake-embedding-endpoints';

const VOYAGE_KEY = 'test-voyage-key-placeholder-0123456789';
const DEEPINFRA_KEY = 'test-deepinfra-key-placeholder-0123';
const OPENROUTER_KEY = 'test-openrouter-key-placeholder-0123';

let fake: FakeEmbeddingEndpoints;

beforeAll(async () => {
  fake = await startFakeEmbeddingEndpoints();
});

afterAll(async () => {
  await fake.stop();
});

afterEach(() => {
  fake.calls.length = 0;
  fake.clearFailures();
  fake.setDelay('voyage', 0);
  fake.setDelay('deepinfra', 0);
  fake.setDelay('openrouter', 0);
  fake.setVoyageReturnDims(null);
  fake.setQwenRawDims(4096);
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('Voyage provider', () => {
  function voyage(apiKey = VOYAGE_KEY): EmbeddingProvider {
    return createVoyageProvider({ config: () => ({ apiKey, baseUrl: fake.urls.voyage, timeoutMs: 5000 }) });
  }

  it('sends input_type document, output_dimension, truncation false and the bearer key for documents', async () => {
    const out = await voyage().embedDocuments(['alpha clause', 'beta clause'], { dims: 1024, signal: signal() });
    expect(fake.callsFor('voyage')).toHaveLength(1);
    const call = fake.callsFor('voyage')[0];
    expect(call.headers.authorization).toBe(`Bearer ${VOYAGE_KEY}`);
    expect(call.body).toMatchObject({
      model: 'voyage-4-large',
      input: ['alpha clause', 'beta clause'],
      input_type: 'document',
      output_dimension: 1024,
      truncation: false,
    });
    expect(out.vectors).toHaveLength(2);
    expect(out.vectors[0]).toHaveLength(1024);
    expect(out.model).toBe('voyage-4-large');
    expect(out.host).toBe('voyage');
    expect(out.usage.tokens).toBe(4);
  });

  it('sends input_type query with the same dimension for a query', async () => {
    const out = await voyage().embedQuery('notice period', { dims: 2048, signal: signal() });
    expect(fake.callsFor('voyage')).toHaveLength(1);
    const call = fake.callsFor('voyage')[0];
    expect(call.body).toMatchObject({ input: ['notice period'], input_type: 'query', output_dimension: 2048, truncation: false });
    expect(out.vectors).toHaveLength(1);
    expect(out.vectors[0]).toHaveLength(2048);
  });

  it('splits 300 short texts into three requests of at most 128 and keeps the order', async () => {
    const texts = Array.from({ length: 300 }, (_, index) => `short text number ${index}`);
    const out = await voyage().embedDocuments(texts, { dims: 256, signal: signal() });
    expect(fake.callsFor('voyage').map((call) => (call.body.input as string[]).length)).toEqual([128, 128, 44]);
    expect(out.vectors).toHaveLength(300);
    const single = await voyage().embedDocuments([texts[200]], { dims: 256, signal: signal() });
    expect(out.vectors[200]).toEqual(single.vectors[0]);
  });

  it('splits further when the estimated tokens (cl100k_base count x 1.3) exceed 100K', async () => {
    const heavy = 'alpha '.repeat(8000);
    const texts = Array.from({ length: 12 }, () => heavy);
    await voyage().embedDocuments(texts, { dims: 256, signal: signal() });
    const requests = fake.callsFor('voyage');
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests) {
      const estimated = (request.body.input as string[]).reduce((sum, text) => sum + Math.ceil(countTokens(text) * 1.3), 0);
      expect(estimated).toBeLessThanOrEqual(100_000);
    }
    expect(requests.reduce((sum, request) => sum + (request.body.input as string[]).length, 0)).toBe(12);
  });

  it('throws an error with the status but not the key on a 400', async () => {
    fake.failNext('voyage', 400);
    let caught: unknown;
    try {
      await voyage().embedQuery('q', { dims: 1024, signal: signal() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('400');
    expect(message).not.toContain(VOYAGE_KEY);
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain(VOYAGE_KEY);
  });

  it('throws a configuration error before any request when the key is missing', async () => {
    await expect(voyage('').embedDocuments(['a'], { dims: 1024, signal: signal() })).rejects.toThrow(
      '[Embedding Profile] VOYAGE_API_KEY not configured',
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('cancels the request when the signal aborts', async () => {
    fake.setDelay('voyage', 3000);
    const controller = new AbortController();
    const started = Date.now();
    const pending = voyage().embedQuery('q', { dims: 1024, signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('rejects a response whose vectors do not have the requested dimension', async () => {
    fake.setVoyageReturnDims(512);
    await expect(voyage().embedQuery('q', { dims: 1024, signal: signal() })).rejects.toMatchObject({
      name: 'EmbeddingProfileMismatch',
      kind: 'dims',
      actual: 512,
      expected: 1024,
    });
  });
});

describe('Voyage provider with a fixed-dimension catalog model (D-02)', () => {
  interface Recorded {
    url: string;
    body: Record<string, unknown>;
    authorization: string | null;
  }

  function stubFetch(options: { status?: number; dims?: number; echoModel?: string; errorText?: string } = {}): Recorded[] {
    const recorded: Recorded[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      recorded.push({ url, body, authorization: new Headers(init.headers).get('authorization') });
      if (options.status && options.status >= 400) {
        return new Response(options.errorText ?? 'error', { status: options.status });
      }
      const inputs = body.input as string[];
      const size = options.dims ?? 1024;
      return new Response(
        JSON.stringify({
          data: inputs.map((_, index) => ({ embedding: new Array<number>(size).fill(0.01), index })),
          model: options.echoModel ?? body.model,
          usage: { total_tokens: inputs.length * 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    return recorded;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function domainVoyage(model: string, apiKey = VOYAGE_KEY): EmbeddingProvider {
    return createVoyageProvider({ model, config: () => ({ apiKey, baseUrl: 'https://voyage.invalid/v1', timeoutMs: 5000 }) });
  }

  it('reports the catalog model, dims and input limit', () => {
    const provider = domainVoyage('voyage-law-2');
    expect(provider.model).toBe('voyage-law-2');
    expect(provider.supportedDims).toEqual([1024]);
    expect(provider.maxInputTokens).toBe(16000);
    expect(domainVoyage('voyage-finance-2').maxInputTokens).toBe(32000);
  });

  it('sends the model, input_type document, truncation false and no output_dimension for documents', async () => {
    const recorded = stubFetch();
    const out = await domainVoyage('voyage-law-2').embedDocuments(['first neutral sentence', 'second neutral sentence'], {
      dims: 1024,
      signal: signal(),
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].body).toMatchObject({ model: 'voyage-law-2', input_type: 'document', truncation: false });
    expect(Object.prototype.hasOwnProperty.call(recorded[0].body, 'output_dimension')).toBe(false);
    expect(out.model).toBe('voyage-law-2');
    expect(out.vectors[0]).toHaveLength(1024);
  });

  it('sends input_type query and no output_dimension for a query', async () => {
    const recorded = stubFetch();
    await domainVoyage('voyage-finance-2').embedQuery('a neutral question', { dims: 1024, signal: signal() });
    expect(recorded[0].body).toMatchObject({ model: 'voyage-finance-2', input_type: 'query', truncation: false });
    expect(Object.prototype.hasOwnProperty.call(recorded[0].body, 'output_dimension')).toBe(false);
  });

  it('canonicalises a host-prefixed model echo', async () => {
    stubFetch({ echoModel: 'mongodb/voyage-law-2' });
    const out = await domainVoyage('voyage-law-2').embedQuery('q', { dims: 1024, signal: signal() });
    expect(out.model).toBe('voyage-law-2');
  });

  it('rejects a response with 1536-length vectors', async () => {
    stubFetch({ dims: 1536 });
    await expect(domainVoyage('voyage-law-2').embedQuery('q', { dims: 1024, signal: signal() })).rejects.toMatchObject({
      name: 'EmbeddingProfileMismatch',
      kind: 'dims',
      actual: 1536,
      expected: 1024,
    });
  });

  it('refuses dims the fixed model cannot produce before any request', async () => {
    const recorded = stubFetch();
    await expect(domainVoyage('voyage-law-2').embedDocuments(['a'], { dims: 2048, signal: signal() })).rejects.toMatchObject({
      name: 'EmbeddingProfileMismatch',
      kind: 'dims',
      actual: 2048,
      expected: 1024,
    });
    expect(recorded).toHaveLength(0);
  });

  it('keeps output_dimension for voyage-4-large', async () => {
    const recorded = stubFetch({ dims: 512 });
    await domainVoyage('voyage-4-large').embedQuery('q', { dims: 512, signal: signal() });
    expect(recorded[0].body).toMatchObject({ model: 'voyage-4-large', output_dimension: 512 });
  });

  it('keeps the key and the vendor response text out of a 401 error', async () => {
    stubFetch({ status: 401, errorText: `invalid key ${VOYAGE_KEY.slice(0, 12)} vendor-detail-text` });
    let caught: unknown;
    try {
      await domainVoyage('voyage-law-2').embedQuery('q', { dims: 1024, signal: signal() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const serialized = `${(caught as Error).message} ${JSON.stringify(caught, Object.getOwnPropertyNames(caught))}`;
    expect((caught as Error).message).toContain('401');
    expect(serialized).not.toContain(VOYAGE_KEY);
    expect(serialized).not.toContain(VOYAGE_KEY.slice(0, 12));
    expect(serialized).not.toContain('vendor-detail-text');
  });

  it('throws for a model that is not a Voyage catalog model', () => {
    expect(() => domainVoyage('voyage-9')).toThrow('[Embedding Profile] unknown embedding model');
  });
});

describe('Qwen3 provider', () => {
  const QWEN_QUERY = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:';

  function qwen(overrides: Partial<QwenConfig> = {}, keys: { deepinfra?: string; openrouter?: string } = {}): EmbeddingProvider {
    return createQwenProvider({
      config: () => ({
        deepinfra: { apiKey: keys.deepinfra ?? DEEPINFRA_KEY, baseUrl: fake.urls.deepinfra },
        openrouter: { apiKey: keys.openrouter ?? OPENROUTER_KEY, baseUrl: fake.urls.openrouter },
        fallback: 'openrouter',
        retries: 2,
        backoffMs: 0,
        timeoutMs: 5000,
        ...overrides,
      }),
    });
  }

  it('prefixes a query with the instruction exactly and sends documents raw', async () => {
    await qwen().embedQuery('notice period', { dims: 2048, signal: signal() });
    await qwen().embedDocuments(['first clause', 'second clause'], { dims: 2048, signal: signal() });
    expect(fake.callsFor('deepinfra')).toHaveLength(2);
    const [query, documents] = fake.callsFor('deepinfra');
    expect(query.body.input).toEqual([`${QWEN_QUERY}notice period`]);
    expect(query.body.model).toBe('Qwen/Qwen3-Embedding-8B');
    expect(query.headers.authorization).toBe(`Bearer ${DEEPINFRA_KEY}`);
    expect(documents.body.input).toEqual(['first clause', 'second clause']);
  });

  it('never sends dimensions, input_type or custom_instruction to either host', async () => {
    await qwen().embedQuery('q', { dims: 1024, signal: signal() });
    await qwen().embedDocuments(['d'], { dims: 1024, signal: signal() });
    fake.failNext('deepinfra', 503, 503, 503);
    await qwen().embedQuery('q', { dims: 1024, signal: signal() });
    expect(fake.callsFor('openrouter')).toHaveLength(1);
    for (const call of fake.calls) {
      expect(Object.keys(call.body)).not.toContain('dimensions');
      expect(Object.keys(call.body)).not.toContain('input_type');
      expect(Object.keys(call.body)).not.toContain('custom_instruction');
      expect(call.body.encoding_format).toBe('float');
    }
  });

  it('truncates the 4096-dim response to the profile dims and returns unit vectors', async () => {
    const out = await qwen().embedDocuments(['alpha', 'beta'], { dims: 2048, signal: signal() });
    expect(out.vectors).toHaveLength(2);
    for (const vector of out.vectors) {
      expect(vector).toHaveLength(2048);
      expect(Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0))).toBeCloseTo(1, 6);
    }
    expect(out.model).toBe('Qwen/Qwen3-Embedding-8B');
    expect(out.host).toBe('deepinfra');
    expect(out.usage.tokens).toBe(2);
  });

  it('rejects a raw response that is not 4096 long (zero-padded or wrong size)', async () => {
    fake.setQwenRawDims(2048);
    await expect(qwen().embedQuery('q', { dims: 1024, signal: signal() })).rejects.toMatchObject({
      name: 'EmbeddingProfileMismatch',
      kind: 'dims',
      actual: 2048,
      expected: 4096,
    });
  });

  it('retries DeepInfra after two 500s and stays on DeepInfra', async () => {
    fake.failNext('deepinfra', 500, 500);
    const out = await qwen().embedQuery('q', { dims: 1024, signal: signal() });
    expect(fake.callsFor('deepinfra')).toHaveLength(3);
    expect(fake.callsFor('openrouter')).toHaveLength(0);
    expect(out.host).toBe('deepinfra');
  });

  it('falls back to OpenRouter after DeepInfra keeps returning 503 and records the host', async () => {
    fake.failNext('deepinfra', 503, 503, 503);
    const out = await qwen().embedQuery('notice period', { dims: 1024, signal: signal() });
    expect(fake.callsFor('deepinfra')).toHaveLength(3);
    expect(fake.callsFor('openrouter')).toHaveLength(1);
    const [fallback] = fake.callsFor('openrouter');
    expect(fallback.body.model).toBe('qwen/qwen3-embedding-8b');
    expect(fallback.body.input).toEqual([`${QWEN_QUERY}notice period`]);
    expect(fallback.headers.authorization).toBe(`Bearer ${OPENROUTER_KEY}`);
    expect(out.host).toBe('openrouter');
    expect(out.model).toBe('Qwen/Qwen3-Embedding-8B');
    expect(out.vectors[0]).toHaveLength(1024);
  });

  it('falls back after 429 responses that outlast the retries', async () => {
    fake.failNext('deepinfra', 429, 429, 429);
    const out = await qwen().embedDocuments(['d'], { dims: 1024, signal: signal() });
    expect(out.host).toBe('openrouter');
  });

  it('falls back when DeepInfra times out', async () => {
    fake.setDelay('deepinfra', 600);
    const out = await qwen({ timeoutMs: 50 }).embedQuery('q', { dims: 1024, signal: signal() });
    expect(fake.callsFor('deepinfra')).toHaveLength(3);
    expect(out.host).toBe('openrouter');
  });

  it('propagates the error when the fallback switch is none', async () => {
    fake.failNext('deepinfra', 503, 503, 503);
    await expect(qwen({ fallback: 'none' }).embedQuery('q', { dims: 1024, signal: signal() })).rejects.toMatchObject({
      name: 'EmbeddingProviderError',
      status: 503,
    });
    expect(fake.callsFor('openrouter')).toHaveLength(0);
  });

  it('propagates the DeepInfra error when no OpenRouter key is configured', async () => {
    fake.failNext('deepinfra', 500, 500, 500);
    await expect(qwen({}, { openrouter: '' }).embedQuery('q', { dims: 1024, signal: signal() })).rejects.toMatchObject({
      name: 'EmbeddingProviderError',
      status: 500,
    });
    expect(fake.callsFor('openrouter')).toHaveLength(0);
  });

  it('does not retry or fall back on a client error', async () => {
    fake.failNext('deepinfra', 400);
    await expect(qwen().embedQuery('q', { dims: 1024, signal: signal() })).rejects.toMatchObject({ status: 400 });
    expect(fake.callsFor('deepinfra')).toHaveLength(1);
    expect(fake.callsFor('openrouter')).toHaveLength(0);
  });

  it('throws a configuration error before any request when the DeepInfra key is missing', async () => {
    await expect(qwen({}, { deepinfra: '' }).embedQuery('q', { dims: 1024, signal: signal() })).rejects.toThrow(
      '[Embedding Profile] DEEPINFRA_API_KEY not configured',
    );
    expect(fake.calls).toHaveLength(0);
  });

  it('keeps both keys out of the errors thrown when the hosts fail', async () => {
    fake.failNext('deepinfra', 503, 503, 503);
    fake.failNext('openrouter', 500);
    let bothDown: unknown;
    try {
      await qwen().embedQuery('q', { dims: 1024, signal: signal() });
    } catch (error) {
      bothDown = error;
    }
    fake.failNext('deepinfra', 401);
    let rejected: unknown;
    try {
      await qwen().embedQuery('q', { dims: 1024, signal: signal() });
    } catch (error) {
      rejected = error;
    }
    expect(bothDown).toMatchObject({ name: 'EmbeddingProviderError', host: 'openrouter', status: 500 });
    expect(rejected).toMatchObject({ name: 'EmbeddingProviderError', host: 'deepinfra', status: 401 });
    for (const caught of [bothDown, rejected]) {
      const dump = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
      expect(dump).not.toContain(DEEPINFRA_KEY);
      expect(dump).not.toContain(OPENROUTER_KEY);
    }
  });

  it('stops without retrying when the signal aborts', async () => {
    fake.setDelay('deepinfra', 3000);
    const controller = new AbortController();
    const pending = qwen().embedQuery('q', { dims: 1024, signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    await expect(pending).rejects.toMatchObject({ name: expect.stringMatching(/Abort/) });
    expect(fake.callsFor('deepinfra')).toHaveLength(1);
    expect(fake.callsFor('openrouter')).toHaveLength(0);
  });
});
