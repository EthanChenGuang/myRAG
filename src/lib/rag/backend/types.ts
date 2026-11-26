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

/** D-12: which document versions a request reads. 'current' (the default) is today's behaviour; a range takes ISO dates. */
export type VersionScope = 'current' | 'all' | { from?: string; to?: string };

/** Request fields a backend honours beyond the base contract; a backend that does not declare one is never handed it (backendForRequest). */
export interface BackendCapabilities {
  versionScope?: boolean;
  identifierFilter?: boolean;
}

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
  /** D-48: the chunk's near-duplicate cluster, when the search function returns one. */
  dupClusterId?: string;
  /** False for a superseded version returned under a non-current version scope. */
  isCurrent?: boolean;
  documentVersion?: number;
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
  /** D-12, D-40: absent or 'current' reads current versions only; filters.currentOnly stays true. */
  versionScope?: VersionScope;
  /** D-31, D-45: normalized identifiers; every leg keeps only chunks that carry one of them. */
  identifiersNorm?: string[];
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

/** One translation leg request (XLG-04, D-30): the query in one language against the tenant's stored translations into it. */
export interface BackendTranslationSearchRequest {
  scope: TenantScope;
  embeddingProfileId: string;
  /** The translation language; the request's query language. */
  language: string;
  denseVector: number[] | null;
  lexicalTokens: string[];
  filters: RetrievalFilters;
  denseLimit: number;
  lexicalLimit: number;
  chunkingProfileOverride?: Record<string, string>;
  signal: AbortSignal;
}

/**
 * A translation hit, already the source chunk: content, metadata and document are the original's, never the translated text.
 * hit.similarity and hit.lexicalScore are the translation's own scores; the leg module clears them before fusion.
 */
export interface TranslationHit {
  leg: 'dense' | 'lexical';
  translationLanguage: string;
  hit: RankedHit;
}

export interface BackendHealth {
  ok: boolean;
  detail?: string;
  pgvectorVersion?: string;
}

export interface RetrievalBackend {
  readonly id: BackendId;
  readonly capabilities?: BackendCapabilities;
  search(req: BackendSearchRequest): Promise<BackendLegs>;
  /** Absent on a backend without chunk translations: no translation leg runs. */
  searchTranslations?(req: BackendTranslationSearchRequest): Promise<TranslationHit[]>;
  health(): Promise<BackendHealth>;
  isReady(scope: TenantScope): Promise<boolean>;
}