import { logger } from '@/lib/logger';
import { assertTenantScope, scopeKey, workspaceRpcArgs, type TenantScope } from '../tenant/scope';

export interface RpcError {
  message: string;
  code?: string;
}

export interface RpcResponse {
  data: unknown[] | null;
  error: RpcError | null;
}

export interface RpcRequest extends PromiseLike<RpcResponse> {
  abortSignal(signal: AbortSignal): RpcRequest;
}

export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): RpcRequest;
}

export interface RawChunk {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown> | null;
}

export class RetrievalBackendError extends Error {
  readonly rpc: string;
  readonly code: string | null;

  constructor(rpc: string, code: string | null) {
    super(`[RAG Backend] ${rpc} failed${code ? ` (${code})` : ''}`);
    this.name = 'RetrievalBackendError';
    this.rpc = rpc;
    this.code = code;
  }
}

export type EmbeddingProfileMismatchKind =
  | 'dims'
  | 'model'
  | 'vector'
  | 'provider'
  | 'startup'
  | 'not_active'
  | 'unknown_profile';

export interface EmbeddingProfileMismatchDetail {
  profile?: string | null;
  model?: string | null;
  dims?: number | null;
  actual?: number | string | null;
  /** The startup check already wrote its own MISMATCH line for this cause. */
  alreadyLogged?: boolean;
}

/**
 * The query vector and the profile it must be searched in disagree (length, model, provider) or the database refused the
 * profile. Carries codes and numbers only, never keys or text.
 */
export class EmbeddingProfileMismatchError extends Error {
  readonly kind: EmbeddingProfileMismatchKind;
  readonly profile: string | null;
  readonly model: string | null;
  readonly dims: number | null;
  readonly actual: number | string | null;
  readonly alreadyLogged: boolean;

  constructor(kind: EmbeddingProfileMismatchKind, detail: EmbeddingProfileMismatchDetail = {}) {
    super(`embedding_profile_mismatch: ${kind}`);
    this.name = 'EmbeddingProfileMismatchError';
    this.kind = kind;
    this.profile = detail.profile ?? null;
    this.model = detail.model ?? null;
    this.dims = detail.dims ?? null;
    this.actual = detail.actual ?? null;
    this.alreadyLogged = detail.alreadyLogged ?? false;
  }
}

interface WorkspaceRow {
  id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown> | null;
}

export async function vectorSearch(
  scope: TenantScope,
  embedding: number[],
  matchCount: number,
  threshold: number,
  opts: { client: RpcClient; signal: AbortSignal },
): Promise<RawChunk[]> {
  assertTenantScope(scope);
  const { client, signal } = opts;

  if (scope.kind === 'single') {
    logger.db(`[Enhanced RAG] Using single-tenant search`);
    logger.db(`[Enhanced RAG] RPC params: match_count=${matchCount}, threshold=${threshold}, embedding_length=${embedding.length}`);
    const response = await client
      .rpc('match_document_chunks', {
        query_embedding: embedding,
        match_count: matchCount,
        similarity_threshold: threshold,
      })
      .abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      logger.error('Enhanced RAG', 'Error in single-tenant vector search', { code: response.error.code });
      throw new RetrievalBackendError('match_document_chunks', response.error.code ?? null);
    }
    const chunks = (response.data || []) as RawChunk[];
    logger.db(`[Enhanced RAG] RPC returned ${chunks.length} chunks`);
    return chunks;
  }

  const args = workspaceRpcArgs(scope);
  logger.db(`[Enhanced RAG] Using workspace search (org=${args.p_org_id || 'personal'}, user=${args.p_user_id || 'anon'})`);
  const response = await client
    .rpc('match_documents_by_workspace', {
      ...args,
      p_query_embedding: embedding,
      p_match_count: matchCount,
      p_min_similarity: threshold,
    })
    .abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) {
    logger.error('Enhanced RAG', 'Error in workspace vector search', { code: response.error.code });
    throw new RetrievalBackendError('match_documents_by_workspace', response.error.code ?? null);
  }
  return ((response.data || []) as WorkspaceRow[]).map((chunk) => ({
    chunk_id: chunk.id,
    document_id: chunk.document_id,
    content: chunk.content,
    similarity: chunk.similarity,
    metadata: chunk.metadata,
  }));
}

export interface ProfileSearchTarget {
  id: string;
  dims: number;
}

interface ProfileRow {
  id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: Record<string, unknown> | null;
}

const PROFILE_RPC = 'match_chunks_by_profile';

function mismatchKindOf(message: string): EmbeddingProfileMismatchKind {
  if (message.includes('profile not active')) return 'not_active';
  if (message.includes('unknown profile')) return 'unknown_profile';
  return 'dims';
}

/**
 * Searches one profile's vectors inside one tenant. The tenant key comes from the scope only, never from a caller value, and the SQL
 * function applies it next to the index scan together with the current and ready filters. A refusal that names
 * embedding_profile_mismatch becomes EmbeddingProfileMismatchError.
 */
export async function profileVectorSearch(
  scope: TenantScope,
  embedding: number[],
  profile: ProfileSearchTarget,
  matchCount: number,
  threshold: number,
  opts: { client: RpcClient; signal: AbortSignal },
): Promise<RawChunk[]> {
  assertTenantScope(scope);
  const { client, signal } = opts;
  const response = await client
    .rpc(PROFILE_RPC, {
      p_tenant_key: scopeKey(scope),
      p_profile_id: profile.id,
      p_dims: profile.dims,
      p_query: embedding,
      p_match_count: matchCount,
      p_min_similarity: threshold,
    })
    .abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) {
    if (response.error.message.includes('embedding_profile_mismatch')) {
      throw new EmbeddingProfileMismatchError(mismatchKindOf(response.error.message), { profile: profile.id, dims: profile.dims });
    }
    logger.error('Enhanced RAG', 'Error in profile vector search', { code: response.error.code });
    throw new RetrievalBackendError(PROFILE_RPC, response.error.code ?? null);
  }
  return ((response.data || []) as ProfileRow[]).map((chunk) => ({
    chunk_id: chunk.id,
    document_id: chunk.document_id,
    content: chunk.content,
    similarity: chunk.similarity,
    metadata: chunk.metadata,
  }));
}

export interface SearchableEmbedding {
  vector: number[];
  profile: (ProfileSearchTarget & { storage: string }) | null;
}

/**
 * The adapter's choice of RPC: a halfvec profile goes to match_chunks_by_profile, everything else (no profile, or the legacy column)
 * to the two legacy RPCs through vectorSearch, which is unchanged.
 */
export function searchByEmbedding(
  scope: TenantScope,
  embedding: SearchableEmbedding,
  matchCount: number,
  threshold: number,
  opts: { client: RpcClient; signal: AbortSignal },
): Promise<RawChunk[]> {
  if (embedding.profile && embedding.profile.storage === 'halfvec') {
    return profileVectorSearch(scope, embedding.vector, embedding.profile, matchCount, threshold, opts);
  }
  return vectorSearch(scope, embedding.vector, matchCount, threshold, opts);
}
