import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchServableChunks, hashForLog, isReviewItemId, linkedAnswer } from '@/lib/rag/feedback-loop/review-access';
import { maskPII } from '@/lib/rag/trace/mask';
import { parseTenantKey } from '@/lib/rag/tenant/embed';

/**
 * D-31 calibration export: the expert-labelled answer checks of one tenant, with the question, the answer and the context chunks re-read
 * under that tenant at request time, for `python -m rag_eval.judge_calibration run --tenant`. The tenant must be one the admin
 * administers (rag_admin_tenant_keys, resolved in SQL). Every read runs on the service-role client filtered by that tenant_key, in SQL
 * and again in code. Contexts are the snapshot's kept candidates, read with the current, ready and not-quarantined filter
 * (fetchServableChunks); a case whose answer is gone, or one of whose kept chunks is no longer servable (re-versioned, quarantined,
 * deleted or moved), is skipped and counted. Text goes through maskPII and only into the response; logs carry counts and hashes.
 */

type Client = SupabaseClient;
type Row = Record<string, unknown>;

const PAGE_SIZE = 500;
const ITEM_BATCH = 100;
const MAX_CONTEXTS = 20;

const ITEM_COLUMNS = ['id', 'tenant_key', 'retrieval_log_id', 'trace_id', 'query_masked', 'query_language', 'channel', 'candidates', 'user_id', 'chat_id'];

export interface CalibrationCaseLabel {
  supported: boolean;
  relevant: boolean;
  unsupported_content: boolean;
  labelled_at: string;
}

export interface CalibrationCaseContext {
  chunk_id: string;
  document_id: string;
  text: string;
}

export interface CalibrationCase {
  item_id: string;
  language: string | null;
  question: string;
  answer: string;
  contexts: CalibrationCaseContext[];
  labels: CalibrationCaseLabel[];
}

export interface CalibrationExport {
  tenant_key: string;
  cases: CalibrationCase[];
  skipped: { no_answer: number; changed_chunk: number; no_context: number };
}

export type CalibrationExportResult =
  | { ok: true; export: CalibrationExport }
  | { ok: false; reason: 'invalid_tenant' | 'forbidden_tenant' | 'unavailable' };

async function adminTenantKeys(admin: Client, actorUserId: string): Promise<string[] | null> {
  const { data, error } = await admin.rpc('rag_admin_tenant_keys', { p_actor: actorUserId });
  if (error || !Array.isArray(data)) return null;
  return data.filter((key): key is string => typeof key === 'string');
}

async function tenantLabels(admin: Client, tenantKey: string): Promise<Map<string, CalibrationCaseLabel[]>> {
  const byItem = new Map<string, CalibrationCaseLabel[]>();
  let after: string | null = null;
  for (;;) {
    let builder = admin
      .from('rag_judge_labels')
      .select('id,review_item_id,tenant_key,supported,relevant,unsupported_content,labelled_at')
      .eq('tenant_key', tenantKey);
    if (after) builder = builder.gt('id', after);
    const { data, error } = await builder.order('id', { ascending: true }).limit(PAGE_SIZE);
    if (error) throw new Error('judge_labels_read_failed');
    const rows = (data ?? []) as unknown as Row[];
    for (const row of rows) {
      if (row.tenant_key !== tenantKey || !isReviewItemId(row.review_item_id)) continue;
      if (typeof row.supported !== 'boolean' || typeof row.relevant !== 'boolean' || typeof row.unsupported_content !== 'boolean') continue;
      const itemId = row.review_item_id.toLowerCase();
      const labels = byItem.get(itemId) ?? [];
      labels.push({
        supported: row.supported,
        relevant: row.relevant,
        unsupported_content: row.unsupported_content,
        labelled_at: typeof row.labelled_at === 'string' ? row.labelled_at : '',
      });
      byItem.set(itemId, labels);
    }
    if (rows.length < PAGE_SIZE) break;
    after = String(rows[rows.length - 1].id);
  }
  for (const labels of byItem.values()) labels.sort((a, b) => a.labelled_at.localeCompare(b.labelled_at));
  return byItem;
}

async function tenantItems(admin: Client, tenantKey: string, ids: string[]): Promise<Row[]> {
  const items: Row[] = [];
  for (let start = 0; start < ids.length; start += ITEM_BATCH) {
    const { data, error } = await admin
      .from('rag_review_items')
      .select(ITEM_COLUMNS.join(','))
      .in('id', ids.slice(start, start + ITEM_BATCH))
      .eq('tenant_key', tenantKey);
    if (error) throw new Error('review_items_read_failed');
    for (const row of (data ?? []) as unknown as Row[]) if (row.tenant_key === tenantKey && isReviewItemId(row.id)) items.push(row);
  }
  return items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function keptRefs(candidates: unknown): Array<{ chunkId: string; documentId: string }> {
  if (!Array.isArray(candidates)) return [];
  const seen = new Set<string>();
  const refs: Array<{ chunkId: string; documentId: string }> = [];
  const ordered = candidates
    .filter((entry): entry is Row => !!entry && typeof entry === 'object' && (entry as Row).kept === true)
    .sort((a, b) => Number(a.rank) - Number(b.rank));
  for (const entry of ordered) {
    const { chunk_id: chunkId, document_id: documentId } = entry;
    if (typeof chunkId !== 'string' || typeof documentId !== 'string' || chunkId === '' || seen.has(chunkId.toLowerCase())) continue;
    seen.add(chunkId.toLowerCase());
    refs.push({ chunkId: chunkId.toLowerCase(), documentId: documentId.toLowerCase() });
  }
  return refs.slice(0, MAX_CONTEXTS);
}

export async function exportCalibrationCases(
  admin: Client,
  options: { actorUserId: string; tenantKey: string },
): Promise<CalibrationExportResult> {
  const tenantKey = options.tenantKey;
  if (!parseTenantKey(tenantKey)) return { ok: false, reason: 'invalid_tenant' };
  const keys = await adminTenantKeys(admin, options.actorUserId);
  if (keys === null) return { ok: false, reason: 'unavailable' };
  if (!keys.includes(tenantKey)) return { ok: false, reason: 'forbidden_tenant' };

  const labels = await tenantLabels(admin, tenantKey);
  const items = await tenantItems(admin, tenantKey, [...labels.keys()]);
  const skipped = { no_answer: 0, changed_chunk: 0, no_context: 0 };
  const cases: CalibrationCase[] = [];

  for (let start = 0; start < items.length; start += 50) {
    const page = items.slice(start, start + 50);
    const servable = await fetchServableChunks(
      admin,
      tenantKey,
      page.flatMap((item) => keptRefs(item.candidates).map((ref) => ref.chunkId)),
    );
    for (const item of page) {
      const question = typeof item.query_masked === 'string' && item.query_masked !== '' ? maskPII(item.query_masked) : null;
      let answer: string | null = null;
      try {
        answer = await linkedAnswer(admin, item);
      } catch {
        answer = null;
      }
      if (question === null || answer === null || answer === '') {
        skipped.no_answer += 1;
        continue;
      }
      const refs = keptRefs(item.candidates);
      if (refs.length === 0) {
        skipped.no_context += 1;
        continue;
      }
      const contexts: CalibrationCaseContext[] = [];
      for (const ref of refs) {
        const chunk = servable.get(ref.chunkId);
        if (!chunk || chunk.document_id !== ref.documentId) break;
        contexts.push({ chunk_id: chunk.chunk_id, document_id: chunk.document_id, text: maskPII(chunk.text) });
      }
      if (contexts.length !== refs.length) {
        skipped.changed_chunk += 1;
        continue;
      }
      const id = String(item.id).toLowerCase();
      cases.push({
        item_id: id,
        language: typeof item.query_language === 'string' ? item.query_language : null,
        question,
        answer,
        contexts,
        labels: labels.get(id) ?? [],
      });
    }
  }

  console.log('[Review] calibration export', { tenant: hashForLog(tenantKey), count: cases.length, skipped });
  return { ok: true, export: { tenant_key: tenantKey, cases, skipped } };
}
