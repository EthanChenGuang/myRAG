import type { SupabaseClient } from '@supabase/supabase-js';

export type MembershipDb = Pick<SupabaseClient, 'from'>;

export async function isOrganizationMember(
  _admin: MembershipDb,
  _organizationId: string,
  _userId: string,
  _signal: AbortSignal,
): Promise<boolean> {
  return false;
}
