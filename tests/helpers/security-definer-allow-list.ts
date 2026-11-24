import type { AllowListEntry } from './sql-function-acl';

/**
 * SECURITY DEFINER functions that must stay callable by authenticated users. Everything else is service_role only.
 * anon says whether anon keeps EXECUTE (only where an RLS policy without a TO clause evaluates the function for anon).
 */
export const AUTHENTICATED_ALLOW_LIST: Record<string, AllowListEntry> = {
  delete_folder: { anon: false, reason: 'called with the user session from chat-store.ts and /api/folders/[id]; checks auth.uid() ownership' },
  move_chats_to_folder: { anon: false, reason: 'called with the user session from chat-store.ts and /api/folders/move-chats; checks auth.uid() ownership' },
  share_personal_organization: { anon: false, reason: 'called with the user session from /api/organizations/[id]/share; checks owner_id = auth.uid()' },
  create_organization_safe: { anon: false, reason: 'called with the user session from /api/organizations; rejects a p_owner_id other than auth.uid()' },
  is_org_member: { anon: true, reason: 'RLS helper in organization and document policies that anon requests also evaluate; answers only for auth.uid()' },
  is_org_owner: { anon: true, reason: 'RLS helper in organization_members policies that anon requests also evaluate; answers only for auth.uid()' },
  is_org_admin: { anon: true, reason: 'RLS helper in organizations policies that anon requests also evaluate; answers only for auth.uid()' },
  check_admin_status: { anon: true, reason: 'RLS helper in admin_users and admin_settings policies that have no TO clause; checks auth.uid() only' },
  is_admin: { anon: false, reason: 'RLS helper in single-tenant knowledge-base policies; contract asserted by tests/security-gaps-rls.test.mts' },
  is_subscribed: { anon: false, reason: 'caller-bound subscription check; contract asserted by tests/security-gaps-rls.test.mts' },
  get_nango_stats: { anon: false, reason: 'caller-bound connection stats; contract asserted by tests/security-gaps-rls.test.mts' },
  kb_writes_locked: { anon: false, reason: 'RLS helper in single-tenant knowledge-base write policies (TO authenticated)' },
  rag_ingest_realtime_topic_allowed: { anon: false, reason: 'RLS helper in the realtime.messages policy for ingestion job topics; reads auth.uid() and realtime.topic()' },
};

/** Lowercases and strips the schema, quotes and blanks from a `name(arg,arg)` signature, as `regprocedure::text` and `signatureKey` print it. */
export function normalizeSignature(signature: string): string {
  return signature.toLowerCase().replace(/"/g, '').replace(/\bpublic\./g, '').replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim();
}

export function allowListEntryFor(signature: string): AllowListEntry | undefined {
  return AUTHENTICATED_ALLOW_LIST[normalizeSignature(signature).split('(')[0] as string];
}
