import { logger } from '@/lib/logger';
import type { TenantScope } from '../tenant/scope';
import { RetrievalBackendError, rpcRows, type RpcClient } from './supabase-rpc';
import { canonicalTenantKey } from './tenant-key';
import type { RankedHit } from './types';

export const VALIDATE_RPC = 'rag_validate_chunks';
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
 * no switch: every external result passes through here.
 */
export async function revalidateChunks(
  scope: TenantScope,
  ids: readonly string[],
  opts: { client: RpcClient | null; profileId: string; signal: AbortSignal },
): Promise<RevalidateResult> {
  const tenantKey = canonicalTenantKey(scope);
  const unique = [...new Set(ids)];
  if (unique.length > MAX_VALIDATE_IDS) throw new RetrievalBackendError(VALIDATE_RPC, 'too_many_ids');
  if (!opts.client) throw new RetrievalBackendError(VALIDATE_RPC, 'admin_unavailable');
  if (unique.length === 0) return { chunks: new Map(), requested: 0, dropped: 0 };

  const response = await opts.client
    .rpc(VALIDATE_RPC, { p_tenant_key: tenantKey, p_ids: unique, p_profile_id: opts.profileId })
    .abortSignal(opts.signal);
  opts.signal.throwIfAborted();
  if (response.error) {
    logger.error('RAG Backend', 'rag_validate_chunks failed', { rpc: VALIDATE_RPC, code: response.error.code ?? null });
    throw new RetrievalBackendError(VALIDATE_RPC, response.error.code ?? 'rpc_error');
  }

  const wanted = new Set(unique);
  const chunks = new Map<string, ValidatedChunk>();
  for (const raw of rpcRows(response.data)) {
    const chunk = toChunk(raw as ValidatedChunkRow);
    if (wanted.has(chunk.chunkId)) chunks.set(chunk.chunkId, chunk);
  }
  return { chunks, requested: unique.length, dropped: unique.length - chunks.size };
}
