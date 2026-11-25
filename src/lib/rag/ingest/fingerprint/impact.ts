import type { FingerprintImpact } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../../backend/supabase-rpc';

export interface FingerprintReadOptions {
  db?: RpcClient | null;
  tenantKey?: string | null;
  signal?: AbortSignal;
}

export async function computeFingerprintImpact(_proposed: Record<string, string>, _options: FingerprintReadOptions = {}): Promise<FingerprintImpact> {
  return { ingestion_keys: [], by_mechanism: [], without_fingerprint: 0, total_current: 0 };
}
