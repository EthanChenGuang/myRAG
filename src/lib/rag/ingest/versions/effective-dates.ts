import type { SupabaseClient } from '@supabase/supabase-js';
import type { RpcClient } from '../../backend/supabase-rpc';
import { getRagDeps } from '../../deps';
import { getIngestDeps } from '../deps';

/**
 * Effective dates (DATA-20, D-43, D-50). The dates are a filter column only: setting them copies them to the chunks and clears the
 * semantic cache rows of the document in one SQL transaction (0807), with no re-embed and no fingerprint change. An extracted date is
 * applied on its own only when its confidence is at least 0.8 and the document stays usable today; a date that would hide the document
 * waits for an admin, and an admin-set date always wins (the SQL setter enforces that too, whatever the order of arrival).
 * Only fixed reason words leave this module, never a database message; logs carry ids and counts only.
 */
export type EffectiveDateDecision = 'apply' | 'await_confirmation' | 'ignore' | 'keep_admin';

export type EffectiveDatesOrigin = 'extracted' | 'admin';

export type EffectiveDatesFailure = 'not_found' | 'invalid_window' | 'invalid_argument' | 'no_proposal' | 'unavailable';

export type EffectiveDatesError = { ok: false; reason: EffectiveDatesFailure };

export interface EffectiveDateProposalInput {
  /** ISO date (YYYY-MM-DD) or null for unbounded. */
  from: string | null;
  to: string | null;
  confidence: number;
}

export interface CurrentEffectiveDates {
  origin: EffectiveDatesOrigin | null;
}

export interface StoredEffectiveDateProposal {
  from: string | null;
  to: string | null;
  confidence: number | null;
  evidenceQuote: string | null;
  awaiting: boolean;
  proposedAt: string | null;
}

export interface EffectiveDatesItem {
  documentId: string;
  lineageId: string | null;
  filename: string;
  version: number | null;
  status: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  origin: EffectiveDatesOrigin | null;
  confidence: number | null;
  proposal: StoredEffectiveDateProposal | null;
  /** documents.version_label (0941, D-49), null when unset. */
  versionLabel: string | null;
}

export interface EffectiveDatesScopeInput {
  /** The user the route guard verified; never a request field. */
  actorUserId: string;
  /** The workspace the guard admitted the actor for. */
  tenantKey: string;
  signal: AbortSignal;
}

export type ApplyEffectiveDatesResult =
  | {
      ok: true;
      documentId: string;
      effectiveFrom: string | null;
      effectiveTo: string | null;
      origin: EffectiveDatesOrigin;
      /** The stored label when the call named one (null: cleared); undefined when the label was left unchanged. */
      versionLabel?: string | null;
    }
  | EffectiveDatesError;

export type ListEffectiveDateProposalsResult =
  | { ok: true; items: EffectiveDatesItem[]; total: number; limit: number; offset: number; query: string | null }
  | EffectiveDatesError;

export type DismissEffectiveDateProposalResult = { ok: true; documentId: string } | EffectiveDatesError;

export type RecordExtractedEffectiveDatesResult =
  | { ok: true; decision: EffectiveDateDecision; outcome: 'applied' | 'stored' | 'kept_admin' | 'skipped' }
  | EffectiveDatesError;

export const AUTO_APPLY_MIN_CONFIDENCE = 0.8;
export const MAX_QUERY_LENGTH = 200;
/** documents.version_label limit (0941): at most 40 characters after trimming, no control characters. */
export const MAX_VERSION_LABEL_LENGTH = 40;
const CONTROL = /\p{Cc}/u;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_EVIDENCE_LENGTH = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SQL_REASONS = new Set<EffectiveDatesFailure>(['not_found', 'invalid_window', 'no_proposal']);

type Row = Record<string, unknown>;
type Call = { ok: true; rows: Row[] } | EffectiveDatesError;
type LookupClient = Pick<SupabaseClient, 'from'>;

/** A real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Inclusive bounds, null meaning unbounded; false when from is later than to. ISO dates compare as strings. */
export function isValidWindow(from: string | null, to: string | null): boolean {
  return from === null || to === null || from <= to;
}

/** Whether a document with this window is usable on `today` (inclusive bounds). */
export function usableOn(from: string | null, to: string | null, today: string): boolean {
  return (from === null || from <= today) && (to === null || to >= today);
}

/** Today's date in UTC, the date v2 retrieval passes as p_effective_on (D-44). */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The D-43 apply rule for an extracted proposal. keep_admin whenever the current dates were set by an admin; await_confirmation when the
 * proposed window would exclude today, at any confidence; apply at confidence 0.8 or more; ignore below (stored as a low-confidence
 * proposal) and for a proposal that is malformed or names no date.
 */
export function decideEffectiveDateProposal(
  proposal: EffectiveDateProposalInput,
  current: CurrentEffectiveDates,
  today: string,
): EffectiveDateDecision {
  if (current.origin === 'admin') return 'keep_admin';
  const { from, to, confidence } = proposal;
  if ((from !== null && !isIsoDate(from)) || (to !== null && !isIsoDate(to))) return 'ignore';
  if (from === null && to === null) return 'ignore';
  if (!isValidWindow(from, to)) return 'ignore';
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return 'ignore';
  if (!usableOn(from, to, today)) return 'await_confirmation';
  return confidence >= AUTO_APPLY_MIN_CONFIDENCE ? 'apply' : 'ignore';
}

function failureOf(message: string | undefined): EffectiveDatesError {
  const word = /^([a-z_]+)/.exec(message ?? '')?.[1];
  if (word === 'invalid_origin' || word === 'invalid_confidence' || word === 'invalid_argument' || word === 'invalid_status' || word === 'invalid_evidence') {
    return { ok: false, reason: 'invalid_argument' };
  }
  return word !== undefined && SQL_REASONS.has(word as EffectiveDatesFailure) ? { ok: false, reason: word as EffectiveDatesFailure } : { ok: false, reason: 'unavailable' };
}

async function call(rpc: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Call> {
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal?.throwIfAborted();
    const request = db.rpc(rpc, args);
    const response = await (signal ? request.abortSignal(signal) : request);
    signal?.throwIfAborted();
    if (response.error) {
      const failure = failureOf(response.error.message);
      if (failure.reason === 'unavailable') console.error('[RAG Admin] effective dates call failed', { rpc, code: response.error.code ?? null });
      return failure;
    }
    return { ok: true, rows: (Array.isArray(response.data) ? response.data : []) as Row[] };
  } catch (error) {
    console.error('[RAG Admin] effective dates call failed', { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

function lookupClient(): LookupClient | null {
  try {
    return getRagDeps().adminClient() as LookupClient | null;
  } catch {
    return null;
  }
}

function validScope(input: EffectiveDatesScopeInput): boolean {
  return UUID.test(input.actorUserId) && TENANT_KEY.test(input.tenantKey);
}

/**
 * The document's tenant, read on the admin client, must be the workspace the guard admitted. An unknown id and another workspace's id
 * give the same not_found, and nothing is called.
 */
async function documentInWorkspace(documentId: string, tenantKey: string, signal: AbortSignal): Promise<{ ok: true } | EffectiveDatesError> {
  const client = lookupClient();
  if (!client) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const { data, error } = await client.from('documents').select('tenant_key').eq('id', documentId).abortSignal(signal).maybeSingle();
    if (error) return { ok: false, reason: 'unavailable' };
    return ((data ?? null) as Row | null)?.tenant_key === tenantKey ? { ok: true } : { ok: false, reason: 'not_found' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function dateOf(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && isIsoDate(value.slice(0, 10))) return value.slice(0, 10);
  return null;
}

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function timeOf(value: unknown): string | null {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function originOf(value: unknown): EffectiveDatesOrigin | null {
  return value === 'admin' || value === 'extracted' ? value : null;
}

function proposalOf(value: unknown): StoredEffectiveDateProposal | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Row;
  const quote = typeof raw.evidence_quote === 'string' ? raw.evidence_quote.slice(0, MAX_EVIDENCE_LENGTH) : null;
  return {
    from: dateOf(raw.from),
    to: dateOf(raw.to),
    confidence: numberOf(raw.confidence),
    evidenceQuote: quote,
    awaiting: raw.status === 'awaiting_confirmation',
    proposedAt: timeOf(raw.proposed_at),
  };
}

/** The trimmed label, null for an empty one (clears it), or false when it breaks the 0941 rule. */
export function normalizeVersionLabel(value: string | null): string | null | false {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length <= MAX_VERSION_LABEL_LENGTH && !CONTROL.test(trimmed) ? trimmed : false;
}

/**
 * version_label of the given documents, read on the admin client by id and only within one tenant (D-49): an id of another tenant is
 * simply absent. Fails as a whole, so a list never shows an unread label as empty.
 */
export async function versionLabelsOf(
  documentIds: ReadonlyArray<string | null>,
  tenantKey: string,
  signal: AbortSignal,
): Promise<{ ok: true; labels: Map<string, string | null> } | EffectiveDatesError> {
  const ids = [...new Set(documentIds.filter((id): id is string => typeof id === 'string' && UUID.test(id)).map((id) => id.toLowerCase()))];
  const labels = new Map<string, string | null>();
  if (ids.length === 0) return { ok: true, labels };
  if (!TENANT_KEY.test(tenantKey)) return { ok: false, reason: 'invalid_argument' };
  const client = lookupClient();
  if (!client) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const { data, error } = await client.from('documents').select('id, version_label').in('id', ids).eq('tenant_key', tenantKey).abortSignal(signal);
    if (error || !Array.isArray(data)) return { ok: false, reason: 'unavailable' };
    for (const row of data as Row[]) {
      if (typeof row.id === 'string') labels.set(row.id.toLowerCase(), typeof row.version_label === 'string' ? row.version_label : null);
    }
    return { ok: true, labels };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

async function setVersionLabel(documentId: string, tenantKey: string, label: string | null, signal: AbortSignal): Promise<{ ok: true } | EffectiveDatesError> {
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const response = await db
      .rpc('rag_set_document_version_label', { p_tenant_key: tenantKey, p_document_id: documentId, p_label: label })
      .abortSignal(signal);
    if (response.error) {
      console.error('[RAG Admin] version label call failed', { documentId, code: response.error.code ?? null });
      return { ok: false, reason: 'unavailable' };
    }
    return response.data === true ? { ok: true } : { ok: false, reason: 'not_found' };
  } catch (error) {
    console.error('[RAG Admin] version label call failed', { documentId, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

function itemOf(row: Row): EffectiveDatesItem | null {
  const documentId = text(row, 'document_id');
  if (documentId === null) return null;
  const version = numberOf(row.version);
  return {
    documentId,
    lineageId: text(row, 'lineage_id'),
    filename: text(row, 'filename') ?? '',
    version: version !== null && Number.isInteger(version) ? version : null,
    status: text(row, 'status') ?? '',
    effectiveFrom: dateOf(row.effective_from),
    effectiveTo: dateOf(row.effective_to),
    origin: originOf(row.effective_dates_origin),
    confidence: numberOf(row.effective_dates_confidence),
    proposal: proposalOf(row.proposal),
    versionLabel: null,
  };
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

/**
 * An admin sets, changes or clears a document's window (PUT, and applying a proposal is the same call). Origin admin; the stored proposal
 * is removed; chunks and the cache follow in the same transaction. A versionLabel (D-49) is saved after the dates through
 * rag_set_document_version_label for the same tenant: an empty or null label clears it, an undefined one leaves it unchanged.
 */
export async function applyEffectiveDates(
  input: EffectiveDatesScopeInput & { documentId: string; from: string | null; to: string | null; versionLabel?: string | null },
): Promise<ApplyEffectiveDatesResult> {
  if (!validScope(input) || !UUID.test(input.documentId)) return { ok: false, reason: 'invalid_argument' };
  if ((input.from !== null && !isIsoDate(input.from)) || (input.to !== null && !isIsoDate(input.to))) return { ok: false, reason: 'invalid_argument' };
  if (!isValidWindow(input.from, input.to)) return { ok: false, reason: 'invalid_window' };
  const label = input.versionLabel === undefined ? undefined : normalizeVersionLabel(input.versionLabel);
  if (label === false) return { ok: false, reason: 'invalid_argument' };
  const documentId = input.documentId.toLowerCase();
  const inWorkspace = await documentInWorkspace(documentId, input.tenantKey, input.signal);
  if (!inWorkspace.ok) return inWorkspace;
  const result = await call(
    'rag_set_document_effective_dates',
    {
      p_document_id: documentId,
      p_tenant_key: input.tenantKey,
      p_from: input.from,
      p_to: input.to,
      p_origin: 'admin',
      p_confidence: null,
      p_actor: input.actorUserId.toLowerCase(),
    },
    input.signal,
  );
  if (!result.ok) return result;
  const row = result.rows[0];
  const id = row ? text(row, 'document_id') : null;
  if (!row || id === null || text(row, 'outcome') !== 'set') return { ok: false, reason: 'unavailable' };
  console.log('[RAG Admin] effective dates set', { documentId: id, chunks: numberOf(row.chunks_updated) ?? 0 });
  const saved = { ok: true as const, documentId: id, effectiveFrom: dateOf(row.effective_from), effectiveTo: dateOf(row.effective_to), origin: 'admin' as const };
  if (label === undefined) return saved;
  const labelled = await setVersionLabel(documentId, input.tenantKey, label, input.signal);
  if (!labelled.ok) return labelled;
  console.log('[RAG Admin] version label set', { documentId: id, cleared: label === null });
  return { ...saved, versionLabel: label };
}

/** Drops a stored proposal and keeps the current dates. */
export async function dismissEffectiveDateProposal(input: EffectiveDatesScopeInput & { documentId: string }): Promise<DismissEffectiveDateProposalResult> {
  if (!validScope(input) || !UUID.test(input.documentId)) return { ok: false, reason: 'invalid_argument' };
  const documentId = input.documentId.toLowerCase();
  const inWorkspace = await documentInWorkspace(documentId, input.tenantKey, input.signal);
  if (!inWorkspace.ok) return inWorkspace;
  const result = await call(
    'rag_dismiss_effective_date_proposal',
    { p_document_id: documentId, p_tenant_key: input.tenantKey, p_actor: input.actorUserId.toLowerCase() },
    input.signal,
  );
  if (!result.ok) return result;
  const id = result.rows[0] ? text(result.rows[0], 'document_id') : null;
  if (id === null || text(result.rows[0] as Row, 'outcome') !== 'dismissed') return { ok: false, reason: 'unavailable' };
  console.log('[RAG Admin] effective date proposal dismissed', { documentId: id });
  return { ok: true, documentId: id };
}

/**
 * Documents of one workspace with a stored proposal (awaiting confirmation first) or, with a query, the documents whose file name
 * contains it, with their current dates. One page.
 */
export async function listEffectiveDateProposals(
  input: EffectiveDatesScopeInput & { query?: string | null; limit?: number; offset?: number },
): Promise<ListEffectiveDateProposalsResult> {
  if (!validScope(input)) return { ok: false, reason: 'invalid_argument' };
  const trimmed = typeof input.query === 'string' ? input.query.trim() : '';
  if (trimmed.length > MAX_QUERY_LENGTH) return { ok: false, reason: 'invalid_argument' };
  const query = trimmed === '' ? null : trimmed;
  const limit = clamp(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clamp(input.offset, 0, 0, 1_000_000);
  const args = (pageLimit: number, pageOffset: number) => ({
    p_actor: input.actorUserId.toLowerCase(),
    p_tenant_key: input.tenantKey,
    p_query: query,
    p_limit: pageLimit,
    p_offset: pageOffset,
  });
  const page = await call('rag_list_effective_date_proposals', args(limit, offset), input.signal);
  if (!page.ok) return page;
  let total = page.rows.length > 0 ? Number(page.rows[0]?.total_count) : 0;
  if (page.rows.length === 0 && offset > 0) {
    const first = await call('rag_list_effective_date_proposals', args(1, 0), input.signal);
    if (!first.ok) return first;
    total = first.rows.length > 0 ? Number(first.rows[0]?.total_count) : 0;
  }
  if (!Number.isFinite(total)) return { ok: false, reason: 'unavailable' };
  const items: EffectiveDatesItem[] = [];
  for (const row of page.rows) {
    const item = itemOf(row);
    if (item === null) return { ok: false, reason: 'unavailable' };
    items.push(item);
  }
  const labels = await versionLabelsOf(
    items.map((item) => item.documentId),
    input.tenantKey,
    input.signal,
  );
  if (!labels.ok) return labels;
  for (const item of items) item.versionLabel = labels.labels.get(item.documentId.toLowerCase()) ?? null;
  return { ok: true, items, total, limit, offset, query };
}

/**
 * Pipeline side (the extractor, plan 47): applies an extracted proposal through the service path when the D-43 rule allows it, otherwise
 * stores it on the document for an admin. A proposal over admin-set dates changes nothing. `current` is what the caller read; the SQL
 * functions check the admin origin again under the row lock.
 */
export async function recordExtractedEffectiveDates(input: {
  documentId: string;
  tenantKey: string;
  proposal: EffectiveDateProposalInput & { evidenceQuote?: string | null };
  current: CurrentEffectiveDates;
  now?: Date;
  signal?: AbortSignal;
}): Promise<RecordExtractedEffectiveDatesResult> {
  if (!UUID.test(input.documentId) || !TENANT_KEY.test(input.tenantKey)) return { ok: false, reason: 'invalid_argument' };
  const decision = decideEffectiveDateProposal(input.proposal, input.current, todayUtc(input.now));
  const { from, to, confidence } = input.proposal;
  if (decision === 'keep_admin') return { ok: true, decision, outcome: 'kept_admin' };
  const storable =
    (from === null || isIsoDate(from)) &&
    (to === null || isIsoDate(to)) &&
    (from !== null || to !== null) &&
    isValidWindow(from, to) &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1;
  if (!storable) return { ok: true, decision, outcome: 'skipped' };
  const documentId = input.documentId.toLowerCase();

  if (decision === 'apply') {
    const result = await call(
      'rag_set_document_effective_dates',
      { p_document_id: documentId, p_tenant_key: input.tenantKey, p_from: from, p_to: to, p_origin: 'extracted', p_confidence: confidence, p_actor: null },
      input.signal,
    );
    if (!result.ok) return result;
    const outcome = result.rows[0] ? text(result.rows[0], 'outcome') : null;
    if (outcome === 'kept_admin') return { ok: true, decision: 'keep_admin', outcome: 'kept_admin' };
    return outcome === 'set' ? { ok: true, decision, outcome: 'applied' } : { ok: false, reason: 'unavailable' };
  }

  const quote = typeof input.proposal.evidenceQuote === 'string' ? input.proposal.evidenceQuote.slice(0, MAX_EVIDENCE_LENGTH) : null;
  const result = await call(
    'rag_propose_document_effective_dates',
    {
      p_document_id: documentId,
      p_tenant_key: input.tenantKey,
      p_from: from,
      p_to: to,
      p_confidence: confidence,
      p_evidence_quote: quote,
      p_status: decision === 'await_confirmation' ? 'awaiting_confirmation' : 'low_confidence',
    },
    input.signal,
  );
  if (!result.ok) return result;
  const outcome = result.rows[0] ? text(result.rows[0], 'outcome') : null;
  if (outcome === 'kept_admin') return { ok: true, decision: 'keep_admin', outcome: 'kept_admin' };
  return outcome === 'stored' ? { ok: true, decision, outcome: 'stored' } : { ok: false, reason: 'unavailable' };
}
