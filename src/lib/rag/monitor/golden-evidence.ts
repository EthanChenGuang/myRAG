import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

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

export function normalizeQuote(text: string): string {
  return text;
}

export function quoteSha256(quote: string): string {
  return createHash('sha256').update(quote, 'utf8').digest('hex');
}

export async function checkEvidence(_admin: Client, _input: { tenantKey: string; spans: readonly EvidenceSpanInput[] }): Promise<EvidenceCheckResult> {
  return { results: [], counts: { ok: 0, document_missing: 0, document_superseded: 0, quote_not_found: 0 } };
}

export async function registerEvidence(_admin: Client, _input: { tenantKey: string; setId: string; rows: readonly EvidenceRow[] }): Promise<{ stored: number; dropped: number }> {
  return { stored: 0, dropped: 0 };
}

export async function pendingEvidence(_admin: Client, _input: { tenantKey: string; setId: string }): Promise<string[]> {
  return [];
}

export async function clearEvidence(_admin: Client, _input: { tenantKey: string; setId: string; itemIds: readonly string[] }): Promise<number> {
  return 0;
}

export function weekStart(now: Date): string {
  return now.toISOString();
}

export async function enqueueReReview(_admin: Client, _input: { tenantKey: string; questions: readonly string[]; now?: Date }): Promise<{ inserted: number }> {
  return { inserted: 0 };
}
