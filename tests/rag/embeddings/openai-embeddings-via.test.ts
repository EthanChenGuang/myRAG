import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const mockEnv: Record<string, string | undefined> = {};
  const constructed: Record<string, unknown>[] = [];
  const createCalls: { model: string; input: unknown }[] = [];
  const state = { responseModel: 'text-embedding-3-small' };
  return { mockEnv, constructed, createCalls, state };
});

vi.mock('@/lib/env', () => ({ env: hoisted.mockEnv }));

vi.mock('openai', () => {
  class FakeOpenAI {
    embeddings = {
      create: async (body: { model: string; input: string | string[] }) => {
        hoisted.createCalls.push(body);
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return {
          data: inputs.map(() => ({ embedding: new Array(1536).fill(0.01) })),
          model: hoisted.state.responseModel,
          usage: { total_tokens: inputs.length },
        };
      },
    };
    files = { create: async () => ({ id: 'file-x' }) };
    batches = { create: async () => ({ id: 'batch-x', status: 'validating' }) };
    constructor(options: Record<string, unknown>) {
      hoisted.constructed.push(options);
    }
  }
  return { default: FakeOpenAI, OpenAI: FakeOpenAI, toFile: async () => ({}) };
});

const OPENAI_KEY = 'sk-test-openai-placeholder';
const OPENROUTER_KEY = 'sk-or-test-placeholder';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of Object.keys(hoisted.mockEnv)) delete hoisted.mockEnv[key];
  Object.assign(hoisted.mockEnv, { OPENAI_API_KEY: OPENAI_KEY, OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small' }, values);
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.resetModules();
  hoisted.constructed.length = 0;
  hoisted.createCalls.length = 0;
  hoisted.state.responseModel = 'text-embedding-3-small';
  setEnv({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openAiEmbeddingsClientOptions', () => {
  it('default openai: exactly { apiKey } and no baseURL', async () => {
    const { openAiEmbeddingsClientOptions } = await import('@/lib/rag/embeddings/openai-client');
    const options = openAiEmbeddingsClientOptions({ OPENAI_API_KEY: OPENAI_KEY, OPENROUTER_API_KEY: OPENROUTER_KEY });
    expect(options).toEqual({ apiKey: OPENAI_KEY });
    expect(Object.keys(options)).toEqual(['apiKey']);
  });

  it('explicit openai matches the default', async () => {
    const { openAiEmbeddingsClientOptions } = await import('@/lib/rag/embeddings/openai-client');
    expect(openAiEmbeddingsClientOptions({ OPENAI_API_KEY: OPENAI_KEY, RAG_OPENAI_EMBEDDINGS_VIA: 'openai' })).toEqual({ apiKey: OPENAI_KEY });
  });

  it('openrouter: OpenRouter base URL and key', async () => {
    const { openAiEmbeddingsClientOptions } = await import('@/lib/rag/embeddings/openai-client');
    expect(
      openAiEmbeddingsClientOptions({ OPENAI_API_KEY: OPENAI_KEY, OPENROUTER_API_KEY: OPENROUTER_KEY, RAG_OPENAI_EMBEDDINGS_VIA: 'openrouter' }),
    ).toEqual({ apiKey: OPENROUTER_KEY, baseURL: OPENROUTER_BASE });
  });

  it('openrouter without OPENROUTER_API_KEY fails clearly', async () => {
    const { openAiEmbeddingsClientOptions } = await import('@/lib/rag/embeddings/openai-client');
    expect(() => openAiEmbeddingsClientOptions({ OPENAI_API_KEY: OPENAI_KEY, RAG_OPENAI_EMBEDDINGS_VIA: 'openrouter' })).toThrow(
      /RAG_OPENAI_EMBEDDINGS_VIA=openrouter needs OPENROUTER_API_KEY/,
    );
    expect(() =>
      openAiEmbeddingsClientOptions({ OPENAI_API_KEY: OPENAI_KEY, OPENROUTER_API_KEY: '  ', RAG_OPENAI_EMBEDDINGS_VIA: 'openrouter' }),
    ).toThrow(/OPENROUTER_API_KEY/);
  });

  it('an unknown value warns and keeps openai', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { openAiEmbeddingsVia } = await import('@/lib/rag/embeddings/openai-client');
    expect(openAiEmbeddingsVia({ RAG_OPENAI_EMBEDDINGS_VIA: 'azure' })).toBe('openai');
    expect(openAiEmbeddingsVia({ RAG_OPENAI_EMBEDDINGS_VIA: ' OpenRouter ' })).toBe('openrouter');
    expect(openAiEmbeddingsVia({})).toBe('openai');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('createOpenAiProvider', () => {
  it('default: constructs the client exactly as before', async () => {
    const { createOpenAiProvider } = await import('@/lib/rag/embeddings/openai-provider');
    const out = await createOpenAiProvider().embedQuery('hello', { dims: 1536, signal: signal() } as never);
    expect(hoisted.constructed).toEqual([{ apiKey: OPENAI_KEY }]);
    expect(hoisted.createCalls[0].model).toBe('text-embedding-3-small');
    expect(out.model).toBe('text-embedding-3-small');
  });

  it('openrouter: OpenRouter base URL, key and the same model', async () => {
    setEnv({ RAG_OPENAI_EMBEDDINGS_VIA: 'openrouter', OPENROUTER_API_KEY: OPENROUTER_KEY });
    hoisted.state.responseModel = 'openai/text-embedding-3-small';
    const { createOpenAiProvider } = await import('@/lib/rag/embeddings/openai-provider');
    const out = await createOpenAiProvider().embedQuery('hello', { dims: 1536, signal: signal() } as never);
    expect(hoisted.constructed).toEqual([{ apiKey: OPENROUTER_KEY, baseURL: OPENROUTER_BASE }]);
    expect(hoisted.createCalls[0].model).toBe('text-embedding-3-small');
    expect(out.model).toBe('text-embedding-3-small');
    expect(out.vectors[0]).toHaveLength(1536);
  });

  it('openrouter without a key rejects before any request', async () => {
    setEnv({ RAG_OPENAI_EMBEDDINGS_VIA: 'openrouter' });
    const { createOpenAiProvider } = await import('@/lib/rag/embeddings/openai-provider');
    await expect(createOpenAiProvider().embedQuery('hello', { dims: 1536, signal: signal() } as never)).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(hoisted.createCalls).toHaveLength(0);
  });
});

describe('legacy embedText / embedBatch (openai.ts)', () => {
  it('default: constructs the client exactly as before', async () => {
    const { embedText } = await import('@/lib/rag/embeddings/openai');
    await embedText('hello', { signal: signal() });
    expect(hoisted.constructed).toEqual([{ apiKey: OPENAI_KEY }]);
    expect(hoisted.createCalls[0].model).toBe('text-embedding-3-small');
  });

  it('openrouter: OpenRouter base URL, key and the same model', async () => {
    setEnv({ RAG_OPENAI_EMBEDDINGS_VIA: 'openrouter', OPENROUTER_API_KEY: OPENROUTER_KEY });
    const { embedBatch } = await import('@/lib/rag/embeddings/openai');
    const vectors = await embedBatch(['a', 'b'], { signal: signal() });
    expect(vectors).toHaveLength(2);
    expect(hoisted.constructed).toEqual([{ apiKey: OPENROUTER_KEY, baseURL: OPENROUTER_BASE }]);
    expect(hoisted.createCalls[0].model).toBe('text-embedding-3-small');
  });

  it('openrouter without a key fails clearly', async () => {
    setEnv({ RAG_OPENAI_EMBEDDINGS_VIA: 'openrouter' });
    const { embedText } = await import('@/lib/rag/embeddings/openai');
    await expect(embedText('hello', { signal: signal() })).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

describe('Batch API under openrouter', () => {
  it('default: the Batch API client is built exactly as before', async () => {
    const { createBatchApiClient } = await import('@/lib/rag/ingest/backfill/batch-api');
    createBatchApiClient();
    expect(hoisted.constructed).toEqual([{ apiKey: OPENAI_KEY }]);
  });

  it('openrouter: createBatchApiClient refuses and never builds an api.openai.com client', async () => {
    setEnv({ RAG_OPENAI_EMBEDDINGS_VIA: 'openrouter', OPENROUTER_API_KEY: OPENROUTER_KEY });
    const { createBatchApiClient, EmbedBatchError } = await import('@/lib/rag/ingest/backfill/batch-api');
    expect(() => createBatchApiClient()).toThrow(EmbedBatchError);
    expect(() => createBatchApiClient()).toThrow(/batch_api_unavailable_via_openrouter/);
    expect(hoisted.constructed).toHaveLength(0);
  });

  it('deferred OpenAI profiles embed synchronously under openrouter', async () => {
    const { deferredEmbedMode } = await import('@/lib/rag/ingest/backfill/orchestrate');
    expect(deferredEmbedMode('openai')).toBe('batch_api');
    expect(deferredEmbedMode('voyage')).toBe('sync');
    setEnv({ RAG_OPENAI_EMBEDDINGS_VIA: 'openrouter', OPENROUTER_API_KEY: OPENROUTER_KEY });
    expect(deferredEmbedMode('openai')).toBe('sync');
  });

  it('new backfill jobs are snapshotted as sync under openrouter even with RAG_EMBED_BATCH_MODE=batch_api', async () => {
    const { batchApiAllowed } = await import('@/lib/rag/embeddings/openai-client');
    expect(batchApiAllowed({})).toBe(true);
    expect(batchApiAllowed({ RAG_OPENAI_EMBEDDINGS_VIA: 'openrouter' })).toBe(false);
  });
});

describe('non-embedding OpenAI clients are untouched', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const files = [
    'src/app/api/audio/route.ts',
    'src/app/api/generate-image/route.ts',
    'src/app/api/generate-video/route.ts',
    'src/app/api/ai-to-rag/route.ts',
    'src/lib/rag/ingest/captioner.ts',
  ];
  it.each(files)('%s does not use the embeddings host switch', (rel) => {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    expect(source).not.toMatch(/RAG_OPENAI_EMBEDDINGS_VIA|openAiEmbeddingsClientOptions|openai-client/);
  });
});
