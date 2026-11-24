import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { isTenantKey } from '../writer';
import type { RunRechunkInput } from './run';

export type ParsedRechunkArgs =
  | { ok: true; mode: 'run'; profileId: string; docType: string | null; tenantKey: string | null; batchSize: number; dryRun: boolean }
  | { ok: true; mode: 'resume'; runId: string; profileId: string | null; docType: string | null; tenantKey: string | null; batchSize: number }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const DEFAULT_RECHUNK_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 1000;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOC_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
/** Refusals that come from the environment (storage, the embedding registry), not from the request. */
const OPERATIONAL_REFUSALS = new Set(['object_store_unavailable', 'embedding_profile_unavailable']);

export const USAGE = [
  'usage: npm run rag:rechunk -- --profile <id> [--dry-run] [--tenant <key>] [--batch-size 20] [--doc-type <type>]',
  '       npm run rag:rechunk -- --resume <runId> [--batch-size 20] [--profile <id>] [--tenant <key>]',
  'exit codes: 0 done, 1 failed or refused by the database, 2 wrong arguments or request, 3 finished but documents still lack children',
].join('\n');

const WITH_VALUE = new Set(['--profile', '--batch-size', '--tenant', '--resume', '--doc-type']);

/**
 * `--profile <id> [--dry-run] [--tenant <key>] [--batch-size n] [--doc-type <type>]` or `--resume <runId>`. A tenant key is `s:default`,
 * `u:<uuid>` or `o:<uuid>`; a run id is a UUID. A resume takes the profile and tenant it was started with and refuses --dry-run.
 */
export function parseRechunkArgs(argv: string[]): ParsedRechunkArgs {
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

  let batchSize = DEFAULT_RECHUNK_BATCH_SIZE;
  const rawBatch = values.get('--batch-size');
  if (rawBatch !== undefined) {
    const parsed = /^\d+$/.test(rawBatch) ? Number(rawBatch) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) return { ok: false, error: `--batch-size needs an integer from 1 to ${MAX_BATCH_SIZE}` };
    batchSize = parsed;
  }
  const tenantKey = values.get('--tenant') ?? null;
  if (tenantKey !== null && !isTenantKey(tenantKey)) return { ok: false, error: '--tenant needs a tenant key: s:default, u:<uuid> or o:<uuid>' };
  const docType = values.get('--doc-type') ?? null;
  if (values.has('--doc-type') && !DOC_TYPE.test(docType ?? '')) return { ok: false, error: '--doc-type needs a document type name' };
  const profileId = values.get('--profile') ?? null;
  const resume = values.get('--resume') ?? null;
  if (resume !== null) {
    if (!RUN_ID.test(resume)) return { ok: false, error: '--resume needs a run id (a UUID)' };
    if (dryRun) return { ok: false, error: '--resume cannot be combined with --dry-run' };
    return { ok: true, mode: 'resume', runId: resume, profileId, docType, tenantKey, batchSize };
  }
  if (profileId === null) return { ok: false, error: '--profile is required' };
  return { ok: true, mode: 'run', profileId, docType, tenantKey, batchSize, dryRun };
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

function usd(value: number): string {
  return value >= 1 ? value.toFixed(2) : value.toFixed(6);
}

/**
 * The CLI body. Prints counts, dollars, run ids, document ids and reason words only: never stored text, never a key. Returns the exit code:
 * 0 done, 1 the run failed or the database refused, 2 the arguments or the request were wrong, 3 the run finished but documents still lack
 * children (the gap list names them). The environment must already be loaded. `options.scopeFor` replaces the tenant scope resolver, for tests.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, signal?: AbortSignal, options: Pick<RunRechunkInput, 'scopeFor'> = {}): Promise<number> {
  const parsed = parseRechunkArgs(argv);
  if (!parsed.ok) {
    io.err(`[RAG Rechunk] ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    io.err('[RAG Rechunk] SUPABASE_SERVICE_ROLE_KEY is not set: the job writes through service-role functions and will not run without it');
    return 1;
  }
  const { getIngestDeps } = await import('../deps');
  const run = await import('./run');
  const db = getIngestDeps().db();
  if (!db) {
    io.err('[RAG Rechunk] admin client unavailable: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    return 1;
  }

  try {
    if (parsed.mode === 'run' && parsed.dryRun) {
      const report = await run.dryRunRechunk({
        db,
        profileId: parsed.profileId,
        docType: parsed.docType,
        tenantKey: parsed.tenantKey,
        batchSize: parsed.batchSize,
        ...(signal ? { signal } : {}),
      });
      io.out('[RAG Rechunk] dry run, nothing written');
      io.out(
        `[RAG Rechunk] profile ${report.profileId} (${report.docType}, ${report.profileStatus}, child ${report.childTokens} tokens, parents ${report.parentMode})`,
      );
      io.out(`[RAG Rechunk] embedding profiles: ${report.embeddingProfiles.join(', ') || 'none'}`);
      const costOf = new Map(report.cost.tenants.map((tenant) => [tenant.tenantKey, tenant.usd]));
      let documents = 0;
      for (const tenant of report.tenants) {
        documents += tenant.eligibleDocuments;
        io.out(
          `[RAG Rechunk] ${tenant.tenantKey}: documents ${tenant.eligibleDocuments}, parents ${tenant.parents}, children ${tenant.children}, tokens ${tenant.tokens}, estimated cost ${usd(costOf.get(tenant.tenantKey) ?? 0)} USD, without parse output ${tenant.gapDocuments}`,
        );
      }
      const { chunks, tokens, usd: total } = report.cost.totals;
      io.out(`[RAG Rechunk] total: documents ${documents}, children ${chunks}, tokens ${tokens}, estimated cost ${usd(total)} USD`);
      if (report.cost.note) io.out(`[RAG Rechunk] note: ${report.cost.note}`);
      if (report.gaps.length > 0) {
        io.out(`[RAG Rechunk] ${report.gaps.length} documents cannot be built from stored parse output and need a budgeted re-ingest:`);
        for (const gap of report.gaps) io.out(`[RAG Rechunk]   ${gap.tenantKey} ${gap.documentId} ${gap.reason}${gap.detail && gap.detail !== gap.reason ? ` (${gap.detail})` : ''}`);
      }
      return 0;
    }

    const report = await run.runRechunk({
      db,
      profileId: parsed.profileId,
      docType: parsed.docType,
      tenantKey: parsed.tenantKey,
      resumeRunId: parsed.mode === 'resume' ? parsed.runId : null,
      batchSize: parsed.batchSize,
      onProgress: (line) => io.out(`[RAG Rechunk] ${line}`),
      ...(options.scopeFor ? { scopeFor: options.scopeFor } : {}),
      ...(signal ? { signal } : {}),
    });
    for (const warning of report.warnings.filter((entry) => entry.startsWith('embedding_gap:'))) {
      io.out(`[RAG Rechunk] warning: ${warning.slice('embedding_gap:'.length)} could not be embedded for some documents; run the re-embed job for it`);
    }
    io.out(
      `[RAG Rechunk] ${report.status}: run ${report.runId} built ${report.documentsWritten} documents (${report.parentsWritten} parents, ${report.childrenWritten} children), ${report.documentsGapped} gaps`,
    );
    for (const [tenant, entry] of Object.entries(report.tenants).sort(([a], [b]) => (a < b ? -1 : 1))) {
      io.out(`[RAG Rechunk] ${tenant}: documents ${entry.documents}, children ${entry.children}, estimated tokens ${entry.tokens}`);
    }
    io.out(`[RAG Rechunk] profile ${report.profileId} is ${report.profileStatus}`);
    if (report.gaps.length > 0) {
      io.out(`[RAG Rechunk] ${report.gaps.length} documents have no children in the profile:`);
      for (const gap of report.gaps) io.out(`[RAG Rechunk]   ${gap.tenantKey} ${gap.documentId} ${gap.reason}${gap.detail && gap.detail !== gap.reason ? ` (${gap.detail})` : ''}`);
    }
    if (report.status === 'failed') {
      io.err(`[RAG Rechunk] failed: ${report.reason ?? 'unknown'}`);
      io.err(`[RAG Rechunk] resume with: npm run rag:rechunk -- --resume ${report.runId}`);
      return 1;
    }
    if (report.status === 'incomplete') {
      io.err('[RAG Rechunk] incomplete: documents without stored parse output stay out of the profile; re-ingest them (see the dry run), then run again');
      return 3;
    }
    return 0;
  } catch (error) {
    if (error instanceof run.RechunkInputError) {
      io.err(`[RAG Rechunk] ${error.code}`);
      return OPERATIONAL_REFUSALS.has(error.code) ? 1 : 2;
    }
    if (error instanceof run.RechunkDatabaseError) {
      io.err(`[RAG Rechunk] database error: ${error.rpc}${error.code ? ` (${error.code})` : ''}`);
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
      console.error('[RAG Rechunk] failed', error instanceof Error ? { error: error.name } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
