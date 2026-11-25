import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEMANTIC_CACHE_TIMEOUT_MS, getSemanticCache, withFailOpen } from '@/lib/rag/cache/index';
import type { SemanticCache } from '@/lib/rag/cache/types';
import { getRagDeps, resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { scopeKey } from '@/lib/rag/tenant/scope';
import { CONFIG, SCOPE_A, cacheQuery, cachedAnswer } from './fixtures';
import { fakeRpc } from './fake-rpc';

const SECRET_QUERY = 'confidential placeholder question text';

function backend(partial: Partial<SemanticCache>): SemanticCache {
  return {
    check: async () => null,
    store: async () => undefined,
    invalidateTenant: async () => 0,
    ...partial,
  };
}

function delayed<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return JSON.stringify(spy.mock.calls);
}

describe('withFailOpen', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes a hit through', async () => {
    const answer = cachedAnswer();
    const cache = withFailOpen(backend({ check: async () => ({ entryId: 'e1', distance: 0.01, answer }) }), 'pgvector');
    expect(await cache.check(cacheQuery())).toEqual({ entryId: 'e1', distance: 0.01, answer });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a backend taking 400 ms is a miss at the 150 ms deadline and aborts the backend signal', async () => {
    expect(SEMANTIC_CACHE_TIMEOUT_MS).toBe(150);
    let seen: AbortSignal | undefined;
    const cache = withFailOpen(
      backend({
        check: (q) => {
          seen = q.signal;
          return delayed(400, { entryId: 'late', distance: 0, answer: cachedAnswer() });
        },
      }),
      'redisvl',
    );
    const started = Date.now();
    expect(await cache.check(cacheQuery({ standalone: SECRET_QUERY }))).toBeNull();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(350);
    expect(seen?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[Semantic Cache\]/);
    expect(logged(warn)).toContain('timeout');
  });

  it('a thrown error is a miss, logged once with a hashed tenant key and never the query text', async () => {
    const cache = withFailOpen(backend({ check: async () => { throw new Error(`boom ${SECRET_QUERY}`); } }), 'pgvector');
    expect(await cache.check(cacheQuery({ standalone: SECRET_QUERY }))).toBeNull();
    const all = logged(warn) + logged(error);
    expect(warn.mock.calls.length + error.mock.calls.length).toBe(1);
    expect(all).toContain('[Semantic Cache]');
    expect(all).not.toContain(SECRET_QUERY);
    expect(all).not.toContain(scopeKey(SCOPE_A));
    expect(all).toMatch(/"tenant":"[0-9a-f]{12}"/);
  });

  it('an aborted request signal is a miss without calling the backend', async () => {
    const check = vi.fn(async () => null);
    const cache = withFailOpen(backend({ check }), 'pgvector');
    const controller = new AbortController();
    controller.abort();
    expect(await cache.check(cacheQuery({ signal: controller.signal }))).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it('an abort during the call is a miss', async () => {
    const controller = new AbortController();
    const cache = withFailOpen(backend({ check: () => delayed(100, null) }), 'pgvector');
    const pending = cache.check(cacheQuery({ signal: controller.signal }));
    controller.abort();
    expect(await pending).toBeNull();
  });

  it('store errors are swallowed and logged once; nothing logged carries the query text', async () => {
    const cache = withFailOpen(backend({ store: async () => { throw new Error(SECRET_QUERY); } }), 'redisvl');
    await expect(cache.store(cacheQuery({ standalone: SECRET_QUERY }), cachedAnswer())).resolves.toBeUndefined();
    expect(warn.mock.calls.length + error.mock.calls.length).toBe(1);
    expect(logged(warn) + logged(error)).not.toContain(SECRET_QUERY);
  });

  it('a slow store is dropped at the deadline', async () => {
    const cache = withFailOpen(backend({ store: () => delayed(400, undefined) }), 'redisvl');
    const started = Date.now();
    await cache.store(cacheQuery(), cachedAnswer());
    expect(Date.now() - started).toBeLessThan(350);
  });

  it('a failing invalidateTenant resolves to 0', async () => {
    const cache = withFailOpen(backend({ invalidateTenant: async () => { throw new Error('down'); } }), 'redisvl');
    expect(await cache.invalidateTenant(SCOPE_A)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a later rejection of a timed-out backend call is not unhandled', async () => {
    const cache = withFailOpen(
      backend({ check: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 200)) }),
      'pgvector',
    );
    expect(await cache.check(cacheQuery())).toBeNull();
    await delayed(100, null);
  });
});

describe('getSemanticCache', () => {
  const io = { adminClient: () => null, fetch: globalThis.fetch, sidecarUrl: 'http://sidecar.invalid', sidecarSecret: 'placeholder' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('off gives null', () => {
    expect(getSemanticCache({ ...CONFIG, backend: 'off' }, io)).toBeNull();
  });

  it('pgvector gives a fail-open cache over the admin client', async () => {
    const rpc = fakeRpc(() => ({ data: [{ hit: false, entry_id: null, distance: null, answer: null, is_refusal: null }], error: null }));
    const cache = getSemanticCache({ ...CONFIG, backend: 'pgvector' }, { ...io, adminClient: () => rpc.client });
    expect(cache).not.toBeNull();
    expect(await cache!.check(cacheQuery())).toBeNull();
    expect(rpc.calls[0]!.fn).toBe('rag_cache_check');
  });

  it('pgvector without an admin client is a miss, never an error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cache = getSemanticCache({ ...CONFIG, backend: 'pgvector' }, io);
    expect(await cache!.check(cacheQuery())).toBeNull();
  });

  it('redisvl gives a fail-open cache over the sidecar; a malformed response is a miss', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = (async () => new Response(JSON.stringify({ hit: 'yes' }), { status: 200 })) as typeof fetch;
    const cache = getSemanticCache({ ...CONFIG, backend: 'redisvl' }, { ...io, fetch: fetchImpl });
    expect(await cache!.check(cacheQuery())).toBeNull();
  });

  it('redisvl without the sidecar URL or secret gives null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(getSemanticCache({ ...CONFIG, backend: 'redisvl' }, { ...io, sidecarUrl: '' })).toBeNull();
    expect(getSemanticCache({ ...CONFIG, backend: 'redisvl' }, { ...io, sidecarSecret: ' ' })).toBeNull();
  });
});

describe('RagDeps.semanticCache', () => {
  afterEach(() => {
    resetRagDepsForTests();
  });

  it('RAG_SEMANTIC_CACHE=off gives null', () => {
    setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_SEMANTIC_CACHE: 'off' }) });
    expect(getRagDeps().semanticCache()).toBeNull();
  });

  it('RAG_SEMANTIC_CACHE=pgvector under v2 gives a cache', () => {
    setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_SEMANTIC_CACHE: 'pgvector' }) });
    expect(getRagDeps().semanticCache()).not.toBeNull();
  });

  it('setRagDepsForTests replaces it', () => {
    const fake = backend({});
    setRagDepsForTests({ semanticCache: () => fake });
    expect(getRagDeps().semanticCache()).toBe(fake);
  });
});
