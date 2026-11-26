import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

export type FinetuneCommand = 'export-vectors' | 'embed-queries';

export type ParsedFinetuneArgs =
  | { ok: true; command: FinetuneCommand; bundleDir: string; profileId: string | null; batchSize: number | null }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const COMMANDS = new Set<FinetuneCommand>(['export-vectors', 'embed-queries']);
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_BATCH_SIZE = 1000;
const TAG = '[Fine-tune]';

export const USAGE = [
  'usage: npm run rag:finetune -- export-vectors --bundle <dir> [--profile <id>] [--batch-size 500]',
  '       npm run rag:finetune -- embed-queries --bundle <dir> [--profile <id>] [--batch-size 64]',
  'The default profile is the active profile (the production model). Needs RAG_FINETUNE=on.',
].join('\n');

/** `<command> --bundle <dir> [--profile <id>] [--batch-size n]`. */
export function parseFinetuneArgs(argv: string[]): ParsedFinetuneArgs {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.has(command as FinetuneCommand)) return { ok: false, error: `unknown command ${command ?? '(none)'}` };
  let bundleDir: string | null = null;
  let profileId: string | null = null;
  let batchSize: number | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag !== '--bundle' && flag !== '--profile' && flag !== '--batch-size') return { ok: false, error: `unknown option ${flag}` };
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `${flag} needs a value` };
    index += 1;
    if (flag === '--bundle') bundleDir = value;
    else if (flag === '--profile') {
      if (!PROFILE_ID.test(value)) return { ok: false, error: 'invalid profile id' };
      profileId = value;
    } else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) return { ok: false, error: `--batch-size must be 1 to ${MAX_BATCH_SIZE}` };
      batchSize = n;
    }
  }
  if (!bundleDir) return { ok: false, error: '--bundle is required' };
  return { ok: true, command: command as FinetuneCommand, bundleDir: path.resolve(bundleDir), profileId, batchSize };
}

/** Only an exact lower-case `on` enables the pipeline (the env.ts parser of 06.1-04); read at call time, after .env.local is loaded. */
export function isFinetuneEnabled(source: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return source.RAG_FINETUNE === 'on';
}

const consoleIo: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export async function main(
  argv: string[] = process.argv.slice(2),
  io: CliIo = consoleIo,
  signal?: AbortSignal,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const parsed = parseFinetuneArgs(argv);
  if (!parsed.ok) {
    io.err(`${TAG} ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  if (!isFinetuneEnabled(env)) {
    io.err(`${TAG} RAG_FINETUNE is off: set RAG_FINETUNE=on to export fine-tune vectors`);
    return 1;
  }

  const { getIngestDeps } = await import('../ingest/deps');
  const { BundleError } = await import('./bundle-io');
  const { FinetuneRefusal, exportVectors } = await import('./export-vectors');
  const { embedBundleQueries } = await import('./embed-queries');
  const { getActiveProfile, listEmbeddingProfiles, ProfileUnavailableError } = await import('../embeddings/active-profile');
  const { EmbeddingProfileMismatchError } = await import('../backend/supabase-rpc');

  const db = getIngestDeps().db();
  if (!db) {
    io.err(`${TAG} admin client unavailable: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }

  try {
    let profile;
    if (parsed.profileId) {
      profile = (await listEmbeddingProfiles()).find((entry) => entry.id === parsed.profileId);
      if (!profile) {
        io.err(`${TAG} refused: unknown_profile`);
        return 1;
      }
    } else {
      profile = await getActiveProfile();
    }

    if (parsed.command === 'export-vectors') {
      const report = await exportVectors({ db, bundleDir: parsed.bundleDir, profile, ...(parsed.batchSize ? { pageSize: parsed.batchSize } : {}), ...(signal ? { signal } : {}) });
      for (const tenant of report.tenants) io.out(`${TAG} ${tenant.tenantKey}: ${tenant.rows} chunk vectors (${report.profileId})`);
      io.out(`${TAG} export-vectors: ${report.tenants.reduce((sum, tenant) => sum + tenant.rows, 0)} rows for ${report.tenants.length} tenants`);
      return 0;
    }

    const report = await embedBundleQueries({ db, bundleDir: parsed.bundleDir, profile, ...(parsed.batchSize ? { batchSize: parsed.batchSize } : {}), ...(signal ? { signal } : {}) });
    for (const tenant of report.tenants) io.out(`${TAG} ${tenant.tenantKey}: ${tenant.rows} query vectors (${report.profileId})`);
    io.out(`${TAG} embed-queries: ${report.tenants.reduce((sum, tenant) => sum + tenant.rows, 0)} rows in ${report.batches} batches`);
    return 0;
  } catch (error) {
    if (error instanceof FinetuneRefusal) {
      io.err(`${TAG} refused: ${error.code}${error.detail ? ` (${error.detail})` : ''}`);
      return 1;
    }
    if (error instanceof BundleError) {
      io.err(`${TAG} bundle refused: ${error.code}${error.detail ? ` (${error.detail})` : ''}`);
      return 1;
    }
    if (error instanceof EmbeddingProfileMismatchError) {
      io.err(`${TAG} refused: profile_mismatch (${error.kind}); nothing was written`);
      return 1;
    }
    if (error instanceof ProfileUnavailableError) {
      io.err(`${TAG} refused: profile registry unavailable (${error.reason})`);
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
      console.error(`${TAG} failed`, error instanceof Error ? { error: error.name } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
