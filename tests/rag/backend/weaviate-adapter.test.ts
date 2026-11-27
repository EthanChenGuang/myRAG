import { describe, expect, it } from 'vitest';
import { BackendNotReadyError } from '@/lib/rag/backend/external';
import { RetrievalBackendError, type RpcClient, type RpcRequest } from '@/lib/rag/backend/supabase-rpc';
import { canonicalTenantKey, weaviateCollectionName, weaviateTenantName } from '@/lib/rag/backend/tenant-key';
import type { BackendSearchRequest, RetrievalFilters } from '@/lib/rag/backend/types';
import { buildWeaviateFilter, createWeaviateBackend, searchWeaviateLegs, tenantCollection } from '@/lib/rag/backend/weaviate/adapter';
import { ensureWeaviateCollection } from '@/lib/rag/backend/weaviate/collection';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';
import { createFakeWeaviate, evaluateFilter, type FakeWeaviate, type FakeWeaviateOptions } from './weaviate-fake';

const PROFILE = 'conformance-profile';
const COLLECTION = weaviateCollectionName(PROFILE);
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b2';
const SCOPE_A = mintScope('personal', USER_A, null);
const SCOPE_B = mintScope('org', null, ORG_B);
const TENANT_A = weaviateTenantName(canonicalTenantKey(SCOPE_A));
const TENANT_B = weaviateTenantName(canonicalTenantKey(SCOPE_B));
const CANARY_VECTOR = [0.6, 0.8, 0];
const CANARY_TEXT = 'canary neutral marker';
const A_IDS = ['00000000-0000-4000-8000-0000000a0001', '00000000-0000-4000-8000-0000000a0002'];
const B_IDS = ['00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000b0002', '00000000-0000-4000-8000-0000000b0003'];

function props(tenantKey: string, extra: Record<string, unknown> = {}) {
  return { tenant_key: tenantKey, document_id: '00000000-0000-4000-8000-00000000d001', lexical_text: CANARY_TEXT, doc_type: 'general', ...extra };
}

async function twoTenantFake(options: FakeWeaviateOptions = {}): Promise<FakeWeaviate> {
  const fake = createFakeWeaviate(options);
  await ensureWeaviateCollection(fake, PROFILE, 3);
  for (const id of A_IDS) fake.plant(COLLECTION, TENANT_A, { id, properties: props(canonicalTenantKey(SCOPE_A)), vector: CANARY_VECTOR });
  for (const id of B_IDS) fake.plant(COLLECTION, TENANT_B, { id, properties: props(canonicalTenantKey(SCOPE_B)), vector: CANARY_VECTOR });
  return fake;
}

/** rag_validate_chunks over a fixed ownership map: returns only the ids the named tenant owns. */
function validatingRpc(owners: Record<string, string>): { client: RpcClient; calls: Array<Record<string, unknown>> } {
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
            .filter((id) => owners[id] === args.p_tenant_key)
            .map((id) => ({
              chunk_id: id,
              document_id: '00000000-0000-4000-8000-00000000d001',
              content: `hydrated ${id.slice(-4)}`,
              metadata: {},
              chunk_index: 0,
              doc_type: 'general',
              language: 'en',
              parent_id: null,
              section_path: [],
              chunk_kind: 'text',
              document_filename: 'neutral.md',
              document_created_at: null,
              document_metadata: {},
              document_content_preview: '',
            }));
          return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

const OWNERS: Record<string, string> = {
  ...Object.fromEntries(A_IDS.map((id) => [id, canonicalTenantKey(SCOPE_A)])),
  ...Object.fromEntries(B_IDS.map((id) => [id, canonicalTenantKey(SCOPE_B)])),
};

function request(scope: TenantScope, over: Partial<BackendSearchRequest> = {}): BackendSearchRequest {
  return {
    scope,
    embeddingProfileId: PROFILE,
    denseVector: CANARY_VECTOR,
    lexicalTokens: ['canary', 'marker'],
    lexicalLanguages: null,
    filters: { currentOnly: true },
    denseLimit: 10,
    lexicalLimit: 10,
    signal: new AbortController().signal,
    ...over,
  };
}

function storeRequest(scope: TenantScope, over: Partial<BackendSearchRequest> = {}) {
  const req = request(scope, over);
  return {
    scope: req.scope,
    profileId: req.embeddingProfileId,
    denseVector: req.denseVector,
    lexicalTokens: req.lexicalTokens,
    denseLimit: req.denseLimit,
    lexicalLimit: req.lexicalLimit,
    filters: req.filters,
    signal: req.signal,
  };
}

function backend(fake: FakeWeaviate, log: string[] = []) {
  const rpc = validatingRpc(OWNERS);
  return {
    rpc,
    backend: createWeaviateBackend({ readClient: () => fake, revalidate: () => rpc.client, securityLog: (line) => log.push(line) }),
  };
}

describe('weaviate adapter legs (D-13, A-4)', () => {
  it('runs nearVector and bm25 concurrently on the tenant handle with the same filters and lexical_text', async () => {
    const fake = await twoTenantFake({ slowQueries: true });
    await searchWeaviateLegs(fake, storeRequest(SCOPE_A, { filters: { currentOnly: true, docTypes: ['general'] } }));
    expect(fake.events.slice(0, 2).sort()).toEqual(['start:bm25', 'start:nearVector']);
    const dense = fake.calls.find((c) => c.op === 'nearVector')!;
    const lexical = fake.calls.find((c) => c.op === 'bm25')!;
    expect(dense.tenant).toBe(TENANT_A);
    expect(lexical.tenant).toBe(TENANT_A);
    expect((lexical.args as { queryProperties: string[] }).queryProperties).toEqual(['lexical_text']);
    expect((lexical.args as { query: string }).query).toBe('canary marker');
    expect((dense.args as { filters: unknown }).filters).toEqual((lexical.args as { filters: unknown }).filters);
    expect((dense.args as { filters: unknown }).filters).toBeDefined();
  });

  it('a scope minted from an upper-case UUID reaches the lower-case tenant name', async () => {
    const fake = await twoTenantFake();
    const upper = mintScope('personal', USER_A.toUpperCase(), null);
    const legs = await searchWeaviateLegs(fake, storeRequest(upper));
    expect(fake.calls.filter((c) => c.op === 'withTenant').map((c) => c.tenant)).toEqual([TENANT_A]);
    expect(legs.dense.map((h) => h.id).sort()).toEqual(A_IDS);
  });

  it('an empty token list skips bm25 and returns an empty lexical leg', async () => {
    const fake = await twoTenantFake();
    const legs = await searchWeaviateLegs(fake, storeRequest(SCOPE_A, { lexicalTokens: [] }));
    expect(legs.lexical).toEqual([]);
    expect(fake.calls.some((c) => c.op === 'bm25')).toBe(false);
    const blank = await searchWeaviateLegs(fake, storeRequest(SCOPE_A, { lexicalTokens: ['', '  '] }));
    expect(blank.lexical).toEqual([]);
    expect(fake.calls.some((c) => c.op === 'bm25')).toBe(false);
  });

  it('distance maps to similarity 1 - distance and the bm25 score to lexicalScore through createExternalBackend', async () => {
    const fake = await twoTenantFake();
    const { backend: wv } = backend(fake);
    const legs = await wv.search(request(SCOPE_A));
    expect(legs.dense).toHaveLength(2);
    for (const hit of legs.dense) {
      expect(hit.similarity).toBeCloseTo(1, 6);
      expect(hit.lexicalScore).toBeNull();
      expect(hit.content).toMatch(/^hydrated /);
    }
    expect(legs.lexical.map((h) => h.lexicalScore)).toEqual([2, 2]);
    expect(legs.dense.map((h) => h.rank)).toEqual([1, 2]);
    expect(wv.id).toBe('weaviate');
  });

  it('tenant not found throws BackendNotReadyError and is never retried without a tenant', async () => {
    const fake = await twoTenantFake();
    const stranger = mintScope('personal', '00000000-0000-4000-8000-0000000000c3', null);
    await expect(searchWeaviateLegs(fake, storeRequest(stranger))).rejects.toBeInstanceOf(BackendNotReadyError);
    await expect(searchWeaviateLegs(fake, storeRequest(stranger))).rejects.toMatchObject({ reason: 'tenant_missing' });
    expect(fake.calls.some((c) => c.op === 'untenanted')).toBe(false);
    expect(fake.calls.filter((c) => c.op === 'nearVector' || c.op === 'bm25').every((c) => c.tenant !== null)).toBe(true);
    expect(fake.calls.filter((c) => c.op === 'withTenant').length).toBe(2);
  });

  it('a missing collection is not ready', async () => {
    const fake = createFakeWeaviate();
    await expect(searchWeaviateLegs(fake, storeRequest(SCOPE_A))).rejects.toMatchObject({ reason: 'collection_missing' });
  });

  it('invoice filters, scope tags, effective dates and chunkingProfileOverride throw filter_unsupported before any call', async () => {
    const fake = await twoTenantFake();
    const { backend: wv, rpc } = backend(fake);
    fake.calls.length = 0;
    const cases: Array<Partial<BackendSearchRequest>> = [
      { filters: { currentOnly: true, invoice: { supplier: 'x' } } },
      { filters: { currentOnly: true, scopes: ['dimension:value'] } },
      { filters: { currentOnly: true, effectiveOn: '2025-01-01' } },
      { chunkingProfileOverride: { general: 'other' } },
      { versionScope: 'all' },
      { identifiersNorm: ['id-1'] },
    ];
    for (const over of cases) {
      const outcome = wv.search(request(SCOPE_A, over));
      await expect(outcome).rejects.toBeInstanceOf(RetrievalBackendError);
      await expect(wv.search(request(SCOPE_A, over))).rejects.toMatchObject({ code: 'filter_unsupported' });
    }
    expect(fake.calls).toEqual([]);
    expect(rpc.calls).toEqual([]);
  });

  it('an abort rejects with the abort reason', async () => {
    const fake = await twoTenantFake({ slowQueries: true });
    const controller = new AbortController();
    const reason = new Error('caller gave up');
    const pending = searchWeaviateLegs(fake, { ...storeRequest(SCOPE_A), signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    const aborted = new AbortController();
    aborted.abort(reason);
    await expect(searchWeaviateLegs(fake, { ...storeRequest(SCOPE_A), signal: aborted.signal })).rejects.toBe(reason);
  });
});

describe('weaviate filter translation (DATA-08)', () => {
  const fake = createFakeWeaviate();
  fake.collectionsByName.set(COLLECTION, { config: {}, tenants: new Map([[TENANT_A, new Map()]]) });
  const col = tenantCollection(fake, SCOPE_A, PROFILE);
  const object = (properties: Record<string, unknown>) => ({ id: A_IDS[0], properties, vector: [] });

  it('every native key maps to a Weaviate filter; empty lists mean no filter', () => {
    expect(buildWeaviateFilter(col, { currentOnly: true })).toBeUndefined();
    expect(buildWeaviateFilter(col, { currentOnly: true, sources: [], docTypes: [] })).toBeUndefined();
    const filters: RetrievalFilters = {
      currentOnly: true,
      documentIds: ['d1'],
      docTypes: ['general'],
      languages: ['en'],
      sources: ['s1'],
      dateRange: { from: '2025-01-01', to: '2025-12-31' },
    };
    const where = buildWeaviateFilter(col, filters);
    const match = { document_id: 'd1', doc_type: 'general', language: 'en', source: 's1', doc_date: '2025-06-01T00:00:00Z' };
    expect(evaluateFilter(where, object(match))).toBe(true);
    for (const [key, value] of Object.entries({ document_id: 'd2', doc_type: 'other', language: 'it', source: 's2', doc_date: '2026-01-01T00:00:00Z' })) {
      expect(evaluateFilter(where, object({ ...match, [key]: value }))).toBe(false);
    }
    expect(evaluateFilter(where, object({ ...match, doc_date: undefined }))).toBe(false);
  });

  it('includeUndated adds an isNull alternative to the date range', () => {
    const where = buildWeaviateFilter(col, { currentOnly: true, dateRange: { from: '2025-01-01', includeUndated: true } });
    expect(evaluateFilter(where, object({}))).toBe(true);
    expect(evaluateFilter(where, object({ doc_date: '2024-12-31T00:00:00Z' }))).toBe(false);
    expect(evaluateFilter(where, object({ doc_date: '2025-01-01T00:00:00Z' }))).toBe(true);
  });

  it('an unknown filter key is refused rather than ignored', () => {
    expect(() => buildWeaviateFilter(col, { currentOnly: true, unknownKey: ['x'] } as unknown as RetrievalFilters)).toThrow(/filter_unsupported/);
  });
});

describe('weaviate two-tenant isolation (cross-tenant leak is the worst failure)', () => {
  it('two-tenant: A and B share the canary vector and tokens; each scope gets only its own ids on both legs', async () => {
    const fake = await twoTenantFake();
    const { backend: wv } = backend(fake);
    const a = await wv.search(request(SCOPE_A));
    const b = await wv.search(request(SCOPE_B));
    expect(a.dense.map((h) => h.chunkId).sort()).toEqual(A_IDS);
    expect(a.lexical.map((h) => h.chunkId).sort()).toEqual(A_IDS);
    expect(b.dense.map((h) => h.chunkId).sort()).toEqual(B_IDS);
    expect(b.lexical.map((h) => h.chunkId).sort()).toEqual(B_IDS);
    expect(a.meta?.tenantValidationDropped).toBe(0);
    const tenants = fake.calls.filter((c) => c.op === 'nearVector' || c.op === 'bm25').map((c) => c.tenant);
    expect(tenants).toEqual([TENANT_A, TENANT_A, TENANT_B, TENANT_B]);
  });

  it('two-tenant: a fake answering from B shard for A tenant has every B id dropped by re-validation', async () => {
    const fake = await twoTenantFake({ misroute: { [TENANT_A]: TENANT_B } });
    const log: string[] = [];
    const { backend: wv, rpc } = backend(fake, log);
    const legs = await wv.search(request(SCOPE_A));
    expect(legs.dense).toEqual([]);
    expect(legs.lexical).toEqual([]);
    expect(legs.meta?.tenantValidationDropped).toBe(B_IDS.length);
    expect(rpc.calls[0]).toMatchObject({ fn: 'rag_validate_chunks', p_tenant_key: canonicalTenantKey(SCOPE_A) });
    expect(log.join('\n')).toMatch(/\[RAG Security\]/);
  });
});
