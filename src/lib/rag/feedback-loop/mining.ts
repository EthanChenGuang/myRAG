import type { SupabaseClient } from '@supabase/supabase-js';
import type { MiningRunResult } from '@/lib/rag-eval/contracts.generated';
import type { FeedbackLoopEnvSource, FeedbackMiningConfig } from './config';
import type { PurgeCounts } from './purge';

export const MAX_MINING_WINDOW_DAYS = 31;
export const MINING_RPC = 'rag_mine_failed_queries_report';

export type MiningDisabledReason = 'domain_expert_review_off' | 'retrieval_log_not_masked_query';

export class MiningError extends Error {
  constructor(readonly code: string) {
    super(`[Feedback Loop] mining failed (${code})`);
    this.name = 'MiningError';
  }
}

export interface MiningWindowInput {
  since?: Date;
  until?: Date;
}

export interface RunMiningDeps {
  client?: SupabaseClient | null;
  env?: FeedbackLoopEnvSource;
  loadConfig?: () => { config: FeedbackMiningConfig; sha256: string };
  purge?: (client: SupabaseClient, retentionDays: number) => Promise<PurgeCounts>;
  now?: () => number;
  log?: (line: string) => void;
}

export function tenantHash(_tenantKey: string): string {
  return '';
}

export function parseMiningDate(_text: string): Date | null {
  return null;
}

export function miningDisabledReason(_env: FeedbackLoopEnvSource = process.env): MiningDisabledReason | null {
  return 'domain_expert_review_off';
}

export function isMiningWindowError(_error: unknown): boolean {
  return false;
}

export async function runMining(_window: MiningWindowInput = {}, deps: RunMiningDeps = {}): Promise<MiningRunResult> {
  const now = new Date((deps.now ?? Date.now)()).toISOString();
  return {
    schema_version: 1,
    status: 'disabled',
    disabled_reason: 'domain_expert_review_off',
    since: now,
    until: now,
    config_sha256: null,
    purged_log_rows: 0,
    purged_review_items: 0,
    total_inserted: 0,
    tenants: [],
  };
}
