import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { assertAccessScope, hashAccessKeys } from './access-brand';
import { assertTenantScope, type TenantScope } from './scope';

export {
  assertAccessScope,
  hashAccessKeys,
  isAccessScope,
  mintAccessScope,
  type AccessScope,
  type AccessScopeMode,
} from './access-brand';

/**
 * A-14: the stable seam Phase 7 (07-38, 07-39) reads. The accessor name and the three shapes are a contract; renaming either breaks that
 * phase.
 */
export type ScopeAccessFilter =
  | { mode: 'off' }
  | { mode: 'admin_all' }
  | { mode: 'keys'; keys: readonly string[]; setHash: string };

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

/** Two filters describe the same access: same mode and, for keys, the same key set. */
export function sameAccessFilter(a: ScopeAccessFilter, b: ScopeAccessFilter): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'keys' && b.mode === 'keys') return a.setHash === b.setHash && hashAccessKeys(a.keys) === b.setHash;
  return true;
}

/** The only place a filter becomes SQL arguments: off sends nothing, so the request body is today's. */
export function accessRpcArgs(filter: ScopeAccessFilter): { p_access_keys?: string[]; p_access_all?: boolean } {
  if (filter.mode === 'off') return {};
  if (filter.mode === 'admin_all') return { p_access_keys: ['all'], p_access_all: true };
  if (filter.keys.length === 0) throw new Error('[RAG Access] keys filter without keys');
  return { p_access_keys: [...filter.keys], p_access_all: false };
}
