import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { OrchestrateDeps } from './orchestrate';
import type { RunnerIo, RunnerName } from './runners';
import type { SourceKind } from './sources';

export type ParsedBackfillArgs =
  | {
      ok: true;
      tenantKey: string;
      source: { kind: SourceKind; ref: string } | null;
      root: string | null;
      budgetUsd: number | null;
      concurrency: number;
      dryRun: boolean;
      resumeBatchId: string | null;
      runner: RunnerName;
      /** --access-groups: group keys of the tenant (D-16); null: no flag, each document's label is left untouched (everyone for a new one). */
      accessGroups: string[] | null;
    }
  | { ok: false; error: string };

export const USAGE = [
  'usage: npm run rag:backfill -- --tenant <key> --source <folder|bucket|manifest>:<ref> [--root <dir>] [--budget <USD>] [--concurrency <n>] [--access-groups <group keys>] [--dry-run] [--runner worker|ray]',
  '       npm run rag:backfill -- --tenant <key> --resume <batch_id> [--source <kind>:<ref>] [--root <dir>] [--runner worker|ray]',
  '  --access-groups <key,key> makes every document of the batch visible to those access groups only (default: everyone).',
  '  The sample dry run always runs first. Without --budget, or with --dry-run, the command stops after the report (exit 2).',
  '  Exit codes: 0 done, 1 failed, 2 report only (or an unknown access group), 3 the projection does not fit the budget, 64 usage.',
].join('\n');

export const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 64;
const MAX_BUDGET_USD = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KINDS: readonly SourceKind[] = ['folder', 'bucket', 'manifest'];
const WITH_VALUE = new Set(['--tenant', '--source', '--root', '--budget', '--concurrency', '--resume', '--runner', '--access-groups']);
const MAX_ACCESS_GROUPS = 50;
const GROUP_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * `--tenant <key>` (required) with `--source <kind>:<ref>` for a new batch or `--resume <batch_id>`; `--budget`, `--concurrency` and
 * `--dry-run` belong to a new batch only (a batch keeps the budget and concurrency it was created with). `--root` is the directory every
 * manifest path must resolve under.
 */
export function parseBackfillArgs(argv: string[]): ParsedBackfillArgs {
  const values = new Map<string, string>();
  let dryRun = false;
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

  const tenantKey = values.get('--tenant');
  if (!tenantKey) return { ok: false, error: '--tenant is required' };

  let source: { kind: SourceKind; ref: string } | null = null;
  const rawSource = values.get('--source');
  if (rawSource !== undefined) {
    const colon = rawSource.indexOf(':');
    const kind = colon > 0 ? rawSource.slice(0, colon) : '';
    const ref = colon > 0 ? rawSource.slice(colon + 1) : '';
    if (!SOURCE_KINDS.includes(kind as SourceKind) || ref.trim() === '') return { ok: false, error: '--source needs <folder|bucket|manifest>:<ref>' };
    source = { kind: kind as SourceKind, ref };
  }
  const root = values.get('--root') ?? null;
  if (root !== null && source !== null && source.kind !== 'manifest') return { ok: false, error: '--root applies to manifest sources only' };

  let budgetUsd: number | null = null;
  const rawBudget = values.get('--budget');
  if (rawBudget !== undefined) {
    const parsed = /^\d+(\.\d+)?$/.test(rawBudget) ? Number(rawBudget) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed > MAX_BUDGET_USD) return { ok: false, error: `--budget needs a USD amount from 0 to ${MAX_BUDGET_USD}` };
    budgetUsd = parsed;
  }
  let concurrency = DEFAULT_CONCURRENCY;
  const rawConcurrency = values.get('--concurrency');
  if (rawConcurrency !== undefined) {
    const parsed = /^\d+$/.test(rawConcurrency) ? Number(rawConcurrency) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONCURRENCY) return { ok: false, error: `--concurrency needs an integer from 1 to ${MAX_CONCURRENCY}` };
    concurrency = parsed;
  }
  const runner = values.get('--runner') ?? 'worker';
  if (runner !== 'worker' && runner !== 'ray') return { ok: false, error: '--runner needs worker or ray' };

  let accessGroups: string[] | null = null;
  const rawGroups = values.get('--access-groups');
  if (rawGroups !== undefined) {
    const keys = [...new Set(rawGroups.split(',').map((key) => key.trim().toLowerCase()).filter((key) => key !== ''))];
    if (keys.length === 0 || keys.length > MAX_ACCESS_GROUPS) return { ok: false, error: `--access-groups needs 1 to ${MAX_ACCESS_GROUPS} group keys, separated by commas` };
    const bad = keys.find((key) => !GROUP_KEY.test(key) || key === 'all');
    if (bad !== undefined) return { ok: false, error: `--access-groups: not a group key: ${bad}` };
    accessGroups = keys.sort();
  }

  const resumeBatchId = values.get('--resume') ?? null;
  if (resumeBatchId !== null) {
    if (accessGroups !== null) return { ok: false, error: '--resume continues the batch with the access groups it was started with' };
    if (!UUID.test(resumeBatchId)) return { ok: false, error: '--resume needs a batch id (a UUID)' };
    if (rawBudget !== undefined || rawConcurrency !== undefined) {
      return { ok: false, error: '--resume continues the batch with the budget and concurrency it was created with' };
    }
    if (dryRun) return { ok: false, error: '--resume cannot be combined with --dry-run' };
  } else if (source === null) {
    return { ok: false, error: '--source is required for a new batch' };
  }

  return { ok: true, tenantKey, source, root, budgetUsd, concurrency, dryRun, resumeBatchId: resumeBatchId?.toLowerCase() ?? null, runner, accessGroups };
}

const consoleIo: RunnerIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

/** Test and embedding hooks: everything the orchestrator takes, plus the tenant resolver. */
export type BackfillCliOverrides = Partial<Omit<OrchestrateDeps, 'signal' | 'io'>> & {
  resolveScope?: (tenantKey: string) => Promise<import('@/lib/rag/tenant/backfill-scope').BackfillScopeResult>;
};

/**
 * --access-groups: the g:<id> keys of the named groups of the batch tenant. An unknown or unreadable key ends the command with exit 2 and a
 * message naming the key, before any batch is created.
 */
async function resolveAccessGroups(
  scope: import('@/lib/rag/tenant/scope').TenantScope,
  groupKeys: readonly string[],
  rpc: OrchestrateDeps['rpc'],
  io: RunnerIo,
  signal: AbortSignal,
): Promise<string[] | null> {
  const { accessKeysForGroupKeys } = await import('@/lib/rag/access/upload');
  const { getIngestDeps } = await import('../deps');
  try {
    const result = await accessKeysForGroupKeys(scope, groupKeys, { db: () => rpc ?? getIngestDeps().db(), signal });
    if (result.ok) return result.keys;
    io.err(`[Backfill] --access-groups: ${result.reason === 'unknown_group' ? 'no access group of this tenant has the key' : 'not a group key'}: ${result.key}`);
    return null;
  } catch (error) {
    if (signal.aborted) throw error;
    io.err('[Backfill] --access-groups: the access groups could not be read');
    return null;
  }
}

/**
 * The CLI body: 0 done, 1 failed, 2 stopped after the report, 3 the projection does not fit the budget, 64 usage (unknown flags, a
 * missing or refused tenant, a refused source). Prints counts, dollars, batch ids and source keys; never file contents or keys. The
 * environment must already be loaded.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  io: RunnerIo = consoleIo,
  signal: AbortSignal = new AbortController().signal,
  overrides: BackfillCliOverrides = {},
): Promise<number> {
  const parsed = parseBackfillArgs(argv);
  if (!parsed.ok) {
    io.err(`[Backfill] ${parsed.error}`);
    io.err(USAGE);
    return 64;
  }
  const { backfillScope } = await import('@/lib/rag/tenant/backfill-scope');
  const orchestrate = await import('./orchestrate');
  const { SourceRejection } = await import('./sources');

  const scope = await (overrides.resolveScope ?? ((key: string) => backfillScope(key, { signal })))(parsed.tenantKey);
  if (!scope.ok) {
    if (scope.reason === 'unavailable') {
      io.err('[Backfill] the tenant could not be checked: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
      return 1;
    }
    io.err(`[Backfill] tenant refused: ${scope.reason}`);
    io.err(USAGE);
    return 64;
  }

  const deps: Partial<Omit<OrchestrateDeps, 'signal' | 'io'>> = { ...overrides };
  delete (deps as BackfillCliOverrides).resolveScope;
  let accessKeys: string[] | undefined;
  if (parsed.accessGroups !== null) {
    const keys = await resolveAccessGroups(scope.scope, parsed.accessGroups, overrides.rpc, io, signal);
    if (keys === null) return 2;
    accessKeys = keys;
  }
  try {
    const outcome = await orchestrate.runBackfill(
      {
        scope: scope.scope,
        source: parsed.source,
        root: parsed.root,
        budgetUsd: parsed.budgetUsd,
        concurrency: parsed.concurrency,
        dryRun: parsed.dryRun,
        resumeBatchId: parsed.resumeBatchId,
        runner: parsed.runner,
        ...(accessKeys ? { accessKeys } : {}),
      },
      { ...deps, signal, io },
    );
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof orchestrate.BackfillUsageError) {
      io.err(`[Backfill] ${error.message}`);
      io.err(USAGE);
      return 64;
    }
    if (error instanceof SourceRejection) {
      io.err(`[Backfill] source refused: ${error.reason}`);
      io.err(USAGE);
      return 64;
    }
    if (signal.aborted) {
      io.err('[Backfill] interrupted; continue with --resume <batch_id>');
      return 1;
    }
    io.err(`[Backfill] failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('interrupted')));
  process.once('SIGTERM', () => controller.abort(new Error('interrupted')));
  main(process.argv.slice(2), consoleIo, controller.signal).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error('[Backfill] failed', error instanceof Error ? { error: error.name, message: error.message.slice(0, 200) } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
