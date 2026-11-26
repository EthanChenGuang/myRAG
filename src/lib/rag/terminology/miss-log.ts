import type { RpcClient } from '../backend/supabase-rpc';
import type { RefusalRecord } from '../refusal/types';
import type { TenantScope } from '../tenant/scope';
import type { Candidate, Profile, RetrievalStatus } from '../types';
import type { TerminologyHashStage } from '../v2/config-hash';

export const MISS_LOG_TIMEOUT_MS = 500;

export interface MissLogInput {
  enabled: boolean;
  profile: Profile;
  scope: TenantScope | null;
  query: string;
  queryLanguage: string | null;
  status: RetrievalStatus;
  reason: string;
  refusal: RefusalRecord | null;
  candidates: readonly Candidate[];
  scoredCandidates?: readonly Candidate[];
  terminology?: TerminologyHashStage;
  retrievalConfigHash: string;
}

export interface MissLogOptions {
  client?: RpcClient;
  timeoutMs?: number;
}

export function shouldRecordMiss(_input: MissLogInput): boolean {
  return false;
}

export async function recordMiss(_input: MissLogInput, _options: MissLogOptions = {}): Promise<void> {}
