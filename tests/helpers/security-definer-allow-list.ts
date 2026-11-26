import type { AllowListEntry } from './sql-function-acl';

/**
 * SECURITY DEFINER functions that must stay callable by authenticated users. Everything else is service_role only.
 * Keys are normalised full signatures (name and argument types, as `signatureKey` and `regprocedure::text` print them), so a new overload that
 * shares an allow-listed name is not approved. Look entries up with allowListEntryFor, never by name.
 * anon says whether anon keeps EXECUTE (only where an RLS policy without a TO clause evaluates the function for anon).
 * Service-role-only definers such as rag_purge_retrieval_log(integer,integer), rag_feedback_loop_on_chat_delete() and
 * rag_mine_failed_queries(timestamptz,timestamptz,jsonb) are deliberately absent: their lock is section 1 of 0410, and
 * tests/rag-db/retrieval-log-purge.test.mts and tests/rag-db/review-items-mining.test.mts assert they never appear here.
 * The 0651 fine-tune consent and registry functions (rag_finetune_set_consent, rag_finetune_list_consent, rag_finetune_consent_for_export,
 * rag_finetune_register_model, rag_finetune_list_models, rag_finetune_set_model_status) are service_role only too, revoked in 0651 itself;
 * tests/rag-db/finetune-registry.test.mts asserts they never appear here.
 * The 0652 fine-tune slot functions (rag_finetune_bind_slot, rag_finetune_clear_slot, rag_finetune_release_rollback) and trigger functions
 * (rag_finetune_slot_guard, rag_finetune_version_taint_guard) are service_role only as well; tests/rag-db/finetune-slots.test.mts asserts it.
 */
export const AUTHENTICATED_ALLOW_LIST: Record<string, AllowListEntry> = {
  'delete_folder(uuid,boolean)': { anon: false, reason: 'called with the user session from chat-store.ts and /api/folders/[id]; checks auth.uid() ownership' },
  'move_chats_to_folder(uuid[],uuid)': { anon: false, reason: 'called with the user session from chat-store.ts and /api/folders/move-chats; checks auth.uid() ownership' },
  'share_personal_organization(uuid)': { anon: false, reason: 'called with the user session from /api/organizations/[id]/share; checks owner_id = auth.uid()' },
  'create_organization_safe(text,text,uuid,boolean)': { anon: false, reason: 'called with the user session from /api/organizations; rejects a p_owner_id other than auth.uid()' },
  'is_org_member(uuid,uuid)': { anon: true, reason: 'RLS helper in organization and document policies that anon requests also evaluate; answers only for auth.uid()' },
  'is_org_owner(uuid)': { anon: true, reason: 'RLS helper in organization_members policies that anon requests also evaluate; answers only for auth.uid()' },
  'is_org_admin(uuid)': { anon: true, reason: 'RLS helper in organizations policies that anon requests also evaluate; answers only for auth.uid()' },
  'check_admin_status()': { anon: true, reason: 'RLS helper in admin_users and admin_settings policies that have no TO clause; checks auth.uid() only' },
  'is_admin(uuid)': { anon: false, reason: 'RLS helper in single-tenant knowledge-base policies; contract asserted by tests/security-gaps-rls.test.mts' },
  'is_subscribed(uuid)': { anon: false, reason: 'caller-bound subscription check; contract asserted by tests/security-gaps-rls.test.mts' },
  'get_nango_stats(uuid)': { anon: false, reason: 'caller-bound connection stats; contract asserted by tests/security-gaps-rls.test.mts' },
  'kb_writes_locked()': { anon: false, reason: 'RLS helper in single-tenant knowledge-base write policies (TO authenticated)' },
  'rag_is_domain_expert(text)': { anon: false, reason: 'RLS helper in the rag_review_items policies (TO authenticated); answers only for auth.uid() against rag_domain_experts or, single-tenant, admin_users for s:default' },
  'rag_ingest_realtime_topic_allowed(text)': { anon: false, reason: 'RLS helper in the realtime.messages policy for ingestion job topics; reads auth.uid() and realtime.topic()' },
};

/** Lowercases and strips the schema, quotes and blanks from a `name(arg,arg)` signature, as `regprocedure::text` and `signatureKey` print it. */
export function normalizeSignature(signature: string): string {
  return signature.toLowerCase().replace(/"/g, '').replace(/\bpublic\./g, '').replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim();
}

export function allowListEntryFor(signature: string): AllowListEntry | undefined {
  return AUTHENTICATED_ALLOW_LIST[normalizeSignature(signature)];
}
