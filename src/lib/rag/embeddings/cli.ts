import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { BindingActivationEvidenceSchema } from '@/lib/rag-eval/contracts.generated';

export type SettableStatus = 'available' | 'backfilling' | 'retired';

export type ParsedEmbeddingArgs =
  | { ok: true; command: 'status' }
  | { ok: true; command: 'activate'; profileId: string }
  | { ok: true; command: 'rollback' }
  | { ok: true; command: 'record-evidence'; profileId: string; evidencePath: string }
  | { ok: true; command: 'set-status'; profileId: string; status: SettableStatus }
  | { ok: true; command: 'bindings' }
  | { ok: true; command: 'bind'; docType: string; profileId: string; tenantKey: string | null }
  | { ok: true; command: 'bind-status'; bindingId: string; status: SettableStatus }
  | { ok: true; command: 'record-binding-evidence'; bindingId: string; evidencePath: string }
  | { ok: true; command: 'activate-binding'; bindingId: string }
  | { ok: true; command: 'rollback-binding'; docType: string; tenantKey: string | null }
  | { ok: true; command: 'deactivate-binding'; docType: string; tenantKey: string | null }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SETTABLE: readonly string[] = ['available', 'backfilling', 'retired'];
const DOC_TYPES: readonly string[] = BindingActivationEvidenceSchema.shape.doc_type.options;
const BINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const USAGE = [
  'usage: npm run rag:embedding -- status',
  '       npm run rag:embedding -- activate <profileId>',
  '       npm run rag:embedding -- rollback',
  '       npm run rag:embedding -- record-evidence <comparison.json> --target <profileId>',
  '       npm run rag:embedding -- set-status <profileId> available|backfilling|retired',
  '       npm run rag:embedding -- bindings',
  '       npm run rag:embedding -- bind <docType> <profileId> [--tenant <key>]',
  '       npm run rag:embedding -- bind-status <bindingId> available|backfilling|retired',
  '       npm run rag:embedding -- record-binding-evidence <comparison.json> --binding <bindingId>',
  '       npm run rag:embedding -- activate-binding <bindingId>',
  '       npm run rag:embedding -- rollback-binding <docType> [--tenant <key>]',
  '       npm run rag:embedding -- deactivate-binding <docType> [--tenant <key>]',
].join('\n');

type DocTypeAndTenant = { ok: true; docType: string; tenantKey: string | null } | { ok: false; error: string };

/** `<docType> [--tenant <key>]`: the tenant flag is the only option, and its key must be a tenant key of either deployment mode. */
function parseDocTypeAndTenant(command: string, args: string[]): DocTypeAndTenant {
  const [docType, ...options] = args;
  if (docType === undefined || docType.startsWith('--')) return { ok: false, error: `${command} needs a doc type` };
  if (!DOC_TYPES.includes(docType)) return { ok: false, error: `unknown doc type: ${docType}` };
  if (options.length === 0) return { ok: true, docType, tenantKey: null };
  if (options.length !== 2 || options[0] !== '--tenant') return { ok: false, error: `${command} takes only --tenant <key> after the doc type` };
  if (!TENANT_KEY.test(options[1] as string)) return { ok: false, error: '--tenant needs a tenant key (s:default, u:<uuid> or o:<uuid>)' };
  return { ok: true, docType, tenantKey: options[1] as string };
}

/** `set-status` never takes `active`: only the gate in `activate` moves the pointer. */
export function parseEmbeddingArgs(argv: string[]): ParsedEmbeddingArgs {
  const [command, ...rest] = argv;
  const profileArgument = (value: string | undefined): string | null => (value !== undefined && PROFILE_ID.test(value) ? value : null);
  switch (command) {
    case 'status':
      return rest.length === 0 ? { ok: true, command: 'status' } : { ok: false, error: 'status takes no arguments' };
    case 'rollback':
      return rest.length === 0 ? { ok: true, command: 'rollback' } : { ok: false, error: 'rollback takes no arguments' };
    case 'record-evidence': {
      const targetFlag = rest.indexOf('--target');
      const evidencePath = rest[0];
      const profileId = targetFlag >= 0 ? profileArgument(rest[targetFlag + 1]) : null;
      if (targetFlag < 0 || rest.length < 3 || profileId === null || !evidencePath) {
        return { ok: false, error: 'record-evidence needs <comparison.json> --target <profileId>' };
      }
      return { ok: true, command: 'record-evidence', profileId, evidencePath };
    }
    case 'activate': {
      const profileId = profileArgument(rest[0]);
      if (rest.length !== 1 || profileId === null) return { ok: false, error: 'activate needs one profile id' };
      return { ok: true, command: 'activate', profileId };
    }
    case 'set-status': {
      const profileId = profileArgument(rest[0]);
      if (rest.length !== 2 || profileId === null) return { ok: false, error: 'set-status needs a profile id and a status' };
      const status = rest[1] as string;
      if (status === 'active') return { ok: false, error: 'set-status never sets active: the pointer only moves through `activate <profileId>`' };
      if (!SETTABLE.includes(status)) return { ok: false, error: 'set-status needs one of available, backfilling or retired' };
      return { ok: true, command: 'set-status', profileId, status: status as SettableStatus };
    }
    case 'bindings':
      return rest.length === 0 ? { ok: true, command: 'bindings' } : { ok: false, error: 'bindings takes no arguments' };
    case 'bind': {
      const [docType, profile, ...options] = rest;
      if (docType === undefined || profile === undefined) return { ok: false, error: 'bind needs <docType> <profileId> [--tenant <key>]' };
      const scope = parseDocTypeAndTenant('bind', [docType, ...options]);
      if (!scope.ok) return scope;
      const profileId = profileArgument(profile);
      if (profileId === null) return { ok: false, error: 'bind needs a valid profile id' };
      return { ok: true, command: 'bind', docType: scope.docType, profileId, tenantKey: scope.tenantKey };
    }
    case 'bind-status': {
      const [bindingId, status] = rest;
      if (rest.length !== 2 || bindingId === undefined || !BINDING_ID.test(bindingId)) return { ok: false, error: 'bind-status needs a binding id and a status' };
      if (status === 'active') return { ok: false, error: 'bind-status never sets active: only activate-binding sets active, through the gate' };
      if (!SETTABLE.includes(status as string)) return { ok: false, error: 'bind-status needs one of available, backfilling or retired' };
      return { ok: true, command: 'bind-status', bindingId, status: status as SettableStatus };
    }
    case 'record-binding-evidence': {
      const flag = rest.indexOf('--binding');
      const evidencePath = rest[0];
      const bindingId = flag >= 0 ? rest[flag + 1] : undefined;
      if (flag !== 1 || rest.length !== 3 || !evidencePath || bindingId === undefined || !BINDING_ID.test(bindingId)) {
        return { ok: false, error: 'record-binding-evidence needs <comparison.json> --binding <bindingId>' };
      }
      return { ok: true, command: 'record-binding-evidence', bindingId, evidencePath };
    }
    case 'activate-binding': {
      const bindingId = rest[0];
      if (rest.length !== 1 || bindingId === undefined || !BINDING_ID.test(bindingId)) return { ok: false, error: 'activate-binding needs one binding id' };
      return { ok: true, command: 'activate-binding', bindingId };
    }
    case 'rollback-binding':
    case 'deactivate-binding': {
      const scope = parseDocTypeAndTenant(command, rest);
      if (!scope.ok) return scope;
      return { ok: true, command, docType: scope.docType, tenantKey: scope.tenantKey };
    }
    default:
      return { ok: false, error: command === undefined ? 'a command is required' : `unknown command: ${command}` };
  }
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

const SWITCH_OFF_WARNING =
  'RAG_EMBEDDING_PROFILES is off: queries and ingestion use the legacy profile whatever the pointer says, so a flip changes nothing until the switch is on.';

const DOMAIN_SWITCH_OFF_WARNING =
  'RAG_DOMAIN_EMBEDDINGS is off: ingestion and queries ignore bindings, so this binding changes nothing until the switch is on.';

/** The actor the gate records for a flip made at the command line: the operating system account, restricted to a safe alphabet. */
function cliActor(): string {
  let name = 'operator';
  try {
    name = os.userInfo().username;
  } catch {
    name = 'operator';
  }
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  return `cli:${safe || 'operator'}`;
}

function describeCompleteness(entry: import('./profile-ops').ProfileCompleteness | undefined): string {
  if (!entry || entry.state === 'unavailable') return 'unavailable';
  if (entry.state === 'legacy_column') return 'legacy column, counted by the gate at activation';
  return `${entry.percent.toFixed(1)}% (${entry.chunks - entry.missing} of ${entry.chunks} current ready chunks)`;
}

/**
 * The CLI body. Prints profile ids, statuses, counts and the gate's refusal words only: never a key and never stored text. Returns the exit
 * code: 0 done, 1 refused by the gate or the registry cannot be reached, 2 the arguments were wrong. The environment must already be loaded.
 */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, signal?: AbortSignal): Promise<number> {
  const parsed = parseEmbeddingArgs(argv);
  if (!parsed.ok) {
    io.err(`[Embedding] ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  const ops = await import('./profile-ops');
  const bindingOps = await import('./binding-ops');
  const { ProfileUnavailableError, isEmbeddingProfilesEnabled } = await import('./active-profile');
  const { isDomainEmbeddingsEnabled } = await import('./bindings');
  const scopeLabel = (tenantKey: string | null): string => tenantKey ?? 'deployment';

  const refused = (result: { reason: string; detail: string }): number => {
    io.err(`[Embedding] refused: ${result.reason}`);
    if (result.detail !== result.reason) io.err(`[Embedding] detail: ${result.detail}`);
    return 1;
  };
  const warnWhenSwitchOff = (): void => {
    if (!isEmbeddingProfilesEnabled()) io.out(`[Embedding] warning: ${SWITCH_OFF_WARNING}`);
  };

  try {
    if (parsed.command === 'status') {
      const status = await ops.getEmbeddingProfileStatus();
      const completeness = await ops.getEmbeddingProfileCompleteness(status.profiles, signal);
      io.out(`[Embedding] switch: ${status.switch}`);
      io.out(`[Embedding] active: ${status.active.id} (${status.active.provider} ${status.active.model}, ${status.active.dims} dims, ${status.active.storage})`);
      const pointer = status.profiles.find((profile) => profile.status === 'active');
      if (pointer && pointer.id !== status.active.id) io.out(`[Embedding] pointer: ${pointer.id}`);
      for (const profile of status.profiles) {
        io.out(
          `[Embedding] profile ${profile.id} status=${profile.status} dims=${profile.dims} storage=${profile.storage} completeness=${describeCompleteness(completeness[profile.id])} evidence=${profile.hasEvidence ? 'yes' : 'no'}`,
        );
      }
      if (status.switch === 'off') io.out(`[Embedding] warning: ${SWITCH_OFF_WARNING}`);
      io.out(`[Embedding] domain embeddings switch: ${isDomainEmbeddingsEnabled() ? 'on' : 'off'}`);
      try {
        for (const binding of await bindingOps.listBindings()) {
          if (binding.stale) {
            io.out(
              `[Embedding] warning: binding stale ${binding.id} ${binding.docType} (${scopeLabel(binding.tenantKey)}) → ${binding.profileId}: its evidence names ${binding.baselineGlobalProfile ?? 'no'} global profile, so queries skip it until it is re-proven`,
            );
          }
        }
      } catch (error) {
        if (!(error instanceof ProfileUnavailableError)) throw error;
        io.out('[Embedding] bindings: unavailable');
      }
      return 0;
    }

    if (parsed.command === 'bindings') {
      const entries = await bindingOps.listBindings();
      io.out(`[Embedding] domain embeddings switch: ${isDomainEmbeddingsEnabled() ? 'on' : 'off'}`);
      if (entries.length === 0) io.out('[Embedding] no bindings');
      for (const entry of entries) {
        io.out(
          `[Embedding] binding ${entry.id} doc_type=${entry.docType} tenant=${scopeLabel(entry.tenantKey)} profile=${entry.profileId} status=${entry.status} stale=${entry.stale ? 'yes' : 'no'} evidence=${entry.hasEvidence ? 'yes' : 'no'}`,
        );
      }
      return 0;
    }

    if (parsed.command === 'bind') {
      const result = await bindingOps.createBinding(parsed.docType, parsed.tenantKey, parsed.profileId, cliActor());
      if (!result.ok) return refused(result);
      io.out(
        `[Embedding] binding ${result.bindingId} ${parsed.docType} (${scopeLabel(parsed.tenantKey)}) → ${parsed.profileId} status=${result.status}${result.created ? '' : ' (already exists)'}`,
      );
      return 0;
    }

    if (parsed.command === 'bind-status') {
      const result = await bindingOps.setBindingStatus(parsed.bindingId, parsed.status, cliActor());
      if (!result.ok) return refused(result);
      io.out(`[Embedding] binding ${result.bindingId} is now ${result.status}`);
      return 0;
    }

    if (parsed.command === 'record-binding-evidence') {
      const { readFileSync } = await import('node:fs');
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(parsed.evidencePath, 'utf8')) as unknown;
      } catch {
        io.err('[Embedding] the evidence file cannot be read as JSON');
        return 2;
      }
      try {
        const result = await bindingOps.recordBindingEvidence(parsed.bindingId, raw, cliActor());
        if (!result.ok) return refused(result);
        io.out(
          `[Embedding] recorded binding evidence on ${result.bindingId} (gate_passed=${result.evidence.gate_passed}, real items ${result.evidence.doc_type_slice.real_n} of ${result.evidence.doc_type_slice.n})`,
        );
        return 0;
      } catch (error) {
        if (!(error instanceof bindingOps.BindingEvidenceInvalidError)) throw error;
        io.err(`[Embedding] ${error.message}`);
        return 2;
      }
    }

    if (parsed.command === 'activate-binding') {
      const result = await bindingOps.activateBinding(parsed.bindingId, cliActor());
      if (!result.ok) return refused(result);
      io.out(
        `[Embedding] activated binding ${result.binding.docType} (${scopeLabel(result.binding.tenantKey)}) → ${result.binding.profileId} (previous: ${result.previous ?? 'none'})`,
      );
      if (!isDomainEmbeddingsEnabled()) io.out(`[Embedding] warning: ${DOMAIN_SWITCH_OFF_WARNING}`);
      return 0;
    }

    if (parsed.command === 'rollback-binding') {
      const result = await bindingOps.rollbackBinding(parsed.docType, parsed.tenantKey, cliActor());
      if (!result.ok) return refused(result);
      io.out(
        `[Embedding] rolled back binding ${parsed.docType} (${scopeLabel(parsed.tenantKey)}): restored ${result.restored.profileId}, rolled away from binding ${result.rolledBack}`,
      );
      return 0;
    }

    if (parsed.command === 'deactivate-binding') {
      const result = await bindingOps.deactivateBinding(parsed.docType, parsed.tenantKey, cliActor());
      if (!result.ok) return refused(result);
      io.out(`[Embedding] deactivated binding ${parsed.docType} (${scopeLabel(parsed.tenantKey)}): binding ${result.deactivated} is now available, the global profile alone serves it`);
      return 0;
    }

    if (parsed.command === 'record-evidence') {
      const { readFileSync } = await import('node:fs');
      const { ActivationEvidenceSchema, EmbeddingProfileComparisonSchema } = await import('@/lib/rag-eval/contracts.generated');
      const raw = JSON.parse(readFileSync(parsed.evidencePath, 'utf8')) as unknown;
      const comparison = EmbeddingProfileComparisonSchema.safeParse(raw);
      const evidenceInput = comparison.success
        ? {
            target_profile: parsed.profileId,
            baseline_profile: comparison.data.active_profile,
            gate_passed: comparison.data.gate_passed,
            pre_migration: { passed: comparison.data.pre_migration.passed, n: comparison.data.pre_migration.n },
            backfill_run_id: comparison.data.backfill_run_id,
            recorded_at: new Date().toISOString(),
          }
        : raw;
      const evidence = ActivationEvidenceSchema.safeParse(evidenceInput);
      if (!evidence.success) {
        io.err(`[Embedding] comparison or evidence JSON is invalid: ${evidence.error.issues.map((i) => i.message).join('; ')}`);
        return 2;
      }
      if (evidence.data.target_profile !== parsed.profileId) {
        io.err('[Embedding] --target must match evidence.target_profile');
        return 2;
      }
      const result = await ops.recordEmbeddingEvalEvidence(parsed.profileId, evidence.data, cliActor());
      if (!result.ok) return refused(result);
      io.out(`[Embedding] recorded eval evidence on ${result.profileId}`);
      return 0;
    }

    if (parsed.command === 'activate') {
      const result = await ops.activateEmbeddingProfile(parsed.profileId, cliActor());
      if (!result.ok) return refused(result);
      io.out(`[Embedding] activated ${result.activated} (previous: ${result.previous ?? 'none'})`);
      warnWhenSwitchOff();
      return 0;
    }

    if (parsed.command === 'rollback') {
      const result = await ops.rollbackEmbeddingProfile(cliActor());
      if (!result.ok) return refused(result);
      io.out(`[Embedding] rolled back: restored ${result.restored}, rolled away from ${result.rolledBack}`);
      warnWhenSwitchOff();
      return 0;
    }

    const result = await ops.setEmbeddingProfileStatus(parsed.profileId, parsed.status, cliActor());
    if (!result.ok) return refused(result);
    io.out(`[Embedding] ${result.profileId} is now ${result.status}`);
    return 0;
  } catch (error) {
    if (error instanceof ProfileUnavailableError) {
      io.err(error.message);
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
      console.error('[Embedding] failed', error instanceof Error ? { error: error.name, message: error.message.slice(0, 200) } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
