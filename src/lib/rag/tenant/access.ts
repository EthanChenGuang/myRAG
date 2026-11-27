import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { assertAccessScope } from './access-brand';
import { assertTenantScope, type TenantScope } from './scope';

export {
  assertAccessScope,
  hashAccessKeys,
  isAccessScope,
  mintAccessScope,
  type AccessScope,
  type AccessScopeMode,
} from './access-brand';

export { accessRpcArgs, sameAccessFilter, type ScopeAccessFilter } from './access-filter';
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
