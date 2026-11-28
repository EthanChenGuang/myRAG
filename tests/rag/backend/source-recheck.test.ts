import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBackendFactoryForTests, resolveRetrievalBackend, setExternalBackendForTests } from '@/lib/rag/backend/factory';
import { resetReadinessCacheForTests } from '@/lib/rag/backend/readiness';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { isExternalBackendId, sourceRecheckDecision } from '@/lib/rag/backend/source-recheck';
import { resetStaleRepairForTests } from '@/lib/rag/backend/stale-repair';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { createTraceCollector, type TraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages, type SearchStagesOutput } from '@/lib/rag/v2/stages/search';
import { resetV2StartupForTests } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { fakeEmbedder, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const QUERY = 'neutral synthetic question about item alpha';
const ENV = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false' };

function config(over: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({ ...ENV, ...over });
}

/** An external backend whose legs carry the re-validation marker the way createExternalBackend writes it. */
function external(id: 'qdrant' | 'weaviate', staleIds: string[] = []): RetrievalBackend & { calls: number } {
  const backend = {
    id,
    calls: 0,
    async search(): Promise<BackendLegs> {
      backend.calls += 1;
      const kept = [`${id}-a`, `${id}-b`];
      const checked = [...kept, ...staleIds];
      return {
        dense: [hit(kept[0]!, { similarity: 0.9 }), hit(kept[1]!, { rank: 2, similarity: 0.8 })],
        lexical: [],
        meta: {
          denseMode: null,
          tenantValidationDropped: staleIds.length,
          sourceRecheck: { checked: checked.length, dropped: staleIds.length },
          sourceRecheckIds: { checked, dropped: staleIds },
        },
      };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  return backend;
}

function pgvector(): RetrievalBackend & { calls: number } {
  const backend = {
    id: 'pgvector' as const,
    calls: 0,
    async search(): Promise<BackendLegs> {
      backend.calls += 1;
      return { dense: [hit('pg-a', { similarity: 0.9 }), hit('pg-b', { rank: 2, similarity: 0.8 })], lexical: [] };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  return backend;
}

/** Answers readiness with the given state and the Phase 6.3 recheck by keeping every id; records each RPC name. */
function recordingClient(state: string, calls: string[]): RpcClient {
  return {
    rpc(fn, args) {
      calls.push(fn);
      let answer: RpcResponse = { data: [], error: null };
      if (fn === 'rag_backend_readiness') answer = { data: [{ state, lag_seconds: 0, outbox_lag_seconds: 0 }], error: null };
      if (fn === 'rag_source_recheck') {
        const ids = ((args as { p_chunk_ids?: string[] })?.p_chunk_ids ?? []).map((chunk_id) => ({ chunk_id }));
        answer = { data: ids, error: null };
      }
      const req: RpcRequest = { abortSignal: () => req, then: (ok, bad) => Promise.resolve(answer).then(ok, bad) };
      return req;
    },
  };
}

async function search(cfg: RagConfig, env: Record<string, string>, state = 'ready'): Promise<{ out: SearchStagesOutput; collector: TraceCollector; calls: string[] }> {
  const calls: string[] = [];
  installDeps({ embedder: fakeEmbedder().embedder, ragEnv: () => ({ ...ENV, ...env }), searchRpc: recordingClient(state, calls) });
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
  const out = await runSearchStages({
    input: { scope, query: QUERY, profile: 'chat', signal: new AbortController().signal },
    scope,
    config: cfg,
    profile: 'chat',
    params: effectiveRetrievalParams('chat', cfg, null),
    embedding: { vector: [0.1, 0.2, 0.3], profile: null },
    signal: new AbortController().signal,
    collector,
  });
  return { out, collector, calls };
}

const recheckCalls = (calls: string[]) => calls.filter((fn) => fn === 'rag_source_recheck').length;
const searchAttributes = (collector: TraceCollector) => collector.stages().find((stage) => stage.name === 'search')?.attributes;

let pg: ReturnType<typeof pgvector>;

beforeEach(() => {
  uninstallDeps();
  resetBackendFactoryForTests();
  resetReadinessCacheForTests();
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  resetStaleRepairForTests();
  pg = pgvector();
  setRetrievalBackendForTests(pg);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  uninstallDeps();
  resetBackendFactoryForTests();
  resetReadinessCacheForTests();
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  resetStaleRepairForTests();
  vi.restoreAllMocks();
});

describe('sourceRecheckDecision (RET-05)', () => {
  it('weaviate and qdrant are forced on whatever RAG_SOURCE_RECHECK says', () => {
    for (const id of ['weaviate', 'qdrant'] as const) {
      expect(sourceRecheckDecision(id, true)).toEqual({ run: true, forced: true });
      expect(sourceRecheckDecision(id, false)).toEqual({ run: true, forced: true });
    }
  });

  it('pgvector follows the configured switch and is never forced', () => {
    expect(sourceRecheckDecision('pgvector', true)).toEqual({ run: true, forced: false });
    expect(sourceRecheckDecision('pgvector', false)).toEqual({ run: false, forced: false });
  });

  it('isExternalBackendId names the two external backends only', () => {
    expect(isExternalBackendId('qdrant')).toBe(true);
    expect(isExternalBackendId('weaviate')).toBe(true);
    for (const value of ['pgvector', 'QDRANT', '', null, undefined, 1]) expect(isExternalBackendId(value)).toBe(false);
  });
});

describe('one query for external results (RET-05, RET-14)', () => {
  it('one query: qdrant with RAG_SOURCE_RECHECK on issues no Phase 6.3 recheck and carries the external marker', async () => {
    const qdrant = external('qdrant', ['00000000-0000-4000-8000-0000000000e1']);
    setExternalBackendForTests('qdrant', qdrant);
    const env = { RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_SOURCE_RECHECK: 'true' };
    const { out, collector, calls } = await search(config(env), env);
    expect(qdrant.calls).toBe(1);
    expect(recheckCalls(calls)).toBe(0);
    expect(out.sourceRecheck).toEqual({ checked: 3, dropped: 1 });
    expect(collector.stages().some((stage) => stage.name === 'source_recheck')).toBe(false);
    expect(searchAttributes(collector)).toEqual({ backend: 'qdrant', tenant_validation_dropped: 1, stale_index_drop: 1 });
  });

  it('one query: qdrant with RAG_SOURCE_RECHECK off still carries the recheck (forced) and stale_index_drop', async () => {
    const qdrant = external('qdrant', ['00000000-0000-4000-8000-0000000000e2']);
    setExternalBackendForTests('qdrant', qdrant);
    const env = { RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_SOURCE_RECHECK: 'false' };
    const { out, collector, calls } = await search(config(env), env);
    expect(recheckCalls(calls)).toBe(0);
    expect(out.sourceRecheck).toEqual({ checked: 3, dropped: 1 });
    expect(searchAttributes(collector)).toMatchObject({ stale_index_drop: 1 });
  });

  it('pgvector with the switch on runs the Phase 6.3 recheck once, as before', async () => {
    const env = { RAG_SOURCE_RECHECK: 'true' };
    const { out, collector, calls } = await search(config(env), env);
    expect(pg.calls).toBe(1);
    expect(recheckCalls(calls)).toBe(1);
    expect(out.sourceRecheck).toEqual({ checked: 2, dropped: 0 });
    expect(searchAttributes(collector)).toEqual({ backend: 'pgvector', tenant_validation_dropped: 0 });
  });

  it('pgvector with the switch off changes nothing: no recheck, no marker, the same span attributes', async () => {
    const { out, collector, calls } = await search(config(), {});
    expect(recheckCalls(calls)).toBe(0);
    expect(out.sourceRecheck).toBeUndefined();
    expect(collector.stages().some((stage) => stage.name === 'source_recheck')).toBe(false);
    expect(searchAttributes(collector)).toEqual({ backend: 'pgvector', tenant_validation_dropped: 0 });
  });

  it('a qdrant request that fell back to pgvector (backend_not_ready) carries no external marker and follows the switch', async () => {
    const qdrant = external('qdrant');
    setExternalBackendForTests('qdrant', qdrant);
    const off = { RAG_RETRIEVAL_BACKEND: 'qdrant' };
    const first = await search(config(off), off, 'stale');
    expect(qdrant.calls).toBe(0);
    expect(recheckCalls(first.calls)).toBe(0);
    expect(first.out.sourceRecheck).toBeUndefined();
    expect(searchAttributes(first.collector)).not.toHaveProperty('stale_index_drop');

    resetReadinessCacheForTests();
    const on = { RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_SOURCE_RECHECK: 'true' };
    const second = await search(config(on), on, 'stale');
    expect(recheckCalls(second.calls)).toBe(1);
    expect(second.out.sourceRecheck).toEqual({ checked: 2, dropped: 0 });
  });

  it('an external result without the marker is still rechecked (forced), even with the switch off', async () => {
    const bare: RetrievalBackend = {
      id: 'weaviate',
      search: async () => ({ dense: [hit('wv-a', { similarity: 0.9 })], lexical: [] }),
      health: async () => ({ ok: true }),
      isReady: async () => true,
    };
    setExternalBackendForTests('weaviate', bare);
    const env = { RAG_RETRIEVAL_BACKEND: 'weaviate' };
    const { out, calls } = await search(config(env), env);
    expect(recheckCalls(calls)).toBe(1);
    expect(out.sourceRecheck).toEqual({ checked: 1, dropped: 0 });
  });
});

describe('factory selection (RET-05)', () => {
  it('unions the marker ids over every external call of a request and exposes the dropped ids only through staleChunkIds', async () => {
    const stale = '00000000-0000-4000-8000-0000000000e3';
    setExternalBackendForTests('qdrant', external('qdrant', [stale]));
    const cfg = config({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    const calls: string[] = [];
    const resolved = resolveRetrievalBackend('chat', cfg, undefined, { readinessRpc: recordingClient('ready', calls), searchBudgetMs: null });
    const req = {
      scope,
      embeddingProfileId: 'openai-3-small-1536',
      denseVector: [0.1],
      lexicalTokens: [],
      lexicalLanguages: null,
      filters: { currentOnly: true as const },
      denseLimit: 10,
      lexicalLimit: 10,
      access: { mode: 'off' as const },
      signal: new AbortController().signal,
    };
    await resolved.backend.search(req);
    await resolved.backend.search(req);
    const selection = resolved.selection();
    expect(selection.sourceRecheck).toEqual({ checked: 3, dropped: 1 });
    expect(selection.tenantValidationDropped).toBe(2);
    expect(resolved.staleChunkIds()).toEqual([stale]);
    expect(JSON.stringify(selection)).not.toContain(stale);
  });

  it('pgvector selection carries no marker and no stale ids', () => {
    const resolved = resolveRetrievalBackend('chat', config(), undefined);
    expect(resolved.selection()).not.toHaveProperty('sourceRecheck');
    expect(resolved.staleChunkIds()).toEqual([]);
  });
});
