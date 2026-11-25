import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { RpcClient } from '../../backend/supabase-rpc';
import { isTenantKey } from '../writer';

export type ParsedFingerprintArgs =
  | { ok: true; command: 'backfill'; dryRun: boolean; tenantKey: string | null; pageSize: number }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const DEFAULT_FINGERPRINT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const TAG = '[RAG Fingerprint]';

export const USAGE = 'usage: npm run rag:fingerprint -- backfill [--tenant <key>] [--dry-run] [--page-size 100]';

const WITH_VALUE = new Set(['--tenant', '--page-size']);

/** `backfill [--tenant <key>] [--dry-run] [--page-size n]`. */
export function parseFingerprintArgs(argv: string[]): ParsedFingerprintArgs {
  const [command, ...rest] = argv;
  if (command !== 'backfill') return { ok: false, error: command === undefined ? 'a command is required' : `unknown command: ${command}` };
  let dryRun = false;
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === '--dry-run') {
      if (dryRun) return { ok: false, error: '--dry-run was given twice' };
      dryRun = true;
    } else if (WITH_VALUE.has(arg)) {
      const value = rest[(i += 1)];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
      if (values.has(arg)) return { ok: false, error: `${arg} was given twice` };
      values.set(arg, value);
    } else {
      return { ok: false, error: `unknown option: ${arg}` };
    }
  }

  let pageSize = DEFAULT_FINGERPRINT_PAGE_SIZE;
  const rawPage = values.get('--page-size');
  if (rawPage !== undefined) {
    const parsed = /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) return { ok: false, error: `--page-size needs an integer from 1 to ${MAX_PAGE_SIZE}` };
    pageSize = parsed;
  }

  const tenantKey = values.get('--tenant') ?? null;
  if (tenantKey !== null && !isTenantKey(tenantKey)) return { ok: false, error: '--tenant needs a tenant key: s:default, u:<uuid> or o:<uuid>' };

  return { ok: true, command: 'backfill', dryRun, tenantKey, pageSize };
}

/** The profile new versions are embedded with: the active profile with RAG_EMBEDDING_PROFILES on, the legacy column otherwise. */
async function preferredEmbeddingProfile(): Promise<string> {
  const profiles = await import('../../embeddings/active-profile');
  if (!profiles.isEmbeddingProfilesEnabled()) return profiles.LEGACY_PROFILE.id;
  return (await profiles.getActiveProfile()).id;
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

function sortedTenants(tenants: Record<string, number>): Array<[string, number]> {
  return Object.entries(tenants).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * CLI entry. Prints counts per tenant only. Exit code 0 when done, 1 on database failure, 2 on bad arguments.
 * Makes no parser or embedding call; requires SUPABASE_SERVICE_ROLE_KEY and a configured admin client.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  io: CliIo = consoleIo,
  signal?: AbortSignal,
  deps: { db?: RpcClient | null; embeddingProfileId?: string } = {},
): Promise<number> {
  const parsed = parseFingerprintArgs(argv);
  if (!parsed.ok) {
    io.err(`${TAG} ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }

  let db = deps.db ?? null;
  if (deps.db === undefined) {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      io.err(`${TAG} refused: set SUPABASE_SERVICE_ROLE_KEY`);
      return 1;
    }
    const { getIngestDeps } = await import('../deps');
    db = getIngestDeps().db() as RpcClient | null;
  }
  if (!db) {
    io.err(`${TAG} admin client unavailable: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }

  const backfill = await import('./backfill');
  try {
    const report = await backfill.runFingerprintBackfill({
      db,
      tenantKey: parsed.tenantKey,
      pageSize: parsed.pageSize,
      dryRun: parsed.dryRun,
      embeddingProfileId: deps.embeddingProfileId ?? (await preferredEmbeddingProfile()),
      onProgress: (line) => io.out(`${TAG} ${line}`),
      ...(signal ? { signal } : {}),
    });
    if (report.dryRun) {
      io.out(`${TAG} dry run, nothing written`);
      let total = 0;
      for (const [tenant, count] of sortedTenants(report.tenants)) {
        io.out(`${TAG} ${tenant}: would update ${count}`);
        total += count;
      }
      io.out(`${TAG} total: would update ${total}`);
      return 0;
    }
    for (const [tenant, count] of sortedTenants(report.tenants)) io.out(`${TAG} ${tenant}: updated ${count}`);
    io.out(`${TAG} done: ${report.updated} documents in ${report.pages} pages, ${report.skipped} already stamped by another writer`);
    return 0;
  } catch (error) {
    if (error instanceof backfill.FingerprintBackfillError) {
      io.err(`${TAG} ${error.code}`);
      return error.code.startsWith('invalid_') ? 2 : 1;
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('interrupted')));
  main(process.argv.slice(2), consoleIo, controller.signal).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`${TAG} failed`, error instanceof Error ? { error: error.name, message: error.message.slice(0, 200) } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
