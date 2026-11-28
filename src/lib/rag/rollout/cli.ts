import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { rpcRows, type RpcClient } from '@/lib/rag/backend/supabase-rpc';

/** `npm run rag:rollout` (plan 07-47, LANG-11): start, list, include, exclude and rollback per-tenant rollouts. Ids, keys and codes only. */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface RolloutCliDeps {
  /** The service-role client; default: built from NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. */
  rpc?: RpcClient;
}

const KINDS = ['embedding_profile', 'chunking_profile', 'rebuild_run'] as const;
type Kind = (typeof KINDS)[number];
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ParsedRolloutArgs =
  | { ok: true; command: 'start'; kind: Kind; candidate: string[]; tenants: string[] | null; share: number | null; actor: string | null }
  | { ok: true; command: 'include' | 'exclude'; rolloutId: string; tenant: string; actor: string | null }
  | { ok: true; command: 'rollback'; rolloutId: string; actor: string | null }
  | { ok: true; command: 'list' }
  | { ok: false; error: string };

export const USAGE = [
  'usage: npm run rag:rollout -- start --kind embedding_profile|chunking_profile|rebuild_run --candidate <id>[,<id>] (--tenants <keys> | --share <0-100>) [--actor <uuid>]',
  '       npm run rag:rollout -- include|exclude <rollout_id> --tenant <key> [--actor <uuid>]',
  '       npm run rag:rollout -- rollback <rollout_id> [--actor <uuid>]',
  '       npm run rag:rollout -- list',
].join('\n');

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

function flags(args: string[]): Map<string, string> | string {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) return `unexpected argument: ${String(name).slice(0, 40)}`;
    if (out.has(name)) return `repeated flag: ${name}`;
    out.set(name, value);
  }
  return out;
}

function actorOf(values: Map<string, string>): string | null | false {
  const actor = values.get('--actor');
  if (actor === undefined) return null;
  return UUID.test(actor) ? actor : false;
}

export function parseRolloutArgs(argv: string[]): ParsedRolloutArgs {
  const [command, ...rest] = argv;
  if (command === 'list') return rest.length === 0 ? { ok: true, command } : { ok: false, error: 'list takes no arguments' };
  if (command === 'start') {
    const values = flags(rest);
    if (typeof values === 'string') return { ok: false, error: values };
    for (const name of values.keys()) {
      if (!['--kind', '--candidate', '--tenants', '--share', '--actor'].includes(name)) return { ok: false, error: `unknown flag: ${name.slice(0, 40)}` };
    }
    const kind = values.get('--kind');
    if (!kind || !(KINDS as readonly string[]).includes(kind)) return { ok: false, error: 'start needs --kind embedding_profile|chunking_profile|rebuild_run' };
    const candidate = (values.get('--candidate') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
    if (candidate.length === 0 || !candidate.every((entry) => REF.test(entry))) return { ok: false, error: 'start needs --candidate <id>' };
    if (kind !== 'chunking_profile' && candidate.length !== 1) return { ok: false, error: `${kind} takes one --candidate` };
    if (kind === 'rebuild_run' && !UUID.test(candidate[0]!)) return { ok: false, error: 'rebuild_run takes a run uuid' };
    const tenantsRaw = values.get('--tenants');
    const shareRaw = values.get('--share');
    if ((tenantsRaw === undefined) === (shareRaw === undefined)) return { ok: false, error: 'start needs exactly one of --tenants or --share' };
    let tenants: string[] | null = null;
    let share: number | null = null;
    if (tenantsRaw !== undefined) {
      tenants = tenantsRaw.split(',').map((entry) => entry.trim()).filter(Boolean);
      if (tenants.length === 0 || !tenants.every((key) => TENANT_KEY.test(key))) return { ok: false, error: 'malformed tenant key' };
    } else {
      share = Number(shareRaw);
      if (!Number.isInteger(share) || share < 0 || share > 100) return { ok: false, error: '--share takes an integer 0-100' };
    }
    const actor = actorOf(values);
    if (actor === false) return { ok: false, error: '--actor takes a uuid' };
    return { ok: true, command, kind: kind as Kind, candidate, tenants, share, actor };
  }
  if (command === 'include' || command === 'exclude' || command === 'rollback') {
    const [rolloutId, ...tail] = rest;
    if (!rolloutId || !UUID.test(rolloutId)) return { ok: false, error: `${command} needs a rollout id` };
    const values = flags(tail);
    if (typeof values === 'string') return { ok: false, error: values };
    const allowed = command === 'rollback' ? ['--actor'] : ['--tenant', '--actor'];
    for (const name of values.keys()) if (!allowed.includes(name)) return { ok: false, error: `unknown flag: ${name.slice(0, 40)}` };
    const actor = actorOf(values);
    if (actor === false) return { ok: false, error: '--actor takes a uuid' };
    if (command === 'rollback') return { ok: true, command, rolloutId, actor };
    const tenant = values.get('--tenant');
    if (!tenant || !TENANT_KEY.test(tenant)) return { ok: false, error: `${command} needs --tenant <key>` };
    return { ok: true, command, rolloutId, tenant, actor };
  }
  return { ok: false, error: 'unknown command' };
}

async function adminFromEnv(): Promise<RpcClient | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as RpcClient;
}

/** The refusal code of a failed call: `rollout_refused: <code>` gives <code>, anything else a fixed code. */
export function refusalCode(message: string): string {
  const match = /rollout_refused: ([a-z_]+)/.exec(message) ?? /(rollout_failed): /.exec(message);
  if (match) return match[1]!;
  if (/tenant key/.test(message)) return 'bad_tenant_key';
  return 'rpc_failed';
}

class RolloutRpcError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function call(rpc: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await rpc.rpc(fn, args).abortSignal(new AbortController().signal);
  if (response.error) throw new RolloutRpcError(refusalCode(response.error.message ?? ''));
  const rows = rpcRows(response.data);
  // PostgREST answers a scalar function with the bare value; a SELECT over it yields one column named after the function.
  if (rows.length === 1 && rows[0] !== null && typeof rows[0] === 'object' && fn in (rows[0] as Record<string, unknown>)) {
    return (rows[0] as Record<string, unknown>)[fn];
  }
  return response.data;
}

function candidateRef(kind: Kind, candidate: string[]): Record<string, unknown> {
  if (kind === 'embedding_profile') return { embedding_profile_id: candidate[0] };
  if (kind === 'chunking_profile') return { chunking_profile_ids: candidate };
  return { rebuild_run_id: candidate[0] };
}

function refString(ref: unknown): string {
  if (ref === null || typeof ref !== 'object') return '-';
  const value = Object.values(ref as Record<string, unknown>)[0];
  return Array.isArray(value) ? value.join(',') : String(value ?? '-');
}

export async function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, deps: RolloutCliDeps = {}): Promise<number> {
  const parsed = parseRolloutArgs(argv);
  if (!parsed.ok) {
    io.err(`[RAG Rollout] ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  const rpc = deps.rpc ?? (await adminFromEnv());
  if (!rpc) {
    io.err('[RAG Rollout] NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    return 3;
  }
  try {
    switch (parsed.command) {
      case 'start': {
        const id = await call(rpc, 'rag_rollout_start', {
          p_kind: parsed.kind,
          p_candidate_ref: candidateRef(parsed.kind, parsed.candidate),
          p_mode: parsed.share === null ? 'tenants' : 'share',
          p_share_percent: parsed.share,
          p_tenants: parsed.tenants,
          p_actor: parsed.actor,
        });
        io.out(`[RAG Rollout] started ${String(id)} kind=${parsed.kind} ${parsed.share === null ? `tenants=${parsed.tenants!.length}` : `share=${parsed.share}`}`);
        return 0;
      }
      case 'include':
      case 'exclude': {
        await call(rpc, 'rag_rollout_set_tenant', {
          p_rollout_id: parsed.rolloutId,
          p_tenant_key: parsed.tenant,
          p_membership: parsed.command,
          p_actor: parsed.actor,
        });
        io.out(`[RAG Rollout] ${parsed.rolloutId} ${parsed.command} ${parsed.tenant}`);
        return 0;
      }
      case 'rollback': {
        await call(rpc, 'rag_rollout_rollback', { p_rollout_id: parsed.rolloutId, p_actor: parsed.actor });
        io.out(`[RAG Rollout] ${parsed.rolloutId} rolled_back`);
        return 0;
      }
      case 'list': {
        const rows = rpcRows(await call(rpc, 'rag_rollout_active', {})) as Array<Record<string, unknown>>;
        if (rows.length === 0) io.out('[RAG Rollout] no active rollout');
        for (const row of rows) {
          const included = Array.isArray(row.included_tenants) ? row.included_tenants.length : 0;
          const excluded = Array.isArray(row.excluded_tenants) ? row.excluded_tenants.length : 0;
          const mode = row.mode === 'share' ? `share=${String(row.share_percent)}` : 'tenants';
          io.out(`${String(row.id)} kind=${String(row.kind)} candidate=${refString(row.candidate_ref)} incumbent=${refString(row.incumbent_ref)} ${mode} included=${included} excluded=${excluded}`);
        }
        return 0;
      }
    }
  } catch (error) {
    io.err(`[RAG Rollout] refused: ${error instanceof RolloutRpcError ? error.code : 'rpc_failed'}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  main(process.argv.slice(2), consoleIo).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error('[RAG Rollout] failed', { error: error instanceof Error ? error.name : 'unknown' });
      process.exit(1);
    },
  );
}
