import type { RetrievalFilters } from '@/lib/rag/backend/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';

export type VectorSyncTarget = 'weaviate' | 'qdrant';

/** D-03: the only fields an external point carries. Chunk text and document names stay in Supabase. */
export interface VectorPointPayload {
  tenant_key: string;
  document_id: string;
  doc_type: string | null;
  doc_date: string | null;
  language: string | null;
  source: string | null;
  chunking_profile_id: string | null;
  parent_id: string | null;
  lexical_text: string | null;
  content_hash: string | null;
  lexical_version: number | null;
  /**
   * SEC-12: the chunk's Phase 4.3 access keys as stored (`all`, `g:<group uuid>`, `u:<user uuid>`), copied unchanged. A filter field,
   * never content; every synced point carries it, and the query side filters on it only while RAG_DOC_ACCESS_GROUPS is on.
   */
  access_groups: string[];
}

export interface VectorPoint {
  /** The chunk UUID (D-02: deterministic, idempotent). */
  id: string;
  vector: number[];
  payload: VectorPointPayload;
}

export interface CollectionSpec {
  profileId: string;
  dims: number;
}

export interface CollectionInfo {
  profileId: string;
  dims: number;
  /** Null for a store that keeps no tenant registry (Qdrant: one shared collection, tenants are a payload index). */
  tenants: number | null;
}

export interface StoreHit {
  id: string;
  score: number;
}

export interface StoreLegs {
  dense: StoreHit[];
  lexical: StoreHit[];
}

export interface StoreSearchRequest {
  scope: TenantScope;
  profileId: string;
  denseVector: number[] | null;
  lexicalTokens: string[];
  denseLimit: number;
  lexicalLimit: number;
  filters: RetrievalFilters;
  signal: AbortSignal;
}

export interface StoreScanPoint {
  id: string;
  documentId: string;
  contentHash: string | null;
  /** The payload's lexical_version; reconcile's content digest covers it (D-05). A store that omits it reads as null. */
  lexicalVersion?: number | null;
}

export interface StoreScanPage {
  points: StoreScanPoint[];
  next: string | null;
}

export interface StoreHealth {
  ok: boolean;
  detail?: string;
}

/**
 * Everything the drain worker, reconcile, the backend adapters and the canary need from an external vector store. Write calls take
 * the canonical tenant key read from Supabase rows; search takes the minted scope. An implementation keeps every tenant in its own
 * partition and never answers a call without one.
 */
export interface VectorStore {
  readonly target: VectorSyncTarget;
  ensureCollection(spec: CollectionSpec): Promise<void>;
  describeCollection(profileId: string): Promise<CollectionInfo | null>;
  ensureTenant(profileId: string, tenantKey: string): Promise<void>;
  upsert(profileId: string, tenantKey: string, points: VectorPoint[]): Promise<number>;
  deleteIds(profileId: string, tenantKey: string, ids: string[]): Promise<number>;
  deleteDocument(profileId: string, tenantKey: string, documentId: string): Promise<number>;
  deleteTenant(profileId: string, tenantKey: string): Promise<number>;
  listDocumentIds(profileId: string, tenantKey: string, documentId: string): Promise<string[]>;
  scanTenant(profileId: string, tenantKey: string, page: { after: string | null; limit: number }): Promise<StoreScanPage>;
  count(profileId: string, tenantKey: string): Promise<number>;
  /**
   * RET-05 purges: every `myrag_chunks_` collection the store holds (vendor names), synced or not, so a retired profile's
   * collection is swept too. The two calls below take one of these names and act inside the caller's tenant only; a collection
   * without that tenant deletes and counts zero.
   */
  listCollections(): Promise<string[]>;
  deleteDocuments(collection: string, tenantKey: string, documentIds: string[]): Promise<number>;
  countDocumentPoints(collection: string, tenantKey: string, documentIds: string[]): Promise<number>;
  searchLegs(req: StoreSearchRequest): Promise<StoreLegs>;
  health(): Promise<StoreHealth>;
}
