import { describe, expect, it } from 'vitest';
import { createPgvectorSemanticCache } from '@/lib/rag/cache/pgvector';
import { computeCacheKeyHash } from '@/lib/rag/cache/keys';
import { scopeKey } from '@/lib/rag/tenant/scope';
import { CONFIG, DOC_1, SCOPE_A, SCOPE_B, cacheQuery, cachedAnswer } from './fixtures';
import { fakeRpc } from './fake-rpc';

const ENTRY = '00000000-0000-4000-8000-00000000e001';

function hitRow(answer: unknown, distance = 0.01) {
  return { data: [{ hit: true, entry_id: ENTRY, distance, answer, is_refusal: false }], error: null };
}

describe('pgvector semantic cache: check', () => {
  it('sends the scope key, key hash, profile, halfvec literal and the caller threshold, and returns the parsed hit', async () => {
    const answer = cachedAnswer();
    const { client, calls } = fakeRpc(() => hitRow(answer));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    const q = cacheQuery({ maxDistance: 0.03, vector: [0.5, -0.25, 0, 1] });
    const hit = await cache.check(q);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe('rag_cache_check');
    expect(calls[0]!.args).toEqual({
      p_tenant_key: scopeKey(SCOPE_A),
      p_key_hash: computeCacheKeyHash(q),
      p_profile: 'p1',
      p_embedding: '[0.5,-0.25,0,1]',
      p_max_distance: 0.03,
    });
    expect(hit).toEqual({ entryId: ENTRY, distance: 0.01, answer: expect.objectContaining({ answer_text: answer.answer_text }) });
  });

  it('uses the configured threshold when the caller passes none', async () => {
    const { client, calls } = fakeRpc(() => ({ data: [{ hit: false, entry_id: null, distance: null, answer: null, is_refusal: null }], error: null }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: { ...CONFIG, maxDistance: 0.04 } });
    expect(await cache.check(cacheQuery())).toBeNull();
    expect(calls[0]!.args.p_max_distance).toBe(0.04);
  });

  it('takes the tenant only from the scope: tenant B never sends tenant A\'s key', async () => {
    const { client, calls } = fakeRpc(() => ({ data: [{ hit: false, entry_id: null, distance: 0.3, answer: null, is_refusal: null }], error: null }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    await cache.check(cacheQuery({ scope: SCOPE_B }));
    expect(calls[0]!.args.p_tenant_key).toBe(scopeKey(SCOPE_B));
    expect(calls[0]!.args.p_tenant_key).not.toBe(scopeKey(SCOPE_A));
  });

  it('a stored answer that fails CachedAnswerSchema is a miss', async () => {
    const { client } = fakeRpc(() => hitRow({ answer_text: 'missing every other field' }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    expect(await cache.check(cacheQuery())).toBeNull();
  });

  it('an RPC error rejects so the wrapper can count it as a miss', async () => {
    const { client } = fakeRpc(() => ({ data: null, error: { message: 'boom', code: '22023' } }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    await expect(cache.check(cacheQuery())).rejects.toThrow();
  });

  it('passes the request signal to the RPC', async () => {
    const { client, calls } = fakeRpc(() => ({ data: [], error: null }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    const controller = new AbortController();
    await cache.check(cacheQuery({ signal: controller.signal }));
    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it('rejects a vector with a non-finite value without calling the database', async () => {
    const { client, calls } = fakeRpc(() => ({ data: [], error: null }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    await expect(cache.check(cacheQuery({ vector: [1, Number.NaN] }))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('pgvector semantic cache: store', () => {
  it('masks the query text, sends the sources and uses the normal TTL for an answer', async () => {
    const { client, calls } = fakeRpc(() => ({ data: ENTRY, error: null }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    const answer = cachedAnswer({ source_versions: [{ document_id: DOC_1, version: 2 }] });
    await cache.store(cacheQuery({ standalone: 'send the summary to someone@example.com please' }), answer);

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(calls[0]!.fn).toBe('rag_cache_store');
    expect(args.p_tenant_key).toBe(scopeKey(SCOPE_A));
    expect(args.p_query_text_masked).toBe('send the summary to [EMAIL] please');
    expect(String(args.p_query_text_masked)).not.toContain('@');
    expect(args.p_source_versions).toEqual([{ document_id: DOC_1, version: 2 }]);
    expect(args.p_is_refusal).toBe(false);
    expect(args.p_ttl_seconds).toBe(3600);
    expect(args.p_embedding).toBe('[1,0,0,0]');
    expect(args.p_answer).toEqual(expect.objectContaining({ answer_text: answer.answer_text }));
  });

  it('uses the refusal TTL for a refusal and sends an empty source list', async () => {
    const { client, calls } = fakeRpc(() => ({ data: ENTRY, error: null }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    await cache.store(cacheQuery(), cachedAnswer({ is_refusal: true }));
    expect(calls[0]!.args.p_is_refusal).toBe(true);
    expect(calls[0]!.args.p_ttl_seconds).toBe(600);
    expect(calls[0]!.args.p_source_versions).toEqual([]);
  });

  it('refuses an answer that fails CachedAnswerSchema without calling the database', async () => {
    const { client, calls } = fakeRpc(() => ({ data: ENTRY, error: null }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    await expect(cache.store(cacheQuery(), { answer_text: '' } as never)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('rejects when the database refuses the entry', async () => {
    const { client } = fakeRpc(() => ({ data: null, error: { message: 'cache_sources_not_current', code: 'P0001' } }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    await expect(cache.store(cacheQuery(), cachedAnswer())).rejects.toThrow();
  });
});

describe('pgvector semantic cache: invalidateTenant', () => {
  it('sends only the scope key and the document ids, and returns the count', async () => {
    const { client, calls } = fakeRpc(() => ({ data: 3, error: null }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    expect(await cache.invalidateTenant(SCOPE_A, [DOC_1])).toBe(3);
    expect(calls[0]).toMatchObject({ fn: 'rag_cache_invalidate', args: { p_tenant_key: scopeKey(SCOPE_A), p_document_ids: [DOC_1] } });
  });

  it('sends null document ids for a whole-tenant invalidation', async () => {
    const { client, calls } = fakeRpc(() => ({ data: 0, error: null }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG });
    expect(await cache.invalidateTenant(SCOPE_B)).toBe(0);
    expect(calls[0]!.args).toEqual({ p_tenant_key: scopeKey(SCOPE_B), p_document_ids: null });
  });

  it('rejects without an admin client', async () => {
    const cache = createPgvectorSemanticCache({ adminClient: () => null, config: CONFIG });
    await expect(cache.invalidateTenant(SCOPE_A)).rejects.toThrow();
  });
});
