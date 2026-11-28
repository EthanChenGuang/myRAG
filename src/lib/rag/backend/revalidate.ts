import { logger } from '@/lib/logger';
import type { ScopeAccessFilter } from '../tenant/access-filter';
import type { TenantScope } from '../tenant/scope';
import { RetrievalBackendError, rpcRows, type RpcClient } from './supabase-rpc';
import { canonicalTenantKey } from './tenant-key';
import type { RankedHit } from './types';

export const VALIDATE_RPC = 'rag_validate_chunks';
/** SEC-12 (07-39, 0742): rag_validate_chunks restricted to chunks and documents whose access_groups overlap the caller's keys. */
export const VALIDATE_GROUPS_RPC = 'rag_validate_chunks_for_groups';
export const MAX_VALIDATE_IDS = 500;

export interface ValidatedChunkRow {
  chunk_id: string;
  document_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  chunk_index: number | null;
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

/** A hydrated hit without rank and scores; the caller sets those from the store leg. */
export type ValidatedChunk = Omit<RankedHit, 'rank' | 'similarity' | 'lexicalScore'>;

export interface SecurityLogSink {
  (line: string): void;
}

const defaultSecuritySink: SecurityLogSink = (line) => console.error(line);

export interface RevalidateResult {
  chunks: Map<string, ValidatedChunk>;
  requested: number;
  dropped: number;
}

function toChunk(row: ValidatedChunkRow): ValidatedChunk {
  return {
    chunkId: String(row.chunk_id),
    documentId: String(row.document_id),
    parentId: row.parent_id ? String(row.parent_id) : null,
    content: row.content,
    metadata: row.metadata ?? {},
    chunkIndex: row.chunk_index,
    sectionPath: row.section_path ?? [],
    chunkKind: row.chunk_kind,
    docType: row.doc_type,
    language: row.language,
    document: {
      filename: row.document_filename ?? '',
      createdAt: row.document_created_at,
      metadata: row.document_metadata ?? {},
      contentPreview: row.document_content_preview ?? '',
    },
  };
}

/** Counts only: never an id, a key or any text. */
export function logTenantValidationDropped(backend: string, requested: number, dropped: number, sink: SecurityLogSink = defaultSecuritySink): void {
  sink(`[RAG Security] ${JSON.stringify({ event: 'tenant_validation_dropped', backend, requested, dropped })}`);
}

/**
 * D-10, isolation layer 2: one rag_validate_chunks call through the admin client keeps exactly the ids that are current, ready, in the
 * caller's tenant and hold a vector in the profile, and hydrates them from Supabase. The tenant key comes from the scope only. There is
 * no switch: every external result passes through here. SEC-12: with a keys access filter (RAG_DOC_ACCESS_GROUPS on) the call is
 * rag_validate_chunks_for_groups with exactly those keys; modes off and admin_all (and no filter) keep the plain call and its arguments.
 */
export async function revalidateChunks(
  scope: TenantScope,
  ids: readonly string[],
  opts: { client: RpcClient | null; profileId: string; signal: AbortSignal; access?: ScopeAccessFilter },
): Promise<RevalidateResult> {
  const tenantKey = canonicalTenantKey(scope);
  const groups = opts.access?.mode === 'keys' ? [...new Set(opts.access.keys)] : null;
  const rpc = groups === null ? VALIDATE_RPC : VALIDATE_GROUPS_RPC;
  if (groups !== null && groups.length === 0) throw new RetrievalBackendError(rpc, 'access_keys_missing');
  const unique = [...new Set(ids)];
  if (unique.length > MAX_VALIDATE_IDS) throw new RetrievalBackendError(rpc, 'too_many_ids');
  if (!opts.client) throw new RetrievalBackendError(rpc, 'admin_unavailable');
  if (unique.length === 0) return { chunks: new Map(), requested: 0, dropped: 0 };

  const args: Record<string, unknown> = { p_tenant_key: tenantKey, p_ids: unique, p_profile_id: opts.profileId };
  if (groups !== null) args.p_access_groups = groups;
  const response = await opts.client.rpc(rpc, args).abortSignal(opts.signal);
  opts.signal.throwIfAborted();
  if (response.error) {
    logger.error('RAG Backend', `${rpc} failed`, { rpc, code: response.error.code ?? null });
    throw new RetrievalBackendError(rpc, response.error.code ?? 'rpc_error');
  }

  const wanted = new Set(unique);
  const chunks = new Map<string, ValidatedChunk>();
  for (const raw of rpcRows(response.data)) {
    const chunk = toChunk(raw as ValidatedChunkRow);
    if (wanted.has(chunk.chunkId)) chunks.set(chunk.chunkId, chunk);
  }
  return { chunks, requested: unique.length, dropped: unique.length - chunks.size };
}
