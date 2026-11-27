import type { SupabaseClient } from '@supabase/supabase-js';
import type { RpcClient } from '../backend/supabase-rpc';

export const LEXSTATS_READY_TTL_MS = 60_000;

export async function lexstatsReady(_client: RpcClient, _tenantKey: string, _now: number = Date.now()): Promise<boolean> {
  return false;
}

export function dropLexstatsReady(_tenantKey: string): void {}

export async function countReadyLexstatsTenants(_client: SupabaseClient): Promise<number | null> {
  return null;
}

export function resetLexstatsCacheForTests(): void {}
