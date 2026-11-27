import type { BackendConfig } from '../config';
import { getRagDeps } from '../deps';
import type { TenantScope } from '../tenant/scope';
import { rpcRows, type RpcClient } from './supabase-rpc';
import { canonicalTenantKey } from './tenant-key';

export type ExternalBackendTarget = 'weaviate' | 'qdrant';

export interface BackendReadinessInput {
  target: ExternalBackendTarget;
  profileId: string;
  scope: TenantScope;
  config: Pick<BackendConfig, 'maxLagSeconds'>;
  /** Defaults to the admin client; null means not ready. */
  rpc?: RpcClient | null;
  now?: () => number;
}

/** D-11: the index state is read at most once per 30 s per (target, profile, tenant) in each process. */
export const READINESS_TTL_MS = 30_000;
const WARN_INTERVAL_MS = 60_000;
const RPC_NAME = 'rag_backend_readiness';

interface ReadinessRow {
  state: string | null;
  lagSeconds: number;
}

const cache = new Map<string, { row: ReadinessRow | null; at: number }>();
let lastWarnAt: number | null = null;

function finiteLag(value: unknown): number {
  const lag = typeof value === 'string' ? Number(value) : value;
  return typeof lag === 'number' && Number.isFinite(lag) && lag >= 0 ? lag : 0;
}

function warnReadFailure(now: number, target: ExternalBackendTarget, kind: string): void {
  if (lastWarnAt !== null && now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn('[RAG Backend] readiness read failed, using pgvector', { target, kind });
}

function defaultRpc(): RpcClient | null {
  try {
    return getRagDeps().adminClient() as unknown as RpcClient | null;
  } catch {
    return null;
  }
}

/** The live lag is the outbox age (outbox_lag_seconds); the larger of it and the last reconcile's lag is compared to the maximum. */
async function readRow(rpc: RpcClient, target: ExternalBackendTarget, profileId: string, tenantKey: string): Promise<ReadinessRow | null> {
  const { data, error } = await rpc.rpc(RPC_NAME, { p_target: target, p_profile_id: profileId, p_tenant_key: tenantKey });
  if (error) throw new Error('readiness_rpc_error');
  const row = rpcRows(data)[0];
  if (!row || typeof row !== 'object') return null;
  const record = row as Record<string, unknown>;
  const state = typeof record.state === 'string' ? record.state : null;
  return { state, lagSeconds: Math.max(finiteLag(record.outbox_lag_seconds), finiteLag(record.lag_seconds)) };
}

/**
 * D-11: true only when the index state of (target, profile, tenant) is ready and its lag is within config.maxLagSeconds. A missing
 * row, a read error or a missing admin client is "not ready" (the request then uses pgvector); this function never throws.
 */
export async function isBackendReady(input: BackendReadinessInput): Promise<boolean> {
  const now = input.now ?? Date.now;
  let tenantKey: string;
  try {
    tenantKey = canonicalTenantKey(input.scope);
  } catch {
    return false;
  }
  const key = `${input.target}|${input.profileId}|${tenantKey}`;
  const at = now();
  const cached = cache.get(key);
  let row: ReadinessRow | null;
  if (cached && at - cached.at < READINESS_TTL_MS) {
    row = cached.row;
  } else {
    const rpc = input.rpc === undefined ? defaultRpc() : input.rpc;
    if (!rpc) {
      warnReadFailure(at, input.target, 'admin_client_unavailable');
      return false;
    }
    try {
      row = await readRow(rpc, input.target, input.profileId, tenantKey);
    } catch {
      warnReadFailure(at, input.target, 'read_failed');
      // A failed read is remembered as "no row" for the TTL, so a broken database is not asked again on every request.
      row = null;
    }
    cache.set(key, { row, at });
  }
  return row !== null && row.state === 'ready' && row.lagSeconds <= input.config.maxLagSeconds;
}

export function resetReadinessCacheForTests(options: { keepWarnClock?: boolean } = {}): void {
  cache.clear();
  if (!options.keepWarnClock) lastWarnAt = null;
}
