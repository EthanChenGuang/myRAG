import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import { hit, rankedList } from '../fusion/helpers';
import { rrf } from '@/lib/rag/fusion/rrf';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import type { ExactIdRow } from '@/lib/rag/retrieval/exact-id';
import * as fetchRows from '@/lib/rag/context/fetch-rows';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const EXACT_RPC = 'rag_exact_id_documents';

function config(over: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_EXACT_ID_LOOKUP: 'true', ...over });
}

function exactRow(chunkId: string, overrides: Partial<ExactIdRow> = {}): ExactIdRow {
  return {
    chunk_id: chunkId,
    document_id: `doc-${chunkId}`,
    content: `exact body ${chunkId}`,
    metadata: null,
    matched_field: 'invoice_number',
    ...overrides,
  };
}

function routedBackend(legs: BackendLegs, exact?: ExactIdRow[], exactError?: { message: string; code?: string }): {
  backend: RetrievalBackend;
  exactCalls: () => number;
} {
  let exactCallCount = 0;
  const rpc: RpcClient = {
    rpc(fn): RpcRequest {
      const request: RpcRequest = {
        abortSignal() {
          return request;
        },
        then(onFulfilled, onRejected) {
          if (fn === EXACT_RPC) {
            exactCallCount += 1;
            const data = exactError ? null : (exact ?? []);
            const error = exactError ? exactError : null;
            return Promise.resolve({ data, error } as RpcResponse).then(onFulfilled, onRejected);
          }
          return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  const backend: RetrievalBackend = {
    id: 'pgvector',
    search: async () => legs,
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  installDeps({
    embedder: fakeEmbedder().embedder,
    adminClient: adminWithRpc(rpc, fakeAssemblyAdmin()),
    ragEnv: () => ({
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'true',
      RAG_EXACT_ID_LOOKUP: 'true',
    }),
  });
  return { backend, exactCalls: () => exactCallCount };
}

function denseLexical(dense: string[], lexical: string[]): BackendLegs {
  return {
    dense: dense.map((chunkId, index) => hit(chunkId, { rank: index + 1, similarity: 0.9 - index * 0.01 })),
    lexical: lexical.map((chunkId, index) => hit(chunkId, { rank: index + 1, lexicalScore: 1 - index * 0.1 })),
  };
}

describe('runSearchStages exact_id RRF leg (D-24)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetRagConfigForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('adds an exact-only hit as a third RRF list with score weight/(k+1)', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('eval', cfg, {
      candidate_pool_size: null,
      final_top_k: null,
      rrf_k: null,
      rerank_input_cap: null,
      rerank_model: null,
      leg_weights: { dense: 1, lexical: 1, exact_id: 2 },
    });
    const { backend } = routedBackend(denseLexical(['a', 'b'], ['b', 'c']), [exactRow('x')]);
    setRetrievalBackendForTests(backend);
    await verifyV2Startup();

    const output = await runSearchStages({
      input: { scope, query: 'invoice FT-2025-09999', profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1, 0.2], profile: null },
      signal: new AbortController().signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
    });

    const k = params.rrf_k;
    const expected = rrf(
      [rankedList('dense:0', ['a', 'b']), rankedList('lexical:0', ['b', 'c']), { id: 'exact_id', weight: 2, hits: [hit('x', { rank: 1 })] }],
      k,
    );
    const fused = output.fusedHits;
    const x = fused.find((row) => row.hit.chunkId === 'x');
    expect(x).toBeDefined();
    expect(x?.ranks.exact_id).toBe(1);
    expect(x?.score).toBeCloseTo(2 / (k + 1), 8);
    const expectedX = expected.find((row) => row.hit.chunkId === 'x');
    expect(x?.score).toBeCloseTo(expectedX?.score ?? 0, 8);
  });

  it('merges dense and exact_id contributions without duplicating a shared chunk', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('eval', cfg, null);
    const shared = hit('shared', { rank: 5, similarity: 0.5 });
    const legs: BackendLegs = {
      dense: [hit('a', { rank: 1 }), shared],
      lexical: [],
    };
    const { backend } = routedBackend(legs, [exactRow('shared')]);
    setRetrievalBackendForTests(backend);
    await verifyV2Startup();

    const output = await runSearchStages({
      input: { scope, query: 'invoice FT-2025-00417', profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1], profile: null },
      signal: new AbortController().signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
    });

    const ids = output.fusedHits.map((row) => row.hit.chunkId);
    expect(ids.filter((id) => id === 'shared').length).toBe(1);
    const fused = output.fusedHits.find((row) => row.hit.chunkId === 'shared');
    expect(fused?.ranks['dense:0']).toBe(5);
    expect(fused?.ranks.exact_id).toBe(1);
    const k = params.rrf_k;
    const denseWeight = params.leg_weights?.dense ?? 1;
    const exactWeight = params.leg_weights?.exact_id ?? 1;
    const expectedScore = denseWeight / (k + 5) + exactWeight / (k + 1);
    expect(fused?.score).toBeCloseTo(expectedScore, 8);
  });

  it('fetches assembly rows once for exact-only hits', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('eval', cfg, null);
    const fetchSpy = vi.spyOn(fetchRows, 'fetchAssemblyRows');
    const rpc: RpcClient = {
      rpc(fn): RpcRequest {
        const request: RpcRequest = {
          abortSignal() {
            return request;
          },
          then(onFulfilled, onRejected) {
            if (fn === EXACT_RPC) {
              return Promise.resolve({ data: [exactRow('only-exact')], error: null }).then(onFulfilled, onRejected);
            }
            return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
          },
        };
        return request;
      },
    };
    installDeps({
      embedder: fakeEmbedder().embedder,
      adminClient: adminWithRpc(rpc, fakeAssemblyAdmin()),
      ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_EXACT_ID_LOOKUP: 'true' }),
    });
    setRetrievalBackendForTests({
      id: 'pgvector',
      search: async () => denseLexical([], []),
      health: async () => ({ ok: true }),
      isReady: async () => true,
    });
    await verifyV2Startup();

    await runSearchStages({
      input: { scope, query: 'invoice FT-2025-77777', profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1], profile: null },
      signal: new AbortController().signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('with the switch off does not run exact_id_lookup and matches two-leg fusion', async () => {
    const cfg = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_EXACT_ID_LOOKUP: 'false' });
    const params = effectiveRetrievalParams('eval', cfg, null);
    const { backend, exactCalls } = routedBackend(denseLexical(['a', 'b'], ['c']), [exactRow('x')]);
    setRetrievalBackendForTests(backend);
    const { embedder } = fakeEmbedder();
    installDeps({ embedder, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_EXACT_ID_LOOKUP: 'false' }) });
    await verifyV2Startup();

    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const output = await runSearchStages({
      input: { scope, query: 'invoice FT-2025-00417', profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1], profile: null },
      signal: new AbortController().signal,
      collector,
    });

    expect(exactCalls()).toBe(0);
    expect(collector.stages().some((row) => row.name === 'exact_id_lookup')).toBe(false);
    const expected = rrf([rankedList('dense:0', ['a', 'b']), rankedList('lexical:0', ['c'])], params.rrf_k).map((row) => row.hit.chunkId);
    expect(output.fusedHits.map((row) => row.hit.chunkId)).toEqual(expected.slice(0, params.rerank_input_cap));
  });

  it('degrades to two-leg fusion when exact_id_lookup fails', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('eval', cfg, null);
    const { backend } = routedBackend(denseLexical(['a', 'b'], ['c']), undefined, { message: 'boom', code: '500' });
    setRetrievalBackendForTests(backend);
    await verifyV2Startup();

    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const output = await runSearchStages({
      input: { scope, query: 'invoice FT-2025-00417', profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1], profile: null },
      signal: new AbortController().signal,
      collector,
    });

    const stage = collector.stages().find((row) => row.name === 'exact_id_lookup');
    expect(stage?.status).toBe('skipped');
    const expected = rrf([rankedList('dense:0', ['a', 'b']), rankedList('lexical:0', ['c'])], params.rrf_k).map((row) => row.hit.chunkId);
    expect(output.fusedHits.map((row) => row.hit.chunkId)).toEqual(expected.slice(0, params.rerank_input_cap));
  });
});