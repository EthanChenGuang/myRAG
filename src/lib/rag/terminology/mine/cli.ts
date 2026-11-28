import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { isTenantKey } from '../../ingest/writer';
import type { TenantScope } from '../../tenant/scope';
import type { MinerDb } from './mine';

export type ParsedMineArgs =
  | { ok: true; tenantKey: string | null; windowDays: number; minSupport: number; dryRun: boolean }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Tests: the service-role client and the scope resolver; production uses the RAG admin client and backfillScope. */
export interface MineCliDeps {
  db?: MinerDb;
  resolveScope?: (tenantKey: string) => Promise<TenantScope | null>;
  signal?: AbortSignal;
}

const TAG = '[RAG Terminology]';
const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 30;
const DEFAULT_MIN_SUPPORT = 3;
const MAX_MIN_SUPPORT = 1000;
const WITH_VALUE = new Set(['--tenant', '--window-days', '--min-support']);

export const USAGE = 'usage: npm run rag:terms:mine -- [--dry-run] [--tenant <key>] [--window-days 14] [--min-support 3]';

function integer(raw: string | undefined, fallback: number, min: number, max: number): number | null {
  if (raw === undefined) return fallback;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** `[--dry-run] [--tenant <key>] [--window-days n] [--min-support n]` (D-26). */
export function parseMineArgs(argv: string[]): ParsedMineArgs {
  let dryRun = false;
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--dry-run') {
      if (dryRun) return { ok: false, error: '--dry-run was given twice' };
      dryRun = true;
    } else if (WITH_VALUE.has(arg)) {
      const value = argv[(i += 1)];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
      if (values.has(arg)) return { ok: false, error: `${arg} was given twice` };
      values.set(arg, value);
    } else {
      return { ok: false, error: `unknown option: ${arg}` };
    }
  }
  const tenantKey = values.get('--tenant') ?? null;
  if (tenantKey !== null && !isTenantKey(tenantKey)) return { ok: false, error: '--tenant needs a tenant key: s:default, u:<uuid> or o:<uuid>' };
  const windowDays = integer(values.get('--window-days'), DEFAULT_WINDOW_DAYS, 1, MAX_WINDOW_DAYS);
  if (windowDays === null) return { ok: false, error: `--window-days needs an integer from 1 to ${MAX_WINDOW_DAYS}` };
  const minSupport = integer(values.get('--min-support'), DEFAULT_MIN_SUPPORT, 1, MAX_MIN_SUPPORT);
  if (minSupport === null) return { ok: false, error: `--min-support needs an integer from 1 to ${MAX_MIN_SUPPORT}` };
  return { ok: true, tenantKey, windowDays, minSupport, dryRun };
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

/**
 * CLI entry (PO-7: run by the operator's scheduler, nightly suggested). Prints counts per tenant only, never a term or a query.
 * Exit 0 when done, 1 on a database failure or a skipped tenant, 2 on bad arguments.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, deps: MineCliDeps = {}): Promise<number> {
  const parsed = parseMineArgs(argv);
  if (!parsed.ok) {
    io.err(`${TAG} ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  if (!deps.db && !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    io.err(`${TAG} refused: set SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }

  const { MineError, mineCandidates, MISS_RETENTION_DAYS } = await import('./mine');
  let report;
  try {
    report = await mineCandidates({
      tenantKey: parsed.tenantKey,
      windowDays: parsed.windowDays,
      minSupport: parsed.minSupport,
      dryRun: parsed.dryRun,
      ...(deps.db ? { db: deps.db } : {}),
      ...(deps.resolveScope ? { resolveScope: deps.resolveScope } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (error) {
    if (error instanceof MineError) {
      io.err(`${TAG} ${error.code}`);
      return 1;
    }
    throw error;
  }

  if (report.dryRun) io.out(`${TAG} dry run, nothing written`);
  else io.out(`${TAG} purged ${report.purged ?? 0} misses older than ${MISS_RETENTION_DAYS} days`);
  for (const tenant of report.tenants) {
    const head = `${TAG} ${tenant.tenantKey}: misses ${tenant.misses}, distinct queries ${tenant.distinctQueries}`;
    if (tenant.error) io.out(`${head}, skipped (${tenant.error})`);
    else if (report.dryRun) io.out(`${head}, would upsert ${tenant.candidates}`);
    else io.out(`${head}, upserted ${tenant.upserted}`);
  }
  io.out(`${TAG} total: ${report.tenants.length} tenants, ${report.tenants.reduce((sum, tenant) => sum + tenant.candidates, 0)} candidates`);
  return report.tenants.some((tenant) => tenant.error) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('interrupted')));
  main(process.argv.slice(2), consoleIo, { signal: controller.signal }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`${TAG} mining failed`, { error: error instanceof Error ? error.name : 'unknown' });
      process.exit(1);
    },
  );
}
