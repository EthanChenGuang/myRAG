import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { isTenantKey } from '../ingest/writer';
import {
  DEFAULT_COMPACT_MAX_ROWS,
  LexstatsRpcError,
  checkTenantStats,
  compactTenantStats,
  disableClusterStats,
  disableTenantStats,
  enableClusterStats,
  enableTenantStats,
  listStatsTenants,
  rebuildTenantStats,
  statusTenantStats,
  type LexstatsDb,
  type TenantStatsCheck,
  type TenantStatsStatus,
} from './stats-admin';

export const LEXSTATS_COMMANDS = ['enable', 'rebuild', 'compact', 'check', 'status', 'disable'] as const;
export type LexstatsCommand = (typeof LEXSTATS_COMMANDS)[number];

export type LexstatsTarget = { kind: 'tenant'; tenantKey: string } | { kind: 'all' };

export type ParsedLexstatsArgs =
  | { ok: true; command: LexstatsCommand; target: LexstatsTarget; repair: boolean; maxRows: number; json: boolean; cluster: boolean }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface LexstatsDeps {
  db: LexstatsDb;
  /** The effective RAG_LEXICAL_SCORING mode; under `bm25` a tenant that is not ready fails `check`. */
  scoringMode: 'ts_rank_cd' | 'bm25';
  /** The effective RAG_LEXICAL_DF_MODE (D-45); under `cluster`, `enable` without --cluster prints a hint and enables nothing more. */
  dfMode?: 'raw' | 'cluster';
}

/** Sub-commands that take --cluster (D-49): the cluster-aware corpus chunks_cluster of 0905. */
const CLUSTER_COMMANDS: readonly LexstatsCommand[] = ['enable', 'rebuild', 'check', 'disable'];

const MAX_ROWS_LIMIT = 50000;
const COMPACT_LOOP_LIMIT = 100000;
const PREFIX = '[Lexical Stats]';

export const USAGE =
  'usage: npm run rag:lexstats -- <enable|rebuild|compact|check|status|disable> [--tenant <key> | --all] [--cluster] [--repair] [--max-rows <n>] [--json]\n' +
  '  --cluster (enable, rebuild, check, disable): the cluster-aware statistics of RAG_LEXICAL_DF_MODE=cluster; disable --cluster removes only those';

/** `<command> (--tenant <key> | --all) [--repair] [--max-rows n] [--json]`; --repair only with check, --max-rows only with compact. */
export function parseLexstatsArgs(argv: string[]): ParsedLexstatsArgs {
  const [command, ...rest] = argv;
  if (command === undefined) return { ok: false, error: 'missing sub-command' };
  if (!(LEXSTATS_COMMANDS as readonly string[]).includes(command)) return { ok: false, error: `unknown sub-command: ${command.slice(0, 32)}` };

  const seen = new Set<string>();
  let tenantKey: string | null = null;
  let rawMaxRows: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg !== '--tenant' && arg !== '--max-rows' && arg !== '--all' && arg !== '--repair' && arg !== '--json' && arg !== '--cluster') {
      return { ok: false, error: `unknown option: ${arg.slice(0, 32)}` };
    }
    if (seen.has(arg)) return { ok: false, error: `${arg} was given twice` };
    seen.add(arg);
    if (arg === '--tenant' || arg === '--max-rows') {
      const value = rest[(i += 1)];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
      if (arg === '--tenant') tenantKey = value;
      else rawMaxRows = value;
    }
  }

  const all = seen.has('--all');
  if (tenantKey !== null && all) return { ok: false, error: '--tenant and --all cannot be combined' };
  if (tenantKey === null && !all) return { ok: false, error: 'give --tenant <key> or --all' };
  if (tenantKey !== null && !isTenantKey(tenantKey)) return { ok: false, error: '--tenant needs a tenant key: s:default, u:<uuid> or o:<uuid>' };
  if (command === 'disable' && all) return { ok: false, error: 'disable --all is refused: disable one tenant at a time' };

  const cluster = seen.has('--cluster');
  if (cluster && !CLUSTER_COMMANDS.includes(command as LexstatsCommand)) return { ok: false, error: '--cluster goes with enable, rebuild, check or disable' };

  const repair = seen.has('--repair');
  if (repair && command !== 'check') return { ok: false, error: '--repair only goes with check' };

  let maxRows = DEFAULT_COMPACT_MAX_ROWS;
  if (rawMaxRows !== null) {
    if (command !== 'compact') return { ok: false, error: '--max-rows only goes with compact' };
    const parsed = /^\d+$/.test(rawMaxRows) ? Number(rawMaxRows) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ROWS_LIMIT) return { ok: false, error: `--max-rows needs an integer from 1 to ${MAX_ROWS_LIMIT}` };
    maxRows = parsed;
  }

  return {
    ok: true,
    command: command as LexstatsCommand,
    target: tenantKey !== null ? { kind: 'tenant', tenantKey } : { kind: 'all' },
    repair,
    maxRows,
    json: seen.has('--json'),
    cluster,
  };
}

/** Display id of a tenant key: sha256, first 12 hex characters (D-34). */
export function tenantHash(tenantKey: string): string {
  return createHash('sha256').update(tenantKey).digest('hex').slice(0, 12);
}

interface TenantReport {
  status: TenantStatsStatus;
  check?: TenantStatsCheck;
  extra?: Record<string, number | boolean>;
}

function report(io: CliIo, json: boolean, command: LexstatsCommand, tenantKey: string, showKey: boolean, r: TenantReport): void {
  const state = r.status.state ?? 'not_enabled';
  const fields: Record<string, unknown> = {
    tenant: tenantHash(tenantKey),
    ...(showKey ? { tenant_key: tenantKey } : {}),
    command,
    state,
    chunks: r.status.chunkCount,
    lexemes: r.status.lexemeCount,
    pending: r.status.pending,
  };
  if (r.check) {
    fields.df_mismatch = r.check.dfMismatchWithPending;
    fields.chunk_count_diff = r.check.chunkCountDiffWithPending;
    fields.total_len_diff = r.check.totalLenDiffWithPending;
    fields.clean = r.check.clean;
  }
  // Cluster fields whenever the tenant keeps cluster statistics (counts and states only, D-34).
  const clusterStatus = r.status.cluster ?? null;
  if (clusterStatus || r.check?.cluster) {
    fields.cluster_status = r.check?.cluster?.status ?? clusterStatus?.status;
    fields.cluster_dirty = r.check?.cluster?.dirty ?? clusterStatus?.dirty;
    if (clusterStatus) fields.cluster_oldest_dirty_age_s = clusterStatus.oldestDirtyAgeS;
  }
  if (r.check?.cluster) {
    fields.cluster_df_diff = r.check.cluster.dfDiff;
    fields.cluster_chunk_count_diff = r.check.cluster.chunkCountDiff;
    fields.cluster_total_len_diff = r.check.cluster.totalLenDiff;
    fields.cluster_ledger_diff = r.check.cluster.ledgerDiff;
  }
  Object.assign(fields, r.extra ?? {});
  if (json) {
    io.out(JSON.stringify(fields));
    return;
  }
  const tail = Object.entries(fields)
    .filter(([k]) => !['tenant', 'tenant_key', 'command', 'state', 'chunks', 'lexemes', 'pending'].includes(k))
    .map(([k, v]) => `${k}=${v === null ? '-' : String(v)}`);
  io.out(
    [`${fields.tenant} ${state} chunks=${fields.chunks} lexemes=${fields.lexemes} pending=${fields.pending}`, ...tail, ...(showKey ? [`tenant=${tenantKey}`] : [])].join(
      ' ',
    ),
  );
}

async function compactAll(db: LexstatsDb, tenantKey: string, maxRows: number): Promise<number> {
  let folded = 0;
  for (let i = 0; i < COMPACT_LOOP_LIMIT; i += 1) {
    const n = await compactTenantStats(db, tenantKey, maxRows);
    if (n === 0) return folded;
    folded += n;
  }
  throw new LexstatsRpcError('rag_lexstats_compact', 'no_converge');
}

/** Runs one sub-command for one tenant; returns whether the tenant passed (false makes the exit code 1). */
async function runTenant(parsed: Extract<ParsedLexstatsArgs, { ok: true }>, tenantKey: string, io: CliIo, deps: LexstatsDeps): Promise<boolean> {
  const { db } = deps;
  const showKey = parsed.target.kind === 'tenant';
  const emit = (r: TenantReport) => report(io, parsed.json, parsed.command, tenantKey, showKey, r);

  if (parsed.cluster) return runCluster(parsed, tenantKey, io, deps, emit);

  switch (parsed.command) {
    case 'enable': {
      const before = await enableTenantStats(db, tenantKey);
      if (deps.dfMode === 'cluster') {
        io.err(`${PREFIX} ${tenantHash(tenantKey)} RAG_LEXICAL_DF_MODE=cluster: add --cluster to build the cluster-aware statistics; raw BM25 serves this tenant until then`);
      }
      let rebuilds = 0;
      if (before !== 'ready') {
        await rebuildTenantStats(db, tenantKey);
        rebuilds += 1;
      }
      let check = await checkTenantStats(db, tenantKey);
      if (check.clean !== true) {
        await rebuildTenantStats(db, tenantKey);
        rebuilds += 1;
        check = await checkTenantStats(db, tenantKey);
      }
      emit({ status: await statusTenantStats(db, tenantKey), check, extra: { rebuilds } });
      return check.clean === true;
    }
    case 'rebuild': {
      const status = await statusTenantStats(db, tenantKey);
      if (status.state === null) {
        emit({ status });
        io.err(`${PREFIX} ${tenantHash(tenantKey)} not enabled: run enable first`);
        return false;
      }
      await rebuildTenantStats(db, tenantKey);
      const check = await checkTenantStats(db, tenantKey);
      emit({ status: await statusTenantStats(db, tenantKey), check });
      return check.clean === true;
    }
    case 'compact': {
      const folded = await compactAll(db, tenantKey, parsed.maxRows);
      emit({ status: await statusTenantStats(db, tenantKey), extra: { folded } });
      return true;
    }
    case 'check': {
      let check = await checkTenantStats(db, tenantKey);
      let repaired = false;
      if (parsed.repair && check.state !== null && check.clean !== true) {
        await rebuildTenantStats(db, tenantKey);
        repaired = true;
        check = await checkTenantStats(db, tenantKey);
      }
      emit({ status: await statusTenantStats(db, tenantKey), check, ...(parsed.repair ? { extra: { repaired } } : {}) });
      const drift = check.state !== null && check.clean !== true;
      const notReady = deps.scoringMode === 'bm25' && check.state !== 'ready';
      return !drift && !notReady;
    }
    case 'status': {
      emit({ status: await statusTenantStats(db, tenantKey) });
      return true;
    }
    case 'disable': {
      const removed = await disableTenantStats(db, tenantKey);
      emit({ status: await statusTenantStats(db, tenantKey), extra: { removed } });
      return true;
    }
  }
}

function clusterClean(check: TenantStatsCheck): boolean {
  return check.clean === true && check.cluster?.status === 'ready';
}

/**
 * --cluster (D-49). enable: raw enable when missing, rag_lexstats_cluster_enable, rebuild, check, one more rebuild when the check is not
 * clean (D-18). rebuild and check need a cluster-enabled tenant; check fails on any cluster difference (--repair rebuilds once).
 * disable removes only the cluster statistics.
 */
async function runCluster(
  parsed: Extract<ParsedLexstatsArgs, { ok: true }>,
  tenantKey: string,
  io: CliIo,
  deps: LexstatsDeps,
  emit: (r: TenantReport) => void,
): Promise<boolean> {
  const { db } = deps;
  const notEnabled = async (): Promise<boolean> => {
    emit({ status: await statusTenantStats(db, tenantKey) });
    io.err(`${PREFIX} ${tenantHash(tenantKey)} cluster statistics not enabled: run enable --cluster first`);
    return false;
  };
  switch (parsed.command) {
    case 'enable': {
      await enableTenantStats(db, tenantKey);
      await enableClusterStats(db, tenantKey);
      await rebuildTenantStats(db, tenantKey);
      let rebuilds = 1;
      let check = await checkTenantStats(db, tenantKey);
      if (!clusterClean(check)) {
        await rebuildTenantStats(db, tenantKey);
        rebuilds += 1;
        check = await checkTenantStats(db, tenantKey);
      }
      emit({ status: await statusTenantStats(db, tenantKey), check, extra: { rebuilds } });
      return clusterClean(check);
    }
    case 'rebuild': {
      if (!(await statusTenantStats(db, tenantKey)).cluster) return notEnabled();
      await rebuildTenantStats(db, tenantKey);
      const check = await checkTenantStats(db, tenantKey);
      emit({ status: await statusTenantStats(db, tenantKey), check });
      return clusterClean(check);
    }
    case 'check': {
      let check = await checkTenantStats(db, tenantKey);
      if (!check.cluster) return notEnabled();
      let repaired = false;
      if (parsed.repair && !clusterClean(check)) {
        await rebuildTenantStats(db, tenantKey);
        repaired = true;
        check = await checkTenantStats(db, tenantKey);
      }
      emit({ status: await statusTenantStats(db, tenantKey), check, ...(parsed.repair ? { extra: { repaired } } : {}) });
      return clusterClean(check);
    }
    case 'disable': {
      const removed = await disableClusterStats(db, tenantKey);
      emit({ status: await statusTenantStats(db, tenantKey), extra: { cluster_removed: removed } });
      return true;
    }
    default:
      return false;
  }
}

/**
 * The command body, for tests: parses the arguments and runs the sub-command per tenant. Exit code 0 when every tenant passed,
 * 1 on drift, a not-ready tenant under bm25 or a failed call (the loop goes on with the next tenant), 2 on bad arguments.
 * Prints tenant-key hashes and counts only; a raw key only when --tenant named it, never a lexeme (D-19, D-34).
 */
export async function runLexstatsCli(argv: string[], io: CliIo, deps: LexstatsDeps): Promise<number> {
  const parsed = parseLexstatsArgs(argv);
  if (!parsed.ok) {
    io.err(`${PREFIX} ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }

  let failed = false;
  const one = async (tenantKey: string) => {
    try {
      if (!(await runTenant(parsed, tenantKey, io, deps))) failed = true;
    } catch (error) {
      failed = true;
      if (error instanceof LexstatsRpcError) io.err(`${PREFIX} ${tenantHash(tenantKey)} ${error.rpc} failed (${error.code})`);
      else io.err(`${PREFIX} ${tenantHash(tenantKey)} failed (${error instanceof Error ? error.name : 'unknown'})`);
    }
  };

  if (parsed.target.kind === 'tenant') {
    await one(parsed.target.tenantKey);
    return failed ? 1 : 0;
  }

  // enable --all starts from the tenants that have member chunks; every other command works on the tenants that keep statistics.
  const source = parsed.command === 'enable' ? 'chunks' : 'enabled';
  let tenants = 0;
  try {
    for await (const tenantKey of listStatsTenants(deps.db, source)) {
      tenants += 1;
      await one(tenantKey);
    }
  } catch (error) {
    failed = true;
    if (error instanceof LexstatsRpcError) io.err(`${PREFIX} tenant listing: ${error.rpc} failed (${error.code})`);
    else io.err(`${PREFIX} tenant listing failed`);
  }
  if (!parsed.json) io.err(`${PREFIX} ${parsed.command}: ${tenants} tenant(s)${failed ? ', with failures' : ''}`);
  return failed ? 1 : 0;
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

/** CLI entry. Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; works whatever RAG_LEXICAL_SCORING says. */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo): Promise<number> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    io.out(USAGE);
    return 0;
  }
  const parsed = parseLexstatsArgs(argv);
  if (!parsed.ok) {
    io.err(`${PREFIX} ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    io.err(`${PREFIX} refused: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }
  // The service-role client from the two variables alone, so the command runs without the app's other keys (models, embeddings).
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY.trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as LexstatsDb;
  let scoringMode: LexstatsDeps['scoringMode'] = 'ts_rank_cd';
  let dfMode: NonNullable<LexstatsDeps['dfMode']> = 'raw';
  try {
    const { loadRagConfig } = await import('../config');
    const { getRagDeps } = await import('../deps');
    const scoring = loadRagConfig(getRagDeps().ragEnv()).v2.lexicalScoring;
    scoringMode = scoring.mode;
    dfMode = scoring.dfMode === 'cluster' ? 'cluster' : 'raw';
  } catch {
    io.err(`${PREFIX} RAG configuration not loadable; check treats the scoring mode as ts_rank_cd`);
  }
  return runLexstatsCli(argv, io, { db, scoringMode, dfMode });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  main(process.argv.slice(2), consoleIo).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`${PREFIX} failed`, { error: error instanceof Error ? error.name : 'unknown' });
      process.exit(1);
    },
  );
}
