import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendNotReadyError } from '@/lib/rag/backend/external';
import {
  EXTERNAL_SEARCH_TIMEOUT_MS,
  resetBackendFactoryForTests,
  resolveRetrievalBackend,
  setExternalBackendForTests,
} from '@/lib/rag/backend/factory';
import { resetReadinessCacheForTests } from '@/lib/rag/backend/readiness';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { RetrievalBackendError, type RpcClient, type RpcRequest, type RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Profile } from '@/lib/rag/types';
import { hit } from '../fusion/helpers';

const scope = mintScope('single', null, null);
const PROFILE_ID = 'profile-neutral';

function cfg(env: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', ...env });
}

function request(signal: AbortSignal = new AbortController().signal, extra: Partial<BackendSearchRequest> = {}): BackendSearchRequest {
  return {
    scope,
    embeddingProfileId: PROFILE_ID,
    denseVector: [0.1, 0.2],
    lexicalTokens: ['token'],
    lexicalLanguages: null,
    access: { mode: 'off' },
    filters: { currentOnly: true },
    denseLimit: 5,
    lexicalLimit: 5,
    signal,
    ...extra,
  };
}

function legs(prefix: string, dropped?: number): BackendLegs {
  return {
    dense: [hit(`${prefix}-1`, { similarity: 0.9 })],
    lexical: [],
    ...(dropped !== undefined ? { meta: { denseMode: null, tenantValidationDropped: dropped } } : {}),
  };
}

type Behaviour = { kind: 'ok'; delayMs?: number; dropped?: number } | { kind: 'throw'; error: unknown; delayMs?: number } | { kind: 'hang' };

interface FakeBackend extends RetrievalBackend {
  calls: BackendSearchRequest[];
  aborted: number;
}

function fakeBackend(id: RetrievalBackend['id'], behaviour: () => Behaviour): FakeBackend {
  const backend: FakeBackend = {
    id,
    calls: [],
    aborted: 0,
    search(req) {
      backend.calls.push(req);
      const plan = behaviour();
      return new Promise<BackendLegs>((resolve, reject) => {
        req.signal.addEventListener(
          'abort',
          () => {
            backend.aborted += 1;
            reject(req.signal.reason ?? new Error('aborted'));
          },
          { once: true },
        );
        if (plan.kind === 'hang') return;
        const settle = () => (plan.kind === 'ok' ? resolve(legs(id, plan.dropped)) : reject(plan.error));
        if (plan.delayMs === undefined) settle();
        else setTimeout(settle, plan.delayMs);
      });
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  return backend;
}

function readinessRpc(state: string | null = 'ready'): { client: RpcClient; calls: string[] } {
  const calls: string[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push(`${fn}:${String(args.p_target)}`);
      const answer: RpcResponse = { data: [{ state, lag_seconds: 0, outbox_lag_seconds: 0 }], error: null };
      const req: RpcRequest = { abortSignal: () => req, then: (ok, bad) => Promise.resolve(answer).then(ok, bad) };
      return req;
    },
  };
  return { client, calls };
}

let pg: FakeBackend;

beforeEach(() => {
  resetBackendFactoryForTests();
  resetReadinessCacheForTests();
  resetRetrievalBackendForTests();
  pg = fakeBackend('pgvector', () => ({ kind: 'ok' }));
  setRetrievalBackendForTests(pg);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  resetBackendFactoryForTests();
  resetReadinessCacheForTests();
  resetRetrievalBackendForTests();
  resetRagConfigForTests();
  vi.restoreAllMocks();
});

describe('resolveRetrievalBackend', () => {
  it('defaults: every entry point gets the pgvector backend object and no readiness read', async () => {
    const config = cfg();
    const rpc = readinessRpc();
    for (const profile of ['chat', 'embed', 'voice', 'eval'] as Profile[]) {
      const resolved = resolveRetrievalBackend(profile, config, undefined, { readinessRpc: rpc.client });
      expect(resolved.backend).toBe(pg);
      await resolved.backend.search(request());
      expect(resolved.selection()).toEqual({ backend: 'pgvector', fallbackReason: null, tenantValidationDropped: 0, degraded: false });
    }
    expect(rpc.calls).toEqual([]);
  });

  it('routes chat to the default backend and voice to the voice backend', async () => {
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    const qdrant = fakeBackend('qdrant', () => ({ kind: 'ok' }));
    setExternalBackendForTests('qdrant', qdrant);
    const rpc = readinessRpc();
    const chat = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: rpc.client });
    expect(chat.choice).toBe('qdrant');
    const legsOut = await chat.backend.search(request());
    expect(legsOut.dense[0]?.chunkId).toBe('qdrant-1');
    expect(chat.selection()).toEqual({ backend: 'qdrant', fallbackReason: null, tenantValidationDropped: 0, degraded: false });
    const voice = resolveRetrievalBackend('voice', config, undefined, { readinessRpc: rpc.client });
    expect(voice.backend).toBe(pg);
    expect(rpc.calls).toEqual(['rag_backend_readiness:qdrant']);
  });

  it('honours the eval backend override for the eval profile only', async () => {
    const config = cfg();
    const weaviate = fakeBackend('weaviate', () => ({ kind: 'ok' }));
    setExternalBackendForTests('weaviate', weaviate);
    const rpc = readinessRpc();
    const evalRun = resolveRetrievalBackend('eval', config, { backend: 'weaviate' }, { readinessRpc: rpc.client });
    expect(evalRun.choice).toBe('weaviate');
    await evalRun.backend.search(request());
    expect(weaviate.calls).toHaveLength(1);
    const chat = resolveRetrievalBackend('chat', config, { backend: 'weaviate' }, { readinessRpc: rpc.client });
    expect(chat.backend).toBe(pg);
  });

  it('not ready: pgvector serves, degraded backend_not_ready, the external search is never called', async () => {
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    const qdrant = fakeBackend('qdrant', () => ({ kind: 'ok' }));
    setExternalBackendForTests('qdrant', qdrant);
    const resolved = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: readinessRpc('building').client });
    const out = await resolved.backend.search(request());
    expect(out.dense[0]?.chunkId).toBe('pgvector-1');
    expect(qdrant.calls).toHaveLength(0);
    expect(resolved.selection()).toEqual({ backend: 'pgvector', fallbackReason: 'backend_not_ready', tenantValidationDropped: 0, degraded: true });
  });

  it('an external error falls back to pgvector with backend_error', async () => {
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    setExternalBackendForTests('qdrant', fakeBackend('qdrant', () => ({ kind: 'throw', error: new Error('vendor down') })));
    const resolved = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: readinessRpc().client });
    const out = await resolved.backend.search(request());
    expect(out.dense[0]?.chunkId).toBe('pgvector-1');
    expect(resolved.selection()).toMatchObject({ backend: 'pgvector', fallbackReason: 'backend_error', degraded: true });
  });

  it('a hanging external search is aborted at 800 ms for chat and pgvector serves with backend_error', async () => {
    vi.useFakeTimers();
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    const qdrant = fakeBackend('qdrant', () => ({ kind: 'hang' }));
    setExternalBackendForTests('qdrant', qdrant);
    pg = fakeBackend('pgvector', () => ({ kind: 'ok', delayMs: 600 }));
    setRetrievalBackendForTests(pg);
    const resolved = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: readinessRpc().client });
    const pending = resolved.backend.search(request());
    await vi.advanceTimersByTimeAsync(EXTERNAL_SEARCH_TIMEOUT_MS - 1);
    expect(qdrant.aborted).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(qdrant.aborted).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    const out = await pending;
    expect(out.dense[0]?.chunkId).toBe('pgvector-1');
    expect(resolved.selection()).toMatchObject({ backend: 'pgvector', fallbackReason: 'backend_error', degraded: true });
    expect(EXTERNAL_SEARCH_TIMEOUT_MS).toBe(800);
  });

  it('eval has no external timeout and no race', async () => {
    vi.useFakeTimers();
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    const qdrant = fakeBackend('qdrant', () => ({ kind: 'ok', delayMs: 5_000 }));
    setExternalBackendForTests('qdrant', qdrant);
    const resolved = resolveRetrievalBackend('eval', config, undefined, { readinessRpc: readinessRpc().client });
    const pending = resolved.backend.search(request());
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await pending;
    expect(out.dense[0]?.chunkId).toBe('qdrant-1');
    expect(pg.calls).toHaveLength(0);
    expect(qdrant.aborted).toBe(0);
    expect(resolved.selection()).toMatchObject({ backend: 'qdrant', fallbackReason: null, degraded: false });
  });

  it('race: past the budget pgvector starts, and a faster pgvector wins with backend_slow', async () => {
    vi.useFakeTimers();
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    const qdrant = fakeBackend('qdrant', () => ({ kind: 'ok', delayMs: 700 }));
    setExternalBackendForTests('qdrant', qdrant);
    pg = fakeBackend('pgvector', () => ({ kind: 'ok', delayMs: 100 }));
    setRetrievalBackendForTests(pg);
    const resolved = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: readinessRpc().client, searchBudgetMs: 400 });
    const pending = resolved.backend.search(request());
    await vi.advanceTimersByTimeAsync(399);
    expect(pg.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(101);
    const out = await pending;
    expect(out.dense[0]?.chunkId).toBe('pgvector-1');
    expect(qdrant.aborted).toBe(1);
    expect(resolved.selection()).toMatchObject({ backend: 'pgvector', fallbackReason: 'backend_slow', degraded: true });
  });

  it('race: an external answer after the budget but before pgvector wins and is not degraded', async () => {
    vi.useFakeTimers();
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    const qdrant = fakeBackend('qdrant', () => ({ kind: 'ok', delayMs: 450 }));
    setExternalBackendForTests('qdrant', qdrant);
    pg = fakeBackend('pgvector', () => ({ kind: 'ok', delayMs: 200 }));
    setRetrievalBackendForTests(pg);
    const resolved = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: readinessRpc().client, searchBudgetMs: 400 });
    const pending = resolved.backend.search(request());
    await vi.advanceTimersByTimeAsync(450);
    const out = await pending;
    expect(out.dense[0]?.chunkId).toBe('qdrant-1');
    expect(pg.calls).toHaveLength(1);
    expect(pg.aborted).toBe(1);
    expect(resolved.selection()).toMatchObject({ backend: 'qdrant', fallbackReason: null, degraded: false });
  });

  it('filter_unsupported routes to pgvector without degrading', async () => {
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    setExternalBackendForTests(
      'qdrant',
      fakeBackend('qdrant', () => ({ kind: 'throw', error: new RetrievalBackendError('qdrant.search', 'filter_unsupported') })),
    );
    const resolved = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: readinessRpc().client });
    const out = await resolved.backend.search(request(undefined, { filters: { currentOnly: true, invoice: { supplier: 'neutral' } } }));
    expect(out.dense[0]?.chunkId).toBe('pgvector-1');
    expect(resolved.selection()).toEqual({ backend: 'pgvector', fallbackReason: 'filter_unsupported', tenantValidationDropped: 0, degraded: false });
  });

  it('BackendNotReadyError from the adapter counts as backend_not_ready', async () => {
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'weaviate' });
    setExternalBackendForTests(
      'weaviate',
      fakeBackend('weaviate', () => ({ kind: 'throw', error: new BackendNotReadyError('weaviate', 'tenant_missing') })),
    );
    const resolved = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: readinessRpc().client });
    await resolved.backend.search(request());
    expect(resolved.selection()).toMatchObject({ backend: 'pgvector', fallbackReason: 'backend_not_ready', degraded: true });
  });

  it('sums tenant_validation_dropped over the external calls of a request', async () => {
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    setExternalBackendForTests('qdrant', fakeBackend('qdrant', () => ({ kind: 'ok', dropped: 2 })));
    const resolved = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: readinessRpc().client });
    await Promise.all([resolved.backend.search(request()), resolved.backend.search(request())]);
    expect(resolved.selection()).toEqual({ backend: 'qdrant', fallbackReason: null, tenantValidationDropped: 4, degraded: false });
  });

  it('a request abort is not a fallback', async () => {
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    setExternalBackendForTests('qdrant', fakeBackend('qdrant', () => ({ kind: 'hang' })));
    const resolved = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: readinessRpc().client });
    const controller = new AbortController();
    const pending = resolved.backend.search(request(controller.signal));
    await Promise.resolve();
    controller.abort(new Error('client gone'));
    await expect(pending).rejects.toThrow();
    expect(pg.calls).toHaveLength(0);
    expect(resolved.selection().fallbackReason).toBeNull();
  });

  it('an external backend that cannot be built falls back with backend_error', async () => {
    const config = cfg({ RAG_RETRIEVAL_BACKEND: 'qdrant' });
    setExternalBackendForTests('qdrant', () => {
      throw new Error('[RAG Config] QDRANT_URL is not set');
    });
    const resolved = resolveRetrievalBackend('chat', config, undefined, { readinessRpc: readinessRpc().client });
    const out = await resolved.backend.search(request());
    expect(out.dense[0]?.chunkId).toBe('pgvector-1');
    expect(resolved.selection()).toMatchObject({ fallbackReason: 'backend_error', degraded: true });
  });
});

describe('legacy pipeline', () => {
  it('ignores a non-pgvector RAG_RETRIEVAL_BACKEND, warns once across two requests, and never reaches the external backend', async () => {
    const { runRetrieval } = await import('@/lib/rag');
    const { fakeEmbedder, fakeRpcClient, installDeps, rows, uninstallDeps, SEMANTIC_QUERY } = await import('../helpers/pipeline-fakes');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetRetrievalBackendForTests();
    const qdrant = fakeBackend('qdrant', () => ({ kind: 'ok' }));
    setExternalBackendForTests('qdrant', qdrant);
    const rpc = fakeRpcClient({ rows: rows(3) });
    installDeps({
      embedder: fakeEmbedder().embedder,
      ragEnv: () => ({ RAG_PIPELINE: 'legacy', RAG_RETRIEVAL_BACKEND: 'qdrant' }),
      searchRpc: rpc.client,
    });
    try {
      for (let index = 0; index < 2; index += 1) {
        await runRetrieval({ scope, query: SEMANTIC_QUERY, profile: 'chat', signal: new AbortController().signal });
      }
    } finally {
      uninstallDeps();
    }
    const backendWarnings = warn.mock.calls.filter(
      ([first]) => String(first).includes('[RAG Config]') && String(first).includes('RAG_RETRIEVAL_BACKEND'),
    );
    expect(backendWarnings).toHaveLength(1);
    expect(qdrant.calls).toHaveLength(0);
    expect(rpc.calls.map((call) => call.fn)).not.toContain('rag_backend_readiness');
  });
});
