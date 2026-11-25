import { getDeploymentMode } from '@/lib/deployment-mode';
import { getRagDeps } from '../deps';
import { isOrganizationMember, type MembershipDb } from './membership';
import { mintScope, type TenantScope } from './scope';

export type TenantResolveFailure = { ok: false; status: 401 | 403 | 503; reason: string };
export type TenantResolveResult =
  | { ok: true; scope: TenantScope | null; reason?: 'no_tenant' }
  | TenantResolveFailure;

export interface ResolveTenantScopeInput {
  requestedOrganizationId?: string | null;
  deploymentMode?: 'single-tenant' | 'multi-tenant';
  getUser?: () => Promise<{ id: string } | null>;
  admin?: MembershipDb | null;
  signal: AbortSignal;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(status: 401 | 403 | 503, reason: string): TenantResolveFailure {
  console.warn('[RAG Tenant] chat scope refused', { reason });
  return { ok: false, status, reason };
}

async function sessionUser(): Promise<{ id: string } | null> {
  const { createClient } = await import('@/lib/supabase/server');
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ? { id: data.user.id } : null;
}

function wantsPersonal(requested: unknown): boolean {
  return requested === undefined || requested === null || requested === '' || requested === 'null';
}

/**
 * The only way a chat, media or LiveKit request obtains a scope. The user comes from the session,
 * never from the body; a body organization is honoured only after a membership row is found.
 * Ids are lowercased once here so the scope key, the query and the logs agree.
 */
export async function resolveTenantScope(input: ResolveTenantScopeInput): Promise<TenantResolveResult> {
  const mode = input.deploymentMode ?? getDeploymentMode();
  if (mode !== 'multi-tenant') return { ok: true, scope: mintScope('single', null, null) };

  let user: { id: string } | null;
  try {
    user = await (input.getUser ?? sessionUser)();
  } catch {
    return refuse(503, 'auth_unavailable');
  }
  if (!user) return { ok: true, scope: null, reason: 'no_tenant' };
  if (typeof user.id !== 'string' || !UUID_RE.test(user.id)) return refuse(503, 'invalid_user');
  const userId = user.id.toLowerCase();

  const requested = input.requestedOrganizationId;
  if (wantsPersonal(requested)) return { ok: true, scope: mintScope('personal', userId, null) };
  if (typeof requested !== 'string' || !UUID_RE.test(requested.trim())) return refuse(403, 'invalid_organization');
  const organizationId = requested.trim().toLowerCase();

  const admin = input.admin === undefined ? getRagDeps().adminClient() : input.admin;
  if (!admin) return refuse(503, 'membership_unavailable');

  let member: boolean;
  try {
    member = await isOrganizationMember(admin, organizationId, userId, input.signal);
  } catch {
    return refuse(503, 'membership_unavailable');
  }
  if (!member) return refuse(403, 'not_a_member');
  return { ok: true, scope: mintScope('org', userId, organizationId) };
}
