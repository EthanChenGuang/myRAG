declare const tenantBrand: unique symbol;

export type TenantScopeKind = 'single' | 'personal' | 'org';

export interface TenantScope {
  readonly [tenantBrand]: true;
  readonly kind: TenantScopeKind;
  readonly userId: string | null;
  readonly organizationId: string | null;
}

export type TenantPredicate =
  | { kind: 'none' }
  | { kind: 'personal'; userId: string }
  | { kind: 'org'; organizationId: string };

export interface WorkspaceRpcArgs {
  p_org_id: string | null;
  p_user_id: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const minted = new WeakSet<object>();

function requireUuid(label: string, value: string | null): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`[RAG Tenant] ${label} must be a UUID`);
  }
  return value;
}

/** Tenant-internal: the boundary check forbids importing this outside src/lib/rag/tenant and tests. */
export function mintScope(kind: TenantScopeKind, userId: string | null, organizationId: string | null): TenantScope {
  if (kind === 'single') {
    if (userId !== null || organizationId !== null) {
      throw new Error('[RAG Tenant] single scope takes no user or organization');
    }
  } else if (kind === 'personal') {
    requireUuid('personal scope userId', userId);
    if (organizationId !== null) throw new Error('[RAG Tenant] personal scope takes no organization');
  } else if (kind === 'org') {
    requireUuid('org scope organizationId', organizationId);
    if (userId !== null) requireUuid('org scope userId', userId);
  } else {
    throw new Error('[RAG Tenant] unknown scope kind');
  }
  const scopedUserId = userId !== null ? userId.toLowerCase() : null;
  const scopedOrganizationId = organizationId !== null ? organizationId.toLowerCase() : null;
  const scope = Object.freeze({
    kind,
    userId: scopedUserId,
    organizationId: scopedOrganizationId,
  }) as unknown as TenantScope;
  minted.add(scope);
  return scope;
}

export function isTenantScope(value: unknown): value is TenantScope {
  return typeof value === 'object' && value !== null && minted.has(value);
}

export function assertTenantScope(value: unknown): asserts value is TenantScope {
  if (!isTenantScope(value)) {
    throw new Error('[RAG Tenant] unminted scope');
  }
}

export function scopeKey(scope: TenantScope): string {
  assertTenantScope(scope);
  if (scope.kind === 'single') return 's:default';
  if (scope.kind === 'org') return `o:${scope.organizationId}`;
  return `u:${scope.userId}`;
}

/** Mirrors match_documents_by_workspace: org ignores the user; personal needs the user and no organization. */
export function tenantPredicate(scope: TenantScope): TenantPredicate {
  assertTenantScope(scope);
  if (scope.kind === 'single') return { kind: 'none' };
  if (scope.kind === 'org') return { kind: 'org', organizationId: scope.organizationId as string };
  return { kind: 'personal', userId: scope.userId as string };
}

export function rowMatchesPredicate(
  predicate: TenantPredicate,
  row: { user_id: string | null; organization_id: string | null },
): boolean {
  if (predicate.kind === 'none') return true;
  if (predicate.kind === 'org') return row.organization_id === predicate.organizationId;
  return row.user_id === predicate.userId && row.organization_id === null;
}

/** The p_org_id / p_user_id pair the legacy multi-tenant search sends. */
export function workspaceRpcArgs(scope: TenantScope): WorkspaceRpcArgs {
  assertTenantScope(scope);
  if (scope.kind === 'single') {
    throw new Error('[RAG Tenant] single scope has no workspace arguments');
  }
  return { p_org_id: scope.organizationId, p_user_id: scope.userId };
}
