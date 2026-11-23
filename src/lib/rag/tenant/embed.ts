import { getDeploymentMode } from '@/lib/deployment-mode';
import { getRagDeps } from '../deps';
import type { MembershipDb } from './membership';
import { mintScope, type TenantScope } from './scope';

export type TenantKey =
  | { kind: 'single' }
  | { kind: 'org'; organizationId: string }
  | { kind: 'personal'; userId: string };

export type EmbedScopeFailure =
  | { ok: false; status: 403 | 503; reason: string }
  | {
      ok: false;
      status: 'retrieval_error';
      reason: 'embed_tenant_unconfigured' | 'embed_tenant_unknown' | 'embed_tenant_invalid';
    };

export type EmbedScopeResult = { ok: true; scope: TenantScope } | EmbedScopeFailure;

export interface ResolveEmbedScopeInput {
  rawBody: unknown;
  configuredTenant?: string;
  deploymentMode?: 'single-tenant' | 'multi-tenant';
  admin?: MembershipDb | null;
  signal: AbortSignal;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_RE = new RegExp(`^(?:(s):(default)|([ou]):(${UUID}))$`);
const BODY_WORKSPACE_KEYS = ['organizationId', 'workspaceId', 'tenant'] as const;

let unconfiguredLogged = false;

export function resetEmbedTenantLogForTests(): void {
  unconfiguredLogged = false;
}

/** Accepts s:default, o:<uuid>, u:<uuid>. Case and surrounding whitespace are normalised, ids come back lowercase. */
export function parseTenantKey(value: unknown): TenantKey | null {
  if (typeof value !== 'string') return null;
  const match = KEY_RE.exec(value.trim().toLowerCase());
  if (!match) return null;
  if (match[1] === 's') return { kind: 'single' };
  if (match[3] === 'o') return { kind: 'org', organizationId: match[4] };
  return { kind: 'personal', userId: match[4] };
}

function refuse(status: 403 | 503, reason: string): EmbedScopeFailure {
  console.warn('[RAG Tenant] embed scope refused', { reason });
  return { ok: false, status, reason };
}

function fail(reason: 'embed_tenant_unconfigured' | 'embed_tenant_unknown' | 'embed_tenant_invalid'): EmbedScopeFailure {
  console.warn('[RAG Tenant] embed scope unavailable', { reason });
  return { ok: false, status: 'retrieval_error', reason };
}

function isNamed(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed !== '' && trimmed !== 'null';
  }
  return true;
}

function sameId(value: unknown, expected: string | null): boolean {
  return expected !== null && typeof value === 'string' && value.trim().toLowerCase() === expected;
}

function bodyMatches(key: (typeof BODY_WORKSPACE_KEYS)[number], value: unknown, configured: TenantKey): boolean {
  if (key === 'tenant') {
    const named = parseTenantKey(value);
    if (!named || named.kind !== configured.kind) return false;
    if (named.kind === 'org' && configured.kind === 'org') return named.organizationId === configured.organizationId;
    if (named.kind === 'personal' && configured.kind === 'personal') return named.userId === configured.userId;
    return named.kind === 'single';
  }
  const orgId = configured.kind === 'org' ? configured.organizationId : null;
  if (key === 'organizationId') return sameId(value, orgId);
  const userId = configured.kind === 'personal' ? configured.userId : null;
  return sameId(value, orgId) || sameId(value, userId);
}

function bodyNamesOtherWorkspace(rawBody: unknown, configured: TenantKey): boolean {
  if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) return false;
  const body = rawBody as Record<string, unknown>;
  return BODY_WORKSPACE_KEYS.some((key) => isNamed(body[key]) && !bodyMatches(key, body[key], configured));
}

async function organizationExists(admin: MembershipDb, organizationId: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const { data, error } = await admin
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .abortSignal(signal)
    .maybeSingle();
  signal.throwIfAborted();
  if (error) throw new Error('[RAG Tenant] organization lookup failed');
  return data !== null && data !== undefined;
}

/**
 * Embedded chat searches only the workspace the server is configured for (RAG_EMBED_TENANT).
 * The raw request body is inspected before schema parsing strips unknown keys.
 */
export async function resolveEmbedScope(input: ResolveEmbedScopeInput): Promise<EmbedScopeResult> {
  const mode = input.deploymentMode ?? getDeploymentMode();
  const configuredText = (input.configuredTenant ?? '').trim();

  let configured: TenantKey;
  if (configuredText === '') {
    if (mode === 'multi-tenant') {
      if (!unconfiguredLogged) {
        unconfiguredLogged = true;
        console.warn('[RAG Tenant] embed scope unavailable', { reason: 'embed_tenant_unconfigured' });
      }
      return { ok: false, status: 'retrieval_error', reason: 'embed_tenant_unconfigured' };
    }
    configured = { kind: 'single' };
  } else {
    const parsed = parseTenantKey(configuredText);
    if (!parsed) return fail('embed_tenant_invalid');
    if (mode === 'multi-tenant' && parsed.kind === 'single') return fail('embed_tenant_invalid');
    if (mode !== 'multi-tenant' && parsed.kind !== 'single') return fail('embed_tenant_invalid');
    configured = parsed;
  }

  if (bodyNamesOtherWorkspace(input.rawBody, configured)) return refuse(403, 'workspace_mismatch');

  if (configured.kind === 'single') return { ok: true, scope: mintScope('single', null, null) };
  if (configured.kind === 'personal') return { ok: true, scope: mintScope('personal', configured.userId, null) };

  const admin = input.admin === undefined ? getRagDeps().adminClient() : input.admin;
  if (!admin) return refuse(503, 'embed_tenant_unavailable');
  let exists: boolean;
  try {
    exists = await organizationExists(admin, configured.organizationId, input.signal);
  } catch {
    return refuse(503, 'embed_tenant_unavailable');
  }
  if (!exists) return fail('embed_tenant_unknown');
  return { ok: true, scope: mintScope('org', null, configured.organizationId) };
}
