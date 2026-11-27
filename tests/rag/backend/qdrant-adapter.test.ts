import { describe, expect, it, vi } from 'vitest';
import { BackendNotReadyError } from '@/lib/rag/backend/external';
import {
  QDRANT_FILTER_SUPPORT,
  createQdrantBackend,
  qdrantFilterConditions,
  searchQdrantLegs,
} from '@/lib/rag/backend/qdrant/adapter';
import { qdrantCollectionSpec } from '@/lib/rag/backend/qdrant/collection';
import { assertScoped } from '@/lib/rag/backend/qdrant/scoped-request';
import { RetrievalBackendError, type RpcClient, type RpcRequest } from '@/lib/rag/backend/supabase-rpc';
import { qdrantCollectionName } from '@/lib/rag/backend/tenant-key';
import type { BackendSearchRequest, RetrievalFilters } from '@/lib/rag/backend/types';
import { qdrantPayload } from '@/lib/rag/sync/stores/qdrant';
import type { StoreSearchRequest, VectorPointPayload } from '@/lib/rag/sync/stores/types';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';
import { createFakeQdrantClient, scopedBodyOf, type FakeQdrantClient } from './qdrant-fake-client';

const PROFILE = 'neutral-profile-3';
const COLLECTION = qdrantCollectionName(PROFILE);
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const scopeA = mintScope('personal', USER_A, null);
const scopeB = mintScope('personal', USER_B, null);
const CANARY_VECTOR = [0.3, 0.4, 0.5];
const CANARY_TEXT = 'shared canary token words';

function pid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const A_IDS = [pid(1), pid(2)];
const B_IDS = [pid(11), pid(12), pid(13)];

function payload(tenantKey: string, n: number): VectorPointPayload {
  return {
    tenant_key: tenantKey,
    document_id: pid(100 + n),
    doc_type: 'general',
    doc_date: '2025-03-01',
    language: 'en',
    source: 'upload',
    chunking_profile_id: null,
    parent_id: null,
    lexical_text: CANARY_TEXT,
    content_hash: null,
    lexical_version: 1,
  };
}

async function twoTenantClient(): Promise<FakeQdrantClient> {
  const client = createFakeQdrantClient();
  await client.createCollection(COLLECTION, qdrantCollectionSpec({ profileId: PROFILE, dims: 3 }));
  client.seed(COLLECTION, [
    ...A_IDS.map((id, i) => ({ id, vector: { dense: CANARY_VECTOR }, payload: qdrantPayload(payload(`u:${USER_A}`, i)) })),
    ...B_IDS.map((id, i) => ({ id, vector: { dense: CANARY_VECTOR }, payload: qdrantPayload(payload(`u:${USER_B}`, 10 + i)) })),
  ]);
  client.requests.length = 0;
  return client;
}

function storeRequest(scope: TenantScope, over: Partial<StoreSearchRequest> = {}): StoreSearchRequest {
  return {
    scope,
    profileId: PROFILE,
    denseVector: [...CANARY_VECTOR],
    lexicalTokens: ['canary', 'token'],
    denseLimit: 10,
    lexicalLimit: 10,
    filters: { currentOnly: true },
    signal: new AbortController().signal,
    ...over,
  };
}

function backendRequest(scope: TenantScope, over: Partial<BackendSearchRequest> = {}): BackendSearchRequest {
  return {
    scope,
    embeddingProfileId: PROFILE,
    denseVector: [...CANARY_VECTOR],
    lexicalTokens: ['canary', 'token'],
    lexicalLanguages: null,
    filters: { currentOnly: true },
    denseLimit: 10,
    lexicalLimit: 10,
    signal: new AbortController().signal,
    ...over,
  };
}

/** rag_validate_chunks as the database answers it: only the caller tenant's ids come back, hydrated. */
function validatingAdmin(owner: Map<string, string>): { client: RpcClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>): RpcRequest {
      const request: RpcRequest = {
        abortSignal() {
          return request;
        },
        then(onFulfilled, onRejected) {
          calls.push({ fn, ...args });
          const ids = (args.p_ids as string[]) ?? [];
          const data = ids
            .filter((id) => owner.get(id) === args.p_tenant_key)
            .map((id) => ({
              chunk_id: id,
              document_id: pid(500),
              content: 'hydrated neutral body',
              metadata: {},
              chunk_index: 0,
              doc_type: 'general',
              language: 'en',
              parent_id: null,
              section_path: [],
              chunk_kind: 'text',
              document_filename: 'neutral.md',
              document_created_at: '2025-01-01T00:00:00Z',
              document_metadata: {},
              document_content_preview: 'preview',
            }));
          return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

function owners(): Map<string, string> {
  return new Map([...A_IDS.map((id) => [id, `u:${USER_A}`] as const), ...B_IDS.map((id) => [id, `u:${USER_B}`] as const)]);
}

describe('qdrant adapter requests', () => {
  it('sends one queryBatch with a dense and a BM25 text search, both passing assertScoped', async () => {
    const client = await twoTenantClient();
    await searchQdrantLegs(client, storeRequest(scopeA, { filters: { currentOnly: true, languages: ['en'] } }));
    expect(client.requests.map((r) => r.method)).toEqual(['queryBatch']);
    const request = client.requests[0];
    expect(request.collection).toBe(COLLECTION);
    expect(() => assertScoped(scopedBodyOf(request), scopeA)).not.toThrow();
    expect(() => assertScoped(scopedBodyOf(request), scopeB)).toThrow(/tenant clause/);
    type Search = { params: { idf: { corpus: { must: unknown[] } } }; filter: { must: unknown[] } };
    const [dense, lexical] = request.body.searches as Search[];
    expect(dense).toMatchObject({ query: CANARY_VECTOR, using: 'dense', limit: 10, params: { acorn: { enable: true } }, with_payload: false });
    expect(lexical).toMatchObject({ query: { text: 'canary token' }, using: 'lexical_text', limit: 10, with_payload: false });
    expect(lexical.params.idf.corpus.must).toEqual([{ key: 'tenant_key', match: { value: `u:${USER_A}` } }]);
    for (const search of [dense, lexical]) {
      expect(search.filter.must).toEqual([
        { key: 'tenant_key', match: { value: `u:${USER_A}` } },
        { key: 'language', match: { any: ['en'] } },
      ]);
    }
  });

  it('an empty or stopword-free token list sends only the dense search; nothing to search sends nothing', async () => {
    const client = await twoTenantClient();
    const legs = await searchQdrantLegs(client, storeRequest(scopeA, { lexicalTokens: ['', ''] }));
    expect(legs.lexical).toEqual([]);
    expect((client.requests[0].body.searches as unknown[]).length).toBe(1);
    expect((client.requests[0].body.searches as Array<{ using: string }>)[0].using).toBe('dense');
    client.requests.length = 0;
    expect(await searchQdrantLegs(client, storeRequest(scopeA, { lexicalTokens: [], denseVector: null }))).toEqual({ dense: [], lexical: [] });
    expect(client.requests).toEqual([]);
  });

  it('maps every filter key to a native pre-filter; empty arrays add nothing', () => {
    expect(qdrantFilterConditions({ currentOnly: true, sources: [], documentIds: [], docTypes: [], languages: [] })).toEqual([]);
    expect(
      qdrantFilterConditions({
        currentOnly: true,
        sources: ['upload'],
        documentIds: [pid(100)],
        docTypes: ['general'],
        languages: ['en', 'it'],
        dateRange: { from: '2025-01-01', to: '2025-12-31' },
      }),
    ).toEqual([
      { key: 'source', match: { any: ['upload'] } },
      { key: 'document_id', match: { any: [pid(100)] } },
      { key: 'doc_type', match: { any: ['general'] } },
      { key: 'language', match: { any: ['en', 'it'] } },
      { key: 'doc_date', range: { gte: '2025-01-01', lte: '2025-12-31' } },
    ]);
    expect(qdrantFilterConditions({ currentOnly: true, dateRange: { to: '2025-12-31', includeUndated: true } })).toEqual([
      { should: [{ key: 'doc_date', range: { lte: '2025-12-31' } }, { is_empty: { key: 'doc_date' } }] },
    ]);
    expect(qdrantFilterConditions({ currentOnly: true, dateRange: {} })).toEqual([]);
  });

  it('the support table covers exactly the RetrievalFilters keys', () => {
    const keys: Array<keyof RetrievalFilters> = [
      'currentOnly',
      'dateRange',
      'sources',
      'documentIds',
      'docTypes',
      'languages',
      'invoice',
      'scopes',
      'scopesIncludeUntagged',
      'effectiveOn',
    ];
    expect(Object.keys(QDRANT_FILTER_SUPPORT).sort()).toEqual([...keys].sort());
    expect(() => qdrantFilterConditions({ currentOnly: true, unknownKey: ['x'] } as unknown as RetrievalFilters)).toThrow(RetrievalBackendError);
  });

  it('includeUndated keeps a null doc_date; without it the range drops it', async () => {
    const client = await twoTenantClient();
    client.seed(COLLECTION, [{ id: pid(3), vector: { dense: CANARY_VECTOR }, payload: qdrantPayload({ ...payload(`u:${USER_A}`, 3), doc_date: null }) }]);
    const range = { from: '2025-01-01', to: '2025-12-31' };
    const strict = await searchQdrantLegs(client, storeRequest(scopeA, { filters: { currentOnly: true, dateRange: range } }));
    expect(strict.dense.map((h) => h.id)).not.toContain(pid(3));
    const loose = await searchQdrantLegs(client, storeRequest(scopeA, { filters: { currentOnly: true, dateRange: { ...range, includeUndated: true } } }));
    expect(loose.dense.map((h) => h.id)).toContain(pid(3));
    expect(loose.lexical.map((h) => h.id)).toContain(pid(3));
  });

  it.each<[string, Partial<BackendSearchRequest>]>([
    ['an invoice filter', { filters: { currentOnly: true, invoice: { currency: 'EUR' } } }],
    ['a scope-tag filter', { filters: { currentOnly: true, scopes: ['dimension:value'] } }],
    ['an effective-date filter', { filters: { currentOnly: true, effectiveOn: '2025-06-01' } }],
    ['a chunkingProfileOverride', { chunkingProfileOverride: { general: 'profile-x' } }],
    ['a non-current version scope', { versionScope: 'all' }],
    ['an identifier filter', { identifiersNorm: ['x-1'] }],
  ])('%s throws filter_unsupported before any request', async (_name, over) => {
    const client = await twoTenantClient();
    const admin = validatingAdmin(owners());
    const backend = createQdrantBackend({ readClient: client, adminClient: () => admin.client });
    const error = await backend.search(backendRequest(scopeA, over)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetrievalBackendError);
    expect((error as RetrievalBackendError).code).toBe('filter_unsupported');
    expect(client.requests).toEqual([]);
    expect(admin.calls).toEqual([]);
  });

  it('unset unsupported filters (empty scopes, empty invoice) do not refuse the request', async () => {
    const client = await twoTenantClient();
    await expect(
      searchQdrantLegs(client, storeRequest(scopeA, { filters: { currentOnly: true, scopes: [], invoice: {} } })),
    ).resolves.toBeDefined();
  });

  it('scores map to similarity and lexicalScore; only re-validated ids come back', async () => {
    const client = await twoTenantClient();
    const admin = validatingAdmin(owners());
    const backend = createQdrantBackend({ readClient: client, adminClient: () => admin.client });
    const legs = await backend.search(backendRequest(scopeA));
    expect(legs.dense.map((h) => h.chunkId)).toEqual(A_IDS);
    expect(legs.dense[0].similarity).toBeCloseTo(1, 6);
    expect(legs.dense[0].lexicalScore).toBeNull();
    expect(legs.lexical[0].lexicalScore).toBe(2);
    expect(legs.lexical[0].similarity).toBeNull();
    expect(legs.lexical[0].content).toBe('hydrated neutral body');
    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0]).toMatchObject({ fn: 'rag_validate_chunks', p_tenant_key: `u:${USER_A}`, p_profile_id: PROFILE });
  });

  it('health reports the server version; isReady delegates to the injected readiness and is false without it', async () => {
    const client = await twoTenantClient();
    const admin = validatingAdmin(owners());
    const readiness = vi.fn(async (scope: TenantScope) => scope === scopeA);
    const backend = createQdrantBackend({ readClient: client, adminClient: () => admin.client, readiness });
    expect(backend.id).toBe('qdrant');
    expect(await backend.health()).toEqual({ ok: true, detail: '1.20.2' });
    expect(await backend.isReady(scopeA)).toBe(true);
    expect(await backend.isReady(scopeB)).toBe(false);
    expect(await createQdrantBackend({ readClient: client, adminClient: () => admin.client }).isReady(scopeA)).toBe(false);
    const down = { ...client, versionInfo: async () => Promise.reject(new Error('connect ECONNREFUSED')) };
    expect(await createQdrantBackend({ readClient: down, adminClient: () => admin.client }).health()).toEqual({ ok: false, detail: 'unreachable' });
  });

  it('an abort rejects with the abort reason', async () => {
    const client = await twoTenantClient();
    client.holdQueries = true;
    const controller = new AbortController();
    const pending = searchQdrantLegs(client, storeRequest(scopeA, { signal: controller.signal }));
    const reason = new Error('caller gave up');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    client.release();
    const already = new AbortController();
    already.abort(reason);
    await expect(searchQdrantLegs(client, storeRequest(scopeA, { signal: already.signal }))).rejects.toBe(reason);
  });

  it('a missing collection is not ready; other vendor errors carry the status only', async () => {
    const client = createFakeQdrantClient();
    await expect(searchQdrantLegs(client, storeRequest(scopeA))).rejects.toBeInstanceOf(BackendNotReadyError);
    const failing = { ...client, queryBatch: async () => Promise.reject(Object.assign(new Error('body with details'), { status: 500 })) };
    const error = await searchQdrantLegs(failing, storeRequest(scopeA)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetrievalBackendError);
    expect((error as RetrievalBackendError).code).toBe('http_500');
    expect((error as Error).message).not.toContain('body with details');
  });
});

describe('qdrant adapter two-tenant isolation', () => {
  it('two-tenant: a filter-evaluating store returns only the caller tenant on both legs', async () => {
    const client = await twoTenantClient();
    const a = await searchQdrantLegs(client, storeRequest(scopeA));
    const b = await searchQdrantLegs(client, storeRequest(scopeB));
    expect(a.dense.map((h) => h.id)).toEqual(A_IDS);
    expect(a.lexical.map((h) => h.id)).toEqual(A_IDS);
    expect(b.dense.map((h) => h.id)).toEqual(B_IDS);
    expect(b.lexical.map((h) => h.id)).toEqual(B_IDS);
  });

  it('two-tenant: a filter-ignoring store leaks foreign ids, and re-validation drops every one of them', async () => {
    const client = await twoTenantClient();
    client.filterMode = 'ignore';
    const raw = await searchQdrantLegs(client, storeRequest(scopeA));
    expect(raw.dense.map((h) => h.id)).toEqual(expect.arrayContaining(B_IDS));
    const admin = validatingAdmin(owners());
    const securityLog = vi.fn();
    const backend = createQdrantBackend({ readClient: client, adminClient: () => admin.client, securityLog });
    const legs = await backend.search(backendRequest(scopeA));
    const returned = [...legs.dense, ...legs.lexical].map((h) => h.chunkId);
    for (const id of B_IDS) expect(returned).not.toContain(id);
    expect(legs.dense.map((h) => h.chunkId)).toEqual(A_IDS);
    expect(legs.lexical.map((h) => h.chunkId)).toEqual(A_IDS);
    expect(legs.meta?.tenantValidationDropped).toBe(B_IDS.length);
    expect(securityLog).toHaveBeenCalledTimes(1);
    expect(String(securityLog.mock.calls[0][0])).not.toContain(USER_B);
  });
});
