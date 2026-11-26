import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
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

export async function claimBatch(_rpc: RpcClient, _opts: { limit: number; leaseSeconds: number }): Promise<OutboxRow[]> {
  return [];
}
export async function completeRows(_rpc: RpcClient, _ids: Array<number | string>): Promise<number> {
  return 0;
}
export async function failRow(_rpc: RpcClient, _id: number | string, _code: string): Promise<string | null> {
  return null;
}
export async function checkpointRow(_rpc: RpcClient, _id: number | string, _cursor: string): Promise<boolean> {
  return false;
}
export async function expandRow(_rpc: RpcClient, _id: number | string, _limit: number): Promise<ExpandPage> {
  return { enqueued: 0, nextCursor: null, hasMore: false };
}
export async function readSyncProfiles(_rpc: RpcClient): Promise<SyncProfile[]> {
  return [];
}
export async function readDocumentRows(
  _rpc: RpcClient,
  _args: { tenantKey: string; documentId: string; profileId: string; after: string | null; limit: number },
): Promise<SyncRow[]> {
  return [];
}
export async function readChunkRow(_rpc: RpcClient, _args: { tenantKey: string; chunkId: string; profileId: string }): Promise<SyncRow | null> {
  return null;
}
