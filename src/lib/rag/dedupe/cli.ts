import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { isTenantKey } from '../ingest/writer';

export type ParsedDupClusterArgs =
  | { ok: true; dryRun: boolean; tenantKey: string; batchSize: number; resumeAfter: string | null }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const DEFAULT_DUP_CLUSTER_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1000;
const CHUNK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The shell convention for a run stopped by SIGINT. */
export const EXIT_INTERRUPTED = 130;

export const USAGE = 'usage: npm run rag:dup-clusters -- --tenant <key> [--dry-run] [--batch-size 500] [--resume-after <chunkId>]';

const PREFIX = '[RAG Dedupe]';
const WITH_VALUE = new Set(['--batch-size', '--tenant', '--resume-after']);

/** `--tenant <key> [--dry-run] [--batch-size n] [--resume-after <chunkId>]`. */
export function parseDupClusterArgs(argv: string[]): ParsedDupClusterArgs {
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

  const tenantKey = values.get('--tenant');
  if (tenantKey === undefined) return { ok: false, error: '--tenant is required' };
  if (!isTenantKey(tenantKey)) return { ok: false, error: '--tenant needs a tenant key: s:default, u:<uuid> or o:<uuid>' };

  let batchSize = DEFAULT_DUP_CLUSTER_BATCH_SIZE;
  const rawBatch = values.get('--batch-size');
  if (rawBatch !== undefined) {
    const parsed = /^\d+$/.test(rawBatch) ? Number(rawBatch) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
      return { ok: false, error: `--batch-size needs an integer from 1 to ${MAX_BATCH_SIZE}` };
    }
    batchSize = parsed;
  }

  const resumeAfter = values.get('--resume-after') ?? null;
  if (resumeAfter !== null && !CHUNK_ID.test(resumeAfter)) return { ok: false, error: '--resume-after needs a chunk id (a UUID)' };

  return { ok: true, dryRun, tenantKey, batchSize, resumeAfter };
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

/**
 * CLI entry. Prints counts only. Exit code 0 when done, 1 on database failure, 2 on bad arguments, 130 when interrupted (the last
 * finished batch is printed as a --resume-after cursor). Requires SUPABASE_SERVICE_ROLE_KEY and a configured admin client.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, signal?: AbortSignal): Promise<number> {
  const parsed = parseDupClusterArgs(argv);
  if (!parsed.ok) {
    io.err(`${PREFIX} ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    io.err(`${PREFIX} refused: set SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }

  const backfill = await import('./backfill');
  const { DupClusterError, dupClustersEnabled } = await import('./cluster');
  const { getIngestDeps } = await import('../ingest/deps');
  const db = getIngestDeps().db();
  if (!db) {
    io.err(`${PREFIX} admin client unavailable: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }
  const input = { db, tenantKey: parsed.tenantKey, batchSize: parsed.batchSize, resumeAfter: parsed.resumeAfter, ...(signal ? { signal } : {}) };
  let lastCursor: string | null = parsed.resumeAfter;

  try {
    if (parsed.dryRun) {
      const report = await backfill.dryRunDupBackfill(input);
      io.out(`${PREFIX} dry run, nothing written`);
      io.out(`${PREFIX} ${report.tenantKey}: would hash ${report.toHash} chunks`);
      return 0;
    }

    io.out(`${PREFIX} started: tenant ${parsed.tenantKey}, batch size ${parsed.batchSize}${parsed.resumeAfter ? `, resume after ${parsed.resumeAfter}` : ''}`);
    io.out(`${PREFIX} RAG_DUP_CLUSTERS=${(await dupClustersEnabled()) ? 'true' : 'false'}: the backfill runs either way; ingestion clusters only while it is true`);
    io.out(
      `${PREFIX} note: each batch writes simhash and dup_cluster_id on its chunk rows, so the chunk statement triggers fire once per batch; documents are not written, so the semantic cache is not flushed`,
    );
    const report = await backfill.runDupBackfill({
      ...input,
      onBatch: (info) => {
        lastCursor = info.cursor;
        io.out(`${PREFIX} batch ${info.batch}: hashed ${info.hashed}, clustered ${info.clustered}, cursor ${info.cursor}`);
      },
    });
    io.out(`${PREFIX} ${report.tenantKey}: hashed ${report.hashed}, clustered ${report.clustered} in ${report.batches} batches`);
    io.out(`${PREFIX} recompute: ${report.recomputed} clusters refreshed, ${report.dissolved} dissolved`);
    return 0;
  } catch (error) {
    if (signal?.aborted) {
      io.err(`${PREFIX} interrupted between batches${lastCursor ? `; continue with --resume-after ${lastCursor}` : '; nothing finished, run it again'}`);
      return EXIT_INTERRUPTED;
    }
    if (error instanceof DupClusterError) {
      io.err(`${PREFIX} ${error.code}${error.rpcCode ? ` (${error.rpcCode})` : ''}`);
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
      console.error(`${PREFIX} failed`, error instanceof Error ? { error: error.name, message: error.message.slice(0, 200) } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
