import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { isTenantKey } from '../writer';

export type ParsedRelexArgs =
  | { ok: true; dryRun: boolean; tenantKey: string | null; batchSize: number; resumeAfter: string | null }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const DEFAULT_RELEX_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1000;
const CHUNK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const USAGE = 'usage: npm run rag:relex -- [--dry-run] [--batch-size 500] [--tenant <key>] [--resume-after <chunkId>]';

const WITH_VALUE = new Set(['--batch-size', '--tenant', '--resume-after']);

/** `[--dry-run] [--batch-size n] [--tenant <key>] [--resume-after <chunkId>]`. */
export function parseRelexArgs(argv: string[]): ParsedRelexArgs {
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

  let batchSize = DEFAULT_RELEX_BATCH_SIZE;
  const rawBatch = values.get('--batch-size');
  if (rawBatch !== undefined) {
    const parsed = /^\d+$/.test(rawBatch) ? Number(rawBatch) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
      return { ok: false, error: `--batch-size needs an integer from 1 to ${MAX_BATCH_SIZE}` };
    }
    batchSize = parsed;
  }

  const tenantKey = values.get('--tenant') ?? null;
  if (tenantKey !== null && !isTenantKey(tenantKey)) {
    return { ok: false, error: '--tenant needs a tenant key: s:default, u:<uuid> or o:<uuid>' };
  }

  const resumeAfter = values.get('--resume-after') ?? null;
  if (resumeAfter !== null && !CHUNK_ID.test(resumeAfter)) {
    return { ok: false, error: '--resume-after needs a chunk id (a UUID)' };
  }

  return { ok: true, dryRun, tenantKey, batchSize, resumeAfter };
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

/**
 * CLI entry. Prints counts per tenant only. Exit code 0 when done, 1 on database failure, 2 on bad arguments.
 * Requires SUPABASE_SERVICE_ROLE_KEY and a configured admin client.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, signal?: AbortSignal): Promise<number> {
  const parsed = parseRelexArgs(argv);
  if (!parsed.ok) {
    io.err(`[RAG Relex] ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    io.err('[RAG Relex] refused: set SUPABASE_SERVICE_ROLE_KEY');
    return 1;
  }

  const run = await import('./run');
  const { getIngestDeps } = await import('../deps');
  const { currentIngestConfig } = await import('../current-config');
  const tableRowSerialization = currentIngestConfig().tableRowSerialization;
  const db = getIngestDeps().db();
  if (!db) {
    io.err('[RAG Relex] admin client unavailable: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    return 1;
  }

  try {
    if (parsed.dryRun) {
      const report = await run.dryRunRelex({
        db,
        tenantKey: parsed.tenantKey,
        batchSize: parsed.batchSize,
        resumeAfter: parsed.resumeAfter,
        tableRowSerialization,
        ...(signal ? { signal } : {}),
      });
      io.out('[RAG Relex] dry run, nothing written');
      for (const [tenant, count] of Object.entries(report.tenants).sort(([a], [b]) => (a < b ? -1 : 1))) {
        io.out(`[RAG Relex] ${tenant}: would update ${count}`);
      }
      io.out(`[RAG Relex] table chunks (RAG_TABLE_ROW_SERIALIZATION=${tableRowSerialization}): would update ${report.tables ?? 0}`);
      io.out(`[RAG Relex] total: would update ${report.total}`);
      return 0;
    }

    const report = await run.runRelex({
      db,
      tenantKey: parsed.tenantKey,
      batchSize: parsed.batchSize,
      resumeAfter: parsed.resumeAfter,
      onProgress: (line) => io.out(`[RAG Relex] ${line}`),
      tableRowSerialization,
      ...(signal ? { signal } : {}),
    });
    for (const [tenant, count] of Object.entries(report.tenants).sort(([a], [b]) => (a < b ? -1 : 1))) {
      io.out(`[RAG Relex] ${tenant}: updated ${count}`);
    }
    io.out(`[RAG Relex] done: ${report.updated} rows in ${report.batches} batches`);
    return 0;
  } catch (error) {
    if (error instanceof run.RelexInputError) {
      io.err(`[RAG Relex] ${error.code}`);
      return 2;
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
      console.error('[RAG Relex] failed', error instanceof Error ? { error: error.name, message: error.message.slice(0, 200) } : { error: 'unknown' });
      process.exit(1);
    },
  );
}