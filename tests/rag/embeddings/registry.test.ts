import { afterEach, describe, expect, it } from 'vitest';
import { EmbeddingProfileMismatch, truncateAndNormalize } from '@/lib/rag/embeddings/mrl';
import { createOpenAiProvider } from '@/lib/rag/embeddings/openai-provider';
import type { OpenAiEmbeddingsClient } from '@/lib/rag/embeddings/openai-provider';
import { estimateCostUsd, priceFor } from '@/lib/rag/embeddings/prices';
import {
  canonicalModelId,
  getEmbeddingProvider,
  resetEmbeddingProvidersForTests,
  setEmbeddingProvidersForTests,
  validateProfileShape,
} from '@/lib/rag/embeddings/registry';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';

afterEach(() => {
  resetEmbeddingProvidersForTests();
});

describe('truncateAndNormalize (MRL)', () => {
  it('keeps the head and rescales it to unit length', () => {
    const out = truncateAndNormalize([3, 4, 0, 0], 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0.6, 10);
    expect(out[1]).toBeCloseTo(0.8, 10);
  });

  it('throws a dims mismatch when the vector is shorter than the requested dims', () => {
    let caught: unknown;
    try {
      truncateAndNormalize([1, 2, 3], 4);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EmbeddingProfileMismatch);
    expect((caught as EmbeddingProfileMismatch).kind).toBe('dims');
    expect((caught as EmbeddingProfileMismatch).actual).toBe(3);
    expect((caught as EmbeddingProfileMismatch).expected).toBe(4);
  });

  it('throws zero_norm when the truncated head is all zeros', () => {
    let caught: unknown;
    try {
      truncateAndNormalize([0, 0, 5, 5], 2);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EmbeddingProfileMismatch);
    expect((caught as EmbeddingProfileMismatch).kind).toBe('zero_norm');
  });

  it('does not mutate its input', () => {
    const input = [3, 4, 12];
    truncateAndNormalize(input, 2);
    expect(input).toEqual([3, 4, 12]);
  });
});

describe('validateProfileShape (EMB-03 registry rules)', () => {
  it('accepts voyage 2048 halfvec', () => {
    expect(validateProfileShape({ provider: 'voyage', dims: 2048, storage: 'halfvec' })).toEqual({ ok: true });
  });

  it('rejects voyage dims the provider does not support', () => {
    const result = validateProfileShape({ provider: 'voyage', dims: 3000, storage: 'halfvec' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('dims_unsupported');
  });

  it('rejects qwen3 4096 halfvec because halfvec HNSW stops at 4000', () => {
    const result = validateProfileShape({ provider: 'qwen3', dims: 4096, storage: 'halfvec' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('dims_above_limit');
  });

  it('accepts openai 1536 in the legacy column', () => {
    expect(validateProfileShape({ provider: 'openai', dims: 1536, storage: 'legacy_column' })).toEqual({ ok: true });
  });

  it.each(['openai', 'voyage', 'qwen3'])('rejects %s with legacy_column above 2000 dims', (provider) => {
    const result = validateProfileShape({ provider, dims: 2048, storage: 'legacy_column' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('legacy_column_dims');
  });

  it('rejects an unknown provider, an unknown storage and non-integer dims', () => {
    const provider = validateProfileShape({ provider: 'cohere', dims: 1024, storage: 'halfvec' });
    expect(provider.ok === false && provider.reason).toBe('provider_unknown');
    const storage = validateProfileShape({ provider: 'voyage', dims: 1024, storage: 'vector' });
    expect(storage.ok === false && storage.reason).toBe('storage_unknown');
    const dims = validateProfileShape({ provider: 'voyage', dims: 1024.5, storage: 'halfvec' });
    expect(dims.ok === false && dims.reason).toBe('dims_invalid');
  });
});

describe('canonicalModelId', () => {
  it('maps the DeepInfra and OpenRouter spellings of the Qwen model to one id', () => {
    expect(canonicalModelId('Qwen/Qwen3-Embedding-8B')).toBe(canonicalModelId('qwen/qwen3-embedding-8b'));
  });

  it('leaves OpenAI ids unchanged', () => {
    expect(canonicalModelId('text-embedding-3-small')).toBe('text-embedding-3-small');
    expect(canonicalModelId('text-embedding-ada-002')).toBe('text-embedding-ada-002');
  });

  it('keeps different Qwen-sized models apart', () => {
    expect(canonicalModelId('Qwen/Qwen3-Embedding-4B')).not.toBe(canonicalModelId('Qwen/Qwen3-Embedding-8B'));
  });
});

interface RecordedCreate {
  body: { model: string; input: string | string[] };
  signal: AbortSignal;
}

function fakeOpenAiClient(model = 'text-embedding-3-small', dims = 1536) {
  const calls: RecordedCreate[] = [];
  const client: OpenAiEmbeddingsClient = {
    embeddings: {
      async create(body, opts) {
        calls.push({ body, signal: opts.signal });
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return {
          data: inputs.map((_, index) => ({ embedding: new Array<number>(dims).fill(index + 1) })),
          model,
          usage: { total_tokens: inputs.length * 7 },
        };
      },
    },
  };
  return { client, calls };
}

describe('OpenAI provider', () => {
  it('returns the response model, summed total_tokens and the host', async () => {
    const { client } = fakeOpenAiClient();
    const provider = createOpenAiProvider({ client: () => client });
    const out = await provider.embedDocuments(['a', 'b', 'c'], { dims: 1536, signal: new AbortController().signal });
    expect(out.vectors).toHaveLength(3);
    expect(out.model).toBe('text-embedding-3-small');
    expect(out.host).toBe('openai');
    expect(out.usage.tokens).toBe(21);
  });

  it('batches 100 inputs per request and passes the signal on every request', async () => {
    const { client, calls } = fakeOpenAiClient();
    const provider = createOpenAiProvider({ client: () => client });
    const controller = new AbortController();
    const texts = Array.from({ length: 250 }, (_, index) => `text ${index}`);
    const out = await provider.embedDocuments(texts, { dims: 1536, signal: controller.signal });
    expect(calls.map((call) => (call.body.input as string[]).length)).toEqual([100, 100, 50]);
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
    expect(out.vectors).toHaveLength(250);
    expect(out.usage.tokens).toBe(250 * 7);
  });

  it('embeds a query as a single input with no instruction prefix', async () => {
    const { client, calls } = fakeOpenAiClient();
    const provider = createOpenAiProvider({ client: () => client });
    const out = await provider.embedQuery('what is the notice period', { dims: 1536, signal: new AbortController().signal });
    expect(out.vectors).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.input).toEqual(['what is the notice period']);
  });

  it('asserts dims equals 1536 before any request', async () => {
    const { client, calls } = fakeOpenAiClient();
    const provider = createOpenAiProvider({ client: () => client });
    await expect(provider.embedDocuments(['a'], { dims: 1024, signal: new AbortController().signal })).rejects.toMatchObject({
      name: 'EmbeddingProfileMismatch',
      kind: 'dims',
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects a response whose vectors are not 1536 long (a same-model-name swap to another size)', async () => {
    const { client } = fakeOpenAiClient('text-embedding-3-large', 3072);
    const provider = createOpenAiProvider({ client: () => client });
    await expect(provider.embedQuery('q', { dims: 1536, signal: new AbortController().signal })).rejects.toMatchObject({
      kind: 'dims',
      actual: 3072,
      expected: 1536,
    });
  });
});

describe('prices', () => {
  it('lists USD per million tokens for the three providers', () => {
    expect(priceFor('openai').usdPerMillionTokens).toBe(0.02);
    expect(priceFor('voyage').usdPerMillionTokens).toBe(0.12);
    expect(priceFor('qwen3').usdPerMillionTokens).toBe(0.01);
  });

  it('labels non-OpenAI token counts as estimates', () => {
    expect(priceFor('openai').tokensAreEstimates).toBe(false);
    expect(priceFor('voyage').tokensAreEstimates).toBe(true);
    expect(priceFor('qwen3').tokensAreEstimates).toBe(true);
  });

  it('turns tokens into a dollar figure and carries the estimate label', () => {
    expect(estimateCostUsd('voyage', 1_000_000)).toEqual({ usd: 0.12, estimated: true });
    expect(estimateCostUsd('openai', 500_000)).toEqual({ usd: 0.01, estimated: false });
  });
});

describe('registry', () => {
  it('returns the openai provider by id', () => {
    const provider = getEmbeddingProvider('openai');
    expect(provider.id).toBe('openai');
    expect(provider.supportedDims).toEqual([1536]);
    expect(provider.maxInputTokens).toBeGreaterThan(0);
  });

  it('registers the voyage and qwen3 providers with their supported dims', () => {
    const voyage = getEmbeddingProvider('voyage');
    expect(voyage.id).toBe('voyage');
    expect(voyage.model).toBe('voyage-4-large');
    expect(voyage.supportedDims).toEqual([256, 512, 1024, 2048]);
    const qwen = getEmbeddingProvider('qwen3');
    expect(qwen.id).toBe('qwen3');
    expect(qwen.model).toBe('Qwen/Qwen3-Embedding-8B');
    expect(qwen.supportedDims).toContain(2048);
    expect(canonicalModelId(qwen.model)).toBe(qwen.model);
  });

  it('throws on an unknown provider id without echoing secrets', () => {
    expect(() => getEmbeddingProvider('cohere')).toThrow(/\[Embedding Profile\] unknown embedding provider/);
  });

  it('lets tests swap a provider and restore the defaults', async () => {
    const fake: EmbeddingProvider = {
      id: 'openai',
      model: 'fake-model',
      maxInputTokens: 1,
      supportedDims: [1536],
      normalize: true,
      embedDocuments: async () => ({ vectors: [], model: 'fake-model', host: 'fake', usage: { tokens: 0 } }),
      embedQuery: async () => ({ vectors: [], model: 'fake-model', host: 'fake', usage: { tokens: 0 } }),
    };
    setEmbeddingProvidersForTests({ openai: fake });
    expect(getEmbeddingProvider('openai')).toBe(fake);
    resetEmbeddingProvidersForTests();
    expect(getEmbeddingProvider('openai')).not.toBe(fake);
  });
});
