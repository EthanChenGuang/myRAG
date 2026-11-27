import type { RpcClient, RpcResponse } from '../backend/supabase-rpc';
import { loadRagConfig, type AccessGroupsMode } from '../config';
import { getRagDeps } from '../deps';
import { accessReadyForResolve } from './access-startup';
import { ACCESS_ADMIN_HASH, assertAccessScope, hashAccessKeys, mintAccessScope, type AccessScope } from './access-brand';
import { assertTenantScope, scopeKey, withAccess, type TenantScope } from './scope';

export {
  ACCESS_ADMIN_HASH,
  assertAccessScope,
  hashAccessKeys,
  isAccessScope,
  mintAccessScope,
  type AccessScope,
  type AccessScopeMode,
} from './access-brand';

export { accessRpcArgs, accessTableFilter, sameAccessFilter, type ScopeAccessFilter } from './access-filter';
import type { ScopeAccessFilter } from './access-filter';

/** A scope that was never resolved for access while RAG_DOC_ACCESS_GROUPS is on: retrieval fails closed (D-09, D-10). */
export class AccessScopeMissingError extends Error {
  constructor() {
    super('[RAG Access] scope not resolved for access');
    this.name = 'AccessScopeMissingError';
  }
}

function accessGroupsOn(): boolean {
  return loadRagConfig(getRagDeps().ragEnv()).accessGroups === 'on';
}

/** True while RAG_DOC_ACCESS_GROUPS is on; read paths outside retrieval use it to skip access work while the switch is off. */
export function accessGroupsEnabled(): boolean {
  return accessGroupsOn();
}

/** A-14 seam 1: the scope's access filter; an unattached scope is off while the switch is off and throws while it is on. */
export function scopeAccessFilter(scope: TenantScope): ScopeAccessFilter {
  assertTenantScope(scope);
  const access = scope.access;
  if (access === undefined) {
    if (accessGroupsOn()) throw new AccessScopeMissingError();
    return { mode: 'off' };
  }
  assertAccessScope(access);
  if (access.mode === 'off') return { mode: 'off' };
  if (access.mode === 'admin_all') return { mode: 'admin_all' };
  return { mode: 'keys', keys: access.keys, setHash: access.setHash };
}

/** D-06, D-07: who is asking, always established by the server (session, signed token, embed configuration, eval admission). */
export type AccessIdentity =
  | { kind: 'user'; userId: string }
  | { kind: 'anonymous' }
  | { kind: 'embed'; groupKey: string }
  | { kind: 'eval'; userId: string | null };

export type AccessScopeRefusalReason =
  | 'access_not_ready'
  | 'access_unavailable'
  | 'access_aborted'
  | 'access_lookup_failed'
  | 'access_identity_invalid';

export type ResolveAccessScopeResult =
  | { ok: true; scope: TenantScope }
  | { ok: false; status: 503; reason: AccessScopeRefusalReason };

export interface ResolveAccessScopeInput {
  scope: TenantScope;
  identity: AccessIdentity;
  signal: AbortSignal;
  /** Injected for tests; defaults to the service-role client. Null means no client and is a refusal. */
  admin?: RpcClient | null;
  config?: { accessGroups: AccessGroupsMode };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let offAccess: AccessScope | null = null;
const timings = new WeakMap<AccessScope, number>();
const loggedOnce = new Set<string>();

function logOnce(key: string, message: string, data?: Record<string, unknown>): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  if (data) console.warn(`[RAG Access] ${message}`, data);
  else console.warn(`[RAG Access] ${message}`);
}

export function resetAccessScopeLogForTests(): void {
  loggedOnce.clear();
}

function refuse(reason: AccessScopeRefusalReason): ResolveAccessScopeResult {
  console.warn('[RAG Access] access scope refused', { reason });
  return { ok: false, status: 503, reason };
}

function rpcCall(admin: RpcClient, fn: string, args: Record<string, unknown>, signal: AbortSignal): PromiseLike<RpcResponse> {
  return admin.rpc(fn, args).abortSignal(signal);
}

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  return value as string[];
}

class LookupInvalid extends Error {}

function mintKeys(keys: string[], effective: string[]): AccessScope {
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  const kept = [...new Set(['all', ...effective.map((key) => key.toLowerCase()).filter((key) => keySet.has(key))])];
  return mintAccessScope('keys', keys, { setHash: hashAccessKeys(kept) });
}

async function resolveUser(admin: RpcClient, scope: TenantScope, userId: string, signal: AbortSignal): Promise<AccessScope> {
  const { data, error } = await rpcCall(admin, 'rag_resolve_access_scope', { p_tenant_key: scopeKey(scope), p_user_id: userId }, signal);
  signal.throwIfAborted();
  if (error) throw new LookupInvalid();
  const row = firstRow(data);
  if (!row || typeof row.is_admin !== 'boolean') throw new LookupInvalid();
  if (row.is_admin) return mintAccessScope('admin_all', [], { setHash: ACCESS_ADMIN_HASH });
  const groupIds = stringArray(row.group_ids ?? []);
  const effective = stringArray(row.effective_keys ?? []);
  if (!groupIds || !effective || !groupIds.every((id) => UUID_RE.test(id.toLowerCase()))) throw new LookupInvalid();
  const keys = ['all', `u:${userId}`, ...groupIds.map((id) => `g:${id.toLowerCase()}`)];
  return mintKeys(keys, effective);
}

async function resolveEmbed(admin: RpcClient, scope: TenantScope, groupKey: string, signal: AbortSignal): Promise<AccessScope> {
  const { data, error } = await rpcCall(admin, 'rag_access_group_by_key', { p_tenant_key: scopeKey(scope), p_key: groupKey }, signal);
  signal.throwIfAborted();
  if (error) throw new LookupInvalid();
  const row = firstRow(data);
  if (!row) {
    logOnce('embed_group_not_found', 'embed_group_not_found', { tenant: scopeKey(scope) });
    return mintAccessScope('keys', ['all']);
  }
  const id = typeof row.id === 'string' ? row.id.toLowerCase() : '';
  if (!UUID_RE.test(id)) throw new LookupInvalid();
  const groupKeyName = `g:${id}`;
  return mintKeys(['all', groupKeyName], row.labels_current === true ? ['all', groupKeyName] : ['all']);
}

/**
 * D-05 to D-09, A-14 seam 1: the only way code outside the tenant module gets a scope resolved for access. Groups come from the verified
 * identity only, membership is read fresh (one call, no cache), and every failure is a 503 refusal, never a wider scope.
 */
export async function resolveAccessScope(input: ResolveAccessScopeInput): Promise<ResolveAccessScopeResult> {
  assertTenantScope(input.scope);
  const deps = getRagDeps();
  const config = input.config ?? loadRagConfig(deps.ragEnv());
  if (config.accessGroups !== 'on') {
    offAccess ??= mintAccessScope('off', []);
    return { ok: true, scope: withAccess(input.scope, offAccess) };
  }

  const started = deps.now();
  const identity = input.identity;
  const userId = identity.kind === 'user' ? identity.userId : identity.kind === 'eval' ? identity.userId : null;
  if (userId !== null && (typeof userId !== 'string' || !UUID_RE.test(userId.toLowerCase()))) return refuse('access_identity_invalid');
  const caller = userId?.toLowerCase() ?? null;

  try {
    input.signal.throwIfAborted();
    if (!(await accessReadyForResolve())) return refuse('access_not_ready');
    input.signal.throwIfAborted();

    let access: AccessScope;
    if (caller !== null && input.scope.kind === 'personal' && input.scope.userId === caller) {
      access = mintAccessScope('admin_all', [], { setHash: ACCESS_ADMIN_HASH });
    } else if (caller === null && identity.kind !== 'embed') {
      access = mintAccessScope('keys', ['all']);
    } else if (identity.kind === 'embed' && identity.groupKey.trim() === '') {
      access = mintAccessScope('keys', ['all']);
    } else {
      const admin = input.admin === undefined ? (deps.adminClient() as unknown as RpcClient | null) : input.admin;
      if (!admin) return refuse('access_unavailable');
      access =
        identity.kind === 'embed'
          ? await resolveEmbed(admin, input.scope, identity.groupKey.trim(), input.signal)
          : await resolveUser(admin, input.scope, caller as string, input.signal);
    }
    timings.set(access, Math.max(0, deps.now() - started));
    return { ok: true, scope: withAccess(input.scope, access) };
  } catch {
    if (input.signal.aborted) return refuse('access_aborted');
    return refuse('access_lookup_failed');
  }
}

/** D-08: how long the resolution of this scope's access took, for the access_scope stage; null when none was timed. */
export function accessScopeTiming(scope: TenantScope): number | null {
  assertTenantScope(scope);
  const access = scope.access;
  if (access === undefined) return null;
  return timings.get(access) ?? null;
}

/** D-07: the embed identity's group key, from RAG_EMBED_ACCESS_GROUP only; empty means visitors see documents labelled all. */
export function embedAccessGroup(): string {
  return loadRagConfig(getRagDeps().ragEnv()).embedAccessGroup;
}

/** D-06: whether a raw request body names groups at the top level (the route ignores the value and logs once). */
export function bodyNamesAccessGroups(rawBody: unknown): boolean {
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) return false;
  const body = rawBody as Record<string, unknown>;
  return ['accessGroups', 'groups'].some((key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined);
}

export type UploadAccessChoice = null | { everyone: true } | { groupIds: readonly string[] };

export type UploadAccessResult = { ok: true; keys: string[] | null } | { ok: false; reason: 'group_not_allowed' };

/** D-16: the label an upload asks for, limited to the caller's own groups unless the caller administers the tenant. */
export function uploadAccessKeys(scope: TenantScope, choice: UploadAccessChoice): UploadAccessResult {
  const filter = scopeAccessFilter(scope);
  if (choice === null) return { ok: true, keys: null };
  if ('everyone' in choice && choice.everyone === true) return { ok: true, keys: ['all'] };
  const ids = 'groupIds' in choice && Array.isArray(choice.groupIds) ? choice.groupIds : null;
  if (!ids || ids.length === 0 || filter.mode === 'off') return { ok: false, reason: 'group_not_allowed' };
  const keys: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id.toLowerCase())) return { ok: false, reason: 'group_not_allowed' };
    keys.push(`g:${id.toLowerCase()}`);
  }
  const unique = [...new Set(keys)].sort();
  if (filter.mode === 'admin_all') return { ok: true, keys: unique };
  const own = new Set(filter.keys);
  return unique.every((key) => own.has(key)) ? { ok: true, keys: unique } : { ok: false, reason: 'group_not_allowed' };
}
