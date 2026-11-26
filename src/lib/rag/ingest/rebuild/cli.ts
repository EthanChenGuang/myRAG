import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import type { RpcClient } from '../../backend/supabase-rpc';
import type { RebuildDeps, RebuildRunRow, StartRebuildResult } from './run';

export type ParsedRebuildArgs =
  | { ok: true; command: 'start'; mechanism: string; dryRun: boolean }
  | { ok: true; command: 'status'; runId: string | null }
  | { ok: true; command: 'record-eval'; runId: string; report: string }
  | { ok: true; command: 'activate' | 'rollback'; runId: string }
  | { ok: true; command: 'rescan'; check: 'hidden_text' | 'links'; tenantKey: string | null; dryRun: boolean }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const TAG = '[RAG Rebuild]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_KEY = /^(?:s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const RESCAN_SWITCH = { hidden_text: 'RAG_HIDDEN_TEXT_CHECK', links: 'RAG_INGEST_LINK_CHECK' } as const;

export const USAGE = [
  'usage: npm run rag:rebuild -- start --mechanism <reparse|rechunk|relex|reembed|recaption|retranslate> [--dry-run]',
  '       npm run rag:rebuild -- status [<run_id>]',
  '       npm run rag:rebuild -- record-eval <run_id> --report <gate.json>',
  '       npm run rag:rebuild -- activate <run_id>',
  '       npm run rag:rebuild -- rollback <run_id>',
  '       npm run rag:rebuild -- rescan --check <hidden_text|links> [--tenant <key>] [--dry-run]',
].join('\n');

export function parseRebuildArgs(argv: string[]): ParsedRebuildArgs {
  const [command, ...rest] = argv;
  switch (command) {
    case 'start': {
      let mechanism: string | null = null;
      let dryRun = false;
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i] as string;
        if (arg === '--dry-run') {
          if (dryRun) return { ok: false, error: '--dry-run was given twice' };
          dryRun = true;
        } else if (arg === '--mechanism') {
          const value = rest[(i += 1)];
          if (value === undefined || value.startsWith('--')) return { ok: false, error: '--mechanism needs a value' };
          if (mechanism !== null) return { ok: false, error: '--mechanism was given twice' };
          mechanism = value;
        } else {
          return { ok: false, error: `unknown option: ${arg}` };
        }
      }
      if (mechanism === null) return { ok: false, error: 'start needs --mechanism' };
      return { ok: true, command, mechanism, dryRun };
    }
    case 'status': {
      if (rest.length > 1) return { ok: false, error: 'status takes at most one run id' };
      const runId = rest[0] ?? null;
      if (runId !== null && !UUID.test(runId)) return { ok: false, error: 'the run id must be a UUID' };
      return { ok: true, command, runId };
    }
    case 'record-eval': {
      const [runId, flag, report, ...extra] = rest;
      if (runId === undefined || !UUID.test(runId)) return { ok: false, error: 'record-eval needs a run id (UUID)' };
      if (flag !== '--report' || report === undefined || report.startsWith('--') || extra.length > 0) return { ok: false, error: 'record-eval needs --report <path>' };
      return { ok: true, command, runId, report };
    }
    case 'activate':
    case 'rollback': {
      const [runId, ...extra] = rest;
      if (runId === undefined || !UUID.test(runId) || extra.length > 0) return { ok: false, error: `${command} needs one run id (UUID)` };
      return { ok: true, command, runId };
    }
    case 'rescan': {
      let check: 'hidden_text' | 'links' | null = null;
      let tenantKey: string | null = null;
      let dryRun = false;
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i] as string;
        if (arg === '--dry-run') {
          if (dryRun) return { ok: false, error: '--dry-run was given twice' };
          dryRun = true;
        } else if (arg === '--check' || arg === '--tenant') {
          const value = rest[(i += 1)];
          if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
          if (arg === '--check') {
            if (check !== null) return { ok: false, error: '--check was given twice' };
            if (value !== 'hidden_text' && value !== 'links') return { ok: false, error: '--check must be hidden_text or links' };
            check = value;
          } else {
            if (tenantKey !== null) return { ok: false, error: '--tenant was given twice' };
            if (!TENANT_KEY.test(value)) return { ok: false, error: '--tenant must be s:default, u:<uuid> or o:<uuid>' };
            tenantKey = value;
          }
        } else {
          return { ok: false, error: `unknown option: ${arg}` };
        }
      }
      if (check === null) return { ok: false, error: 'rescan needs --check' };
      return { ok: true, command, check, tenantKey, dryRun };
    }
    default:
      return { ok: false, error: command === undefined ? 'a command is required' : `unknown command: ${command}` };
  }
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

function runLine(run: RebuildRunRow): string {
  const evidence = run.evidencePassed === null ? 'no eval' : run.evidencePassed ? 'eval passed' : 'eval failed';
  return `${run.id} ${run.mechanism} ${run.state} ${run.done}/${run.total} gaps ${run.gaps} activation ${run.activation} ${evidence}`;
}

function printStart(result: StartRebuildResult, io: CliIo): void {
  const { plan } = result;
  io.out(`${TAG} ${result.mechanism}: ${result.affected} documents on previous settings, ${result.withoutFingerprint} without a fingerprint`);
  if (result.withoutFingerprint > 0) io.out(`${TAG} documents without a fingerprint are not selected: run npm run rag:fingerprint -- backfill first`);
  switch (plan.kind) {
    case 'nothing':
      io.out(`${TAG} nothing to rebuild`);
      return;
    case 'needs_async':
      io.out(`${TAG} reparse needs RAG_INGEST_ASYNC=on; with it on, run: ${plan.command}`);
      return;
    case 'command':
      io.out(`${TAG} run ${plan.commands.length === 1 ? 'this command' : 'these commands'}:`);
      for (const command of plan.commands) io.out(`  ${command}`);
      return;
    case 'held_batch':
    case 'chunking_profile':
      if (result.status === 'dry_run') {
        io.out(`${TAG} dry run, nothing written: ${plan.kind === 'held_batch' ? 'a held re-ingest batch' : 'a chunking profile build'} of ${plan.affected} documents`);
        if (plan.kind === 'chunking_profile') for (const profile of plan.profiles) io.out(`  profile ${profile.profileId} (${profile.docType}), child ${profile.childTokens} tokens, parent_mode none`);
        return;
      }
      if (result.run) io.out(`${TAG} ${result.resumed ? 'continued' : 'started'} ${runLine(result.run)}${result.more ? ' (call start again to continue)' : ''}`);
      if (plan.kind === 'chunking_profile') io.out(`${TAG} activate with npm run rag:chunking -- activate <profile> once the profile is ready and evaluated`);
      else io.out(`${TAG} when the jobs are done: record-eval, then activate (rollback restores the previous versions)`);
  }
}

/**
 * D-47: the security rescan, a separate explicit action. Exit 0 when every document was checked, 1 when some could not be (checker or
 * database unavailable: run it again), 2 for bad arguments, 3 when the check is off. Prints counts and document ids only.
 */
async function rescan(
  parsed: Extract<ParsedRebuildArgs, { command: 'rescan' }>,
  io: CliIo,
  signal: AbortSignal | undefined,
  db: RpcClient | null | undefined,
): Promise<number> {
  const { rescanDocuments } = await import('../../security/rescan');
  const result = await rescanDocuments(
    { check: parsed.check, tenantKey: parsed.tenantKey, dryRun: parsed.dryRun },
    { ...(db !== undefined ? { db } : {}), ...(signal ? { signal } : {}) },
  );
  if (!result.ok) {
    if (result.reason === 'check_off') {
      io.err(`${TAG} refused: ${RESCAN_SWITCH[parsed.check]} is off; set it to flag or quarantine first`);
      return 3;
    }
    io.err(`${TAG} rescan failed (${result.reason})`);
    return result.reason === 'invalid_tenant' || result.reason === 'invalid_check' ? 2 : 1;
  }
  const { report } = result;
  const scope = parsed.tenantKey ?? 'every tenant';
  io.out(`${TAG} rescan ${report.check} (${report.mode}) of ${scope}${report.dryRun ? ', dry run, nothing written' : ''}`);
  io.out(`${TAG} ${report.checked} documents read, ${report.skipped} skipped, ${report.affectedIds.length} affected, ${report.quarantined} quarantined, ${report.flagged} flagged, ${report.unavailable} not checked`);
  for (const id of report.affectedIds) io.out(`  ${id}`);
  if (report.artifactsFailed > 0) io.err(`${TAG} ${report.artifactsFailed} stored parse outputs were not rewritten`);
  if (report.unavailable > 0) io.err(`${TAG} ${report.unavailable} documents could not be checked; run the rescan again`);
  return report.unavailable > 0 || report.artifactsFailed > 0 ? 1 : 0;
}

/**
 * CLI entry. Exit codes: 0 done, 1 database or environment failure, 2 bad arguments, 3 refused by the run's gate (activation, rollback,
 * evidence). Prints run ids and counts only, never document text.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, signal?: AbortSignal, deps: { db?: RpcClient | null } & RebuildDeps = {}): Promise<number> {
  const parsed = parseRebuildArgs(argv);
  if (!parsed.ok) {
    io.err(`${TAG} ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  if (deps.db === undefined && !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    io.err(`${TAG} refused: set SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }
  if (parsed.command === 'rescan') return rescan(parsed, io, signal, deps.db);
  const run = await import('./run');
  const runDeps: RebuildDeps = { ...deps, ...(signal ? { signal } : {}) };
  try {
    switch (parsed.command) {
      case 'start': {
        const result = await run.startRebuild({ mechanism: parsed.mechanism, dryRun: parsed.dryRun, startedBy: 'cli' }, runDeps);
        printStart(result, io);
        return 0;
      }
      case 'status': {
        if (parsed.runId !== null) {
          const found = await run.getRebuildRun(parsed.runId, runDeps);
          if (!found) {
            io.err(`${TAG} run not found`);
            return 1;
          }
          io.out(`${TAG} ${runLine(found)}`);
          return 0;
        }
        const runs = await run.listRebuildRuns(runDeps);
        if (runs.length === 0) io.out(`${TAG} no rebuild runs`);
        for (const row of runs) io.out(`${TAG} ${runLine(row)}`);
        return 0;
      }
      case 'record-eval': {
        let report: unknown;
        try {
          report = JSON.parse(await readFile(parsed.report, 'utf8'));
        } catch {
          io.err(`${TAG} the report could not be read as JSON`);
          return 2;
        }
        const recorded = await run.recordRebuildEvidence(parsed.runId, report, runDeps);
        io.out(`${TAG} evidence recorded: ${recorded.passed ? 'passed' : 'failed'}`);
        return 0;
      }
      case 'activate': {
        const done = await run.activateRebuild(parsed.runId, 'cli', runDeps);
        io.out(`${TAG} activated: ${done.published.length} versions published, ${done.superseded} skipped as superseded`);
        return 0;
      }
      case 'rollback': {
        const done = await run.rollbackRebuild(parsed.runId, 'cli', runDeps);
        io.out(`${TAG} rolled back: ${done.restored.length} previous versions current again, ${done.superseded} skipped as superseded`);
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof run.RebuildRefused) {
      io.err(`${TAG} ${error.code}: ${error.reason}`);
      return 3;
    }
    if (error instanceof run.RebuildNotFound) {
      io.err(`${TAG} run not found`);
      return 1;
    }
    if (error instanceof run.RebuildInputError) {
      io.err(`${TAG} ${error.code}`);
      return 2;
    }
    if (error instanceof run.RebuildUnavailable) {
      io.err(`${TAG} ${error.rpc} failed (${error.code})`);
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
      console.error(`${TAG} failed`, error instanceof Error ? { error: error.name, message: error.message.slice(0, 200) } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
