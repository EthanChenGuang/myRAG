import { describe, expect, it } from 'vitest';
import { assertScoped } from '@/lib/rag/backend/qdrant/scoped-request';
import { qdrantCollectionName, weaviateCollectionName, weaviateTenantName } from '@/lib/rag/backend/tenant-key';
import { createQdrantStore } from '@/lib/rag/sync/stores/qdrant';
import type { VectorPoint } from '@/lib/rag/sync/stores/types';
import { createWeaviateStore } from '@/lib/rag/sync/stores/weaviate';
import { storeScopeForTenantKey } from '@/lib/rag/tenant/store-scope';
import { createFakeQdrantClient, scopedBodyOf } from '../backend/qdrant-fake-client';
import { createFakeWeaviate } from '../backend/weaviate-fake';

const ACTIVE = 'neutral-active-3';
const RETIRED = 'neutral-retired-3';
const KEY_A = 'u:00000000-0000-4000-8000-0000000000a1';
const KEY_B = 'o:00000000-0000-4000-8000-0000000000b2';
const DOC_SHARED = '00000000-0000-4000-8000-00000000d0a1';
const DOC_OTHER = '00000000-0000-4000-8000-00000000d0a2';

function uuid(n: number, block = 'e'): string {
  return `00000000-0000-4000-8000-${block.repeat(4)}${String(n).padStart(8, '0')}`;
}

function point(n: number, tenantKey: string, documentId: string): VectorPoint {
  return {
    id: uuid(n, tenantKey === KEY_A ? 'a' : 'b'),
    vector: [1, 0, 0],
    payload: {
      tenant_key: tenantKey,
      document_id: documentId,
      doc_type: 'general',
      doc_date: null,
      language: 'en',
      source: null,
      chunking_profile_id: null,
      parent_id: null,
      lexical_text: 'neutral sample words',
      content_hash: 'h',
      lexical_version: 1,
      access_groups: ['all'],
    },
  };
}

function manyDocs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => uuid(i + 1, 'd'));
}

describe('qdrant store purge operations', () => {
  async function seeded() {
    const client = createFakeQdrantClient();
    const store = createQdrantStore({ writeClient: client });
    for (const profileId of [ACTIVE, RETIRED]) {
      await store.ensureCollection({ profileId, dims: 3 });
      await store.upsert(profileId, KEY_A, [point(1, KEY_A, DOC_SHARED), point(2, KEY_A, DOC_SHARED), point(3, KEY_A, DOC_OTHER)]);
      await store.upsert(profileId, KEY_B, [point(11, KEY_B, DOC_SHARED), point(12, KEY_B, DOC_OTHER)]);
    }
    await client.createCollection('unrelated_collection', { vectors: { dense: { size: 3, distance: 'Cosine' } } } as never);
    client.requests.length = 0;
    return { client, store };
  }

  function docsIn(client: ReturnType<typeof createFakeQdrantClient>, profileId: string, tenantKey: string): string[] {
    return [...(client.collections.get(qdrantCollectionName(profileId))?.points.values() ?? [])]
      .filter((p) => p.payload.tenant_key === tenantKey)
      .map((p) => String(p.payload.document_id))
      .sort();
  }

  it('listCollections returns only myrag_chunks_ collections', async () => {
    const { store } = await seeded();
    expect(await store.listCollections()).toEqual([qdrantCollectionName(ACTIVE), qdrantCollectionName(RETIRED)]);
  });

  it('deleteDocuments sends tenant-scoped document_id match-any deletes of at most 100 ids and counts exactly', async () => {
    const { client, store } = await seeded();
    const ids = [DOC_SHARED, ...manyDocs(249)];
    const deleted = await store.deleteDocuments(qdrantCollectionName(ACTIVE), KEY_A, ids);
    expect(deleted).toBe(2);
    const scope = storeScopeForTenantKey(KEY_A);
    for (const r of client.requests.filter((r) => r.method === 'delete' || r.method === 'count')) {
      expect(r.collection).toBe(qdrantCollectionName(ACTIVE));
      expect(() => assertScoped(scopedBodyOf(r), scope)).not.toThrow();
      const must = (r.body.filter as { must: Array<Record<string, unknown>> }).must;
      const any = must.find((c) => c.key === 'document_id')?.match as { any: string[] } | undefined;
      expect(any?.any.length).toBeGreaterThan(0);
      expect(any?.any.length).toBeLessThanOrEqual(100);
    }
    const counts = client.requests.filter((r) => r.method === 'count');
    expect(counts).toHaveLength(3);
    for (const c of counts) expect(c.body.exact).toBe(true);
    // Only the chunk that holds points is deleted; the other two counted zero.
    expect(client.requests.filter((r) => r.method === 'delete')).toHaveLength(1);
    expect(docsIn(client, ACTIVE, KEY_A)).toEqual([DOC_OTHER]);
    expect(docsIn(client, ACTIVE, KEY_B)).toEqual([DOC_SHARED, DOC_OTHER].sort());
    expect(docsIn(client, RETIRED, KEY_A)).toEqual([DOC_SHARED, DOC_SHARED, DOC_OTHER].sort());
  });

  it('countDocumentPoints counts exactly inside the tenant; a missing collection counts and deletes zero', async () => {
    const { client, store } = await seeded();
    expect(await store.countDocumentPoints(qdrantCollectionName(RETIRED), KEY_A, [DOC_SHARED])).toBe(2);
    expect(await store.countDocumentPoints(qdrantCollectionName(RETIRED), KEY_B, [DOC_SHARED, DOC_OTHER])).toBe(2);
    const last = client.requests[client.requests.length - 1];
    expect(last.body.exact).toBe(true);
    expect(() => assertScoped(scopedBodyOf(last), storeScopeForTenantKey(KEY_B))).not.toThrow();
    expect(await store.countDocumentPoints(qdrantCollectionName('gone-profile'), KEY_A, [DOC_SHARED])).toBe(0);
    expect(await store.deleteDocuments(qdrantCollectionName('gone-profile'), KEY_A, [DOC_SHARED])).toBe(0);
  });

  it('refuses a collection outside the chunk prefix, a malformed key and a non-uuid document id before any request', async () => {
    const { client, store } = await seeded();
    await expect(store.deleteDocuments('unrelated_collection', KEY_A, [DOC_SHARED])).rejects.toThrow(/chunk collection/);
    await expect(store.deleteDocuments(qdrantCollectionName(ACTIVE), 'u:not-a-key', [DOC_SHARED])).rejects.toThrow(/tenant key/);
    await expect(store.countDocumentPoints(qdrantCollectionName(ACTIVE), KEY_A, ['not-a-uuid'])).rejects.toThrow(/document id/);
    expect(client.requests).toHaveLength(0);
  });

  it('two-tenant: with a filter-ignoring server a delete without the tenant clause would remove B; the store keeps B', async () => {
    const control = await seeded();
    control.client.filterMode = 'ignore';
    await control.client.delete(qdrantCollectionName(ACTIVE), { filter: { must: [{ key: 'document_id', match: { any: [DOC_SHARED] } }] } } as never);
    expect(docsIn(control.client, ACTIVE, KEY_B)).toEqual([DOC_OTHER]);

    const { client, store } = await seeded();
    client.filterMode = 'ignore';
    await store.deleteDocuments(qdrantCollectionName(ACTIVE), KEY_A, [DOC_SHARED]);
    expect(docsIn(client, ACTIVE, KEY_B)).toEqual([DOC_SHARED, DOC_OTHER].sort());
    expect(docsIn(client, ACTIVE, KEY_A)).toEqual([DOC_OTHER]);
    for (const r of client.requests.filter((r) => r.method === 'delete')) {
      expect(() => assertScoped(scopedBodyOf(r), storeScopeForTenantKey(KEY_A))).not.toThrow();
    }
  });
});

describe('weaviate store purge operations', () => {
  async function seeded(options: Parameters<typeof createFakeWeaviate>[0] = {}) {
    const fake = createFakeWeaviate(options);
    const store = createWeaviateStore({ client: fake });
    for (const profileId of [ACTIVE, RETIRED]) {
      await store.ensureCollection({ profileId, dims: 3 });
      await store.upsert(profileId, KEY_A, [point(1, KEY_A, DOC_SHARED), point(2, KEY_A, DOC_SHARED), point(3, KEY_A, DOC_OTHER)]);
      await store.upsert(profileId, KEY_B, [point(11, KEY_B, DOC_SHARED), point(12, KEY_B, DOC_OTHER)]);
    }
    await fake.collections.create({ name: 'UnrelatedCollection' });
    fake.calls.length = 0;
    return { fake, store };
  }

  function docsIn(fake: ReturnType<typeof createFakeWeaviate>, profileId: string, tenantKey: string): string[] {
    const shard = fake.collectionsByName.get(weaviateCollectionName(profileId))?.tenants.get(weaviateTenantName(tenantKey));
    return [...(shard?.values() ?? [])].map((o) => String(o.properties.document_id)).sort();
  }

  it('listCollections returns only the chunk collections', async () => {
    const { store } = await seeded();
    expect(await store.listCollections()).toEqual([weaviateCollectionName(ACTIVE), weaviateCollectionName(RETIRED)].sort());
  });

  it('deleteDocuments runs only on the tenant handle with a document_id containsAny filter, in chunks of at most 100 ids', async () => {
    const { fake, store } = await seeded();
    const ids = [DOC_SHARED, ...manyDocs(249)];
    expect(await store.deleteDocuments(weaviateCollectionName(ACTIVE), KEY_A, ids)).toBe(2);
    expect(fake.calls.some((c) => c.op === 'untenanted')).toBe(false);
    const deletes = fake.calls.filter((c) => c.op === 'deleteMany');
    expect(deletes.length).toBeGreaterThanOrEqual(3);
    for (const d of deletes) {
      expect(d.tenant).toBe(weaviateTenantName(KEY_A));
      const where = d.args as { operator: string; filters: Array<{ operator: string; value: unknown; target: { property: string } }> };
      expect(where.operator).toBe('And');
      const docs = where.filters.find((f) => f.target.property === 'document_id');
      expect(docs?.operator).toBe('ContainsAny');
      expect((docs?.value as string[]).length).toBeLessThanOrEqual(100);
      expect(where.filters.find((f) => f.target.property === 'tenant_key')?.value).toBe(KEY_A);
    }
    expect(docsIn(fake, ACTIVE, KEY_A)).toEqual([DOC_OTHER]);
    expect(docsIn(fake, ACTIVE, KEY_B)).toEqual([DOC_SHARED, DOC_OTHER].sort());
    expect(await store.countDocumentPoints(weaviateCollectionName(RETIRED), KEY_A, ids)).toBe(2);
    expect(await store.countDocumentPoints(weaviateCollectionName(ACTIVE), KEY_A, ids)).toBe(0);
  });

  it('a collection without the tenant counts and deletes zero without an error; a missing collection too', async () => {
    const { fake, store } = await seeded();
    const KEY_C = 'u:00000000-0000-4000-8000-0000000000c3';
    expect(await store.deleteDocuments(weaviateCollectionName(ACTIVE), KEY_C, [DOC_SHARED])).toBe(0);
    expect(await store.countDocumentPoints(weaviateCollectionName(ACTIVE), KEY_C, [DOC_SHARED])).toBe(0);
    expect(await store.countDocumentPoints(weaviateCollectionName('gone-profile'), KEY_A, [DOC_SHARED])).toBe(0);
    expect(fake.calls.some((c) => c.op === 'untenanted')).toBe(false);
  });

  it('refuses a collection outside the chunk prefix before any call', async () => {
    const { fake, store } = await seeded();
    await expect(store.deleteDocuments('UnrelatedCollection', KEY_A, [DOC_SHARED])).rejects.toThrow(/chunk collection/);
    expect(fake.calls).toHaveLength(0);
  });

  it('two-tenant: on a wrong-shard server a document-only filter would delete B; the store filter keeps B', async () => {
    const misroute = { [weaviateTenantName(KEY_A)]: weaviateTenantName(KEY_B) };
    // Seeded on a healthy server; then the handle for A starts answering from B's shard.
    const controlOptions: Parameters<typeof createFakeWeaviate>[0] = {};
    const control = await seeded(controlOptions);
    controlOptions.misroute = misroute;
    const handle = control.fake.collections.use(weaviateCollectionName(ACTIVE)).withTenant(weaviateTenantName(KEY_A));
    await handle.data.deleteMany(handle.filter.byProperty('document_id').containsAny([DOC_SHARED]));
    expect(docsIn(control.fake, ACTIVE, KEY_B)).toEqual([DOC_OTHER]);

    const options: Parameters<typeof createFakeWeaviate>[0] = {};
    const { fake, store } = await seeded(options);
    options.misroute = misroute;
    expect(await store.deleteDocuments(weaviateCollectionName(ACTIVE), KEY_A, [DOC_SHARED])).toBe(0);
    expect(docsIn(fake, ACTIVE, KEY_B)).toEqual([DOC_SHARED, DOC_OTHER].sort());
    expect(await store.countDocumentPoints(weaviateCollectionName(ACTIVE), KEY_A, [DOC_SHARED])).toBe(0);
  });
});
