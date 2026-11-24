import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import { env } from '@/lib/env';
import { runRetrieval } from '@/lib/rag';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, type RagDeps } from '@/lib/rag/deps';
import {
  getStartupVerdict,
  resetActiveProfileForTests,
  verifyActiveEmbeddingProfileAtStartup,
} from '@/lib/rag/embeddings/active-profile';
import { resetProfileFailureLogForTests } from '@/lib/rag/embeddings/query-embedding';
import { resetEmbeddingProvidersForTests, setEmbeddingProvidersForTests } from '@/lib/rag/embeddings/registry';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Profile } from '@/lib/rag/types';
import { installDeps, rows, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const QUERY = 'tell me about the onboarding process';
const VOYAGE_KEY = 'test-voyage-key-placeholder-0123456789';
const LEGACY_VECTOR_LENGTH = 1536;

const mutableEnv = env as unknown as Record<string, unknown>;
const savedVoyageKey = mutableEnv.VOYAGE_API_KEY;

interface RecordedRpc {
  fn: string;
  args: Record<string, unknown>;
}

type ActiveRow = Record<string, unknown>;

function profileRow(id: string, over: Record<string, unknown> = {}): ActiveRow {
  return {
    id,
    provider: 'voyage',
    model: 'voyage-4-large',
    dims: 2048,
    storage: 'halfvec',
    status: 'active',
    query_instruction: null,
    score_calibration: {},
    activated_at: null,
    activated_by: null,
    previous_active_id: null,
    has_evidence: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const LEGACY_ROW = profileRow('openai-3-small-1536', {
  provider: 'openai',
  model: 'text-embedding-3-small',
  dims: LEGACY_VECTOR_LENGTH,
  storage: 'legacy_column',
  score_calibration: { retrieval_threshold: 0.7, context_threshold: 0.65, fallback_threshold: 0.28, context_image_threshold: 0.25 },
});

function fakeRpc(registry: () => RpcResponse): { client: RpcClient; calls: RecordedRpc[]; searchCalls: () => RecordedRpc[] } {
  const calls: RecordedRpc[] = [];
  const client: RpcClient = {
    rpc(fn, args): RpcRequest {
      calls.push({ fn, args });
      const respond = (): RpcResponse =>
        fn === 'rag_list_embedding_profiles' ? registry() : { data: rows(5), error: null };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(respond()).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { client, calls, searchCalls: () => calls.filter((call) => call.fn !== 'rag_list_embedding_profiles') };
}

interface FakeProvider {
  provider: EmbeddingProvider;
  queryCalls: { text: string; dims: number }[];
  documentCalls: number;
}

function fakeProvider(options: { vectorLength?: number; model?: string; modelId?: string } = {}): FakeProvider {
  const state: FakeProvider = { provider: null as unknown as EmbeddingProvider, queryCalls: [], documentCalls: 0 };
  const modelId = options.modelId ?? 'voyage-4-large';
  state.provider = {
    id: 'voyage',
    model: modelId,
    maxInputTokens: 8000,
    supportedDims: [1024, 2048],
    normalize: true,
    async embedQuery(text, opts) {
      state.queryCalls.push({ text, dims: opts.dims });
      const length = options.vectorLength ?? opts.dims;
      return { vectors: [Array.from({ length }, () => 0.01)], model: options.model ?? modelId, host: 'fake', usage: { tokens: 3 } };
    },
    async embedDocuments() {
      state.documentCalls += 1;
      throw new Error('a query path must never call embedDocuments');
    },
  };
  return state;
}

let mode: string | undefined;
let errorSpy: MockInstance<typeof console.error>;

function mismatchLines(): string[] {
  return errorSpy.mock.calls
    .map((args) => String(args[0]))
    .filter((line) => line.startsWith('[Embedding Profile] MISMATCH'));
}

function setUp(options: { registry?: () => RpcResponse; embedder?: Mock<RagDeps['embedder']> } = {}) {
  const rpc = fakeRpc(options.registry ?? (() => ({ data: [profileRow('voyage-4-large-2048')], error: null })));
  const embedder: Mock<RagDeps['embedder']> = options.embedder ?? vi.fn<RagDeps['embedder']>(async () => Array.from({ length: LEGACY_VECTOR_LENGTH }, () => 0.02));
  installDeps({ embedder, searchRpc: rpc.client });
  return { rpc, embedder };
}

async function retrieve(profile: Profile = 'eval', query = QUERY) {
  return runRetrieval({ scope, query, profile, signal: new AbortController().signal });
}

beforeEach(() => {
  mode = 'on';
  setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: mode }) });
  mutableEnv.VOYAGE_API_KEY = VOYAGE_KEY;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  mutableEnv.VOYAGE_API_KEY = savedVoyageKey;
  uninstallDeps();
  resetRagDepsForTests();
  resetIngestDepsForTests();
  resetActiveProfileForTests();
  resetEmbeddingProvidersForTests();
  resetProfileFailureLogForTests();
});

describe('query embedding with the switch off', () => {
  it('calls the legacy embedder once with the query, never the registry or a provider, and searches the legacy RPC', async () => {
    mode = 'off';
    const voyage = fakeProvider();
    setEmbeddingProvidersForTests({ voyage: voyage.provider });
    const { rpc, embedder } = setUp();

    const result = await retrieve();

    expect(embedder).toHaveBeenCalledTimes(1);
    expect(embedder.mock.calls[0]?.[0]).toBe(QUERY);
    expect(voyage.queryCalls).toHaveLength(0);
    expect(rpc.calls.some((call) => call.fn === 'rag_list_embedding_profiles')).toBe(false);
    const searches = rpc.searchCalls();
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((call) => call.fn === 'match_document_chunks')).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.stages.find((stage) => stage.name === 'embed')?.detail).toBeUndefined();
  });
});

describe('query embedding with a non-legacy active profile', () => {
  it('asks the profile provider for a query embedding at the profile dims and accepts a vector of that length', async () => {
    const voyage = fakeProvider();
    setEmbeddingProvidersForTests({ voyage: voyage.provider });
    const { embedder } = setUp();

    const result = await retrieve();

    expect(voyage.queryCalls).toEqual([{ text: QUERY, dims: 2048 }]);
    expect(voyage.documentCalls).toBe(0);
    expect(embedder).not.toHaveBeenCalled();
    const embed = result.stages.find((stage) => stage.name === 'embed');
    expect(embed?.status).toBe('ok');
    expect(embed?.detail).toBe('voyage-4-large-2048');
    expect(result.status).not.toBe('error');
  });

  it('a provider that returns fewer values than the profile dims gives status error embedding_profile_mismatch and never searches', async () => {
    const voyage = fakeProvider({ vectorLength: 1024 });
    setEmbeddingProvidersForTests({ voyage: voyage.provider });
    const { rpc } = setUp();

    const result = await retrieve();

    expect(result.status).toBe('error');
    expect(result.reason).toBe('embedding_profile_mismatch');
    expect(result.refusalCandidate).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(rpc.searchCalls()).toEqual([]);
  });

  it('a same-dims vector from another model gives the same error and never searches', async () => {
    const voyage = fakeProvider({ model: 'other-model' });
    setEmbeddingProvidersForTests({ voyage: voyage.provider });
    const { rpc } = setUp();

    const result = await retrieve();

    expect(voyage.queryCalls).toHaveLength(1);
    expect(result.status).toBe('error');
    expect(result.reason).toBe('embedding_profile_mismatch');
    expect(rpc.searchCalls()).toEqual([]);
  });

  it('accepts another spelling of the same model through its canonical id', async () => {
    const voyage = fakeProvider({ model: 'mongodb/voyage-4-large' });
    setEmbeddingProvidersForTests({ voyage: voyage.provider });
    setUp();

    const result = await retrieve();

    expect(voyage.queryCalls).toHaveLength(1);
    expect(result.reason).not.toBe('embedding_profile_mismatch');
    expect(result.stages.find((stage) => stage.name === 'embed')?.status).toBe('ok');
  });

  it('the voice, media and overview paths fail the same way on a wrong-length vector', async () => {
    const voyage = fakeProvider({ vectorLength: 1024 });
    setEmbeddingProvidersForTests({ voyage: voyage.provider });
    const { rpc } = setUp();

    const voice = await retrieve('voice');
    const media = await retrieve('media');
    const overview = await runRetrieval({
      scope,
      query: QUERY,
      profile: 'chat',
      options: { generalOverview: true },
      signal: new AbortController().signal,
    });

    for (const result of [voice, media, overview]) {
      expect(result.status).toBe('error');
      expect(result.reason).toBe('embedding_profile_mismatch');
    }
    expect(rpc.searchCalls()).toEqual([]);
  });
});

describe('the legacy profile while the switch is on', () => {
  it('embeds with the legacy embedder, asserts the length and searches the legacy RPC', async () => {
    const voyage = fakeProvider();
    setEmbeddingProvidersForTests({ voyage: voyage.provider });
    const { rpc, embedder } = setUp({ registry: () => ({ data: [LEGACY_ROW], error: null }) });

    const result = await retrieve();

    expect(embedder).toHaveBeenCalledTimes(1);
    expect(voyage.queryCalls).toHaveLength(0);
    expect(rpc.searchCalls().every((call) => call.fn === 'match_document_chunks')).toBe(true);
    expect(result.status).toBe('ok');
  });

  it('a legacy embedder that returns the wrong number of values fails with embedding_profile_mismatch', async () => {
    const { rpc } = setUp({
      registry: () => ({ data: [LEGACY_ROW], error: null }),
      embedder: vi.fn<RagDeps['embedder']>(async () => [0.1, 0.2, 0.3]),
    });

    const result = await retrieve();

    expect(result.status).toBe('error');
    expect(result.reason).toBe('embedding_profile_mismatch');
    expect(rpc.searchCalls()).toEqual([]);
  });
});

describe('a startup verdict of mismatch', () => {
  it('makes every retrieval return the error without calling the provider or the search RPC', async () => {
    const voyage = fakeProvider({ modelId: 'some-other-model' });
    setEmbeddingProvidersForTests({ voyage: voyage.provider });
    const { rpc, embedder } = setUp();

    const verdict = await verifyActiveEmbeddingProfileAtStartup();
    expect(verdict.status).toBe('mismatch');
    expect(getStartupVerdict().status).toBe('mismatch');
    errorSpy.mockClear();
    const callsBefore = rpc.calls.length;

    for (const profile of ['chat', 'embed', 'voice', 'media', 'eval'] as const) {
      const result = await retrieve(profile);
      expect(result.status).toBe('error');
      expect(result.reason).toBe('embedding_profile_mismatch');
      expect(result.candidates).toEqual([]);
    }

    expect(voyage.queryCalls).toHaveLength(0);
    expect(embedder).not.toHaveBeenCalled();
    expect(rpc.searchCalls()).toEqual([]);
    expect(rpc.calls.length - callsBefore).toBeLessThanOrEqual(1);
    expect(mismatchLines()).toEqual([]);
  });
});

describe('a registry that cannot be read', () => {
  it('gives status error, never the legacy embedder and never an information-not-available status', async () => {
    const voyage = fakeProvider();
    setEmbeddingProvidersForTests({ voyage: voyage.provider });
    const { rpc, embedder } = setUp({ registry: () => ({ data: null, error: { message: 'down', code: '08006' } }) });

    const result = await retrieve();

    expect(result.status).toBe('error');
    expect(result.status).not.toBe('empty');
    expect(result.reason).toBe('embedding_profile_unavailable');
    expect(result.refusalCandidate).toBe(false);
    expect(embedder).not.toHaveBeenCalled();
    expect(voyage.queryCalls).toHaveLength(0);
    expect(rpc.searchCalls()).toEqual([]);
  });
});

describe('the MISMATCH log line', () => {
  it('is written once per distinct cause with profile, model and dims and never a key', async () => {
    const wrongLength = fakeProvider({ vectorLength: 1024 });
    setEmbeddingProvidersForTests({ voyage: wrongLength.provider });
    setUp();

    await retrieve();
    await retrieve();
    await retrieve('voice');

    expect(mismatchLines()).toHaveLength(1);
    const first = mismatchLines()[0] as string;
    expect(first).toContain('voyage-4-large-2048');
    expect(first).toContain('voyage-4-large');
    expect(first).toContain('2048');
    expect(first).toContain('dims');

    const wrongModel = fakeProvider({ model: 'other-model' });
    setEmbeddingProvidersForTests({ voyage: wrongModel.provider });
    await retrieve();
    await retrieve();

    const lines = mismatchLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('model');
    for (const line of lines) {
      expect(line).not.toContain(VOYAGE_KEY);
      expect(line).not.toContain('Bearer');
    }
    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(VOYAGE_KEY);
    }
  });
});
