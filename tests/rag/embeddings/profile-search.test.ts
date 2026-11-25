import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { env } from '@/lib/env';
import { runRetrieval } from '@/lib/rag';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests } from '@/lib/rag/deps';
import { resetActiveProfileForTests } from '@/lib/rag/embeddings/active-profile';
import { resetProfileFailureLogForTests } from '@/lib/rag/embeddings/query-embedding';
import { resetEmbeddingProvidersForTests, setEmbeddingProvidersForTests } from '@/lib/rag/embeddings/registry';
import type { EmbeddingProvider } from '@/lib/rag/embeddings/types';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { legacyAnalyze, resetCalibrationWarningsForTests } from '@/lib/rag/legacy/enhanced-retrieval';
import { mintScope } from '@/lib/rag/tenant/scope';
import { installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000b1';
const SEMANTIC = 'tell me about the onboarding process';
const FALLBACK_QUERIES = ['What was the revenue in Q3 2023?', 'revenue growth in 2023', 'total sales for fiscal year 2022'];
const MISMATCH_NOT_ACTIVE = 'embedding_profile_mismatch: profile not active';

const mutableEnv = env as unknown as Record<string, unknown>;
const savedVoyageKey = mutableEnv.VOYAGE_API_KEY;

interface RecordedRpc {
  fn: string;
  args: Record<string, unknown>;
}

function profileRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    provider: 'voyage',
    model: 'voyage-4-large',
    dims: 8,
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
  dims: 1536,
  storage: 'legacy_column',
  score_calibration: { retrieval_threshold: 0.7, context_threshold: 0.65, fallback_threshold: 0.28, context_image_threshold: 0.25 },
});

type Responder = (fn: string, args: Record<string, unknown>, nth: number) => RpcResponse;

function fakeRpc(respond: Responder): { client: RpcClient; calls: RecordedRpc[]; of: (fn: string) => RecordedRpc[] } {
  const calls: RecordedRpc[] = [];
  const counts = new Map<string, number>();
  const client: RpcClient = {
    rpc(fn, args): RpcRequest {
      calls.push({ fn, args });
      const nth = (counts.get(fn) ?? 0) + 1;
      counts.set(fn, nth);
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(respond(fn, args, nth)).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { client, calls, of: (fn) => calls.filter((call) => call.fn === fn) };
}

function profileRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `chunk-${index + 1}`,
    document_id: `doc-${index + 1}`,
    content: `fixture chunk body ${index + 1}`,
    similarity: 0.9 - index * 0.05,
    metadata: null,
  }));
}

function legacyRows(count: number) {
  return profileRows(count).map((row) => ({ chunk_id: row.id, document_id: row.document_id, content: row.content, similarity: row.similarity, metadata: null }));
}

function provider(): EmbeddingProvider {
  return {
    id: 'voyage',
    model: 'voyage-4-large',
    maxInputTokens: 8000,
    supportedDims: [8, 16],
    normalize: true,
    async embedQuery(_text, opts) {
      return { vectors: [Array.from({ length: opts.dims }, (_v, i) => i / 100)], model: 'voyage-4-large', host: 'fake', usage: { tokens: 1 } };
    },
    async embedDocuments() {
      throw new Error('unused');
    },
  };
}

let errorSpy: MockInstance<typeof console.error>;
let warnSpy: MockInstance<typeof console.warn>;

function install(rpc: ReturnType<typeof fakeRpc>) {
  installDeps({ embedder: vi.fn(async () => Array.from({ length: 1536 }, () => 0.02)), searchRpc: rpc.client });
}

function retrieve(query: string, scope = mintScope('single', null, null)) {
  return runRetrieval({ scope, query, profile: 'eval', options: { maxResults: 10, fallbackToLowerThreshold: true }, signal: new AbortController().signal });
}

beforeEach(() => {
  setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'on' }) });
  mutableEnv.VOYAGE_API_KEY = 'test-voyage-key-placeholder-0123456789';
  setEmbeddingProvidersForTests({ voyage: provider() });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  mutableEnv.VOYAGE_API_KEY = savedVoyageKey;
  uninstallDeps();
  resetRagDepsForTests();
  resetIngestDepsForTests();
  resetActiveProfileForTests();
  resetEmbeddingProvidersForTests();
  resetProfileFailureLogForTests();
  resetCalibrationWarningsForTests();
});

describe('search through the active non-legacy profile', () => {
  it('calls match_chunks_by_profile with the scope tenant key, the profile id and dims, and never a legacy RPC', async () => {
    const rpc = fakeRpc((fn) =>
      fn === 'rag_list_embedding_profiles' ? { data: [profileRow('test-8')], error: null } : { data: profileRows(5), error: null },
    );
    install(rpc);

    const result = await retrieve(SEMANTIC, mintScope('org', USER, ORG));

    const searches = rpc.of('match_chunks_by_profile');
    expect(searches.length).toBeGreaterThan(0);
    for (const call of searches) {
      expect(call.args.p_tenant_key).toBe(`o:${ORG}`);
      expect(call.args.p_profile_id).toBe('test-8');
      expect(call.args.p_dims).toBe(8);
      expect(call.args.p_query).toHaveLength(8);
      expect(Object.keys(call.args).sort()).toEqual(
        ['p_dims', 'p_match_count', 'p_min_similarity', 'p_profile_id', 'p_query', 'p_tenant_key'],
      );
    }
    expect(rpc.of('match_documents_by_workspace')).toEqual([]);
    expect(rpc.of('match_document_chunks')).toEqual([]);
    expect(result.status).toBe('ok');
    expect(result.candidates.map((candidate) => candidate.chunk_id)).toContain('chunk-1');
  });

  it('a personal scope and the single scope send their own tenant keys', async () => {
    const rpc = fakeRpc((fn) =>
      fn === 'rag_list_embedding_profiles' ? { data: [profileRow('test-8')], error: null } : { data: profileRows(5), error: null },
    );
    install(rpc);

    await retrieve(SEMANTIC, mintScope('personal', USER, null));
    await retrieve(SEMANTIC, mintScope('single', null, null));

    const keys = new Set(rpc.of('match_chunks_by_profile').map((call) => call.args.p_tenant_key));
    expect(keys).toEqual(new Set([`u:${USER}`, 's:default']));
  });

  it('the voice, media and overview searches also use the profile RPC', async () => {
    const rpc = fakeRpc((fn) =>
      fn === 'rag_list_embedding_profiles' ? { data: [profileRow('test-8')], error: null } : { data: profileRows(5), error: null },
    );
    install(rpc);
    const scope = mintScope('single', null, null);
    const signal = new AbortController().signal;

    await runRetrieval({ scope, query: SEMANTIC, profile: 'voice', signal });
    await runRetrieval({ scope, query: SEMANTIC, profile: 'media', signal });
    await runRetrieval({ scope, query: SEMANTIC, profile: 'chat', options: { generalOverview: true }, signal });

    expect(rpc.of('match_chunks_by_profile').length).toBeGreaterThanOrEqual(3);
    expect(rpc.of('match_document_chunks')).toEqual([]);
  });
});

describe('the stale-pointer retry', () => {
  it('refreshes the pointer once and retries once with the new active profile', async () => {
    let flipped = false;
    const rpc = fakeRpc((fn, args) => {
      if (fn === 'rag_list_embedding_profiles') {
        return { data: [profileRow(flipped ? 'test-16' : 'test-8', { dims: flipped ? 16 : 8 })], error: null };
      }
      if (args.p_profile_id === 'test-8') {
        flipped = true;
        return { data: null, error: { message: MISMATCH_NOT_ACTIVE, code: '22000' } };
      }
      return { data: profileRows(4), error: null };
    });
    install(rpc);

    const result = await retrieve(SEMANTIC);

    expect(rpc.of('rag_list_embedding_profiles')).toHaveLength(2);
    const searches = rpc.of('match_chunks_by_profile');
    expect(searches.map((call) => call.args.p_profile_id)).toEqual(['test-8', 'test-16']);
    expect(searches[1]?.args.p_dims).toBe(16);
    expect(searches[1]?.args.p_query).toHaveLength(16);
    expect(result.status).not.toBe('error');
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('a second failure returns status error and no third search is made', async () => {
    let reads = 0;
    const rpc = fakeRpc((fn) => {
      if (fn === 'rag_list_embedding_profiles') {
        reads += 1;
        return { data: [profileRow(reads === 1 ? 'test-8' : 'test-16', { dims: reads === 1 ? 8 : 16 })], error: null };
      }
      return { data: null, error: { message: MISMATCH_NOT_ACTIVE, code: '22000' } };
    });
    install(rpc);

    const result = await retrieve(SEMANTIC);

    expect(result.status).toBe('error');
    expect(result.reason).toBe('embedding_profile_mismatch');
    expect(rpc.of('match_chunks_by_profile')).toHaveLength(2);
    expect(rpc.of('rag_list_embedding_profiles')).toHaveLength(2);
  });

  it('does not retry when the refreshed pointer names the same profile', async () => {
    const rpc = fakeRpc((fn) =>
      fn === 'rag_list_embedding_profiles'
        ? { data: [profileRow('test-8')], error: null }
        : { data: null, error: { message: MISMATCH_NOT_ACTIVE, code: '22000' } },
    );
    install(rpc);

    const result = await retrieve(SEMANTIC);

    expect(result.status).toBe('error');
    expect(result.reason).toBe('embedding_profile_mismatch');
    expect(rpc.of('match_chunks_by_profile')).toHaveLength(1);
  });

  it('any other RPC failure stays a backend error and is not retried', async () => {
    const rpc = fakeRpc((fn) =>
      fn === 'rag_list_embedding_profiles'
        ? { data: [profileRow('test-8')], error: null }
        : { data: null, error: { message: 'connection reset', code: '08006' } },
    );
    install(rpc);

    const result = await retrieve(SEMANTIC);

    expect(result.status).toBe('error');
    expect(result.reason).toBe('backend_error');
    expect(rpc.of('match_chunks_by_profile')).toHaveLength(1);
    expect(rpc.of('rag_list_embedding_profiles')).toHaveLength(1);
  });
});

describe('thresholds from score_calibration', () => {
  function thresholds(rpc: ReturnType<typeof fakeRpc>, fn: string): number[] {
    return rpc.of(fn).map((call) => (call.args.p_min_similarity ?? call.args.similarity_threshold) as number);
  }

  it('a non-legacy profile is searched at the tier scaled by its retrieval threshold and falls back at its own fallback threshold', async () => {
    const query = FALLBACK_QUERIES.find((candidate) => legacyAnalyze(candidate).suggestedThreshold > 0.35);
    expect(query, 'a fixture query with a tier above the low tier').toBeDefined();
    const tier = legacyAnalyze(query as string).suggestedThreshold;
    const rpc = fakeRpc((fn) =>
      fn === 'rag_list_embedding_profiles'
        ? { data: [profileRow('test-8', { score_calibration: { retrieval_threshold: 0.35, fallback_threshold: 0.14, context_threshold: 0.3, context_image_threshold: 0.1 } })], error: null }
        : { data: [], error: null },
    );
    install(rpc);

    await retrieve(query as string);

    const used = thresholds(rpc, 'match_chunks_by_profile');
    expect(used.length).toBeGreaterThanOrEqual(2);
    expect(used[0]).toBeCloseTo(Math.max(tier * 0.5, 0.35), 6);
    expect(used[used.length - 1]).toBe(0.14);
  });

  it('a low-tier query on a non-legacy profile is searched at half the legacy threshold when the calibration halves the scale', async () => {
    const low = legacyAnalyze(SEMANTIC).suggestedThreshold;
    const rpc = fakeRpc((fn) =>
      fn === 'rag_list_embedding_profiles'
        ? { data: [profileRow('test-8', { score_calibration: { retrieval_threshold: 0.35, fallback_threshold: 0.14 } })], error: null }
        : { data: profileRows(5), error: null },
    );
    install(rpc);

    await retrieve(SEMANTIC);

    expect(thresholds(rpc, 'match_chunks_by_profile')[0]).toBeCloseTo(low * 0.5, 6);
  });

  it('the legacy profile row searches at exactly the constants it searches at with the switch off', async () => {
    const query = FALLBACK_QUERIES.find((candidate) => legacyAnalyze(candidate).suggestedThreshold > 0.35) as string;
    const tier = legacyAnalyze(query).suggestedThreshold;
    const rpc = fakeRpc((fn) => (fn === 'rag_list_embedding_profiles' ? { data: [LEGACY_ROW], error: null } : { data: [], error: null }));
    install(rpc);

    await retrieve(query);

    const used = thresholds(rpc, 'match_document_chunks');
    expect(used[0]).toBe(Math.max(tier, legacyAnalyze(query).searchStrategy === 'exact_match' ? 0.7 : 0));
    expect(used[used.length - 1]).toBe(0.28);
    expect(rpc.of('match_chunks_by_profile')).toEqual([]);
  });

  it('a non-legacy profile with an empty calibration keeps the legacy constants and warns once', async () => {
    const query = FALLBACK_QUERIES.find((candidate) => legacyAnalyze(candidate).suggestedThreshold > 0.35) as string;
    const rpc = fakeRpc((fn) => (fn === 'rag_list_embedding_profiles' ? { data: [profileRow('test-8')], error: null } : { data: [], error: null }));
    install(rpc);

    await retrieve(query);
    await retrieve(query);

    const used = thresholds(rpc, 'match_chunks_by_profile');
    expect(used[used.length - 1]).toBe(0.28);
    const warnings = warnSpy.mock.calls.map((args) => String(args[0])).filter((line) => line.startsWith('[Embedding Profile] CALIBRATION MISSING'));
    expect(warnings).toHaveLength(1);
  });
});

describe('eval embedding_profile override', () => {
  it('embeds the requested profile and searches with p_require_active false', async () => {
    const voyage = profileRow('voyage-4-large-2048', {
      status: 'available',
      dims: 2048,
      storage: 'halfvec',
      provider: 'voyage',
      model: 'voyage-4-large',
    });
    const rpc = fakeRpc((fn) =>
      fn === 'rag_list_embedding_profiles'
        ? { data: [profileRow('test-8'), voyage], error: null }
        : { data: profileRows(3), error: null },
    );
    setEmbeddingProvidersForTests({
      voyage: {
        ...provider(),
        supportedDims: [256, 512, 1024, 2048],
        async embedQuery(_text, opts) {
          return {
            vectors: [Array.from({ length: opts.dims }, (_, index) => (index + 1) / opts.dims)],
            model: 'voyage-4-large',
            host: 'fake',
            usage: { tokens: 1 },
          };
        },
      },
    });
    install(rpc);

    await runRetrieval({
      scope: mintScope('single', null, null),
      query: SEMANTIC,
      profile: 'eval',
      options: { maxResults: 10, fallbackToLowerThreshold: true, embeddingProfile: 'voyage-4-large-2048' },
      signal: new AbortController().signal,
    });

    const searches = rpc.of('match_chunks_by_profile');
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((call) => call.args.p_profile_id === 'voyage-4-large-2048')).toBe(true);
    expect(searches.every((call) => call.args.p_require_active === false)).toBe(true);
  });
});

describe('the switch off', () => {
  it('issues no registry read and no profile search, only the legacy RPC', async () => {
    setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'off' }) });
    const rpc = fakeRpc((fn) => (fn === 'match_document_chunks' ? { data: legacyRows(5), error: null } : { data: [], error: null }));
    install(rpc);

    const result = await retrieve(SEMANTIC);

    expect(rpc.calls.map((call) => call.fn).every((fn) => fn === 'match_document_chunks')).toBe(true);
    expect(result.status).toBe('ok');
  });
});
