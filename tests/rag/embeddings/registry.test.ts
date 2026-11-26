import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { resetActiveProfileForTests, verifyActiveEmbeddingProfileAtStartup } from '@/lib/rag/embeddings/active-profile';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { EmbeddingProfileMismatch, truncateAndNormalize } from '@/lib/rag/embeddings/mrl';
import { createOpenAiProvider } from '@/lib/rag/embeddings/openai-provider';
import type { OpenAiEmbeddingsClient } from '@/lib/rag/embeddings/openai-provider';
import { estimateCostUsd, priceFor } from '@/lib/rag/embeddings/prices';
import {
  canonicalModelId,
  getEmbeddingProvider,
  getEmbeddingProviderFor,
  maxInputTokensFor,
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

  it('uses the catalog dims of the named model (voyage-law-2 is 1024 only)', () => {
    const law = validateProfileShape({ provider: 'voyage', dims: 2048, storage: 'halfvec', model: 'voyage-law-2' });
    expect(law.ok === false && law.reason).toBe('dims_unsupported');
    expect(validateProfileShape({ provider: 'voyage', dims: 1024, storage: 'halfvec', model: 'voyage-law-2' })).toEqual({ ok: true });
    expect(validateProfileShape({ provider: 'voyage', dims: 2048, storage: 'halfvec', model: 'voyage-4-large' })).toEqual({ ok: true });
  });

  it('rejects a model the provider does not serve', () => {
    const unknown = validateProfileShape({ provider: 'voyage', dims: 1024, storage: 'halfvec', model: 'voyage-9' });
    expect(unknown.ok === false && unknown.reason).toBe('model_unknown');
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

  it('prices per model from the catalog', () => {
    expect(estimateCostUsd('voyage', 'voyage-law-2', 1_000_000)).toEqual({ usd: 0.12, estimated: true });
    expect(estimateCostUsd('voyage', 'voyage-finance-2', 1_000_000)).toEqual({ usd: 0.12, estimated: true });
    expect(estimateCostUsd('openai', 'text-embedding-3-small', 1_000_000)).toEqual({ usd: 0.02, estimated: false });
    expect(priceFor('voyage', 'voyage-law-2')).toMatchObject({ provider: 'voyage', model: 'voyage-law-2', usdPerMillionTokens: 0.12, tokensAreEstimates: true });
    expect(priceFor('voyage').model).toBe('voyage-4-large');
  });

  it('throws for a model with no catalog price', () => {
    expect(() => estimateCostUsd('voyage', 'voyage-9', 1_000)).toThrow('[Embedding Profile] unknown embedding model');
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

describe('maxInputTokensFor', () => {
  it.each([
    ['openai', 8191],
    ['voyage', 32000],
    ['qwen3', 32768],
  ])('returns the documented input limit of %s', (id, limit) => {
    expect(maxInputTokensFor(id)).toBe(limit);
  });

  it('agrees with the maxInputTokens each registered provider declares', () => {
    for (const id of ['openai', 'voyage', 'qwen3']) {
      expect(maxInputTokensFor(id)).toBe(getEmbeddingProvider(id).maxInputTokens);
    }
  });

  it('throws for an unknown provider id and for ids that only exist on Object.prototype', () => {
    expect(() => maxInputTokensFor('cohere')).toThrow('[Embedding Profile] unknown provider cohere');
    expect(() => maxInputTokensFor('constructor')).toThrow('[Embedding Profile] unknown provider constructor');
  });

  it('follows a provider swapped in for tests', () => {
    const fake: EmbeddingProvider = {
      id: 'openai',
      model: 'fake-model',
      maxInputTokens: 1234,
      supportedDims: [1536],
      normalize: true,
      embedDocuments: async () => ({ vectors: [], model: 'fake-model', host: 'fake', usage: { tokens: 0 } }),
      embedQuery: async () => ({ vectors: [], model: 'fake-model', host: 'fake', usage: { tokens: 0 } }),
    };
    setEmbeddingProvidersForTests({ openai: fake });
    expect(maxInputTokensFor('openai')).toBe(1234);
  });
});

describe('getEmbeddingProviderFor (D-02)', () => {
  function fakeProvider(id: 'openai' | 'voyage' | 'qwen3', model: string): EmbeddingProvider {
    return {
      id,
      model,
      maxInputTokens: 1000,
      supportedDims: [1024],
      normalize: true,
      embedDocuments: async () => ({ vectors: [], model, host: 'fake', usage: { tokens: 0 } }),
      embedQuery: async () => ({ vectors: [], model, host: 'fake', usage: { tokens: 0 } }),
    };
  }

  it('resolves a Voyage domain model and keeps the provider default unchanged', () => {
    const law = getEmbeddingProviderFor('voyage', 'voyage-law-2');
    expect(law.id).toBe('voyage');
    expect(law.model).toBe('voyage-law-2');
    expect(law.supportedDims).toEqual([1024]);
    expect(law.maxInputTokens).toBe(16000);
    expect(getEmbeddingProviderFor('voyage', 'voyage-finance-2').model).toBe('voyage-finance-2');
    expect(getEmbeddingProvider('voyage').model).toBe('voyage-4-large');
    expect(getEmbeddingProviderFor('voyage', 'voyage-4-large')).toBe(getEmbeddingProvider('voyage'));
  });

  it('returns the same instance for repeated lookups of one model', () => {
    expect(getEmbeddingProviderFor('voyage', 'voyage-law-2')).toBe(getEmbeddingProviderFor('voyage', 'mongodb/voyage-law-2'));
  });

  it('throws for a pair that is not in the catalog', () => {
    expect(() => getEmbeddingProviderFor('voyage', 'voyage-9')).toThrow('[Embedding Profile] unknown embedding model');
    expect(() => getEmbeddingProviderFor('openai', 'voyage-law-2')).toThrow('[Embedding Profile] unknown embedding model');
    expect(() => getEmbeddingProviderFor('cohere', 'embed-v4.0')).toThrow('[Embedding Profile] unknown embedding model');
  });

  it('keeps a provider-keyed test override working for its own model only', () => {
    const fake = fakeProvider('voyage', 'voyage-4-large');
    setEmbeddingProvidersForTests({ voyage: fake });
    expect(getEmbeddingProviderFor('voyage', 'voyage-4-large')).toBe(fake);
    expect(getEmbeddingProviderFor('voyage', 'voyage-law-2')).not.toBe(fake);
    expect(getEmbeddingProviderFor('voyage', 'voyage-law-2').model).toBe('voyage-law-2');
  });

  it('lets a provider:model override replace only that model', () => {
    const fake = fakeProvider('voyage', 'voyage-law-2');
    setEmbeddingProvidersForTests({ 'voyage:voyage-law-2': fake });
    expect(getEmbeddingProviderFor('voyage', 'voyage-law-2')).toBe(fake);
    expect(getEmbeddingProviderFor('voyage', 'voyage-finance-2')).not.toBe(fake);
    expect(getEmbeddingProvider('voyage').model).toBe('voyage-4-large');
  });

  it('resolves a provider-keyed override for a model outside the catalog (Phase 3 fakes)', () => {
    const fake = fakeProvider('openai', 'fake-openai-model');
    setEmbeddingProvidersForTests({ openai: fake });
    expect(getEmbeddingProviderFor('openai', 'fake-openai-model')).toBe(fake);
  });
});

describe('fine-tune slot providers (06.1 D-02, D-22)', () => {
  const slotEnv = env as unknown as Record<string, unknown>;
  const SLOT_NAMES = ['RAG_FINETUNE', 'RAG_FT_SLOT_A_BASE_URL', 'RAG_FT_SLOT_A_MODEL', 'RAG_FT_SLOT_B_BASE_URL', 'RAG_FT_SLOT_B_MODEL'];
  const saved = Object.fromEntries(SLOT_NAMES.map((name) => [name, slotEnv[name]]));

  function slotRow(id: string, provider: string, model: string): Record<string, unknown> {
    return {
      id,
      provider,
      model,
      dims: 1024,
      storage: 'halfvec',
      status: 'active',
      query_instruction: null,
      score_calibration: {},
      activated_at: null,
      activated_by: null,
      previous_active_id: null,
      has_evidence: true,
      created_at: '2026-01-01T00:00:00Z',
    };
  }

  function installRegistry(rows: Record<string, unknown>[]): void {
    const respond = (fn: string): RpcResponse => ({ data: fn === 'rag_list_embedding_profiles' ? rows : [], error: null });
    const client: RpcClient = {
      rpc: (fn) => {
        const pending: RpcRequest = {
          abortSignal: () => pending,
          then: (onFulfilled, onRejected) => Promise.resolve(respond(fn)).then(onFulfilled, onRejected),
        };
        return pending;
      },
    };
    setRagDepsForTests({ adminClient: () => client as never, now: () => 1_000_000 });
    setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'on' }) });
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const name of SLOT_NAMES) slotEnv[name] = saved[name];
    resetRagDepsForTests();
    resetIngestDepsForTests();
    resetActiveProfileForTests();
    vi.restoreAllMocks();
  });

  it('accepts the ft-a-1024 and ft-b-1024 shapes and rejects other dims and the legacy column', () => {
    for (const provider of ['ft_slot_a', 'ft_slot_b']) {
      expect(validateProfileShape({ provider, dims: 1024, storage: 'halfvec' })).toEqual({ ok: true });
      expect(validateProfileShape({ provider, dims: 1024, storage: 'halfvec', model: 'unbound' })).toEqual({ ok: true });
      expect(validateProfileShape({ provider, dims: 1024, storage: 'halfvec', model: 'ft-neutral-v1' })).toEqual({ ok: true });
      for (const dims of [768, 512, 2048]) {
        const result = validateProfileShape({ provider, dims, storage: 'halfvec' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('dims_unsupported');
      }
      expect(validateProfileShape({ provider, dims: 1024, storage: 'legacy_column' }).ok).toBe(false);
    }
  });

  it('keeps the slot providers out of the registry while RAG_FINETUNE is off', () => {
    slotEnv.RAG_FINETUNE = 'off';
    slotEnv.RAG_FT_SLOT_A_BASE_URL = 'http://127.0.0.1:9/v1';
    slotEnv.RAG_FT_SLOT_A_MODEL = 'ft-neutral-v1';
    expect(() => getEmbeddingProvider('ft_slot_a')).toThrow(/unknown embedding provider/);
    expect(() => getEmbeddingProvider('ft_slot_b')).toThrow(/unknown embedding provider/);
    expect(() => getEmbeddingProviderFor('ft_slot_a', 'ft-neutral-v1')).toThrow(/unknown embedding model/);
  });

  it('registers both slots while RAG_FINETUNE is on, with the env model as the provider model', () => {
    slotEnv.RAG_FINETUNE = 'on';
    slotEnv.RAG_FT_SLOT_A_BASE_URL = 'http://127.0.0.1:9/v1';
    slotEnv.RAG_FT_SLOT_A_MODEL = 'ft-neutral-v1';
    slotEnv.RAG_FT_SLOT_B_MODEL = 'ft-neutral-v2';
    const a = getEmbeddingProvider('ft_slot_a');
    expect(a.id).toBe('ft_slot_a');
    expect(a.model).toBe('ft-neutral-v1');
    expect([...a.supportedDims]).toEqual([1024]);
    expect(getEmbeddingProvider('ft_slot_b').model).toBe('ft-neutral-v2');
    expect(getEmbeddingProviderFor('ft_slot_a', 'ft-neutral-v1')).toBe(a);
    expect(getEmbeddingProviderFor('ft_slot_a', 'ft-other-v9').model).toBe('ft-neutral-v1');
  });

  it('prices a slot at zero (no list price) for any bound version', () => {
    expect(priceFor('ft_slot_a', 'ft-neutral-v1').usdPerMillionTokens).toBe(0);
    expect(estimateCostUsd('ft_slot_b', 1_000_000).usd).toBe(0);
  });

  it('startup check: a slot profile with RAG_FINETUNE off is provider_unconfigured', async () => {
    slotEnv.RAG_FINETUNE = 'off';
    slotEnv.RAG_FT_SLOT_A_BASE_URL = 'http://127.0.0.1:9/v1';
    slotEnv.RAG_FT_SLOT_A_MODEL = 'ft-neutral-v1';
    installRegistry([slotRow('ft-a-1024', 'ft_slot_a', 'ft-neutral-v1')]);
    const verdict = await verifyActiveEmbeddingProfileAtStartup();
    expect(verdict).toMatchObject({ status: 'mismatch', reason: 'provider_unconfigured', profile: 'ft-a-1024' });
  });

  it('startup check: RAG_FINETUNE on with an empty slot base URL is provider_unconfigured', async () => {
    slotEnv.RAG_FINETUNE = 'on';
    slotEnv.RAG_FT_SLOT_A_BASE_URL = '';
    slotEnv.RAG_FT_SLOT_A_MODEL = 'ft-neutral-v1';
    installRegistry([slotRow('ft-a-1024', 'ft_slot_a', 'ft-neutral-v1')]);
    const verdict = await verifyActiveEmbeddingProfileAtStartup();
    expect(verdict).toMatchObject({ status: 'mismatch', reason: 'provider_unconfigured', profile: 'ft-a-1024' });
  });

  it('startup check: an env model that differs from the bound profile model is model_mismatch', async () => {
    slotEnv.RAG_FINETUNE = 'on';
    slotEnv.RAG_FT_SLOT_A_BASE_URL = 'http://127.0.0.1:9/v1';
    slotEnv.RAG_FT_SLOT_A_MODEL = 'ft-neutral-v2';
    installRegistry([slotRow('ft-a-1024', 'ft_slot_a', 'ft-neutral-v1')]);
    const verdict = await verifyActiveEmbeddingProfileAtStartup();
    expect(verdict).toMatchObject({ status: 'mismatch', reason: 'model_mismatch', profile: 'ft-a-1024' });
  });

  it('startup check: a configured slot whose env model equals the bound model is ok', async () => {
    slotEnv.RAG_FINETUNE = 'on';
    slotEnv.RAG_FT_SLOT_B_BASE_URL = 'http://127.0.0.1:9/v1';
    slotEnv.RAG_FT_SLOT_B_MODEL = 'ft-neutral-v1';
    installRegistry([slotRow('ft-b-1024', 'ft_slot_b', 'ft-neutral-v1')]);
    const verdict = await verifyActiveEmbeddingProfileAtStartup();
    expect(verdict).toMatchObject({ status: 'ok', profile: 'ft-b-1024', dims: 1024 });
  });
});
