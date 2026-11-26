import { BackendNotReadyError } from '@/lib/rag/backend/external';
import { canonicalTenantKey, isCanonicalTenantKey } from '@/lib/rag/backend/tenant-key';
import type { RetrievalFilters } from '@/lib/rag/backend/types';
import type {
  CollectionInfo,
  CollectionSpec,
  StoreHealth,
  StoreHit,
  StoreLegs,
  StoreScanPage,
  StoreSearchRequest,
  VectorPoint,
  VectorStore,
  VectorSyncTarget,
} from './types';

interface FakeCollection {
  dims: number;
  tenants: Map<string, Map<string, VectorPoint>>;
}

export interface FakeVectorStore extends VectorStore {
  /** Test-only: plants a point without the drain (a foreign or stale point the re-validation must drop). */
  plant(profileId: string, tenantKey: string, point: VectorPoint): void;
  /** Test-only: every point of one partition, sorted by id. */
  points(profileId: string, tenantKey: string): VectorPoint[];
}

function requireKey(tenantKey: string): string {
  if (!isCanonicalTenantKey(tenantKey)) throw new Error('[Vector Sync] fake store: malformed tenant key');
  return tenantKey;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** An empty or absent list keeps everything; a null field never matches a set list. */
function inList(values: string[] | undefined, value: string | null): boolean {
  if (!values || values.length === 0) return true;
  return value !== null && values.includes(value);
}

function passesFilters(point: VectorPoint, filters: RetrievalFilters): boolean {
  const p = point.payload;
  if (!inList(filters.documentIds, p.document_id)) return false;
  if (!inList(filters.docTypes, p.doc_type)) return false;
  if (!inList(filters.languages, p.language)) return false;
  if (!inList(filters.sources, p.source)) return false;
  const range = filters.dateRange;
  if (range && (range.from || range.to)) {
    if (p.doc_date === null) return range.includeUndated === true;
    if (range.from && p.doc_date < range.from) return false;
    if (range.to && p.doc_date > range.to) return false;
  }
  return true;
}

function byScore(a: StoreHit, b: StoreHit): number {
  return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** In-memory VectorStore for tests and the tracer: one map per (collection, tenant), cosine dense leg, token-overlap lexical leg. */
export function createFakeVectorStore(target: VectorSyncTarget = 'qdrant'): FakeVectorStore {
  const collections = new Map<string, FakeCollection>();

  function collection(profileId: string): FakeCollection {
    const found = collections.get(profileId);
    if (!found) throw new BackendNotReadyError(target, 'collection_missing');
    return found;
  }

  function partition(profileId: string, tenantKey: string, create = false): Map<string, VectorPoint> | null {
    const col = collection(profileId);
    const key = requireKey(tenantKey);
    let part = col.tenants.get(key);
    if (!part && create) {
      part = new Map();
      col.tenants.set(key, part);
    }
    return part ?? null;
  }

  function sorted(part: Map<string, VectorPoint> | null): VectorPoint[] {
    return part ? [...part.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) : [];
  }

  return {
    target,
    async ensureCollection(spec: CollectionSpec): Promise<void> {
      const found = collections.get(spec.profileId);
      if (found && found.dims !== spec.dims) throw new Error('[Vector Sync] fake store: collection dims differ');
      if (!found) collections.set(spec.profileId, { dims: spec.dims, tenants: new Map() });
    },
    async describeCollection(profileId: string): Promise<CollectionInfo | null> {
      const found = collections.get(profileId);
      return found ? { profileId, dims: found.dims, tenants: found.tenants.size } : null;
    },
    async ensureTenant(profileId: string, tenantKey: string): Promise<void> {
      partition(profileId, tenantKey, true);
    },
    async upsert(profileId: string, tenantKey: string, points: VectorPoint[]): Promise<number> {
      const col = collection(profileId);
      const part = partition(profileId, tenantKey, true) as Map<string, VectorPoint>;
      for (const point of points) {
        if (point.payload.tenant_key !== tenantKey) throw new Error('[Vector Sync] fake store: point tenant differs from partition');
        if (point.vector.length !== col.dims) throw new Error('[Vector Sync] fake store: vector dims differ');
        part.set(point.id, { id: point.id, vector: [...point.vector], payload: { ...point.payload } });
      }
      return points.length;
    },
    async deleteIds(profileId: string, tenantKey: string, ids: string[]): Promise<number> {
      const part = partition(profileId, tenantKey);
      if (!part) return 0;
      let n = 0;
      for (const id of ids) if (part.delete(id)) n += 1;
      return n;
    },
    async deleteDocument(profileId: string, tenantKey: string, documentId: string): Promise<number> {
      const part = partition(profileId, tenantKey);
      if (!part) return 0;
      let n = 0;
      for (const [id, point] of part) {
        if (point.payload.document_id === documentId) {
          part.delete(id);
          n += 1;
        }
      }
      return n;
    },
    async deleteTenant(profileId: string, tenantKey: string): Promise<number> {
      const col = collection(profileId);
      const part = col.tenants.get(requireKey(tenantKey));
      col.tenants.delete(tenantKey);
      return part?.size ?? 0;
    },
    async listDocumentIds(profileId: string, tenantKey: string, documentId: string): Promise<string[]> {
      return sorted(partition(profileId, tenantKey))
        .filter((point) => point.payload.document_id === documentId)
        .map((point) => point.id);
    },
    async scanTenant(profileId: string, tenantKey: string, page: { after: string | null; limit: number }): Promise<StoreScanPage> {
      const all = sorted(partition(profileId, tenantKey)).filter((point) => page.after === null || point.id > page.after);
      const slice = all.slice(0, page.limit);
      return {
        points: slice.map((point) => ({ id: point.id, documentId: point.payload.document_id, contentHash: point.payload.content_hash })),
        next: all.length > page.limit && slice.length > 0 ? slice[slice.length - 1].id : null,
      };
    },
    async count(profileId: string, tenantKey: string): Promise<number> {
      return partition(profileId, tenantKey)?.size ?? 0;
    },
    async searchLegs(req: StoreSearchRequest): Promise<StoreLegs> {
      const tenantKey = canonicalTenantKey(req.scope);
      req.signal.throwIfAborted();
      const part = partition(req.profileId, tenantKey);
      if (!part) throw new BackendNotReadyError(target, 'tenant_missing');
      const candidates = [...part.values()].filter((point) => passesFilters(point, req.filters));
      const dense: StoreHit[] =
        req.denseVector && req.denseLimit > 0
          ? candidates
              .map((point) => ({ id: point.id, score: cosine(req.denseVector as number[], point.vector) }))
              .sort(byScore)
              .slice(0, req.denseLimit)
          : [];
      const tokens = new Set(req.lexicalTokens.filter((token) => token.length > 0));
      const lexical: StoreHit[] =
        tokens.size > 0 && req.lexicalLimit > 0
          ? candidates
              .map((point) => {
                const words = new Set((point.payload.lexical_text ?? '').split(/\s+/).filter(Boolean));
                let overlap = 0;
                for (const token of tokens) if (words.has(token)) overlap += 1;
                return { id: point.id, score: overlap };
              })
              .filter((hit) => hit.score > 0)
              .sort(byScore)
              .slice(0, req.lexicalLimit)
          : [];
      return { dense, lexical };
    },
    async health(): Promise<StoreHealth> {
      return { ok: true };
    },
    plant(profileId: string, tenantKey: string, point: VectorPoint): void {
      const part = partition(profileId, tenantKey, true) as Map<string, VectorPoint>;
      part.set(point.id, { id: point.id, vector: [...point.vector], payload: { ...point.payload } });
    },
    points(profileId: string, tenantKey: string): VectorPoint[] {
      return sorted(collections.has(profileId) ? partition(profileId, tenantKey) : null);
    },
  };
}
