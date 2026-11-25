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
}

export type RetrievalFilterInput = Omit<RetrievalFilters, 'currentOnly'>;

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