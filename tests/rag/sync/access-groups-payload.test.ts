import { describe, expect, it } from 'vitest';
import { QDRANT_PAYLOAD_INDEXES, qdrantCollectionSpec } from '@/lib/rag/backend/qdrant/collection';
import { qdrantCollectionName, weaviateCollectionName } from '@/lib/rag/backend/tenant-key';
import { weaviateCollectionSpec } from '@/lib/rag/backend/weaviate/collection';
import { createQdrantStore } from '@/lib/rag/sync/stores/qdrant';
import type { VectorPoint } from '@/lib/rag/sync/stores/types';
import { createWeaviateStore } from '@/lib/rag/sync/stores/weaviate';
import { createFakeQdrantClient } from '../backend/qdrant-fake-client';
import { createFakeWeaviate } from '../backend/weaviate-fake';

const PROFILE = 'neutral-profile-3';
const KEY_A = 'u:00000000-0000-4000-8000-0000000000a1';
const DOC = '00000000-0000-4000-8000-0000000000d1';
const GA = 'g:0a000000-0000-4000-8000-00000000a701';
const UA = 'u:0a000000-0000-4000-8000-00000000a702';

function point(n: number, accessGroups: string[] | undefined = [GA, UA]): VectorPoint {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    vector: [1, 0, 0],
    payload: {
      tenant_key: KEY_A,
      document_id: DOC,
      doc_type: 'general',
      doc_date: null,
      language: 'en',
      source: 'upload',
      chunking_profile_id: null,
      parent_id: null,
      lexical_text: 'neutral sample words',
      content_hash: 'h',
      lexical_version: 1,
      access_groups: accessGroups as string[],
    },
  };
}

describe('qdrant: access_groups filter index and payload (SEC-12, RET-10)', () => {
  it('a new collection gets a keyword index on access_groups before the first upsert', async () => {
    const client = createFakeQdrantClient();
    const store = createQdrantStore({ writeClient: client });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    await store.upsert(PROFILE, KEY_A, [point(1)]);
    const indexes = client.requests.filter((r) => r.method === 'createPayloadIndex');
    const access = indexes.find((r) => r.body.field_name === 'access_groups');
    expect(access?.body.field_schema).toEqual({ type: 'keyword' });
    const methods = client.requests.map((r) => r.method);
    expect(methods.lastIndexOf('createPayloadIndex')).toBeLessThan(methods.indexOf('upsert'));
    expect(client.collections.get(qdrantCollectionName(PROFILE))?.lateIndexes).toEqual([]);
  });

  it('an existing collection without the index gets it once, is not recreated, and a second call sends no index request', async () => {
    const client = createFakeQdrantClient();
    const name = qdrantCollectionName(PROFILE);
    await client.createCollection(name, qdrantCollectionSpec({ profileId: PROFILE, dims: 3 }));
    for (const index of QDRANT_PAYLOAD_INDEXES.filter((i) => i.field !== 'access_groups')) {
      await client.createPayloadIndex(name, { field_name: index.field, field_schema: index.schema, wait: true });
    }
    client.requests.length = 0;
    const store = createQdrantStore({ writeClient: client });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    expect(client.requests.map((r) => r.method)).not.toContain('createCollection');
    expect(client.requests.filter((r) => r.method === 'createPayloadIndex').map((r) => r.body.field_name)).toEqual(['access_groups']);
    client.requests.length = 0;
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    expect(client.requests).toHaveLength(0);
    await createQdrantStore({ writeClient: client }).ensureCollection({ profileId: PROFILE, dims: 3 });
    expect(client.requests.filter((r) => r.method === 'createPayloadIndex')).toHaveLength(0);
  });

  it('upsert writes access_groups exactly as planned', async () => {
    const client = createFakeQdrantClient();
    const store = createQdrantStore({ writeClient: client });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    await store.upsert(PROFILE, KEY_A, [point(1), point(2, ['all'])]);
    const sent = client.requests.find((r) => r.method === 'upsert')?.body as { points: Array<{ payload: Record<string, unknown> }> };
    expect(sent.points.map((p) => p.payload.access_groups)).toEqual([[GA, UA], ['all']]);
  });

  it('a point without access_groups is refused before any write', async () => {
    const client = createFakeQdrantClient();
    const store = createQdrantStore({ writeClient: client });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    await expect(store.upsert(PROFILE, KEY_A, [point(1, undefined)])).rejects.toThrow(/access_groups/);
    await expect(store.upsert(PROFILE, KEY_A, [point(1, [])])).rejects.toThrow(/access_groups/);
    expect(client.requests.some((r) => r.method === 'upsert')).toBe(false);
  });
});

describe('weaviate: access_groups filterable property and properties (SEC-12, RET-10)', () => {
  const ACCESS_PROPERTY = { name: 'access_groups', dataType: 'text[]', tokenization: 'field', indexFilterable: true, indexSearchable: false };

  it('a new collection declares access_groups as an indexFilterable text array', () => {
    const spec = weaviateCollectionSpec(PROFILE, 3);
    const props = spec.properties as Array<Record<string, unknown>>;
    expect(props.find((p) => p.name === 'access_groups')).toMatchObject(ACCESS_PROPERTY);
  });

  it('an existing collection without the property gets it once and is never recreated', async () => {
    const fake = createFakeWeaviate();
    const spec = weaviateCollectionSpec(PROFILE, 3);
    await fake.collections.create({
      ...spec,
      properties: (spec.properties as Array<Record<string, unknown>>).filter((p) => p.name !== 'access_groups'),
    });
    fake.calls.length = 0;
    const store = createWeaviateStore({ client: fake });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    const added = fake.calls.filter((c) => c.op === 'config.addProperty');
    expect(added).toHaveLength(1);
    expect(added[0].collection).toBe(weaviateCollectionName(PROFILE));
    expect(added[0].args).toMatchObject(ACCESS_PROPERTY);
    expect(fake.calls.some((c) => c.op === 'collections.create' || c.op === 'collections.delete')).toBe(false);
  });

  it('a collection created with the property gets no addProperty call', async () => {
    const fake = createFakeWeaviate();
    const store = createWeaviateStore({ client: fake });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    expect(fake.calls.filter((c) => c.op === 'config.addProperty')).toHaveLength(0);
  });

  it('upsert writes access_groups exactly as planned', async () => {
    const fake = createFakeWeaviate();
    const store = createWeaviateStore({ client: fake });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    await store.upsert(PROFILE, KEY_A, [point(1), point(2, ['all'])]);
    const insert = fake.calls.find((c) => c.op === 'insertMany')?.args as Array<{ properties: Record<string, unknown> }>;
    expect(insert.map((o) => o.properties.access_groups)).toEqual([[GA, UA], ['all']]);
  });

  it('a point without access_groups is refused before any write', async () => {
    const fake = createFakeWeaviate();
    const store = createWeaviateStore({ client: fake });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    await expect(store.upsert(PROFILE, KEY_A, [point(1, undefined)])).rejects.toThrow(/access_groups/);
    await expect(store.upsert(PROFILE, KEY_A, [point(1, [])])).rejects.toThrow(/access_groups/);
    expect(fake.calls.some((c) => c.op === 'insertMany')).toBe(false);
  });
});
