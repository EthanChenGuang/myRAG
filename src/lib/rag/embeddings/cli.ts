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
  | { ok: true; command: 'ft-consent-grant'; tenantKey: string; evidenceRef: string; scope: FinetuneConsentScope }
  | { ok: true; command: 'ft-consent-revoke'; tenantKey: string; pruneRoot: string | null }
  | { ok: true; command: 'ft-consent-list' }
  | { ok: true; command: 'ft-models-register'; cardPath: string }
  | { ok: true; command: 'ft-models-list' }
  | { ok: true; command: 'ft-models-retire'; versionId: string }
  | { ok: true; command: 'ft-bind'; slot: FinetuneSlotId; versionId: string }
  | { ok: true; command: 'ft-clear'; slot: FinetuneSlotId; batch: number }
  | { ok: true; command: 'ft-release-rollback' }
  | { ok: true; command: 'ft-check'; slot: FinetuneSlotId }
  | { ok: false; error: string };

export type FinetuneConsentScope = 'private' | 'deployment';
export type FinetuneSlotId = 'ft-a-1024' | 'ft-b-1024';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SETTABLE: readonly string[] = ['available', 'backfilling', 'retired'];
const DOC_TYPES: readonly string[] = BindingActivationEvidenceSchema.shape.doc_type.options;
const BINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const VERSION_ID = /^ft-[a-z0-9][a-z0-9.-]{2,58}$/;
const FT_SLOTS: readonly string[] = ['ft-a-1024', 'ft-b-1024'];
const FT_CLEAR_DEFAULT_BATCH = 1000;

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
  '       npm run rag:embedding -- ft-consent grant <tenantKey> --ref <evidenceRef> [--scope private|deployment]',
  '       npm run rag:embedding -- ft-consent revoke <tenantKey> [--prune-root <bundles dir>]',
  '       npm run rag:embedding -- ft-consent list',
  '       npm run rag:embedding -- ft-models register <card.json>',
  '       npm run rag:embedding -- ft-models list',
  '       npm run rag:embedding -- ft-models retire <versionId>',
  '       npm run rag:embedding -- ft-bind ft-a-1024|ft-b-1024 <versionId>',
  '       npm run rag:embedding -- ft-clear ft-a-1024|ft-b-1024 [--batch <1..10000>]',
  '       npm run rag:embedding -- ft-release-rollback --ack drop-rollback',
  '       npm run rag:embedding -- ft-check ft-a-1024|ft-b-1024',
].join('\n');

type DocTypeAndTenant = { ok: true; docType: string; tenantKey: string | null } | { ok: false; error: string };

/** `<docType> [--tenant <key>]`: the tenant flag is the only option, and its key must be a tenant key of either deployment mode. */
function parseDocTypeAndTenant(command: string, args: string[]): DocTypeAndTenant {
  const [docType, ...options] = args;
  if (!docType || docType.startsWith('--')) return { ok: false, error: `${command} needs a doc type` };
  if (!DOC_TYPES.includes(docType)) return { ok: false, error: `unknown doc type: ${docType}` };
  if (options.length === 0) return { ok: true, docType, tenantKey: null };
  if (options.length !== 2 || options[0] !== '--tenant') return { ok: false, error: `${command} takes only --tenant <key> after the doc type` };
  if (!TENANT_KEY.test(options[1] as string)) return { ok: false, error: '--tenant needs a tenant key (s:default, u:<uuid> or o:<uuid>)' };
  return { ok: true, docType, tenantKey: options[1] as string };
}

/** `--flag value` pairs only; each flag at most once and only from `allowed`. */
function parseFlags(command: string, args: string[], allowed: readonly string[]): { ok: true; values: Map<string, string> } | { ok: false; error: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] as string;
    const value = args[index + 1];
    if (!allowed.includes(flag)) return { ok: false, error: `${command} does not take ${flag}` };
    if (values.has(flag)) return { ok: false, error: `${command} takes ${flag} once` };
    if (value === undefined || value === '' || value.startsWith('--')) return { ok: false, error: `${flag} needs a value` };
    values.set(flag, value);
  }
  return { ok: true, values };
}

function parseFinetuneConsent(rest: string[]): ParsedEmbeddingArgs {
  const [action, tenantKey, ...options] = rest;
  if (action === 'list') return rest.length === 1 ? { ok: true, command: 'ft-consent-list' } : { ok: false, error: 'ft-consent list takes no arguments' };
  if (action !== 'grant' && action !== 'revoke') return { ok: false, error: 'ft-consent needs grant, revoke or list' };
  if (tenantKey === undefined || !TENANT_KEY.test(tenantKey)) return { ok: false, error: `ft-consent ${action} needs a tenant key (s:default, u:<uuid> or o:<uuid>)` };
  if (action === 'revoke') {
    const flags = parseFlags('ft-consent revoke', options, ['--prune-root']);
    if (!flags.ok) return flags;
    return { ok: true, command: 'ft-consent-revoke', tenantKey, pruneRoot: flags.values.get('--prune-root') ?? null };
  }
  const flags = parseFlags('ft-consent grant', options, ['--ref', '--scope']);
  if (!flags.ok) return flags;
  const evidenceRef = flags.values.get('--ref');
  if (!evidenceRef) return { ok: false, error: 'ft-consent grant needs --ref <evidenceRef> (a ticket or signed-agreement reference)' };
  const scope = flags.values.get('--scope') ?? 'private';
  if (scope !== 'private' && scope !== 'deployment') return { ok: false, error: '--scope needs private or deployment (revoke sets none)' };
  return { ok: true, command: 'ft-consent-grant', tenantKey, evidenceRef, scope };
}

function parseFinetuneModels(rest: string[]): ParsedEmbeddingArgs {
  const [action, argument] = rest;
  if (action === 'list') return rest.length === 1 ? { ok: true, command: 'ft-models-list' } : { ok: false, error: 'ft-models list takes no arguments' };
  if (action === 'register') {
    if (rest.length !== 2 || !argument || argument.startsWith('--')) return { ok: false, error: 'ft-models register needs one <card.json>' };
    return { ok: true, command: 'ft-models-register', cardPath: argument };
  }
  if (action === 'retire') {
    if (rest.length !== 2 || argument === undefined || !VERSION_ID.test(argument)) return { ok: false, error: 'ft-models retire needs one model version id (ft-...)' };
    return { ok: true, command: 'ft-models-retire', versionId: argument };
  }
  return { ok: false, error: 'ft-models needs register, list or retire' };
}

export type FinetuneParsedArgs = Extract<ParsedEmbeddingArgs, { ok: true; command: `ft-${string}` }>;

export function isFinetuneCommand(parsed: ParsedEmbeddingArgs): parsed is FinetuneParsedArgs {
  return parsed.ok && parsed.command.startsWith('ft-');
}

const slotArgument = (value: string | undefined): FinetuneSlotId | null => (value !== undefined && FT_SLOTS.includes(value) ? (value as FinetuneSlotId) : null);

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
      if (!docType || !profile) return { ok: false, error: 'bind needs <docType> <profileId> [--tenant <key>]' };
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
    case 'ft-consent':
      return parseFinetuneConsent(rest);
    case 'ft-models':
      return parseFinetuneModels(rest);
    case 'ft-bind': {
      const slot = slotArgument(rest[0]);
      const versionId = rest[1];
      if (slot === null) return { ok: false, error: 'ft-bind needs a slot: ft-a-1024 or ft-b-1024' };
      if (rest.length !== 2 || versionId === undefined || !VERSION_ID.test(versionId)) return { ok: false, error: 'ft-bind needs <slot> <versionId>' };
      return { ok: true, command: 'ft-bind', slot, versionId };
    }
    case 'ft-clear': {
      const slot = slotArgument(rest[0]);
      if (slot === null) return { ok: false, error: 'ft-clear needs a slot: ft-a-1024 or ft-b-1024' };
      const flags = parseFlags('ft-clear', rest.slice(1), ['--batch']);
      if (!flags.ok) return flags;
      const raw = flags.values.get('--batch');
      const batch = raw === undefined ? FT_CLEAR_DEFAULT_BATCH : /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isInteger(batch) || batch < 1 || batch > 10000) return { ok: false, error: '--batch needs a whole number from 1 to 10000' };
      return { ok: true, command: 'ft-clear', slot, batch };
    }
    case 'ft-release-rollback':
      if (rest.length !== 2 || rest[0] !== '--ack' || rest[1] !== 'drop-rollback') {
        return { ok: false, error: 'ft-release-rollback needs --ack drop-rollback (the active profile loses its rollback target)' };
      }
      return { ok: true, command: 'ft-release-rollback' };
    case 'ft-check': {
      const slot = slotArgument(rest[0]);
      if (rest.length !== 1 || slot === null) return { ok: false, error: 'ft-check needs one slot: ft-a-1024 or ft-b-1024' };
      return { ok: true, command: 'ft-check', slot };
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

export interface EmbeddingCliDeps {
  /** The RAG_FINETUNE switch; defaults to the environment. */
  finetuneEnabled?: () => boolean;
  /** Runs an external command (the retention prune) and resolves its exit code. */
  runCommand?: (argv: string[]) => Promise<number>;
}

async function spawnCommand(argv: string[]): Promise<number> {
  const { spawn } = await import('node:child_process');
  const [command, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawn(command as string, args, { stdio: 'inherit', cwd: process.cwd() });
    child.once('error', () => resolve(127));
    child.once('close', (code) => resolve(code ?? 1));
  });
}

const FT_LISTS: readonly string[] = ['ft-consent-list', 'ft-models-list'];

/**
 * The ft-* commands (06.1-15). Every command except the two lists refuses while RAG_FINETUNE is off, before any request. Prints ids,
 * statuses, counts, refusal reasons and the commands to run next: never a key, a probe vector or stored text.
 */
async function runFinetuneCommand(parsed: FinetuneParsedArgs, io: CliIo, deps: EmbeddingCliDeps): Promise<number> {
  const ops = await import('./finetune-ops');
  const { ProfileUnavailableError } = await import('./active-profile');
  const enabled = deps.finetuneEnabled ?? ops.isFinetuneEnabled;
  if (!FT_LISTS.includes(parsed.command) && !enabled()) {
    io.err(`[Embedding] refused: ${ops.FINETUNE_OFF_MESSAGE}`);
    return 1;
  }
  const refused = (result: { reason: string; detail: string }): number => {
    io.err(`[Embedding] refused: ${result.reason}`);
    if (result.detail !== result.reason) io.err(`[Embedding] detail: ${result.detail.slice(0, 300)}`);
    return 1;
  };
  try {
    switch (parsed.command) {
      case 'ft-consent-list': {
        const rows = await ops.listConsent();
        if (rows.length === 0) io.out('[Embedding] no fine-tune consent recorded (no row means none)');
        for (const row of rows) {
          io.out(
            `[Embedding] consent ${row.tenantKey} scope=${row.scope} evidence_ref=${row.evidenceRef ?? '-'} granted_at=${row.grantedAt ?? '-'} revoked_at=${row.revokedAt ?? '-'}`,
          );
        }
        return 0;
      }
      case 'ft-consent-grant': {
        const result = await ops.grantConsent(parsed.tenantKey, parsed.scope, parsed.evidenceRef, cliActor());
        if (!result.ok) return refused(result);
        io.out(`[Embedding] consent ${result.tenantKey} is now ${result.scope}`);
        if (result.taintedVersions.length > 0) io.out(`[Embedding] tainted (deployment-scope versions no longer covered): ${result.taintedVersions.join(', ')}`);
        return 0;
      }
      case 'ft-consent-revoke': {
        const result = await ops.revokeConsent(parsed.tenantKey, cliActor());
        if (!result.ok) return refused(result);
        io.out(`[Embedding] consent ${result.tenantKey} revoked (scope none)`);
        io.out(`[Embedding] tainted: ${result.taintedVersions.length > 0 ? result.taintedVersions.join(', ') : 'none'}`);
        for (const slot of result.slots) {
          if (slot.active) {
            io.out(`[Embedding] warning: ${slot.versionId} is bound to ${slot.slot}, the ACTIVE profile: it keeps serving until you roll back`);
            io.out('[Embedding] next: npm run rag:embedding -- rollback');
          } else {
            io.out(`[Embedding] ${slot.versionId} is bound to ${slot.slot}; its evidence was dropped, so it cannot be activated`);
            if (slot.rollbackTarget) io.out('[Embedding] next: npm run rag:embedding -- ft-release-rollback --ack drop-rollback');
          }
          io.out(`[Embedding] next: npm run rag:embedding -- ft-clear ${slot.slot}`);
        }
        for (const uri of result.artifactUris) io.out(`[Embedding] next: delete the weights at ${uri} (an operator step outside this command)`);
        const prune = ops.pruneCommand(parsed.tenantKey, parsed.pruneRoot);
        io.out(`[Embedding] retention: ${parsed.pruneRoot ? prune.join(' ') : `${prune.join(' ')} [--root <bundles dir>]`}`);
        if (!parsed.pruneRoot) return 0;
        const code = await (deps.runCommand ?? spawnCommand)(prune);
        io.out(`[Embedding] prune exited with ${code}`);
        return code === 0 ? 0 : 1;
      }
      case 'ft-models-list': {
        const models = await ops.listModels();
        if (models.length === 0) io.out('[Embedding] no fine-tuned model versions registered');
        for (const model of models) {
          io.out(
            `[Embedding] model ${model.id} base=${model.baseModel} scope=${model.scope} tenants=${model.tenantKeys.join(',')} status=${model.status} slot=${model.boundSlot ?? '-'}`,
          );
        }
        return 0;
      }
      case 'ft-models-register': {
        const { readFileSync } = await import('node:fs');
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(parsed.cardPath, 'utf8')) as unknown;
        } catch {
          io.err('[Embedding] the model card cannot be read as JSON');
          return 2;
        }
        try {
          const result = await ops.registerModel(raw, cliActor());
          if (!result.ok) return refused(result);
          io.out(`[Embedding] registered ${result.versionId} (status ${result.status})`);
          return 0;
        } catch (error) {
          if (!(error instanceof ops.FinetuneCardInvalidError)) throw error;
          io.err(`[Embedding] refused: ${error.message}`);
          return 2;
        }
      }
      case 'ft-models-retire': {
        const result = await ops.retireModel(parsed.versionId, cliActor());
        if (!result.ok) return refused(result);
        io.out(`[Embedding] ${result.versionId} is now ${result.status}`);
        return 0;
      }
      case 'ft-bind': {
        const result = await ops.bindSlot(parsed.slot, parsed.versionId, cliActor());
        if (!result.ok) return refused(result);
        io.out(`[Embedding] bound ${result.version.id} to ${result.slot} (no vector written; the slot is unscoped and uses the global EMB-05 path)`);
        for (const line of ops.bindGuidance(result.slot, result.version)) io.out(`[Embedding] ${line}`);
        return 0;
      }
      case 'ft-clear': {
        const result = await ops.clearSlot(parsed.slot, cliActor(), parsed.batch);
        if (!result.ok) return refused(result);
        io.out(`[Embedding] cleared ${result.slot}: ${result.deleted} vectors deleted in ${result.batches} batches; the slot is unbound`);
        return 0;
      }
      case 'ft-release-rollback': {
        const result = await ops.releaseRollback(cliActor(), 'drop-rollback');
        if (!result.ok) return refused(result);
        io.out(
          result.droppedPrevious
            ? `[Embedding] active profile ${result.activeProfile} no longer rolls back to ${result.droppedPrevious}; that profile is free`
            : `[Embedding] active profile ${result.activeProfile} has no rollback target; nothing changed`,
        );
        return 0;
      }
      case 'ft-check': {
        const { checkFinetuneProbe } = await import('./finetune-slot');
        const result = await checkFinetuneProbe(parsed.slot === 'ft-a-1024' ? 'a' : 'b');
        const cosine = result.minCosine === null ? 'n/a' : result.minCosine.toFixed(6);
        if (result.ok) {
          io.out(`[Embedding] ${parsed.slot} probe ok minCosine=${cosine}: the endpoint serves the registered weights and prompts`);
          return 0;
        }
        io.err(`[Embedding] ${parsed.slot} probe failed: ${result.reason} minCosine=${cosine}; do not re-embed or activate this slot`);
        return 1;
      }
    }
  } catch (error) {
    if (error instanceof ProfileUnavailableError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
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
export async function main(
  argv: string[] = process.argv.slice(2),
  io: CliIo = consoleIo,
  signal?: AbortSignal,
  deps: EmbeddingCliDeps = {},
): Promise<number> {
  const parsed = parseEmbeddingArgs(argv);
  if (!parsed.ok) {
    io.err(`[Embedding] ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  if (isFinetuneCommand(parsed)) return runFinetuneCommand(parsed, io, deps);
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
