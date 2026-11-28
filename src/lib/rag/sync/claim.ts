import { RetrievalBackendError, rpcRows, type RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { SyncRow } from './servable';

export type OutboxEntity = 'chunk' | 'document' | 'profile' | 'tenant';

export interface OutboxRow {
  id: number | string;
  target: string;
  entity: OutboxEntity;
  entity_id: string;
  tenant_key: string | null;
  profile_id: string | null;
  cursor: string | null;
  attempts: number;
  enqueued_at: string;
}

export interface SyncProfile {
  profile_id: string;
  dims: number;
  storage: string;
}

export interface ExpandPage {
  enqueued: number;
  nextCursor: string | null;
  hasMore: boolean;
}

const MAX_ERROR_CODE = 200;

/** One call to a 0703/0705 RPC on the injected client (the admin client in production); an RPC error is never swallowed. */
async function call(rpc: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown[]> {
  const response = await rpc.rpc(fn, args).abortSignal(new AbortController().signal);
  if (response.error) throw new RetrievalBackendError(fn, response.error.code ?? null);
  return rpcRows(response.data);
}

export async function claimBatch(rpc: RpcClient, opts: { limit: number; leaseSeconds: number }): Promise<OutboxRow[]> {
  return (await call(rpc, 'rag_vector_sync_claim', { p_limit: opts.limit, p_lease_seconds: opts.leaseSeconds })) as OutboxRow[];
}

export async function completeRows(rpc: RpcClient, ids: Array<number | string>): Promise<number> {
  if (ids.length === 0) return 0;
  const [count] = await call(rpc, 'rag_vector_sync_complete', { p_ids: ids });
  return Number(count ?? 0);
}

/** Codes only (D-04): the SQL side replaces anything that is not a code; the wrapper caps the length. Returns pending, dead or null. */
export async function failRow(rpc: RpcClient, id: number | string, code: string): Promise<string | null> {
  const safe = (code || 'unknown').slice(0, MAX_ERROR_CODE);
  const [state] = await call(rpc, 'rag_vector_sync_fail', { p_id: id, p_error: safe });
  return typeof state === 'string' ? state : null;
}

/** A-12: stores a paging cursor and hands the row back without counting the attempt. */
export async function checkpointRow(rpc: RpcClient, id: number | string, cursor: string): Promise<boolean> {
  const [found] = await call(rpc, 'rag_vector_sync_checkpoint', { p_id: id, p_cursor: cursor });
  return found === true;
}

export async function expandRow(rpc: RpcClient, id: number | string, limit: number): Promise<ExpandPage> {
  const [page] = (await call(rpc, 'rag_vector_sync_expand', { p_id: id, p_limit: limit })) as Array<{
    enqueued: number | null;
    next_cursor: string | null;
    has_more: boolean | null;
  }>;
  return { enqueued: Number(page?.enqueued ?? 0), nextCursor: page?.next_cursor ?? null, hasMore: page?.has_more === true };
}

export async function readSyncProfiles(rpc: RpcClient): Promise<SyncProfile[]> {
  return (await call(rpc, 'rag_vector_sync_profiles', {})) as SyncProfile[];
}

export async function readDocumentRows(
  rpc: RpcClient,
  args: { tenantKey: string; documentId: string; profileId: string; after: string | null; limit: number },
): Promise<SyncRow[]> {
  return (await call(rpc, 'rag_vector_sync_document_rows', {
    p_tenant_key: args.tenantKey,
    p_document_id: args.documentId,
    p_profile_id: args.profileId,
    p_after: args.after,
    p_limit: args.limit,
  })) as SyncRow[];
}

export async function readChunkRow(rpc: RpcClient, args: { tenantKey: string; chunkId: string; profileId: string }): Promise<SyncRow | null> {
  const rows = (await call(rpc, 'rag_vector_sync_chunk_row', {
    p_tenant_key: args.tenantKey,
    p_chunk_id: args.chunkId,
    p_profile_id: args.profileId,
  })) as SyncRow[];
  return rows[0] ?? null;
}
