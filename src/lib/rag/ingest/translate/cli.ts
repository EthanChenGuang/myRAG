import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { isTenantKey } from '../writer';
import type { TranslationEstimateResult, TranslationRefusal, TranslationRunResult } from './produce';

export type ParsedTranslateArgs =
  | { ok: true; tenantKey: string; dryRun: boolean; budgetUsd: number | null; resume: boolean; reembed: boolean; languages: string[] | null }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const USAGE = [
  'usage: npm run rag:translate -- --tenant <key> [--dry-run] [--budget <USD>] [--resume] [--language <code>]',
  '       npm run rag:translate -- --tenant <key> --reembed --budget <USD>',
  '  Translates the tenant\'s pending chunks into its target languages (RAG_DOC_TRANSLATION=on and the tenant\'s setting enabled).',
  '  The dry run always runs first. Without --budget, or with --dry-run, the command stops after the report (exit 2).',
  '  --resume continues after an interrupted or budget-stopped run (progress is read from the stored translations).',
  '  --reembed writes vectors of the active embedding profile for existing translations; it never calls the translation model.',
  '  Exit codes: 0 done, 1 failed, 2 report only, 3 stopped at the budget with chunks remaining, 64 usage or refused.',
].join('\n');

const MAX_BUDGET_USD = 1_000_000;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const WITH_VALUE = new Set(['--tenant', '--budget', '--language']);
const FLAGS = new Set(['--dry-run', '--resume', '--reembed']);

export function parseTranslateArgs(argv: string[]): ParsedTranslateArgs {
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
  const tenantKey = values.get('--tenant');
  if (!tenantKey) return { ok: false, error: '--tenant is required' };
  if (!isTenantKey(tenantKey)) return { ok: false, error: '--tenant needs s:default, u:<uuid> or o:<uuid>' };

  let budgetUsd: number | null = null;
  const rawBudget = values.get('--budget');
  if (rawBudget !== undefined) {
    const parsed = /^\d+(\.\d+)?$/.test(rawBudget) ? Number(rawBudget) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed > MAX_BUDGET_USD) return { ok: false, error: `--budget needs a USD amount from 0 to ${MAX_BUDGET_USD}` };
    budgetUsd = parsed;
  }
  const language = values.get('--language');
  if (language !== undefined && !LANGUAGE.test(language)) return { ok: false, error: '--language needs a language code' };
  const reembed = flags.has('--reembed');
  const dryRun = flags.has('--dry-run');
  if (reembed && (dryRun || language !== undefined || flags.has('--resume'))) {
    return { ok: false, error: '--reembed takes only --tenant and --budget' };
  }
  return { ok: true, tenantKey: tenantKey.toLowerCase(), dryRun, budgetUsd, resume: flags.has('--resume'), reembed, languages: language ? [language] : null };
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

const REFUSALS: Record<TranslationRefusal, string> = {
  switch_off: 'document translation is off (RAG_DOC_TRANSLATION=off); nothing was translated',
  monolingual: 'the deployment has one language; document translation does not apply',
  languages_not_configured: 'RAG_SUPPORTED_LANGUAGES is not configured; nothing was translated',
  tenant_disabled: 'the tenant has not enabled translation; nothing was sent to the model',
  no_targets: 'the tenant has no supported target language; nothing was sent to the model',
  invalid_argument: 'invalid tenant',
  unavailable: 'the database could not be reached: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
};

function refused(io: CliIo, reason: TranslationRefusal): number {
  io.err(`[Translation] refused: ${REFUSALS[reason]}`);
  return reason === 'unavailable' ? 1 : 64;
}

const usd = (value: number) => `$${value.toFixed(4)}`;

function printEstimate(io: CliIo, estimate: Extract<TranslationEstimateResult, { ok: true }>): void {
  io.out(`[Translation] dry run: model ${estimate.model}, embedding profile ${estimate.profileId}`);
  for (const entry of estimate.languages) {
    io.out(
      `  ${entry.language}: ${entry.chunks} chunks, ${entry.inputTokens} input tokens, ${entry.outputTokens} output tokens, ${usd(entry.estimatedUsd)}` +
        (entry.tooLong > 0 ? ` (${entry.tooLong} too long, skipped)` : ''),
    );
  }
  io.out(`  total: ${estimate.chunks} chunks, estimated ${usd(estimate.estimatedUsd)} (list-price estimate)`);
}

function printRun(io: CliIo, result: Extract<TranslationRunResult, { ok: true }>, reembed: boolean): void {
  if (reembed) {
    io.out(`[Translation] re-embedded ${result.reembedded} translations, estimated ${usd(result.estimatedUsd)}`);
  } else {
    for (const [language, counts] of Object.entries(result.byLanguage)) {
      io.out(`  ${language}: ${counts.translated} translated, ${counts.gaps} gaps, ${counts.remaining} remaining`);
    }
    io.out(`[Translation] translated ${result.translated}, gaps ${result.gaps}, remaining ${result.remaining}, estimated ${usd(result.estimatedUsd)}`);
  }
  if (result.stopped) io.out(`[Translation] stopped: ${result.stopped}; ${result.remaining} remaining, continue with --resume`);
}

/**
 * The CLI body: 0 done, 1 failed, 2 stopped after the report, 3 stopped at the budget with chunks remaining, 64 usage or refused.
 * Prints counts and dollars, never chunk text. The environment must already be loaded.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, signal: AbortSignal = new AbortController().signal): Promise<number> {
  const parsed = parseTranslateArgs(argv);
  if (!parsed.ok) {
    io.err(`[Translation] ${parsed.error}`);
    io.err(USAGE);
    return 64;
  }
  const produce = await import('./produce');
  try {
    if (!parsed.reembed) {
      const estimate = await produce.estimateTranslation(parsed.tenantKey, { signal, ...(parsed.languages ? { languages: parsed.languages } : {}) });
      if (!estimate.ok) return refused(io, estimate.reason);
      printEstimate(io, estimate);
      if (parsed.dryRun) return 2;
      if (parsed.budgetUsd === null) {
        io.out('[Translation] no --budget given: stopping after the report');
        return 2;
      }
    } else if (parsed.budgetUsd === null) {
      io.err('[Translation] --reembed needs --budget <USD>');
      return 64;
    }
    const result = await produce.translatePending(parsed.tenantKey, {
      signal,
      budgetUsd: parsed.budgetUsd,
      reembedOnly: parsed.reembed,
      ...(parsed.languages ? { languages: parsed.languages } : {}),
      pageSize: 32,
    });
    if (!result.ok) return refused(io, result.reason);
    printRun(io, result, parsed.reembed);
    if (result.stopped === 'usd_budget') return 3;
    if (result.stopped !== null) return 1;
    return 0;
  } catch (error) {
    if (signal.aborted) {
      io.err('[Translation] interrupted; continue with --resume');
      return 1;
    }
    io.err(`[Translation] failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`);
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
      console.error('[Translation] failed', error instanceof Error ? { error: error.name, message: error.message.slice(0, 200) } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
