import type { TenantScope } from '../tenant/scope';

export type BackendId = 'pgvector' | 'weaviate' | 'qdrant';

export const RETRIEVAL_BACKEND_IDS: readonly BackendId[] = ['pgvector', 'weaviate', 'qdrant'] as const;

export interface RetrievalFilters {
  readonly currentOnly: true;
  /** includeUndated (D-11, set only by the query layer's merge) also keeps chunks without a doc_date. */
  dateRange?: { from?: string; to?: string; includeUndated?: boolean };
  sources?: string[];
  documentIds?: string[];
  docTypes?: string[];
  languages?: string[];
  invoice?: {
    supplier?: string;
    amountMin?: number;
    amountMax?: number;
    currency?: string;
  };
  /** D-39: sorted dimension:value tags, set only after the tenant vocabulary check (resolveScopesFilter). */
  scopes?: string[];
  /** D-39: also admit documents with no tag in a filtered dimension; present only when true. */
  scopesIncludeUntagged?: true;
  /** D-44: today's UTC date (YYYY-MM-DD) while RAG_EFFECTIVE_DATES is on; never taken from a request. */
  effectiveOn?: string;
}

export type RetrievalFilterInput = Omit<RetrievalFilters, 'currentOnly' | 'effectiveOn'>;

export interface RankedHitDocument {
  filename: string;
  createdAt: string | null;
  metadata: Record<string, unknown>;
  contentPreview: string;
}

export interface RankedHit {
  rank: number;
  chunkId: string;
  documentId: string;
  parentId: string | null;
  content: string;
  metadata: Record<string, unknown>;
  chunkIndex: number | null;
  sectionPath: string[];
  chunkKind: string | null;
  similarity: number | null;
  lexicalScore: number | null;
  docType: string | null;
  language: string | null;
  document: RankedHitDocument;
}

export interface BackendSearchRequest {
  scope: TenantScope;
  embeddingProfileId: string;
  denseVector: number[] | null;
  lexicalTokens: string[];
  lexicalLanguages: string[] | null;
  filters: RetrievalFilters;
  denseLimit: number;
  lexicalLimit: number;
  chunkingProfileOverride?: Record<string, string>;
  signal: AbortSignal;
}

export interface BackendLegsMeta {
  denseMode: 'ann' | 'exact' | null;
  /** External backends (D-10): store ids that failed re-validation in this request. */
  tenantValidationDropped?: number;
}

export interface BackendLegs {
  dense: RankedHit[];
  lexical: RankedHit[];
  meta?: BackendLegsMeta;
}

export interface BackendHealth {
  ok: boolean;
  detail?: string;
  pgvectorVersion?: string;
}

export interface RetrievalBackend {
  readonly id: BackendId;
  search(req: BackendSearchRequest): Promise<BackendLegs>;
  health(): Promise<BackendHealth>;
  isReady(scope: TenantScope): Promise<boolean>;
}