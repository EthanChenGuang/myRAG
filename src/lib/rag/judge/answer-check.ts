import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod/v3';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { hashForLog, linkedAnswer, readVisibleItem } from '@/lib/rag/feedback-loop/review-access';
import { parseTenantKey } from '@/lib/rag/tenant/embed';

/**
 * D-31 answer check: an expert's three verdicts on the answer of one review item, stored in rag_judge_labels (0965). Items and labels are
 * read and written with the caller's session client, so RLS (public.rag_is_domain_expert) decides; the tenant comes from the item row
 * that client can read, never from the request. The admin client only checks that the visible item has an answer (its own linked chat)
 * and, for an item the caller cannot see, whether the caller is an expert at all (403 versus the foreign-item 404). No judge score is
 * read or returned here: the expert answers before seeing one.
 */

type Client = SupabaseClient;
type Row = Record<string, unknown>;

export const AnswerCheckRequestSchema = z
  .object({ supported: z.boolean(), relevant: z.boolean(), unsupported_content: z.boolean() })
  .strict();
export type AnswerCheckVerdicts = z.infer<typeof AnswerCheckRequestSchema>;

export interface AnswerCheck {
  supported: boolean | null;
  relevant: boolean | null;
  unsupported_content: boolean | null;
  labelled_at: string | null;
}

export type AnswerCheckFailure = 'not_found' | 'not_expert' | 'no_answer' | 'exported';
export type AnswerCheckResult = { ok: true; check: AnswerCheck } | { ok: false; reason: AnswerCheckFailure };

const LABEL_COLUMNS = 'supported,relevant,unsupported_content,labelled_at';
const EMPTY: AnswerCheck = { supported: null, relevant: null, unsupported_content: null, labelled_at: null };

function toCheck(row: Row): AnswerCheck {
  const flag = (value: unknown) => (typeof value === 'boolean' ? value : null);
  return {
    supported: flag(row.supported),
    relevant: flag(row.relevant),
    unsupported_content: flag(row.unsupported_content),
    labelled_at: typeof row.labelled_at === 'string' ? row.labelled_at : null,
  };
}

/** True when the caller holds an expert grant for any tenant (single-tenant admins are experts of s:default by rule). */
async function isAnyTenantExpert(ssr: Client, admin: Client, userId: string): Promise<boolean> {
  const { data, error } = await admin.from('rag_domain_experts').select('tenant_key').eq('user_id', userId).limit(1);
  if (error) throw new Error('answer_check_expert_lookup_failed');
  if (Array.isArray(data) && data.length > 0) return true;
  if (getDeploymentMode() !== 'single-tenant') return false;
  const { data: implicit, error: rpcError } = await ssr.rpc('rag_is_domain_expert', { p_tenant_key: 's:default' });
  if (rpcError) throw new Error('answer_check_expert_lookup_failed');
  return implicit === true;
}

type ItemAccess = { ok: true; item: Row; tenantKey: string } | { ok: false; reason: AnswerCheckFailure };

async function openItem(ssr: Client, admin: Client, itemId: string, userId: string): Promise<ItemAccess> {
  const item = await readVisibleItem(ssr, itemId);
  if (!item) return { ok: false, reason: (await isAnyTenantExpert(ssr, admin, userId)) ? 'not_found' : 'not_expert' };
  const tenantKey = item.tenant_key;
  if (typeof tenantKey !== 'string' || !parseTenantKey(tenantKey)) return { ok: false, reason: 'not_found' };
  let answer: string | null = null;
  try {
    answer = await linkedAnswer(admin, item);
  } catch {
    answer = null;
  }
  if (answer === null || answer === '') return { ok: false, reason: 'no_answer' };
  return { ok: true, item, tenantKey };
}

async function ownLabel(ssr: Client, itemId: string, userId: string): Promise<Row | null> {
  const { data, error } = await ssr
    .from('rag_judge_labels')
    .select(LABEL_COLUMNS)
    .eq('review_item_id', itemId)
    .eq('labelled_by', userId)
    .maybeSingle();
  if (error) throw new Error('answer_check_read_failed');
  return (data as unknown as Row | null) ?? null;
}

/** The caller's own answer check of a visible item with an answer; all fields null when none was saved yet. */
export async function readAnswerCheck(ssr: Client, admin: Client, itemId: string, userId: string): Promise<AnswerCheckResult> {
  const access = await openItem(ssr, admin, itemId, userId);
  if (!access.ok) return access;
  const row = await ownLabel(ssr, String(access.item.id), userId);
  return { ok: true, check: row ? toCheck(row) : EMPTY };
}

async function updateOwn(ssr: Client, itemId: string, userId: string, verdicts: AnswerCheckVerdicts, labelledAt: string): Promise<Row | null> {
  const { data, error } = await ssr
    .from('rag_judge_labels')
    .update({ ...verdicts, labelled_at: labelledAt })
    .eq('review_item_id', itemId)
    .eq('labelled_by', userId)
    .select(LABEL_COLUMNS)
    .maybeSingle();
  if (error) throw new Error('answer_check_write_failed');
  return (data as unknown as Row | null) ?? null;
}

/**
 * Saves or replaces the caller's own verdicts. The update path touches only the columns 0965 lets authenticated update; the insert
 * names the tenant of the item row, and the composite foreign key plus the insert policy reject any other. A concurrent first save
 * (unique violation) falls back to the update.
 */
export async function saveAnswerCheck(
  ssr: Client,
  admin: Client,
  itemId: string,
  userId: string,
  verdicts: AnswerCheckVerdicts,
): Promise<AnswerCheckResult> {
  const access = await openItem(ssr, admin, itemId, userId);
  if (!access.ok) return access;
  if (access.item.status === 'exported') return { ok: false, reason: 'exported' };
  const id = String(access.item.id);
  const labelledAt = new Date().toISOString();

  let row = await updateOwn(ssr, id, userId, verdicts, labelledAt);
  if (!row) {
    const { data, error } = await ssr
      .from('rag_judge_labels')
      .insert({ review_item_id: id, tenant_key: access.tenantKey, ...verdicts, labelled_by: userId, labelled_at: labelledAt })
      .select(LABEL_COLUMNS)
      .maybeSingle();
    if (error) {
      if ((error as { code?: unknown }).code !== '23505') throw new Error('answer_check_write_failed');
      row = await updateOwn(ssr, id, userId, verdicts, labelledAt);
    } else {
      row = (data as unknown as Row | null) ?? null;
    }
  }
  if (!row) throw new Error('answer_check_write_failed');

  console.log('[Review] answer check', { expert: userId, item: hashForLog(id), ...verdicts });
  return { ok: true, check: toCheck(row) };
}
