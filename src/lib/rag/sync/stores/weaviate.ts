import { tenantCollection, searchWeaviateLegs, weaviateDate } from '@/lib/rag/backend/weaviate/adapter';
import {
  countWeaviateTenants,
  describeWeaviateCollection,
  ensureWeaviateCollection,
  ensureWeaviateTenant,
} from '@/lib/rag/backend/weaviate/collection';
import { mapWeaviateError } from '@/lib/rag/backend/weaviate/errors';
import type { WeaviateClientLike, WeaviateFilterValue, WeaviateTenantCollection } from '@/lib/rag/backend/weaviate/types';
import { BackendNotReadyError } from '@/lib/rag/backend/external';
import { RetrievalBackendError } from '@/lib/rag/backend/supabase-rpc';
import { isCanonicalTenantKey, weaviateCollectionName, weaviateTenantName } from '@/lib/rag/backend/tenant-key';
import type {
  CollectionInfo,
  CollectionSpec,
  StoreHealth,
  StoreLegs,
  StoreScanPage,
  StoreSearchRequest,
  VectorPoint,
  VectorPointPayload,
  VectorStore,
} from './types';

export interface WeaviateStoreOptions {
  /** The write client for the worker; retrieval uses the read client through the adapter. */
  client: WeaviateClientLike;
  /** Pitfall 13: deleteMany removes at most QUERY_MAXIMUM_RESULTS per call, so deletes loop; this caps the loop. */
  maxDeleteRounds?: number;
  pageSize?: number;
}

/** D-03: the only properties an object carries. A null field is left out (Weaviate stores absent as null). */
const PAYLOAD_FIELDS: readonly (keyof VectorPointPayload)[] = [
  'tenant_key',
  'document_id',
  'doc_type',
  'doc_date',
  'language',
  'source',
  'chunking_profile_id',
  'parent_id',
  'lexical_text',
  'content_hash',
  'lexical_version',
];

/** RET-05 purges: document ids per deleteMany filter and per count. */
const PURGE_BATCH = 100;
const CHUNK_COLLECTION_PREFIX = 'Myrag_chunks_';
const CHUNK_COLLECTION_RE = /^Myrag_chunks_[A-Za-z0-9_]{1,160}$/;

function requireChunkCollection(name: string): string {
  if (typeof name !== 'string' || !CHUNK_COLLECTION_RE.test(name)) throw new Error('[Vector Sync] weaviate store: not a chunk collection');
  return name;
}

function and(filters: WeaviateFilterValue[]): WeaviateFilterValue {
  return { operator: 'And', filters, value: null };
}

function requireKey(tenantKey: string): string {
  if (!isCanonicalTenantKey(tenantKey)) throw new Error('[Vector Sync] weaviate store: malformed tenant key');
  return tenantKey;
}

function toProperties(payload: VectorPointPayload): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of PAYLOAD_FIELDS) {
    const value = payload[field];
    if (value === null || value === undefined) continue;
    properties[field] = field === 'doc_date' ? weaviateDate(String(value)) : value;
  }
  return properties;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * VectorStore over Weaviate (D-06, D-07): one collection per profile, one tenant per workspace. Every data call starts from
 * tenantCollection; collection and tenant creation are the only tenant-less calls. A missing tenant reads as empty and deletes
 * as zero, as in the fake store; a search on it is "not ready".
 */
export function createWeaviateStore(options: WeaviateStoreOptions): VectorStore {
  const { client } = options;
  const maxDeleteRounds = options.maxDeleteRounds ?? 1000;
  const pageSize = options.pageSize ?? 1000;
  const knownTenants = new Set<string>();

  function shard(profileId: string, tenantKey: string): WeaviateTenantCollection {
    return tenantCollection(client, requireKey(tenantKey), profileId);
  }

  function memoKey(profileId: string, tenantKey: string): string {
    return `${weaviateCollectionName(profileId)}/${weaviateTenantName(requireKey(tenantKey))}`;
  }

  async function ensureTenant(profileId: string, tenantKey: string): Promise<void> {
    const memo = memoKey(profileId, tenantKey);
    if (knownTenants.has(memo)) return;
    await ensureWeaviateTenant(client, profileId, tenantKey);
    knownTenants.add(memo);
  }

  /** A tenant removed behind the worker's back is created again on the drain's retry. */
  function forgetOnNotReady(error: Error, profileId: string, tenantKey: string): Error {
    if (error instanceof BackendNotReadyError) knownTenants.delete(memoKey(profileId, tenantKey));
    return error;
  }

  /** A missing tenant holds nothing; any other error surfaces. */
  async function orEmpty<T>(operation: string, empty: T, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const mapped = mapWeaviateError(error, operation);
      if (mapped instanceof BackendNotReadyError && mapped.reason === 'tenant_missing') return empty;
      throw mapped;
    }
  }

  async function deleteLoop(col: WeaviateTenantCollection, filter: WeaviateFilterValue): Promise<number> {
    let deleted = 0;
    for (let round = 0; round < maxDeleteRounds; round += 1) {
      const result = await col.data.deleteMany(filter, { dryRun: false, verbose: false });
      if (result.failed > 0) throw new RetrievalBackendError('weaviate.delete', 'delete_failed');
      deleted += result.successful;
      if (result.matches === 0 || result.successful === 0) return deleted;
    }
    throw new RetrievalBackendError('weaviate.delete', 'delete_incomplete');
  }

  async function deleteWhere(profileId: string, tenantKey: string, where: (col: WeaviateTenantCollection) => WeaviateFilterValue): Promise<number> {
    return orEmpty('delete', 0, async () => {
      const col = shard(profileId, tenantKey);
      return deleteLoop(col, where(col));
    });
  }

  /** A purge names the collection by its listed name; the data path is still only the tenant handle (D-07). */
  function namedShard(collection: string, tenantKey: string): WeaviateTenantCollection {
    return client.collections.use(requireChunkCollection(collection)).withTenant(weaviateTenantName(requireKey(tenantKey)));
  }

  /** The tenant_key clause guards against a shard answering for another tenant; the purge ids are the document filter. */
  function purgeFilter(col: WeaviateTenantCollection, tenantKey: string, documentIds: string[]): WeaviateFilterValue {
    return and([col.filter.byProperty('tenant_key').equal(tenantKey), col.filter.byProperty('document_id').containsAny([...documentIds])]);
  }

  /** A missing tenant or a missing collection holds nothing for a purge. */
  async function orZero(operation: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      const mapped = mapWeaviateError(error, operation);
      if (mapped instanceof BackendNotReadyError && (mapped.reason === 'tenant_missing' || mapped.reason === 'collection_missing')) return 0;
      throw mapped;
    }
  }

  return {
    target: 'weaviate',
    async ensureCollection(spec: CollectionSpec): Promise<void> {
      await ensureWeaviateCollection(client, spec.profileId, spec.dims);
    },
    async describeCollection(profileId: string): Promise<CollectionInfo | null> {
      const state = await describeWeaviateCollection(client, profileId);
      if (!state.exists || state.dims === null) return null;
      return { profileId, dims: state.dims, tenants: await countWeaviateTenants(client, profileId) };
    },
    ensureTenant,
    async upsert(profileId: string, tenantKey: string, points: VectorPoint[]): Promise<number> {
      requireKey(tenantKey);
      if (points.length === 0) return 0;
      for (const point of points) {
        if (point.payload.tenant_key !== tenantKey) throw new Error('[Vector Sync] weaviate store: point tenant differs from tenant');
      }
      await ensureTenant(profileId, tenantKey);
      let result;
      try {
        result = await shard(profileId, tenantKey).data.insertMany(
          points.map((point) => ({ id: point.id, properties: toProperties(point.payload), vectors: [...point.vector] })),
        );
      } catch (error) {
        throw forgetOnNotReady(mapWeaviateError(error, 'upsert'), profileId, tenantKey);
      }
      if (result.hasErrors) {
        const first = Object.values(result.errors)[0];
        const mapped = forgetOnNotReady(mapWeaviateError(new Error(first?.message ?? ''), 'upsert'), profileId, tenantKey);
        if (mapped instanceof BackendNotReadyError) throw mapped;
        if (mapped instanceof RetrievalBackendError && mapped.code === 'permission_denied') throw mapped;
        throw new RetrievalBackendError('weaviate.upsert', 'upsert_failed');
      }
      return points.length;
    },
    async deleteIds(profileId: string, tenantKey: string, ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;
      return deleteWhere(profileId, tenantKey, (col) => col.filter.byId().containsAny([...ids]));
    },
    async deleteDocument(profileId: string, tenantKey: string, documentId: string): Promise<number> {
      return deleteWhere(profileId, tenantKey, (col) => col.filter.byProperty('document_id').equal(documentId));
    },
    async deleteTenant(profileId: string, tenantKey: string): Promise<number> {
      return deleteWhere(profileId, tenantKey, (col) => col.filter.byProperty('tenant_key').equal(tenantKey));
    },
    async listDocumentIds(profileId: string, tenantKey: string, documentId: string): Promise<string[]> {
      return orEmpty('list_document', [] as string[], async () => {
        const col = shard(profileId, tenantKey);
        const filters = col.filter.byProperty('document_id').equal(documentId);
        const ids: string[] = [];
        for (let offset = 0; ; offset += pageSize) {
          const page = await col.query.fetchObjects({ limit: pageSize, offset, filters, returnProperties: ['document_id'] });
          for (const object of page.objects) ids.push(object.uuid);
          if (page.objects.length < pageSize) break;
        }
        return [...new Set(ids)].sort();
      });
    },
    async scanTenant(profileId: string, tenantKey: string, page: { after: string | null; limit: number }): Promise<StoreScanPage> {
      return orEmpty('scan', { points: [], next: null } as StoreScanPage, async () => {
        const col = shard(profileId, tenantKey);
        const limit = Math.max(1, page.limit);
        const result = await col.query.fetchObjects({
          limit: limit + 1,
          ...(page.after ? { after: page.after } : {}),
          returnProperties: ['document_id', 'content_hash', 'lexical_version'],
        });
        const slice = result.objects.slice(0, limit);
        return {
          points: slice.map((object) => ({
            id: object.uuid,
            documentId: stringOrNull(object.properties?.document_id) ?? '',
            contentHash: stringOrNull(object.properties?.content_hash),
            lexicalVersion: numberOrNull(object.properties?.lexical_version),
          })),
          next: result.objects.length > limit && slice.length > 0 ? slice[slice.length - 1].uuid : null,
        };
      });
    },
    async count(profileId: string, tenantKey: string): Promise<number> {
      return orEmpty('count', 0, async () => (await shard(profileId, tenantKey).aggregate.overAll()).totalCount);
    },
    async listCollections(): Promise<string[]> {
      try {
        return (await client.collections.listAll())
          .map((c) => c.name)
          .filter((name) => name.startsWith(CHUNK_COLLECTION_PREFIX) && CHUNK_COLLECTION_RE.test(name))
          .sort();
      } catch (error) {
        throw mapWeaviateError(error, 'list_collections');
      }
    },
    async deleteDocuments(collection: string, tenantKey: string, documentIds: string[]): Promise<number> {
      const col = namedShard(collection, tenantKey);
      if (documentIds.length === 0) return 0;
      return orZero('purge_delete', async () => {
        let deleted = 0;
        for (let i = 0; i < documentIds.length; i += PURGE_BATCH) {
          deleted += await deleteLoop(col, purgeFilter(col, tenantKey, documentIds.slice(i, i + PURGE_BATCH)));
        }
        return deleted;
      });
    },
    async countDocumentPoints(collection: string, tenantKey: string, documentIds: string[]): Promise<number> {
      const col = namedShard(collection, tenantKey);
      if (documentIds.length === 0) return 0;
      return orZero('purge_count', async () => {
        let total = 0;
        for (let i = 0; i < documentIds.length; i += PURGE_BATCH) {
          total += (await col.aggregate.overAll({ filters: purgeFilter(col, tenantKey, documentIds.slice(i, i + PURGE_BATCH)) })).totalCount;
        }
        return total;
      });
    },
    searchLegs(req: StoreSearchRequest): Promise<StoreLegs> {
      return searchWeaviateLegs(client, req);
    },
    async health(): Promise<StoreHealth> {
      try {
        return (await client.isReady()) ? { ok: true } : { ok: false, detail: 'not_ready' };
      } catch {
        return { ok: false, detail: 'unreachable' };
      }
    },
  };
}
