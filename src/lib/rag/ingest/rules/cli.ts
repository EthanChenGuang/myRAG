import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { BackfillScopeResult } from '@/lib/rag/tenant/backfill-scope';
import type { RunnerIo } from '../backfill/runners';

export type ParsedRulesArgs =
  | { ok: true; command: 'import'; tenantKey: string; actorUserId: string; file: string; apply: boolean }
  | { ok: true; command: 'export'; tenantKey: string; actorUserId: string; out: string }
  | { ok: false; error: string };

export const USAGE = [
  'usage: npm run rag:rules -- import --tenant <key> --actor <uuid> --file <path> [--dry-run | --apply]',
  '       npm run rag:rules -- export --tenant <key> --actor <uuid> --out <path>',
  '  The rules file follows the TenantRulesFile contract (section_rule_sets, boilerplate_rules), at most 2 MB, kept outside the repository.',
  '  --actor is an admin of the tenant; the rule functions check it again. Stored rows the file does not name are kept, never deleted.',
  '  The import report always runs first. Without --apply, or with --dry-run, the command stops after the report (exit 2).',
  '  export writes a new file (mode 0600) outside the working directory; an existing path is refused.',
  '  Exit codes: 0 done, 1 failed, 2 report only, 3 file refused, 64 usage.',
].join('\n');

const LOG = '[RAG Rules]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WITH_VALUE: Record<'import' | 'export', Set<string>> = {
  import: new Set(['--tenant', '--actor', '--file']),
  export: new Set(['--tenant', '--actor', '--out']),
};
const FLAGS: Record<'import' | 'export', Set<string>> = { import: new Set(['--dry-run', '--apply']), export: new Set() };

export const SWITCH_OFF_LINE =
  `${LOG} RAG_SECTION_RULES and RAG_PAGE_BOILERPLATE are off: rag:rules needs RAG_SECTION_RULES=on or RAG_PAGE_BOILERPLATE on, ` +
  'with RAG_INGEST_PIPELINE=unified; nothing was read or written';

/** `import` takes --tenant, --actor and --file plus --dry-run or --apply; `export` takes --tenant, --actor and --out. */
export function parseRulesArgs(argv: string[]): ParsedRulesArgs {
  const command = argv[0];
  if (command !== 'import' && command !== 'export') return { ok: false, error: 'the first argument must be import or export' };
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (FLAGS[command].has(arg)) {
      if (flags.has(arg)) return { ok: false, error: `${arg} was given twice` };
      flags.add(arg);
    } else if (WITH_VALUE[command].has(arg)) {
      const value = argv[(i += 1)];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
      if (values.has(arg)) return { ok: false, error: `${arg} was given twice` };
      values.set(arg, value);
    } else {
      return { ok: false, error: `unknown option for ${command}: ${arg}` };
    }
  }
  if (flags.has('--dry-run') && flags.has('--apply')) return { ok: false, error: '--dry-run and --apply exclude each other' };
  const tenantKey = values.get('--tenant');
  if (!tenantKey) return { ok: false, error: '--tenant is required' };
  const actorUserId = values.get('--actor');
  if (!actorUserId) return { ok: false, error: '--actor is required' };
  if (!UUID.test(actorUserId)) return { ok: false, error: '--actor must be a user id (uuid)' };
  if (command === 'import') {
    const file = values.get('--file');
    if (!file) return { ok: false, error: '--file is required' };
    return { ok: true, command, tenantKey, actorUserId: actorUserId.toLowerCase(), file, apply: flags.has('--apply') };
  }
  const out = values.get('--out');
  if (!out) return { ok: false, error: '--out is required' };
  return { ok: true, command, tenantKey, actorUserId: actorUserId.toLowerCase(), out };
}

const consoleIo: RunnerIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

/** Test and embedding hooks: the tenant resolver, the switches and the working directory the export must stay outside of. */
export type RulesCliOverrides = {
  resolveScope?: (tenantKey: string) => Promise<BackfillScopeResult>;
  enabled?: () => { sectionRules: boolean; pageBoilerplate: boolean };
  cwd?: string;
};

/**
 * The CLI body: 0 done, 1 failed, 2 stopped after the report, 3 file refused, 64 usage (flags, both switches off, a list whose switch is
 * off, a refused tenant, an unreadable file, a refused output path, a refused actor). The switches are checked before anything is read.
 * The environment must already be loaded.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  io: RunnerIo = consoleIo,
  signal: AbortSignal = new AbortController().signal,
  overrides: RulesCliOverrides = {},
): Promise<number> {
  const parsed = parseRulesArgs(argv);
  if (!parsed.ok) {
    io.err(`${LOG} ${parsed.error}`);
    io.err(USAGE);
    return 64;
  }

  const { pageBoilerplateEnabled, sectionRulesEnabled } = await import('./service');
  const switches = (overrides.enabled ?? (() => ({ sectionRules: sectionRulesEnabled(), pageBoilerplate: pageBoilerplateEnabled() })))();
  if (!switches.sectionRules && !switches.pageBoilerplate) {
    io.err(SWITCH_OFF_LINE);
    return 64;
  }

  const { backfillScope } = await import('@/lib/rag/tenant/backfill-scope');
  const transfer = await import('./transfer');
  try {
    let file: import('@/lib/rag-eval/contracts.generated').TenantRulesFile | null = null;
    if (parsed.command === 'import') {
      const read = await transfer.readRulesFile(parsed.file, { signal });
      if (!read.ok) {
        for (const issue of read.issues) io.err(`${LOG}   ${issue.path === '' ? '(file)' : issue.path}: ${issue.code}`);
        io.err(`${LOG} file refused: ${read.issues.length} issue(s); nothing was written`);
        return 3;
      }
      if ((read.file.section_rule_sets ?? []).length > 0 && !switches.sectionRules) {
        io.err(`${LOG} the file has section rule sets but RAG_SECTION_RULES is off: it needs RAG_SECTION_RULES=on and RAG_INGEST_PIPELINE=unified`);
        return 64;
      }
      if ((read.file.boilerplate_rules ?? []).length > 0 && !switches.pageBoilerplate) {
        io.err(`${LOG} the file has boilerplate rules but RAG_PAGE_BOILERPLATE is off: it needs RAG_PAGE_BOILERPLATE on and RAG_INGEST_PIPELINE=unified`);
        return 64;
      }
      file = read.file;
    }

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

    const deps = { signal, io };
    if (parsed.command === 'import' && file !== null) {
      const outcome = await transfer.runRulesImport(
        { scope: scope.scope, actorUserId: parsed.actorUserId, file, apply: parsed.apply, ...switches },
        deps,
      );
      return outcome.exitCode;
    }
    if (parsed.command === 'export') {
      const outcome = await transfer.runRulesExport(
        { scope: scope.scope, actorUserId: parsed.actorUserId, out: parsed.out, ...switches, cwd: overrides.cwd ?? process.cwd() },
        deps,
      );
      return outcome.exitCode;
    }
    return 64;
  } catch (error) {
    if (error instanceof transfer.RulesFileError) {
      io.err(`${LOG} ${error.message}`);
      io.err(USAGE);
      return 64;
    }
    if (signal.aborted) {
      io.err(`${LOG} interrupted; writes already applied stay applied, and running the same file again completes the import`);
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
