import type { SupabaseClient } from '@supabase/supabase-js';

export const MISS_RECORDER_RPC = 'rag_term_record_miss';
export const BRIDGE_REASONS: readonly string[] = [];

export interface BridgeTenant {
  tenantKey: string;
  inserted: number;
}

export interface BridgeInput {
  until: Date;
  tenants: readonly BridgeTenant[];
}

export interface BridgeDeps {
  client: SupabaseClient;
  enabled: boolean;
  log?: (line: string) => void;
}

export interface BridgeCounts {
  recorded: number;
  skipped: number;
  failed: number;
}

export function miningWindowStart(until: Date): Date {
  return until;
}

export async function bridgeToTerminologyMisses(_input: BridgeInput, _deps: BridgeDeps): Promise<BridgeCounts> {
  return { recorded: 0, skipped: 0, failed: 0 };
}
