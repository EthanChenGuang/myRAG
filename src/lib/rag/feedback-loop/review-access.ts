import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod/v3';
import { ReviewItemSchema, type ReviewItem } from '@/lib/rag-eval/contracts.generated';
import { maskPII } from '@/lib/rag/trace/mask';
import { parseTenantKey } from '@/lib/rag/tenant/embed';
import type { DeploymentMode } from '@/lib/deployment-mode';

/**
 * D-16 expert access to the review queue. Items are always read with the caller's SSR client, so RLS
 * (public.rag_is_domain_expert) decides visibility; the admin client is used only after an item was visible, and only for that
 * item's tenant_key and the ids its snapshot holds. D-29: tags are returned as stored and are never filtered on or written here.
 */

type Client = SupabaseClient;
type Row = Record<string, unknown>;

export const REVIEW_PAGE_SIZE = 50;
const MAX_ANSWER_LENGTH = 20000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

const ITEM_COLUMNS = [
  'id',
  'tenant_key',
  'retrieval_log_id',
  'trace_id',
  'query_masked',
  'query_language',
  'query_language_confidence',
  'answer_language',
  'chunk_languages',
  'channel',
  'outcome',
  'candidates',
  'retrieval_config_hash',
  'reasons',
  'occurrences',
  'tags',
  'status',
  'triage',
  'label',
  'labelled_by',
  'labelled_at',
  'split',
  'split_group',
  'mining_window',
  'mined_at',
  'expires_at',
] as const;

/** The detail read adds the two internal link columns; they never leave this module. */
const DETAIL_COLUMNS = [...ITEM_COLUMNS, 'user_id', 'chat_id'] as const;

export const ReviewListQuerySchema = z
  .object({
    status: ReviewItemSchema.shape.status.optional(),
    reason: z
      .enum(['feedback_negative', 'refusal_disputed', 'groundedness_flagged', 'refused_high_score', 'zero_results', 'low_score', 'no_source_opened'])
      .optional(),
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/).optional(),
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict();
export type ReviewListQuery = z.infer<typeof ReviewListQuerySchema>;

export function hashForLog(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function isReviewItemId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function encodeCursor(minedAt: string, id: string): string {
  return Buffer.from(JSON.stringify([minedAt, id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { minedAt: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [minedAt, id] = parsed as unknown[];
    if (typeof minedAt !== 'string' || !TIMESTAMP_RE.test(minedAt) || !isReviewItemId(id)) return null;
    return { minedAt, id: id.toLowerCase() };
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Maps a stored row to the ReviewItem shape; tags and the D-03a language snapshot pass through unchanged. */
function toReviewItem(row: Row, answerMasked: string | null): ReviewItem | null {
  const confidence = row.query_language_confidence;
  const candidate = {
    id: row.id,
    tenant_key: row.tenant_key,
    retrieval_log_id: stringOrNull(row.retrieval_log_id),
    trace_id: row.trace_id,
    query_masked: stringOrNull(row.query_masked),
    query_language: stringOrNull(row.query_language),
    query_language_confidence: typeof confidence === 'number' ? confidence : confidence == null ? null : Number(confidence),
    answer_language: stringOrNull(row.answer_language),
    chunk_languages: stringArray(row.chunk_languages),
    channel: row.channel,
    outcome: row.outcome ?? 'unknown',
    candidates: Array.isArray(row.candidates) ? row.candidates : [],
    retrieval_config_hash: stringOrNull(row.retrieval_config_hash),
    reasons: stringArray(row.reasons),
    occurrences: row.occurrences,
    tags: stringArray(row.tags),
    status: row.status,
    triage: stringArray(row.triage),
    label: row.label ?? null,
    labelled_by: stringOrNull(row.labelled_by),
    labelled_at: stringOrNull(row.labelled_at),
    split: stringOrNull(row.split),
    split_group: stringOrNull(row.split_group),
    mining_window: stringOrNull(row.mining_window),
    mined_at: row.mined_at,
    expires_at: stringOrNull(row.expires_at),
    answer_masked: answerMasked,
  };
  const parsed = ReviewItemSchema.safeParse(candidate);
  if (!parsed.success) {
    console.error('[Review] stored item failed the contract', { item: hashForLog(String(row.id)), issues: parsed.error.errors.length });
    return null;
  }
  return parsed.data;
}

export type ListReviewItemsResult =
  | { ok: true; items: ReviewItem[]; next_cursor: string | null }
  | { ok: false; reason: 'invalid_cursor' };

/** Newest first by (mined_at, id); the opaque cursor is the last returned pair. Reads with the caller's SSR client only. */
export async function listReviewItems(ssr: Client, query: ReviewListQuery): Promise<ListReviewItemsResult> {
  let builder = ssr.from('rag_review_items').select(ITEM_COLUMNS.join(','));
  if (query.status) builder = builder.eq('status', query.status);
  if (query.reason) builder = builder.contains('reasons', [query.reason]);
  if (query.language) builder = builder.eq('query_language', query.language);
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    if (!cursor) return { ok: false, reason: 'invalid_cursor' };
    builder = builder.or(`mined_at.lt."${cursor.minedAt}",and(mined_at.eq."${cursor.minedAt}",id.lt.${cursor.id})`);
  }
  const { data, error } = await builder
    .order('mined_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(REVIEW_PAGE_SIZE + 1);
  if (error) throw new Error('review_items_read_failed');
  const rows = ((data ?? []) as unknown as Row[]).slice(0, REVIEW_PAGE_SIZE + 1);
  const page = rows.slice(0, REVIEW_PAGE_SIZE);
  const items: ReviewItem[] = [];
  for (const row of page) {
    const item = toReviewItem(row, null);
    if (item) items.push(item);
  }
  const last = page[page.length - 1];
  const next_cursor =
    rows.length > REVIEW_PAGE_SIZE && last && typeof last.mined_at === 'string' && typeof last.id === 'string'
      ? encodeCursor(last.mined_at, last.id)
      : null;
  return { ok: true, items, next_cursor };
}

/** The item as RLS lets the caller see it, with the internal link columns; null when missing or not visible. */
async function readVisibleItem(ssr: Client, id: string): Promise<Row | null> {
  if (!isReviewItemId(id)) return null;
  const { data, error } = await ssr.from('rag_review_items').select(DETAIL_COLUMNS.join(',')).eq('id', id.toLowerCase()).maybeSingle();
  if (error) throw new Error('review_item_read_failed');
  return (data as unknown as Row | null) ?? null;
}

function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => (part && typeof part === 'object' && (part as Row).type === 'text' ? (part as Row).text : null))
    .filter((text): text is string => typeof text === 'string');
  return parts.length > 0 ? parts.join('\n') : null;
}

async function loggedAnswerId(admin: Client, item: Row): Promise<string | null> {
  if (!isReviewItemId(item.retrieval_log_id)) return null;
  const { data, error } = await admin
    .from('rag_retrieval_log')
    .select('answer_id,tenant_key')
    .eq('id', item.retrieval_log_id)
    .eq('tenant_key', item.tenant_key as string)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as Row;
  return row.tenant_key === item.tenant_key && isReviewItemId(row.answer_id) ? row.answer_id.toLowerCase() : null;
}

/**
 * The masked answer of a chat item: the assistant message of the item's own chat row (from the item, never from the request) whose
 * metadata carries the item's trace id or logged answer id. The chat must belong to the item's user.
 */
async function linkedAnswer(admin: Client, item: Row): Promise<string | null> {
  if (item.channel !== 'chat' || !isReviewItemId(item.chat_id) || !isReviewItemId(item.user_id)) return null;
  const { data, error } = await admin.from('chats').select('id,user_id,messages').eq('id', item.chat_id).maybeSingle();
  if (error || !data) return null;
  const chat = data as unknown as Row;
  if (typeof chat.user_id !== 'string' || chat.user_id.toLowerCase() !== item.user_id.toLowerCase()) return null;
  if (!Array.isArray(chat.messages)) return null;
  const traceId = typeof item.trace_id === 'string' && item.trace_id !== '' ? item.trace_id : null;
  const answerId = await loggedAnswerId(admin, item);
  for (const message of chat.messages as unknown[]) {
    if (!message || typeof message !== 'object') continue;
    const { role, metadata, content } = message as Row;
    if (role !== 'assistant' || !metadata || typeof metadata !== 'object') continue;
    const meta = metadata as Row;
    const byTrace = traceId !== null && meta.ragTraceId === traceId;
    const byAnswer = answerId !== null && typeof meta.answerId === 'string' && meta.answerId.toLowerCase() === answerId;
    if (!byTrace && !byAnswer) continue;
    const text = messageText(content);
    return text === null ? null : maskPII(text).slice(0, MAX_ANSWER_LENGTH);
  }
  return null;
}

export type GetReviewItemResult = { ok: true; item: ReviewItem } | { ok: false; reason: 'not_found' | 'invalid_item' };

export async function getReviewItem(ssr: Client, admin: Client, id: string): Promise<GetReviewItemResult> {
  const row = await readVisibleItem(ssr, id);
  if (!row) return { ok: false, reason: 'not_found' };
  let answer: string | null = null;
  try {
    answer = await linkedAnswer(admin, row);
  } catch {
    console.error('[Review] linked answer read failed', { item: hashForLog(String(row.id)) });
  }
  const item = toReviewItem(row, answer);
  return item ? { ok: true, item } : { ok: false, reason: 'invalid_item' };
}

export interface ReviewChunk {
  chunk_id: string;
  document_id: string;
  available: boolean;
  document_name?: string;
  section?: string;
  text?: string;
}

export type GetReviewItemChunksResult = { ok: true; item_id: string; chunks: ReviewChunk[] } | { ok: false; reason: 'not_found' };

interface SnapshotRef {
  chunkId: string;
  documentId: string;
}

function snapshotRefs(candidates: unknown): SnapshotRef[] {
  if (!Array.isArray(candidates)) return [];
  const seen = new Set<string>();
  const refs: SnapshotRef[] = [];
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    const { chunk_id: chunkId, document_id: documentId } = entry as Row;
    if (typeof chunkId !== 'string' || chunkId === '' || typeof documentId !== 'string' || seen.has(chunkId)) continue;
    seen.add(chunkId);
    refs.push({ chunkId, documentId });
  }
  return refs.slice(0, REVIEW_PAGE_SIZE);
}

/**
 * Chunk text for the expert's evidence. The item is read through RLS first; only then does the admin client fetch the chunk ids of
 * that item's snapshot, restricted to the item's tenant_key and to current, ready rows of current, ready documents (D-08), so a
 * quarantined, superseded or other-tenant chunk is reported unavailable without text.
 */
export async function getReviewItemChunks(
  ssr: Client,
  admin: Client,
  id: string,
  expertId: string,
): Promise<GetReviewItemChunksResult> {
  void ssr;
  void admin;
  void id;
  void expertId;
  return { ok: false, reason: 'not_found' };
}

// --- Domain-expert grants (operator admins only, admin client) ---

export type GrantValidation = { ok: true; tenantKey: string } | { ok: false; reason: 'invalid_tenant_key' | 'tenant_key_mode' };

/** parseTenantKey plus the deployment mode: single-tenant accepts only s:default, multi-tenant only u: and o: keys. */
export function validateGrantTenantKey(value: unknown, mode: DeploymentMode): GrantValidation {
  const parsed = parseTenantKey(value);
  if (!parsed || typeof value !== 'string') return { ok: false, reason: 'invalid_tenant_key' };
  const tenantKey = value.trim().toLowerCase();
  if (mode === 'single-tenant' ? parsed.kind !== 'single' : parsed.kind === 'single') return { ok: false, reason: 'tenant_key_mode' };
  return { ok: true, tenantKey };
}

export function maskEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return '***';
  return `***@${email.slice(at + 1).toLowerCase()}`;
}

async function userExists(admin: Client, userId: string): Promise<{ exists: boolean; email: string | null }> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data?.user) return { exists: false, email: null };
  return { exists: true, email: data.user.email ?? null };
}

export type GrantResult = { ok: true; created: boolean } | { ok: false; reason: 'unknown_user' };

export async function grantDomainExpert(admin: Client, input: { tenantKey: string; userId: string; grantedBy: string }): Promise<GrantResult> {
  const userId = input.userId.toLowerCase();
  const user = await userExists(admin, userId);
  if (!user.exists) return { ok: false, reason: 'unknown_user' };
  const existing = await admin
    .from('rag_domain_experts')
    .select('tenant_key,user_id')
    .eq('tenant_key', input.tenantKey)
    .eq('user_id', userId)
    .maybeSingle();
  if (existing.error) throw new Error('domain_expert_read_failed');
  if (existing.data) return { ok: true, created: false };
  const { error } = await admin.from('rag_domain_experts').insert({ tenant_key: input.tenantKey, user_id: userId, granted_by: input.grantedBy });
  if (error) {
    if ((error as { code?: string }).code === '23505') return { ok: true, created: false };
    throw new Error('domain_expert_insert_failed');
  }
  console.log('[Review] grant', { tenant: hashForLog(input.tenantKey), user: hashForLog(userId), admin: input.grantedBy });
  return { ok: true, created: true };
}

export async function revokeDomainExpert(admin: Client, input: { tenantKey: string; userId: string; revokedBy: string }): Promise<void> {
  const userId = input.userId.toLowerCase();
  const { error } = await admin.from('rag_domain_experts').delete().eq('tenant_key', input.tenantKey).eq('user_id', userId);
  if (error) throw new Error('domain_expert_delete_failed');
  console.log('[Review] revoke', { tenant: hashForLog(input.tenantKey), user: hashForLog(userId), admin: input.revokedBy });
}

export interface DomainExpertGrant {
  tenant_key: string;
  user_id: string;
  email: string | null;
  granted_by: string | null;
  created_at: string | null;
}

export async function listDomainExperts(admin: Client, tenantKey: string): Promise<DomainExpertGrant[]> {
  const { data, error } = await admin
    .from('rag_domain_experts')
    .select('tenant_key,user_id,granted_by,created_at')
    .eq('tenant_key', tenantKey)
    .order('created_at', { ascending: true });
  if (error) throw new Error('domain_expert_list_failed');
  const grants: DomainExpertGrant[] = [];
  for (const row of (data ?? []) as unknown as Row[]) {
    const userId = String(row.user_id);
    const user = await userExists(admin, userId);
    grants.push({
      tenant_key: String(row.tenant_key),
      user_id: userId,
      email: maskEmail(user.email),
      granted_by: stringOrNull(row.granted_by),
      created_at: stringOrNull(row.created_at),
    });
  }
  return grants;
}
