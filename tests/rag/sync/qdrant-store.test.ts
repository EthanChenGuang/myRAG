import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendNotReadyError } from '@/lib/rag/backend/external';
import { buildQdrantClients, resetQdrantClientsForTests } from '@/lib/rag/backend/qdrant/client';
import { QDRANT_PAYLOAD_INDEXES, qdrantCollectionSpec } from '@/lib/rag/backend/qdrant/collection';
import { assertScoped } from '@/lib/rag/backend/qdrant/scoped-request';
import { qdrantCollectionName } from '@/lib/rag/backend/tenant-key';
import { createQdrantStore, QDRANT_PAYLOAD_KEYS } from '@/lib/rag/sync/stores/qdrant';
import type { VectorPoint, VectorPointPayload } from '@/lib/rag/sync/stores/types';
import { mintScope } from '@/lib/rag/tenant/scope';
import { storeScopeForTenantKey } from '@/lib/rag/tenant/store-scope';
import { createFakeQdrantClient, scopedBodyOf, type FakeQdrantClient } from '../backend/qdrant-fake-client';

const PROFILE = 'neutral-profile-3';
const COLLECTION = qdrantCollectionName(PROFILE);
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const KEY_A = `u:${USER_A}`;
const KEY_B = `u:${USER_B}`;
const DOC_SHARED = '00000000-0000-4000-8000-0000000000d1';
const DOC_A_ONLY = '00000000-0000-4000-8000-0000000000d2';

function pointId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function payload(tenantKey: string, documentId: string, extra: Partial<VectorPointPayload> = {}): VectorPointPayload {
  return {
    tenant_key: tenantKey,
    document_id: documentId,
    doc_type: 'general',
    doc_date: '2025-03-01',
    language: 'en',
    source: 'upload',
    chunking_profile_id: null,
    parent_id: null,
    lexical_text: 'neutral sample words',
    content_hash: `hash-${documentId.slice(-2)}`,
    lexical_version: 1,
    ...extra,
  };
}

function point(n: number, tenantKey: string, documentId: string, extra: Partial<VectorPointPayload> = {}): VectorPoint {
  return { id: pointId(n), vector: [1, 0, 0], payload: payload(tenantKey, documentId, extra) };
}

async function seededStore(): Promise<{ client: FakeQdrantClient; store: ReturnType<typeof createQdrantStore> }> {
  const client = createFakeQdrantClient();
  const store = createQdrantStore({ writeClient: client });
  await store.ensureCollection({ profileId: PROFILE, dims: 3 });
  await store.upsert(PROFILE, KEY_A, [point(1, KEY_A, DOC_SHARED), point(2, KEY_A, DOC_SHARED), point(3, KEY_A, DOC_A_ONLY)]);
  await store.upsert(PROFILE, KEY_B, [point(11, KEY_B, DOC_SHARED), point(12, KEY_B, DOC_SHARED)]);
  return { client, store };
}

function idsIn(client: FakeQdrantClient): string[] {
  return [...(client.collections.get(COLLECTION)?.points.keys() ?? [])].sort();
}

afterEach(() => {
  resetQdrantClientsForTests();
  vi.restoreAllMocks();
});

describe('qdrant collection setup', () => {
  it('creates the collection, then every payload index with tenant_key first, before any point', async () => {
    const client = createFakeQdrantClient();
    const store = createQdrantStore({ writeClient: client });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    const methods = client.requests.map((r) => r.method);
    expect(methods).toEqual(['getCollection', 'createCollection', ...QDRANT_PAYLOAD_INDEXES.map(() => 'createPayloadIndex')]);
    const create = client.requests[1].body;
    expect(create).toEqual(qdrantCollectionSpec({ profileId: PROFILE, dims: 3 }));
    expect(create.vectors).toEqual({ dense: { size: 3, distance: 'Cosine' } });
    expect(create.hnsw_config).toEqual({ m: 64, ef_construct: 200 });
    expect(create).not.toHaveProperty('quantization_config');
    expect(create.strict_mode_config).toEqual({ enabled: true, unindexed_filtering_retrieve: false, unindexed_filtering_update: false });
    expect(create.metadata).toEqual({
      profile_id: PROFILE,
      dims: 3,
      lexical_mode: 'text_bm25',
      hnsw: { m: 64, ef_construct: 200 },
      lexical_bm25: { k1: 1.2, b: 0.75 },
    });
    const indexes = client.requests.slice(2).map((r) => [r.body.field_name, r.body.field_schema]);
    expect(indexes[0]).toEqual(['tenant_key', { type: 'keyword', is_tenant: true }]);
    expect(indexes.map(([field]) => field)).toEqual([
      'tenant_key',
      'document_id',
      'doc_type',
      'language',
      'source',
      'chunking_profile_id',
      'parent_id',
      'doc_date',
      'lexical_text',
    ]);
    expect(Object.fromEntries(indexes)).toMatchObject({
      doc_date: { type: 'datetime' },
      lexical_text: { type: 'text', tokenizer: 'whitespace', lowercase: false, scoring: { type: 'bm25' } },
    });
    for (const r of client.requests.slice(2)) expect(r.body.wait).toBe(true);
  });

  it('a second ensure on the same store sends nothing; a new store checks with getCollection and creates nothing', async () => {
    const client = createFakeQdrantClient();
    await createQdrantStore({ writeClient: client }).ensureCollection({ profileId: PROFILE, dims: 3 });
    const store = createQdrantStore({ writeClient: client });
    client.requests.length = 0;
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    expect(client.requests.map((r) => r.method)).toEqual(['getCollection']);
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    expect(client.requests).toHaveLength(1);
  });

  it('adds only the missing indexes to a collection left half set up, and refuses other dims', async () => {
    const client = createFakeQdrantClient();
    await client.createCollection(COLLECTION, qdrantCollectionSpec({ profileId: PROFILE, dims: 3 }));
    await client.createPayloadIndex(COLLECTION, { field_name: 'tenant_key', field_schema: { type: 'keyword', is_tenant: true } });
    client.requests.length = 0;
    await createQdrantStore({ writeClient: client }).ensureCollection({ profileId: PROFILE, dims: 3 });
    expect(client.requests.filter((r) => r.method === 'createPayloadIndex').map((r) => r.body.field_name)).toEqual(
      QDRANT_PAYLOAD_INDEXES.slice(1).map((i) => i.field),
    );
    await expect(createQdrantStore({ writeClient: client }).ensureCollection({ profileId: PROFILE, dims: 4 })).rejects.toThrow(/dims differ/);
  });

  it('describeCollection reads dims and lexical mode; a missing collection is null', async () => {
    const client = createFakeQdrantClient();
    const store = createQdrantStore({ writeClient: client });
    expect(await store.describeCollection(PROFILE)).toBeNull();
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    expect(await store.describeCollection(PROFILE)).toEqual({
      profileId: PROFILE,
      dims: 3,
      tenants: null,
      lexicalMode: 'text_bm25',
      lexicalParams: { k1: 1.2, b: 0.75 },
    });
  });

  it('never writes a point into a collection before its indexes exist', async () => {
    const { client } = await seededStore();
    expect(client.collections.get(COLLECTION)?.lateIndexes).toEqual([]);
  });
});

describe('qdrant store writes', () => {
  it('upsert writes id = chunk id, the vector under dense and exactly the D-03 payload keys, absent values as null', async () => {
    const client = createFakeQdrantClient();
    const store = createQdrantStore({ writeClient: client });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    const loose = { ...payload(KEY_A, DOC_A_ONLY), doc_date: undefined, extra_field: 'not D-03' } as unknown as VectorPointPayload;
    expect(await store.upsert(PROFILE, KEY_A, [{ id: pointId(5), vector: [0, 1, 0], payload: loose }])).toBe(1);
    const sent = client.requests.find((r) => r.method === 'upsert')?.body as { wait: boolean; points: Array<Record<string, unknown>> };
    expect(sent.wait).toBe(true);
    expect(sent.points).toHaveLength(1);
    expect(sent.points[0].id).toBe(pointId(5));
    expect(sent.points[0].vector).toEqual({ dense: [0, 1, 0] });
    const written = sent.points[0].payload as Record<string, unknown>;
    expect(Object.keys(written)).toEqual([...QDRANT_PAYLOAD_KEYS]);
    expect(written.doc_date).toBeNull();
    expect(written).not.toHaveProperty('extra_field');
  });

  it('refuses a point whose payload tenant differs from the call, and a malformed tenant key', async () => {
    const client = createFakeQdrantClient();
    const store = createQdrantStore({ writeClient: client });
    await store.ensureCollection({ profileId: PROFILE, dims: 3 });
    await expect(store.upsert(PROFILE, KEY_A, [point(1, KEY_B, DOC_SHARED)])).rejects.toThrow(/tenant differs/);
    await expect(store.count(PROFILE, `u:${USER_A.toUpperCase()}`)).rejects.toThrow(/malformed tenant key/);
    expect(client.requests.some((r) => r.method === 'upsert' || r.method === 'count')).toBe(false);
  });

  it('every request the store sends is scoped (assertScoped), upserts carry only the call tenant', async () => {
    const { client, store } = await seededStore();
    client.requests.length = 0;
    const scope = mintScope('personal', USER_A, null);
    await store.searchLegs({
      scope,
      profileId: PROFILE,
      denseVector: [1, 0, 0],
      lexicalTokens: ['neutral'],
      denseLimit: 5,
      lexicalLimit: 5,
      filters: { currentOnly: true, docTypes: ['general'] },
      signal: new AbortController().signal,
    });
    await store.listDocumentIds(PROFILE, KEY_A, DOC_SHARED);
    await store.scanTenant(PROFILE, KEY_A, { after: null, limit: 2 });
    await store.count(PROFILE, KEY_A);
    await store.deleteIds(PROFILE, KEY_A, [pointId(1)]);
    await store.deleteDocument(PROFILE, KEY_A, DOC_A_ONLY);
    await store.upsert(PROFILE, KEY_A, [point(4, KEY_A, DOC_A_ONLY)]);
    await store.deleteTenant(PROFILE, KEY_A);
    const data = client.requests.filter((r) => ['queryBatch', 'scroll', 'count', 'delete'].includes(r.method));
    expect(new Set(data.map((r) => r.method))).toEqual(new Set(['queryBatch', 'scroll', 'count', 'delete']));
    for (const request of data) {
      expect(() => assertScoped(scopedBodyOf(request), scope), `${request.method} ${JSON.stringify(request.body)}`).not.toThrow();
    }
    for (const request of client.requests.filter((r) => r.method === 'upsert')) {
      for (const p of (request.body as { points: Array<{ payload: { tenant_key: string } }> }).points) expect(p.payload.tenant_key).toBe(KEY_A);
    }
    const allowed = new Set(['queryBatch', 'scroll', 'count', 'delete', 'upsert']);
    expect(client.requests.filter((r) => !allowed.has(r.method))).toEqual([]);
  });

  it('two-tenant: scans, lists and counts return only the tenant; deletes leave every other tenant point in place', async () => {
    const { client, store } = await seededStore();
    const scanned: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await store.scanTenant(PROFILE, KEY_A, { after, limit: 2 });
      scanned.push(...page.points.map((p) => p.id));
      if (page.next === null) break;
      after = page.next;
    }
    expect(scanned).toEqual([pointId(1), pointId(2), pointId(3)]);
    expect(await store.listDocumentIds(PROFILE, KEY_A, DOC_SHARED)).toEqual([pointId(1), pointId(2)]);
    expect(await store.count(PROFILE, KEY_A)).toBe(3);
    expect(await store.count(PROFILE, KEY_B)).toBe(2);

    expect(await store.deleteIds(PROFILE, KEY_A, [pointId(11), pointId(1)])).toBe(1);
    expect(idsIn(client)).toEqual([pointId(2), pointId(3), pointId(11), pointId(12)]);
    expect(await store.deleteDocument(PROFILE, KEY_A, DOC_SHARED)).toBe(1);
    expect(idsIn(client)).toEqual([pointId(3), pointId(11), pointId(12)]);
    expect(await store.deleteTenant(PROFILE, KEY_A)).toBe(1);
    expect(idsIn(client)).toEqual([pointId(11), pointId(12)]);
    expect(await store.count(PROFILE, KEY_B)).toBe(2);
    expect(await store.deleteDocument(PROFILE, KEY_A, DOC_SHARED)).toBe(0);
  });

  it('scan pages carry document id, content hash and lexical version only', async () => {
    const { store } = await seededStore();
    const page = await store.scanTenant(PROFILE, KEY_B, { after: null, limit: 10 });
    expect(page).toEqual({
      points: [
        { id: pointId(11), documentId: DOC_SHARED, contentHash: 'hash-d1', lexicalVersion: 1 },
        { id: pointId(12), documentId: DOC_SHARED, contentHash: 'hash-d1', lexicalVersion: 1 },
      ],
      next: null,
    });
  });

  it('a missing collection reads as not ready', async () => {
    const client = createFakeQdrantClient();
    const store = createQdrantStore({ writeClient: client });
    await expect(store.count(PROFILE, KEY_A)).rejects.toBeInstanceOf(BackendNotReadyError);
    await expect(store.ensureTenant(PROFILE, KEY_A)).rejects.toBeInstanceOf(BackendNotReadyError);
  });

  it('storeScopeForTenantKey mints the scope of every canonical key and refuses anything else', () => {
    expect(() => storeScopeForTenantKey('s:default')).not.toThrow();
    expect(() => storeScopeForTenantKey(`o:${USER_B}`)).not.toThrow();
    expect(() => storeScopeForTenantKey(KEY_A)).not.toThrow();
    for (const bad of [`u:${USER_A.toUpperCase()}`, 'u:not-a-uuid', '', 's:other', ` ${KEY_A}`]) {
      expect(() => storeScopeForTenantKey(bad)).toThrow(/malformed tenant key/);
    }
  });
});

describe('qdrant client factory', () => {
  const capture = () => {
    const built: Array<Record<string, unknown>> = [];
    const construct = (options: unknown) => {
      built.push(options as Record<string, unknown>);
      return createFakeQdrantClient();
    };
    return { built, construct };
  };

  it('refuses plain http in production while a key is set', () => {
    const { construct } = capture();
    expect(() =>
      buildQdrantClients({ url: 'http://qdrant.internal:6333', apiKey: 'placeholder-write', readApiKey: '', nodeEnv: 'production' }, { construct }),
    ).toThrow(/https in production/);
    expect(() =>
      buildQdrantClients({ url: 'http://qdrant.internal:6333', apiKey: '', readApiKey: 'placeholder-read', nodeEnv: 'production' }, { construct }),
    ).toThrow(/https in production/);
    expect(() =>
      buildQdrantClients({ url: 'https://qdrant.internal', apiKey: 'placeholder-write', readApiKey: '', nodeEnv: 'production' }, { construct }),
    ).not.toThrow();
  });

  it('builds a read and a write client without the version check; no read key falls back to the write key with one warning', () => {
    const { built, construct } = capture();
    const warn = vi.fn();
    buildQdrantClients({ url: 'http://127.0.0.1:6333/', apiKey: 'placeholder-write', readApiKey: '', nodeEnv: 'test' }, { construct, warn });
    buildQdrantClients({ url: 'http://127.0.0.1:6333/', apiKey: 'placeholder-write', readApiKey: '', nodeEnv: 'test' }, { construct, warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[RAG Config\] QDRANT_READ_API_KEY/);
    expect(String(warn.mock.calls[0][0])).not.toContain('placeholder-write');
    expect(built[0]).toMatchObject({ url: 'http://127.0.0.1:6333', apiKey: 'placeholder-write', checkCompatibility: false });
    expect(built[1]).toMatchObject({ apiKey: 'placeholder-write', checkCompatibility: false });
    expect(typeof built[0].timeout).toBe('number');
    built.length = 0;
    buildQdrantClients({ url: 'http://127.0.0.1:6333', apiKey: 'placeholder-write', readApiKey: 'placeholder-read', nodeEnv: 'test' }, { construct, warn });
    expect(built[0].apiKey).toBe('placeholder-read');
    expect(built[1].apiKey).toBe('placeholder-write');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty or malformed URL', () => {
    const { construct } = capture();
    expect(() => buildQdrantClients({ url: '', apiKey: '', readApiKey: '', nodeEnv: 'test' }, { construct })).toThrow(/QDRANT_URL is not set/);
    expect(() => buildQdrantClients({ url: 'not a url', apiKey: '', readApiKey: '', nodeEnv: 'test' }, { construct })).toThrow(/valid URL/);
    expect(() => buildQdrantClients({ url: 'ftp://host', apiKey: '', readApiKey: '', nodeEnv: 'test' }, { construct })).toThrow(/http or https/);
  });
});
