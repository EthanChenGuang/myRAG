import type { SupabaseClient } from '@supabase/supabase-js';

export type MembershipDb = Pick<SupabaseClient, 'from'>;

export class MembershipQueryError extends Error {
  constructor() {
    super('[RAG Tenant] membership query failed');
    this.name = 'MembershipQueryError';
  }
}

export async function isOrganizationMember(
  admin: MembershipDb,
  organizationId: string,
  userId: string,
  signal: AbortSignal,
  roles?: readonly string[],
): Promise<boolean> {
  signal.throwIfAborted();
  const base = admin
    .from('organization_members')
    .select('organization_id')
    .eq('organization_id', organizationId)
    .eq('user_id', userId);
  const { data, error } = await (roles ? base.in('role', [...roles]) : base).abortSignal(signal).maybeSingle();
  signal.throwIfAborted();
  if (error) throw new MembershipQueryError();
  return data !== null && data !== undefined;
}
