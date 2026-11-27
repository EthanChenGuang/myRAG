import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadDotenv } from 'dotenv';
import { readFeedbackLoopConfig } from '../feedback-loop/config';
import { IMPORT_LIMITS, importQuestions, parseQuestionFile, prepareQuestions, type ImportCounts, type QuestionFileFormat } from './questions-import';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface QuestionsImportCliDeps {
  env?: Record<string, string | undefined>;
  createClient?: (url: string, key: string) => SupabaseClient;
  now?: Date;
}

export type ParsedImportArgs =
  | { ok: true; tenant: string; file: string; format: QuestionFileFormat; column: string; dryRun: boolean }
  | { ok: false; message: string };

export const USAGE =
  'usage: npm run rag:questions-import -- --tenant <tenant key> --file <path.csv|path.jsonl> [--format csv|jsonl] [--column <name>] [--dry-run]';

const TENANT_KEY_RE = /^(?:s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const COLUMN_RE = /^[A-Za-z0-9_. -]{1,128}$/;
const REQUIRED_ENV = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
const PREFIX = '[Monitor]';
const VALUE_FLAGS = ['--tenant', '--file', '--format', '--column'] as const;

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

function formatOf(file: string): QuestionFileFormat | null {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.csv') return 'csv';
  if (extension === '.jsonl' || extension === '.ndjson') return 'jsonl';
  return null;
}

export function parseImportArgs(argv: string[]): ParsedImportArgs {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!(VALUE_FLAGS as readonly string[]).includes(flag) || value === undefined || values.has(flag)) {
      return { ok: false, message: 'unknown, repeated or incomplete option' };
    }
    values.set(flag, value);
    index += 1;
  }
  const tenant = values.get('--tenant');
  const file = values.get('--file');
  if (tenant === undefined || file === undefined) return { ok: false, message: '--tenant and --file are required' };
  if (!TENANT_KEY_RE.test(tenant)) return { ok: false, message: '--tenant must be s:default, u:<uuid> or o:<uuid>' };
  const explicit = values.get('--format');
  if (explicit !== undefined && explicit !== 'csv' && explicit !== 'jsonl') return { ok: false, message: '--format must be csv or jsonl' };
  const format = (explicit as QuestionFileFormat | undefined) ?? formatOf(file);
  if (format === null) return { ok: false, message: 'the file must end in .csv, .jsonl or .ndjson, or pass --format' };
  const column = values.get('--column') ?? 'question';
  if (!COLUMN_RE.test(column)) return { ok: false, message: '--column must be 1 to 128 letters, digits, spaces, dots, dashes or underscores' };
  return { ok: true, tenant, file, format, column, dryRun };
}

function countLines(counts: ImportCounts, dryRun: boolean): string[] {
  const languages = Object.entries(counts.by_language)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, n]) => `${code} ${n}`)
    .join(', ');
  return [
    `${PREFIX} questions import${dryRun ? ' (dry run, nothing written)' : ''}: read ${counts.read}, added ${counts.added}, duplicates ${counts.duplicates}, rejected_pii ${counts.rejected_pii}, truncated ${counts.truncated}, empty ${counts.empty}`,
    `${PREFIX} by_language: ${languages === '' ? 'none' : languages}`,
  ];
}

function serviceClient(url: string, key: string): SupabaseClient {
  return createSupabaseClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * The rag:questions-import CLI (D-51). Reads the file in place, never copies it and prints counts only, never a question or a row.
 * Exit codes: 0 done (or expert review off: one notice, nothing read or written), 1 the database failed, 2 the arguments, the
 * environment or the file limits were wrong.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, deps: QuestionsImportCliDeps = {}): Promise<number> {
  const parsed = parseImportArgs(argv);
  if (!parsed.ok) {
    io.err(`${PREFIX} ${parsed.message}`);
    io.err(USAGE);
    return 2;
  }
  const env = deps.env ?? process.env;
  if (!readFeedbackLoopConfig(env, () => undefined).domainExpertReview) {
    io.out(`${PREFIX} RAG_DOMAIN_EXPERT_REVIEW is off; the review queue is not in use, nothing was imported`);
    return 0;
  }
  const missing = REQUIRED_ENV.filter((name) => (env[name]?.trim() ?? '') === '');
  if (missing.length > 0) {
    io.err(`${PREFIX} set ${missing.join(' and ')} to run with the service role`);
    return 2;
  }

  let size: number;
  try {
    const info = await stat(parsed.file);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch {
    io.err(`${PREFIX} the file cannot be read`);
    return 2;
  }
  if (size > IMPORT_LIMITS.maxFileBytes) {
    io.err(`${PREFIX} the file is larger than the 10 MB limit`);
    return 2;
  }
  const text = await readFile(parsed.file, 'utf8');
  const file = parseQuestionFile(text, { format: parsed.format, column: parsed.column });
  if (!file.ok) {
    io.err(
      file.reason === 'too_many_rows'
        ? `${PREFIX} the file has more than the ${IMPORT_LIMITS.maxRows} rows limit`
        : `${PREFIX} the header row has no column named by --column`,
    );
    return 2;
  }

  const client = (deps.createClient ?? serviceClient)(env.NEXT_PUBLIC_SUPABASE_URL!.trim(), env.SUPABASE_SERVICE_ROLE_KEY!.trim());
  try {
    const counts = await importQuestions(client, {
      tenantKey: parsed.tenant,
      prepared: prepareQuestions(file.values),
      dryRun: parsed.dryRun,
      now: deps.now,
    });
    for (const line of countLines(counts, parsed.dryRun)) io.out(line);
    return 0;
  } catch (error) {
    const operation = (error as { operation?: unknown } | null)?.operation;
    const code = (error as { code?: unknown } | null)?.code;
    io.err(`${PREFIX} questions import failed${typeof operation === 'string' ? ` (${operation}${typeof code === 'string' ? ` ${code}` : ''})` : ''}`);
    return 1;
  }
}

async function run(argv: string[], io: CliIo): Promise<number> {
  try {
    return await main(argv, io);
  } catch {
    io.err(`${PREFIX} questions import failed`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  run(process.argv.slice(2), consoleIo).then((code) => process.exit(code));
}
