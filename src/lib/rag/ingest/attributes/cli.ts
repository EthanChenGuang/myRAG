import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { BackfillScopeResult } from '@/lib/rag/tenant/backfill-scope';
import type { RunnerIo } from '../backfill/runners';
import type { AttributesImportDeps } from './import';

export type ParsedAttributesArgs =
  | { ok: true; tenantKey: string; file: string; apply: boolean }
  | { ok: true; tenantKey: string; reindexIdentifiers: true; apply: boolean }
  | { ok: false; error: string };

export const USAGE = [
  'usage: npm run rag:attributes -- --tenant <key> --import <file> [--dry-run | --apply]',
  '       npm run rag:attributes -- --tenant <key> --reindex-identifiers [--dry-run | --apply]',
  '  The file is JSON Lines: one { "source_key", "attributes", "source"? } object per line, at most 50,000 rows.',
  '  --reindex-identifiers re-indexes the identifiers of every document of the tenant that carries attributes (after a flag change).',
  '  The dry-run report always runs first. Without --apply, or with --dry-run, the command stops after the report (exit 2).',
  '  Exit codes: 0 done, 1 failed, 2 report only, 3 file refused, 64 usage.',
].join('\n');

const LOG = '[RAG Attributes]';
const WITH_VALUE = new Set(['--tenant', '--import']);
const FLAGS = new Set(['--dry-run', '--apply', '--reindex-identifiers']);

export const SWITCH_OFF_LINE = `${LOG} RAG_DOC_ATTRIBUTES is off: it needs RAG_DOC_ATTRIBUTES=true and RAG_INGEST_PIPELINE=unified; nothing was read or written`;

/**
 * `--tenant <key>` and exactly one of `--import <file>` and `--reindex-identifiers` are required; `--dry-run` and `--apply` take no value
 * and exclude each other.
 */
export function parseAttributesArgs(argv: string[]): ParsedAttributesArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (FLAGS.has(arg)) {
      if (flags.has(arg)) return { ok: false, error: `${arg} was given twice` };
      flags.add(arg);
    } else if (WITH_VALUE.has(arg)) {
      const value = argv[(i += 1)];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
      if (values.has(arg)) return { ok: false, error: `${arg} was given twice` };
      values.set(arg, value);
    } else {
      return { ok: false, error: `unknown option: ${arg}` };
    }
  }
  if (flags.has('--dry-run') && flags.has('--apply')) return { ok: false, error: '--dry-run and --apply exclude each other' };
  const tenantKey = values.get('--tenant');
  if (!tenantKey) return { ok: false, error: '--tenant is required' };
  const file = values.get('--import');
  const reindex = flags.has('--reindex-identifiers');
  if (file && reindex) return { ok: false, error: '--import and --reindex-identifiers exclude each other' };
  if (reindex) return { ok: true, tenantKey, reindexIdentifiers: true, apply: flags.has('--apply') };
  if (!file) return { ok: false, error: '--import or --reindex-identifiers is required' };
  return { ok: true, tenantKey, file, apply: flags.has('--apply') };
}

const consoleIo: RunnerIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

/** Test and embedding hooks: the run's dependencies plus the tenant resolver and the switch. */
export type AttributesCliOverrides = Partial<Omit<AttributesImportDeps, 'signal' | 'io'>> & {
  rpc?: RpcClient | null;
  resolveScope?: (tenantKey: string) => Promise<BackfillScopeResult>;
  enabled?: () => boolean;
};

/**
 * The CLI body: 0 done, 1 failed, 2 stopped after the report, 3 file refused, 64 usage (flags, the switch off, a refused tenant, an
 * unreadable file). The switch is checked before anything is read. The environment must already be loaded.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  io: RunnerIo = consoleIo,
  signal: AbortSignal = new AbortController().signal,
  overrides: AttributesCliOverrides = {},
): Promise<number> {
  const parsed = parseAttributesArgs(argv);
  if (!parsed.ok) {
    io.err(`${LOG} ${parsed.error}`);
    io.err(USAGE);
    return 64;
  }

  const { docAttributesEnabled } = await import('./schema');
  if (!(overrides.enabled ?? (() => docAttributesEnabled()))()) {
    io.err(SWITCH_OFF_LINE);
    return 64;
  }

  const { backfillScope } = await import('@/lib/rag/tenant/backfill-scope');
  const { ImportFileError, runAttributesImport } = await import('./import');
  try {
    const scope = await (overrides.resolveScope ?? ((key: string) => backfillScope(key, { signal })))(parsed.tenantKey);
    if (!scope.ok) {
      if (scope.reason === 'unavailable') {
        io.err(`${LOG} the tenant could not be checked: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`);
        return 1;
      }
      io.err(`${LOG} tenant refused: ${scope.reason}`);
      io.err(USAGE);
      return 64;
    }
    const deps: AttributesImportDeps = { signal, io };
    if (overrides.rpc !== undefined) deps.rpc = overrides.rpc;
    if (overrides.loadSchema) deps.loadSchema = overrides.loadSchema;
    if (overrides.identifierIndex) deps.identifierIndex = overrides.identifierIndex;
    if (overrides.loadPatterns) deps.loadPatterns = overrides.loadPatterns;
    if ('reindexIdentifiers' in parsed) {
      const { runAttributeIdentifierReindex } = await import('./identifier-feed');
      return await runAttributeIdentifierReindex({ scope: scope.scope, apply: parsed.apply }, deps);
    }
    const outcome = await runAttributesImport({ scope: scope.scope, file: parsed.file, apply: parsed.apply }, deps);
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof ImportFileError) {
      io.err(`${LOG} ${error.message}`);
      io.err(USAGE);
      return 64;
    }
    if (signal.aborted) {
      io.err(`${LOG} interrupted; batches already applied stay applied, and running the same file again completes the import`);
      return 1;
    }
    io.err(`${LOG} failed: ${error instanceof Error ? error.name : 'unknown error'}`);
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
      console.error(`${LOG} failed`, error instanceof Error ? { error: error.name } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
