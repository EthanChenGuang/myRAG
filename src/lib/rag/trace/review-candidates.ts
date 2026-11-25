import type { SupabaseClient } from '@supabase/supabase-js';
import { citedQuotesOf, exchangeForAnswer, recordTenantKey } from '@/lib/answers/exchange';
import { ReviewQueueItemSchema, type ReviewQueueItem } from '@/lib/rag-eval/contracts.generated';
import { maskPII } from './mask';

const MAX_ITEMS = 500;
const RECORD_COLUMNS = 'id,user_id,organization_id,chat_id,trace_id,model_id,answer_language,citations,review_reasons,updated_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ['feedback_negative', 'groundedness_flagged'] as const;

interface FlaggedRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  chat_id: string | null;
  trace_id: string | null;
  model_id: string | null;
  answer_language: string | null;
  citations: unknown;
  review_reasons: string[] | null;
  updated_at: string;
}

type AdminClient = Pick<SupabaseClient, 'from' | 'rpc'>;

function languageOf(value: string | null): 'zh' | 'en' | 'it' | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === 'zh' || lower.startsWith('zh-')) return 'zh';
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  if (lower === 'it' || lower.startsWith('it-')) return 'it';
  return null;
}

function isoOf(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** The tenants this admin may review, resolved in SQL by rag_admin_tenant_keys (service_role only). */
async function tenantKeys(admin: AdminClient, actor: string): Promise<string[] | null> {
  const { data, error } = await admin.rpc('rag_admin_tenant_keys', { p_actor: actor });
  if (error || !Array.isArray(data)) return null;
  return data.filter((key): key is string => typeof key === 'string');
}

async function flaggedRows(admin: AdminClient, keys: string[], actor: string, window: { from: string; to: string }): Promise<FlaggedRow[] | null> {
  const base = () =>
    admin
      .from('rag_answer_records')
      .select(RECORD_COLUMNS)
      .neq('review_reasons', '{}')
      .gte('updated_at', window.from)
      .lte('updated_at', window.to);
  const queries: Array<PromiseLike<{ data: unknown; error: unknown }>> = [];
  if (keys.includes('s:default')) {
    queries.push(base().order('updated_at', { ascending: false }).limit(MAX_ITEMS));
  } else {
    if (keys.includes(`u:${actor}`)) queries.push(base().is('organization_id', null).eq('user_id', actor).order('updated_at', { ascending: false }).limit(MAX_ITEMS));
    const organizations = keys.filter((key) => key.startsWith('o:')).map((key) => key.slice(2)).filter((id) => UUID_RE.test(id));
    if (organizations.length > 0) queries.push(base().in('organization_id', organizations).order('updated_at', { ascending: false }).limit(MAX_ITEMS));
  }
  const rows: FlaggedRow[] = [];
  for (const result of await Promise.all(queries)) {
    if (result.error || !Array.isArray(result.data)) return null;
    rows.push(...(result.data as FlaggedRow[]));
  }
  const allowed = new Set(keys);
  const multiTenant = !allowed.has('s:default');
  return rows
    .filter((row) => Array.isArray(row.review_reasons) && row.review_reasons.length > 0)
    .filter((row) => allowed.has(recordTenantKey(row, multiTenant)))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.id.localeCompare(b.id)))
    .slice(0, MAX_ITEMS);
}

/** The chats of the flagged records, kept only where the chat belongs to the record's own user. */
async function chatsFor(admin: AdminClient, rows: FlaggedRow[]): Promise<Map<string, { user_id: string; messages: unknown }> | null> {
  const ids = [...new Set(rows.map((row) => row.chat_id).filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)))];
  const chats = new Map<string, { user_id: string; messages: unknown }>();
  if (ids.length === 0) return chats;
  const { data, error } = await admin.from('chats').select('id,user_id,messages').in('id', ids);
  if (error || !Array.isArray(data)) return null;
  for (const chat of data as Array<{ id: string; user_id: string; messages: unknown }>) chats.set(String(chat.id), chat);
  return chats;
}

export type ListReviewCandidatesResult = { ok: true; items: ReviewQueueItem[] } | { ok: false; reason: 'unavailable' };

/**
 * D-19: flagged answer records (non-empty review_reasons, updated_at in the window) of the tenants the verified admin administers,
 * as ReviewQueueItem entries. The query and answer come from the record's own chat row; every text is masked. At most 500 items.
 */
export async function listReviewCandidates(
  admin: AdminClient,
  input: { actorUserId: string; from: string; to: string },
): Promise<ListReviewCandidatesResult> {
  if (!UUID_RE.test(input.actorUserId)) return { ok: false, reason: 'unavailable' };
  const actor = input.actorUserId.toLowerCase();
  const keys = await tenantKeys(admin, actor);
  if (!keys || keys.length === 0) return { ok: false, reason: 'unavailable' };
  const rows = await flaggedRows(admin, keys, actor, { from: input.from, to: input.to });
  if (!rows) return { ok: false, reason: 'unavailable' };
  const chats = await chatsFor(admin, rows);
  if (!chats) return { ok: false, reason: 'unavailable' };
  const multiTenant = !keys.includes('s:default');

  const items: ReviewQueueItem[] = [];
  for (const row of rows) {
    const reasons = REASONS.filter((reason) => row.review_reasons?.includes(reason));
    if (reasons.length === 0 || !row.trace_id) continue;
    const chat = row.chat_id ? chats.get(row.chat_id) : undefined;
    const exchange = chat && chat.user_id === row.user_id ? exchangeForAnswer(chat.messages, row.id) : null;
    const item = ReviewQueueItemSchema.safeParse({
      trace_id: row.trace_id,
      observation_id: row.id,
      captured_at: isoOf(row.updated_at),
      tenant_key: recordTenantKey(row, multiTenant),
      language: languageOf(row.answer_language),
      query_masked: maskPII(exchange?.query ?? ''),
      answer_masked: maskPII(exchange?.answer ?? ''),
      context_masked: maskPII(citedQuotesOf(row.citations).join('\n\n')),
      model: maskPII(row.model_id ?? ''),
      tags: ['review_candidate', ...reasons.map((reason) => `review:${reason}`)],
      reasons,
    });
    if (item.success) items.push(item.data);
  }
  return { ok: true, items };
}
