import { getDeploymentMode } from '@/lib/deployment-mode';

export interface RepairOwnerMembershipInput {
  requestedOrganizationId?: unknown;
  getUser: () => Promise<{ id: string } | null>;
  deploymentMode?: 'single-tenant' | 'multi-tenant';
  verify?: (userId: string, organizationId: string) => Promise<unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function defaultVerify(userId: string, organizationId: string): Promise<unknown> {
  const { verifyUserOrganizationAccess } = await import('@/lib/auth/organization-handler');
  return verifyUserOrganizationAccess(userId, organizationId);
}

/**
 * Backfills a missing organization_members row for the organization's owner before resolveTenantScope
 * checks membership. verifyUserOrganizationAccess only writes the row when organizations.owner_id equals
 * the session user, so a non-owner non-member is not admitted here; resolveTenantScope stays the decision.
 * Never throws: a failed repair leaves the membership check to answer.
 */
export async function repairOwnerMembership(input: RepairOwnerMembershipInput): Promise<void> {
  const mode = input.deploymentMode ?? getDeploymentMode();
  if (mode !== 'multi-tenant') return;

  const requested = input.requestedOrganizationId;
  if (typeof requested !== 'string' || !UUID_RE.test(requested.trim())) return;

  try {
    const user = await input.getUser();
    if (!user || typeof user.id !== 'string' || !UUID_RE.test(user.id)) return;
    await (input.verify ?? defaultVerify)(user.id.toLowerCase(), requested.trim().toLowerCase());
  } catch {
    console.warn('[RAG Tenant] owner membership repair skipped');
  }
}
