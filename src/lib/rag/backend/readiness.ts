import type { BackendConfig } from '../config';
import type { TenantScope } from '../tenant/scope';
import type { RpcClient } from './supabase-rpc';

export type ExternalBackendTarget = 'weaviate' | 'qdrant';

export interface BackendReadinessInput {
  target: ExternalBackendTarget;
  profileId: string;
  scope: TenantScope;
  config: Pick<BackendConfig, 'maxLagSeconds'>;
  rpc?: RpcClient | null;
  now?: () => number;
}

export async function isBackendReady(_input: BackendReadinessInput): Promise<boolean> {
  return true;
}

export function resetReadinessCacheForTests(_options: { keepWarnClock?: boolean } = {}): void {}

export const READINESS_TTL_MS = 0;
