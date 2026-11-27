import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBackendFactoryForTests, setExternalBackendForTests } from '@/lib/rag/backend/factory';
import { backendIndexParams } from '@/lib/rag/backend/index-params';
import { resetReadinessCacheForTests } from '@/lib/rag/backend/readiness';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { degradedReason, deriveStatus } from '@/lib/rag/pipeline';
import { createTraceCollector, type TraceCollector } from '@/lib/rag/trace/collector';
import { buildTraceLogPayload } from '@/lib/rag/trace/log';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { QueryVariant, RetrievalResult } from '@/lib/rag/types';
import { computeRetrievalConfigHash, type RetrievalConfigHashInput } from '@/lib/rag/v2/config-hash';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { resetV2StartupForTests } from '@/lib/rag/v2/startup';
import { RagTraceSchema } from '@/lib/rag-eval/contracts.generated';
import { retrievalBackendTrace } from '@/lib/rag-eval/trace';
import { hit } from '../fusion/helpers';
import { fakeEmbedder, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const QUERY = 'neutral synthetic question about item alpha';
const ENV = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false' };

function config(over: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({ ...ENV, ...over });
}

function counting(id: RetrievalBackend['id'], prefix: string, dropped?: number): RetrievalBackend & { calls: number } {
  const backend = {
    id,
    calls: 0,
    async search(): Promise<BackendLegs> {
      backend.calls += 1;
      return {
        dense: [hit(`${prefix}-a`, { similarity: 0.9 }), hit(`${prefix}-b`, { rank: 2, similarity: 0.8 })],
        lexical: [],
        ...(dropped !== undefined ? { meta: { denseMode: null, tenantValidationDropped: dropped } } : {}),
      };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  return backend;
}

function readinessClient(state: string): RpcClient {
  return {
    rpc(fn) {
      const answer: RpcResponse =
        fn === 'rag_backend_readiness'
          ? { data: [{ state, lag_seconds: 0, outbox_lag_seconds: 0 }], error: null }
          : { data: [], error: null };
      const req: RpcRequest = { abortSignal: () => req, then: (ok, bad) => Promise.resolve(answer).then(ok, bad) };
      return req;
    },
  };
}

const variants: QueryVariant[] = [
  { text: QUERY, language: null, kind: 'original' },
  { text: 'neutral synthetic question, reworded', language: null, kind: 'condensed' },
];

async function search(cfg: RagConfig, env: Record<string, string>, state = 'ready', withVariants = false): Promise<TraceCollector> {
  installDeps({ embedder: fakeEmbedder().embedder, ragEnv: () => ({ ...ENV, ...env }), searchRpc: readinessClient(state) });
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
  await runSearchStages({
    input: { scope, query: QUERY, profile: 'chat', signal: new AbortController().signal },
    scope,
    config: cfg,
    profile: 'chat',
    params: effectiveRetrievalParams('chat', cfg, null),
    embedding: { vector: [0.1, 0.2, 0.3], profile: null },
    signal: new AbortController().signal,
    collector,
    ...(withVariants ? { variants, variantEmbeddings: [{ vector: [0.1, 0.2, 0.3], profile: null }, { vector: [0.3, 0.2, 0.1], profile: null }] } : {}),
  });
  return collector;
}

function searchRecord(collector: TraceCollector) {
  const record = collector.stages().find((stage) => stage.name === 'search');
  expect(record).toBeDefined();
  return record!;
}

function resultOf(collector: TraceCollector): RetrievalResult {
  return { status: 'degraded', reason: 'x', stages: collector.stages() } as unknown as RetrievalResult;
}

let pg: ReturnType<typeof counting>;

beforeEach(() => {
  uninstallDeps();
  resetBackendFactoryForTests();
  resetReadinessCacheForTests();
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  pg = counting('pgvector', 'pg');
  setRetrievalBackendForTests(pg);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  uninstallDeps();
  resetBackendFactoryForTests();
  resetReadinessCacheForTests();
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  vi.restoreAllMocks();
});

describe('search stage backend selection (D-24, D-25)', () => {
  it('defaults: pgvector serves, the span records the backend with no fallback, and the stage stays ok', async () => {
    const collector = await search(config(), {});
    const record = searchRecord(collector);
    expect(record.status).toBe('ok');
    expect(record.attributes).toEqual({ backend: 'pgvector', tenant_validation_dropped: 0 });
    expect(record.detail).toBeUndefined();
    expect(pg.calls).toBe(1);
  });

  it('every variant search of a request goes through the selected backend and the dropped counts are summed', async () => {
    const qdrant = counting('qdrant', 'qd', 1);
    setExternalBackendForTests('qdrant', qdrant);
    const collector = await search(config({ RAG_RETRIEVAL_BACKEND: 'qdrant' }), { RAG_RETRIEVAL_BACKEND: 'qdrant' }, 'ready', true);
    const record = searchRecord(collector);
    expect(qdrant.calls).toBe(2);
    expect(pg.calls).toBe(0);
    expect(record.status).toBe('ok');
    expect(record.attributes).toEqual({ backend: 'qdrant', tenant_validation_dropped: 2 });
  });

  it('a not-ready backend falls back to pgvector, degrades the stage and the result reason is backend_not_ready', async () => {
    const qdrant = counting('qdrant', 'qd');
    setExternalBackendForTests('qdrant', qdrant);
    const collector = await search(config({ RAG_RETRIEVAL_BACKEND: 'qdrant' }), { RAG_RETRIEVAL_BACKEND: 'qdrant' }, 'stale');
    const record = searchRecord(collector);
    expect(qdrant.calls).toBe(0);
    expect(pg.calls).toBe(1);
    expect(record.status).toBe('degraded');
    expect(record.attributes).toEqual({ backend: 'pgvector', tenant_validation_dropped: 0, fallback_reason: 'backend_not_ready' });
    expect(record.detail).toContain('backend_not_ready');
    const records = collector.stages();
    expect(deriveStatus(records, 2)).toBe('degraded');
    expect(degradedReason(records)).toBe('backend_not_ready');
  });

  it('the [RAG Trace] payload carries the three fields and no query or chunk text', async () => {
    const qdrant = counting('qdrant', 'qd', 3);
    setExternalBackendForTests('qdrant', qdrant);
    const collector = await search(config({ RAG_RETRIEVAL_BACKEND: 'qdrant' }), { RAG_RETRIEVAL_BACKEND: 'qdrant' });
    const payload = buildTraceLogPayload(collector, resultOf(collector));
    const stage = payload.stages.find((entry) => entry.name === 'search') as Record<string, unknown>;
    expect(stage).toMatchObject({ backend: 'qdrant', fallback_reason: null, tenant_validation_dropped: 3 });
    const line = JSON.stringify(payload);
    expect(line).not.toContain(QUERY);
    expect(line).not.toContain('content-qd');
  });

  it('the eval trace field validates against the generated RagTrace schema', async () => {
    const collector = await search(config({ RAG_RETRIEVAL_BACKEND: 'weaviate' }), { RAG_RETRIEVAL_BACKEND: 'weaviate' }, 'building');
    const field = retrievalBackendTrace(collector.stages());
    expect(field).toEqual({ backend: 'pgvector', fallback_reason: 'backend_not_ready', tenant_validation_dropped: 0 });
    expect(RagTraceSchema.shape.retrieval_backend.safeParse(field).success).toBe(true);
    expect(retrievalBackendTrace([])).toBeUndefined();
  });
});

describe('retrieval config hash backend inputs (D-24)', () => {
  const base: RetrievalConfigHashInput = {
    backendId: 'pgvector',
    embeddingProfileId: 'openai-3-small-1536',
    lexicalVersion: 1,
    rerankTextVersion: 1,
    params: { candidate_pool_size: 50, final_top_k: 8, rrf_k: 60, rerank_input_cap: 40 } as unknown as RetrievalConfigHashInput['params'],
    reranker: { id: 'none', model: '' } as RetrievalConfigHashInput['reranker'],
    thresholdsConfigHash: null,
    activeChunkingProfiles: { general: 'legacy' },
    switches: {
      lexicalSearch: false,
      refusalThreshold: false,
      edgeOrder: false,
      compression: false,
      tokenBudget: 6000,
      parentChild: false,
      iterativeScan: 'off',
      exactScanCutoff: 0,
      lexicalTranslation: false,
      exactIdLookup: false,
      rerankTierChat: 'quality',
      rerankTierVoice: 'fast',
    },
  };

  it('default hash: pgvector with the defaults keeps the value it had before external backends', () => {
    expect(backendIndexParams('pgvector', base.embeddingProfileId)).toBeNull();
    expect(computeRetrievalConfigHash(base)).toBe(PGVECTOR_DEFAULT_HASH);
    expect(computeRetrievalConfigHash({ ...base, backendIndex: null })).toBe(PGVECTOR_DEFAULT_HASH);
  });

  it('differs between pgvector and qdrant, and between two qdrant index configurations', () => {
    const qdrantIndex = backendIndexParams('qdrant', base.embeddingProfileId)!;
    expect(qdrantIndex).toMatchObject({ collection: 'myrag_chunks_openai-3-small-1536', hnsw_m: 64, hnsw_ef: 200, quantization: 'none' });
    const qdrant = computeRetrievalConfigHash({ ...base, backendId: 'qdrant', backendIndex: qdrantIndex });
    expect(qdrant).not.toBe(computeRetrievalConfigHash(base));
    const otherLexical = computeRetrievalConfigHash({ ...base, backendId: 'qdrant', backendIndex: { ...qdrantIndex, lexical_mode: 'other_mode' } });
    expect(otherLexical).not.toBe(qdrant);
    const weaviateIndex = backendIndexParams('weaviate', base.embeddingProfileId)!;
    expect(weaviateIndex.collection).toMatch(/^Myrag_chunks_/);
    expect(computeRetrievalConfigHash({ ...base, backendId: 'weaviate', backendIndex: weaviateIndex })).not.toBe(qdrant);
  });
});

/** computeRetrievalConfigHash(base) at the commit before this plan (pinned so the default hash can never drift). */
const PGVECTOR_DEFAULT_HASH = 'cd5802e67caf9dba719d8f8ef510b12369a1c158275090a4794aca06cd743d11';
