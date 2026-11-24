import type { SupabaseClient } from '@supabase/supabase-js';
import { getDeploymentMode, type DeploymentMode } from '@/lib/deployment-mode';
import { parseTenantKey } from './embed';
import { mintScope, type TenantScope } from './scope';

export type BackfillScopeResult =
  | { ok: true; scope: TenantScope }
  | { ok: false; reason: 'invalid_tenant' | 'unknown_tenant' | 'unavailable' };

export type BackfillScopeAdmin = Pick<SupabaseClient, 'from' | 'auth'>;

export interface BackfillScopeDeps {
  deploymentMode?: DeploymentMode;
  admin?: BackfillScopeAdmin | null;
  signal: AbortSignal;
}

function refuse(reason: BackfillScopeResult extends { ok: false } ? BackfillScopeResult['reason'] : never): BackfillScopeResult {
  console.warn('[Backfill] tenant scope refused', { reason });
  return { ok: false, reason };
}

async function userExists(admin: BackfillScopeAdmin, userId: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    signal.throwIfAborted();
    if (error || !data?.user?.id) return false;
    return data.user.id.toLowerCase() === userId;
  } catch {
    throw new Error('[Backfill] user lookup failed');
  }
}

async function organizationExists(admin: BackfillScopeAdmin, organizationId: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const { data, error } = await admin
    .from('organizations')
    .select('id')
    .eq('id', organizationId)
    .abortSignal(signal)
    .maybeSingle();
  signal.throwIfAborted();
  if (error) throw new Error('[Backfill] organization lookup failed');
  return data !== null && data !== undefined;
}

export async function backfillScope(tenantKey: string, deps?: BackfillScopeDeps): Promise<BackfillScopeResult> {
  const mode = deps?.deploymentMode ?? getDeploymentMode();
  const signal = deps?.signal ?? AbortSignal.timeout(30_000);
  const parsed = parseTenantKey(tenantKey);
  if (!parsed) return refuse('invalid_tenant');

  if (mode === 'multi-tenant' && parsed.kind === 'single') return refuse('invalid_tenant');
  if (mode !== 'multi-tenant' && parsed.kind !== 'single') return refuse('invalid_tenant');

  if (parsed.kind === 'single') return { ok: true, scope: mintScope('single', null, null) };

  let admin = deps?.admin;
  if (admin === undefined) {
    const { getRagDeps } = await import('../deps');
    admin = getRagDeps().adminClient();
  }
  if (!admin) return refuse('unavailable');

  try {
    if (parsed.kind === 'personal') {
      const exists = await userExists(admin, parsed.userId, signal);
      if (!exists) return refuse('unknown_tenant');
      return { ok: true, scope: mintScope('personal', parsed.userId, null) };
    }
    const exists = await organizationExists(admin, parsed.organizationId, signal);
    if (!exists) return refuse('unknown_tenant');
    return { ok: true, scope: mintScope('org', null, parsed.organizationId) };
  } catch {
    return refuse('unavailable');
  }
}