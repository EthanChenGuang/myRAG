import type { RpcClient } from '../backend/supabase-rpc';
import { buildQuarantineReasons, legacyQuarantineReasons, type QuarantineReason } from '../security/quarantine-reasons';
import { displayUsers, type UserDisplay } from './approval/admin';
import { removeVersionObjects } from './artifacts';
import { getIngestDeps } from './deps';
import { afterPublish } from './post-publish';

export type QuarantineFailure = 'not_found' | 'not_quarantined' | 'not_admin' | 'invalid_argument' | 'unavailable';

export interface QuarantineItem {
  documentId: string;
  lineageId: string;
  tenantKey: string;
  filename: string;
  source: string;
  version: number;
  ruleIds: string[];
  snippets: string[];
  quarantinedAt: string;
  detectedBy: 'injection_scan' | 'invoice_extraction';
  /** D-32, in the fixed order; an older row without reasons shows its rule ids as one injection_rule reason. Evidence text: never log it. */
  reasons: QuarantineReason[];
  /** Hidden spans the remover could not locate in the parse text, summed over the reasons. */
  unlocated: number;
  hiddenTextCheck: 'clean' | 'hidden_found' | 'not_checked' | null;
  /** The upload also needed approval (D-36); releasing it counts as the approval. */
  pendingApproval: boolean;
  uploaderId: string | null;
  /** The uploader's e-mail or name, the id when no display is known; null when no uploader was recorded. Never log it. */
  uploader: UserDisplay | null;
}

export interface NotCheckedItem {
  documentId: string;
  lineageId: string;
  tenantKey: string;
  filename: string;
  docType: string | null;
  source: string;
  uploadedAt: string;
}

export type ListNotCheckedResult =
  | { ok: true; items: NotCheckedItem[]; total: number; limit: number; offset: number }
  | { ok: false; reason: QuarantineFailure };

export type ListQuarantineResult =
  | { ok: true; items: QuarantineItem[]; total: number; limit: number; offset: number }
  | { ok: false; reason: QuarantineFailure };

export interface QuarantineActionInput {
  documentId: string;
  /** The id of the admin the route guard verified; the database checks admin_users again and limits the call to the tenants this user administers. */
  actorUserId: string;
  signal: AbortSignal;
}

export interface ListQuarantineInput {
  actorUserId: string;
  limit?: number;
  offset?: number;
  signal: AbortSignal;
}

export type ReleaseQuarantinedResult =
  | {
      ok: true;
      documentId: string;
      version: number;
      supersededDocumentId: string | null;
      ruleIds: string[];
      /** The link targets the admin reviewed; skipped on the next version of the lineage (D-35). */
      releasedTargets: string[];
      /** published, or superseded_lineage when a confirmed supersession link keeps the lineage retired (0806). */
      outcome: 'published' | 'superseded_lineage';
    }
  | { ok: false; reason: QuarantineFailure };

export type DeleteQuarantinedResult =
  | { ok: true; documentId: string; version: number; ruleIds: string[]; artifactsRemoved: number; artifactsFailed: number }
  | { ok: false; reason: QuarantineFailure };

type Row = Record<string, unknown>;
type Call = { ok: true; rows: Row[] } | { ok: false; reason: QuarantineFailure };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SQL_REASONS = new Set<QuarantineFailure>(['not_found', 'not_quarantined', 'not_admin']);

function failureOf(message: string | undefined): QuarantineFailure {
  const word = /^[a-z_]+/.exec(message ?? '')?.[0] as QuarantineFailure | undefined;
  return word !== undefined && SQL_REASONS.has(word) ? word : 'unavailable';
}

/** One RPC on the admin client. Only the fixed reason words of the SQL functions leave this module, never a database message. */
async function call(rpc: string, args: Record<string, unknown>, signal: AbortSignal): Promise<Call> {
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      const reason = failureOf(response.error.message);
      if (reason === 'unavailable') console.error('[RAG Admin] quarantine call failed', { rpc, code: response.error.code ?? null });
      return { ok: false, reason };
    }
    return { ok: true, rows: (response.data ?? []) as Row[] };
  } catch (error) {
    console.error('[RAG Admin] quarantine call failed', { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function integer(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function strings(row: Row, key: string): string[] {
  const value = row[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function timeOf(row: Row, key: string): string | null {
  const value = row[key];
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

const HIDDEN_TEXT_CHECKS = new Set(['clean', 'hidden_found', 'not_checked']);

/** Validates the stored reasons with the generated schema; a reason that fails is dropped and only the count is logged. */
function reasonsOf(row: Row, ruleIds: string[], detectedBy: QuarantineItem['detectedBy']): QuarantineItem['reasons'] {
  const stored = Array.isArray(row.reasons) ? (row.reasons as unknown[]) : [];
  if (stored.length === 0) return legacyQuarantineReasons(ruleIds, detectedBy);
  const { reasons, dropped } = buildQuarantineReasons(stored);
  if (dropped > 0) console.warn('[RAG Admin] quarantine reasons failed validation and were dropped', { documentId: row.document_id, dropped });
  return reasons;
}

function itemOf(row: Row): QuarantineItem | null {
  const documentId = text(row, 'document_id');
  const lineageId = text(row, 'lineage_id');
  const tenantKey = text(row, 'tenant_key');
  const version = integer(row, 'version');
  const quarantinedAt = timeOf(row, 'quarantined_at');
  if (documentId === null || lineageId === null || tenantKey === null || version === null || quarantinedAt === null) return null;
  const ruleIds = strings(row, 'rule_ids');
  const detectedBy: QuarantineItem['detectedBy'] = text(row, 'detected_by') === 'invoice_extraction' ? 'invoice_extraction' : 'injection_scan';
  const hiddenTextCheck = text(row, 'hidden_text_check');
  return {
    documentId,
    lineageId,
    tenantKey,
    filename: text(row, 'filename') ?? '',
    source: text(row, 'source') ?? '',
    version,
    ruleIds,
    snippets: strings(row, 'snippets').slice(0, 3),
    quarantinedAt,
    detectedBy,
    reasons: reasonsOf(row, ruleIds, detectedBy),
    unlocated: Math.max(integer(row, 'unlocated') ?? 0, 0),
    hiddenTextCheck: HIDDEN_TEXT_CHECKS.has(hiddenTextCheck ?? '') ? (hiddenTextCheck as QuarantineItem['hiddenTextCheck']) : null,
    pendingApproval: row.pending_approval === true,
    uploaderId: text(row, 'uploader_id'),
    uploader: null,
  };
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

/**
 * Quarantined versions of the tenants the actor administers, newest first, one page. The snippets are for the admin screen only:
 * callers must not log them.
 */
export async function listQuarantine(input: ListQuarantineInput): Promise<ListQuarantineResult> {
  if (!UUID.test(input.actorUserId)) return { ok: false, reason: 'invalid_argument' };
  const actor = input.actorUserId.toLowerCase();
  const limit = clamp(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clamp(input.offset, 0, 0, 1_000_000);

  const page = await call('rag_list_quarantine_reasons', { p_actor: actor, p_limit: limit, p_offset: offset }, input.signal);
  if (!page.ok) return page;
  const items: QuarantineItem[] = [];
  for (const row of page.rows) {
    const item = itemOf(row);
    if (item === null) return { ok: false, reason: 'unavailable' };
    items.push(item);
  }
  let total = page.rows.length > 0 ? Number(page.rows[0]?.total_count) : 0;
  if (page.rows.length === 0 && offset > 0) {
    const first = await call('rag_list_quarantine_reasons', { p_actor: actor, p_limit: 1, p_offset: 0 }, input.signal);
    if (!first.ok) return first;
    total = first.rows.length > 0 ? Number(first.rows[0]?.total_count) : 0;
  }
  if (!Number.isFinite(total)) return { ok: false, reason: 'unavailable' };
  const names = await displayUsers(items.map((item) => item.uploaderId), input.signal);
  for (const item of items) item.uploader = item.uploaderId === null ? null : { id: item.uploaderId, display: names.get(item.uploaderId) ?? item.uploaderId };
  return { ok: true, items, total, limit, offset };
}

/**
 * Releases a quarantined version into retrieval through the publish swap. The database records released_by, released_at and the rule ids
 * it was released for, and writes the audit row; another tenant's id and an unknown id both answer not_found.
 */
export async function releaseQuarantined(input: QuarantineActionInput): Promise<ReleaseQuarantinedResult> {
  if (!UUID.test(input.documentId) || !UUID.test(input.actorUserId)) return { ok: false, reason: 'invalid_argument' };
  const result = await call(
    'rag_release_quarantine_reasons',
    { p_document_id: input.documentId.toLowerCase(), p_actor: input.actorUserId.toLowerCase() },
    input.signal,
  );
  if (!result.ok) return result;
  const row = result.rows[0];
  const documentId = row ? text(row, 'document_id') : null;
  const version = row ? integer(row, 'version') : null;
  const outcome = row ? text(row, 'outcome') : null;
  if (!row || documentId === null || version === null || (outcome !== 'published' && outcome !== 'superseded_lineage')) {
    return { ok: false, reason: 'unavailable' };
  }
  const tenantKey = text(row, 'tenant_key');
  // A release goes through the publish seam: the post-publish hooks run as after any publish. Never awaited, never fails the release.
  if (outcome === 'published' && tenantKey !== null) void afterPublish({ documentId, tenantKey });
  return {
    ok: true,
    documentId,
    version,
    supersededDocumentId: text(row, 'superseded_document_id'),
    ruleIds: strings(row, 'rule_ids'),
    releasedTargets: strings(row, 'released_targets'),
    outcome,
  };
}

function notCheckedOf(row: Row): NotCheckedItem | null {
  const documentId = text(row, 'document_id');
  const lineageId = text(row, 'lineage_id');
  const tenantKey = text(row, 'tenant_key');
  const uploadedAt = timeOf(row, 'uploaded_at');
  if (documentId === null || lineageId === null || tenantKey === null || uploadedAt === null) return null;
  return {
    documentId,
    lineageId,
    tenantKey,
    filename: text(row, 'filename') ?? '',
    docType: text(row, 'doc_type'),
    source: text(row, 'source') ?? '',
    uploadedAt,
  };
}

/** Current, ready documents of the actor's tenants that no hidden-text checker covered (D-34), newest first, one page. */
export async function listNotChecked(input: ListQuarantineInput): Promise<ListNotCheckedResult> {
  if (!UUID.test(input.actorUserId)) return { ok: false, reason: 'invalid_argument' };
  const actor = input.actorUserId.toLowerCase();
  const limit = clamp(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clamp(input.offset, 0, 0, 1_000_000);

  const page = await call('rag_list_not_checked', { p_actor: actor, p_limit: limit, p_offset: offset }, input.signal);
  if (!page.ok) return page;
  const items: NotCheckedItem[] = [];
  for (const row of page.rows) {
    const item = notCheckedOf(row);
    if (item === null) return { ok: false, reason: 'unavailable' };
    items.push(item);
  }
  let total = page.rows.length > 0 ? Number(page.rows[0]?.total_count) : 0;
  if (page.rows.length === 0 && offset > 0) {
    const first = await call('rag_list_not_checked', { p_actor: actor, p_limit: 1, p_offset: 0 }, input.signal);
    if (!first.ok) return first;
    total = first.rows.length > 0 ? Number(first.rows[0]?.total_count) : 0;
  }
  if (!Number.isFinite(total)) return { ok: false, reason: 'unavailable' };
  return { ok: true, items, total, limit, offset };
}

/**
 * Deletes one quarantined version and then its stored objects in the private bucket. The database delete and its audit row come first, so
 * a storage failure never leaves a document whose original is gone; objects that could not be removed are counted and logged by version
 * prefix (ids only) so the operator can clear them.
 */
export async function deleteQuarantined(input: QuarantineActionInput): Promise<DeleteQuarantinedResult> {
  if (!UUID.test(input.documentId) || !UUID.test(input.actorUserId)) return { ok: false, reason: 'invalid_argument' };
  const result = await call(
    'rag_delete_quarantined',
    { p_document_id: input.documentId.toLowerCase(), p_actor: input.actorUserId.toLowerCase() },
    input.signal,
  );
  if (!result.ok) return result;
  const row = result.rows[0];
  const documentId = row ? text(row, 'document_id') : null;
  const lineageId = row ? text(row, 'lineage_id') : null;
  const tenantKey = row ? text(row, 'tenant_key') : null;
  const version = row ? integer(row, 'version') : null;
  if (!row || documentId === null || lineageId === null || tenantKey === null || version === null) return { ok: false, reason: 'unavailable' };

  const cleanup = await removeVersionObjects({ tenantKey, lineageId, version, keys: strings(row, 'artifact_keys'), signal: input.signal });
  if (cleanup.failed > 0) {
    console.error('[RAG Admin] stored objects of a deleted quarantined version were not all removed', {
      documentId,
      lineageId,
      version,
      failed: cleanup.failed,
    });
  }
  return { ok: true, documentId, version, ruleIds: strings(row, 'rule_ids'), artifactsRemoved: cleanup.removed, artifactsFailed: cleanup.failed };
}
