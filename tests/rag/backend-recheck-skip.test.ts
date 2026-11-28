import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRetrieval } from '@/lib/rag';
import { resetBackendFactoryForTests, setExternalBackendForTests } from '@/lib/rag/backend/factory';
import { resetReadinessCacheForTests } from '@/lib/rag/backend/readiness';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { resetStaleRepairForTests, setStaleRepairDepsForTests } from '@/lib/rag/backend/stale-repair';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Profile, RetrievalResult } from '@/lib/rag/types';
import { resetV2StartupForTests } from '@/lib/rag/v2/startup';
import { hit } from './fusion/helpers';
import { fakeAssemblyAdmin, fakeEmbedder, installDeps, uninstallDeps } from './helpers/pipeline-fakes';

const RECHECK_RPC = 'rag_source_recheck';
const scope = mintScope('single', null, null);
const QUERY = 'neutral synthetic question about item alpha';
const V2 = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_REFUSAL_THRESHOLD: 'false' };
const STALE = '00000000-0000-4000-8000-0000000000f1';

/** A fake external store whose legs carry the marker the way createExternalBackend writes it after rag_validate_chunks. */
function externalStore(id: 'qdrant' | 'weaviate', staleIds: readonly string[]): RetrievalBackend & { calls: number } {
  const store = {
    id,
    calls: 0,
    async search(): Promise<BackendLegs> {
      store.calls += 1;
      const kept = [`${id}-kept-1`, `${id}-kept-2`];
      const checked = [...kept, ...staleIds];
      return {
        dense: kept.map((chunkId, index) => hit(chunkId, { rank: index + 1, similarity: 0.9 - index * 0.05, documentId: `doc-${chunkId}` })),
        lexical: [],
        meta: {
          denseMode: null,
          tenantValidationDropped: staleIds.length,
          sourceRecheck: { checked: checked.length, dropped: staleIds.length },
          sourceRecheckIds: { checked, dropped: [...staleIds] },
        },
      };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  return store;
}

/** The pgvector fixture: three candidates, one of which the Phase 6.3 recheck reports as stale. */
function pgvectorStore(): RetrievalBackend & { calls: number } {
  const store = {
    id: 'pgvector' as const,
    calls: 0,
    async search(): Promise<BackendLegs> {
      store.calls += 1;
      return {
        dense: ['pg-1', 'pg-2', 'pg-3'].map((chunkId, index) => hit(chunkId, { rank: index + 1, similarity: 0.9 - index * 0.05, documentId: `doc-${chunkId}` })),
        lexical: [],
      };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  return store;
}

/** Readiness answers with the given state; the 6.3 recheck keeps every id except pg-2; every RPC name is recorded. */
function routedRpc(readiness: string) {
  const calls: string[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push(fn);
      let answer: RpcResponse = { data: [], error: null };
      if (fn === 'rag_backend_readiness') answer = { data: [{ state: readiness, lag_seconds: 0, outbox_lag_seconds: 0 }], error: null };
      if (fn === RECHECK_RPC) {
        const ids = ((args as { p_chunk_ids?: string[] })?.p_chunk_ids ?? []).filter((id) => id !== 'pg-2');
        answer = { data: ids.map((chunk_id) => ({ chunk_id })), error: null };
      }
      const req: RpcRequest = { abortSignal: () => req, then: (ok, bad) => Promise.resolve(answer).then(ok, bad) };
      return req;
    },
  };
  return { client, calls, recheckCalls: () => calls.filter((fn) => fn === RECHECK_RPC).length };
}

let scheduledRepairs = 0;

async function retrieve(env: Record<string, string>, options: { profile?: Profile; readiness?: string } = {}) {
  const rpc = routedRpc(options.readiness ?? 'ready');
  const merged = { ...V2, ...env };
  installDeps({ embedder: fakeEmbedder().embedder, adminClient: fakeAssemblyAdmin(), searchRpc: rpc.client, ragEnv: () => merged });
  const result = await runRetrieval({ scope, query: QUERY, profile: options.profile ?? 'chat', signal: new AbortController().signal });
  return { result, rpc };
}

const stage = (result: RetrievalResult, name: string) => result.stages.find((record) => record.name === name);
/** The run route's single mapping (src/app/api/internal/rag/run/route.ts): stale_index_drop = result.sourceRecheck.dropped. */
const traceStaleDrop = (result: RetrievalResult) => (result.sourceRecheck ? result.sourceRecheck.dropped : undefined);

let pg: ReturnType<typeof pgvectorStore>;

beforeEach(() => {
  uninstallDeps();
  resetBackendFactoryForTests();
  resetReadinessCacheForTests();
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  resetStaleRepairForTests();
  scheduledRepairs = 0;
  pg = pgvectorStore();
  setRetrievalBackendForTests(pg);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  uninstallDeps();
  resetBackendFactoryForTests();
  resetReadinessCacheForTests();
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  setStaleRepairDepsForTests(null);
  resetStaleRepairForTests();
  vi.restoreAllMocks();
});

describe('the Phase 6.3 recheck composed with the external re-validation (RET-14, D-46)', () => {
  it('qdrant with one stale id: one query, no 6.3 stage, stale_index_drop from the external marker', async () => {
    setStaleRepairDepsForTests({ schedule: () => void (scheduledRepairs += 1) });
    const qdrant = externalStore('qdrant', [STALE]);
    setExternalBackendForTests('qdrant', qdrant);
    const { result, rpc } = await retrieve({ RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_SOURCE_RECHECK: 'true' });
    expect(qdrant.calls).toBeGreaterThan(0);
    expect(pg.calls).toBe(0);
    expect(rpc.recheckCalls()).toBe(0);
    expect(stage(result, 'source_recheck')).toBeUndefined();
    expect(result.sourceRecheck?.dropped).toBe(1);
    expect(result.sourceRecheck?.checked).toBe(3 * qdrant.calls);
    expect(traceStaleDrop(result)).toBe(1 * qdrant.calls);
    expect(stage(result, 'search')?.attributes).toMatchObject({ backend: 'qdrant', stale_index_drop: result.sourceRecheck?.dropped });
    expect(stage(result, 'search')?.attributes?.tenant_validation_dropped).toBe(qdrant.calls);
    expect(scheduledRepairs).toBe(1);
  });

  it('qdrant with RAG_SOURCE_RECHECK=false: the recheck still happened (forced) and stale_index_drop is set', async () => {
    const qdrant = externalStore('qdrant', [STALE]);
    setExternalBackendForTests('qdrant', qdrant);
    const { result, rpc } = await retrieve({ RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_SOURCE_RECHECK: 'false' });
    expect(rpc.recheckCalls()).toBe(0);
    expect(stage(result, 'source_recheck')).toBeUndefined();
    expect(result.sourceRecheck).toBeDefined();
    expect(traceStaleDrop(result)).toBe(1);
    expect(stage(result, 'search')?.attributes).toMatchObject({ stale_index_drop: 1 });
  });

  it('weaviate on the voice profile is forced the same way', async () => {
    const weaviate = externalStore('weaviate', [STALE]);
    setExternalBackendForTests('weaviate', weaviate);
    const { result, rpc } = await retrieve({ RAG_RETRIEVAL_BACKEND_VOICE: 'weaviate', RAG_SOURCE_RECHECK: 'false' }, { profile: 'voice' });
    expect(weaviate.calls).toBeGreaterThan(0);
    expect(rpc.recheckCalls()).toBe(0);
    expect(stage(result, 'source_recheck')).toBeUndefined();
    expect(traceStaleDrop(result)).toBe(1);
  });

  it('fallback to pgvector (backend not ready) with the switch on: the 6.3 stage runs once and sets the marker', async () => {
    const qdrant = externalStore('qdrant', [STALE]);
    setExternalBackendForTests('qdrant', qdrant);
    const { result, rpc } = await retrieve({ RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_SOURCE_RECHECK: 'true' }, { readiness: 'stale' });
    expect(qdrant.calls).toBe(0);
    expect(pg.calls).toBeGreaterThan(0);
    expect(rpc.recheckCalls()).toBe(1);
    expect(stage(result, 'source_recheck')).toMatchObject({ status: 'ok', counts: { stale_index_drop: 1, checked: 3 } });
    expect(result.sourceRecheck).toEqual({ checked: 3, dropped: 1 });
    expect(traceStaleDrop(result)).toBe(1);
    expect(stage(result, 'search')?.attributes).not.toHaveProperty('stale_index_drop');
  });

  it('fallback to pgvector with the switch off: no stage and no marker', async () => {
    setExternalBackendForTests('qdrant', externalStore('qdrant', [STALE]));
    const { result, rpc } = await retrieve({ RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_SOURCE_RECHECK: 'false' }, { readiness: 'stale' });
    expect(rpc.recheckCalls()).toBe(0);
    expect(stage(result, 'source_recheck')).toBeUndefined();
    expect(result.sourceRecheck).toBeUndefined();
    expect(traceStaleDrop(result)).toBeUndefined();
  });

  it('pgvector with the switch on is unchanged from 06.3-07: one rag_source_recheck call', async () => {
    const { result, rpc } = await retrieve({ RAG_SOURCE_RECHECK: 'true' });
    expect(rpc.recheckCalls()).toBe(1);
    expect(stage(result, 'source_recheck')).toMatchObject({ counts: { stale_index_drop: 1, checked: 3 } });
    expect(result.candidates.map((item) => item.chunk_id)).not.toContain('pg-2');
    expect(traceStaleDrop(result)).toBe(1);
  });

  it('pgvector with the switch off: the stages and the result carry nothing from the recheck', async () => {
    const { result, rpc } = await retrieve({});
    expect(rpc.recheckCalls()).toBe(0);
    expect(stage(result, 'source_recheck')).toBeUndefined();
    expect(result.sourceRecheck).toBeUndefined();
    expect(stage(result, 'search')?.attributes).toEqual({ backend: 'pgvector', tenant_validation_dropped: 0 });
  });

  it('no path issues more than one recheck query per request', async () => {
    setExternalBackendForTests('qdrant', externalStore('qdrant', [STALE]));
    const cases: Array<[Record<string, string>, string]> = [
      [{ RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_SOURCE_RECHECK: 'true' }, 'ready'],
      [{ RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_SOURCE_RECHECK: 'true' }, 'stale'],
      [{ RAG_SOURCE_RECHECK: 'true' }, 'ready'],
    ];
    for (const [env, readiness] of cases) {
      resetReadinessCacheForTests();
      const { result, rpc } = await retrieve(env, { readiness });
      // The external re-validation shows as stale_index_drop on the search span; the 6.3 query as a rag_source_recheck call.
      const externalQueries = stage(result, 'search')?.attributes && 'stale_index_drop' in (stage(result, 'search')?.attributes ?? {}) ? 1 : 0;
      expect(rpc.recheckCalls() + externalQueries).toBe(1);
      expect(result.stages.filter((record) => record.name === 'source_recheck').length).toBeLessThanOrEqual(1);
    }
  });
});

describe('Phase 7 owns the external path (D-47)', () => {
  it('zero drops on an external backend: no 6.3 query, no 6.3 log line and no repair request', async () => {
    setStaleRepairDepsForTests({ schedule: () => void (scheduledRepairs += 1) });
    const qdrant = externalStore('qdrant', []);
    setExternalBackendForTests('qdrant', qdrant);
    const { result, rpc } = await retrieve({ RAG_RETRIEVAL_BACKEND: 'qdrant', RAG_SOURCE_RECHECK: 'true' });
    expect(qdrant.calls).toBeGreaterThan(0);
    expect(rpc.recheckCalls()).toBe(0);
    expect(rpc.calls.filter((fn) => fn !== 'rag_backend_readiness')).toEqual([]);
    expect(stage(result, 'source_recheck')).toBeUndefined();
    expect(result.sourceRecheck?.dropped).toBe(0);
    expect(traceStaleDrop(result)).toBe(0);
    expect(scheduledRepairs).toBe(0);
    const logged = [console.log, console.info, console.warn, console.error].flatMap((fn) => vi.mocked(fn).mock.calls.map((call) => String(call[0])));
    expect(logged.filter((line) => /Source recheck|\[RAG Security\]|\[Vector Sync\]/.test(line))).toEqual([]);
  });
});
