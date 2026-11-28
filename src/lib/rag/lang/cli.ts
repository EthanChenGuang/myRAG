import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { normalizeLanguageSettings, parseLanguageList } from '../../../../config/rag/validate-language-settings.cjs';
import { readEnvFileValues, writeLanguageVariables } from '../../../../scripts/rag/language-settings-context.js';
import type { StartRebuildResult } from '../ingest/rebuild/run';
import {
  appLanguageChangeContext,
  baselineCommand,
  languageBaselinePath,
  LIVE_BASELINE_DIR,
  planLanguageChange,
  type LanguageChangeContext,
  type LanguageChangePlan,
} from './change-plan';
import { getLanguageRegistry } from './registry';

const TAG = '[RAG Languages]';
const CODE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const FIXTURE_MODES = ['prechunked', 'ingest'] as const;
/** rag_eval.baseline refuses fewer runs (MIN_RUNS). */
const BASELINE_RUNS = 3;

export const USAGE = [
  'usage: npm run rag:languages -- baseline <code> [--fixture-mode prechunked|ingest] [--base-url <url>]',
  '       npm run rag:languages -- plan --languages <a,b,...> [--primary <code>]',
  '       npm run rag:languages -- add <code> [--primary <code>] [--dry-run]',
  '       npm run rag:languages -- remove <code> [--primary <code>] [--dry-run]',
  '       npm run rag:languages -- rebuild   (start or continue the language_add reprocessing for the saved set)',
  '       npm run rag:languages -- selection --languages <a,b,...> [--primary <code>]   (JSON counts of the language_add groups, a dry run)',
].join('\n');

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export type ParsedLanguagesArgs =
  | { ok: true; command: 'baseline'; code: string; fixtureMode: (typeof FIXTURE_MODES)[number]; baseUrl: string | null }
  | { ok: true; command: 'plan'; languages: string[]; primary: string | null }
  | { ok: true; command: 'add' | 'remove'; code: string; primary: string | null; dryRun: boolean }
  | { ok: true; command: 'rebuild' }
  | { ok: true; command: 'selection'; languages: string[]; primary: string | null }
  | { ok: false; error: string };

export function parseLanguagesArgs(argv: string[]): ParsedLanguagesArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === '--dry-run') {
      flags['dry-run'] = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const value = rest[(i += 1)];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
      const name = arg.slice(2);
      if (flags[name] !== undefined) return { ok: false, error: `${arg} was given twice` };
      flags[name] = value;
      continue;
    }
    positional.push(arg);
  }
  const value = (name: string): string | null => (typeof flags[name] === 'string' ? (flags[name] as string) : null);
  const allowed = (names: string[]): string | null => Object.keys(flags).find((name) => !names.includes(name)) ?? null;
  const primary = value('primary');
  if (primary !== null && !CODE.test(primary)) return { ok: false, error: '--primary must be a language code' };
  switch (command) {
    case 'baseline': {
      const unknown = allowed(['fixture-mode', 'base-url']);
      if (unknown) return { ok: false, error: `unknown option: --${unknown}` };
      const code = positional[0];
      if (positional.length !== 1 || !code || !CODE.test(code)) return { ok: false, error: 'baseline needs one language code' };
      const mode = value('fixture-mode') ?? 'prechunked';
      if (!(FIXTURE_MODES as readonly string[]).includes(mode)) return { ok: false, error: '--fixture-mode must be prechunked or ingest' };
      return { ok: true, command, code, fixtureMode: mode as (typeof FIXTURE_MODES)[number], baseUrl: value('base-url') };
    }
    case 'plan': {
      const unknown = allowed(['languages', 'primary']);
      if (unknown) return { ok: false, error: `unknown option: --${unknown}` };
      const languages = parseLanguageList(value('languages') ?? '');
      if (languages.length === 0 || positional.length > 0) return { ok: false, error: 'plan needs --languages <a,b,...>' };
      return { ok: true, command, languages, primary };
    }
    case 'add':
    case 'remove': {
      const unknown = allowed(['primary', 'dry-run']);
      if (unknown) return { ok: false, error: `unknown option: --${unknown}` };
      const code = positional[0];
      if (positional.length !== 1 || !code || !CODE.test(code)) return { ok: false, error: `${command} needs one language code` };
      return { ok: true, command, code, primary, dryRun: flags['dry-run'] === true };
    }
    case 'selection': {
      const unknown = allowed(['languages', 'primary']);
      if (unknown) return { ok: false, error: `unknown option: --${unknown}` };
      const languages = parseLanguageList(value('languages') ?? '');
      if (languages.length === 0 || positional.length > 0 || !languages.every((code) => CODE.test(code))) return { ok: false, error: 'selection needs --languages <a,b,...>' };
      return { ok: true, command, languages, primary };
    }
    case 'rebuild':
      if (rest.length > 0) return { ok: false, error: 'rebuild takes no argument' };
      return { ok: true, command };
    default:
      return { ok: false, error: command ? `unknown command: ${command}` : 'a command is required' };
  }
}

export interface SavedLanguages {
  languages: string[];
  primary: string | null;
}

export interface LanguagesCliDeps {
  root?: string;
  /** The saved set, read from .env.local by default. */
  readSaved?: () => SavedLanguages;
  context?: () => Promise<LanguageChangeContext>;
  /** The Phase 3.2 writer (scripts/rag/language-settings-context.js, temp file then rename) by default. */
  save?: (normalized: { languages: string[]; primary: string }) => void;
  /** Starts the Phase 3.2 rebuild with the language_add selection under the saved values. */
  startRebuild?: (saved: { languages: string[]; primary: string }) => Promise<StartRebuildResult>;
  /** Runs rag_eval.baseline record and returns the path of the full baseline it wrote. */
  /** The dry run behind `selection`. */
  dryRunSelection?: (saved: { languages: string[]; primary: string }) => Promise<StartRebuildResult>;
  runBaseline?: (options: { out: string; fixtureMode: string; baseUrl: string | null }) => number;
  now?: () => Date;
}

function defaultReadSaved(root: string): SavedLanguages {
  const values = readEnvFileValues(path.join(root, '.env.local')) as Record<string, string | undefined>;
  const saved = normalizeLanguageSettings(values.RAG_SUPPORTED_LANGUAGES, values.RAG_PRIMARY_LANGUAGE, getLanguageRegistry());
  return { languages: saved.languages, primary: saved.primary };
}

async function defaultStartRebuild(saved: { languages: string[]; primary: string }): Promise<StartRebuildResult> {
  const { startRebuild } = await import('../ingest/rebuild/run');
  const { savedFingerprintValues } = await import('../ingest/fingerprint/impact');
  const values = { ...savedFingerprintValues(), RAG_SUPPORTED_LANGUAGES: saved.languages.join(','), RAG_PRIMARY_LANGUAGE: saved.primary };
  return startRebuild({ mechanism: 'reparse', selection: 'language_add', startedBy: 'cli:rag:languages' }, { saved: values });
}

function defaultRunBaseline(root: string): NonNullable<LanguagesCliDeps['runBaseline']> {
  return ({ out, fixtureMode, baseUrl }) => {
    const args = ['run', '--directory', 'eval', 'python', '-m', 'rag_eval.baseline', 'record', '--runs', String(BASELINE_RUNS), '--out', out, '--fixture-mode', fixtureMode];
    if (baseUrl) args.push('--base-url', baseUrl);
    const result = spawnSync('uv', args, { cwd: root, stdio: 'inherit', env: process.env });
    return result.status ?? 1;
  };
}

function printRefusals(plan: LanguageChangePlan, io: CliIo): void {
  for (const refusal of plan.refusals) {
    const parts = [refusal.code, refusal.language ? `language ${refusal.language}` : null, refusal.id ? `id ${refusal.id}` : null].filter(Boolean);
    io.err(`${TAG} refused: ${parts.join(', ')}`);
    if (refusal.command) io.err(`${TAG} record the baseline first: ${refusal.command}`);
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/** Records eval/baselines/languages/<code>.json from a rag_eval.baseline run: the language slice, config hash and golden sha256. */
function recordBaseline(parsed: Extract<ParsedLanguagesArgs, { command: 'baseline' }>, root: string, deps: LanguagesCliDeps, io: CliIo): number {
  const pack = getLanguageRegistry().packs.find((candidate) => candidate.code === parsed.code);
  if (!pack) {
    io.err(`${TAG} refused: unknown_language, language ${parsed.code}`);
    return 2;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-language-baseline-'));
  const liveDir = parsed.baseUrl ? path.join(root, LIVE_BASELINE_DIR) : null;
  const full = liveDir ? path.join(liveDir, `${parsed.code}.full.json`) : path.join(scratch, 'baseline.json');
  try {
    const status = (deps.runBaseline ?? defaultRunBaseline(root))({ out: full, fixtureMode: parsed.fixtureMode, baseUrl: parsed.baseUrl });
    if (status !== 0) {
      io.err(`${TAG} the eval baseline run failed (exit ${status}); nothing recorded`);
      return 1;
    }
    const baseline = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
    const slices = (baseline.slices ?? {}) as Record<string, unknown>;
    const slice = slices[`language:${parsed.code}`];
    if (!slice) {
      io.err(`${TAG} refused: golden_slice_missing, language ${parsed.code}; the golden set has no item in this language`);
      return 2;
    }
    const record = {
      schema_version: 1,
      language: parsed.code,
      recorded_at: (deps.now ?? (() => new Date()))().toISOString(),
      tool: 'rag_eval.baseline record',
      fixture_mode: parsed.fixtureMode,
      population: parsed.baseUrl ? 'live' : 'fixture',
      run_config_hash: baseline.run_config_hash,
      golden_sha256: baseline.golden_sha256,
      golden_manifest_sha256: baseline.golden_manifest_sha256 ?? null,
      golden_set_version: baseline.golden_set_version ?? null,
      corpus_sha256: baseline.corpus_sha256 ?? null,
      runs: Array.isArray(baseline.runs) ? baseline.runs.length : null,
      slice,
    };
    const target = liveDir ? path.join(liveDir, `${parsed.code}.json`) : (languageBaselinePath(root, parsed.code) as string);
    writeJsonAtomic(target, record);
    io.out(`${TAG} baseline recorded for ${parsed.code}: ${path.relative(root, target)} (run_config_hash ${String(record.run_config_hash).slice(0, 12)})`);
    return 0;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function groupLine(result: StartRebuildResult): string {
  const groups = result.groups ?? { und: 0, scanned: 0, stale: 0 };
  return `und ${groups.und}, scanned ${groups.scanned}, stale ${groups.stale}, total ${result.affected}`;
}

/**
 * CLI entry. Exit codes: 0 done, 1 database, environment or eval failure, 2 bad arguments or a refused change (nothing changed).
 * Prints codes and counts only.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, deps: LanguagesCliDeps = {}): Promise<number> {
  const parsed = parseLanguagesArgs(argv);
  if (!parsed.ok) {
    io.err(`${TAG} ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  const root = deps.root ?? process.cwd();
  if (parsed.command === 'baseline') return recordBaseline(parsed, root, deps, io);

  const saved = (deps.readSaved ?? (() => defaultReadSaved(root)))();
  if (parsed.command === 'selection') return printSelection(parsed, io, deps);
  if (parsed.command === 'rebuild') {
    if (saved.languages.length === 0 || !saved.primary) {
      io.err(`${TAG} no supported language is saved`);
      return 2;
    }
    if (deps.startRebuild === undefined && !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      io.err(`${TAG} refused: set SUPABASE_SERVICE_ROLE_KEY`);
      return 1;
    }
    return runRebuild({ languages: saved.languages, primary: saved.primary }, io, deps);
  }
  const proposed =
    parsed.command === 'plan'
      ? parsed.languages
      : parsed.command === 'add'
        ? [...saved.languages, parsed.code]
        : saved.languages.filter((code) => code !== parsed.code);
  if (parsed.command === 'add' && saved.languages.includes(parsed.code)) {
    io.err(`${TAG} ${parsed.code} is already a supported language`);
    return 2;
  }
  if (parsed.command === 'remove' && !saved.languages.includes(parsed.code)) {
    io.err(`${TAG} ${parsed.code} is not a supported language`);
    return 2;
  }
  const primary = parsed.primary ?? (saved.primary && proposed.includes(saved.primary) ? saved.primary : (proposed[0] ?? null));
  const context = await (deps.context ?? (() => appLanguageChangeContext(root)))();
  const plan = planLanguageChange({ current: saved.languages, proposed, primary }, context);

  if (!plan.ok) {
    printRefusals(plan, io);
    return 2;
  }
  io.out(`${TAG} plan: added ${plan.added.join(',') || '-'}; removed ${plan.removed.join(',') || '-'}; steps ${plan.steps.map((step) => step.kind).join(', ') || 'none'}`);
  for (const note of plan.notes) io.out(`${TAG} ${note.language}: its documents stay searchable; nothing is deleted or rebuilt`);
  if (parsed.command === 'plan' || (parsed.command === 'add' && parsed.dryRun) || (parsed.command === 'remove' && parsed.dryRun)) return 0;
  if (!plan.normalized || plan.steps.every((step) => step.kind !== 'save')) return 0;

  (deps.save ?? ((normalized) => writeLanguageVariables(path.join(root, '.env.local'), normalized)))(plan.normalized);
  io.out(`${TAG} saved RAG_SUPPORTED_LANGUAGES=${plan.normalized.languages.join(',')} RAG_PRIMARY_LANGUAGE=${plan.normalized.primary}`);
  if (!plan.rebuild) return 0;

  if (deps.startRebuild === undefined && !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    io.err(`${TAG} saved; set SUPABASE_SERVICE_ROLE_KEY, then start the reprocessing with: npm run rag:languages -- rebuild`);
    return 1;
  }
  return runRebuild(plan.normalized, io, deps);
}

/** One JSON line with the language_add group counts under the given set (a dry run; nothing is written). Used by the Config UI server. */
async function printSelection(parsed: Extract<ParsedLanguagesArgs, { command: 'selection' }>, io: CliIo, deps: LanguagesCliDeps): Promise<number> {
  if (deps.dryRunSelection === undefined && !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    io.err(`${TAG} refused: set SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }
  const primary = parsed.primary && parsed.languages.includes(parsed.primary) ? parsed.primary : (parsed.languages[0] as string);
  try {
    const result = await (deps.dryRunSelection ?? defaultDryRunSelection)({ languages: parsed.languages, primary });
    io.out(JSON.stringify({ groups: result.groups ?? { und: 0, scanned: 0, stale: 0 }, total: result.affected }));
    return 0;
  } catch (error) {
    io.err(`${TAG} the selection could not be counted (${error instanceof Error ? error.name : 'error'})`);
    return 1;
  }
}

async function defaultDryRunSelection(saved: { languages: string[]; primary: string }): Promise<StartRebuildResult> {
  const { startRebuild } = await import('../ingest/rebuild/run');
  const { savedFingerprintValues } = await import('../ingest/fingerprint/impact');
  const values = { ...savedFingerprintValues(), RAG_SUPPORTED_LANGUAGES: saved.languages.join(','), RAG_PRIMARY_LANGUAGE: saved.primary };
  return startRebuild({ mechanism: 'reparse', selection: 'language_add', dryRun: true, startedBy: 'cli:rag:languages' }, { saved: values });
}

async function runRebuild(saved: { languages: string[]; primary: string }, io: CliIo, deps: LanguagesCliDeps): Promise<number> {
  try {
    const result = await (deps.startRebuild ?? defaultStartRebuild)(saved);
    io.out(`${TAG} language_add rebuild (${result.status}): ${groupLine(result)}`);
    if (result.status === 'command' && result.plan.kind === 'needs_async') io.out(`${TAG} reparse needs RAG_INGEST_ASYNC=on; then run ${result.plan.command}`);
    if (result.run) io.out(`${TAG} run ${result.run.id} ${result.run.state}`);
    return 0;
  } catch (error) {
    io.err(`${TAG} saved; the rebuild could not start (${error instanceof Error ? error.name : 'error'})`);
    return 1;
  }
}

export const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

export { baselineCommand };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  main(process.argv.slice(2), consoleIo).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`${TAG} failed`, error instanceof Error ? { error: error.name, message: error.message.slice(0, 200) } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
