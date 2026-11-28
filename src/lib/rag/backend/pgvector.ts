import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import type { RagConfig } from '../config';
import { assertTenantScope, scopeKey } from '../tenant/scope';
import {
  EmbeddingProfileMismatchError,
  RetrievalBackendError,
  type RpcClient,
} from './supabase-rpc';
import type {
  BackendHealth,
  BackendLegs,
  BackendLegsMeta,
  BackendCapabilities,
  BackendSearchRequest,
  BackendTranslationSearchRequest,
  RankedHit,
  RetrievalBackend,
  TranslationHit,
  VersionScope,
} from './types';

export interface PgvectorBackendDeps {
  adminClient: () => RpcClient | SupabaseClient | null;
  getConfig: () => RagConfig;
}

interface HybridRow {
  leg: string;
  rank: number;
  chunk_id: string;
  document_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  chunk_index: number | null;
  similarity: number | null;
  lexical_score: number | null;
  doc_type: string | null;
  language: string | null;
  parent_id: string | null;
  section_path: string[] | null;
  chunk_kind: string | null;
  document_filename: string | null;
  document_created_at: string | null;
  document_metadata: Record<string, unknown> | null;
  document_content_preview: string | null;
  dense_mode: string | null;
  dup_cluster_id?: string | null;
  is_current?: boolean | null;
  document_version?: number | null;
}

export const PGVECTOR_CAPABILITIES: Readonly<Required<BackendCapabilities>> = Object.freeze({ versionScope: true, identifierFilter: true });

/** The p_version_scope argument for a scope, or null when the request reads current versions only (the argument is then left out). */
export function versionScopeArg(scope: VersionScope | undefined): Record<string, string> | null {
  if (scope === undefined || scope === 'current') return null;
  if (scope === 'all') return { mode: 'all' };
  return { mode: 'range', ...(scope.from ? { from: scope.from } : {}), ...(scope.to ? { to: scope.to } : {}) };
}

/** D-12, D-31: both arguments are spread in only when set, so a request without them sends today's body. */
export function versionAndIdentifierArgs(scope: VersionScope | undefined, identifiersNorm: string[] | undefined): Record<string, unknown> {
  const version = versionScopeArg(scope);
  return {
    ...(version ? { p_version_scope: version } : {}),
    ...(identifiersNorm !== undefined ? { p_identifiers_norm: [...identifiersNorm] } : {}),
  };
}

function mismatchKindOf(message: string): 'dims' | 'model' | 'vector' | 'provider' | 'startup' | 'not_active' | 'unknown_profile' {
  if (message.includes('profile not active')) return 'not_active';
  if (message.includes('unknown profile')) return 'unknown_profile';
  if (message.includes(': model')) return 'model';
  if (message.includes(': vector')) return 'vector';
  if (message.includes(': provider')) return 'provider';
  return 'dims';
}

function nullIfEmpty(values: string[] | undefined): string[] | null {
  if (!values || values.length === 0) return null;
  return values;
}

function mapRow(row: HybridRow): RankedHit {
  return {
    rank: row.rank,
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    content: row.content,
    metadata: row.metadata ?? {},
    chunkIndex: row.chunk_index,
    sectionPath: row.section_path ?? [],
    chunkKind: row.chunk_kind,
    similarity: row.similarity,
    lexicalScore: row.lexical_score,
    docType: row.doc_type,
    language: row.language,
    document: {
      filename: row.document_filename ?? '',
      createdAt: row.document_created_at,
      metadata: row.document_metadata ?? {},
      contentPreview: row.document_content_preview ?? '',
    },
    ...(typeof row.dup_cluster_id === 'string' && row.dup_cluster_id.length > 0 ? { dupClusterId: row.dup_cluster_id } : {}),
    ...(typeof row.is_current === 'boolean' ? { isCurrent: row.is_current } : {}),
    ...(typeof row.document_version === 'number' ? { documentVersion: row.document_version } : {}),
  };
}

function splitLegs(rows: HybridRow[]): BackendLegs {
  const dense: RankedHit[] = [];
  const lexical: RankedHit[] = [];
  let denseMode: BackendLegsMeta['denseMode'] = null;
  for (const row of rows) {
    const hit = mapRow(row);
    if (row.leg === 'dense') {
      dense.push(hit);
      if (row.dense_mode === 'exact' || row.dense_mode === 'ann') denseMode = row.dense_mode;
    } else if (row.leg === 'lexical') {
      lexical.push(hit);
    }
  }
  return { dense, lexical, meta: denseMode ? { denseMode } : undefined };
}

/** D-39: spread in only for a non-empty filter, so a filter-free request body is unchanged. */
function scopeArgs(filters: BackendSearchRequest['filters']): Record<string, unknown> {
  if (!filters.scopes || filters.scopes.length === 0) return {};
  return {
    p_scopes: [...filters.scopes],
    ...(filters.scopesIncludeUntagged === true ? { p_scopes_include_untagged: true } : {}),
  };
}

function buildRpcArgs(req: BackendSearchRequest, config: RagConfig): Record<string, unknown> {
  const filters = req.filters;
  return {
    p_tenant_key: scopeKey(req.scope),
    p_profile_id: req.embeddingProfileId,
    p_query_embedding: req.denseVector,
    p_lexical_tokens: req.lexicalTokens,
    p_dense_limit: req.denseVector && req.denseVector.length > 0 ? req.denseLimit : 0,
    p_lexical_limit: req.lexicalLimit,
    p_date_from: filters.dateRange?.from ?? null,
    p_date_to: filters.dateRange?.to ?? null,
    p_sources: nullIfEmpty(filters.sources),
    p_document_ids: nullIfEmpty(filters.documentIds),
    p_doc_types: nullIfEmpty(filters.docTypes),
    p_languages: nullIfEmpty(filters.languages),
    p_iterative_scan: config.v2.iterativeScan,
    p_exact_scan_cutoff: config.v2.exactScanCutoff,
    p_lexical_languages: nullIfEmpty(req.lexicalLanguages ?? undefined),
    p_supplier: filters.invoice?.supplier ?? null,
    p_amount_min: filters.invoice?.amountMin ?? null,
    p_amount_max: filters.invoice?.amountMax ?? null,
    p_currency: filters.invoice?.currency ?? null,
    p_chunking_override: req.chunkingProfileOverride ?? null,
    ...(filters.dateRange?.includeUndated === true ? { p_include_undated: true } : {}),
    ...scopeArgs(filters),
    ...(filters.effectiveOn ? { p_effective_on: filters.effectiveOn } : {}),
    ...versionAndIdentifierArgs(req.versionScope, req.identifiersNorm),
  };
}

interface TranslationRow {
  leg: unknown;
  rank: unknown;
  chunk_id: unknown;
  document_id: unknown;
  translation_language: unknown;
  content: unknown;
  metadata: Record<string, unknown> | null;
  chunk_index: number | null;
  translation_similarity: number | null;
  lexical_score: number | null;
  doc_type: string | null;
  language: string | null;
  parent_id: string | null;
  section_path: string[] | null;
  chunk_kind: string | null;
  document_filename: string | null;
  document_created_at: string | null;
  document_metadata: Record<string, unknown> | null;
  document_content_preview: string | null;
}

/** A hybrid_search_translations row that cannot be mapped to a source chunk; the translation leg is dropped (translation_leg_invalid). */
export class TranslationRowInvalidError extends Error {
  constructor() {
    super('[Document Search] invalid translation row');
    this.name = 'TranslationRowInvalidError';
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function mapTranslationRow(row: TranslationRow): TranslationHit {
  if (
    (row.leg !== 'dense' && row.leg !== 'lexical') ||
    typeof row.rank !== 'number' ||
    !Number.isInteger(row.rank) ||
    row.rank < 1 ||
    !nonEmptyString(row.chunk_id) ||
    !nonEmptyString(row.document_id) ||
    !nonEmptyString(row.translation_language) ||
    typeof row.content !== 'string'
  ) {
    throw new TranslationRowInvalidError();
  }
  return {
    leg: row.leg,
    translationLanguage: row.translation_language,
    hit: {
      rank: row.rank,
      chunkId: row.chunk_id,
      documentId: row.document_id,
      parentId: row.parent_id ? String(row.parent_id) : null,
      content: row.content,
      metadata: row.metadata ?? {},
      chunkIndex: row.chunk_index,
      sectionPath: row.section_path ?? [],
      chunkKind: row.chunk_kind,
      similarity: row.translation_similarity,
      lexicalScore: row.lexical_score,
      docType: row.doc_type,
      language: row.language,
      document: {
        filename: row.document_filename ?? '',
        createdAt: row.document_created_at,
        metadata: row.document_metadata ?? {},
        contentPreview: row.document_content_preview ?? '',
      },
    },
  };
}

/** hybrid_search_translations takes the hybrid_search_chunks filter arguments unchanged, without the exact-scan and lexical-language ones. */
function buildTranslationArgs(req: BackendTranslationSearchRequest, config: RagConfig): Record<string, unknown> {
  const filters = req.filters;
  return {
    p_tenant_key: scopeKey(req.scope),
    p_profile_id: req.embeddingProfileId,
    p_language: req.language,
    p_query_embedding: req.denseVector,
    p_lexical_tokens: req.lexicalTokens,
    p_dense_limit: req.denseVector && req.denseVector.length > 0 ? req.denseLimit : 0,
    p_lexical_limit: req.lexicalTokens.length > 0 ? req.lexicalLimit : 0,
    p_date_from: filters.dateRange?.from ?? null,
    p_date_to: filters.dateRange?.to ?? null,
    p_sources: nullIfEmpty(filters.sources),
    p_document_ids: nullIfEmpty(filters.documentIds),
    p_doc_types: nullIfEmpty(filters.docTypes),
    p_languages: nullIfEmpty(filters.languages),
    p_iterative_scan: config.v2.iterativeScan,
    p_supplier: filters.invoice?.supplier ?? null,
    p_amount_min: filters.invoice?.amountMin ?? null,
    p_amount_max: filters.invoice?.amountMax ?? null,
    p_currency: filters.invoice?.currency ?? null,
    p_chunking_override: req.chunkingProfileOverride ?? null,
    ...(filters.dateRange?.includeUndated === true ? { p_include_undated: true } : {}),
    ...scopeArgs(filters),
    ...(filters.effectiveOn ? { p_effective_on: filters.effectiveOn } : {}),
  };
}

export function createPgvectorBackend(deps: PgvectorBackendDeps): RetrievalBackend {
  return {
    id: 'pgvector',
    capabilities: PGVECTOR_CAPABILITIES,
    async search(req: BackendSearchRequest): Promise<BackendLegs> {
      assertTenantScope(req.scope);
      const client = deps.adminClient();
      if (!client) throw new RetrievalBackendError('hybrid_search_chunks', 'admin_unavailable');
      const config = deps.getConfig();
      const rpcClient = client as RpcClient;
      const response = await rpcClient.rpc('hybrid_search_chunks', buildRpcArgs(req, config)).abortSignal(req.signal);
      req.signal.throwIfAborted();
      if (response.error) {
        if (response.error.message.includes('embedding_profile_mismatch')) {
          throw new EmbeddingProfileMismatchError(mismatchKindOf(response.error.message), { profile: req.embeddingProfileId });
        }
        logger.error('Document Search', 'hybrid_search_chunks failed', { rpc: 'hybrid_search_chunks', code: response.error.code ?? null });
        throw new RetrievalBackendError('hybrid_search_chunks', response.error.code ?? null);
      }
      return splitLegs((response.data ?? []) as HybridRow[]);
    },
    async searchTranslations(req: BackendTranslationSearchRequest): Promise<TranslationHit[]> {
      assertTenantScope(req.scope);
      const client = deps.adminClient();
      if (!client) throw new RetrievalBackendError('hybrid_search_translations', 'admin_unavailable');
      const rpcClient = client as RpcClient;
      const response = await rpcClient
        .rpc('hybrid_search_translations', buildTranslationArgs(req, deps.getConfig()))
        .abortSignal(req.signal);
      req.signal.throwIfAborted();
      if (response.error) {
        logger.error('Document Search', 'hybrid_search_translations failed', { rpc: 'hybrid_search_translations', code: response.error.code ?? null });
        throw new RetrievalBackendError('hybrid_search_translations', response.error.code ?? null);
      }
      if (response.data !== null && response.data !== undefined && !Array.isArray(response.data)) throw new TranslationRowInvalidError();
      return ((response.data ?? []) as TranslationRow[]).map(mapTranslationRow);
    },
    async health(): Promise<BackendHealth> {
      const client = deps.adminClient();
      if (!client) return { ok: false, detail: 'admin_unavailable' };
      const supa = client as SupabaseClient;
      const probe = await supa.from('embedding_profiles').select('id').limit(1);
      if (probe.error) return { ok: false, detail: probe.error.code ?? 'probe_failed' };
      let pgvectorVersion: string | undefined;
      try {
        const version = await supa.rpc('rag_pgvector_version');
        if (!version.error && typeof version.data === 'string') pgvectorVersion = version.data;
      } catch {
        // optional helper may be absent on older schemas
      }
      return { ok: true, pgvectorVersion };
    },
    async isReady(): Promise<boolean> {
      return true;
    },
  };
}