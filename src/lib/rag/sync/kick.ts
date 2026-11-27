import { after } from 'next/server';
import { RetrievalBackendError, type RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { VectorSyncTarget } from './stores/types';

export const KICK_BUDGET_MS = 10_000;
export const KICK_TARGETS_TTL_MS = 30_000;
const CODE_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface KickDeps {
  now?: () => number;
  /** The service-role client; defaults to the RAG deps' admin client. */
  rpc?: () => RpcClient | null;
}

let cached: { at: number; targets: VectorSyncTarget[] } | null = null;
let scheduled = false;

function codeOf(error: unknown): string {
  let code = 'unknown';
  if (error instanceof RetrievalBackendError) code = `${error.rpc}:${error.code ?? 'rpc_error'}`.toLowerCase();
  else if (error instanceof Error) code = error.name;
  return CODE_RE.test(code) ? code : 'kick_error';
}

async function defaultRpc(): Promise<RpcClient | null> {
  const { getRagDeps } = await import('../deps');
  return getRagDeps().adminClient() as unknown as RpcClient | null;
}

/**
 * D-04 (a): after a publish, a soft delete or a profile activation, run one in-process drain slice of at most 10 s once the
 * response is sent. A no-op outside a request scope or while no target is enabled (the targets read is cached for 30 s); every
 * error is swallowed with one warning. It never delays or fails the request that called it.
 */
export function kickVectorSync(deps: KickDeps = {}): void {
  const now = deps.now ?? Date.now;
  if (cached && now() - cached.at < KICK_TARGETS_TTL_MS && cached.targets.length === 0) return;
  if (scheduled) return;

  const task = async (): Promise<void> => {
    try {
      const rpc = deps.rpc ? deps.rpc() : await defaultRpc();
      if (!rpc) return;
      let targets: VectorSyncTarget[];
      if (cached && now() - cached.at < KICK_TARGETS_TTL_MS) {
        targets = cached.targets;
      } else {
        const { readEnabledTargets } = await import('./targets');
        cached = { at: now(), targets: [] };
        targets = await readEnabledTargets(rpc);
        cached = { at: now(), targets };
      }
      if (targets.length === 0) return;
      const { runVectorSyncSlice } = await import('./slice');
      await runVectorSyncSlice('drain', { rpc, budgetMs: KICK_BUDGET_MS, targets });
    } catch (error) {
      console.warn('[Vector Sync] kick failed', { code: codeOf(error) });
    } finally {
      scheduled = false;
    }
  };

  try {
    scheduled = true;
    after(task);
  } catch {
    // outside a Next.js request scope there is nothing to extend
    scheduled = false;
  }
}

export function resetVectorSyncKickForTests(): void {
  cached = null;
  scheduled = false;
}
