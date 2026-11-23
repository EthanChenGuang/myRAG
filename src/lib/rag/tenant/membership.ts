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
): Promise<boolean> {
  signal.throwIfAborted();
  const { data, error } = await admin
    .from('organization_members')
    .select('organization_id')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .maybeSingle()
    .abortSignal(signal);
  signal.throwIfAborted();
  if (error) throw new MembershipQueryError();
  return data !== null && data !== undefined;
}
