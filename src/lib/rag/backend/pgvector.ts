import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import type { RagConfig } from '../config';
import { dropLexstatsReady, lexstatsReady } from '../lexical/stats';
import { accessRpcArgs, sameAccessFilter, scopeAccessFilter, type ScopeAccessFilter } from '../tenant/access';
import { getV2StartupVerdict } from '../v2/startup';
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
  LexicalScoringOutcome,
  LexicalScoringRequest,
  RankedHit,
  RetrievalBackend,
  TranslationHit,
  VersionScope,
} from './types';

export interface PgvectorBackendDeps {
  adminClient: () => RpcClient | SupabaseClient | null;
  getConfig: () => RagConfig;
  /** The pgvector version from the startup verdict; null while unknown. */
  pgvectorVersion?: () => string | null;
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

export const PGVECTOR_CAPABILITIES: Readonly<Required<BackendCapabilities>> = Object.freeze({
  versionScope: true,
  identifierFilter: true,
  accessFilter: true,
});

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

/** D-13, A-09: the floor of the exact-scan cutoff for a restricted caller. */
export const ACCESS_EXACT_SCAN_CUTOFF = 1000;

export interface DenseScanArgs {
  iterativeScan: RagConfig['v2']['iterativeScan'];
  exactScanCutoff: number;
  /** Set for a keys filter: the values it sent, recorded on the leg meta and never in the config hash. */
  forced?: { accessExactCutoff: number; accessIterativeScan: RagConfig['v2']['iterativeScan'] };
}

function versionAtLeast(version: string, required: string): boolean {
  const left = version.split('.').map((part) => Number.parseInt(part, 10));
  const right = required.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = Number.isFinite(left[index]) ? left[index]! : 0;
    const b = Number.isFinite(right[index]) ? right[index]! : 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * A-09 (fixed rule): a keys filter raises the exact-scan cutoff to at least 1000 and, when the configured iterative scan is off and
 * pgvector is 0.8.0 or newer, asks for relaxed_order. off and admin_all send the configured values.
 */
export function denseScanArgs(access: ScopeAccessFilter, config: RagConfig, pgvectorVersion: string | null): DenseScanArgs {
  const configured = { iterativeScan: config.v2.iterativeScan, exactScanCutoff: config.v2.exactScanCutoff };
  if (access.mode !== 'keys') return configured;
  const exactScanCutoff = Math.max(configured.exactScanCutoff, ACCESS_EXACT_SCAN_CUTOFF);
  const iterativeScan =
    configured.iterativeScan === 'off' && pgvectorVersion !== null && versionAtLeast(pgvectorVersion, '0.8.0')
      ? 'relaxed_order'
      : configured.iterativeScan;
  return { iterativeScan, exactScanCutoff, forced: { accessExactCutoff: exactScanCutoff, accessIterativeScan: iterativeScan } };
}

function splitLegs(rows: HybridRow[], forced?: DenseScanArgs['forced']): BackendLegs {
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
  if (forced) return { dense, lexical, meta: { denseMode, ...forced } };
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

function buildRpcArgs(req: BackendSearchRequest, config: RagConfig, scan: DenseScanArgs): Record<string, unknown> {
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
    p_iterative_scan: scan.iterativeScan,
    p_exact_scan_cutoff: scan.exactScanCutoff,
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
    ...accessRpcArgs(req.access),
  };
}

/** D-26: the BM25 first-pass candidate cap, min(2000, max(500, 5 x lexical limit)). */
export function bm25CandidateLimit(lexicalLimit: number): number {
  return Math.min(2000, Math.max(500, 5 * lexicalLimit));
}

/** Dense-only arguments that rag_bm25_search_chunks does not take; every other hybrid argument (filters included) is carried over. */
const DENSE_ONLY_ARGS = ['p_dense_limit', 'p_iterative_scan', 'p_exact_scan_cutoff'] as const;

/** D-22: derived from the hybrid_search_chunks arguments, so a filter argument added there reaches the BM25 call without another edit. */
export function bm25ArgsFrom(hybridArgs: Record<string, unknown>, scoring: LexicalScoringRequest, lexicalLimit: number): Record<string, unknown> {
  const args: Record<string, unknown> = { ...hybridArgs };
  for (const key of DENSE_ONLY_ARGS) delete args[key];
  return { ...args, p_k1: scoring.k1, p_b: scoring.b, p_candidate_limit: bm25CandidateLimit(lexicalLimit) };
}

const BM25_RPC = 'rag_bm25_search_chunks';

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

async function hybridRows(client: RpcClient, args: Record<string, unknown>, req: BackendSearchRequest): Promise<HybridRow[]> {
  const response = await client.rpc('hybrid_search_chunks', args).abortSignal(req.signal);
  req.signal.throwIfAborted();
  if (response.error) {
    if (response.error.message.includes('embedding_profile_mismatch')) {
      throw new EmbeddingProfileMismatchError(mismatchKindOf(response.error.message), { profile: req.embeddingProfileId });
    }
    logger.error('Document Search', 'hybrid_search_chunks failed', { rpc: 'hybrid_search_chunks', code: response.error.code ?? null });
    throw new RetrievalBackendError('hybrid_search_chunks', response.error.code ?? null);
  }
  return (response.data ?? []) as HybridRow[];
}

function withScoring(legs: BackendLegs, outcome: LexicalScoringOutcome): BackendLegs {
  return { ...legs, meta: { denseMode: legs.meta?.denseMode ?? null, ...legs.meta, lexicalScoring: outcome } };
}

type Bm25Outcome = { rows: HybridRow[] } | { fallback: 'stats_unavailable' | 'bm25_failed' };

async function bm25Rows(client: RpcClient, args: Record<string, unknown>, req: BackendSearchRequest, tenantKey: string): Promise<Bm25Outcome> {
  try {
    const response = await client.rpc(BM25_RPC, args).abortSignal(req.signal);
    if (req.signal.aborted) return { fallback: 'bm25_failed' };
    if (!response.error) return { rows: (response.data ?? []) as HybridRow[] };
    if (response.error.message.includes('lexical_stats_not_ready')) {
      dropLexstatsReady(tenantKey);
      return { fallback: 'stats_unavailable' };
    }
    logger.error('Document Search', `${BM25_RPC} failed`, { rpc: BM25_RPC, code: response.error.code ?? null });
    return { fallback: 'bm25_failed' };
  } catch (error) {
    if (req.signal.aborted) return { fallback: 'bm25_failed' };
    const code = error instanceof Error ? error.name : null;
    logger.error('Document Search', `${BM25_RPC} failed`, { rpc: BM25_RPC, code });
    return { fallback: 'bm25_failed' };
  }
}

/**
 * D-22, D-25, D-26: the dense hybrid call (lexical limit 0) and the BM25 call run in parallel. A tenant without ready statistics, or a
 * failed BM25 call, is served by the unchanged ts_rank_cd leg of hybrid_search_chunks; that is degraded scoring, never an error.
 */
async function searchWithBm25(
  client: RpcClient,
  args: Record<string, unknown>,
  req: BackendSearchRequest,
  scoring: LexicalScoringRequest,
  forced?: DenseScanArgs['forced'],
): Promise<BackendLegs> {
  const tenantKey = String(args.p_tenant_key);
  const ready = await lexstatsReady(client, tenantKey, Date.now(), req.signal);
  req.signal.throwIfAborted();
  if (!ready) return withScoring(splitLegs(await hybridRows(client, args, req), forced), 'stats_unavailable');

  const denseWanted = typeof args.p_dense_limit === 'number' && args.p_dense_limit > 0;
  const densePending = denseWanted ? hybridRows(client, { ...args, p_lexical_limit: 0 }, req) : Promise.resolve([] as HybridRow[]);
  const bm25Pending = bm25Rows(client, bm25ArgsFrom(args, scoring, req.lexicalLimit), req, tenantKey);
  // Both are awaited; a dense failure first must not leave the BM25 promise unobserved (it never rejects).
  const [denseRows, bm25] = await Promise.all([densePending, bm25Pending]);
  req.signal.throwIfAborted();
  const dense = splitLegs(denseRows, forced);
  if ('rows' in bm25) {
    return withScoring({ ...dense, lexical: splitLegs(bm25.rows).lexical }, 'bm25');
  }
  const lexical = splitLegs(await hybridRows(client, { ...args, p_dense_limit: 0 }, req)).lexical;
  return withScoring({ ...dense, lexical }, bm25.fallback);
}

export function createPgvectorBackend(deps: PgvectorBackendDeps): RetrievalBackend {
  return {
    id: 'pgvector',
    capabilities: PGVECTOR_CAPABILITIES,
    async search(req: BackendSearchRequest): Promise<BackendLegs> {
      assertTenantScope(req.scope);
      // D-05: the request's filter must be the one its scope resolves to; a mismatch never reaches SQL.
      if (!req.access || !sameAccessFilter(req.access, scopeAccessFilter(req.scope))) {
        throw new RetrievalBackendError('hybrid_search_chunks', 'access_filter_mismatch');
      }
      const client = deps.adminClient();
      if (!client) throw new RetrievalBackendError('hybrid_search_chunks', 'admin_unavailable');
      const config = deps.getConfig();
      const rpcClient = client as RpcClient;
      const version = deps.pgvectorVersion ? deps.pgvectorVersion() : getV2StartupVerdict().pgvectorVersion;
      const scan = denseScanArgs(req.access, config, version);
      const args = buildRpcArgs(req, config, scan);
      if (!req.lexicalScoring || req.lexicalLimit <= 0 || req.lexicalTokens.length === 0) {
        return splitLegs(await hybridRows(rpcClient, args, req), scan.forced);
      }
      return searchWithBm25(rpcClient, args, req, req.lexicalScoring, scan.forced);
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
