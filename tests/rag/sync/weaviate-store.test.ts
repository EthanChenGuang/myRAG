import { describe, expect, it, vi } from 'vitest';
import { BackendNotReadyError } from '@/lib/rag/backend/external';
import { RetrievalBackendError } from '@/lib/rag/backend/supabase-rpc';
import { weaviateCollectionName, weaviateTenantName } from '@/lib/rag/backend/tenant-key';
import { resolveWeaviateConnection } from '@/lib/rag/backend/weaviate/client';
import { describeWeaviateCollection, weaviateCollectionSpec } from '@/lib/rag/backend/weaviate/collection';
import { createWeaviateStore } from '@/lib/rag/sync/stores/weaviate';
import type { VectorPoint } from '@/lib/rag/sync/stores/types';
import { createFakeWeaviate } from '../backend/weaviate-fake';

const PROFILE = 'conformance-profile';
const COLLECTION = weaviateCollectionName(PROFILE);
const KEY_A = 'u:00000000-0000-4000-8000-0000000000a1';
const KEY_B = 'o:00000000-0000-4000-8000-0000000000b2';
const TENANT_A = weaviateTenantName(KEY_A);
const TENANT_B = weaviateTenantName(KEY_B);
const DOC_A = '00000000-0000-4000-8000-00000000d0a1';
const DOC_B = '00000000-0000-4000-8000-00000000d0b2';

function point(id: string, tenantKey: string, documentId: string, extra: Partial<VectorPoint['payload']> = {}): VectorPoint {
  return {
    id,
    vector: [1, 0, 0],
    payload: {
      tenant_key: tenantKey,
      document_id: documentId,
      doc_type: 'general',
      doc_date: '2025-03-01',
      language: 'en',
      source: null,
      chunking_profile_id: null,
      parent_id: null,
      lexical_text: 'neutral sample words',
      content_hash: `hash-${id.slice(-4)}`,
      lexical_version: 1,
      access_groups: ['all'],
      ...extra,
    },
  };
}

function id(n: number, prefix = 'a'): string {
  return `00000000-0000-4000-8000-${prefix.repeat(4)}${String(n).padStart(8, '0')}`;
}

async function seeded(options: Parameters<typeof createFakeWeaviate>[0] = {}) {
  const fake = createFakeWeaviate(options);
  const store = createWeaviateStore({ client: fake });
  await store.ensureCollection({ profileId: PROFILE, dims: 3 });
  return { fake, store };
}

describe('weaviate collection spec (D-06, D-13, A-4)', () => {
  it('creates a multi-tenant collection without automatic tenants, one uncompressed HNSW vector and BM25 over lexical_text', async () => {
    const { fake } = await seeded();
    const created = fake.calls.filter((c) => c.op === 'collections.create');
    expect(created).toHaveLength(1);
    const config = created[0].args as Record<string, any>;
    expect(config.name).toBe(COLLECTION);
    expect(config.multiTenancy).toMatchObject({ enabled: true, autoTenantCreation: false });
    expect(config.vectorizers.vectorizer.name).toBe('none');
    expect(config.vectorizers.vectorIndex.config).toMatchObject({
      maxConnections: 64,
      efConstruction: 200,
      distance: 'cosine',
      filterStrategy: 'acorn',
      quantizer: { type: 'none' },
    });
    expect(config.invertedIndex).toMatchObject({ indexNullState: true, stopwords: { preset: 'none' }, bm25: { k1: 1.2, b: 0.75 } });
    const props = new Map((config.properties as Array<Record<string, unknown>>).map((p) => [p.name, p]));
    expect(props.get('lexical_text')).toMatchObject({ dataType: 'text', tokenization: 'whitespace' });
    for (const name of ['tenant_key', 'document_id', 'doc_type', 'language', 'source', 'chunking_profile_id', 'parent_id', 'content_hash']) {
      expect(props.get(name)).toMatchObject({ dataType: 'text', tokenization: 'field', indexSearchable: false });
    }
    expect(props.get('doc_date')).toMatchObject({ dataType: 'date', indexRangeFilters: true });
    expect(JSON.parse(config.description)).toEqual({
      profile_id: PROFILE,
      dims: 3,
      lexical_mode: 'bm25_whitespace',
      lexical_bm25: { k1: 1.2, b: 0.75 },
    });
  });

  it('a second ensureCollection is a no-op and other dims are refused', async () => {
    const { fake, store } = await seeded();
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    expect(fake.calls.filter((c) => c.op === 'collections.create')).toHaveLength(1);
    await expect(store.ensureCollection({ profileId: PROFILE, dims: 4 })).rejects.toThrow(/dims differ/);
  });

  it('describeCollection reads exists, dims and lexical mode from the stored description', async () => {
    const { fake, store } = await seeded();
    expect(await describeWeaviateCollection(fake, PROFILE)).toEqual({
      exists: true,
      dims: 3,
      lexicalMode: 'bm25_whitespace',
      lexicalParams: { k1: 1.2, b: 0.75 },
    });
    expect(await describeWeaviateCollection(fake, 'other-profile')).toEqual({ exists: false, dims: null, lexicalMode: null, lexicalParams: null });
    expect(await store.describeCollection(PROFILE)).toEqual({ profileId: PROFILE, dims: 3, tenants: 0 });
    expect(await store.describeCollection('other-profile')).toBeNull();
  });

  it('the spec refuses non-positive dims', () => {
    expect(() => weaviateCollectionSpec(PROFILE, 0)).toThrow();
  });
});

describe('weaviate store writes (D-02, D-03, D-07)', () => {
  it('upsert creates an unseen tenant once, then inserts on the tenant handle with the chunk id and D-03 properties only', async () => {
    const { fake, store } = await seeded();
    await store.upsert(PROFILE, KEY_A, [point(id(1), KEY_A, DOC_A)]);
    await store.upsert(PROFILE, KEY_A, [point(id(2), KEY_A, DOC_A, { doc_date: null })]);
    expect(fake.calls.filter((c) => c.op === 'tenants.create').map((c) => c.tenant)).toEqual([TENANT_A]);
    const inserts = fake.calls.filter((c) => c.op === 'insertMany');
    expect(inserts.every((c) => c.tenant === TENANT_A)).toBe(true);
    const [first] = inserts[0].args as Array<{ id: string; properties: Record<string, unknown>; vectors: number[] }>;
    expect(first.id).toBe(id(1));
    expect(first.vectors).toEqual([1, 0, 0]);
    expect(Object.keys(first.properties).sort()).toEqual(
      ['content_hash', 'doc_date', 'doc_type', 'document_id', 'language', 'lexical_text', 'lexical_version', 'tenant_key'].sort(),
    );
    expect(first.properties.doc_date).toBe('2025-03-01T00:00:00Z');
    const [second] = inserts[1].args as Array<{ properties: Record<string, unknown> }>;
    expect('doc_date' in second.properties).toBe(false);
  });

  it('a point whose tenant differs from the call is refused before any write', async () => {
    const { fake, store } = await seeded();
    await expect(store.upsert(PROFILE, KEY_A, [point(id(1), KEY_B, DOC_A)])).rejects.toThrow(/tenant differs/);
    expect(fake.calls.some((c) => c.op === 'insertMany')).toBe(false);
  });

  it('a malformed tenant key is refused', async () => {
    const { store } = await seeded();
    await expect(store.upsert(PROFILE, 'u:NOT-A-UUID', [])).rejects.toThrow();
    await expect(store.count(PROFILE, 'x:bad')).rejects.toThrow();
  });

  it('deleteDocument loops deleteMany until no match remains (Pitfall 13)', async () => {
    const { fake, store } = await seeded({ deleteCap: 2 });
    await store.upsert(PROFILE, KEY_A, [1, 2, 3, 4, 5].map((n) => point(id(n), KEY_A, DOC_A)));
    await store.upsert(PROFILE, KEY_A, [point(id(6), KEY_A, DOC_B)]);
    expect(await store.deleteDocument(PROFILE, KEY_A, DOC_A)).toBe(5);
    expect(fake.calls.filter((c) => c.op === 'deleteMany').length).toBeGreaterThanOrEqual(3);
    expect(await store.listDocumentIds(PROFILE, KEY_A, DOC_B)).toEqual([id(6)]);
    expect(await store.count(PROFILE, KEY_A)).toBe(1);
  });

  it('deleteIds removes only the named ids', async () => {
    const { store } = await seeded();
    await store.upsert(PROFILE, KEY_A, [1, 2, 3].map((n) => point(id(n), KEY_A, DOC_A)));
    expect(await store.deleteIds(PROFILE, KEY_A, [id(1), id(3)])).toBe(2);
    expect(await store.listDocumentIds(PROFILE, KEY_A, DOC_A)).toEqual([id(2)]);
  });

  it('a write with the read-only client surfaces the permission error as RetrievalBackendError, never as success', async () => {
    const writer = await seeded();
    await writer.store.upsert(PROFILE, KEY_A, [point(id(1), KEY_A, DOC_A)]);
    const readOnly = createFakeWeaviate({ readOnly: true });
    readOnly.collectionsByName.set(COLLECTION, writer.fake.collectionsByName.get(COLLECTION)!);
    const store = createWeaviateStore({ client: readOnly });
    const upsert = store.upsert(PROFILE, KEY_A, [point(id(2), KEY_A, DOC_A)]);
    await expect(upsert).rejects.toBeInstanceOf(RetrievalBackendError);
    await expect(store.upsert(PROFILE, KEY_A, [point(id(2), KEY_A, DOC_A)])).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(store.deleteDocument(PROFILE, KEY_A, DOC_A)).rejects.toBeInstanceOf(RetrievalBackendError);
    await expect(store.upsert(PROFILE, KEY_B, [point(id(3), KEY_B, DOC_B)])).rejects.toBeInstanceOf(RetrievalBackendError);
  });

  it('a tenant removed behind the worker is created again on the next ensureTenant', async () => {
    const { fake, store } = await seeded();
    await store.upsert(PROFILE, KEY_A, [point(id(1), KEY_A, DOC_A)]);
    fake.collectionsByName.get(COLLECTION)!.tenants.delete(TENANT_A);
    const failed = store.upsert(PROFILE, KEY_A, [point(id(2), KEY_A, DOC_A)]);
    await expect(failed).rejects.toBeInstanceOf(BackendNotReadyError);
    await store.ensureTenant(PROFILE, KEY_A);
    await expect(store.upsert(PROFILE, KEY_A, [point(id(2), KEY_A, DOC_A)])).resolves.toBe(1);
  });

  it('reads on a missing tenant are empty and deletes are zero; a missing collection is not ready', async () => {
    const { store } = await seeded();
    expect(await store.count(PROFILE, KEY_B)).toBe(0);
    expect(await store.scanTenant(PROFILE, KEY_B, { after: null, limit: 10 })).toEqual({ points: [], next: null });
    expect(await store.listDocumentIds(PROFILE, KEY_B, DOC_B)).toEqual([]);
    expect(await store.deleteDocument(PROFILE, KEY_B, DOC_B)).toBe(0);
    await expect(store.count('missing-profile', KEY_A)).rejects.toBeInstanceOf(BackendNotReadyError);
  });
});

describe('weaviate store isolation (D-07)', () => {
  it('negative control: the fake refuses query and data calls on a handle obtained without withTenant', async () => {
    const { fake } = await seeded();
    const raw = fake.rawHandle(COLLECTION) as unknown as {
      query: { fetchObjects: () => unknown; nearVector: () => unknown; bm25: () => unknown };
      data: { insertMany: () => unknown; deleteMany: () => unknown };
      aggregate: { overAll: () => unknown };
    };
    expect(() => raw.query.fetchObjects()).toThrow(/without tenant/);
    expect(() => raw.query.nearVector()).toThrow(/without tenant/);
    expect(() => raw.query.bm25()).toThrow(/without tenant/);
    expect(() => raw.data.insertMany()).toThrow(/without tenant/);
    expect(() => raw.data.deleteMany()).toThrow(/without tenant/);
    expect(() => raw.aggregate.overAll()).toThrow(/without tenant/);
  });

  it('negative control: every store method passes while the fake rejects untenanted calls', async () => {
    const { fake, store } = await seeded();
    await store.upsert(PROFILE, KEY_A, [point(id(1), KEY_A, DOC_A), point(id(2), KEY_A, DOC_A)]);
    await store.ensureTenant(PROFILE, KEY_A);
    await store.listDocumentIds(PROFILE, KEY_A, DOC_A);
    await store.scanTenant(PROFILE, KEY_A, { after: null, limit: 1 });
    await store.count(PROFILE, KEY_A);
    await store.deleteIds(PROFILE, KEY_A, [id(1)]);
    await store.deleteDocument(PROFILE, KEY_A, DOC_A);
    await store.deleteTenant(PROFILE, KEY_A);
    await store.describeCollection(PROFILE);
    expect(fake.calls.some((c) => c.op === 'untenanted')).toBe(false);
    const dataOps = fake.calls.filter((c) => ['insertMany', 'deleteMany', 'fetchObjects', 'aggregate'].includes(c.op));
    expect(dataOps.length).toBeGreaterThan(0);
    expect(dataOps.every((c) => c.tenant === TENANT_A)).toBe(true);
  });

  it('two-tenant: scan, list and count on A see only A; deletes on A leave every B object in place', async () => {
    const { fake, store } = await seeded();
    const aPoints = [1, 2, 3].map((n) => point(id(n), KEY_A, DOC_A));
    const bPoints = [1, 2, 3].map((n) => point(id(n), KEY_B, DOC_A));
    await store.upsert(PROFILE, KEY_A, aPoints);
    await store.upsert(PROFILE, KEY_B, bPoints);

    const scanned: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await store.scanTenant(PROFILE, KEY_A, { after, limit: 2 });
      scanned.push(...page.points.map((p) => p.id));
      expect(page.points.every((p) => p.documentId === DOC_A && p.lexicalVersion === 1)).toBe(true);
      if (!page.next) break;
      after = page.next;
    }
    expect(scanned).toEqual(aPoints.map((p) => p.id));
    expect(await store.listDocumentIds(PROFILE, KEY_A, DOC_A)).toEqual(aPoints.map((p) => p.id));
    expect(await store.count(PROFILE, KEY_A)).toBe(3);

    expect(await store.deleteIds(PROFILE, KEY_A, [aPoints[0].id])).toBe(1);
    expect(await store.count(PROFILE, KEY_B)).toBe(3);
    expect(await store.deleteDocument(PROFILE, KEY_A, DOC_A)).toBe(2);
    expect(await store.count(PROFILE, KEY_B)).toBe(3);
    await store.upsert(PROFILE, KEY_A, aPoints);
    expect(await store.deleteTenant(PROFILE, KEY_A)).toBe(3);
    expect(await store.count(PROFILE, KEY_A)).toBe(0);
    const bShard = fake.collectionsByName.get(COLLECTION)!.tenants.get(TENANT_B)!;
    expect([...bShard.keys()].sort()).toEqual(bPoints.map((p) => p.id));
  });
});

describe('weaviate client resolution (D-09, A-1)', () => {
  it('a Weaviate Cloud host connects as cloud, any other host as custom with gRPC on 50051 of the same host', () => {
    expect(resolveWeaviateConnection('write', { WEAVIATE_URL: 'https://example-cluster.weaviate.cloud', WEAVIATE_API_KEY: 'k' })).toMatchObject({
      kind: 'cloud',
      url: 'https://example-cluster.weaviate.cloud',
      skipInitChecks: false,
    });
    expect(resolveWeaviateConnection('read', { WEAVIATE_URL: 'http://127.0.0.1:8080', WEAVIATE_READ_API_KEY: 'r' })).toMatchObject({
      kind: 'custom',
      httpHost: '127.0.0.1',
      httpPort: 8080,
      httpSecure: false,
      grpcHost: '127.0.0.1',
      grpcPort: 50051,
      apiKey: 'r',
      skipInitChecks: true,
    });
  });

  it('the read client falls back to the write key with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = { WEAVIATE_URL: 'https://vectors.example.test', WEAVIATE_API_KEY: 'w' };
    expect(resolveWeaviateConnection('read', source).apiKey).toBe('w');
    resolveWeaviateConnection('read', source);
    expect(warn.mock.calls.filter(([line]) => String(line).includes('WEAVIATE_READ_API_KEY'))).toHaveLength(1);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('w ');
    warn.mockRestore();
  });

  it('production refuses plain http with a key', () => {
    expect(() =>
      resolveWeaviateConnection('write', { WEAVIATE_URL: 'http://vectors.example.test', WEAVIATE_API_KEY: 'w', NODE_ENV: 'production' }),
    ).toThrow(/plain http/);
    expect(() => resolveWeaviateConnection('write', { WEAVIATE_URL: '' })).toThrow(/not set/);
  });
});
