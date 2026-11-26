import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { maskPII } from '@/lib/rag/trace/mask';
import { fingerprintMaskedQuery } from '@/lib/rag/feedback-loop/retrieval-log';

/**
 * Golden-set evidence for real sets (Phase 5.3 D-48 to D-50). A gold span names a document and quotes it; the check resolves the name
 * to the current, ready (not quarantined, not pending review) version under the item's tenant only, reads its current chunks with the
 * service-role client and compares the quote after the same normalisation as Python `normalize_text`. Responses carry status codes,
 * item ids and document ids; never a quote, chunk text or document name. Logs carry counts only.
 */

type Client = Pick<SupabaseClient, 'from' | 'rpc'>;
type Row = Record<string, unknown>;

export type EvidenceStatus = 'ok' | 'document_missing' | 'document_superseded' | 'quote_not_found';

export const EVIDENCE_STATUSES: readonly EvidenceStatus[] = ['ok', 'document_missing', 'document_superseded', 'quote_not_found'];
export const MAX_EVIDENCE_SPANS = 500;
export const MAX_QUOTE_CHARS = 4000;
export const MAX_DOCUMENT_NAME_CHARS = 500;
export const MAX_REGISTER_ROWS = 20000;
export const MAX_RE_REVIEW_ITEMS = 100;
const MAX_MASKED_QUERY = 2000;
const PAGE_SIZE = 1000;

export interface EvidenceSpanInput {
  item_id: string;
  document: string;
  quote: string;
}

export interface EvidenceSpanResult {
  item_id: string;
  status: EvidenceStatus;
  document_id: string | null;
}

export interface EvidenceCheckResult {
  results: EvidenceSpanResult[];
  counts: Record<EvidenceStatus, number>;
}

export interface EvidenceRow {
  item_id: string;
  document_id: string;
  quote_sha256: string;
}

const SPACE_RE = /\s/u;
const PUNCT_RE = /\p{P}/u;

/** Python str.isspace also holds the information separators U+001C to U+001F and NEL (U+0085). */
function isSpace(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return SPACE_RE.test(char) || (code >= 0x1c && code <= 0x1f) || code === 0x85;
}
const FULL_FOLDS: Record<string, string> = { 'ß': 'ss', 'ẞ': 'ss', 'ς': 'σ', 'ϐ': 'β', 'ϑ': 'θ', 'ϕ': 'φ', 'ϖ': 'π', 'ϰ': 'κ', 'ϱ': 'ρ', 'ϵ': 'ε', 'ẛ': 'ṡ' };

/** TypeScript twin of `rag_eval.matching.normalize_text`: NFKC, case fold, then drop whitespace and punctuation (shared vectors). */
export function normalizeQuote(text: string): string {
  const folded = text.normalize('NFKC').toLowerCase();
  let out = '';
  for (const char of folded) {
    const mapped = FULL_FOLDS[char] ?? char;
    for (const c of mapped) {
      if (isSpace(c) || PUNCT_RE.test(c)) continue;
      out += c;
    }
  }
  return out;
}

export function quoteSha256(quote: string): string {
  return createHash('sha256').update(normalizeQuote(quote), 'utf8').digest('hex');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function sameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

function normalizeName(value: string): string {
  let out = '';
  for (const char of value.normalize('NFKC').toLowerCase()) out += FULL_FOLDS[char] ?? char;
  return out;
}

interface DocumentVersion {
  id: string;
  isCurrent: boolean;
  status: string;
}

async function documentsNamed(admin: Client, tenantKey: string, name: string): Promise<DocumentVersion[]> {
  const versions: DocumentVersion[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from('documents')
      .select('id,filename,tenant_key,is_current,status')
      .eq('tenant_key', tenantKey)
      .ilike('filename', escapeLike(name))
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error('golden_documents_read_failed');
    const rows = (data ?? []) as unknown as Row[];
    for (const row of rows) {
      if (row.tenant_key !== tenantKey || typeof row.filename !== 'string' || !sameName(row.filename, name)) continue;
      versions.push({ id: String(row.id).toLowerCase(), isCurrent: row.is_current === true, status: String(row.status ?? '') });
    }
    if (rows.length < PAGE_SIZE) return versions;
  }
}

async function documentText(admin: Client, tenantKey: string, documentId: string): Promise<string> {
  const parts: string[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from('document_chunks')
      .select('id,document_id,tenant_key,is_current,status,content,chunk_index')
      .eq('document_id', documentId)
      .eq('tenant_key', tenantKey)
      .eq('is_current', true)
      .eq('status', 'ready')
      .order('chunk_index', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error('golden_chunks_read_failed');
    const rows = (data ?? []) as unknown as Row[];
    for (const row of rows) {
      if (row.tenant_key !== tenantKey || row.is_current !== true || row.status !== 'ready' || typeof row.content !== 'string') continue;
      if (String(row.document_id).toLowerCase() !== documentId) continue;
      parts.push(row.content);
    }
    if (rows.length < PAGE_SIZE) return normalizeQuote(parts.join('\n\n'));
  }
}

/** One status per span, in request order. Every read is filtered by the tenant key, in the query and again in code. */
export async function checkEvidence(admin: Client, input: { tenantKey: string; spans: readonly EvidenceSpanInput[] }): Promise<EvidenceCheckResult> {
  const { tenantKey } = input;
  const byName = new Map<string, DocumentVersion[]>();
  const texts = new Map<string, string>();
  const counts: Record<EvidenceStatus, number> = { ok: 0, document_missing: 0, document_superseded: 0, quote_not_found: 0 };
  const results: EvidenceSpanResult[] = [];

  for (const span of input.spans) {
    const key = normalizeName(span.document);
    let versions = byName.get(key);
    if (!versions) {
      versions = await documentsNamed(admin, tenantKey, span.document);
      byName.set(key, versions);
    }
    const servable = versions.filter((version) => version.isCurrent && version.status === 'ready');
    let result: EvidenceSpanResult;
    if (servable.length > 0) {
      const quote = normalizeQuote(span.quote);
      let found: string | null = null;
      for (const version of servable) {
        let text = texts.get(version.id);
        if (text === undefined) {
          text = await documentText(admin, tenantKey, version.id);
          texts.set(version.id, text);
        }
        if (quote.length > 0 && text.includes(quote)) {
          found = version.id;
          break;
        }
      }
      result = found
        ? { item_id: span.item_id, status: 'ok', document_id: found }
        : { item_id: span.item_id, status: 'quote_not_found', document_id: servable[0].id };
    } else {
      const superseded = versions.find((version) => !version.isCurrent);
      result = superseded
        ? { item_id: span.item_id, status: 'document_superseded', document_id: superseded.id }
        : { item_id: span.item_id, status: 'document_missing', document_id: versions[0]?.id ?? null };
    }
    counts[result.status] += 1;
    results.push(result);
  }
  console.log('[Monitor] golden evidence checked', { spans: results.length, ...counts });
  return { results, counts };
}

export async function registerEvidence(
  admin: Client,
  input: { tenantKey: string; setId: string; rows: readonly EvidenceRow[] },
): Promise<{ stored: number; dropped: number }> {
  const { data, error } = await admin.rpc('rag_golden_evidence_register', {
    p_tenant_key: input.tenantKey,
    p_set_id: input.setId,
    p_rows: input.rows,
  });
  if (error) throw new Error('golden_evidence_register_failed');
  const row = (Array.isArray(data) ? data[0] : data) as Row | null | undefined;
  const stored = Number(row?.stored ?? 0);
  const dropped = Number(row?.dropped ?? 0);
  console.log('[Monitor] golden evidence registered', { rows: input.rows.length, stored, dropped });
  return { stored, dropped };
}

export async function pendingEvidence(admin: Client, input: { tenantKey: string; setId: string }): Promise<string[]> {
  const { data, error } = await admin.rpc('rag_golden_evidence_pending', { p_tenant_key: input.tenantKey, p_set_id: input.setId });
  if (error) throw new Error('golden_evidence_pending_failed');
  const list = Array.isArray(data) ? data : data === null || data === undefined ? [] : [data];
  const ids = [...new Set(list.filter((value): value is string => typeof value === 'string'))].sort();
  console.log('[Monitor] golden evidence pending', { items: ids.length });
  return ids;
}

export async function clearEvidence(admin: Client, input: { tenantKey: string; setId: string; itemIds: readonly string[] }): Promise<number> {
  if (input.itemIds.length === 0) return 0;
  const { data, error } = await admin.rpc('rag_golden_evidence_clear', {
    p_tenant_key: input.tenantKey,
    p_set_id: input.setId,
    p_item_ids: [...input.itemIds],
  });
  if (error) throw new Error('golden_evidence_clear_failed');
  const cleared = Number(data ?? 0);
  console.log('[Monitor] golden evidence cleared', { items: input.itemIds.length, cleared });
  return cleared;
}

/** Monday 00:00 UTC of the week holding `now`: the mining window of a weekly re-review batch. */
export function weekStart(now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return day.toISOString();
}

/** Queue golden questions for expert re-review (reason re_review). Masked and fingerprinted as the 5.1.1 log does; idempotent per week. */
export async function enqueueReReview(
  admin: Client,
  input: { tenantKey: string; questions: readonly string[]; now?: Date },
): Promise<{ inserted: number }> {
  const window = weekStart(input.now ?? new Date());
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const question of input.questions) {
    const masked = maskPII(question).slice(0, MAX_MASKED_QUERY);
    if (masked.trim().length === 0) continue;
    const fingerprint = fingerprintMaskedQuery(masked);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    rows.push({ query_masked: masked, query_fingerprint: fingerprint, mining_window: window });
  }
  if (rows.length === 0) return { inserted: 0 };
  const { data, error } = await admin.rpc('rag_review_items_enqueue_re_review', { p_tenant_key: input.tenantKey, p_rows: rows });
  if (error) throw new Error('golden_re_review_enqueue_failed');
  const inserted = Number(data ?? 0);
  console.log('[Monitor] golden re-review queued', { items: rows.length, inserted });
  return { inserted };
}
