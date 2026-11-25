import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { isTenantKey } from '../writer';

export type ParsedReembedArgs =
  | { ok: true; mode: 'run'; profileId: string; tenantKey: string | null; batchSize: number; deriveFrom: string | null; dryRun: boolean }
  | { ok: true; mode: 'resume'; runId: string; profileId: string | null; tenantKey: string | null; batchSize: number }
  | { ok: true; mode: 'rollback'; runId: string }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const DEFAULT_REEMBED_BATCH_SIZE = 128;
const MAX_BATCH_SIZE = 1000;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const USAGE = [
  'usage: npm run rag:reembed -- --profile <id> [--dry-run] [--batch-size 128] [--tenant <key>] [--derive-from <profileId>]',
  '       npm run rag:reembed -- --resume <runId> [--batch-size 128] [--profile <id>] [--tenant <key>]',
  '       npm run rag:reembed -- --rollback <runId>',
].join('\n');

const WITH_VALUE = new Set(['--profile', '--batch-size', '--tenant', '--resume', '--rollback', '--derive-from']);

/**
 * `--profile <id> [--dry-run] [--batch-size n] [--tenant <key>] [--derive-from <id>]`, or `--resume <runId>`, or `--rollback <runId>`.
 * A tenant key is `s:default`, `u:<uuid>` or `o:<uuid>`; a run id is a UUID. A rollback takes nothing else; a resume takes the profile and
 * tenant it was started with (and refuses the dry run and derive options, which only apply to a new run).
 */
export function parseReembedArgs(argv: string[]): ParsedReembedArgs {
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

  let batchSize = DEFAULT_REEMBED_BATCH_SIZE;
  const rawBatch = values.get('--batch-size');
  if (rawBatch !== undefined) {
    const parsed = /^\d+$/.test(rawBatch) ? Number(rawBatch) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) return { ok: false, error: `--batch-size needs an integer from 1 to ${MAX_BATCH_SIZE}` };
    batchSize = parsed;
  }
  const tenantKey = values.get('--tenant') ?? null;
  if (tenantKey !== null && !isTenantKey(tenantKey)) return { ok: false, error: '--tenant needs a tenant key: s:default, u:<uuid> or o:<uuid>' };
  const profileId = values.get('--profile') ?? null;
  const deriveFrom = values.get('--derive-from') ?? null;
  const resume = values.get('--resume') ?? null;
  const rollback = values.get('--rollback') ?? null;
  for (const [flag, id] of [['--resume', resume], ['--rollback', rollback]] as const) {
    if (id !== null && !RUN_ID.test(id)) return { ok: false, error: `${flag} needs a run id (a UUID)` };
  }

  if (rollback !== null) {
    if (resume !== null || profileId !== null || tenantKey !== null || deriveFrom !== null || dryRun || rawBatch !== undefined) {
      return { ok: false, error: '--rollback takes only a run id' };
    }
    return { ok: true, mode: 'rollback', runId: rollback };
  }
  if (resume !== null) {
    if (dryRun) return { ok: false, error: '--resume cannot be combined with --dry-run' };
    if (deriveFrom !== null) return { ok: false, error: '--resume continues the run as it was started; --derive-from belongs to a new run' };
    return { ok: true, mode: 'resume', runId: resume, profileId, tenantKey, batchSize };
  }
  if (profileId === null) return { ok: false, error: '--profile is required' };
  if (deriveFrom !== null && deriveFrom === profileId) return { ok: false, error: '--derive-from must name another profile' };
  return { ok: true, mode: 'run', profileId, tenantKey, batchSize, deriveFrom, dryRun };
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

const SWITCH_OFF_WARNING =
  'RAG_EMBEDDING_PROFILES is off: new documents are not written to this profile, so a document ingested after the run needs another run, and activation stays refused until the profile is complete.';

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/**
 * The CLI body. Prints counts, dollars, run ids and reason words only: never stored text, never a key. Returns the exit code: 0 done, 1 the
 * run failed or the database refused, 2 the arguments or the request were wrong. The environment must already be loaded.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, signal?: AbortSignal): Promise<number> {
  const parsed = parseReembedArgs(argv);
  if (!parsed.ok) {
    io.err(`[Re-embed] ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  const { getIngestDeps } = await import('../deps');
  const run = await import('./run');
  const { ReembedWriterError } = await import('../writer');
  const { formatUsd } = await import('./cost');
  const db = getIngestDeps().db();
  if (!db) {
    io.err('[Re-embed] admin client unavailable: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    return 1;
  }

  try {
    if (parsed.mode === 'rollback') {
      const result = await run.rollbackReembedRun({ db, runId: parsed.runId, ...(signal ? { signal } : {}) });
      io.out(`[Re-embed] rolled back run ${parsed.runId}: deleted ${result.rowsDeleted} rows, the profile is ${result.profileStatus}`);
      return 0;
    }

    if (parsed.mode === 'run' && parsed.dryRun) {
      const report = await run.dryRunReembed({
        db,
        profileId: parsed.profileId,
        tenantKey: parsed.tenantKey,
        deriveFrom: parsed.deriveFrom,
        batchSize: parsed.batchSize,
        ...(signal ? { signal } : {}),
      });
      io.out('[Re-embed] dry run, nothing written');
      io.out(`[Re-embed] profile ${report.profileId} (${report.provider}, ${report.dims} dims${report.derived ? `, derived from ${parsed.deriveFrom}` : ''})`);
      if (report.scope) io.out(`[Re-embed] scope: ${report.scope.join(', ')}`);
      for (const tenant of report.cost.tenants) {
        io.out(`[Re-embed] ${tenant.tenantKey}: chunks ${tenant.chunks}, tokens ${tenant.tokens}, estimated cost ${formatUsd(tenant.usd)} USD`);
      }
      const { chunks, tokens, usd } = report.cost.totals;
      io.out(`[Re-embed] total: chunks ${chunks}, tokens ${tokens}, estimated cost ${formatUsd(usd)} USD`);
      if (report.cost.note) io.out(`[Re-embed] note: ${report.cost.note}`);
      return 0;
    }

    const report = await run.runReembed({
      db,
      profileId: parsed.profileId,
      tenantKey: parsed.tenantKey,
      deriveFrom: parsed.mode === 'run' ? parsed.deriveFrom : null,
      resumeRunId: parsed.mode === 'resume' ? parsed.runId : null,
      batchSize: parsed.batchSize,
      onProgress: (line) => io.out(`[Re-embed] ${line}`),
      ...(signal ? { signal } : {}),
    });
    if (report.warnings.includes('profiles_switch_off')) io.out(`[Re-embed] warning: ${SWITCH_OFF_WARNING}`);
    if (report.warnings.includes('dual_write_not_active') || report.warnings.includes('dual_write_unverified')) {
      io.out('[Re-embed] warning: could not confirm that ingestion dual-writes this profile; documents added during the run may need another run.');
    }
    if (report.warnings.includes('unknown_doc_type')) io.out('[Re-embed] warning: some chunks have a document type with no profile; they were embedded without a header');
    if (report.derived) io.out('[Re-embed] note: derived vectors assume the model truncates by Matryoshka prefix; the evaluation decides whether the derived profile holds.');

    io.out(
      `[Re-embed] ${report.status}: run ${report.runId} wrote ${report.chunksEmbedded} chunks in ${report.batches} batches${report.derived ? ' (derived, no provider call)' : `, ${report.tokens} tokens reported by the provider`}`,
    );
    for (const [tenant, entry] of Object.entries(report.tenants).sort(([a], [b]) => (a < b ? -1 : 1))) {
      io.out(`[Re-embed] ${tenant}: chunks ${entry.chunks}, estimated tokens ${entry.tokens}`);
    }
    if (report.hosts.length > 0) {
      io.out(`[Re-embed] serving hosts: ${report.hosts.map((host) => `${host.host} ${host.chunks} rows (${percent(host.share)})`).join(', ')}`);
      if (report.provider === 'qwen3') {
        const fallback = report.hosts.filter((host) => host.host === 'openrouter').reduce((sum, host) => sum + host.share, 0);
        io.out(`[Re-embed] fallback share: ${percent(fallback)} of the rows came from the OpenRouter fallback host`);
      }
    }
    if (report.status === 'failed') {
      io.err(`[Re-embed] failed: ${report.reason ?? 'unknown'}${report.chunksMissing > 0 ? `, ${report.chunksMissing} chunks still lack a vector` : ''}`);
      io.err(`[Re-embed] resume with: npm run rag:reembed -- --resume ${report.runId}`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof run.ReembedInputError) {
      io.err(`[Re-embed] ${error.code}`);
      return 2;
    }
    if (error instanceof ReembedWriterError) {
      io.err(`[Re-embed] refused: ${error.reason ?? 'database error'}${error.detail ? `: ${error.detail}` : ''}${error.code ? ` (${error.code})` : ''}`);
      return 1;
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
      console.error('[Re-embed] failed', error instanceof Error ? { error: error.name, message: error.message.slice(0, 200) } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
