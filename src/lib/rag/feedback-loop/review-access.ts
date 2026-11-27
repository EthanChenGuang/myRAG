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

const REVIEW_REASONS = [
  'feedback_negative',
  'refusal_disputed',
  'groundedness_flagged',
  'refused_high_score',
  'zero_results',
  'low_score',
  'no_source_opened',
  'claim_unsupported',
  'output_guard',
  'version_conflict',
  'representative',
  're_review',
] as const;
/** rag_review_item_strata.source (0967); a mined item has none. */
export const REVIEW_SOURCES = ['representative', 'pilot', 'drift_fill', 'historical'] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export const ReviewListQuerySchema = z
  .object({
    status: ReviewItemSchema.shape.status.optional(),
    reason: z.enum(REVIEW_REASONS).optional(),
    source: z.enum(REVIEW_SOURCES).optional(),
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

/**
 * D-25, A-06 (04.3-13): with access groups on, a review item whose access_sets the caller does not cover is hidden from the caller's SSR
 * read by the restrictive policy rag_review_items_access_sets. An expert of the item's tenant still learns that the item exists: the
 * server reader adds it with its content masked (no query, candidates, label or answer). Experts are confirmed with the caller's own
 * rag_is_domain_expert call; the admin client only reads rows of those tenants that carry access_sets.
 */
export interface MaskedReviewOptions {
  admin: Client;
  userId: string;
}

function maskReviewItem(item: ReviewItem): ReviewItem {
  return { ...item, query_masked: null, candidates: [], label: null, answer_masked: null };
}

async function expertTenants(ssr: Client, admin: Client, userId: string): Promise<string[]> {
  const candidates = new Set<string>(['s:default']);
  const { data, error } = await admin.from('rag_domain_experts').select('tenant_key').eq('user_id', userId);
  if (error) throw new Error('review_expert_read_failed');
  for (const row of (data ?? []) as Row[]) if (typeof row.tenant_key === 'string') candidates.add(row.tenant_key);
  const tenants: string[] = [];
  for (const tenantKey of candidates) {
    const { data: expert, error: expertError } = await ssr.rpc('rag_is_domain_expert', { p_tenant_key: tenantKey });
    if (expertError) throw new Error('review_expert_check_failed');
    if (expert === true) tenants.push(tenantKey);
  }
  return tenants;
}

function rowOrder(a: Row, b: Row): number {
  const left = String(a.mined_at ?? '');
  const right = String(b.mined_at ?? '');
  if (left !== right) return Date.parse(right) - Date.parse(left) || (left < right ? 1 : -1);
  return String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0;
}

export type ListReviewItemsResult =
  | { ok: true; items: ReviewItem[]; next_cursor: string | null }
  | { ok: false; reason: 'invalid_cursor' };

/** Newest first by (mined_at, id); the opaque cursor is the last returned pair. Reads with the caller's SSR client only. */
export async function listReviewItems(ssr: Client, query: ReviewListQuery, masked?: MaskedReviewOptions): Promise<ListReviewItemsResult> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false, reason: 'invalid_cursor' };
  const filtered = (client: Client) => {
    let builder = client.from('rag_review_items').select(ITEM_COLUMNS.join(','));
    if (query.status) builder = builder.eq('status', query.status);
    if (query.reason) builder = builder.contains('reasons', [query.reason]);
    if (query.language) builder = builder.eq('query_language', query.language);
    if (cursor) builder = builder.or(`mined_at.lt."${cursor.minedAt}",and(mined_at.eq."${cursor.minedAt}",id.lt.${cursor.id})`);
    return builder;
  };
  const { data, error } = await filtered(ssr)
    .order('mined_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(REVIEW_PAGE_SIZE + 1);
  if (error) throw new Error('review_items_read_failed');
  let rows = ((data ?? []) as unknown as Row[]).slice(0, REVIEW_PAGE_SIZE + 1);
  const hidden = new Set<string>();
  if (masked) {
    const tenants = await expertTenants(ssr, masked.admin, masked.userId);
    if (tenants.length > 0) {
      const { data: extra, error: extraError } = await filtered(masked.admin)
        .in('tenant_key', tenants)
        .not('access_sets', 'is', null)
        .order('mined_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(REVIEW_PAGE_SIZE + 1);
      if (extraError) throw new Error('review_items_read_failed');
      const seen = new Set(rows.map((row) => String(row.id)));
      for (const row of (extra ?? []) as unknown as Row[]) {
        if (seen.has(String(row.id))) continue;
        hidden.add(String(row.id));
        rows.push(row);
      }
      rows = rows.sort(rowOrder).slice(0, REVIEW_PAGE_SIZE + 1);
    }
  }
  const page = rows.slice(0, REVIEW_PAGE_SIZE);
  const items: ReviewItem[] = [];
  for (const row of page) {
    const item = toReviewItem(row, null);
    if (item) items.push(hidden.has(String(row.id)) ? maskReviewItem(item) : item);
  }
  const last = page[page.length - 1];
  const next_cursor =
    rows.length > REVIEW_PAGE_SIZE && last && typeof last.mined_at === 'string' && typeof last.id === 'string'
      ? encodeCursor(last.mined_at, last.id)
      : null;
  return { ok: true, items, next_cursor };
}

const SOURCE_SCAN_PAGES = 10;

function isReviewSource(value: unknown): value is ReviewSource {
  return typeof value === 'string' && (REVIEW_SOURCES as readonly string[]).includes(value);
}

/**
 * D-41, D-55, research X-9: adds each item's rag_review_item_strata source (null for mined items). Only items already read under
 * the caller's RLS are passed in; the admin read is limited to exactly their ids and, per tenant, to that tenant_key, and the
 * tenant is checked again in code. A failed read leaves source null: it is shown, never used for access.
 */
export async function attachReviewSources(admin: Client, items: ReviewItem[]): Promise<ReviewItem[]> {
  const byTenant = new Map<string, string[]>();
  for (const item of items) {
    if (!parseTenantKey(item.tenant_key) || !isReviewItemId(item.id)) continue;
    const ids = byTenant.get(item.tenant_key) ?? [];
    ids.push(item.id.toLowerCase());
    byTenant.set(item.tenant_key, ids);
  }
  const sources = new Map<string, ReviewSource>();
  for (const [tenantKey, ids] of byTenant) {
    const wanted = new Set(ids);
    const { data, error } = await admin
      .from('rag_review_item_strata')
      .select('review_item_id,tenant_key,source')
      .in('review_item_id', [...wanted])
      .eq('tenant_key', tenantKey);
    if (error) {
      console.error('[Review] strata read failed', { tenant: hashForLog(tenantKey), count: wanted.size });
      continue;
    }
    for (const row of (data ?? []) as unknown as Row[]) {
      const id = typeof row.review_item_id === 'string' ? row.review_item_id.toLowerCase() : null;
      if (id && wanted.has(id) && row.tenant_key === tenantKey && isReviewSource(row.source)) sources.set(`${tenantKey}|${id}`, row.source);
    }
  }
  return items.map((item) => ({ ...item, source: sources.get(`${item.tenant_key}|${item.id.toLowerCase()}`) ?? null }));
}

/**
 * The review list with each item's source. A source filter is applied after the strata read, page by page of the RLS list (at most
 * SOURCE_SCAN_PAGES pages per call), so strata are only ever read for visible items; next_cursor continues the scan.
 */
export async function listReviewItemsWithSource(
  ssr: Client,
  admin: Client,
  query: ReviewListQuery,
  masked?: MaskedReviewOptions,
): Promise<ListReviewItemsResult> {
  const { source, ...rest } = query;
  if (!source) {
    const page = await listReviewItems(ssr, rest, masked);
    if (!page.ok) return page;
    return { ok: true, items: await attachReviewSources(admin, page.items), next_cursor: page.next_cursor };
  }
  const items: ReviewItem[] = [];
  let cursor = rest.cursor;
  for (let scanned = 0; scanned < SOURCE_SCAN_PAGES; scanned += 1) {
    const page = await listReviewItems(ssr, { ...rest, ...(cursor ? { cursor } : {}) }, masked);
    if (!page.ok) return page;
    for (const item of await attachReviewSources(admin, page.items)) {
      if (item.source !== source) continue;
      items.push(item);
      if (items.length === REVIEW_PAGE_SIZE) {
        const last = page.items[page.items.length - 1];
        const more = page.next_cursor !== null || last.id !== item.id;
        return { ok: true, items, next_cursor: more ? encodeCursor(item.mined_at, item.id) : null };
      }
    }
    if (!page.next_cursor) return { ok: true, items, next_cursor: null };
    cursor = page.next_cursor;
  }
  return { ok: true, items, next_cursor: cursor ?? null };
}

export async function getReviewItemWithSource(
  ssr: Client,
  admin: Client,
  id: string,
  masked?: MaskedReviewOptions,
): Promise<GetReviewItemResult> {
  const result = await getReviewItem(ssr, admin, id, masked);
  if (!result.ok) return result;
  const [item] = await attachReviewSources(admin, [result.item]);
  return { ok: true, item };
}

/** The item as RLS lets the caller see it, with the internal link columns; null when missing or not visible. */
export async function readVisibleItem(ssr: Client, id: string): Promise<Row | null> {
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
export async function linkedAnswer(admin: Client, item: Row): Promise<string | null> {
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

export async function getReviewItem(ssr: Client, admin: Client, id: string, masked?: MaskedReviewOptions): Promise<GetReviewItemResult> {
  const row = await readVisibleItem(ssr, id);
  if (!row) {
    if (!masked || !isReviewItemId(id)) return { ok: false, reason: 'not_found' };
    const { data, error } = await masked.admin
      .from('rag_review_items')
      .select(ITEM_COLUMNS.join(','))
      .eq('id', id.toLowerCase())
      .not('access_sets', 'is', null)
      .maybeSingle();
    if (error) throw new Error('review_item_read_failed');
    const hiddenRow = (data as unknown as Row | null) ?? null;
    if (!hiddenRow || typeof hiddenRow.tenant_key !== 'string') return { ok: false, reason: 'not_found' };
    const { data: expert, error: expertError } = await ssr.rpc('rag_is_domain_expert', { p_tenant_key: hiddenRow.tenant_key });
    if (expertError) throw new Error('review_expert_check_failed');
    if (expert !== true) return { ok: false, reason: 'not_found' };
    const item = toReviewItem(hiddenRow, null);
    return item ? { ok: true, item: maskReviewItem(item) } : { ok: false, reason: 'invalid_item' };
  }
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

export function snapshotRefs(candidates: unknown): SnapshotRef[] {
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

export interface ServableChunk {
  chunk_id: string;
  document_id: string;
  document_name: string;
  section: string;
  text: string;
}

/**
 * Admin-client read of chunk ids restricted to one tenant_key and to current, ready rows of current, ready documents (D-08), so a
 * quarantined, superseded or other-tenant chunk is simply absent from the map. The filters run in SQL and again in code. Keys are
 * lower-case chunk ids; ids that are not UUIDs are never queried.
 */
export async function fetchServableChunks(admin: Client, tenantKey: string, ids: readonly string[]): Promise<Map<string, ServableChunk>> {
  const servable = new Map<string, ServableChunk>();
  const chunkIds = [...new Set(ids.map((chunkId) => chunkId.toLowerCase()).filter((chunkId) => UUID_RE.test(chunkId)))];
  if (chunkIds.length === 0 || !parseTenantKey(tenantKey)) return servable;
  const { data, error } = await admin
    .from('document_chunks')
    .select('id,document_id,content,section_path,tenant_key,is_current,status')
    .in('id', chunkIds)
    .eq('tenant_key', tenantKey)
    .eq('is_current', true)
    .eq('status', 'ready');
  if (error) throw new Error('review_chunks_read_failed');
  const chunks = new Map<string, Row>();
  for (const row of (data ?? []) as unknown as Row[]) {
    if (row.tenant_key === tenantKey && row.is_current === true && row.status === 'ready' && typeof row.content === 'string') {
      chunks.set(String(row.id).toLowerCase(), row);
    }
  }
  const documentIds = [...new Set([...chunks.values()].map((row) => String(row.document_id).toLowerCase()))];
  const documents = new Map<string, Row>();
  if (documentIds.length > 0) {
    const { data: docs, error: docError } = await admin
      .from('documents')
      .select('id,filename,tenant_key,is_current,status')
      .in('id', documentIds)
      .eq('tenant_key', tenantKey)
      .eq('is_current', true)
      .eq('status', 'ready');
    if (docError) throw new Error('review_documents_read_failed');
    for (const row of (docs ?? []) as unknown as Row[]) {
      if (row.tenant_key === tenantKey && row.is_current === true && row.status === 'ready') documents.set(String(row.id).toLowerCase(), row);
    }
  }
  for (const [chunkId, chunk] of chunks) {
    const documentId = String(chunk.document_id).toLowerCase();
    const document = documents.get(documentId);
    if (!document) continue;
    servable.set(chunkId, {
      chunk_id: chunkId,
      document_id: documentId,
      document_name: typeof document.filename === 'string' ? document.filename : '',
      section: stringArray(chunk.section_path).join(' > '),
      text: chunk.content as string,
    });
  }
  return servable;
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
  const item = await readVisibleItem(ssr, id);
  if (!item) return { ok: false, reason: 'not_found' };
  const tenantKey = item.tenant_key;
  if (typeof tenantKey !== 'string' || !parseTenantKey(tenantKey)) return { ok: false, reason: 'not_found' };

  const refs = snapshotRefs(item.candidates);
  const servable = await fetchServableChunks(
    admin,
    tenantKey,
    refs.map((ref) => ref.chunkId),
  );

  const result: ReviewChunk[] = refs.map((ref) => {
    const chunk = servable.get(ref.chunkId.toLowerCase());
    if (!chunk || chunk.document_id !== ref.documentId.toLowerCase()) {
      return { chunk_id: ref.chunkId, document_id: ref.documentId, available: false };
    }
    return {
      chunk_id: ref.chunkId,
      document_id: ref.documentId,
      available: true,
      document_name: chunk.document_name,
      section: chunk.section,
      text: chunk.text,
    };
  });
  const count = result.filter((entry) => entry.available).length;
  console.log('[Review] chunks', { expert: expertId, item: hashForLog(String(item.id)), count });
  return { ok: true, item_id: String(item.id), chunks: result };
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
