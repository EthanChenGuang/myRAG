import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import { createVoyageProvider } from '@/lib/rag/embeddings/voyage';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';
import { startFakeEmbeddingEndpoints } from '../../helpers/fake-embedding-endpoints';
import type { FakeEmbeddingEndpoints } from '../../helpers/fake-embedding-endpoints';

const VOYAGE_KEY = 'test-voyage-key-placeholder-0123456789';

let fake: FakeEmbeddingEndpoints;

beforeAll(async () => {
  fake = await startFakeEmbeddingEndpoints();
});

afterAll(async () => {
  await fake.stop();
});

afterEach(() => {
  fake.calls.length = 0;
  fake.setDelay('voyage', 0);
  fake.setVoyageReturnDims(null);
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
