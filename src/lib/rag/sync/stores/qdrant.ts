import { createQdrantReader } from '@/lib/rag/backend/qdrant/adapter';
import type { QdrantApi } from '@/lib/rag/backend/qdrant/client';
import { qdrantErrorStatus } from '@/lib/rag/backend/qdrant/errors';
import { QDRANT_DENSE_VECTOR, describeQdrantCollection, ensureQdrantCollection } from '@/lib/rag/backend/qdrant/collection';
import {
  scopedCount,
  scopedDeleteByFilter,
  scopedDeleteIds,
  scopedScroll,
  type QdrantFilter,
  type QdrantScrollRequest,
} from '@/lib/rag/backend/qdrant/scoped-request';
import { BackendNotReadyError } from '@/lib/rag/backend/external';
import { isCanonicalTenantKey, qdrantCollectionName } from '@/lib/rag/backend/tenant-key';
import { storeScopeForTenantKey } from '@/lib/rag/tenant/store-scope';
import type {
  CollectionInfo,
  CollectionSpec,
  StoreScanPage,
  VectorPoint,
  VectorPointPayload,
  VectorStore,
} from './types';

/** The D-03 payload keys, in a fixed order; every key is written, an absent value as explicit null (Pitfall 7). */
export const QDRANT_PAYLOAD_KEYS = [
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
] as const satisfies ReadonlyArray<keyof VectorPointPayload>;

const PAGE = 256;
const DELETE_BATCH = 256;
/** RET-05 purges: document ids per points-delete and per count. */
const PURGE_BATCH = 100;
const CHUNK_COLLECTION_RE = /^myrag_chunks_[a-z0-9_-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Params<K extends keyof QdrantApi> = Parameters<QdrantApi[K]>[1];

export interface QdrantStoreDeps {
  writeClient: QdrantApi;
  /** The retrieval path's client (read key); defaults to the write client for the worker and the canary. */
  readClient?: QdrantApi;
}

function requireKey(tenantKey: string): string {
  if (!isCanonicalTenantKey(tenantKey)) throw new Error('[Vector Sync] qdrant: malformed tenant key');
  return tenantKey;
}

function fail(action: string, error: unknown): never {
  const status = qdrantErrorStatus(error);
  if (status === 404) throw new BackendNotReadyError('qdrant', 'collection_missing');
  throw new Error(`[Vector Sync] qdrant: ${action} failed (${status === null ? 'unreachable' : `http_${status}`})`);
}

function requireChunkCollection(name: string): string {
  if (typeof name !== 'string' || !CHUNK_COLLECTION_RE.test(name)) throw new Error('[Vector Sync] qdrant: not a chunk collection');
  return name;
}

function requireDocumentIds(ids: string[]): string[] {
  for (const id of ids) if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('[Vector Sync] qdrant: invalid document id');
  return ids;
}

function documentAny(ids: string[]): QdrantFilter {
  return { must: [{ key: 'document_id', match: { any: [...ids] } }] };
}

export function qdrantPayload(payload: VectorPointPayload): Record<(typeof QDRANT_PAYLOAD_KEYS)[number], string | number | null> {
  const out = {} as Record<(typeof QDRANT_PAYLOAD_KEYS)[number], string | number | null>;
  for (const key of QDRANT_PAYLOAD_KEYS) {
    const value = payload[key];
    out[key] = value === undefined ? null : value;
  }
  return out;
}

/** VectorStore over one shared collection per embedding profile; every data call is built by a scoped builder (D-08). */
export function createQdrantStore(deps: QdrantStoreDeps): VectorStore {
  const write = deps.writeClient;
  const reader = createQdrantReader(deps.readClient ?? deps.writeClient);
  const ensured = new Map<string, number>();

  async function scrollIds(profileId: string, tenantKey: string, request: QdrantScrollRequest): Promise<string[]> {
    const scope = storeScopeForTenantKey(requireKey(tenantKey));
    const ids: string[] = [];
    let offset: string | number | null = null;
    for (;;) {
      const body = scopedScroll(scope, { ...request, limit: PAGE, offset, with_payload: false, with_vector: false });
      let page: Awaited<ReturnType<QdrantApi['scroll']>>;
      try {
        page = await write.scroll(qdrantCollectionName(profileId), body as Params<'scroll'>);
      } catch (error) {
        fail('scroll', error);
      }
      for (const point of page.points) ids.push(String(point.id));
      const next = page.next_page_offset;
      if (next === null || next === undefined || page.points.length === 0) return ids;
      offset = typeof next === 'object' ? String(next) : next;
    }
  }

  async function countIn(collection: string, tenantKey: string, filter: QdrantFilter | undefined): Promise<number> {
    const scope = storeScopeForTenantKey(requireKey(tenantKey));
    const body = scopedCount(scope, { ...(filter ? { filter } : {}), exact: true });
    try {
      const result = await write.count(collection, body as Params<'count'>);
      return result.count;
    } catch (error) {
      fail('count', error);
    }
  }

  async function countWhere(profileId: string, tenantKey: string, filter: QdrantFilter | undefined): Promise<number> {
    return countIn(qdrantCollectionName(profileId), tenantKey, filter);
  }

  /** A purge sweeps collections the worker may never have ensured; a missing one holds nothing. */
  async function orZero(run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof BackendNotReadyError && error.reason === 'collection_missing') return 0;
      throw error;
    }
  }

  async function purgeCount(collection: string, tenantKey: string, documentIds: string[]): Promise<number> {
    let total = 0;
    for (let i = 0; i < documentIds.length; i += PURGE_BATCH) {
      total += await countIn(collection, tenantKey, documentAny(documentIds.slice(i, i + PURGE_BATCH)));
    }
    return total;
  }

  async function deleteIdList(profileId: string, tenantKey: string, ids: string[]): Promise<number> {
    const scope = storeScopeForTenantKey(requireKey(tenantKey));
    let deleted = 0;
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      const slice = ids.slice(i, i + DELETE_BATCH);
      const present = await countWhere(profileId, tenantKey, { must: [{ has_id: slice }] });
      if (present === 0) continue;
      const body = scopedDeleteIds(scope, slice);
      try {
        await write.delete(qdrantCollectionName(profileId), { ...(body as object), wait: true } as Params<'delete'>);
      } catch (error) {
        fail('delete', error);
      }
      deleted += present;
    }
    return deleted;
  }

  return {
    target: 'qdrant',
    async ensureCollection(spec: CollectionSpec): Promise<void> {
      await ensureQdrantCollection(write, spec, ensured);
    },
    async describeCollection(profileId: string): Promise<CollectionInfo | null> {
      return describeQdrantCollection(write, profileId);
    },
    async ensureTenant(profileId: string, tenantKey: string): Promise<void> {
      requireKey(tenantKey);
      if (!ensured.has(profileId) && (await describeQdrantCollection(write, profileId)) === null) {
        throw new BackendNotReadyError('qdrant', 'collection_missing');
      }
    },
    async upsert(profileId: string, tenantKey: string, points: VectorPoint[]): Promise<number> {
      requireKey(tenantKey);
      if (points.length === 0) return 0;
      const body = points.map((point) => {
        if (point.payload.tenant_key !== tenantKey) throw new Error('[Vector Sync] qdrant: point tenant differs from the call');
        return { id: point.id, vector: { [QDRANT_DENSE_VECTOR]: [...point.vector] }, payload: qdrantPayload(point.payload) };
      });
      try {
        await write.upsert(qdrantCollectionName(profileId), { wait: true, points: body });
      } catch (error) {
        fail('upsert', error);
      }
      return points.length;
    },
    async deleteIds(profileId: string, tenantKey: string, ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;
      return deleteIdList(profileId, tenantKey, ids);
    },
    async deleteDocument(profileId: string, tenantKey: string, documentId: string): Promise<number> {
      const scope = storeScopeForTenantKey(requireKey(tenantKey));
      const filter: QdrantFilter = { must: [{ key: 'document_id', match: { value: documentId } }] };
      const present = await countWhere(profileId, tenantKey, filter);
      if (present === 0) return 0;
      const body = scopedDeleteByFilter(scope, filter);
      try {
        await write.delete(qdrantCollectionName(profileId), { ...(body as object), wait: true } as Params<'delete'>);
      } catch (error) {
        fail('delete', error);
      }
      return present;
    },
    /** By id pages, never by a tenant-only filter: scopedDeleteByFilter refuses a filter without a condition of its own. */
    async deleteTenant(profileId: string, tenantKey: string): Promise<number> {
      const ids = await scrollIds(profileId, tenantKey, {});
      return ids.length === 0 ? 0 : deleteIdList(profileId, tenantKey, ids);
    },
    async listDocumentIds(profileId: string, tenantKey: string, documentId: string): Promise<string[]> {
      const ids = await scrollIds(profileId, tenantKey, { filter: { must: [{ key: 'document_id', match: { value: documentId } }] } });
      return ids.sort();
    },
    async scanTenant(profileId: string, tenantKey: string, page: { after: string | null; limit: number }): Promise<StoreScanPage> {
      const scope = storeScopeForTenantKey(requireKey(tenantKey));
      const body = scopedScroll(scope, {
        limit: page.limit,
        offset: page.after,
        with_payload: ['document_id', 'content_hash', 'lexical_version'],
        with_vector: false,
      });
      let result: Awaited<ReturnType<QdrantApi['scroll']>>;
      try {
        result = await write.scroll(qdrantCollectionName(profileId), body as Params<'scroll'>);
      } catch (error) {
        fail('scroll', error);
      }
      const points = result.points.map((point) => {
        const payload = (point.payload ?? {}) as Record<string, unknown>;
        return {
          id: String(point.id),
          documentId: String(payload.document_id ?? ''),
          contentHash: typeof payload.content_hash === 'string' ? payload.content_hash : null,
          lexicalVersion: typeof payload.lexical_version === 'number' ? payload.lexical_version : null,
        };
      });
      const next = result.next_page_offset;
      return { points, next: next === null || next === undefined || points.length === 0 ? null : String(next) };
    },
    async count(profileId: string, tenantKey: string): Promise<number> {
      return countWhere(profileId, tenantKey, undefined);
    },
    async listCollections(): Promise<string[]> {
      let result: Awaited<ReturnType<QdrantApi['getCollections']>>;
      try {
        result = await write.getCollections();
      } catch (error) {
        fail('list_collections', error);
      }
      return result.collections.map((c) => c.name).filter((name) => CHUNK_COLLECTION_RE.test(name)).sort();
    },
    async deleteDocuments(collection: string, tenantKey: string, documentIds: string[]): Promise<number> {
      const name = requireChunkCollection(collection);
      const scope = storeScopeForTenantKey(requireKey(tenantKey));
      const ids = requireDocumentIds(documentIds);
      return orZero(async () => {
        let deleted = 0;
        for (let i = 0; i < ids.length; i += PURGE_BATCH) {
          const filter = documentAny(ids.slice(i, i + PURGE_BATCH));
          const present = await countIn(name, tenantKey, filter);
          if (present === 0) continue;
          const body = scopedDeleteByFilter(scope, filter);
          try {
            await write.delete(name, { ...(body as object), wait: true } as Params<'delete'>);
          } catch (error) {
            fail('delete', error);
          }
          deleted += present;
        }
        return deleted;
      });
    },
    async countDocumentPoints(collection: string, tenantKey: string, documentIds: string[]): Promise<number> {
      const name = requireChunkCollection(collection);
      requireKey(tenantKey);
      const ids = requireDocumentIds(documentIds);
      return orZero(() => purgeCount(name, tenantKey, ids));
    },
    searchLegs: (req) => reader.searchLegs(req),
    health: () => reader.health(),
  };
}
