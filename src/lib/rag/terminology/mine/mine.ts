import type { RpcClient } from '../../backend/supabase-rpc';
import type { TenantScope } from '../../tenant/scope';

export type MinerDb = RpcClient & { from(table: string): unknown };

export function extractTerms(_query: string): string[] {
  return [];
}

export async function readMisses(_db: MinerDb, _input: { tenantKey?: string | null; windowDays: number }): Promise<Array<{ tenantKey: string; misses: Array<Record<string, unknown>> }>> {
  return [];
}

export async function mineCandidates(_input: {
  db?: MinerDb;
  resolveScope?: (tenantKey: string) => Promise<TenantScope | null>;
  tenantKey?: string | null;
  dryRun?: boolean;
}): Promise<{ tenants: Array<Record<string, unknown>> }> {
  return { tenants: [] };
}
