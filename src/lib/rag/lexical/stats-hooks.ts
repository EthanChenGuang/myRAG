import type { RpcClient } from '../backend/supabase-rpc';
import { scalarOf } from '../cache/wire';
import type { RagConfig } from '../config';
import { compactTenantStats, enableTenantStats, LexstatsRpcError, rebuildTenantStats, type LexstatsDb } from './stats-admin';
import { tenantHash } from './stats-cli';

/** How long a write path waits for the statistics follow-up before it gives up (D-17, T-04.4-30). */
export const LEXICAL_WRITE_TIMEOUT_MS = 5_000;
const MAX_LOGGED = 1000;

export interface LexicalWriteDeps {
  /** The service-role admin client; the 0902 functions are service_role only. */
  db: () => RpcClient | null;
  /** Read for the scoring mode when given (the relex run's configuration); absent, the app configuration. */
  config?: Pick<RagConfig, 'v2'>;
  timeoutMs?: number;
}

/** Tenant-key hashes already logged in this process, so a tenant with a broken setup logs once. */
const logged = new Set<string>();

function logOnce(tenantKey: string, rpc: string, code: string): void {
  const hash = tenantHash(tenantKey);
  if (logged.has(hash)) return;
  if (logged.size >= MAX_LOGGED) return;
  logged.add(hash);
  console.warn(`[Lexical Stats] ${hash} ${rpc} failed (${code}); the write is kept and the next publish, relex or rag:lexstats run catches up`);
}

async function lexicalScoring(config: Pick<RagConfig, 'v2'> | undefined): Promise<{ mode: string; dfMode: string; rerankLocalStats: string }> {
  try {
    // Loaded on use: the fixture harness imports the write paths before the app environment is set.
    const v2 = config
      ? config.v2
      : await Promise.all([import('../config'), import('../deps')]).then(([{ loadRagConfig }, { getRagDeps }]) => loadRagConfig(getRagDeps().ragEnv()).v2);
    const scoring = v2?.lexicalScoring;
    return { mode: scoring?.mode ?? 'ts_rank_cd', dfMode: scoring?.dfMode ?? 'raw', rerankLocalStats: v2?.rerankLocalStats ?? 'pool' };
  } catch {
    return { mode: 'ts_rank_cd', dfMode: 'raw', rerankLocalStats: 'pool' };
  }
}

/** D-17, 04.4-21 D-55: the statistics are kept fresh while bm25 scores the lexical leg or the local reranker reads them (tenant mode). */
async function statsInUse(config: Pick<RagConfig, 'v2'> | undefined): Promise<boolean> {
  const scoring = await lexicalScoring(config);
  return scoring.mode === 'bm25' || scoring.rerankLocalStats === 'tenant';
}

/**
 * Only `rpc` is used by enable, rebuild and compact. A scalar answer may also come as the one-row shape keyed by the function name (the
 * fixture edge's shape for a scalar function, the scalarOf rule of the cache wire).
 */
function adminOf(db: RpcClient): LexstatsDb {
  return {
    rpc: async (fn, args) => {
      const response = await db.rpc(fn, args);
      return response.error ? response : { ...response, data: scalarOf(response.data, fn) };
    },
    from: () => {
      throw new LexstatsRpcError('from', 'unsupported');
    },
  };
}

/**
 * D-17: after a write that changed a tenant's member chunks, and only while RAG_LEXICAL_SCORING resolves to bm25 or the effective
 * RAG_RERANK_LOCAL_STATS is tenant (04.4-21, rerankLocalStats), makes sure the tenant
 * keeps statistics (enable; a rebuild while the state is building) and folds its pending rows once (one compaction batch). Best effort:
 * it resolves within the timeout whatever happens, never throws, and logs a failure once per process and tenant-key hash with the rpc
 * name and code only (T-04.4-31). The calls it started keep running in the database after a timeout; the advisory lock in 0902 orders
 * them with any later caller.
 */
export async function afterLexicalWrite(deps: LexicalWriteDeps, tenantKey: string): Promise<void> {
  if (!(await statsInUse(deps.config))) return;
  let db: RpcClient | null;
  try {
    db = deps.db();
  } catch {
    db = null;
  }
  if (!db) return;
  const admin = adminOf(db);
  let step = 'rag_lexstats_enable';
  const work = (async () => {
    const state = await enableTenantStats(admin, tenantKey);
    if (state === 'building') {
      step = 'rag_lexstats_rebuild';
      await rebuildTenantStats(admin, tenantKey);
    }
    step = 'rag_lexstats_compact';
    await compactTenantStats(admin, tenantKey);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), deps.timeoutMs ?? LEXICAL_WRITE_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([work.then(() => 'done' as const), timedOut]);
    if (outcome === 'timeout') {
      work.catch(() => undefined);
      logOnce(tenantKey, step, 'timeout');
    }
  } catch (error) {
    if (error instanceof LexstatsRpcError) logOnce(tenantKey, error.rpc, error.code);
    else logOnce(tenantKey, step, 'rejected');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * D-48, D-49: after `npm run rag:dup-clusters` changed a tenant's clusters, and only while bm25 is effective with RAG_LEXICAL_DF_MODE=cluster,
 * the same best-effort follow-up as a publish (enable when missing, one compaction batch, which reconciles the cluster markers). Returns
 * whether it ran; never throws.
 */
export async function afterDupClusterWrite(deps: LexicalWriteDeps, tenantKey: string): Promise<boolean> {
  const scoring = await lexicalScoring(deps.config);
  if (scoring.mode !== 'bm25' || scoring.dfMode !== 'cluster') return false;
  await afterLexicalWrite(deps, tenantKey);
  return true;
}

export function resetLexicalWriteLogForTests(): void {
  logged.clear();
}
