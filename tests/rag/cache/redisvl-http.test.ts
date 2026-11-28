import { describe, expect, it } from 'vitest';
import { createRedisvlSemanticCache } from '@/lib/rag/cache/redisvl-http';
import { computeCacheKeyHash } from '@/lib/rag/cache/keys';
import { scopeKey } from '@/lib/rag/tenant/scope';
import { CONFIG, DOC_1, SCOPE_A, SCOPE_B, cacheQuery, cachedAnswer } from './fixtures';
import { fakeRpc } from './fake-rpc';

const SECRET = 'placeholder-sidecar-secret';
const URL_BASE = 'http://sidecar.invalid/';
const ENTRY = 'entry-placeholder-1';

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | null;
}

function fakeFetch(respond: (path: string, body: Record<string, unknown>) => { status?: number; json: unknown }): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body, signal: init?.signal ?? null });
    const reply = respond(new URL(url).pathname, body);
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const MISS = { hit: false, entry_id: null, distance: 0.4, answer: null };

function hitBody(answer: unknown = cachedAnswer(), distance = 0.02) {
  return { hit: true, entry_id: ENTRY, distance, answer };
}

function sourcesCurrent(current: boolean) {
  return fakeRpc(() => ({ data: current, error: null }));
}

function build(fetchImpl: typeof fetch, current = true) {
  const rpc = sourcesCurrent(current);
  const cache = createRedisvlSemanticCache({
    url: URL_BASE,
    secret: SECRET,
    fetch: fetchImpl,
    adminClient: () => rpc.client,
    config: CONFIG,
  });
  return { cache, rpcCalls: rpc.calls };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RedisVL HTTP backend: check', () => {
  it('posts a CacheCheckRequest with the secret header and returns the parsed hit after the sources check', async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: hitBody(cachedAnswer({ source_versions: [{ document_id: DOC_1, version: 3 }] })) }));
    const { cache, rpcCalls } = build(fetch);
    const q = cacheQuery({ maxDistance: 0.04 });
    const hit = await cache.check(q);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://sidecar.invalid/v1/cache/check');
    expect(calls[0]!.headers['x-sidecar-secret']).toBe(SECRET);
    expect(calls[0]!.body).toEqual({
      tenant_key: scopeKey(SCOPE_A),
      key_hash: computeCacheKeyHash(q),
      embedding_profile_id: 'p1',
      max_distance: 0.04,
      vector: [1, 0, 0, 0],
    });
    expect(calls[0]!.body).not.toHaveProperty('query_text_masked');
    expect(hit).toMatchObject({ entryId: ENTRY, distance: 0.02 });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({
      fn: 'rag_cache_sources_current',
      args: { p_tenant_key: scopeKey(SCOPE_A), p_source_versions: [{ document_id: DOC_1, version: 3 }] },
    });
  });

  it('a miss makes no sources check', async () => {
    const { fetch } = fakeFetch(() => ({ json: MISS }));
    const { cache, rpcCalls } = build(fetch);
    expect(await cache.check(cacheQuery())).toBeNull();
    expect(rpcCalls).toHaveLength(0);
  });

  it('a response failing CacheCheckResponseSchema rejects (the wrapper serves a miss)', async () => {
    const { fetch } = fakeFetch(() => ({ json: { hit: true, entry_id: ENTRY, distance: 0.01, answer: { answer_text: 'bad' } } }));
    const { cache } = build(fetch);
    await expect(cache.check(cacheQuery())).rejects.toThrow();
  });

  it('a non-2xx response rejects', async () => {
    const { fetch } = fakeFetch(() => ({ status: 503, json: { error: 'cache unavailable' } }));
    const { cache } = build(fetch);
    await expect(cache.check(cacheQuery())).rejects.toThrow();
  });

  it('a hit whose sources are no longer current is a miss and triggers one invalidate call', async () => {
    const { fetch, calls } = fakeFetch((path) =>
      path === '/v1/cache/check'
        ? { json: hitBody(cachedAnswer({ source_versions: [{ document_id: DOC_1, version: 1 }] })) }
        : { json: { deleted: 1 } },
    );
    const { cache } = build(fetch, false);
    expect(await cache.check(cacheQuery())).toBeNull();
    await flush();
    const invalidations = calls.filter((call) => call.url.endsWith('/v1/cache/invalidate'));
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]!.body).toEqual({ tenant_key: scopeKey(SCOPE_A), document_ids: [DOC_1] });
    expect(invalidations[0]!.headers['x-sidecar-secret']).toBe(SECRET);
  });

  it('a hit cannot be verified without the admin client, so it is not served', async () => {
    const { fetch } = fakeFetch(() => ({ json: hitBody() }));
    const cache = createRedisvlSemanticCache({ url: URL_BASE, secret: SECRET, fetch, adminClient: () => null, config: CONFIG });
    await expect(cache.check(cacheQuery())).rejects.toThrow();
  });

  it('a recorded check response whose answer is a refusal is a miss', async () => {
    const { fetch } = fakeFetch(() => ({ json: hitBody(cachedAnswer({ is_refusal: true })) }));
    const { cache, rpcCalls } = build(fetch);
    expect(await cache.check(cacheQuery())).toBeNull();
    expect(rpcCalls).toHaveLength(0);
  });

  it('a hit beyond the requested distance is a miss', async () => {
    const { fetch } = fakeFetch(() => ({ json: hitBody(cachedAnswer(), 0.09) }));
    const { cache } = build(fetch);
    expect(await cache.check(cacheQuery({ maxDistance: 0.05 }))).toBeNull();
  });

  it('two tenants: B posts its own scope key and never A\'s, even with the same text, vector and key hash', async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: MISS }));
    const { cache } = build(fetch);
    await cache.check(cacheQuery({ scope: SCOPE_A }));
    await cache.check(cacheQuery({ scope: SCOPE_B }));
    expect(calls[0]!.body.tenant_key).toBe(scopeKey(SCOPE_A));
    expect(calls[1]!.body.tenant_key).toBe(scopeKey(SCOPE_B));
    expect(calls[1]!.body.key_hash).toBe(calls[0]!.body.key_hash);
    expect(JSON.stringify(calls[1]!.body)).not.toContain(scopeKey(SCOPE_A));
  });

  it('passes a signal to fetch', async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: MISS }));
    const { cache } = build(fetch);
    const controller = new AbortController();
    await cache.check(cacheQuery({ signal: controller.signal }));
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(calls[0]!.signal!.aborted).toBe(true);
  });
});

describe('RedisVL HTTP backend: store', () => {
  it('posts a non-refusal answer with masked text, the TTL and the secret header', async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { stored: true } }));
    const { cache } = build(fetch);
    const q = cacheQuery({ standalone: 'mail the outline to someone@example.com' });
    await cache.store(q, cachedAnswer({ source_versions: [{ document_id: DOC_1, version: 1 }] }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://sidecar.invalid/v1/cache/store');
    expect(calls[0]!.headers['x-sidecar-secret']).toBe(SECRET);
    expect(calls[0]!.body).toMatchObject({
      tenant_key: scopeKey(SCOPE_A),
      key_hash: computeCacheKeyHash(q),
      embedding_profile_id: 'p1',
      query_text_masked: 'mail the outline to [EMAIL]',
      ttl_seconds: 3600,
      vector: [1, 0, 0, 0],
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain('someone@example.com');
  });

  it('an is_refusal answer makes no fetch call', async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: {} }));
    const { cache } = build(fetch);
    await cache.store(cacheQuery(), cachedAnswer({ is_refusal: true }));
    expect(calls).toHaveLength(0);
  });

  it('a non-2xx store rejects', async () => {
    const { fetch } = fakeFetch(() => ({ status: 422, json: { error: 'refused' } }));
    const { cache } = build(fetch);
    await expect(cache.store(cacheQuery(), cachedAnswer())).rejects.toThrow();
  });
});

describe('RedisVL HTTP backend: invalidateTenant', () => {
  it('posts only the given tenant key and returns the deleted count', async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { deleted: 4 } }));
    const { cache } = build(fetch);
    expect(await cache.invalidateTenant(SCOPE_A)).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ tenant_key: scopeKey(SCOPE_A), document_ids: null });
    expect(JSON.stringify(calls[0]!.body)).not.toContain(scopeKey(SCOPE_B));
  });

  it('sends the document ids when given', async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { deleted: 0 } }));
    const { cache } = build(fetch);
    await cache.invalidateTenant(SCOPE_B, [DOC_1]);
    expect(calls[0]!.body).toEqual({ tenant_key: scopeKey(SCOPE_B), document_ids: [DOC_1] });
  });

  it('a malformed response rejects', async () => {
    const { fetch } = fakeFetch(() => ({ json: { deleted: -1 } }));
    const { cache } = build(fetch);
    await expect(cache.invalidateTenant(SCOPE_A)).rejects.toThrow();
  });
});
