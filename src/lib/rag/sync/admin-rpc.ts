import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { getRagDeps } from '../deps';

/** The service-role client for the admin vector-sync routes; null (fail closed) when it is unavailable. */
export function resolveVectorSyncAdminRpc(): RpcClient | null {
  try {
    return (getRagDeps().adminClient() as unknown as RpcClient | null) ?? null;
  } catch {
    return null;
  }
}
