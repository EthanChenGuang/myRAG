import { after } from 'next/server';
import { kickVectorSync } from '../sync/kick';
import type { TenantScope } from '../tenant/scope';
import type { ExternalBackendId } from './source-recheck';
import { RetrievalBackendError, type RpcClient } from './supabase-rpc';
import { canonicalTenantKey } from './tenant-key';

/** RET-05 (D-11): at most one repair call per (target, tenant) in this window. */
export const STALE_REPAIR_INTERVAL_MS = 60_000;
/** The SQL function's limit (rag_vector_sync_enqueue_stale, 0740). */
export const STALE_REPAIR_MAX_IDS = 200;
const MAX_KEYS = 1000;
const RPC_NAME = 'rag_vector_sync_enqueue_stale';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface StaleRepairInput {
  target: ExternalBackendId;
  scope: TenantScope;
  chunkIds: readonly string[];
}

export interface StaleRepairDeps {
  /** The service-role client; defaults to the RAG deps' admin client. */
  rpc?: () => RpcClient | null | Promise<RpcClient | null>;
  /** Runs the task after the response; defaults to next/server after(), which throws outside a request scope. */
  schedule?: (task: () => Promise<void>) => void;
  now?: () => number;
  /** One drain slice after the enqueue; defaults to kickVectorSync. */
  kick?: () => void;
  warn?: (line: string, data: Record<string, string | number>) => void;
}

const lastSent = new Map<string, number>();
let testDeps: StaleRepairDeps = {};

function codeOf(error: unknown): string {
  let code = 'unknown';
  if (error instanceof RetrievalBackendError) code = `${error.rpc}:${error.code ?? 'rpc_error'}`.toLowerCase();
  else if (error instanceof Error) code = error.name;
  return CODE_RE.test(code) ? code : 'repair_error';
}

async function defaultRpc(): Promise<RpcClient | null> {
  const { getRagDeps } = await import('../deps');
  return getRagDeps().adminClient() as unknown as RpcClient | null;
}

function remember(key: string, at: number): void {
  lastSent.delete(key);
  lastSent.set(key, at);
  while (lastSent.size > MAX_KEYS) {
    const oldest = lastSent.keys().next().value;
    if (oldest === undefined) break;
    lastSent.delete(oldest);
  }
}

/**
 * RET-05, RET-14: ask the outbox to re-sync the points the external re-validation dropped, for the caller's tenant only, once the
 * response is sent; then kick one drain slice, whose chunk path deletes every point that is not servable (D-02). At most 200 distinct
 * ids per call and one call per (target, tenant) per 60 s. Every error is swallowed with one warning that carries counts only; ids and
 * tenant keys are never logged or traced. A no-op outside a request scope.
 */
export function scheduleStaleRepair(input: StaleRepairInput, callerDeps: StaleRepairDeps = {}): void {
  const deps: StaleRepairDeps = { ...testDeps, ...callerDeps };
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((line, data) => console.warn(line, data));
  let tenantKey: string;
  try {
    tenantKey = canonicalTenantKey(input.scope);
  } catch {
    return;
  }
  const ids = [...new Set(input.chunkIds.filter((id) => typeof id === 'string' && UUID_RE.test(id)).map((id) => id.toLowerCase()))].slice(
    0,
    STALE_REPAIR_MAX_IDS,
  );
  if (ids.length === 0) return;
  const key = `${input.target}|${tenantKey}`;
  const at = now();
  const previous = lastSent.get(key);
  if (previous !== undefined && at - previous < STALE_REPAIR_INTERVAL_MS) return;

  const task = async (): Promise<void> => {
    try {
      const rpc = deps.rpc ? await deps.rpc() : await defaultRpc();
      if (!rpc) return;
      const response = await rpc
        .rpc(RPC_NAME, { p_target: input.target, p_tenant_key: tenantKey, p_chunk_ids: ids })
        .abortSignal(AbortSignal.timeout(10_000));
      if (response.error) throw new RetrievalBackendError(RPC_NAME, response.error.code ?? null);
      (deps.kick ?? kickVectorSync)();
    } catch (error) {
      warn('[Vector Sync] stale repair failed', { code: codeOf(error), requested: ids.length });
    }
  };

  remember(key, at);
  try {
    (deps.schedule ?? after)(task);
  } catch {
    // outside a Next.js request scope there is nothing to extend
    if (lastSent.get(key) === at) lastSent.delete(key);
  }
}

/** Defaults for calls that pass no deps (the search stage); a test seam only. */
export function setStaleRepairDepsForTests(deps: StaleRepairDeps | null): void {
  testDeps = deps ?? {};
}

export function resetStaleRepairForTests(): void {
  lastSent.clear();
  testDeps = {};
}
