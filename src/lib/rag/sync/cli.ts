import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { ReconcileReport, VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';
import type { VectorSyncTarget } from './stores/types';
import type { VectorStoreFactories } from './targets';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface VectorSyncCliDeps {
  /** The service-role client; default: built from NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. */
  rpc?: RpcClient;
  factories?: VectorStoreFactories;
  actor?: string;
  maxSlices?: number;
}

export type ParsedSyncArgs =
  | { ok: true; command: 'drain' }
  | { ok: true; command: 'backfill'; target: VectorSyncTarget }
  | { ok: true; command: 'targets'; enabled: boolean; target: VectorSyncTarget }
  | { ok: true; command: 'requeue-dead'; target: VectorSyncTarget }
  | { ok: true; command: 'status' }
  | { ok: true; command: 'reconcile' }
  | { ok: false; error: string };

export const USAGE = [
  'usage: npm run rag:vector-sync -- drain',
  '       npm run rag:vector-sync -- backfill --target weaviate|qdrant',
  '       npm run rag:vector-sync -- targets enable|disable weaviate|qdrant',
  '       npm run rag:vector-sync -- requeue-dead --target weaviate|qdrant',
  '       npm run rag:vector-sync -- status',
  '       npm run rag:reconcile',
].join('\n');

const TARGETS: readonly string[] = ['weaviate', 'qdrant'];
/** A full pass: one slice compares every candidate (the schema needs a finite integer budget). */
const UNSLICED_BUDGET_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SLICES = 10_000;

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

function asTarget(value: string | undefined): VectorSyncTarget | null {
  return value !== undefined && TARGETS.includes(value) ? (value as VectorSyncTarget) : null;
}

function targetFlag(command: string, args: string[]): { ok: true; target: VectorSyncTarget } | { ok: false; error: string } {
  if (args.length !== 2 || args[0] !== '--target') return { ok: false, error: `${command} takes --target weaviate|qdrant` };
  const target = asTarget(args[1]);
  return target ? { ok: true, target } : { ok: false, error: `unknown target: ${String(args[1]).slice(0, 40)}` };
}

export function parseSyncArgs(argv: string[]): ParsedSyncArgs {
  const [program, command, ...rest] = argv;
  if (program === 'reconcile') {
    return command === undefined ? { ok: true, command: 'reconcile' } : { ok: false, error: 'reconcile takes no arguments' };
  }
  if (program !== 'vector-sync') return { ok: false, error: 'unknown program' };
  switch (command) {
    case 'drain':
    case 'status':
      return rest.length === 0 ? { ok: true, command } : { ok: false, error: `${command} takes no arguments` };
    case 'backfill':
    case 'requeue-dead': {
      const flag = targetFlag(command, rest);
      return flag.ok ? { ok: true, command, target: flag.target } : flag;
    }
    case 'targets': {
      const [action, name, ...extra] = rest;
      if ((action !== 'enable' && action !== 'disable') || extra.length > 0) return { ok: false, error: 'targets takes enable|disable <target>' };
      const target = asTarget(name);
      if (!target) return { ok: false, error: `unknown target: ${String(name).slice(0, 40)}` };
      return { ok: true, command: 'targets', enabled: action === 'enable', target };
    }
    default:
      return { ok: false, error: `unknown subcommand: ${String(command).slice(0, 40)}` };
  }
}

async function adminFromEnv(): Promise<RpcClient | null> {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as RpcClient;
}

/** A scalar-returning RPC. */
async function callCount(rpc: RpcClient, fn: string, args: Record<string, unknown>): Promise<number> {
  const { RetrievalBackendError, rpcRows } = await import('@/lib/rag/backend/supabase-rpc');
  const response = await rpc.rpc(fn, args).abortSignal(new AbortController().signal);
  if (response.error) throw new RetrievalBackendError(fn, response.error.code ?? null);
  const [first] = rpcRows(response.data);
  // PostgREST answers a scalar function with the bare value; a SELECT * over it yields one column named after the function.
  const value = first !== null && typeof first === 'object' ? (first as Record<string, unknown>)[fn] : first;
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function sliceLine(report: VectorSyncSliceReport): string {
  return `[Vector Sync] slice ${JSON.stringify(report)}`;
}

/** Counts per (target, state) only: a ReconcileReport carries a tenant key, which the CLI never prints. */
function reconcileSummary(reports: ReconcileReport[]): string[] {
  const counts = new Map<string, number>();
  for (const report of reports) {
    const key = `${report.target} ${report.state}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, n]) => `[Vector Sync] reconcile ${key}: ${n}`);
}

interface ReconcileRun {
  reports: ReconcileReport[];
  allReady: boolean;
}

async function reconcileAll(
  rpc: RpcClient,
  targets: VectorSyncTarget[],
  deps: VectorSyncCliDeps,
  io: CliIo,
): Promise<ReconcileRun> {
  const { reconcileSlice } = await import('./reconcile');
  const { buildVectorSyncStores } = await import('./targets');
  const stores = await buildVectorSyncStores(targets, deps.factories);
  const reports: ReconcileReport[] = [];
  const maxSlices = deps.maxSlices ?? DEFAULT_MAX_SLICES;
  for (let i = 0; i < maxSlices; i += 1) {
    const result = await reconcileSlice({ stores, rpc, budgetMs: UNSLICED_BUDGET_MS });
    io.out(sliceLine(result.slice));
    reports.push(...result.reports);
    if (!result.slice.more_pending) break;
  }
  for (const line of reconcileSummary(reports)) io.out(line);
  const missingStore = stores.length < targets.length;
  return { reports, allReady: !missingStore && reports.every((report) => report.state === 'ready') };
}

async function drainAll(rpc: RpcClient, targets: VectorSyncTarget[], deps: VectorSyncCliDeps, io: CliIo): Promise<boolean> {
  const { drainSlice } = await import('./drain');
  const { buildVectorSyncStores } = await import('./targets');
  const stores = await buildVectorSyncStores(targets, deps.factories);
  const maxSlices = deps.maxSlices ?? DEFAULT_MAX_SLICES;
  let failed = 0;
  for (let i = 0; i < maxSlices; i += 1) {
    const report = await drainSlice({ stores, rpc, budgetMs: UNSLICED_BUDGET_MS });
    io.out(sliceLine(report));
    failed += report.failed;
    if (!report.more_pending) break;
  }
  return failed === 0;
}

/**
 * The CLI body (D-04 c, D-05, D-24). Prints targets, counts and slice reports only: never a key, a tenant key or stored text.
 * Exit codes: 0 done, 1 failed or not ready, 2 wrong arguments, 3 the service-role client cannot be built.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, deps: VectorSyncCliDeps = {}): Promise<number> {
  const parsed = parseSyncArgs(argv);
  if (!parsed.ok) {
    io.err(`[Vector Sync] ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  const rpc = deps.rpc ?? (await adminFromEnv());
  if (!rpc) {
    io.err('[Vector Sync] set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    return 3;
  }
  const actor = deps.actor ?? 'cli';
  const { readVectorSyncStatus, readEnabledTargets } = await import('./targets');

  try {
    switch (parsed.command) {
      case 'status': {
        for (const row of await readVectorSyncStatus(rpc)) {
          const age = row.oldestPendingSeconds === null ? '-' : `${row.oldestPendingSeconds}s`;
          io.out(
            `[Vector Sync] ${row.target}: ${row.enabled ? 'enabled' : 'disabled'}, pending ${row.pending}, leased ${row.leased}, dead ${row.dead}, oldest pending ${age}`,
          );
        }
        return 0;
      }
      case 'targets': {
        const enqueued = await callCount(rpc, 'rag_vector_sync_set_target', { p_target: parsed.target, p_enabled: parsed.enabled, p_actor: actor });
        io.out(`[Vector Sync] ${parsed.target} ${parsed.enabled ? 'enabled' : 'disabled'}; tenants enqueued: ${enqueued}`);
        return 0;
      }
      case 'requeue-dead': {
        const requeued = await callCount(rpc, 'rag_vector_sync_requeue_dead', { p_target: parsed.target });
        io.out(`[Vector Sync] ${parsed.target}: requeued ${requeued} dead rows`);
        return 0;
      }
      case 'drain': {
        const targets = await readEnabledTargets(rpc);
        if (targets.length === 0) {
          io.out('[Vector Sync] no target is enabled; nothing to drain');
          return 0;
        }
        return (await drainAll(rpc, targets, deps, io)) ? 0 : 1;
      }
      case 'backfill': {
        const targets = await readEnabledTargets(rpc);
        if (!targets.includes(parsed.target)) {
          io.err(`[Vector Sync] ${parsed.target} is disabled; run targets enable ${parsed.target} first`);
          return 1;
        }
        // Every enabled target gets its store, so the drain never fails another target's rows for want of one.
        const drained = await drainAll(rpc, targets, deps, io);
        const reconciled = await reconcileAll(rpc, [parsed.target], deps, io);
        return drained && reconciled.allReady ? 0 : 1;
      }
      case 'reconcile': {
        const targets = await readEnabledTargets(rpc);
        if (targets.length === 0) {
          io.out('[Vector Sync] no target is enabled; nothing to reconcile');
          return 0;
        }
        return (await reconcileAll(rpc, targets, deps, io)).allReady ? 0 : 1;
      }
    }
  } catch (error) {
    const { RetrievalBackendError } = await import('@/lib/rag/backend/supabase-rpc');
    const code = error instanceof RetrievalBackendError ? `${error.rpc}:${error.code ?? 'rpc_error'}` : error instanceof Error ? error.name : 'unknown';
    io.err(`[Vector Sync] failed: ${code}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  main(process.argv.slice(2), consoleIo).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error('[Vector Sync] failed', { error: error instanceof Error ? error.name : 'unknown' });
      process.exit(1);
    },
  );
}
