import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import {
  FINETUNE_PROBE_MIN_COSINE,
  FINETUNE_PROBE_ROLES,
  checkFinetuneProbe,
  createFinetuneSlotProvider,
  resetFinetuneProbeCacheForTests,
  type FinetuneSlotConfig,
} from '@/lib/rag/embeddings/finetune-slot';
import { EmbeddingProfileMismatch } from '@/lib/rag/embeddings/mrl';
import { EmbeddingProviderError } from '@/lib/rag/embeddings/types';
import { fakeSlotVector, startFakeEmbeddingEndpoints, type FakeEmbeddingEndpoints } from '../../helpers/fake-embedding-endpoints';

const VERSION = 'ft-neutral-v1';
const QUERY_PROMPT = 'query: ';
const DOCUMENT_PROMPT = 'passage: ';
const PROBE_TEXTS = [
  'Probe line one is a neutral sentence for the endpoint check.',
  'Probe line two is another neutral sentence for the endpoint check.',
  'Probe line three closes the neutral endpoint check.',
];
const KEY = 'test-ft-key-placeholder-0123456789';
const SIGNAL = new AbortController().signal;
const OPTS = { dims: 1024, signal: SIGNAL };

let fake: FakeEmbeddingEndpoints;
let listCalls: Record<string, unknown>[];
let registryRows: Record<string, unknown>[];

function unit(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  return vector.map((x) => x / norm);
}

function norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
}

/** Reference vectors as training computes them: each probe text with the prompt its role names. */
function referenceVectors(queryPrompt = QUERY_PROMPT, documentPrompt = DOCUMENT_PROMPT, salt = ''): number[][] {
  return PROBE_TEXTS.map((text, index) =>
    unit(fakeSlotVector(`${FINETUNE_PROBE_ROLES[index] === 'query' ? queryPrompt : documentPrompt}${text}`, salt)),
  );
}

function versionRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VERSION,
    status: 'bound',
    bound_slot: 'ft-a-1024',
    dims: 1024,
    query_prompt: QUERY_PROMPT,
    document_prompt: DOCUMENT_PROMPT,
    probe: { texts: PROBE_TEXTS, vectors: referenceVectors(), query_prompt: QUERY_PROMPT, document_prompt: DOCUMENT_PROMPT },
    ...over,
  };
}

function installRegistry(): void {
  const client: RpcClient = {
    rpc: (fn, args) => {
      if (fn === 'rag_finetune_list_models') listCalls.push(args ?? {});
      const response: RpcResponse = { data: fn === 'rag_finetune_list_models' ? registryRows : [], error: null };
      const pending: RpcRequest = {
        abortSignal: () => pending,
        then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return pending;
    },
  };
  setRagDepsForTests({ adminClient: () => client as never, now: () => 1_000_000 });
}

function config(over: Partial<FinetuneSlotConfig> = {}): () => FinetuneSlotConfig {
  return () => ({
    baseUrl: fake.urls.ft,
    model: VERSION,
    queryPrompt: QUERY_PROMPT,
    documentPrompt: DOCUMENT_PROMPT,
    apiKey: '',
    retries: 2,
    backoffMs: 0,
    ...over,
  });
}

/** Requests that are not the three-text probe call. */
function workCalls() {
  return fake.callsFor('ft').filter((call) => {
    const input = call.body.input as string[];
    return !(input.length === 3 && input[0].endsWith(PROBE_TEXTS[0]));
  });
}

beforeAll(async () => {
  fake = await startFakeEmbeddingEndpoints();
});

afterAll(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.clearFailures();
  fake.setFtDims(1024);
  fake.setFtSalt('');
  listCalls = [];
  registryRows = [versionRow()];
  installRegistry();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetRagDepsForTests();
  resetFinetuneProbeCacheForTests();
  vi.restoreAllMocks();
});

describe('fine-tune slot provider requests (06.1 D-23)', () => {
  it('posts to {base}/embeddings with the env model, float encoding and the query or document prompt', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config() });
    expect(provider.id).toBe('ft_slot_a');
    expect(provider.model).toBe(VERSION);
    const query = await provider.embedQuery('a neutral question', OPTS);
    const docs = await provider.embedDocuments(['first neutral passage', 'second neutral passage'], OPTS);
    const calls = workCalls();
    expect(calls.map((call) => call.path)).toEqual(['/ft/v1/embeddings', '/ft/v1/embeddings']);
    expect(calls[0].body).toMatchObject({ model: VERSION, encoding_format: 'float', input: ['query: a neutral question'] });
    expect(calls[1].body).toMatchObject({ model: VERSION, input: ['passage: first neutral passage', 'passage: second neutral passage'] });
    expect(query.model).toBe(VERSION);
    expect(query.host).toBe('ft_slot_a');
    expect(docs.vectors).toHaveLength(2);
  });

  it('embedQueries prefixes every text with the query prompt in one request', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config() });
    const out = await provider.embedQueries!(['q one', 'q two'], OPTS);
    expect(out.vectors).toHaveLength(2);
    expect(workCalls()[0].body.input).toEqual(['query: q one', 'query: q two']);
  });

  it('sends no Authorization header when the key is empty and a bearer key when it is set', async () => {
    await createFinetuneSlotProvider('a', { config: config() }).embedQuery('neutral', OPTS);
    for (const call of fake.callsFor('ft')) {
      expect(call.headers.authorization).toBeUndefined();
      expect(call.headers['openai-organization']).toBeUndefined();
      expect(call.headers['openai-project']).toBeUndefined();
    }
    fake.calls.length = 0;
    resetFinetuneProbeCacheForTests();
    await createFinetuneSlotProvider('a', { config: config({ apiKey: KEY }) }).embedQuery('neutral', OPTS);
    for (const call of fake.callsFor('ft')) expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('splits 300 texts into requests of at most 128 and keeps the order', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config() });
    const texts = Array.from({ length: 300 }, (_, index) => `neutral passage number ${index}`);
    const out = await provider.embedDocuments(texts, OPTS);
    expect(workCalls().map((call) => (call.body.input as string[]).length)).toEqual([128, 128, 44]);
    expect(out.vectors).toHaveLength(300);
    expect(out.vectors[0]).toEqual(unit(fakeSlotVector(`passage: ${texts[0]}`)));
    expect(out.vectors[299]).toEqual(unit(fakeSlotVector(`passage: ${texts[299]}`)));
  });

  it('returns unit-length vectors', async () => {
    registryRows = [versionRow({ bound_slot: 'ft-b-1024' })];
    const out = await createFinetuneSlotProvider('b', { config: config() }).embedDocuments(['one', 'two', 'three'], OPTS);
    for (const vector of out.vectors) expect(norm(vector)).toBeCloseTo(1, 10);
  });

  it('refuses a vector that is not exactly 1024 long', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config() });
    await provider.embedQuery('warm up', OPTS);
    fake.setFtDims(1023);
    const error = await provider.embedQuery('neutral', OPTS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingProfileMismatch);
    expect(error).toMatchObject({ kind: 'dims', actual: 1023, expected: 1024 });
    fake.setFtDims(2048);
    await expect(provider.embedQuery('neutral', OPTS)).rejects.toMatchObject({ kind: 'dims', actual: 2048 });
  });

  it('refuses a request for other than 1024 dims before any call', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config() });
    await expect(provider.embedQuery('neutral', { dims: 512, signal: SIGNAL })).rejects.toMatchObject({ kind: 'dims', actual: 512 });
    expect(fake.callsFor('ft')).toHaveLength(0);
  });

  it('retries a 503 twice and then succeeds', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config() });
    await provider.embedQuery('warm up', OPTS);
    fake.calls.length = 0;
    fake.failNext('ft', 503, 503);
    const out = await provider.embedQuery('neutral', OPTS);
    expect(out.vectors).toHaveLength(1);
    expect(fake.callsFor('ft')).toHaveLength(3);
  });

  it('retries 429 and gives up after two retries', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config() });
    await provider.embedQuery('warm up', OPTS);
    fake.calls.length = 0;
    fake.failNext('ft', 429, 429, 429);
    const error = await provider.embedQuery('neutral', OPTS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingProviderError);
    expect((error as EmbeddingProviderError).status).toBe(429);
    expect(fake.callsFor('ft')).toHaveLength(3);
  });

  it('does not retry a 400 and never puts the response body or the key into the error', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config({ apiKey: KEY }) });
    await provider.embedQuery('warm up', OPTS);
    fake.calls.length = 0;
    fake.failNext('ft', 400);
    const error = await provider.embedQuery('neutral', OPTS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingProviderError);
    expect((error as Error).message).toContain('status 400');
    expect((error as Error).message).not.toContain('upstream failure');
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).message).not.toContain('127.0.0.1');
    expect(fake.callsFor('ft')).toHaveLength(1);
  });

  it('throws a configuration error naming the variable when the base URL or model is empty', async () => {
    await expect(createFinetuneSlotProvider('b', { config: config({ baseUrl: '' }) }).embedQuery('x', OPTS)).rejects.toThrow(
      /RAG_FT_SLOT_B_BASE_URL not configured/,
    );
    await expect(createFinetuneSlotProvider('a', { config: config({ model: '' }) }).embedQuery('x', OPTS)).rejects.toThrow(
      /RAG_FT_SLOT_A_MODEL not configured/,
    );
    expect(fake.callsFor('ft')).toHaveLength(0);
  });
});

describe('fine-tune slot probe check (06.1 D-24)', () => {
  it('embeds the probe once per process before the first call and then serves', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config() });
    await provider.embedQuery('neutral one', OPTS);
    await provider.embedQuery('neutral two', OPTS);
    await createFinetuneSlotProvider('a', { config: config() }).embedDocuments(['neutral three'], OPTS);
    const calls = fake.callsFor('ft');
    expect(calls[0].body.input).toEqual(
      PROBE_TEXTS.map((text, index) => `${FINETUNE_PROBE_ROLES[index] === 'query' ? QUERY_PROMPT : DOCUMENT_PROMPT}${text}`),
    );
    expect(calls).toHaveLength(4);
    expect(listCalls).toEqual([{ p_include_probe: true }]);
  });

  it('shares one probe between concurrent first calls', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config() });
    await Promise.all([provider.embedQuery('one', OPTS), provider.embedQuery('two', OPTS), provider.embedDocuments(['three'], OPTS)]);
    expect(fake.callsFor('ft')).toHaveLength(4);
    expect(listCalls).toHaveLength(1);
  });

  it('refuses other weights behind the same URL and model name and returns no vector', async () => {
    fake.setFtSalt('other weights ');
    const provider = createFinetuneSlotProvider('a', { config: config() });
    const error = await provider.embedQuery('neutral', OPTS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbeddingProfileMismatch);
    expect((error as EmbeddingProfileMismatch).kind).toBe('probe');
    expect(Number((error as EmbeddingProfileMismatch).actual)).toBeLessThan(FINETUNE_PROBE_MIN_COSINE);
    expect(fake.callsFor('ft')).toHaveLength(1);
    await expect(provider.embedDocuments(['neutral'], OPTS)).rejects.toMatchObject({ kind: 'probe' });
    await expect(provider.embedQueries!(['a', 'b'], OPTS)).rejects.toMatchObject({ kind: 'probe' });
    expect(fake.callsFor('ft')).toHaveLength(1);
  });

  it('fails when the serving query prompt differs from the trained one, though the weights match', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config({ queryPrompt: 'search: ' }) });
    await expect(provider.embedQuery('neutral', OPTS)).rejects.toMatchObject({ kind: 'probe' });
  });

  it('fails when the serving document prompt differs from the trained one', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config({ documentPrompt: '' }) });
    await expect(provider.embedDocuments(['neutral'], OPTS)).rejects.toMatchObject({ kind: 'probe' });
  });

  it('fails when the env model names no registered version or a version bound to the other slot', async () => {
    registryRows = [versionRow({ id: 'ft-neutral-v9' })];
    await expect(createFinetuneSlotProvider('a', { config: config() }).embedQuery('neutral', OPTS)).rejects.toMatchObject({
      kind: 'probe',
      actual: 'unregistered',
    });
    resetFinetuneProbeCacheForTests();
    registryRows = [versionRow({ bound_slot: 'ft-b-1024' })];
    await expect(createFinetuneSlotProvider('a', { config: config() }).embedQuery('neutral', OPTS)).rejects.toMatchObject({
      kind: 'probe',
      actual: 'ft-b-1024',
      expected: 'ft-a-1024',
    });
    expect(fake.callsFor('ft')).toHaveLength(0);
  });

  it('does not cache a probe that could not run, so the next call probes again', async () => {
    const provider = createFinetuneSlotProvider('a', { config: config({ retries: 0 }) });
    fake.failNext('ft', 503);
    await expect(provider.embedQuery('neutral', OPTS)).rejects.toBeInstanceOf(EmbeddingProviderError);
    const out = await provider.embedQuery('neutral', OPTS);
    expect(out.vectors).toHaveLength(1);
    expect(listCalls).toHaveLength(2);
  });

  it('checkFinetuneProbe reports ok and minCosine without throwing', async () => {
    const good = await checkFinetuneProbe('a', { config: config() });
    expect(good.ok).toBe(true);
    expect(good.minCosine).toBeGreaterThanOrEqual(FINETUNE_PROBE_MIN_COSINE);

    resetFinetuneProbeCacheForTests();
    fake.setFtSalt('other weights ');
    const bad = await checkFinetuneProbe('a', { config: config() });
    expect(bad.ok).toBe(false);
    expect(bad.minCosine).not.toBeNull();
    expect(bad.minCosine as number).toBeLessThan(FINETUNE_PROBE_MIN_COSINE);
  });

  it('checkFinetuneProbe reports an unreachable endpoint and an empty base URL as not ok', async () => {
    fake.failNext('ft', 500, 500, 500);
    await expect(checkFinetuneProbe('a', { config: config() })).resolves.toMatchObject({ ok: false, minCosine: null, reason: 'unavailable' });
    await expect(checkFinetuneProbe('a', { config: config({ baseUrl: '' }) })).resolves.toMatchObject({
      ok: false,
      minCosine: null,
      reason: 'unconfigured',
    });
  });

  it('checkFinetuneProbe shares the cached verdict with the provider', async () => {
    await createFinetuneSlotProvider('a', { config: config() }).embedQuery('neutral', OPTS);
    const before = fake.callsFor('ft').length;
    const result = await checkFinetuneProbe('a', { config: config() });
    expect(result.ok).toBe(true);
    expect(fake.callsFor('ft')).toHaveLength(before);
  });
});
