import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerRecordRow } from './store';

export type DocumentAvailability = 'current' | 'unavailable';

/** A record still pending this long after creation is reported as not_checked/expired (D-15). */
export const ANSWER_PENDING_EXPIRY_MS = 120_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DOCUMENT_IDS = 1000;

export function answerFeedbackEnabled(): boolean {
  return process.env.RAG_ANSWER_FEEDBACK === 'true';
}

function isoOf(value: unknown): string {
  if (typeof value !== 'string' && !(value instanceof Date)) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function objectOr(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The document ids the record's citation snapshots point at. */
export function citedDocumentIds(row: Pick<AnswerRecordRow, 'citations'>): string[] {
  if (!Array.isArray(row.citations)) return [];
  const ids = new Set<string>();
  for (const citation of row.citations) {
    const documentId = objectOr(citation)?.documentId;
    if (typeof documentId === 'string' && documentId.length > 0) ids.add(documentId);
  }
  return [...ids];
}

function groundednessAt(stored: unknown, createdAtMs: number, now: Date): Record<string, unknown> {
  const value = objectOr(stored);
  const status = value?.status ?? 'pending';
  if (status === 'pending' && Number.isFinite(createdAtMs) && now.getTime() - createdAtMs >= ANSWER_PENDING_EXPIRY_MS) {
    return { status: 'not_checked', label: 'not_checked', reason: 'expired', truncated: false };
  }
  return value && 'status' in value ? value : { ...(value ?? {}), status: 'pending' };
}

/**
 * The wire shape of a stored row, before AnswerRecordSchema validation. Applies the expiry rule at read time;
 * never writes. Citations are returned as stored (the snapshot), documents as computed by documentStatuses.
 */
export function toAnswerRecord(
  row: AnswerRecordRow,
  now: Date,
  documents: Record<string, DocumentAvailability>,
  options: { feedbackEnabled: boolean },
): Record<string, unknown> {
  const createdAt = isoOf(row.created_at);
  const cited = citedDocumentIds(row);
  return {
    answerId: row.id,
    chatId: row.chat_id,
    traceId: row.trace_id,
    modelId: row.model_id,
    citationStrategy: row.citation_strategy,
    ragMode: row.rag_mode,
    answerLanguage: row.answer_language,
    invalidCitations: row.invalid_citations,
    citations: Array.isArray(row.citations) ? row.citations : [],
    groundedness: groundednessAt(row.groundedness, createdAt ? Date.parse(createdAt) : Number.NaN, now),
    feedback: row.feedback ?? null,
    documents: Object.fromEntries(cited.map((id) => [id, documents[id] === 'current' ? 'current' : 'unavailable'])),
    feedbackEnabled: options.feedbackEnabled,
    createdAt,
    updatedAt: isoOf(row.updated_at),
  };
}

/**
 * current while the documents row is visible to the client (the session client in routes, so documents RLS applies),
 * is_current and not deleted; otherwise unavailable. Reads documents rows by id only, never chunks.
 */
export async function documentStatuses(client: SupabaseClient, documentIds: string[]): Promise<Record<string, DocumentAvailability>> {
  const statuses: Record<string, DocumentAvailability> = {};
  for (const id of documentIds) statuses[id] = 'unavailable';
  const lookups = [...new Set(documentIds.filter((id) => UUID_RE.test(id)))].slice(0, MAX_DOCUMENT_IDS);
  if (lookups.length === 0) return statuses;
  const { data, error } = await client.from('documents').select('id,is_current,status').in('id', lookups);
  if (error) {
    console.warn('[RAG Answers] document status lookup failed', { code: error.code });
    return statuses;
  }
  for (const row of (data ?? []) as Array<{ id: string; is_current: boolean | null; status: string | null }>) {
    if (row.is_current === true && row.status !== 'deleted') {
      for (const id of documentIds) if (id.toLowerCase() === String(row.id).toLowerCase()) statuses[id] = 'current';
    }
  }
  return statuses;
}
